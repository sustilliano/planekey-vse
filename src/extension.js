'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PredictiveTypingProvider } = require('./providers/predictiveTypingProvider');
const { ChatPanel } = require('./panels/chatPanel');

const EXT_VERSION = '0.2.4';
const OUTPUT_NAME = 'PlaneKey';

let output;
let statusBar;
let trustProvider;
let actionProvider;
let predictiveProvider;
let chatPanel;
// Install root of THIS extension — the bundled toolchain (pk-client,
// pk-memory, the MCP server) lives under <extensionRoot>/toolchain/, so a
// fresh install works with zero config in the editor, from the CLI, and
// over MCP. Set in activate().
let extensionRoot = '';
let lastState = {
  status: 'unknown',
  label: 'PlaneKey: unknown',
  projectRoot: '',
  pkClient: '',
  currentFileRisk: 'unknown',
  lastRuns: {},
  findings: []
};

function activate(context) {
  extensionRoot = context.extensionPath || '';
  output = vscode.window.createOutputChannel(OUTPUT_NAME);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
  statusBar.command = 'planekey.refreshStatus';
  context.subscriptions.push(output, statusBar);

  trustProvider = new TrustProvider();
  actionProvider = new ActionProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('planekeyTrustView', trustProvider),
    vscode.window.registerTreeDataProvider('planekeyActionsView', actionProvider)
  );

  // ── Predictive typing inline completion ──────────────────────────────────
  predictiveProvider = new PredictiveTypingProvider(
    getProjectRoot(),
    getPkClient,
    getPkMemory,
    getNode,
    (msg) => appendLog(msg)
  );
  const COMPLETION_LANGUAGES = [
    { scheme: 'file', language: 'javascript' },
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'typescriptreact' },
    { scheme: 'file', language: 'javascriptreact' },
    { scheme: 'file', language: 'html' },
    { scheme: 'file', language: 'json' }
  ];
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      COMPLETION_LANGUAGES,
      predictiveProvider
    )
  );
  appendLog('[Predictive] Inline completion provider registered.');

  // ── Chat control board (WebviewPanel) ────────────────────────────────────
  chatPanel = new ChatPanel(
    context,
    getPkClient,
    getNode,
    getProjectRoot,
    (msg) => appendLog(msg)
  );
  context.subscriptions.push({ dispose: () => chatPanel && chatPanel.dispose() });
  appendLog('[Chat] Control board registered.');

  const commands = [
    ['planekey.refreshStatus', refreshStatus],
    ['planekey.runRepoGuard', () => runScan('RepoGuard', ['repoguard', 'scan', getProjectRoot()], { parse: true })],
    ['planekey.runPixelGuard', () => runScan('PixelGuard', ['pixelguard', 'scan', getProjectRoot(), '--name', scanName('ide-pixelguard')], { parse: true })],
    ['planekey.runResidueMap', () => runScan('ResidueGuard', ['residue', 'map', getProjectRoot(), '--name', scanName('ide-residue')], { parse: true })],
    ['planekey.runRootRabbit', () => runScan('RootRabbit', ['rootrabbit', 'scan', getProjectRoot()], { parse: true })],
    ['planekey.runSafetyNet', () => runScan('SafetyNet', ['safetynet', 'scan', getProjectRoot()], { parse: true })],
    ['planekey.runMemoryBuild', runMemoryBuild],
    ['planekey.runRganoScan', runRganoScan],
    ['planekey.runCanonRank', runCanonRank],
    ['planekey.runGraftPlan', runGraftPlan],
    ['planekey.runOperatorDoctor', runOperatorDoctor],
    ['planekey.openIncident', openOperatorIncident],
    ['planekey.attestDev', attestDev],
    ['planekey.createSafeBundle', createSafeBundle],
    ['planekey.openReports', openReports],
    ['planekey.setPkClientPath', setPkClientPath],
    ['planekey.setPkMemoryPath', setPkMemoryPath],
    ['planekey.setPkOperatorPath', setPkOperatorPath],
    ['planekey.setProjectRoot', setProjectRoot],
    ['planekey.runFlightReport', runFlightReport],
    ['planekey.runCanonAnalyze', runCanonAnalyze],
    ['planekey.runForensicsAttribution', runForensicsAttribution],
    ['planekey.runRganoPacket', runRganoPacket],
    ['planekey.runRootRabbitHealth', runRootRabbitHealth],
    ['planekey.runCoherencePack', runCoherencePack],
    ['planekey.runTrustState', runTrustState],
    ['planekey.runRpgReachable', runRpgReachable],
    ['planekey.runMatrixCarryForward', runMatrixCarryForward],
    ['planekey.runDecisionsDistribution', runDecisionsDistribution],
    ['planekey.runOperatorReplay', runOperatorReplay],
    ['planekey.setMcpServerPath', setMcpServerPath],
    ['planekey.refreshMcpServer', () => { mcpDidChange.fire(); vscode.window.showInformationMessage('PlaneKey MCP: re-registered with the MCP host.'); }],
    ['planekey.showCliSetup', showCliSetup],
    ['planekey.openPkClientTerminal', openPkClientTerminal],
    // Chat control board
    ['planekey.openChat', () => chatPanel.open('ai')],
    ['planekey.openChatDocs', () => chatPanel.open('docs')],
    ['planekey.openChatDirect', () => chatPanel.open('direct')],
    ['planekey.openInbox', () => chatPanel.openInbox()],
    // Predictive typing commands
    ['planekey.indexCodebase', indexCodebase],
    ['planekey.buildDB', buildDB],
    ['planekey.snapshotWorkspace', snapshotWorkspace],
    ['planekey.refreshCache', refreshPredictiveCache],
    ['planekey.showMemoryStats', showMemoryStats],
    ['planekey.togglePredictive', togglePredictive]
  ];
  for (const [name, fn] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(name, fn));
  }

  registerMcpServer(context);

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    updateCurrentFileRisk();
    refreshViews();
  }));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => {
    if (getConfig().get('autoRefreshOnSave')) {
      updateCurrentFileRisk();
      refreshViews();
    }
  }));

  // Invalidate predictive cache on config change
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('planekey') && predictiveProvider) {
      predictiveProvider.invalidateCache();
    }
  }));

  // Invalidate predictive cache when an operator incident file changes
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.fileName.includes('.planekey/operator/incidents') && predictiveProvider) {
      predictiveProvider.onIncidentChanged(e.document);
    }
  }));

  updateCurrentFileRisk();
  refreshStatus({ quiet: true });

  // Optional: generate a full workspace snapshot on init (like pk snapshot),
  // so a fresh session starts with an up-to-date report set.
  if (getConfig().get('snapshotOnStartup')) {
    setTimeout(() => snapshotWorkspace({ quiet: true }), 2500);
  }
}

