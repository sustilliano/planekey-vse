'use strict';

/**
 * snapshotCard.js — the welcoming front door for a PlaneKey snapshot.
 * ===================================================================
 * You shouldn't need to understand routes, signatures, or the RPG to look
 * at your codebase and get it. This turns the raw report JSON into one
 * plain-language page you can just read: what's here, what holds it
 * together, what to trust, and what's worth a second look. The full
 * technical reports stay in reports/ for anyone who wants to look under the
 * hood — this is the view you can admire without reading the blueprints.
 *
 * Pure Node (no vscode dependency) so it runs standalone or inside the
 * extension. Self-contained HTML, safe in a webview or a browser.
 */

const fs = require('fs');
const path = require('path');

const ROLE_LABEL = {
  code_module: 'Code',
  planekey_component: 'PlaneKey piece',
  package_manifest: 'Manifest & wiring',
  documentation: 'Docs',
  json_config: 'Config',
  agent_runtime: 'Agent runtime',
  artifact: 'Asset',
  server_app_entry: 'Server entry',
  secret_or_credential: 'Secret / credential'
};
const roleLabel = (r) => ROLE_LABEL[r] || (r ? String(r).replace(/_/g, ' ') : 'File');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function asArray(j) { return Array.isArray(j) ? j : (j && Array.isArray(j.items) ? j.items : []); }

