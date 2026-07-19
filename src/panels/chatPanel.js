'use strict';

/**
 * chatPanel.js — PlaneKey Chat Control Board
 * ==========================================
 * The chat IS the primary interface. On the web, it mounts as a FAB +
 * full-screen sliding panel and is the main way users navigate, search,
 * message, and manage their PlaneKey account.
 *
 * In the VSE we surface it as a full WebviewPanel (not a side widget) using
 * the production design-system tokens from planekey.css:
 *
 *   Surface:  --bg #0A0C10 / --panel #11141A / --panel-2 #161A22
 *   Ink:      --ink #E8ECF2 / --ink-dim #8E97A4
 *   Tiers:    --burrow #7CA7FF (encrypted/private)
 *             --warren #6FD49A (routing/network)
 *             --thump  #F0B14B (alerts/broadcast)
 *   Type:     IBM Plex Sans + IBM Plex Mono
 *
 * Five channels (full control board):
 *   • Your AI   – pk-client ai proxy completion (PKBridge gated)
 *   • Docs      – pk-client docs search --json (grounded, no LLM)
 *   • Direct    – pk-client burrow send (E2EE, hop/run/vault tier)
 *   • Inbox     – pk-client warren inbox (read-only, click-to-decrypt)
 *   • Settings  – account + bridge config
 *
 * Warren inbox polled every 45s (production rate). Auth state echoed
 * via pk-client trust state --json on open.
 */

const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

const POLL_MS = 45_000;
const TOOL_TIMEOUT_MS = 8_000;

class ChatPanel {
  constructor(context, getPkClient, getNode, getProjectRoot, log) {
    this._context = context;
    this._getPkClient = getPkClient;
    this._getNode = getNode;
    this._getProjectRoot = getProjectRoot;
    this._log = log;
    this._panel = null;
    this._pollTimer = null;
    this._unread = 0;
    this._disposed = false;
  }

