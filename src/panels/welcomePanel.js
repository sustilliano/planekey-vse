'use strict';

/**
 * welcomePanel.js — the hands-on "hello world" for PlaneKey.
 * ==========================================================
 * A first-run / on-demand welcome that lets the user pick how to start,
 * and then actually *runs* the steps (the buttons trigger real commands):
 *
 *   • Follow along — replay the job of adding predictive typing: go from
 *     "no suggestions" to working, canon-ranked ghost text on real code.
 *   • Dive in — snapshot your own project and start accumulating history.
 *
 * No branches, no monorepo, no template repo: the "there → here" is the
 * append-only snapshot history the user builds by doing it.
 */

const vscode = require('vscode');
const path = require('path');

let _panel = null;

function openWelcome(context, log) {
  if (_panel) { _panel.reveal(vscode.ViewColumn.Active, false); return; }
  _panel = vscode.window.createWebviewPanel(
    'planekeyWelcome', 'Welcome to PlaneKey', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  _panel.webview.html = html(_panel.webview);
  _panel.onDidDispose(() => { _panel = null; });
  _panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      if (msg.type === 'run' && typeof msg.command === 'string' && msg.command.startsWith('planekey.')) {
        await vscode.commands.executeCommand(msg.command);
      } else if (msg.type === 'openDoc' && msg.file) {
        const root = context.extensionPath || '';
        const uri = vscode.Uri.file(path.join(root, msg.file));
        await vscode.commands.executeCommand('markdown.showPreview', uri).then(undefined,
          () => vscode.window.showTextDocument(uri));
      }
    } catch (e) { if (log) log('[Welcome] ' + e.message); }
  });
}

function html(webview) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return /* html */`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to PlaneKey</title>
<style nonce="${nonce}">
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
  color:var(--ink);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased;
  padding:40px 22px 56px;min-height:100vh;
}
.wrap{max-width:820px;margin:0 auto;}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--warren);}
h1{font-size:27px;font-weight:700;letter-spacing:-.02em;margin:6px 0 6px;}
h1 em{font-style:normal;color:var(--burrow);}
.lede{color:var(--ink-dim);font-size:15px;max-width:62ch;margin-bottom:26px;}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
@media (max-width:680px){.cards{grid-template-columns:1fr;}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px 20px 18px;display:flex;flex-direction:column;}
.card h2{font-size:17px;font-weight:600;margin-bottom:4px;}
.card .tag{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-mute);margin-bottom:10px;}
.card p{font-size:13.5px;color:var(--ink-dim);margin-bottom:12px;}
.steps{list-style:none;margin:0 0 16px;padding:0;display:flex;flex-direction:column;gap:8px;}
.steps li{display:flex;gap:9px;font-size:13px;color:var(--ink-2);}
.steps .n{flex:none;width:18px;height:18px;border-radius:50%;background:var(--panel-2);border:1px solid var(--line-2);
  font-family:var(--mono);font-size:10.5px;display:flex;align-items:center;justify-content:center;color:var(--ink-dim);margin-top:1px;}
.spacer{flex:1;}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;
  font-family:var(--sans);font-size:14px;font-weight:600;padding:11px 16px;border-radius:9px;border:1px solid var(--ink);
  background:var(--ink);color:var(--bg);cursor:pointer;transition:background .12s,border-color .12s;}
.btn:hover{background:#fff;border-color:#fff;}
.btn.warren{background:var(--warren-wash,rgba(111,212,154,.12));border-color:rgba(111,212,154,.4);color:var(--warren);}
.btn.warren:hover{background:rgba(111,212,154,.2);}
.link{margin-top:11px;font-size:12.5px;color:var(--burrow);cursor:pointer;text-align:center;background:none;border:none;font-family:var(--sans);}
.link:hover{text-decoration:underline;}
.foot{margin-top:26px;font-size:12.5px;color:var(--ink-mute);text-align:center;line-height:1.7;}
.foot code{font-family:var(--mono);color:var(--ink-2);background:var(--panel-2);padding:2px 6px;border-radius:5px;}
</style></head>
<body><div class="wrap">
  <div class="eyebrow">Hello world</div>
  <h1>Welcome to Plane<em>Key</em></h1>
  <p class="lede">The trust &amp; memory layer for AI-built software. Pick how you want to start —
    follow along with a real change we made, or point PlaneKey at your own code. Either way,
    nothing is templated or branched: the "there&nbsp;→&nbsp;here" is the snapshot history you build by doing it.</p>

  <div class="cards">
    <div class="card">
      <div class="tag">Guided</div>
      <h2>Follow along</h2>
      <p>Replay the job of adding <strong>predictive typing</strong> — from half-built and
        silent to working, canon-ranked ghost text, on real code. No AI, all local.</p>
      <ul class="steps">
        <li><span class="n">1</span> Build the memory: PlaneKey indexes your codebase from its own reports.</li>
        <li><span class="n">2</span> Open any file and start typing an identifier.</li>
        <li><span class="n">3</span> Watch suggestions appear — drawn from your canon, secrets suppressed.</li>
      </ul>
      <div class="spacer"></div>
      <button class="btn warren" id="follow">Build the memory &amp; try it</button>
      <button class="link" id="how">How we built this →</button>
    </div>

    <div class="card">
      <div class="tag">Your code</div>
      <h2>Dive in</h2>
      <p>Take a first <strong>snapshot</strong> of your own project. You'll get a plain-language
        page of what holds it together — and every future snapshot is kept, building a history.</p>
      <ul class="steps">
        <li><span class="n">1</span> PlaneKey scans your workspace and writes an immutable snapshot.</li>
        <li><span class="n">2</span> The snapshot page opens — read it, no jargon required.</li>
        <li><span class="n">3</span> Change something, snapshot again — that's your "there → here."</li>
      </ul>
      <div class="spacer"></div>
      <button class="btn" id="dive">Take my first snapshot</button>
      <button class="link" id="chat">Or just open the chat →</button>
    </div>
  </div>

  <p class="foot">You can reopen this anytime with <code>PlaneKey: Get Started</code>.</p>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const run = (command) => vscode.postMessage({ type:'run', command });
  document.getElementById('follow').addEventListener('click', () => run('planekey.indexCodebase'));
  document.getElementById('dive').addEventListener('click', () => run('planekey.snapshotWorkspace'));
  document.getElementById('chat').addEventListener('click', () => run('planekey.openChat'));
  document.getElementById('how').addEventListener('click', () => vscode.postMessage({ type:'openDoc', file:'CHANGELOG.md' }));
</script>
</body></html>`;
}

module.exports = { openWelcome };