function deactivate() {
  if (predictiveProvider) predictiveProvider.dispose();
}

// ── PlaneKey Env-Observer MCP server ────────────────────────────────────────
const mcpDidChange = new vscode.EventEmitter();

function registerMcpServer(context) {
  context.subscriptions.push(mcpDidChange);
  const lm = vscode.lm;
  if (!lm || typeof lm.registerMcpServerDefinitionProvider !== 'function' || typeof vscode.McpStdioServerDefinition !== 'function') {
    appendLog('[MCP] This VS Code build predates the MCP server provider API (needs 1.101+); MCP auto-registration skipped. Use mcp/*_config.example.json to wire it manually.\n');
    return;
  }
  context.subscriptions.push(lm.registerMcpServerDefinitionProvider('planekey.envObserver', {
    onDidChangeMcpServerDefinitions: mcpDidChange.event,
    provideMcpServerDefinitions() {
      const server = resolveMcpServerPath();
      if (!server) {
        appendLog('[MCP] planekey_env_observer_server.py not found. Set planekey.mcpServerPath.\n');
        return [];
      }
      const cfg = getConfig();
      const python = (cfg.get('mcpPythonPath') || '').trim()
        || (process.platform === 'win32' ? 'python' : 'python3');
      const env = {
        PLANEKEY_HOME_BRIDGE_URL: (cfg.get('homeBridgeUrl') || 'https://bridge.planekey.dev').trim(),
        PLANEKEY_SERVICE_ID: (cfg.get('serviceId') || 'ide-workspace').trim(),
        PLANEKEY_ENVIRONMENT_ID: (cfg.get('environmentId') || 'local-dev').trim(),
        PLANEKEY_WORKSPACE_ROOT: getProjectRoot(),
        PLANEKEY_MCP_ALLOW_SUBMIT: cfg.get('mcpAllowSubmit') ? 'true' : 'false'
      };
      const def = new vscode.McpStdioServerDefinition(
        'PlaneKey Env-Observer',
        python,
        [server],
        env,
        EXT_VERSION
      );
      try { def.cwd = vscode.Uri.file(path.dirname(server)); } catch (_) { /* cwd optional */ }
      return [def];
    }
  }));
  appendLog('[MCP] PlaneKey Env-Observer MCP provider registered.\n');
}