  open(channel = 'ai') {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One, false);
      this._panel.webview.postMessage({ type: 'switch_channel', channel });
      return;
    }
    this._panel = vscode.window.createWebviewPanel(
      'planekeyChatBoard',
      'PlaneKey',
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this._context.extensionPath, 'assets'))
        ]
      }
    );
    this._panel.iconPath = vscode.Uri.file(
      path.join(this._context.extensionPath, 'assets', 'planekey.svg')
    );
    this._panel.webview.html = this._buildHtml(this._panel.webview, channel);
    this._panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
    this._panel.onDidDispose(() => { this._panel = null; this._stopPoll(); });
    this._startPoll();
    // Bootstrap: get trust/auth state immediately
    setTimeout(() => this._pushTrustState(), 600);
  }

  openInbox(observationId) {
    this.open('inbox');
    if (observationId && this._panel) {
      this._panel.webview.postMessage({ type: 'open_observation', observationId });
    }
  }

  dispose() {
    this._disposed = true;
    this._stopPoll();
    if (this._panel) { this._panel.dispose(); this._panel = null; }
  }

  // ── message handler (webview → host) ─────────────────────────────

  async _handleMessage(msg) {
    switch (msg.type) {
      case 'ai_completion': {
        const r = await this._pk(['ai', 'proxy', 'completion', '--prompt', msg.prompt, '--json']);
        this._post({ type: 'ai_result', id: msg.id, result: r });
        break;
      }
      case 'docs_search': {
        const r = await this._pk(['docs', 'search', msg.query, '--json']);
        this._post({ type: 'docs_result', id: msg.id, result: r });
        break;
      }
      case 'direct_send': {
        const r = await this._pk(['burrow', 'send', msg.recipient, msg.text, '--tier', msg.tier || 'hop', '--json']);
        this._post({ type: 'direct_result', id: msg.id, result: r });
        break;
      }
      case 'inbox_fetch': {
        const r = await this._pk(['warren', 'inbox', '--json']);
        this._post({ type: 'inbox_result', id: msg.id, result: r });
        break;
      }
      case 'inbox_decrypt': {
        const r = await this._pk(['warren', 'decrypt', msg.messageId, '--json']);
        this._post({ type: 'decrypt_result', id: msg.id, result: r });
        break;
      }
      case 'save_settings': {
        const cfg = vscode.workspace.getConfiguration('planekey');
        if (msg.bridgeUrl) await cfg.update('homeBridgeUrl', msg.bridgeUrl, vscode.ConfigurationTarget.Workspace);
        if (msg.serviceId) await cfg.update('serviceId', msg.serviceId, vscode.ConfigurationTarget.Workspace);
        this._log('[Chat] Settings saved from control board.');
        await this._pushTrustState();
        break;
      }
      case 'log':
        this._log('[Chat] ' + msg.text);
        break;
    }
  }

  // ── warren inbox polling ──────────────────────────────────────────

  _startPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._pollInbox(), POLL_MS);
    this._pollInbox();
  }

  _stopPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  async _pollInbox() {
    if (!this._panel || this._disposed) return;
    try {
      const raw = await this._pk(['warren', 'inbox', '--json', '--unread-only']);
      let count = 0;
      try {
        const p = JSON.parse(raw);
        count = Array.isArray(p) ? p.length : typeof p.unread === 'number' ? p.unread : 0;
      } catch (_) {}
      if (count !== this._unread) {
        this._unread = count;
        this._post({ type: 'unread_update', count });
        this._panel.title = count > 0 ? `PlaneKey (${count})` : 'PlaneKey';
      }
    } catch (_) {}
  }

  async _pushTrustState() {
    if (!this._panel) return;
    const r = await this._pk(['trust', 'state', '--json']);
    try {
      const p = JSON.parse(r);
      this._post({ type: 'auth_update', authenticated: !!(p.authenticated || p.signed_in || p.token), trustData: p });
    } catch (_) {
      this._post({ type: 'auth_update', authenticated: false });
    }
  }

  // ── helpers ───────────────────────────────────────────────────────

  _post(msg) {
    try { if (this._panel) this._panel.webview.postMessage(msg); } catch (_) {}
  }

  _pk(args) {
    const tool = this._getPkClient();
    const isJs = tool.toLowerCase().endsWith('.js');
    const cmd = isJs ? this._getNode() : tool;
    const cmdArgs = isJs ? [tool, ...args] : args;
    return new Promise(resolve =>
      cp.execFile(cmd, cmdArgs, {
        cwd: this._getProjectRoot(), maxBuffer: 4 * 1024 * 1024,
        windowsHide: true, timeout: TOOL_TIMEOUT_MS, env: process.env
      }, (err, stdout) => resolve(err ? JSON.stringify({ error: err.message }) : (stdout || '').trim()))
    );
  }

  // ── HTML (production DS tokens) ───────────────────────────────────

  _buildHtml(_webview, initialChannel) {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${nonce}' https://fonts.googleapis.com https://fonts.gstatic.com; font-src https://fonts.gstatic.com; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PlaneKey</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style nonce="${nonce}">
/* ── PlaneKey DS tokens (from planekey.css) ── */
:root {
  --bg:        #0A0C10;
  --bg-deep:   #07090C;
  --panel:     #11141A;
  --panel-2:   #161A22;
  --panel-3:   #1B2029;
  --line:      #1E2330;
  --line-strong: #2A3142;
  --ink:       #E8ECF2;
  --ink-2:     #C5CCD7;
  --ink-dim:   #8E97A4;
  --ink-mute:  #5C6573;
  --ink-faint: #3A414F;
  --burrow:    #7CA7FF;
  --warren:    #6FD49A;
  --thump:     #F0B14B;
  --danger:    #F07A7A;
  --burrow-wash: rgba(124,167,255,.10);
  --warren-wash: rgba(111,212,154,.10);
  --thump-wash:  rgba(240,177,75,.10);
  --sans: 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, 'JetBrains Mono', monospace;
  --r-card: 8px; --r-tile: 10px; --r-pill: 100px; --r-chip: 4px;
}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{
  background:var(--bg);
  color:var(--ink);
  font-family:var(--sans);
  font-size:14px;
  line-height:1.55;
  height:100vh;
  -webkit-font-smoothing:antialiased;
  font-feature-settings:"ss01","cv11";
  display:flex;
  flex-direction:column;
  overflow:hidden;
}
body{
  background:
    radial-gradient(900px 500px at 70% -10%, rgba(124,167,255,0.05), transparent 60%),
    radial-gradient(700px 400px at 10% 110%, rgba(111,212,154,0.04), transparent 60%),
    var(--bg);
}
a{color:var(--burrow);text-decoration:none;}
code,kbd{font-family:var(--mono);font-size:0.91em;}

/* ── Nav / channel bar ── */
.pk-nav{
  display:flex;
  align-items:center;
  gap:0;
  background:rgba(10,12,16,0.82);
  backdrop-filter:blur(12px) saturate(140%);
  border-bottom:1px solid var(--line);
  flex-shrink:0;
  padding:0 20px;
  height:46px;
}
.pk-brand{
  display:inline-flex;
  align-items:center;
  gap:8px;
  font-family:var(--sans);
  font-weight:600;
  font-size:14px;
  letter-spacing:-0.01em;
  color:var(--ink);
  margin-right:20px;
  flex-shrink:0;
}
.pk-brand svg{flex-shrink:0;}
.pk-brand-word em{font-style:normal;color:var(--burrow);}
.pk-nav-links{
  display:flex;
  gap:2px;
  flex:1;
}
.tab{
  padding:6px 13px;
  font-size:12.5px;
  font-family:var(--sans);
  color:var(--ink-dim);
  border-radius:var(--r-chip);
  cursor:pointer;
  user-select:none;
  border:none;
  background:transparent;
  position:relative;
  white-space:nowrap;
  transition:color .12s, background .12s;
}
.tab:hover{color:var(--ink);background:var(--panel);}
.tab.active{color:var(--ink);background:var(--panel-2);}
.tab.active::after{
  content:'';
  position:absolute;
  bottom:-1px; left:0; right:0;
  height:2px;
  background:var(--warren);
  border-radius:2px 2px 0 0;
}
.badge{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  background:var(--thump);
  color:var(--bg);
  border-radius:var(--r-pill);
  font-size:9.5px;
  font-family:var(--mono);
  font-weight:600;
  padding:0 5px;
  min-width:16px;
  height:16px;
  margin-left:5px;
  vertical-align:middle;
}
.badge.hidden{display:none;}
.pk-nav-spacer{flex:1;}
.auth-chip{
  display:inline-flex;
  align-items:center;
  gap:6px;
  font-family:var(--mono);
  font-size:11px;
  color:var(--ink-mute);
  background:var(--panel);
  border:1px solid var(--line-strong);
  border-radius:var(--r-chip);
  padding:4px 9px;
}
.auth-dot{
  width:6px;height:6px;
  border-radius:50%;
  background:var(--ink-faint);
  flex-shrink:0;
  transition:background .3s, box-shadow .3s;
}
.auth-dot.active{
  background:var(--warren);
  box-shadow:0 0 0 3px rgba(111,212,154,.22);
  animation:pk-pulse 2.2s ease-in-out infinite;
}
@keyframes pk-pulse{
  0%,100%{box-shadow:0 0 0 3px rgba(111,212,154,.22);}
  50%{box-shadow:0 0 0 6px rgba(111,212,154,0);}
}

/* ── Panes ── */
.pane{display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0;}
.pane.active{display:flex;}

/* ── Message list ── */
.messages{
  flex:1;
  overflow-y:auto;
  padding:20px;
  display:flex;
  flex-direction:column;
  gap:10px;
  scroll-behavior:smooth;
}
.messages::-webkit-scrollbar{width:4px;}
.messages::-webkit-scrollbar-track{background:transparent;}
.messages::-webkit-scrollbar-thumb{background:var(--line-strong);border-radius:4px;}
.msg{
  padding:10px 13px;
  border-radius:var(--r-card);
  max-width:78%;
  word-break:break-word;
  line-height:1.55;
  font-size:13.5px;
}
.msg.user{
  background:var(--burrow);
  color:var(--bg);
  align-self:flex-end;
  border-bottom-right-radius:2px;
}
.msg.ai{
  background:var(--panel);
  border:1px solid var(--line);
  color:var(--ink);
  align-self:flex-start;
  border-bottom-left-radius:2px;
}
.msg.ai code{
  background:var(--panel-2);
  border:1px solid var(--line);
  padding:2px 5px;
  border-radius:3px;
}
.msg.system{
  background:transparent;
  color:var(--ink-mute);
  align-self:center;
  font-size:11.5px;
  font-family:var(--mono);
  letter-spacing:.03em;
  max-width:100%;
  text-align:center;
}
.msg.inbox-item{
  background:var(--panel);
  border:1px solid var(--line);
  color:var(--ink);
  align-self:stretch;
  max-width:100%;
  cursor:pointer;
  transition:border-color .12s;
}
.msg.inbox-item:hover{border-color:var(--warren);}
.msg-from{font-family:var(--mono);font-size:11px;color:var(--ink-mute);margin-bottom:4px;}
.msg-preview{color:var(--ink-dim);font-size:12.5px;}
.msg-decrypted{
  margin-top:10px;
  padding-top:10px;
  border-top:1px solid var(--line);
  color:var(--ink);
  font-size:13px;
  white-space:pre-wrap;
}

/* ── Input row ── */
.input-row{
  display:flex;
  gap:8px;
  padding:12px 16px;
  border-top:1px solid var(--line);
  background:var(--panel);
  flex-shrink:0;
  align-items:flex-end;
}
.input-row textarea{
  flex:1;
  resize:none;
  background:var(--panel-2);
  border:1px solid var(--line-strong);
  color:var(--ink);
  border-radius:var(--r-chip);
  padding:8px 10px;
  font-family:var(--sans);
  font-size:13.5px;
  min-height:36px;
  max-height:130px;
  outline:none;
  transition:border-color .12s;
}
.input-row textarea:focus{border-color:var(--warren);}
.input-row textarea::placeholder{color:var(--ink-mute);}
.pk-btn{
  display:inline-flex;align-items:center;gap:7px;
  font-family:var(--sans);font-size:13px;font-weight:500;
  padding:8px 16px;
  border-radius:var(--r-chip);
  border:1px solid var(--line-strong);
  background:var(--panel-2);
  color:var(--ink);
  cursor:pointer;
  white-space:nowrap;
  transition:background .12s, border-color .12s;
}
.pk-btn:hover{background:var(--panel-3);border-color:var(--ink-faint);}
.pk-btn:disabled{opacity:.38;cursor:default;}
.pk-btn-primary{
  background:var(--ink);color:var(--bg);
  border-color:var(--ink);
}
.pk-btn-primary:hover{background:#fff;border-color:#fff;}
.pk-btn-warren{
  background:var(--warren-wash);
  border-color:rgba(111,212,154,.3);
  color:var(--warren);
}
.pk-btn-warren:hover{background:rgba(111,212,154,.18);}

/* ── Tier picker ── */
.tier-row{
  display:flex;
  gap:6px;
  padding:8px 16px;
  background:var(--panel);
  border-top:1px solid var(--line);
  flex-shrink:0;
}
.tier-btn{
  padding:3px 12px;
  border-radius:var(--r-pill);
  border:1px solid var(--line);
  background:transparent;
  color:var(--ink-mute);
  cursor:pointer;
  font-family:var(--mono);
  font-size:11px;
  letter-spacing:.06em;
  text-transform:uppercase;
  transition:all .12s;
}
.tier-btn.selected.hop{border-color:rgba(124,167,255,.5);color:var(--burrow);background:var(--burrow-wash);}
.tier-btn.selected.run{border-color:rgba(111,212,154,.5);color:var(--warren);background:var(--warren-wash);}
.tier-btn.selected.vault{border-color:rgba(240,177,75,.5);color:var(--thump);background:var(--thump-wash);}

/* ── Recipient row ── */
.recipient-row{
  display:flex;
  gap:8px;
  padding:10px 16px;
  border-bottom:1px solid var(--line);
  background:var(--panel-2);
  flex-shrink:0;
  align-items:center;
}
.recipient-row label{
  font-family:var(--mono);font-size:10.5px;
  letter-spacing:.12em;text-transform:uppercase;
  color:var(--ink-mute);white-space:nowrap;
}
.recipient-row input{
  flex:1;
  background:var(--panel);
  border:1px solid var(--line-strong);
  color:var(--ink);
  border-radius:var(--r-chip);
  padding:6px 10px;
  font-family:var(--mono);
  font-size:12px;
  outline:none;
  transition:border-color .12s;
}
.recipient-row input:focus{border-color:var(--burrow);}
.recipient-row input::placeholder{color:var(--ink-mute);}

/* ── Docs results ── */
.doc-result{
  padding:12px 14px;
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:var(--r-card);
  cursor:pointer;
  transition:border-color .12s;
}
.doc-result:hover{border-color:var(--burrow);}
.doc-result-title{
  font-weight:600;font-size:13px;color:var(--ink);
  margin-bottom:4px;
}
.doc-result-excerpt{
  font-size:12px;color:var(--ink-dim);line-height:1.5;
}
.doc-result-anchor{
  font-family:var(--mono);font-size:10.5px;color:var(--burrow);margin-top:5px;
}

/* ── Settings ── */
.settings-body{overflow-y:auto;flex:1;}
.pk-eyebrow{
  font-family:var(--mono);font-size:10px;letter-spacing:.18em;
  text-transform:uppercase;color:var(--ink-mute);font-weight:500;
  padding:16px 18px 8px;
  display:flex;align-items:center;gap:8px;
}
.pk-eyebrow::before{
  content:'';width:14px;height:1px;
  background:var(--ink-faint);display:inline-block;
}
.pk-eyebrow.is-warren{color:var(--warren);}
.pk-eyebrow.is-warren::before{background:var(--warren);}
.setting-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:14px;
  padding:10px 18px;
  border-bottom:1px solid var(--line);
}
.setting-row label{font-size:12.5px;color:var(--ink-dim);white-space:nowrap;}
.setting-row input{
  background:var(--panel-2);
  border:1px solid var(--line-strong);
  color:var(--ink);
  border-radius:var(--r-chip);
  padding:5px 10px;
  font-family:var(--mono);
  font-size:12px;
  width:240px;
  outline:none;
  transition:border-color .12s;
}
.setting-row input:focus{border-color:var(--warren);}
.pk-rule{border:0;border-top:1px solid var(--line);margin:8px 18px;}

/* ── pk-cmd code block ── */
.pk-cmd{
  display:inline-flex;align-items:center;
  font-family:var(--mono);font-size:12.5px;
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:var(--r-chip);
  overflow:hidden;color:var(--ink);
  margin:4px 0;
}
.pk-cmd-prompt{padding:8px 10px;background:var(--panel-2);color:var(--warren);border-right:1px solid var(--line);}
.pk-cmd-text{padding:8px 12px;flex:1;}

/* ── chip ── */
.pk-chip{
  display:inline-flex;align-items:center;gap:5px;
  font-family:var(--mono);font-size:11px;letter-spacing:.04em;
  padding:3px 8px;border-radius:var(--r-chip);
  background:var(--panel-2);border:1px solid var(--line);color:var(--ink-mute);
}
.pk-chip.is-ok{color:var(--warren);border-color:rgba(111,212,154,.25);background:var(--warren-wash);}
.pk-chip.is-warn{color:var(--thump);border-color:rgba(240,177,75,.25);background:var(--thump-wash);}
.pk-chip.is-burrow{color:var(--burrow);border-color:rgba(124,167,255,.25);background:var(--burrow-wash);}

/* ── Empty / hint ── */
.hint{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--ink-mute);text-align:center;padding:32px;}
.hint strong{color:var(--ink-dim);font-size:13.5px;}
.hint small{font-family:var(--mono);font-size:11px;letter-spacing:.05em;}

