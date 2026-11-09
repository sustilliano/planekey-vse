'use strict';

/**
 * PredictiveTypingProvider
 * ========================
 * VS Code inline-completion provider that shows PlaneKey ghost-text
 * suggestions in the editor as you type — like Copilot/Ponicode, but with
 * NO AI and NO network. Every suggestion comes from a local index built out
 * of the PlaneKey reports (see predictiveIndex.js): your codebase's own
 * identifiers, ranked by canon (source-of-truth) and with residue (secrets /
 * agent-runtime junk) suppressed.
 *
 * On each keystroke this does a fast in-memory prefix scan — no subprocess,
 * no LLM call — so it never stalls the editor. The report index is loaded
 * once (lazily) and reloaded after a snapshot / Index Codebase run. The open
 * document's own identifiers are blended in so brand-new code is suggestable
 * before the next snapshot.
 */

const vscode = require('vscode');

const IDENT_RX = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const WORD_AT_CURSOR = /[A-Za-z_$][A-Za-z0-9_$]*$/;
const IMPORT_CTX = /(?:require\s*\(\s*|(?:import|from)\s+[^'"]*)['"]([^'"]*)$/;

class PredictiveTypingProvider {
  /**
   * @param {{getProjectRoot: () => string, getReportRoot: () => string, log: (m:string)=>void}} deps
   */
  constructor(deps) {
    this._getProjectRoot = deps.getProjectRoot;
    this._getReportRoot = deps.getReportRoot;
    this._log = deps.log || (() => {});
    const { PredictiveIndex } = require('./predictiveIndex');
    this._index = new PredictiveIndex(this._log);
    this._indexTried = false;
    // per-document identifier cache: uri → {version, ids:Set}
    this._docCache = new Map();
    this._disposed = false;
  }

  // ── VS Code API ────────────────────────────────────────────────────────────

  provideInlineCompletionItems(document, position, _context, _token) {
    if (this._disposed) return { items: [] };
    const cfg = vscode.workspace.getConfiguration('planekey');
    if (!cfg.get('predictive.enabled', true)) return { items: [] };

    this._ensureIndex(cfg);

    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const maxItems = cfg.get('predictive.maxSuggestions', 5);

    // 1) Import-path context: complete inside require('…') / import … '…'
    const imp = linePrefix.match(IMPORT_CTX);
    if (imp) {
      const partial = imp[1];
      const startCol = position.character - partial.length;
      const range = new vscode.Range(position.line, startCol, position.line, position.character);
      const items = this._index.queryImports(partial, maxItems)
        .filter(s => s.text !== partial)
        .map(s => new vscode.InlineCompletionItem(s.text, range));
      return { items };
    }

    // 2) Identifier completion at the word under the cursor.
    const wm = linePrefix.match(WORD_AT_CURSOR);
    const word = wm ? wm[0] : '';
    const minPrefix = cfg.get('predictive.minPrefix', 2);
    if (word.length < minPrefix) return { items: [] };

    const startCol = position.character - word.length;
    const range = new vscode.Range(position.line, startCol, position.line, position.character);

    const seen = new Set([word]);
    const out = [];

    // Report-backed (canon-ranked) suggestions first.
    for (const s of this._index.query(word, maxItems)) {
      if (seen.has(s.text)) continue;
      seen.add(s.text);
      out.push(new vscode.InlineCompletionItem(s.text, range));
      if (out.length >= maxItems) break;
    }

    // Blend in the current document's own identifiers (recency / fresh code).
    if (out.length < maxItems) {
      const wl = word.toLowerCase();
      for (const id of this._documentIdentifiers(document)) {
        if (out.length >= maxItems) break;
        if (seen.has(id)) continue;
        if (id.toLowerCase().startsWith(wl)) { seen.add(id); out.push(new vscode.InlineCompletionItem(id, range)); }
      }
    }

    return { items: out };
  }

  // ── index lifecycle ─────────────────────────────────────────────────────────

  _ensureIndex(_cfg) {
    if (this._index.isLoaded || this._indexTried) return;
    this._indexTried = true;
    try { this._index.load(this._getReportRoot()); }
    catch (e) { this._log('[Predictive] index load failed: ' + e.message); }
  }

  /** Force a reload from the newest reports (called after a snapshot / index build). */
  reloadIndex() {
    this._indexTried = false;
    this._index.clear();
    try { this._index.load(this._getReportRoot()); this._indexTried = true; }
    catch (e) { this._log('[Predictive] index reload failed: ' + e.message); }
  }

  stats() { return this._index.stats(); }

  // ── current-document identifiers ─────────────────────────────────────────────

  _documentIdentifiers(document) {
    const key = document.uri.toString();
    const cached = this._docCache.get(key);
    if (cached && cached.version === document.version) return cached.ids;
    const ids = new Set();
    const text = document.getText();
    let m;
    IDENT_RX.lastIndex = 0;
    while ((m = IDENT_RX.exec(text))) { if (m[0].length >= 3 && m[0].length <= 60) ids.add(m[0]); }
    this._docCache.set(key, { version: document.version, ids });
    return ids;
  }

  // ── compatibility hooks used by extension.js ─────────────────────────────────

  invalidateCache() { this._docCache.clear(); }
  onIncidentChanged() { this._docCache.clear(); }
  dispose() { this._disposed = true; this._docCache.clear(); this._index.clear(); }
}

module.exports = { PredictiveTypingProvider };
