'use strict';

/**
 * chatPanel.js
 * ============
 * Renders the PlaneKey pk-chat panel as a VS Code WebviewPanel.
 *
 * Five channels mirroring the production web chat (pk-chat.d.ts contract):
 *   • Your AI   – pk-client ai_proxy_completion via PKBridge (desktop only)
 *   • Docs      – grounded keyword search via pk-client docs search --json
 *   • Direct    – E2EE Burrow send (CosmicID recipient, hop/run/vault tier)
 *   • Inbox     – read-only warren inbox, click-to-decrypt, feeds badge
 *   • Settings  – account surfaces + sign in/out
 *
 * No external script tags — everything is self-contained in the webview HTML
 * to satisfy VS Code's strict CSP. Auth state and unread count are bridged
 * from the extension host via postMessage.
 */

const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

const POLL_INTERVAL_MS = 45_000; // match production warren inbox poll rate
const TOOL_TIMEOUT_MS = 8_000;

class ChatPanel {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {() => string} getPkClient
   * @param {() => string} getNode
   * @param {() => string} getProjectRoot
   * @param {(msg: string) => void} log
   */
  constructor(context, getPkClient, getNode, getProjectRoot, log) {
    this._context = context;
    this._getPkClient = getPkClient;
    this._getNode = getNode;
    this._getProjectRoot = getProjectRoot;
    this._log = log;
    /** @type {vscode.WebviewPanel | null} */
    this._panel = null;
    this._pollTimer = null;
    this._unread = 0;
    this._disposed = false;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /** Open (or reveal) the chat panel, optionally switching to a channel. */
  open(channel = 'ai') {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Beside, false);
      this._panel.webview.postMessage({ type: 'switch_channel', channel });
      return;
    }
    this._panel = vscode.window.createWebviewPanel(
      'planekeyChatPanel',
      'PlaneKey Chat',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this._context.extensionPath, 'assets'))]
      }
    );
    this._panel.iconPath = vscode.Uri.file(
      path.join(this._context.extensionPath, 'assets', 'planekey.svg')
    );
    this._panel.webview.html = this._buildHtml(this._panel.webview, channel);
    this._panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
    this._panel.onDidDispose(() => {
      this._panel = null;
      this._stopPoll();
    });
    this._startPoll();
  }

  /** Open the panel directly on the Inbox channel (mirrors window.__PK_CHAT_OPEN_INBOX__). */
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

  // ── message handler (webview → extension) ──────────────────────────────────

  async _handleMessage(msg) {
    switch (msg.type) {
      case 'ai_completion': {
        const result = await this._runPk(['ai', 'proxy', 'completion', '--prompt', msg.prompt, '--json']);
        this._post({ type: 'ai_result', id: msg.id, result });
        break;
      }
      case 'docs_search': {
        const result = await this._runPk(['docs', 'search', msg.query, '--json']);
        this._post({ type: 'docs_result', id: msg.id, result });
        break;
      }
      case 'direct_send': {
        // pk-client burrow send <recipient> <message> --tier <tier> --json
        const result = await this._runPk([
          'burrow', 'send', msg.recipient, msg.text,
          '--tier', msg.tier || 'hop',
          '--json'
        ]);
        this._post({ type: 'direct_result', id: msg.id, result });
        break;
      }
      case 'inbox_fetch': {
        const result = await this._runPk(['warren', 'inbox', '--json']);
        this._post({ type: 'inbox_result', id: msg.id, result });
        break;
      }
      case 'inbox_decrypt': {
        const result = await this._runPk(['warren', 'decrypt', msg.messageId, '--json']);
        this._post({ type: 'decrypt_result', id: msg.id, result });
        break;
      }
      case 'trust_status': {
        const result = await this._runPk(['trust', 'state', '--json']);
        this._post({ type: 'trust_result', id: msg.id, result });
        break;
      }
      case 'log': {
        this._log(`[Chat] ${msg.text}`);
        break;
      }
    }
  }

  // ── warren inbox polling ────────────────────────────────────────────────────

  _startPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._pollInbox(), POLL_INTERVAL_MS);
    // Immediate first poll
    this._pollInbox();
  }

  _stopPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  async _pollInbox() {
    if (!this._panel || this._disposed) return;
    try {
      const raw = await this._runPk(['warren', 'inbox', '--json', '--unread-only']);
      let count = 0;
      try {
        const parsed = JSON.parse(raw);
        count = Array.isArray(parsed) ? parsed.length
          : typeof parsed.unread === 'number' ? parsed.unread : 0;
      } catch (_) { /* non-JSON = no change */ }
      if (count !== this._unread) {
        this._unread = count;
        this._post({ type: 'unread_update', count });
        // Update panel title badge
        this._panel.title = count > 0 ? `PlaneKey Chat (${count})` : 'PlaneKey Chat';
      }
    } catch (_) { /* polling errors are silent */ }
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  _post(msg) {
    if (this._panel) {
      try { this._panel.webview.postMessage(msg); } catch (_) { /* panel may have closed */ }
    }
  }

  _runPk(args) {
    const tool = this._getPkClient();
    const isJs = typeof tool === 'string' && tool.toLowerCase().endsWith('.js');
    const cmd = isJs ? this._getNode() : tool;
    const cmdArgs = isJs ? [tool, ...args] : args;
    return new Promise((resolve) => {
      cp.execFile(cmd, cmdArgs, {
        cwd: this._getProjectRoot(),
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        timeout: TOOL_TIMEOUT_MS,
        env: process.env
      }, (err, stdout) => resolve(err ? JSON.stringify({ error: err.message }) : (stdout || '').trim()));
    });
  }

  // ── HTML ─────────────────────────────────────────────────────────────────────

  _buildHtml(webview, initialChannel) {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PlaneKey Chat</title>
<style nonce="${nonce}">
  :root {
    --pk: #22c55e;
    --pk-dark: #16a34a;
    --accent: #7c3aed;
    --accent-light: #a78bfa;
    --surface: var(--vscode-sideBar-background, #1e1e1e);
    --surface2: var(--vscode-editor-background, #252526);
    --border: var(--vscode-panel-border, #3c3c3c);
    --text: var(--vscode-foreground, #cccccc);
    --text-muted: var(--vscode-descriptionForeground, #8b8b8b);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-border: var(--vscode-input-border, #555);
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-text: var(--vscode-button-foreground, #fff);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    background: var(--surface);
    color: var(--text);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* ── tab bar ── */
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    background: var(--surface2);
    flex-shrink: 0;
  }
  .tab {
    padding: 8px 14px;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    position: relative;
    user-select: none;
    white-space: nowrap;
  }
  .tab.active { color: var(--pk); border-bottom-color: var(--pk); }
  .tab:hover:not(.active) { color: var(--text); }
  .badge {
    display: inline-block;
    background: var(--accent);
    color: #fff;
    border-radius: 8px;
    font-size: 10px;
    padding: 0 5px;
    margin-left: 4px;
    line-height: 16px;
    min-width: 16px;
    text-align: center;
    vertical-align: middle;
  }
  .badge.hidden { display: none; }
  /* ── channel panes ── */
  .pane { display: none; flex: 1; flex-direction: column; overflow: hidden; }
  .pane.active { display: flex; }
  /* ── messages list ── */
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .msg {
    padding: 8px 10px;
    border-radius: 6px;
    max-width: 85%;
    word-break: break-word;
    line-height: 1.5;
  }
  .msg.user { background: var(--accent); color: #fff; align-self: flex-end; }
  .msg.ai { background: var(--surface2); border: 1px solid var(--border); align-self: flex-start; }
  .msg.system { background: transparent; color: var(--text-muted); align-self: center; font-size: 11px; font-style: italic; }
  .msg.inbox-item {
    background: var(--surface2);
    border: 1px solid var(--border);
    align-self: stretch;
    max-width: 100%;
    cursor: pointer;
  }
  .msg.inbox-item:hover { border-color: var(--pk); }
  .msg-meta { font-size: 10px; color: var(--text-muted); margin-top: 3px; }
  /* ── input row ── */
  .input-row {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--border);
    background: var(--surface2);
    flex-shrink: 0;
    align-items: flex-end;
  }
  .input-row textarea {
    flex: 1;
    resize: none;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    color: var(--text);
    border-radius: 4px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: inherit;
    min-height: 36px;
    max-height: 120px;
    outline: none;
  }
  .input-row textarea:focus { border-color: var(--pk); }
  .send-btn {
    background: var(--pk);
    color: #000;
    border: none;
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
    font-weight: 600;
    font-size: 12px;
    white-space: nowrap;
    height: 36px;
  }
  .send-btn:hover { background: var(--pk-dark); }
  .send-btn:disabled { opacity: 0.4; cursor: default; }
  /* ── tier picker ── */
  .tier-row {
    display: flex;
    gap: 6px;
    padding: 6px 12px;
    background: var(--surface2);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .tier-btn {
    padding: 3px 10px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 11px;
  }
  .tier-btn.selected { border-color: var(--pk); color: var(--pk); background: rgba(34,197,94,.08); }
  /* ── recipient row ── */
  .recipient-row {
    display: flex;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .recipient-row input {
    flex: 1;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    color: var(--text);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    outline: none;
  }
  .recipient-row input:focus { border-color: var(--pk); }
  .recipient-row input::placeholder { color: var(--text-muted); }
  /* ── hint ── */
  .hint {
    margin: auto;
    text-align: center;
    color: var(--text-muted);
    padding: 24px;
    line-height: 1.7;
  }
  .hint strong { color: var(--text); }
  /* ── settings rows ── */
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }
  .setting-row label { font-size: 12px; color: var(--text-muted); }
  .setting-row input {
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    color: var(--text);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    width: 220px;
    outline: none;
  }
  .setting-row input:focus { border-color: var(--pk); }
  .save-btn {
    margin: 12px 14px;
    background: var(--btn-bg);
    color: var(--btn-text);
    border: none;
    border-radius: 4px;
    padding: 6px 16px;
    cursor: pointer;
    font-size: 12px;
  }
  .status-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    margin-right: 6px;
    vertical-align: middle;
  }
  .status-dot.auth { background: var(--pk); box-shadow: 0 0 4px var(--pk); }
</style>
</head>
<body>

<!-- ── Tab bar ─────────────────────────────────────────────────── -->
<div class="tabs">
  <div class="tab" data-ch="ai" id="tab-ai">Your AI</div>
  <div class="tab" data-ch="docs" id="tab-docs">Docs</div>
  <div class="tab" data-ch="direct" id="tab-direct">Direct</div>
  <div class="tab" data-ch="inbox" id="tab-inbox">Inbox <span class="badge hidden" id="inbox-badge">0</span></div>
  <div class="tab" data-ch="settings" id="tab-settings"><span class="status-dot" id="auth-dot"></span>Settings</div>
</div>

<!-- ── AI channel ─────────────────────────────────────────────── -->
<div class="pane" id="pane-ai">
  <div class="messages" id="ai-messages">
    <div class="msg system">Your AI — routed through PKBridge ai_proxy_completion. Set your provider key in Settings.</div>
  </div>
  <div class="input-row">
    <textarea id="ai-input" rows="1" placeholder="Ask anything…"></textarea>
    <button class="send-btn" id="ai-send">Send</button>
  </div>
</div>

<!-- ── Docs channel ───────────────────────────────────────────── -->
<div class="pane" id="pane-docs">
  <div class="messages" id="docs-messages">
    <div class="msg system">Docs — grounded keyword search via pk-client. No LLM: returns ranked excerpts + anchor links.</div>
  </div>
  <div class="input-row">
    <textarea id="docs-input" rows="1" placeholder="Search docs…"></textarea>
    <button class="send-btn" id="docs-send">Search</button>
  </div>
</div>

<!-- ── Direct channel ────────────────────────────────────────── -->
<div class="pane" id="pane-direct">
  <div class="recipient-row">
    <input id="direct-recipient" placeholder="CosmicID recipient (144-hex or bridge UUID)" />
  </div>
  <div class="messages" id="direct-messages">
    <div class="msg system">E2EE Burrow send. Choose a tier below.</div>
  </div>
  <div class="tier-row">
    <button class="tier-btn selected" data-tier="hop" id="tier-hop">hop</button>
    <button class="tier-btn" data-tier="run" id="tier-run">run</button>
    <button class="tier-btn" data-tier="vault" id="tier-vault">vault</button>
  </div>
  <div class="input-row">
    <textarea id="direct-input" rows="1" placeholder="Message…"></textarea>
    <button class="send-btn" id="direct-send">Send</button>
  </div>
</div>

<!-- ── Inbox channel ──────────────────────────────────────────── -->
<div class="pane" id="pane-inbox">
  <div class="messages" id="inbox-messages">
    <div class="msg system">Warren inbox — click a message to decrypt.</div>
  </div>
  <div class="input-row">
    <button class="send-btn" id="inbox-refresh" style="width:100%">Refresh inbox</button>
  </div>
</div>

<!-- ── Settings channel ───────────────────────────────────────── -->
<div class="pane" id="pane-settings">
  <div class="setting-row">
    <label>Account / CosmicID</label>
    <input id="s-account" placeholder="Not signed in" />
  </div>
  <div class="setting-row">
    <label>AI Provider Key</label>
    <input id="s-provider-key" type="password" placeholder="sk-…" />
  </div>
  <div class="setting-row">
    <label>Bridge URL</label>
    <input id="s-bridge-url" placeholder="https://bridge.planekey.dev" />
  </div>
  <button class="save-btn" id="s-save">Save settings</button>
  <div style="padding:12px 14px; font-size:11px; color:var(--text-muted)">
    Settings are stored in VS Code workspace configuration (planekey.*).
    The AI channel requires PKBridge desktop access.
  </div>
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  let _state = vscode.getState() || { channel: '${initialChannel}', history: {}, settings: {} };
  let _pendingCallbacks = {};
  let _msgId = 0;
  let _selectedTier = 'hop';

  function nextId() { return 'msg-' + (++_msgId); }

  // ── channel switching ──
  const CHANNELS = ['ai', 'docs', 'direct', 'inbox', 'settings'];
  function switchTo(ch) {
    _state.channel = ch;
    vscode.setState(_state);
    CHANNELS.forEach(c => {
      document.getElementById('tab-' + c).classList.toggle('active', c === ch);
      document.getElementById('pane-' + c).classList.toggle('active', c === ch);
    });
    if (ch === 'inbox') fetchInbox();
  }
  CHANNELS.forEach(ch => {
    document.getElementById('tab-' + ch).addEventListener('click', () => switchTo(ch));
  });
  switchTo(_state.channel);

  // ── send helpers ──
  function postRequest(type, payload, onResult) {
    const id = nextId();
    _pendingCallbacks[id] = onResult;
    vscode.postMessage({ type, id, ...payload });
  }

  function appendMsg(containerId, role, text) {
    const el = document.getElementById(containerId);
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    return div;
  }

  // ── AI ──
  document.getElementById('ai-send').addEventListener('click', sendAi);
  document.getElementById('ai-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAi(); }
  });
  function sendAi() {
    const input = document.getElementById('ai-input');
    const prompt = input.value.trim();
    if (!prompt) return;
    input.value = '';
    appendMsg('ai-messages', 'user', prompt);
    const thinking = appendMsg('ai-messages', 'ai', '…');
    document.getElementById('ai-send').disabled = true;
    postRequest('ai_completion', { prompt }, (result) => {
      document.getElementById('ai-send').disabled = false;
      try {
        const parsed = JSON.parse(result);
        thinking.textContent = parsed.text || parsed.completion || parsed.response || result;
      } catch (_) {
        thinking.textContent = result || '(no response)';
      }
    });
  }

  // ── Docs ──
  document.getElementById('docs-send').addEventListener('click', sendDocs);
  document.getElementById('docs-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDocs(); }
  });
  function sendDocs() {
    const input = document.getElementById('docs-input');
    const query = input.value.trim();
    if (!query) return;
    input.value = '';
    appendMsg('docs-messages', 'user', query);
    const waiting = appendMsg('docs-messages', 'ai', 'Searching…');
    postRequest('docs_search', { query }, (result) => {
      try {
        const parsed = JSON.parse(result);
        const items = Array.isArray(parsed) ? parsed : parsed.results || [];
        if (!items.length) { waiting.textContent = 'No results found.'; return; }
        waiting.remove();
        items.slice(0, 5).forEach(item => {
          const div = appendMsg('docs-messages', 'ai', '');
          const title = document.createElement('strong');
          title.textContent = item.title || item.anchor || 'Result';
          const excerpt = document.createElement('div');
          excerpt.className = 'msg-meta';
          excerpt.textContent = item.excerpt || item.text || '';
          div.appendChild(title);
          div.appendChild(excerpt);
        });
      } catch (_) {
        waiting.textContent = result || '(no results)';
      }
    });
  }

  // ── Direct ──
  ['hop','run','vault'].forEach(tier => {
    document.getElementById('tier-' + tier).addEventListener('click', () => {
      _selectedTier = tier;
      ['hop','run','vault'].forEach(t =>
        document.getElementById('tier-' + t).classList.toggle('selected', t === tier));
    });
  });
  document.getElementById('direct-send').addEventListener('click', sendDirect);
  document.getElementById('direct-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDirect(); }
  });
  function sendDirect() {
    const recipient = document.getElementById('direct-recipient').value.trim();
    const input = document.getElementById('direct-input');
    const text = input.value.trim();
    if (!recipient) { appendMsg('direct-messages', 'system', 'Enter a CosmicID recipient first.'); return; }
    if (!text) return;
    input.value = '';
    appendMsg('direct-messages', 'user', text);
    const sent = appendMsg('direct-messages', 'system', 'Sending…');
    postRequest('direct_send', { recipient, text, tier: _selectedTier }, (result) => {
      try {
        const parsed = JSON.parse(result);
        sent.textContent = parsed.ok || parsed.sent ? '✓ Delivered via Burrow (' + _selectedTier + ')' : (parsed.error || 'Sent.');
      } catch (_) { sent.textContent = 'Sent.'; }
    });
  }

  // ── Inbox ──
  document.getElementById('inbox-refresh').addEventListener('click', fetchInbox);
  function fetchInbox() {
    const el = document.getElementById('inbox-messages');
    el.innerHTML = '<div class="msg system">Loading…</div>';
    postRequest('inbox_fetch', {}, (result) => {
      el.innerHTML = '';
      try {
        const items = JSON.parse(result);
        const arr = Array.isArray(items) ? items : items.messages || [];
        if (!arr.length) {
          el.innerHTML = '<div class="msg system">Inbox is empty.</div>';
          return;
        }
        arr.forEach(item => {
          const div = document.createElement('div');
          div.className = 'msg inbox-item';
          const from = document.createElement('strong');
          from.textContent = item.from || item.sender || 'Unknown';
          const preview = document.createElement('div');
          preview.className = 'msg-meta';
          preview.textContent = item.preview || item.subject || '(encrypted)';
          div.appendChild(from);
          div.appendChild(preview);
          div.addEventListener('click', () => decryptItem(item.id || item.messageId, div));
          el.appendChild(div);
        });
      } catch (_) {
        el.innerHTML = '<div class="msg system">' + (result || 'Failed to load inbox.') + '</div>';
      }
    });
  }
  function decryptItem(id, el) {
    el.style.opacity = '0.5';
    postRequest('inbox_decrypt', { messageId: id }, (result) => {
      el.style.opacity = '1';
      try {
        const parsed = JSON.parse(result);
        const body = document.createElement('div');
        body.style.marginTop = '6px';
        body.style.borderTop = '1px solid var(--border)';
        body.style.paddingTop = '6px';
        body.textContent = parsed.body || parsed.text || parsed.plaintext || result;
        el.appendChild(body);
      } catch (_) {
        el.appendChild(Object.assign(document.createElement('div'), { textContent: result }));
      }
    });
  }

  // ── Settings ──
  document.getElementById('s-save').addEventListener('click', () => {
    const account = document.getElementById('s-account').value.trim();
    const providerKey = document.getElementById('s-provider-key').value.trim();
    const bridgeUrl = document.getElementById('s-bridge-url').value.trim();
    vscode.postMessage({ type: 'log', text: 'Settings saved from chat panel.' });
    // Post back to extension so it can update workspace config
    vscode.postMessage({ type: 'save_settings', account, providerKey, bridgeUrl });
    appendMsg('ai-messages', 'system', 'Settings saved.');
  });

  // ── extension → webview messages ──
  window.addEventListener('message', e => {
    const msg = e.data;
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'ai_result':
      case 'docs_result':
      case 'inbox_result':
      case 'decrypt_result':
      case 'direct_result':
      case 'trust_result': {
        const cb = _pendingCallbacks[msg.id];
        if (cb) { delete _pendingCallbacks[msg.id]; cb(msg.result); }
        break;
      }
      case 'unread_update': {
        const badge = document.getElementById('inbox-badge');
        badge.textContent = msg.count;
        badge.classList.toggle('hidden', msg.count === 0);
        break;
      }
      case 'switch_channel': {
        switchTo(msg.channel);
        break;
      }
      case 'open_observation': {
        switchTo('inbox');
        // auto-decrypt by observationId if present
        if (msg.observationId) {
          postRequest('inbox_decrypt', { messageId: msg.observationId }, (result) => {
            const el = document.getElementById('inbox-messages');
            const div = document.createElement('div');
            div.className = 'msg inbox-item';
            div.textContent = result;
            el.prepend(div);
          });
        }
        break;
      }
      case 'auth_update': {
        const dot = document.getElementById('auth-dot');
        dot.classList.toggle('auth', !!msg.authenticated);
        break;
      }
    }
  });

  // Request initial trust state
  vscode.postMessage({ type: 'trust_status', id: 'init-trust' });
})();
</script>
</body>
</html>`;
  }
}

module.exports = { ChatPanel };