::selection{background:rgba(124,167,255,.28);color:var(--ink);}
</style>
</head>
<body>

<!-- ── Control bar (the nav IS the navigation) ── -->
<nav class="pk-nav">
  <span class="pk-brand">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="1.5" stroke-linecap="square" width="18" height="18">
      <rect x="2.25" y="2.25" width="19.5" height="19.5" rx="1"/>
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="12" y1="16.25" x2="14.75" y2="16.25"/>
      <circle cx="7.25" cy="12" r="1.4" fill="currentColor" stroke="none"/>
      <circle cx="16.75" cy="12" r="1.4" fill="currentColor" stroke="none"/>
    </svg>
    <span class="pk-brand-word">Plane<em>Key</em></span>
  </span>
  <div class="pk-nav-links">
    <button class="tab" data-ch="ai">Your AI</button>
    <button class="tab" data-ch="docs">Docs</button>
    <button class="tab" data-ch="direct">Direct</button>
    <button class="tab" data-ch="inbox">Inbox <span class="badge hidden" id="inbox-badge">0</span></button>
    <button class="tab" data-ch="settings">Settings</button>
  </div>
  <span class="pk-nav-spacer"></span>
  <div class="auth-chip">
    <span class="auth-dot" id="auth-dot"></span>
    <span id="auth-label">not signed in</span>
  </div>
