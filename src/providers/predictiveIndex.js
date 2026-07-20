'use strict';

/**
 * PredictiveIndex — the local, no-AI suggestion source for predictive typing.
 * ==========================================================================
 * Turns the PlaneKey reports (which we already generate) into an in-memory,
 * trust-ranked index of identifiers. No LLM, no network, no per-keystroke
 * subprocess — just a fast prefix scan over what the codebase already
 * declares:
 *
 *   STRUCTURE_INDEX.json   → the real identifiers per file (functions,
 *                            imports, routes, config keys, html ids)
 *   CANON_CANDIDATES.json  → per-file canon score (rank trusted first)
 *   RESIDUE_CANDIDATES.json→ per-file residue signals (never suggest from
 *                            secrets / agent-runtime junk)
 *
 * The result: suggestions come from your own canon (source-of-truth) and
 * residue is suppressed — which is the whole point of a trust layer.
 *
 * (A future semantic pass — e.g. sentence-transformers embeddings for
 * fuzzy intent matching — could re-rank these, but is deliberately NOT
 * required: the base engine is pure string matching.)
 */

const fs = require('fs');
const path = require('path');

// Files carrying a genuinely sensitive signal never contribute suggestions —
// we must never surface a secret. We deliberately do NOT block the broad,
// keyword-based `agent_runtime_residue` here: a function name is not a secret,
// and blocking it would drop the codebase's own API (any file that merely
// mentions "mcp"/"agent"/"secret" gets that signal). Callers can pass extra
// signals to block if they want it stricter.
const HARD_BLOCK = new Set(['secret_or_private_material']);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function asArray(j) { return Array.isArray(j) ? j : (j && Array.isArray(j.items) ? j.items : []); }

// Find the newest STRUCTURE_INDEX.json anywhere under reportRoot, so we work
// with whatever layout produced it (snapshots/<id>/memory/snapshot/, or a
// plain memory/<name>/ from Index Codebase). Bounded, skips heavy dirs.
function findNewestStructureIndex(reportRoot) {
  const SKIP = new Set(['node_modules', '.git', 'target', '.venv', 'venv', '__pycache__']);
  let best = null, bestMtime = -1, budget = 20000;
  const stack = [reportRoot];
  while (stack.length && budget-- > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(path.join(dir, e.name)); continue; }
      if (e.name === 'STRUCTURE_INDEX.json') {
        const p = path.join(dir, e.name);
        try { const m = fs.statSync(p).mtimeMs; if (m > bestMtime) { bestMtime = m; best = p; } } catch (_) {}
      }
    }
  }
  return best;
}

class PredictiveIndex {
  constructor(log) {
    this._log = log || (() => {});
    /** @type {Array<{text:string, score:number, count:number, kind:string}>} */
    this._identifiers = [];
    /** @type {Array<{text:string, score:number}>} */
    this._imports = [];
    this._source = '';
    this._loadedAt = 0;
  }

  get isLoaded() { return this._loadedAt > 0; }
  stats() { return { identifiers: this._identifiers.length, imports: this._imports.length, source: this._source }; }

  /**
   * (Re)build the index from the newest report set under reportRoot.
   * Returns true if it loaded something.
   */
  load(reportRoot, extraBlock) {
    const blocked = new Set(HARD_BLOCK);
    for (const s of (extraBlock || [])) blocked.add(s);
    const structPath = reportRoot ? findNewestStructureIndex(reportRoot) : null;
    if (!structPath) { this._identifiers = []; this._imports = []; this._source = ''; this._loadedAt = 0; return false; }

    const dir = path.dirname(structPath);
    const structure = readJson(structPath) || {};
    const canon = asArray(readJson(path.join(dir, 'CANON_CANDIDATES.json')));
    const residue = asArray(readJson(path.join(dir, 'RESIDUE_CANDIDATES.json')));

    // path → trust
    const trust = new Map();
    for (const c of canon) if (c && c.path) trust.set(c.path, { canon: c.canon_score ?? 0.5, risk: c.risk_score ?? 0, signals: [] });
    for (const r of residue) if (r && r.path) {
      const t = trust.get(r.path) || { canon: r.canon_score ?? 0.5, risk: r.risk_score ?? 0, signals: [] };
      t.signals = r.residue_signals || [];
      if (r.risk_score != null) t.risk = r.risk_score;
      trust.set(r.path, t);
    }

    const idMap = new Map();   // text → {score, count, kind}
    const impMap = new Map();  // text → score
    const addId = (text, score, kind) => {
      if (!text || text.length < 2 || text.length > 80) return;
      const cur = idMap.get(text);
      if (cur) { cur.count += 1; if (score > cur.score) cur.score = score; }
      else idMap.set(text, { score, count: 1, kind });
    };

    const nodes = Array.isArray(structure) ? structure : Object.values(structure);
    for (const node of nodes) {
      if (!node || !node.structure) continue;
      const t = trust.get(node.path) || { canon: 0.5, risk: 0, signals: [] };
      // Never surface identifiers from residue-bearing files (secrets, agent runtime, ...)
      if ((t.signals || []).some(s => blocked.has(s))) continue;
      const s = node.structure;
      const base = (t.canon ?? 0.5); // higher canon → ranked first
      for (const fn of s.functions || []) addId(fn, base + 0.15, 'function');
      for (const key of s.config_keys || []) addId(key, base, 'config');
      for (const id of s.html_ids || []) addId(id, base - 0.05, 'id');
      for (const imp of s.imports || []) {
        if (!imp || imp.length > 120) continue;
        const cur = impMap.get(imp) || 0;
        impMap.set(imp, Math.max(cur, base));
      }
    }

    this._identifiers = Array.from(idMap, ([text, v]) => ({ text, score: v.score + Math.min(v.count, 5) * 0.02, count: v.count, kind: v.kind }))
      .sort((a, b) => b.score - a.score || b.count - a.count);
    this._imports = Array.from(impMap, ([text, score]) => ({ text, score })).sort((a, b) => b.score - a.score);
    this._source = structPath;
    this._loadedAt = Date.now();
    this._log(`[Predictive] index loaded: ${this._identifiers.length} identifiers, ${this._imports.length} imports from ${path.basename(dir)}`);
    return true;
  }

  clear() { this._identifiers = []; this._imports = []; this._source = ''; this._loadedAt = 0; }

  /** Prefix (then substring) match over identifiers, ranked by canon score. */
  query(prefix, limit = 5) {
    if (!prefix) return [];
    const p = prefix.toLowerCase();
    const starts = [], contains = [];
    for (const it of this._identifiers) {
      const t = it.text.toLowerCase();
      if (t === p) continue;
      if (t.startsWith(p)) starts.push(it);
      else if (t.includes(p)) contains.push(it);
      if (starts.length >= limit * 4) break; // already have plenty of strong matches
    }
    return starts.concat(contains).slice(0, limit);
  }

  /** Import-path suggestions (for lines like require('…') / import … '…'). */
  queryImports(prefix, limit = 6) {
    const p = (prefix || '').toLowerCase();
    return this._imports.filter(i => !p || i.text.toLowerCase().includes(p)).slice(0, limit);
  }
}

module.exports = { PredictiveIndex, findNewestStructureIndex };