function resolveMcpServerPath() {
  const configured = (getConfig().get('mcpServerPath') || '').trim();
  if (configured) return fs.existsSync(configured) ? configured : '';
  const bundled = bundledTool('mcp/planekey_env_observer_server.py');
  if (bundled) return bundled;
  const root = getProjectRoot();
  const candidates = [
    path.join(root, 'mcp', 'planekey_env_observer_server.py'),
    path.join(root, 'products', 'bridge', 'mcp', 'planekey_env_observer_server.py'),
    path.join(root, '..', 'bridge', 'mcp', 'planekey_env_observer_server.py'),
    path.join(root, 'bridge', 'mcp', 'planekey_env_observer_server.py')
  ];
  const pkc = (getConfig().get('pkClientPath') || '').trim();
  if (pkc) {
    const guess = path.resolve(path.dirname(pkc), '..', '..', 'bridge', 'mcp', 'planekey_env_observer_server.py');
    candidates.push(guess);
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return '';
}

async function showCliSetup() {
  const bundled = bundledTool('pk-client/bin/pk-client.js');
  if (!bundled) {
    vscode.window.showWarningMessage('PlaneKey: bundled pk-client not found in this extension. Reinstall the extension or set planekey.pkClientPath.');
    return;
  }
  const node = getNode();
  const alias = process.platform === 'win32'
    ? `doskey pk-client=${node} "${bundled}" $*`
    : `alias pk-client='${node} "${bundled}"'`;
  const shellHint = process.platform === 'win32'
    ? 'Add to your PowerShell profile, or just run the full command.'
    : "Add to your ~/.zshrc or ~/.bashrc, then `source` it.";
  const runLine = `${node} "${bundled}" --help`;
  const pick = await vscode.window.showInformationMessage(
    `PlaneKey CLI is bundled with this extension. Alias:\n\n${alias}\n\n${shellHint}`,
    { modal: true, detail: `Or run directly:\n${runLine}` },
    'Copy alias', 'Copy run command'
  );
  if (pick === 'Copy alias') {
    await vscode.env.clipboard.writeText(alias);
    vscode.window.showInformationMessage('PlaneKey: alias copied to clipboard.');
  } else if (pick === 'Copy run command') {
    await vscode.env.clipboard.writeText(runLine);
    vscode.window.showInformationMessage('PlaneKey: run command copied to clipboard.');
  }
}

async function openPkClientTerminal() {
  const bundled = bundledTool('pk-client/bin/pk-client.js');
  const node = getNode();
  const root = getProjectRoot();
  const terminal = vscode.window.createTerminal({
    name: 'pk-client',
    cwd: root,
    message: `PlaneKey pk-client terminal — project root: ${root}`
  });
  terminal.show(false);
  if (bundled) {
    terminal.sendText(`${node} "${bundled}" --help`, true);
  } else {
    vscode.window.showInformationMessage(
      'PlaneKey: bundled pk-client not found; falling back to global pk-client on PATH.'
    );
    terminal.sendText('pk-client --help', true);
  }
}

// ── Predictive typing commands ───────────────────────────────────────────────

async function indexCodebase() {
  const name = scanName('ide-memory');
  vscode.window.showInformationMessage('PlaneKey: Indexing codebase for predictive typing...');
  await runExternalBinary('Index Codebase', getPkMemory(), ['memory', 'build', getProjectRoot(), '--name', name]);
  if (predictiveProvider) predictiveProvider.invalidateCache();
  vscode.window.showInformationMessage('PlaneKey: Codebase indexed. Predictive typing cache refreshed.');
}

async function buildDB() {
  vscode.window.showInformationMessage('PlaneKey: Building repo DB for predictive typing...');
  await runExternalBinary('Build Repo DB', getPkMemory(), ['rgano', 'scan', getProjectRoot(), '--name', scanName('ide-rgano')]);
  if (predictiveProvider) predictiveProvider.invalidateCache();
  vscode.window.showInformationMessage('PlaneKey: Repo DB built. Predictive typing cache refreshed.');
}

function refreshPredictiveCache() {
  if (predictiveProvider) {
    predictiveProvider.invalidateCache();
    vscode.window.showInformationMessage('PlaneKey: Predictive typing cache cleared.');
  }
}

// ── Workspace snapshot ───────────────────────────────────────────────────────
// Runs the whole RootRabbit:Rgano / TMrFS report suite into an IMMUTABLE,
// timestamped folder: <reportRoot>/snapshots/<id>/. Snapshots are never
// overwritten — each run is added, past runs are kept — so you accumulate an
// honest history of the codebase over time (which is the whole point of a
// memory / lineage tool). A running ledger (snapshots/index.json) is the
// append-only record; snapshots/index.html is a derived view of it.
const SNAPSHOT_REPORTS = [
  { label: 'Rgano structure scan', args: (root, out) => ['rgano', 'scan', root, '--name', 'snapshot', '--out', out] },
  { label: 'Repository Planning Graph', args: (root, out) => ['memory', 'rpg', root, '--name', 'snapshot', '--out', out] },
  { label: 'Timeline', args: (root, out) => ['memory', 'timeline', root, '--name', 'snapshot', '--out', out] },
  { label: 'TMrFS memory', args: (root, out) => ['memory', 'build', root, '--name', 'snapshot', '--out', out] }
];

// FS-safe, sortable, unique to the millisecond — never reused, never reissued.
function snapshotId(d = new Date()) { return d.toISOString().replace(/[:.]/g, '-'); }

async function snapshotWorkspace(options = {}) {
  const root = getProjectRoot();
  const reportRoot = getReportRoot();
  const quiet = !!options.quiet;
  const takenAt = new Date();
  const id = snapshotId(takenAt);
  const snapDir = path.join(reportRoot, 'snapshots', id);

  const results = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `PlaneKey: Snapshot ${id}`,
    cancellable: false
  }, async (progress) => {
    const acc = [];
    for (let i = 0; i < SNAPSHOT_REPORTS.length; i++) {
      const step = SNAPSHOT_REPORTS[i];
      progress.report({ message: `${step.label} (${i + 1}/${SNAPSHOT_REPORTS.length})`, increment: 100 / SNAPSHOT_REPORTS.length });
      const r = await runBinary(getPkMemory(), step.args(root, snapDir), { cwd: root });
      lastState.lastRuns[`Snapshot: ${step.label}`] = {
        time: new Date().toISOString(), code: r.code, ok: !r.error,
        summary: summarizeOutput(r.stdout + '\n' + r.stderr)
      };
      acc.push({ label: step.label, ok: !r.error });
    }
    return acc;
  });

  if (predictiveProvider) predictiveProvider.invalidateCache();
  refreshViews();

  // Front-door card (inside this snapshot's immutable folder) + append this
  // run to the history ledger. Nothing here rewrites a previous snapshot.
  let cardHtml = '';
  const title = path.basename(root) || 'workspace';
  try {
    const { loadSnapshotData, buildSnapshotHtml, summarizeSnapshot, buildHistoryHtml } = require('./panels/snapshotCard');
    const data = loadSnapshotData(snapDir, {});
    cardHtml = buildSnapshotHtml(data, { title, id, takenAt: takenAt.toISOString() });
    fs.writeFileSync(path.join(snapDir, 'snapshot.html'), cardHtml);

    const ledgerPath = path.join(reportRoot, 'snapshots', 'index.json');
    let ledger = [];
    try { const j = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); if (Array.isArray(j)) ledger = j; } catch (_) { /* first run */ }
    ledger.push(Object.assign({ id, taken_at: takenAt.toISOString(), title, path: `${id}/snapshot.html` }, summarizeSnapshot(data)));
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
    fs.writeFileSync(path.join(reportRoot, 'snapshots', 'index.html'), buildHistoryHtml(ledger, { title }));
  } catch (e) { appendLog('[Snapshot] card/ledger skipped: ' + e.message); }

  const failed = results.filter(r => !r.ok);
  const rel = path.relative(root, snapDir) || snapDir;
  if (quiet) {
    appendLog(`[Snapshot] ${id}: wrote ${results.length - failed.length}/${results.length} reports to ${snapDir}`);
    if (cardHtml) showSnapshotCard(cardHtml);
    return;
  }
  if (failed.length) {
    vscode.window.showWarningMessage(`PlaneKey snapshot ${id}: ${failed.length} of ${results.length} reports had issues (${failed.map(f => f.label).join(', ')}). See the PlaneKey output.`);
    return;
  }
  const actions = cardHtml ? ['Open Snapshot', 'History', 'Open Folder'] : ['Open Folder'];
  const pick = await vscode.window.showInformationMessage(
    `PlaneKey snapshot ${id} saved — ${results.length} reports under ${rel}. Past snapshots kept.`, ...actions
  );
  if (pick === 'Open Snapshot') showSnapshotCard(cardHtml);
  else if (pick === 'History') openSnapshotHistory(reportRoot);
  else if (pick === 'Open Folder') openReports();
}