// Locate + parse the four reports a snapshot produces. `names` lets callers
// override per-report folder names (the editor writes them all as
// "snapshot"; the demo branch uses vse-rgano/vse-rpg/...).
function loadSnapshotData(reportRoot, names = {}) {
  const n = {
    rgano: names.rgano || 'snapshot',
    rpg: names.rpg || 'snapshot',
    timeline: names.timeline || 'snapshot',
    memory: names.memory || 'snapshot'
  };
  const structure = readJson(path.join(reportRoot, 'rgano', n.rgano, 'RGANO_STRUCTURE_SCAN.json'));
  const canon = asArray(readJson(path.join(reportRoot, 'memory', n.memory, 'CANON_CANDIDATES.json')));
  const residue = asArray(readJson(path.join(reportRoot, 'memory', n.memory, 'RESIDUE_CANDIDATES.json')));
  const rows = (structure && Array.isArray(structure.rows)) ? structure.rows : [];

  let rpgCounts = null;
  try {
    const md = fs.readFileSync(path.join(reportRoot, 'rpg', n.rpg, 'rpg.md'), 'utf8');
    const m = /Modules:\s*(\d+)\s+Symbols:\s*(\d+)\s+Dependencies:\s*(\d+)\s+Capabilities:\s*(\d+)/.exec(md);
    if (m) rpgCounts = { modules: +m[1], symbols: +m[2], dependencies: +m[3], capabilities: +m[4] };
  } catch (_) { /* optional */ }

  return {
    generatedAt: (structure && structure.generated_at) || new Date().toISOString(),
    rows, canon, residue, rpgCounts
  };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSnapshotHtml(data, opts = {}) {
  const title = opts.title || 'this workspace';
  const rows = data.rows || [];
  const files = rows.length;
  const connections = rows.reduce((a, r) => a + (r.routes || 0), 0);
  const canon = (data.canon || []).slice().sort((a, b) => (b.canon_score || 0) - (a.canon_score || 0));
  const residue = (data.residue || []).slice().sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0));

  const connected = rows
    .filter(r => (r.structure_score || 0) > 0)
    .sort((a, b) => (b.structure_score || 0) - (a.structure_score || 0))
    .slice(0, 6);

  const seenCanon = new Set();
  const trusted = canon.filter(c => c.path && !seenCanon.has(c.path) && seenCanon.add(c.path)).slice(0, 6);

  const date = new Date(data.generatedAt);
  const dateStr = isNaN(date) ? '' : date.toISOString().slice(0, 10);

  const stat = (n, label, tone) =>
    `<div class="stat ${tone || ''}"><div class="stat-n">${esc(n)}</div><div class="stat-l">${esc(label)}</div></div>`;

  const connectedRows = connected.map(r => {
    const chips = [];
    if (r.routes) chips.push(`<span class="chip is-warren">${r.routes} connection${r.routes === 1 ? '' : 's'}</span>`);
    if (r.imports) chips.push(`<span class="chip">${r.imports} import${r.imports === 1 ? '' : 's'}</span>`);
    if (r.functions) chips.push(`<span class="chip">${r.functions} fn</span>`);
    return `<li>
      <div class="row-main"><span class="path">${esc(r.path)}</span><span class="role">${esc(roleLabel(r.role))}</span></div>
      <div class="chips">${chips.join('')}</div>
    </li>`;
  }).join('') || '<li class="empty">Nothing scored yet — try a bigger folder.</li>';

  const trustedRows = trusted.map(c => `<li>
      <div class="row-main"><span class="path">${esc(c.path || c.filename)}</span>
        <span class="score">${Math.round((c.canon_score || 0) * 100)}%</span></div>
      <div class="sub">${esc(roleLabel(c.role))}</div>
    </li>`).join('') || '<li class="empty">No source-of-truth candidates surfaced.</li>';

  const residueRows = residue.slice(0, 6).map(r => {
    const signals = Array.isArray(r.residue_signals) && r.residue_signals.length
      ? r.residue_signals : (r.status ? [r.status] : []);
    const sig = signals.slice(0, 3).map(s => `<span class="chip is-thump">${esc(String(s).replace(/_/g, ' '))}</span>`).join('');
    return `<li>
      <div class="row-main"><span class="path">${esc(r.path || r.filename)}</span>
        <span class="role">${esc(roleLabel(r.role))}</span></div>
      <div class="chips">${sig}</div>
    </li>`;
  }).join('') || '<li class="empty">Nothing flagged — clean bill of health. 🎉</li>';

  const rpg = data.rpgCounts;
  const rpgLine = rpg
    ? `${rpg.modules} modules · ${rpg.symbols} functions & symbols · ${rpg.dependencies} links between them`
    : '';

  return /* html */`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PlaneKey snapshot — ${esc(title)}</title>
<style>
:root{
  --bg:#0A0C10; --panel:#11141A; --panel-2:#161A22; --line:#1E2330; --line-2:#2A3142;
  --ink:#E8ECF2; --ink-2:#C5CCD7; --ink-dim:#8E97A4; --ink-mute:#5C6573;
  --burrow:#7CA7FF; --warren:#6FD49A; --thump:#F0B14B;
  --sans:'IBM Plex Sans',ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{
  background:
    radial-gradient(900px 500px at 75% -10%, rgba(124,167,255,.06), transparent 60%),
    radial-gradient(700px 420px at 5% 110%, rgba(111,212,154,.05), transparent 60%),
    var(--bg);
  color:var(--ink); font-family:var(--sans); line-height:1.55; -webkit-font-smoothing:antialiased;
  padding:32px 20px 48px; min-height:100vh;
}
.wrap{max-width:860px;margin:0 auto;}
.hero{margin-bottom:22px;}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--warren);}
h1{font-size:26px;font-weight:700;letter-spacing:-.02em;margin:6px 0 4px;}
h1 em{font-style:normal;color:var(--burrow);}
.lede{color:var(--ink-dim);font-size:14.5px;max-width:60ch;}
.meta{font-family:var(--mono);font-size:11.5px;color:var(--ink-mute);margin-top:8px;}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin:22px 0 26px;}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 14px;}
.stat-n{font-size:28px;font-weight:700;letter-spacing:-.02em;}
.stat-l{font-size:12px;color:var(--ink-dim);margin-top:2px;}
.stat.warren .stat-n{color:var(--warren);}
.stat.burrow .stat-n{color:var(--burrow);}
.stat.thump .stat-n{color:var(--thump);}
section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 18px 8px;margin-bottom:16px;}
.sec-head{display:flex;align-items:baseline;gap:10px;margin-bottom:6px;}
.sec-head h2{font-size:15px;font-weight:600;}
.sec-head p{font-size:12.5px;color:var(--ink-mute);}
ul{list-style:none;}
li{padding:11px 0;border-top:1px solid var(--line);}
li:first-child{border-top:none;}
.row-main{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.path{font-family:var(--mono);font-size:12.5px;color:var(--ink);overflow-wrap:anywhere;}
.role{font-size:11px;color:var(--ink-mute);white-space:nowrap;}
.score{font-family:var(--mono);font-size:12px;color:var(--warren);white-space:nowrap;}
.sub{font-size:11.5px;color:var(--ink-mute);margin-top:2px;}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}
.chip{font-family:var(--mono);font-size:10.5px;color:var(--ink-dim);background:var(--panel-2);
  border:1px solid var(--line-2);border-radius:100px;padding:2px 9px;}
.chip.is-warren{color:var(--warren);border-color:rgba(111,212,154,.3);background:rgba(111,212,154,.08);}
.chip.is-thump{color:var(--thump);border-color:rgba(240,177,75,.3);background:rgba(240,177,75,.08);}
.empty{color:var(--ink-mute);font-size:13px;}
.footer{margin-top:24px;padding:16px 18px;border:1px dashed var(--line-2);border-radius:12px;color:var(--ink-dim);font-size:13px;}
.footer code{font-family:var(--mono);font-size:12px;color:var(--ink-2);background:var(--panel-2);padding:2px 6px;border-radius:5px;}
a{color:var(--burrow);}
</style></head>
<body><div class="wrap">
  <div class="hero">
    <div class="eyebrow">PlaneKey snapshot</div>
    <h1>${esc(title)}</h1>
    <p class="lede">A plain-language look at what's in this codebase and how its pieces connect —
      no blueprints required. ${rpgLine ? esc(rpgLine) + '.' : ''}</p>
    ${dateStr ? `<div class="meta">Taken ${esc(dateStr)}</div>` : ''}
  </div>

  <div class="stats">
    ${stat(files, 'files', 'burrow')}
    ${stat(connections, 'connections', 'warren')}
    ${stat(trusted.length ? canon.length : 0, 'trusted pieces')}
    ${stat(residue.length, 'to review', residue.length ? 'thump' : '')}
  </div>

  <section>
    <div class="sec-head"><h2>What holds it together</h2><p>the most connected pieces</p></div>
    <ul>${connectedRows}</ul>
  </section>

  <section>
    <div class="sec-head"><h2>The trusted core</h2><p>what looks like source-of-truth</p></div>
    <ul>${trustedRows}</ul>
  </section>

  <section>
    <div class="sec-head"><h2>Worth a look</h2><p>flagged for a human's eye — not necessarily wrong</p></div>
    <ul>${residueRows}</ul>
  </section>

  <div class="footer">
    This is the front door. The full technical reports — structure scan, dependency graph,
    timeline, and memory — live in <code>reports/</code> whenever you want to look under the hood.
    Re-take this anytime with <code>PlaneKey: Snapshot Workspace</code>.
  </div>
</div></body></html>`;
}

module.exports = { loadSnapshotData, buildSnapshotHtml, roleLabel };
