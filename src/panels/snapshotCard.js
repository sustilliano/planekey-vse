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

  // Version-integrity check (written alongside the reports by the snapshot).
  const versionIntegrity = readJson(path.join(reportRoot, 'VERSION_INTEGRITY.json'));

  return {
    generatedAt: (structure && structure.generated_at) || new Date().toISOString(),
    rows, canon, residue, rpgCounts, versionIntegrity
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

  // Interactive table data. Ensure a 0–100 score even for older (v1) reports
  // that only carry the raw structure_score.
  const maxScore = rows.reduce((mx, r) => Math.max(mx, r.structure_score || 0), 0) || 1;
  const score100 = (r) => (r.score_100 != null ? r.score_100 : Math.round(100 * (r.structure_score || 0) / maxScore));
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const tableRows = rows.map(r => ({
    p: r.path, role: roleLabel(r.role), s: score100(r), raw: Number((r.structure_score || 0).toFixed(1)),
    routes: r.routes || 0, imports: r.imports || 0, fns: r.functions || 0, risk: r.risk_score || 0,
    sig: r.signature_short || '', signals: (r.residue_signals || []).map(x => String(x).replace(/_/g, ' '))
  }));
  const rowsJson = JSON.stringify(tableRows).replace(/</g, '\\u003c');

  const connected = rows
    .filter(r => (r.structure_score || 0) > 0)
    .sort((a, b) => (b.structure_score || 0) - (a.structure_score || 0))
    .slice(0, 6);

  const seenCanon = new Set();
  const trusted = canon.filter(c => c.path && !seenCanon.has(c.path) && seenCanon.add(c.path)).slice(0, 6);

  const date = new Date(opts.takenAt || data.generatedAt);
  const dateStr = isNaN(date) ? '' : date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

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

  // Version & governance — the version-integrity check, surfaced like any
  // other checker (residue/canon/secrets).
  const vi = data.versionIntegrity;
  const viTone = (l) => l === 'warn' ? 'is-thump' : l === 'ok' ? 'is-warren' : '';
  const viHtml = vi ? `
  <section>
    <div class="sec-head"><h2>Version &amp; governance</h2>
      <p>${vi.ok ? 'version tag agrees with the record' : vi.warnings + ' thing' + (vi.warnings === 1 ? '' : 's') + ' to reconcile'}</p></div>
    <ul>
      <li><div class="row-main"><span class="path">version ${esc(vi.version || '—')}</span>
        <span class="score" style="color:${vi.ok ? 'var(--warren)' : 'var(--thump)'}">${vi.ok ? 'consistent' : 'check'}</span></div></li>
      ${(vi.findings || []).map(f => `<li><div class="chips"><span class="chip ${viTone(f.level)}">${esc(f.message)}</span></div></li>`).join('')}
    </ul>
  </section>` : '';

  return /* html */`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
/* self-explaining glossary */
details.glossary{background:var(--panel);border:1px solid var(--line);border-radius:14px;margin-bottom:16px;padding:0 18px;}
details.glossary summary{cursor:pointer;list-style:none;padding:15px 0;font-size:14px;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:9px;}
details.glossary summary::-webkit-details-marker{display:none;}
details.glossary summary::before{content:'›';color:var(--warren);font-size:16px;transition:transform .15s;display:inline-block;}
details.glossary[open] summary::before{transform:rotate(90deg);}
.gloss{padding:2px 0 14px;display:grid;gap:11px;}
.gloss dt{font-weight:600;font-size:12.5px;color:var(--ink-2);}
.gloss dd{font-size:12.5px;color:var(--ink-dim);margin:2px 0 0;line-height:1.5;}
.gloss code{font-family:var(--mono);font-size:11px;color:var(--warren);}
/* interactive table */
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;}
.controls input{flex:1;min-width:160px;background:var(--panel-2);border:1px solid var(--line-2);color:var(--ink);border-radius:8px;padding:8px 11px;font-family:var(--sans);font-size:13px;outline:none;}
.controls input:focus{border-color:var(--warren);}
.controls button{background:var(--panel-2);border:1px solid var(--line-2);color:var(--ink-dim);border-radius:8px;padding:8px 12px;font-family:var(--mono);font-size:11.5px;cursor:pointer;white-space:nowrap;}
.controls button.on{color:var(--warren);border-color:rgba(111,212,154,.4);}
.tbl-wrap{overflow-x:auto;}
table{width:100%;border-collapse:collapse;font-size:12.5px;}
th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mute);font-weight:600;padding:6px 8px;cursor:pointer;user-select:none;white-space:nowrap;border-bottom:1px solid var(--line-2);}
th:hover{color:var(--ink-dim);}
th.num,td.num{text-align:right;}
td{padding:8px;border-top:1px solid var(--line);vertical-align:top;}
td.num{font-family:var(--mono);}
tr.file{cursor:pointer;}
tr.file:hover td{background:var(--panel-2);}
.bar{height:4px;border-radius:3px;background:var(--panel-2);overflow:hidden;margin-top:4px;min-width:44px;}
.bar>i{display:block;height:100%;background:var(--warren);}
.trole{color:var(--ink-mute);font-size:11px;margin-top:2px;}
tr.detail td{background:var(--bg-deep,#07090C);color:var(--ink-dim);font-family:var(--mono);font-size:11px;}
</style></head>
<body><div class="wrap">
  <div class="hero">
    <div class="eyebrow">PlaneKey snapshot</div>
    <h1>${esc(title)}</h1>
    <p class="lede">A plain-language look at what's in this codebase and how its pieces connect —
      no blueprints required. ${rpgLine ? esc(rpgLine) + '.' : ''}</p>
    ${dateStr ? `<div class="meta">Taken ${esc(dateStr)}${opts.id ? ' · snapshot ' + esc(opts.id) : ''}</div>` : ''}
  </div>

  <div class="stats">
    ${stat(files, 'files', 'burrow')}
    ${stat(connections, 'connections', 'warren')}
    ${stat(trusted.length ? canon.length : 0, 'trusted pieces')}
    ${stat(residue.length, 'to review', residue.length ? 'thump' : '')}
  </div>

  <details class="glossary">
    <summary>How to read this — and why these numbers exist</summary>
    <dl class="gloss">
      <dt>What a snapshot is</dt><dd>A point-in-time read of your code by RootRabbit:Rgano. Snapshots are kept, never overwritten — so you can watch the codebase change over time, which is the whole reason the tool exists.</dd>
      <dt>Score (0–100)</dt><dd>"Structural surface" — how much a file carries (routes + functions + imports), relative to the busiest file. It's centrality, <strong>not</strong> quality: a <code>100</code> isn't better than a <code>27</code>, it just does more.</dd>
      <dt>Routes / connections</dt><dd>Named hand-off points where one part reaches another: HTTP endpoints, IDE commands (<code>CMD</code>/<code>CALL</code>), tools (<code>TOOL</code>), events (<code>EVT</code>), webview messages (<code>MSG</code>), and CLI subcommands (<code>CLI</code>). It's why a tool that does 50 things shows dozens of routes, not one.</dd>
      <dt>Trusted core (canon)</dt><dd>Files that read as source-of-truth, ranked by a canon score. Predictive typing draws its suggestions from these.</dd>
      <dt>Worth a look (residue)</dt><dd>Leftovers a human should glance at — agent-runtime junk, tracking surfaces, or secrets. Flagged for review, not condemned.</dd>
    </dl>
  </details>

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

  <section>
    <div class="sec-head"><h2>Explore all files</h2><p>sort a column, filter, click a row to expand</p></div>
    <div class="controls">
      <input id="pk-filter" type="text" placeholder="Filter by file or role…" aria-label="Filter files">
      <button id="pk-scoremode" class="on">score: 0–100</button>
    </div>
    <div class="tbl-wrap"><table id="pk-table">
      <thead><tr>
        <th class="num" data-k="s">Score</th>
        <th data-k="p">File</th>
        <th class="num" data-k="routes">Routes</th>
        <th class="num" data-k="imports">Imp</th>
        <th class="num" data-k="fns">Fns</th>
        <th class="num" data-k="risk">Risk</th>
      </tr></thead>
      <tbody id="pk-tbody"></tbody>
    </table></div>
  </section>
${viHtml}
  <div class="footer">
    This is the front door. The full technical reports — structure scan, dependency graph,
    timeline, and memory — sit next to this file in this snapshot's folder.
    Every snapshot is kept: this one never overwrote the last. Browse them all in
    <code>../index.html</code>, or re-take with <code>PlaneKey: Snapshot Workspace</code>.
  </div>
</div>
<script nonce="${nonce}">
(function(){
  var ROWS = ${rowsJson};
  var tbody = document.getElementById('pk-tbody');
  var filter = document.getElementById('pk-filter');
  var scoreBtn = document.getElementById('pk-scoremode');
  if(!tbody) return;
  var sortKey='s', sortDir=-1, mode='100';
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function render(){
    var q=(filter.value||'').toLowerCase();
    var rows=ROWS.filter(function(r){return !q || r.p.toLowerCase().indexOf(q)>=0 || r.role.toLowerCase().indexOf(q)>=0;});
    rows.sort(function(a,b){var A=a[sortKey],B=b[sortKey]; if(A<B)return -sortDir; if(A>B)return sortDir; return 0;});
    tbody.innerHTML = rows.map(function(r,i){
      var sc = mode==='100'? r.s : r.raw;
      var bar = mode==='100'? '<div class="bar"><i style="width:'+r.s+'%"></i></div>' : '';
      var det = 'signature '+esc(r.sig)+' · raw score '+r.raw + (r.signals.length? ' · flags: '+r.signals.map(esc).join(', ') : '');
      return '<tr class="file" data-i="'+i+'">'+
          '<td class="num">'+sc+bar+'</td>'+
          '<td><span class="path">'+esc(r.p)+'</span><div class="trole">'+esc(r.role)+'</div></td>'+
          '<td class="num">'+r.routes+'</td><td class="num">'+r.imports+'</td>'+
          '<td class="num">'+r.fns+'</td><td class="num">'+(r.risk||'')+'</td></tr>'+
        '<tr class="detail" data-d="'+i+'" style="display:none"><td colspan="6">'+det+'</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">No files match.</td></tr>';
  }
  filter.addEventListener('input', render);
  scoreBtn.addEventListener('click', function(){
    mode = mode==='100' ? 'raw' : '100';
    scoreBtn.textContent = 'score: ' + (mode==='100' ? '0–100' : 'raw');
    scoreBtn.classList.toggle('on', mode==='100');
    render();
  });
  Array.prototype.forEach.call(document.querySelectorAll('#pk-table th'), function(th){
    th.addEventListener('click', function(){
      var k=th.getAttribute('data-k');
      if(sortKey===k) sortDir=-sortDir; else { sortKey=k; sortDir = (k==='p') ? 1 : -1; }
      render();
    });
  });
  tbody.addEventListener('click', function(e){
    var tr = e.target.closest ? e.target.closest('tr.file') : null;
    if(!tr) return;
    var d = tbody.querySelector('tr.detail[data-d="'+tr.getAttribute('data-i')+'"]');
    if(d) d.style.display = d.style.display==='none' ? '' : 'none';
  });
  render();
})();
</script>
</body></html>`;
}