</nav>

<!-- ── AI ── -->
<div class="pane" id="pane-ai">
  <div class="messages" id="ai-messages">
    <div class="msg system">Your AI &mdash; routed via PKBridge <code>ai_proxy_completion</code>. Set your provider key in Settings.</div>
  </div>
  <div class="input-row">
    <textarea id="ai-input" rows="1" placeholder="Ask anything&hellip;"></textarea>
    <button class="pk-btn pk-btn-primary" id="ai-send">Send</button>
  </div>
</div>

<!-- ── Docs ── -->
<div class="pane" id="pane-docs">
  <div class="messages" id="docs-messages">
    <div class="msg system">Docs &mdash; grounded keyword search via <code>pk-client docs search</code>. Returns ranked excerpts + anchor links. No LLM.</div>
  </div>
  <div class="input-row">
    <textarea id="docs-input" rows="1" placeholder="Search docs&hellip;"></textarea>
    <button class="pk-btn pk-btn-warren" id="docs-send">Search</button>
  </div>
</div>

<!-- ── Direct ── -->
<div class="pane" id="pane-direct">
  <div class="recipient-row">
    <label>To</label>
    <input id="direct-recipient" placeholder="CosmicID &mdash; 144-hex or bridge UUID" />
  </div>
  <div class="messages" id="direct-messages">
    <div class="msg system">E2EE Burrow send. Select a tier below, then send.</div>
  </div>
  <div class="tier-row">
    <button class="tier-btn selected hop" data-tier="hop">hop</button>
    <button class="tier-btn run" data-tier="run">run</button>
    <button class="tier-btn vault" data-tier="vault">vault</button>
  </div>
  <div class="input-row">
    <textarea id="direct-input" rows="1" placeholder="Message&hellip;"></textarea>
    <button class="pk-btn pk-btn-primary" id="direct-send">Send</button>
  </div>