function openSnapshotHistory(reportRoot) {
  try {
    const html = fs.readFileSync(path.join(reportRoot, 'snapshots', 'index.html'), 'utf8');
    showSnapshotCard(html);
  } catch (_) {
    vscode.window.showInformationMessage('PlaneKey: no snapshot history yet — run PlaneKey: Snapshot Workspace.');
  }
}

let snapshotCardPanel;
function showSnapshotCard(html) {
  if (snapshotCardPanel) {
    snapshotCardPanel.webview.html = html;
    snapshotCardPanel.reveal(vscode.ViewColumn.Active, false);
    return;
  }
  snapshotCardPanel = vscode.window.createWebviewPanel(
    'planekeySnapshot', 'PlaneKey Snapshot', vscode.ViewColumn.Active,
    { enableScripts: false, retainContextWhenHidden: true }
  );
  snapshotCardPanel.webview.html = html;
  snapshotCardPanel.onDidDispose(() => { snapshotCardPanel = null; });
}

async function showMemoryStats() {
  const result = await runPk(['memory', 'stats', '--json'], { cwd: getProjectRoot() });
  const text = (result.stdout || result.stderr || 'No stats available.').trim();
  const doc = await vscode.workspace.openTextDocument({ content: text, language: 'json' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function togglePredictive() {
  const cfg = getConfig();
  const current = cfg.get('predictive.enabled', true);
  await cfg.update('predictive.enabled', !current, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(
    `PlaneKey predictive typing ${!current ? 'enabled' : 'disabled'}.`
  );
  if (predictiveProvider) predictiveProvider.invalidateCache();
}

async function setMcpServerPath() {
  const current = getConfig().get('mcpServerPath') || '';
  const value = await vscode.window.showInputBox({
    prompt: 'Path to planekey_env_observer_server.py',
    value: current,
    ignoreFocusOut: true
  });
  if (value === undefined) return;
  await getConfig().update('mcpServerPath', value.trim(), vscode.ConfigurationTarget.Workspace);
  mcpDidChange.fire();
  vscode.window.showInformationMessage('PlaneKey MCP server path updated and re-registered.');
}

function getConfig() {
  return vscode.workspace.getConfiguration('planekey');
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.length ? folders[0].uri.fsPath : process.cwd();
}

function getProjectRoot() {
  const configured = getConfig().get('projectRoot');
  return configured && configured.trim() ? configured.trim() : getWorkspaceRoot();
}

function getReportRoot() {
  const configured = getConfig().get('reportRoot');
  return configured && configured.trim() ? configured.trim() : path.join(getProjectRoot(), 'reports');
}

function getNode() {
  const configured = (getConfig().get('nodePath') || '').trim();
  return configured || 'node';
}

function bundledTool(rel) {
  if (!extensionRoot) return '';
  const p = path.join(extensionRoot, 'toolchain', rel);
  try { return fs.existsSync(p) ? p : ''; } catch (_) { return ''; }
}

function getPkClient() {
  const configured = getConfig().get('pkClientPath');
  if (configured && configured.trim()) return configured.trim();
  const bundled = bundledTool('pk-client/bin/pk-client.js');
  if (bundled) return bundled;
  return process.platform === 'win32' ? 'pk-client.cmd' : 'pk-client';
}

function getPkMemory() {
  const configured = getConfig().get('pkMemoryPath');
  if (configured && configured.trim()) return configured.trim();
  const bundled = bundledTool('pk-memory/pk-memory.js');
  if (bundled) return bundled;
  return process.platform === 'win32' ? 'pk-memory.cmd' : 'pk-memory';
}

function toInvocation(tool, args) {
  if (typeof tool === 'string' && tool.toLowerCase().endsWith('.js')) {
    return { command: getNode(), args: [tool, ...args] };
  }
  return { command: tool, args };
}

function getPkOperator() {
  const configured = getConfig().get('pkOperatorPath');
  if (configured) return configured;
  return process.platform === 'win32' ? 'pk-operator.cmd' : 'pk-operator';
}

async function runExternalBinary(label, bin, args, options = {}) {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `PlaneKey ${label}`, cancellable: false }, async () => {
    appendLog(`\n$ ${bin} ${args.map(a => JSON.stringify(String(a))).join(' ')}\n`);
    const result = await runBinary(bin, args, { cwd: getProjectRoot() });
    lastState.lastRuns[label] = { time: new Date().toISOString(), code: result.code, ok: !result.error, summary: summarizeOutput(result.stdout + '\n' + result.stderr) };
    if (result.error) {
      lastState.status = 'warn';
      vscode.window.showWarningMessage(`PlaneKey ${label} finished with warnings/errors. Open the PlaneKey output for details.`);
    } else {
      vscode.window.showInformationMessage(`PlaneKey ${label} completed.`);
    }
    refreshViews();
  });
}

function runBinary(bin, args, options = {}) {
  const inv = toInvocation(bin, args);
  return new Promise((resolve) => {
    const child = cp.execFile(inv.command, inv.args, { cwd: options.cwd || getProjectRoot(), maxBuffer: 1024 * 1024 * 32, windowsHide: true }, (error, stdout, stderr) => {
      if (stdout) output.append(stdout.endsWith('\n') ? stdout : stdout + '\n');
      if (stderr) output.append(stderr.endsWith('\n') ? stderr : stderr + '\n');
      resolve({ error, stdout: stdout || '', stderr: stderr || '', code: error && typeof error.code === 'number' ? error.code : 0 });
    });
    child.on('error', (err) => {
      appendLog(`Failed to start ${inv.command}: ${err.message}`);
      resolve({ error: err, stdout: '', stderr: err.message, code: -1 });
    });
  });
}

function scanName(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}`;
}

function appendLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  output.appendLine(line);
}

function runPk(args, options = {}) {
  const cwd = options.cwd || getProjectRoot();
  const inv = toInvocation(getPkClient(), args);
  appendLog(`$ ${inv.command} ${inv.args.join(' ')}`);
  return new Promise((resolve) => {
    const child = cp.execFile(inv.command, inv.args, {
      cwd,
      windowsHide: true,
      maxBuffer: 12 * 1024 * 1024,
      env: process.env
    }, (error, stdout, stderr) => {
      if (stdout) output.append(stdout.endsWith('\n') ? stdout : stdout + '\n');
      if (stderr) output.append(stderr.endsWith('\n') ? stderr : stderr + '\n');
      resolve({ error, stdout: stdout || '', stderr: stderr || '', code: error && typeof error.code === 'number' ? error.code : 0 });
    });
    child.on('error', (err) => {
      appendLog(`Failed to start pk-client: ${err.message}`);
      resolve({ error: err, stdout: '', stderr: err.message, code: -1 });
    });
  });
}

async function refreshStatus(options = {}) {
  lastState.projectRoot = getProjectRoot();
  lastState.pkClient = getPkClient();
  updateCurrentFileRisk();
  // Keep predictive provider project root in sync
  if (predictiveProvider) predictiveProvider.projectRoot = getProjectRoot();

  const result = await runPk(['status'], { cwd: getProjectRoot() });
  const combined = `${result.stdout}\n${result.stderr}`;

  if (result.error) {
    lastState.status = 'warn';
    lastState.label = 'PlaneKey: pk-client issue';
    lastState.findings = [
      'Could not run pk-client status.',
      'Check PlaneKey path or install pk-client with npm link.',
      String(result.stderr || result.error.message || '').trim()
    ].filter(Boolean);
    if (!options.quiet) vscode.window.showWarningMessage('PlaneKey could not run pk-client. Use PlaneKey: Set pk-client Path or test pk-client.cmd --help.');
  } else {
    lastState.status = 'ok';
    lastState.label = 'PlaneKey: ready';
    lastState.findings = parseStatusFindings(combined);
  }

  updateStatusBar();
  refreshViews();
}

function parseStatusFindings(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return ['pk-client status completed.'];
  return lines.slice(0, 12);
}

function updateStatusBar() {
  const risk = lastState.currentFileRisk;
  if (lastState.status === 'ok' && risk === 'red') {
    statusBar.text = '$(shield) PlaneKey: file risk';
    statusBar.tooltip = 'PlaneKey detected current-file risk markers.';
  } else if (lastState.status === 'ok' && risk === 'yellow') {
    statusBar.text = '$(shield) PlaneKey: review';
    statusBar.tooltip = 'PlaneKey current file should be reviewed.';
  } else if (lastState.status === 'ok') {
    statusBar.text = '$(shield) PlaneKey: ready';
    statusBar.tooltip = 'PlaneKey is ready.';
  } else {
    statusBar.text = '$(warning) PlaneKey';
    statusBar.tooltip = lastState.label;
  }
  statusBar.show();
}

function refreshViews() {
  if (trustProvider) trustProvider.refresh();
  if (actionProvider) actionProvider.refresh();
  updateStatusBar();
}

function updateCurrentFileRisk() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document || editor.document.uri.scheme !== 'file') {
    lastState.currentFileRisk = 'unknown';
    return;
  }
  const file = editor.document.uri.fsPath;
  const rel = path.relative(getProjectRoot(), file).replace(/\\/g, '/');
  lastState.currentFile = rel;
  const lower = rel.toLowerCase();
  if (
    lower.includes('.env') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower.includes('/debug/') ||
    lower.includes('/shell-snapshots/') ||
    lower.includes('.claude') ||
    lower.includes('.openai') ||
    lower.includes('/agent-state/') ||
    lower.includes('/mcp/')
  ) {
    lastState.currentFileRisk = 'red';
  } else if (
    lower.endsWith('server.js') ||
    lower.includes('/routes/') ||
    lower.includes('/admin/') ||
    lower.includes('/public/') ||
    lower.endsWith('package.json') ||
    lower.includes('planekey') ||
    lower.includes('root-rabbit') ||
    lower.includes('pk-memory') ||
    lower.includes('pk-operator') ||
    lower.includes('planekey-operator') ||
    lower.includes('tmrfs') ||
    lower.includes('rgano')
  ) {
    lastState.currentFileRisk = 'yellow';
  } else {
    lastState.currentFileRisk = 'green';
  }
}

async function runScan(label, args, options = {}) {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `PlaneKey ${label}`,
    cancellable: false
  }, async () => {
    const result = await runPk(args, { cwd: getProjectRoot() });
    lastState.lastRuns[label] = {
      time: new Date().toISOString(),
      code: result.code,
      ok: !result.error,
      summary: summarizeOutput(result.stdout + '\n' + result.stderr)
    };
    if (result.error) {
      lastState.status = 'warn';
      vscode.window.showWarningMessage(`PlaneKey ${label} finished with warnings/errors. Open the PlaneKey output for details.`);
    } else {
      vscode.window.showInformationMessage(`PlaneKey ${label} completed.`);
    }
    refreshViews();
  });
}

function summarizeOutput(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const interesting = lines.filter(line => /pass|fail|warn|red|yellow|green|risk|safe|error|critical|secret|pixel|residue|route/i.test(line));
  return (interesting.length ? interesting : lines).slice(0, 8);
}

async function runMemoryBuild() {
  const cfg = getConfig();
  const name = await vscode.window.showInputBox({ prompt: 'TMrFS memory report name', value: cfg.get('defaultMemoryName') || scanName('ide-memory') });
  if (!name) return;
  await runExternalBinary('TMrFS Memory Build', getPkMemory(), ['memory', 'build', getProjectRoot(), '--name', name]);
}

async function runRganoScan() {
  const name = await vscode.window.showInputBox({ prompt: 'Rgano structure scan name', value: scanName('ide-rgano') });
  if (!name) return;
  await runExternalBinary('Rgano Structure Scan', getPkMemory(), ['rgano', 'scan', getProjectRoot(), '--name', name]);
}

async function runCanonRank() {
  const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select TMrFS memory report folder' });
  if (!picked || !picked[0]) return;
  await runExternalBinary('Canon Rank', getPkMemory(), ['memory', 'canon-rank', picked[0].fsPath]);
}

async function runGraftPlan() {
  const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select TMrFS memory report folder' });
  if (!picked || !picked[0]) return;
  await runExternalBinary('Graft Plan', getPkMemory(), ['memory', 'graft-plan', picked[0].fsPath]);
}

async function runOperatorDoctor() {
  await runExternalBinary('Operator Doctor', getPkOperator(), ['doctor', getProjectRoot()]);
}

async function pickSubmitMode(label) {
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Local only (write envelope, don\'t POST)', value: 'local', description: 'Default. Saves the envelope under reports/bridge-envelopes/.' },
      { label: 'Submit to bridge.planekey.dev', value: 'submit', description: 'Sign and POST. Requires PLANEKEY_HMAC_SECRET for HMAC-gated routes.' },
    ],
    { placeHolder: `${label}: local-only or submit?`, ignoreFocusOut: true }
  );
  return choice ? choice.value : null;
}

async function pickJsonFile(label) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: label,
    filters: { JSON: ['json'] },
  });
  return picked && picked[0] ? picked[0].fsPath : null;
}

async function runFlightReport() {
  const base = await vscode.window.showInputBox({ prompt: 'Flight report: base version (e.g. v0.2.20)', ignoreFocusOut: true });
  if (!base) return;
  const proposed = await vscode.window.showInputBox({ prompt: 'Flight report: proposed version (e.g. v0.2.21)', ignoreFocusOut: true });
  if (!proposed) return;
  const mode = await pickSubmitMode('Flight report');
  if (!mode) return;
  const args = ['flight', 'report', '--base', base, '--proposed', proposed, '--dir', getProjectRoot()];
  if (mode === 'submit') args.push('--submit');
  appendLog(`Flight report → ${mode}`);
  await runScan('Flight Report', args, { parse: false });
}

async function runCanonAnalyze() {
  const inputPath = await pickJsonFile('Select canon-analyzer JSON');
  if (!inputPath) return;
  const mode = await pickSubmitMode('Canon analyze');
  if (!mode) return;
  const args = ['canon', 'analyze', inputPath];
  if (mode === 'submit') args.push('--submit');
  await runScan('Canon Analyze', args, { parse: false });
}

async function runForensicsAttribution() {
  const inputPath = await pickJsonFile('Select forensics report JSON');
  if (!inputPath) return;
  const mode = await pickSubmitMode('Forensics attribution');
  if (!mode) return;
  const args = ['forensics', 'attribution', inputPath];
  if (mode === 'submit') args.push('--submit');
  await runScan('Forensics Attribution', args, { parse: false });
}

const RGANO_EXTRACTORS = [
  'rgano_scene.py', 'rgano_image.py', 'rgano_taxonomy.py', 'rgano_coastline.py',
  'rgano_phase.py', 'rgano_aerial.py', 'rgano_geo_recon.py',
  'rgano_label_transfer.py', 'container_annotation_and_proposal_tool.py'
];

async function runRganoPacket() {
  const extractor = await vscode.window.showQuickPick(RGANO_EXTRACTORS, { placeHolder: 'Select the Rgano extractor that produced the raw JSON', ignoreFocusOut: true });
  if (!extractor) return;
  const inputPath = await pickJsonFile('Select raw extractor output JSON');
  if (!inputPath) return;
  const mode = await pickSubmitMode('Rgano packet');
  if (!mode) return;
  const args = ['rgano', 'packet', extractor, inputPath];
  if (mode === 'submit') args.push('--submit');
  await runScan('Rgano Packet', args, { parse: false });
}

async function runRootRabbitHealth() {
  const inputPath = await pickJsonFile('Select RootRabbit observation JSON');
  if (!inputPath) return;
  const mode = await pickSubmitMode('RootRabbit health');
  if (!mode) return;
  const args = ['rootrabbit', 'health', inputPath];
  if (mode === 'submit') args.push('--submit');
  await runScan('RootRabbit Health', args, { parse: false });
}

async function runCoherencePack() {
  await runScan('Coherence Pack', ['coherence', '--dbs', '/tmp/dbs-rpg'], { parse: false });
}

async function runTrustState() {
  await runScan('Trust State', ['trust', 'state', '--table'], { parse: false });
}

async function runRpgReachable() {
  const symbol = await vscode.window.showInputBox({ prompt: 'Target symbol name (e.g. bridge_attest, verify_hmac)', ignoreFocusOut: true });
  if (!symbol) return;
  await runScan('RPG Reachable', ['rpg', 'reachable', symbol, '--table'], { parse: false });
}

async function runMatrixCarryForward() {
  const left = await vscode.window.showInputBox({ prompt: 'Left version (e.g. 0.2.17)', ignoreFocusOut: true });
  if (!left) return;
  const right = await vscode.window.showInputBox({ prompt: 'Right version (e.g. 0.2.18)', ignoreFocusOut: true });
  if (!right) return;
  await runScan('Matrix Carry-Forward', ['matrix', 'carry-forward', left, right, '--table'], { parse: false });
}

async function runDecisionsDistribution() {
  const service = await vscode.window.showInputBox({ prompt: 'Service ID filter (blank = all services)', ignoreFocusOut: true });
  const sinceDays = await vscode.window.showInputBox({ prompt: 'Since how many days back?', value: '30', ignoreFocusOut: true });
  const submit = await vscode.window.showQuickPick(['local-only (just show target URL)', 'submit (fetch from bridge.planekey.dev)'], { placeHolder: 'Local-only or fetch from bridge?' });
  if (!submit) return;
  const args = ['decisions', 'distribution'];
  if (service) args.push('--service', service);
  if (sinceDays) args.push('--since-days', sinceDays);
  if (submit.startsWith('submit')) args.push('--submit');
  await runScan('Decisions Distribution', args, { parse: false });
}

async function runOperatorReplay() {
  const service = await vscode.window.showInputBox({ prompt: 'Service ID filter (blank = all services)', ignoreFocusOut: true });
  const kind = await vscode.window.showQuickPick(
    ['(any)', 'patch_apply', 'patch_probe', 'soft_delete', 'hard_delete', 'restore', 'wipe_plan', 'wipe_apply', 'trash_list', 'doctor'],
    { placeHolder: 'Filter by action_kind' }
  );
  if (!kind) return;
  const sinceDays = await vscode.window.showInputBox({ prompt: 'Since how many days back?', value: '30', ignoreFocusOut: true });
  const submit = await vscode.window.showQuickPick(['local-only (just show target URL)', 'submit (fetch from bridge.planekey.dev)'], { placeHolder: 'Local-only or fetch from bridge?' });
  if (!submit) return;
  const args = ['operator', 'replay'];
  if (service) args.push('--service', service);
  if (kind !== '(any)') args.push('--kind', kind);
  if (sinceDays) args.push('--since-days', sinceDays);
  if (submit.startsWith('submit')) args.push('--submit');
  await runScan('Operator Replay', args, { parse: false });
}

async function openOperatorIncident() {
  const title = await vscode.window.showInputBox({ prompt: 'Operator incident title', value: 'IDE review incident' });
  if (!title) return;
  await runExternalBinary('Open Operator Incident', getPkOperator(), ['incident', 'open', '--title', title, '--target', getProjectRoot()]);
}

async function attestDev() {
  const name = await vscode.window.showInputBox({ prompt: 'PlaneKey dev attestation name', value: scanName('ide-dev') });
  if (!name) return;
  await runScan('Dev Attestation', ['layer', 'attest', 'dev', getProjectRoot(), '--name', name], { parse: true });
}

async function createSafeBundle() {
  const cfg = getConfig();
  const name = await vscode.window.showInputBox({ prompt: 'PlaneKey bundle name', value: cfg.get('defaultBundleName') || 'ide-safe-bundle' });
  if (!name) return;
  await runScan('Safe Bundle', ['bundle', 'create', name, '--intent', 'Created from PlaneKey IDE add-on'], { parse: true });
}

async function openReports() {
  const reportRoot = getReportRoot();
  if (!fs.existsSync(reportRoot)) {
    const choice = await vscode.window.showWarningMessage(`Reports folder not found: ${reportRoot}`, 'Create Folder');
    if (choice === 'Create Folder') fs.mkdirSync(reportRoot, { recursive: true });
    else return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(reportRoot), { forceNewWindow: true });
}

async function setPkClientPath() {
  const current = getPkClient();
  const value = await vscode.window.showInputBox({
    prompt: 'Path to pk-client executable. Example: C:\\dev\\cc-master\\pkclient\\planekey-client-v1.5.7\\bin\\pk-client.js or pk-client.cmd',
    value: current
  });
  if (!value) return;
  await getConfig().update('pkClientPath', value, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage('PlaneKey pk-client path saved.');
  refreshStatus({ quiet: true });
}

async function setPkMemoryPath() {
  const current = getPkMemory();
  const value = await vscode.window.showInputBox({ prompt: 'Path to pk-memory executable. Example: pk-memory.cmd or C:\path\to\pk-memory.js', value: current });
  if (!value) return;
  await getConfig().update('pkMemoryPath', value, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage('PlaneKey pk-memory path saved.');
}

async function setPkOperatorPath() {
  const current = getPkOperator();
  const value = await vscode.window.showInputBox({ prompt: 'Path to pk-operator executable. Example: pk-operator.cmd or C:\path\to\pk-operator.js', value: current });
  if (!value) return;
  await getConfig().update('pkOperatorPath', value, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage('PlaneKey pk-operator path saved.');
}

async function setProjectRoot() {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use as PlaneKey Project Root'
  });
  if (!picked || !picked[0]) return;
  await getConfig().update('projectRoot', picked[0].fsPath, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage('PlaneKey project root saved.');
  refreshStatus({ quiet: true });
}

class TrustProvider {
  constructor() { this._onDidChangeTreeData = new vscode.EventEmitter(); this.onDidChangeTreeData = this._onDidChangeTreeData.event; }
  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(element) { return element; }
  getChildren(element) {
    if (element) return [];
    const items = [];
    items.push(treeItem('Project', lastState.projectRoot || 'No workspace', 'folder'));
    items.push(treeItem('pk-client', lastState.pkClient || 'auto', 'terminal'));
    items.push(treeItem('Current file', `${lastState.currentFile || 'none'} — ${lastState.currentFileRisk}`, riskIcon(lastState.currentFileRisk)));
    const runs = Object.entries(lastState.lastRuns).sort((a, b) => String(b[1].time).localeCompare(String(a[1].time)));
    if (!runs.length) {
      items.push(treeItem('Scans', 'No scans run yet', 'circle-outline'));
    } else {
      for (const [name, run] of runs.slice(0, 8)) {
        const tooltip = [`${name}`, `Time: ${run.time}`, ...(run.summary || [])].join('\n');
        items.push(treeItem(name, run.ok ? 'completed' : 'warning/error', run.ok ? 'check' : 'warning', tooltip));
      }
    }
    for (const finding of (lastState.findings || []).slice(0, 8)) {
      items.push(treeItem('Status', finding, 'info'));
    }
    return items;
  }
}

class ActionProvider {
  constructor() { this._onDidChangeTreeData = new vscode.EventEmitter(); this.onDidChangeTreeData = this._onDidChangeTreeData.event; }
  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(element) { return element; }
  getChildren(element) {
    if (element) return [];
    return [
      commandItem('Open Chat', 'planekey.openChat', 'comment-discussion'),
      commandItem('Open Inbox', 'planekey.openInbox', 'inbox'),
      commandItem('Snapshot Workspace (all reports)', 'planekey.snapshotWorkspace', 'device-camera'),
      commandItem('Refresh Trust Status', 'planekey.refreshStatus', 'refresh'),
      commandItem('Open pk-client Terminal', 'planekey.openPkClientTerminal', 'terminal'),
      commandItem('── Predictive Typing ──', '', 'symbol-keyword'),
      commandItem('Index Codebase (Memory)', 'planekey.indexCodebase', 'symbol-class'),
      commandItem('Build Repo DB', 'planekey.buildDB', 'database'),
      commandItem('Refresh Predictive Cache', 'planekey.refreshCache', 'refresh'),
      commandItem('Show Memory Stats', 'planekey.showMemoryStats', 'graph'),
      commandItem('Toggle Predictive Typing', 'planekey.togglePredictive', 'eye'),
      commandItem('── Scans ──', '', 'shield'),
      commandItem('Run RepoGuard', 'planekey.runRepoGuard', 'shield'),
      commandItem('Run PixelGuard', 'planekey.runPixelGuard', 'eye'),
      commandItem('Run ResidueGuard Map', 'planekey.runResidueMap', 'search'),
      commandItem('Run RootRabbit Scan', 'planekey.runRootRabbit', 'beaker'),
      commandItem('Run SafetyNet', 'planekey.runSafetyNet', 'checklist'),
      commandItem('Attest Dev Layer', 'planekey.attestDev', 'verified'),
      commandItem('Create Safe Bundle', 'planekey.createSafeBundle', 'package'),
      commandItem('Build TMrFS Memory', 'planekey.runMemoryBuild', 'database'),
      commandItem('Run Rgano Structure Scan', 'planekey.runRganoScan', 'graph'),
      commandItem('Rank Canon Candidates', 'planekey.runCanonRank', 'symbol-class'),
      commandItem('Build Graft Plan', 'planekey.runGraftPlan', 'git-merge'),
      commandItem('Operator Doctor', 'planekey.runOperatorDoctor', 'wrench'),
      commandItem('Open Operator Incident', 'planekey.openIncident', 'issues'),
      commandItem('Open Reports Folder', 'planekey.openReports', 'folder-opened'),
      commandItem('Set pk-client Path', 'planekey.setPkClientPath', 'tools'),
      commandItem('Set pk-memory Path', 'planekey.setPkMemoryPath', 'database'),
      commandItem('Set pk-operator Path', 'planekey.setPkOperatorPath', 'wrench'),
      commandItem('Set Project Root', 'planekey.setProjectRoot', 'root-folder')
    ];
  }
}

function riskIcon(risk) {
  if (risk === 'red') return 'error';
  if (risk === 'yellow') return 'warning';
  if (risk === 'green') return 'pass';
  return 'question';
}

function treeItem(label, description, icon, tooltip) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = description;
  item.tooltip = tooltip || description;
  item.iconPath = new vscode.ThemeIcon(icon || 'circle-outline');
  return item;
}

function commandItem(label, command, icon) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon || 'play');
  if (command) item.command = { command, title: label };
  return item;
}

module.exports = { activate, deactivate };