// A one-line summary of a snapshot, for the append-only ledger.
function summarizeSnapshot(data) {
  const rows = data.rows || [];
  return {
    files: rows.length,
    connections: rows.reduce((a, r) => a + (r.routes || 0), 0),
    trusted: (data.canon || []).length,
    review: (data.residue || []).length,
    modules: data.rpgCounts ? data.rpgCounts.modules : null,
    symbols: data.rpgCounts ? data.rpgCounts.symbols : null
  };
}

// The history page: every snapshot ever taken, newest first, nothing dropped.
// It's a derived listing of the append-only ledger (snapshots/index.json) —
// regenerating it loses no history because the ledger is the record.
function buildHistoryHtml(ledger, opts = {}) {
  const title = opts.title || 'this workspace';
  const entries = (Array.isArray(ledger) ? ledger : []).slice().sort(
    (a, b) => String(b.taken_at || b.id).localeCompare(String(a.taken_at || a.id))
  );
  const rowsHtml = entries.map((e, i) => {
    const when = String(e.taken_at || e.id).replace('T', ' ').replace(/-(\d\d)-(\d\d)-(\d\d\d)Z$/, ':$1:$2').slice(0, 19);
    const badge = i === 0 ? '<span class="chip is-warren">latest</span>' : '';
    return `<li>
      <a class="row-main" href="${esc(e.path || (e.id + '/snapshot.html'))}">
        <span class="path">${esc(when)} UTC ${badge}</span>
        <span class="score">${esc(e.files)} files · ${esc(e.connections)} connections</span>
      </a>
      <div class="sub">${e.symbols != null ? esc(e.symbols) + ' symbols · ' : ''}${esc(e.trusted)} trusted · ${esc(e.review)} to review · <code>${esc(e.id)}</code></div>
    </li>`;
  }).join('') || '<li class="empty">No snapshots recorded yet.</li>';

  return /* html */`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PlaneKey snapshot history — ${esc(title)}</title>
<style>
:root{--bg:#0A0C10;--panel:#11141A;--panel-2:#161A22;--line:#1E2330;--line-2:#2A3142;
--ink:#E8ECF2;--ink-dim:#8E97A4;--ink-mute:#5C6573;--burrow:#7CA7FF;--warren:#6FD49A;
--sans:'IBM Plex Sans',ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
--mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.55;
-webkit-font-smoothing:antialiased;padding:32px 20px 48px;min-height:100vh;}
.wrap{max-width:760px;margin:0 auto;}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--warren);}
h1{font-size:24px;font-weight:700;letter-spacing:-.02em;margin:6px 0 4px;}
.lede{color:var(--ink-dim);font-size:14px;max-width:60ch;margin-bottom:22px;}
section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:6px 18px;}
ul{list-style:none;}
li{padding:13px 0;border-top:1px solid var(--line);}
li:first-child{border-top:none;}
.row-main{display:flex;align-items:center;justify-content:space-between;gap:12px;text-decoration:none;color:inherit;}
.row-main:hover .path{color:var(--burrow);}
.path{font-family:var(--mono);font-size:13px;}
.score{font-family:var(--mono);font-size:12px;color:var(--warren);white-space:nowrap;}
.sub{font-size:11.5px;color:var(--ink-mute);margin-top:3px;}
.sub code{color:var(--ink-dim);}
.chip{font-family:var(--mono);font-size:10px;color:var(--warren);border:1px solid rgba(111,212,154,.3);
background:rgba(111,212,154,.08);border-radius:100px;padding:1px 7px;margin-left:6px;}
</style></head>
<body><div class="wrap">
  <div class="eyebrow">PlaneKey snapshot history</div>
  <h1>${esc(title)}</h1>
  <p class="lede">Every snapshot ever taken, newest first. Snapshots are immutable — a new one
    is added, the old ones are never overwritten — so this is an accurate record over time.</p>
  <section><ul>${rowsHtml}</ul></section>
</div></body></html>`;
}

module.exports = { loadSnapshotData, buildSnapshotHtml, summarizeSnapshot, buildHistoryHtml, roleLabel };