</div>

<!-- ── Inbox ── -->
<div class="pane" id="pane-inbox">
  <div class="messages" id="inbox-messages">
    <div class="msg system">Warren inbox &mdash; click a message to decrypt.</div>
  </div>
  <div class="input-row" style="padding:10px 16px;">
    <button class="pk-btn" id="inbox-refresh" style="width:100%;justify-content:center;">&#8635; Refresh inbox</button>
  </div>
</div>

<!-- ── Settings ── -->
<div class="pane" id="pane-settings">
  <div class="settings-body">
    <div class="pk-eyebrow is-warren">Account</div>
    <div class="setting-row">
      <label>CosmicID / Account</label>
      <input id="s-account" placeholder="Not signed in" />
    </div>
    <div class="setting-row">
      <label>Service ID</label>
      <input id="s-service" placeholder="ide-workspace" />
    </div>
    <hr class="pk-rule">
    <div class="pk-eyebrow">Bridge</div>
    <div class="setting-row">
      <label>Bridge URL</label>
      <input id="s-bridge" placeholder="https://bridge.planekey.dev" />
    </div>
    <div class="setting-row">
      <label>Environment ID</label>
      <input id="s-env" placeholder="local-dev" />
    </div>
    <hr class="pk-rule">
    <div style="padding:14px 18px;">
      <button class="pk-btn pk-btn-primary" id="s-save">Save settings</button>
    </div>
    <div style="padding:0 18px 16px;">
      <span class="pk-chip" id="trust-chip">trust state unknown</span>
    </div>
    <div style="padding:0 18px 24px;font-family:var(--mono);font-size:11px;color:var(--ink-mute);line-height:1.7;">
      Settings write to VS Code workspace config (<code>planekey.*</code>).
      The Your AI channel requires PKBridge desktop access.
    </div>
  </div>
