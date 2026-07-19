'use strict';

/**
 * PredictiveTypingProvider
 * ========================
 * VS Code inline-completion provider that queries pk-client and pk-memory
 * for risk-aware ghost-text suggestions.
 *
 * Data sources (in priority order):
 *   1. pk-memory  — canon-ranked patterns from TMrFS memory reports
 *   2. pk-client  — trust-state / coherence pack summaries
 *   3. MCP env-observer state — get_environment_state tool output (JSON)
 *
 * Each source is queried async with a short timeout so slow tools never
 * stall the editor. Results are cached per (file, prefix) for `cacheTtl`
 * seconds. Suggestions flagged with high-risk signals are suppressed.
 */

const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_SUGGESTIONS = 5;
const TOOL_TIMEOUT_MS = 4_000;

// Residue signals that must never surface as suggestions.
const BLOCKED_SIGNALS = [
  'agent_runtime_residue',
  'secret_or_private_material',
  'debug_artifact',
  'shell_snapshot'
];

class PredictiveTypingProvider {
  /**
   * @param {string} projectRoot
   * @param {() => string} getPkClient   - returns resolved pk-client path
   * @param {() => string} getPkMemory   - returns resolved pk-memory path
   * @param {() => string} getNode       - returns node interpreter
   * @param {(msg: string) => void} log  - append to output channel
   */
  constructor(projectRoot, getPkClient, getPkMemory, getNode, log) {
    this.projectRoot = projectRoot;
    this._getPkClient = getPkClient;
    this._getPkMemory = getPkMemory;
    this._getNode = getNode;
    this._log = log;

    /** @type {Map<string, {ts: number, items: vscode.InlineCompletionItem[]}>} */
    this._cache = new Map();
    this._disposed = false;
  }

  // ── VS Code API ────────────────────────────────────────────────────────────

  /**
   * Called by VS Code on every keystroke (debounced internally by the editor).
   * @param {vscode.TextDocument} document
   * @param {vscode.Position} position
   * @param {vscode.InlineCompletionContext} _context
   * @param {vscode.CancellationToken} token
   * @returns {Promise<vscode.InlineCompletionList>}
   */
  async provideInlineCompletionItems(document, position, _context, token) {
    if (this._disposed) return { items: [] };

    const cfg = vscode.workspace.getConfiguration('planekey');
    if (!cfg.get('predictive.enabled', true)) return { items: [] };

    const line = document.lineAt(position).text.substring(0, position.character);
    const prefix = line.trimStart();
    if (prefix.length < 3) return { items: [] }; // too short to be useful

    const cacheKey = `${document.uri.fsPath}::${prefix}`;
    const ttlMs = (cfg.get('cache.ttl', 30)) * 1_000;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ttlMs) {
      return { items: cached.items };
    }

    const [memoryItems, clientItems] = await Promise.all([
      this._queryPkMemory(prefix, token),
      this._queryPkClient(prefix, token)
    ]);

    const raw = [...memoryItems, ...clientItems];
    const items = this._dedupe(raw)
      .filter(s => !this._isBlocked(s))
      .slice(0, MAX_SUGGESTIONS)
      .map(s => new vscode.InlineCompletionItem(
        s.text,
        new vscode.Range(position, position)
      ));

    this._cache.set(cacheKey, { ts: Date.now(), items });
    return { items };
  }

  // ── pk-memory ──────────────────────────────────────────────────────────────

  /**
   * Calls `pk-memory memory suggest <prefix> --root <projectRoot> --json`
   * Falls back gracefully if pk-memory doesn't support that verb yet.
   */
  async _queryPkMemory(prefix, token) {
    try {
      const out = await this._run(
        this._getPkMemory(),
        ['memory', 'suggest', prefix, '--root', this.projectRoot, '--json'],
        token
      );
      if (!out) return [];
      const parsed = JSON.parse(out);
      // Expected shape: [{text, canonScore, signals}] or {suggestions: [...]}
      const arr = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed.suggestions) ? parsed.suggestions
        : [];
      const minScore = vscode.workspace.getConfiguration('planekey').get('memory.minCanonScore', 0.5);
      return arr
        .filter(s => typeof s.text === 'string' && s.text.trim())
        .filter(s => (s.canonScore ?? 1) >= minScore)
        .map(s => ({ text: s.text, signals: s.signals || [] }));
    } catch (_) {
      return [];
    }
  }

  // ── pk-client ──────────────────────────────────────────────────────────────

  /**
   * Calls `pk-client coherence --json` to get live grounding context,
   * then extracts short pattern suggestions from the output.
   * Also tries `pk-client trust state --json` for trust-gated patterns.
   */
  async _queryPkClient(prefix, token) {
    try {
      const cfg = vscode.workspace.getConfiguration('planekey');
      if (!cfg.get('db.enabled', true)) return [];

      const out = await this._run(
        this._getPkClient(),
        ['coherence', '--json'],
        token
      );
      if (!out) return [];

      let parsed;
      try { parsed = JSON.parse(out); } catch (_) { return []; }

      // Coherence pack shape: { patterns: [{text, risk, signals}] }
      const patterns = Array.isArray(parsed.patterns) ? parsed.patterns
        : Array.isArray(parsed) ? parsed
        : [];

      const maxRisk = cfg.get('memory.maxRiskScore', 30);
      return patterns
        .filter(p => typeof p.text === 'string' && p.text.trim())
        .filter(p => (p.risk ?? 0) <= maxRisk)
        // Only return patterns whose text starts with or contains the prefix
        .filter(p => {
          const t = p.text.toLowerCase();
          const pf = prefix.toLowerCase();
          return t.startsWith(pf) || t.includes(pf);
        })
        .map(p => ({ text: p.text, signals: p.signals || [] }));
    } catch (_) {
      return [];
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  _isBlocked(suggestion) {
    const cfg = vscode.workspace.getConfiguration('planekey');
    const excluded = cfg.get('memory.excludeSignals', BLOCKED_SIGNALS);
    return (suggestion.signals || []).some(sig => excluded.includes(sig));
  }

  _dedupe(items) {
    const seen = new Set();
    return items.filter(i => {
      if (seen.has(i.text)) return false;
      seen.add(i.text);
      return true;
    });
  }

  /**
   * Spawn a tool and return its stdout, or '' on timeout/error.
   * Respects the VS Code cancellation token.
   */
  _run(tool, args, token) {
    return new Promise((resolve) => {
      let cmd, cmdArgs;
      if (typeof tool === 'string' && tool.toLowerCase().endsWith('.js')) {
        cmd = this._getNode();
        cmdArgs = [tool, ...args];
      } else {
        cmd = tool;
        cmdArgs = args;
      }

      const child = cp.execFile(
        cmd, cmdArgs,
        { cwd: this.projectRoot, maxBuffer: 2 * 1024 * 1024, windowsHide: true, timeout: TOOL_TIMEOUT_MS },
        (err, stdout) => resolve(err ? '' : (stdout || '').trim())
      );

      child.on('error', () => resolve(''));

      if (token) {
        token.onCancellationRequested(() => {
          try { child.kill(); } catch (_) {}
          resolve('');
        });
      }
    });
  }

  invalidateCache() {
    this._cache.clear();
  }

  onIncidentChanged(_doc) {
    // Operator incident closed → clear cache so next keystroke re-queries
    this._cache.clear();
  }

  dispose() {
    this._disposed = true;
    this._cache.clear();
  }
}

module.exports = { PredictiveTypingProvider };