</div>

<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();
  let _state = vscode.getState() || { channel:'${initialChannel}' };
  let _cbs = {};
  let _msgId = 0;
  let _tier = 'hop';

  const nextId = () => 'r' + (++_msgId);

  // ── channel switching ──
  const CHANNELS = ['ai','docs','direct','inbox','settings'];
  function switchTo(ch){
    _state.channel = ch;
    vscode.setState(_state);
    CHANNELS.forEach(c=>{
      document.querySelector('[data-ch="'+c+'"]').classList.toggle('active', c===ch);
      document.getElementById('pane-'+c).classList.toggle('active', c===ch);
    });
    if(ch==='inbox') fetchInbox();
  }
  CHANNELS.forEach(c=>{
    document.querySelector('[data-ch="'+c+'"]').addEventListener('click', ()=>switchTo(c));
  });
  switchTo(_state.channel);

  // ── post helper ──
  function req(type, payload, cb){
    const id = nextId();
    _cbs[id] = cb;
    vscode.postMessage({type, id, ...payload});
  }

  function appendMsg(container, role, content){
    const el = document.getElementById(container);
    const div = document.createElement('div');
    div.className = 'msg '+role;
    if(typeof content === 'string') div.textContent = content;
    else div.appendChild(content);
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    return div;
  }

  // ── AI ──
  const aiSend = document.getElementById('ai-send');
  document.getElementById('ai-input').addEventListener('keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doAi();} });
  aiSend.addEventListener('click', doAi);
  function doAi(){
    const inp = document.getElementById('ai-input');
    const prompt = inp.value.trim();
    if(!prompt) return;
    inp.value=''; autoResize(inp);
    appendMsg('ai-messages','user',prompt);
    const thinking = appendMsg('ai-messages','ai','…');
    aiSend.disabled=true;
    req('ai_completion',{prompt}, result=>{
      aiSend.disabled=false;
      try{
        const p=JSON.parse(result);
        thinking.textContent = p.text||p.completion||p.response||result;
      }catch(_){thinking.textContent=result||'(no response)';}
    });
  }

  // ── Docs ──
  document.getElementById('docs-input').addEventListener('keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doDocs();} });
  document.getElementById('docs-send').addEventListener('click', doDocs);
  function doDocs(){
    const inp=document.getElementById('docs-input');
    const query=inp.value.trim();
    if(!query) return;
    inp.value=''; autoResize(inp);
    appendMsg('docs-messages','user',query);
    const wait=appendMsg('docs-messages','system','Searching…');
    req('docs_search',{query}, result=>{
      wait.remove();
      try{
        const p=JSON.parse(result);
        const items=Array.isArray(p)?p:(p.results||[]);
        if(!items.length){appendMsg('docs-messages','system','No results.'); return;}
        const el=document.getElementById('docs-messages');
        items.slice(0,6).forEach(item=>{
          const card=document.createElement('div');
          card.className='doc-result';
          card.innerHTML=
            '<div class="doc-result-title">'+esc(item.title||item.anchor||'Result')+'</div>'+
            '<div class="doc-result-excerpt">'+esc(item.excerpt||item.text||'')+'</div>'+
            (item.anchor?'<div class="doc-result-anchor">'+esc(item.anchor)+'</div>':'');
          el.appendChild(card);
          el.scrollTop=el.scrollHeight;
        });
      }catch(_){appendMsg('docs-messages','ai',result||'(no results)');}
    });
  }

  // ── Direct / tiers ──
  document.querySelectorAll('.tier-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      _tier=btn.dataset.tier;
      document.querySelectorAll('.tier-btn').forEach(b=>{
        b.classList.remove('selected');
      });
      btn.classList.add('selected');
    });
  });
  document.getElementById('direct-input').addEventListener('keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doDirect();} });
  document.getElementById('direct-send').addEventListener('click', doDirect);
  function doDirect(){
    const rec=document.getElementById('direct-recipient').value.trim();
    const inp=document.getElementById('direct-input');
    const text=inp.value.trim();
    if(!rec){appendMsg('direct-messages','system','Enter a CosmicID recipient first.');return;}
    if(!text) return;
    inp.value=''; autoResize(inp);
    appendMsg('direct-messages','user',text);
    const sent=appendMsg('direct-messages','system','Sending via Burrow ('+_tier+')…');
    req('direct_send',{recipient:rec,text,tier:_tier}, result=>{
      try{
        const p=JSON.parse(result);
        sent.textContent=(p.ok||p.sent)?'✓ Delivered ('+_tier+')':(p.error||'Sent.');
      }catch(_){sent.textContent='Sent.';}
    });
  }

  // ── Inbox ──
  document.getElementById('inbox-refresh').addEventListener('click', fetchInbox);
  function fetchInbox(){
    const el=document.getElementById('inbox-messages');
    el.innerHTML='<div class="msg system">Loading…</div>';
    req('inbox_fetch',{}, result=>{
      el.innerHTML='';
      try{
        const p=JSON.parse(result);
        const arr=Array.isArray(p)?p:(p.messages||[]);
        if(!arr.length){el.innerHTML='<div class="msg system">Inbox is empty.</div>';return;}
        arr.forEach(item=>{
          const div=document.createElement('div');
          div.className='msg inbox-item';
          div.innerHTML=
            '<div class="msg-from">'+esc(item.from||item.sender||'unknown')+'</div>'+
            '<div class="msg-preview">'+esc(item.preview||item.subject||'(encrypted)')+'</div>';
          div.addEventListener('click',()=>decryptMsg(item.id||item.messageId, div));
          el.appendChild(div);
          el.scrollTop=el.scrollHeight;
        });
      }catch(_){el.innerHTML='<div class="msg system">'+esc(result||'Failed to load inbox.')+'</div>';}
    });
  }
  function decryptMsg(id, el){
    el.style.opacity='0.55';
    req('inbox_decrypt',{messageId:id}, result=>{
      el.style.opacity='1';
      try{
        const p=JSON.parse(result);
        const body=document.createElement('div');
        body.className='msg-decrypted';
        body.textContent=p.body||p.text||p.plaintext||result;
        el.appendChild(body);
      }catch(_){
        const body=document.createElement('div');
        body.className='msg-decrypted';
        body.textContent=result;
        el.appendChild(body);
      }
    });
  }

  // ── Settings ──
  document.getElementById('s-save').addEventListener('click',()=>{
    const account=document.getElementById('s-account').value.trim();
    const serviceId=document.getElementById('s-service').value.trim();
    const bridgeUrl=document.getElementById('s-bridge').value.trim();
    const envId=document.getElementById('s-env').value.trim();
    vscode.postMessage({type:'save_settings', account, serviceId, bridgeUrl, envId});
    appendMsg('ai-messages','system','Settings saved.');
  });

  // ── extension → webview ──
  window.addEventListener('message', e=>{
    const msg=e.data;
    if(!msg||!msg.type) return;
    const cb=_cbs[msg.id];
    if(cb&&msg.result!==undefined){delete _cbs[msg.id]; cb(msg.result); return;}
    switch(msg.type){
      case 'unread_update':{
        const b=document.getElementById('inbox-badge');
        b.textContent=msg.count;
        b.classList.toggle('hidden',msg.count===0);
        break;
      }
      case 'switch_channel': switchTo(msg.channel); break;
      case 'open_observation':{
        switchTo('inbox');
        if(msg.observationId) decryptDirectById(msg.observationId);
        break;
      }
      case 'auth_update':{
        const dot=document.getElementById('auth-dot');
        const lbl=document.getElementById('auth-label');
        const chip=document.getElementById('trust-chip');
        dot.classList.toggle('active', !!msg.authenticated);
        lbl.textContent=msg.authenticated?'signed in':'not signed in';
        if(msg.trustData){
          const td=msg.trustData;
          chip.className='pk-chip '+(td.status==='ok'?'is-ok':td.status==='warn'?'is-warn':'');
          chip.textContent='trust: '+(td.status||'unknown');
        }
        break;
      }
    }
  });

  function decryptDirectById(id){
    req('inbox_decrypt',{messageId:id}, result=>{
      const el=document.getElementById('inbox-messages');
      const div=document.createElement('div');
      div.className='msg inbox-item';
      div.innerHTML='<div class="msg-decrypted">'+esc(result)+'</div>';
      el.prepend(div);
    });
  }

  // ── textarea auto-resize ──
  document.querySelectorAll('.input-row textarea').forEach(t=>{
    t.addEventListener('input',()=>autoResize(t));
  });
  function autoResize(t){
    t.style.height='auto';
    t.style.height=Math.min(t.scrollHeight,130)+'px';
  }

  function esc(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();
</script>
</body>
</html>`;
  }
}

module.exports = { ChatPanel };
