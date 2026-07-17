// Unified loader + query engine for pk-memory, pk-repo-db, pk-operator
// Wires canonical predictions (db) + trust scores (memory) + incident learning (operator)
// =============================================================================

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

// ============================================================================
// TYPES
// ============================================================================

interface MemoryNode {
  node_id: string;
  path: string;
  role: string;
  layer: string;
  status: 'candidate' | 'review' | 'quarantine' | 'block' | 'forensic_only';
  canon_score: number;
  residue_score: number;
  risk_score: number;
  residue_signals: string[];
  structure: {
    imports: string[];
    routes: string[];
    functions: string[];
    html_ids: string[];
    forms: any[];
    scripts: string[];
    package_scripts: { [key: string]: string };
    config_keys: string[];
  };
}

interface DBComponent {
  name: string;
  component_kind: 'function' | 'module' | 'schema' | string;
  source_path: string;
  source_path_hash: string;
  source_content_hash: string;
  canonical_hash: string;
  risk_score_basis_points: number;
}

interface DBFile {
  path: string;
  path_hash: string;
  file_kind: string;
  content_hash: string;
  size_bytes: number;
  extracted: boolean;
}

interface DBImportEdge {
  from: string;
  to: string;
  from_path_hash: string;
}

interface OperatorIncident {
  id: string;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at?: string;
  title: string;
  source_path?: string;
  resolution?: string;
  code_snippet?: string;
  corrected_code?: string;
  timeline: Array<{ ts: string; event: string; note: string }>;
}

interface LoadedIndexes {
  memory: {
    nodes: MemoryNode[];
    pathIndex: { [path: string]: MemoryNode[] };
    contentIndex: { [hash: string]: MemoryNode[] };
    trustIndex: { [nodeId: string]: any };
    structureIndex: { [nodeId: string]: any };
  };
  db: {
    files: DBFile[];
    components: DBComponent[];
    importEdges: DBImportEdge[];
    fileIndex: { [path: string]: DBFile };
    componentIndex: { [name: string]: DBComponent[] };
    treeHash: string;
    canonicalRecipeHash: string;
  };
  incidents: OperatorIncident[];
}

// ============================================================================
// LOADING: Memory Index
// ============================================================================

async function loadMemoryIndex(projectRoot: string): Promise<any> {
  const memoryDir = path.join(projectRoot, '.planekey', 'memory');
  if (!fs.existsSync(memoryDir)) return null;

  // Find latest memory report
  const dirs = fs.readdirSync(memoryDir);
  if (dirs.length === 0) return null;

  const latest = dirs.sort().reverse()[0];
  const indexPath = path.join(memoryDir, latest, 'TMRFS_MEMORY_INDEX.json');

  if (!fs.existsSync(indexPath)) return null;

  const memory = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const pathIndex: { [path: string]: MemoryNode[] } = {};
  const contentIndex: { [hash: string]: MemoryNode[] } = {};
  const trustIndex: { [nodeId: string]: any } = {};
  const structureIndex: { [nodeId: string]: any } = {};

  for (const node of memory.nodes) {
    (pathIndex[node.path] ||= []).push(node);
    (contentIndex[node.hash_short] ||= []).push(node);
    trustIndex[node.node_id] = {
      path: node.path,
      role: node.role,
      status: node.status,
      canon_score: node.canon_score,
      residue_score: node.residue_score,
      risk_score: node.risk_score,
      residue_signals: node.residue_signals || [],
    };
    structureIndex[node.node_id] = {
      path: node.path,
      role: node.role,
      structure: node.structure,
    };
  }

  return { nodes: memory.nodes, pathIndex, contentIndex, trustIndex, structureIndex };
}

// ============================================================================
// LOADING: DB Index
// ============================================================================

async function loadDBIndex(projectRoot: string): Promise<any> {
  const dbPath = path.join(projectRoot, 'repo-db', 'repo-ingest-packet.json');

  if (!fs.existsSync(dbPath)) return null;

  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

  const fileIndex: { [path: string]: DBFile } = {};
  const componentIndex: { [name: string]: DBComponent[] } = {};

  for (const file of db.files) {
    fileIndex[file.path] = file;
  }

  for (const comp of db.components) {
    (componentIndex[comp.name] ||= []).push(comp);
  }

  return {
    files: db.files,
    components: db.components,
    importEdges: db.import_edges_raw,
    fileIndex,
    componentIndex,
    treeHash: db.commit.tree_hash,
    canonicalRecipeHash: db.recipe.canonical_recipe_hash,
  };
}

// ============================================================================
// LOADING: Operator Incidents
// ============================================================================

async function loadIncidents(projectRoot: string): Promise<OperatorIncident[]> {
  const incidentDir = path.join(projectRoot, '.planekey', 'operator', 'incidents');

  if (!fs.existsSync(incidentDir)) return [];

  const incidents: OperatorIncident[] = [];
  for (const file of fs.readdirSync(incidentDir)) {
    if (file.endsWith('.json')) {
      const inc = JSON.parse(fs.readFileSync(path.join(incidentDir, file), 'utf8'));
      incidents.push(inc);
    }
  }

  return incidents;
}

// ============================================================================
// UNIFIED LOADER
// ============================================================================

let cachedIndexes: LoadedIndexes | null = null;
let lastLoadTime = 0;

async function loadAllIndexes(projectRoot: string, force = false): Promise<LoadedIndexes | null> {
  const now = Date.now();

  // Cache for 30 seconds
  if (cachedIndexes && !force && now - lastLoadTime < 30000) {
    return cachedIndexes;
  }

  const memory = await loadMemoryIndex(projectRoot);
  const db = await loadDBIndex(projectRoot);
  const incidents = await loadIncidents(projectRoot);

  if (!memory || !db) return null;

  cachedIndexes = {
    memory,
    db,
    incidents,
  };

  lastLoadTime = now;
  return cachedIndexes;
}

// ============================================================================
// QUERY ENGINE: Intent Parser
// ============================================================================

interface QueryIntent {
  type: 'route' | 'import' | 'function' | 'html_id' | 'component';
  prefix: string;
  context?: string;
}

function parseIntent(linePrefix: string, fileName: string): QueryIntent | null {
  // Route: app.get('/api/
  if (/app\.(get|post|put|patch|delete|use)\s*\(\s*['"`]/.test(linePrefix)) {
    const match = linePrefix.match(/['"`]([^'"`]*)$/);
    return {
      type: 'route',
      prefix: match ? match[1] : '',
      context: 'route',
    };
  }

  // Import: require('./  or  import './
  if (/(?:require|import)\s*\(\s*['"`]\.\/.test(linePrefix)) {
    const match = linePrefix.match(/['"`](\.\/.*)$/);
    return {
      type: 'import',
      prefix: match ? match[1] : './',
      context: 'import',
    };
  }

  // Function: function foo  or  const foo =
  if (/function\s+\w*$/.test(linePrefix) || /const\s+\w*\s*=\s*(?:async\s*)?\(/.test(linePrefix)) {
    const match = linePrefix.match(/(function|const)\s+(\w*)$/);
    return {
      type: 'function',
      prefix: match ? match[2] : '',
      context: 'function',
    };
  }

  // HTML ID: id="user-
  if (/id\s*=\s*['"`]/.test(linePrefix)) {
    const match = linePrefix.match(/['"`]([^'"`]*)$/);
    return {
      type: 'html_id',
      prefix: match ? match[1] : '',
      context: 'html_id',
    };
  }

  // Component reference: SomeComponent or fetchUser
  if (/[A-Z][a-zA-Z]*$/.test(linePrefix) || /fetch[A-Z]\w*$/.test(linePrefix)) {
    const match = linePrefix.match(/(\w+)$/);
    return {
      type: 'component',
      prefix: match ? match[1] : '',
      context: fileName.endsWith('.tsx') || fileName.endsWith('.jsx') ? 'react' : 'function',
    };
  }

  return null;
}

// ============================================================================
// QUERY ENGINE: Memory Query
// ============================================================================

interface QueryResult {
  completion: string;
  label: string;
  detail: string;
  source: 'memory' | 'db' | 'operator-rewrite';
  canonScore: number;
  riskScore: number;
  frequency?: number;
  sortKey: string;
}

function queryMemoryByIntent(
  indexes: LoadedIndexes,
  intent: QueryIntent
): QueryResult[] {
  const results: QueryResult[] = [];
  const seen = new Set<string>();

  if (intent.type === 'route') {
    // Search memory for routes
    for (const node of indexes.memory.nodes) {
      if (!node.structure.routes) continue;

      for (const route of node.structure.routes) {
        if (route.toLowerCase().startsWith(intent.prefix.toLowerCase())) {
          const trust = indexes.memory.trustIndex[node.node_id];

          // Apply trust filters
          if (trust.status === 'quarantine' || trust.status === 'block') continue;
          if (trust.risk_score >= 80) continue;
          if (
            trust.residue_signals.includes('agent_runtime_residue') &&
            trust.canon_score < 0.8
          )
            continue;

          const key = route;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
            completion: route,
            label: \`\${route} — \${node.source_archive}\`,
            detail: \`Risk: \${trust.risk_score} | Canon: \${trust.canon_score.toFixed(2)}\`,
            source: 'memory',
            canonScore: trust.canon_score,
            riskScore: trust.risk_score,
            sortKey: \`\${trust.canon_score.toFixed(2)}_\${route}\`,
          });
        }
      }
    }
  }

  if (intent.type === 'import') {
    // Search DB for import edges + memory for canonical imports
    const importSet = new Set<string>();

    for (const edge of indexes.db.importEdges) {
      if (edge.from.toLowerCase().includes(intent.prefix.toLowerCase())) {
        importSet.add(edge.to);
      }
    }

    for (const imp of Array.from(importSet)) {
      if (seen.has(imp)) continue;
      seen.add(imp);

      results.push({
        completion: imp,
        label: \`\${imp}\`,
        detail: 'From repo-db',
        source: 'db',
        canonScore: 0.8,
        riskScore: 0,
        sortKey: \`0.8_\${imp}\`,
      });
    }
  }

  if (intent.type === 'function') {
    // Search memory for function definitions
    for (const node of indexes.memory.nodes) {
      if (!node.structure.functions) continue;

      for (const fn of node.structure.functions) {
        if (fn.toLowerCase().startsWith(intent.prefix.toLowerCase())) {
          const trust = indexes.memory.trustIndex[node.node_id];

          if (trust.status === 'quarantine' || trust.risk_score >= 80) continue;

          const key = fn;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
            completion: fn,
            label: \`\${fn} — \${node.source_archive}\`,
            detail: \`Risk: \${trust.risk_score} | Canon: \${trust.canon_score.toFixed(2)}\`,
            source: 'memory',
            canonScore: trust.canon_score,
            riskScore: trust.risk_score,
            sortKey: \`\${trust.canon_score.toFixed(2)}_\${fn}\`,
          });
        }
      }
    }

    // Also search DB components
    for (const comp of indexes.db.components) {
      if (comp.component_kind !== 'function') continue;
      if (!comp.name.toLowerCase().includes(intent.prefix.toLowerCase())) continue;

      const key = comp.name;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        completion: comp.name.split('::')[1] || comp.name,
        label: \`\${comp.name} — repo-db\`,
        detail: 'From component index',
        source: 'db',
        canonScore: 1 - comp.risk_score_basis_points / 10000,
        riskScore: comp.risk_score_basis_points / 100,
        sortKey: \`\${(1 - comp.risk_score_basis_points / 10000).toFixed(2)}_\${comp.name}\`,
      });
    }
  }

  if (intent.type === 'html_id') {
    // Search memory for HTML IDs
    for (const node of indexes.memory.nodes) {
      if (!node.structure.html_ids) continue;

      for (const id of node.structure.html_ids) {
        if (id.toLowerCase().startsWith(intent.prefix.toLowerCase())) {
          const trust = indexes.memory.trustIndex[node.node_id];

          if (trust.status === 'quarantine' || trust.risk_score >= 80) continue;

          const key = id;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
            completion: id,
            label: \`\${id} — \${node.source_archive}\`,
            detail: \`Risk: \${trust.risk_score}\`,
            source: 'memory',
            canonScore: trust.canon_score,
            riskScore: trust.risk_score,
            sortKey: \`\${trust.canon_score.toFixed(2)}_\${id}\`,
          });
        }
      }
    }
  }

  if (intent.type === 'component') {
    // Unified component search across DB + memory
    for (const comp of indexes.db.components) {
      const name = comp.name.split('::')[1] || comp.name;
      if (name.toLowerCase().startsWith(intent.prefix.toLowerCase())) {
        const key = name;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          completion: name,
          label: \`\${name} — \${comp.component_kind}\`,
          detail: \`Risk: \${(comp.risk_score_basis_points / 100).toFixed(0)} bp\`,
          source: 'db',
          canonScore: 1 - comp.risk_score_basis_points / 10000,
          riskScore: comp.risk_score_basis_points / 100,
          sortKey: \`\${(1 - comp.risk_score_basis_points / 10000).toFixed(2)}_\${name}\`,
        });
      }
    }
  }

  // Sort by canon score (descending) then alphabetically
  results.sort((a, b) => {
    if (b.canonScore !== a.canonScore) return b.canonScore - a.canonScore;
    return a.completion.localeCompare(b.completion);
  });

  return results.slice(0, 5);
}

// ============================================================================
// OPERATOR INTEGRATION: Learn from Incidents
// ============================================================================

async function syncIncidentToMemory(
  incident: OperatorIncident,
  projectRoot: string
): Promise<void> {
  if (incident.status !== 'closed' || !incident.resolution) return;

  // Store learned patterns in a local cache
  const learnDir = path.join(projectRoot, '.planekey', 'learned-patterns');
  fs.mkdirSync(learnDir, { recursive: true });

  const learnFile = path.join(learnDir, `${incident.id}.json`);

  const learned = {
    incident_id: incident.id,
    resolution: incident.resolution,
    pattern: incident.code_snippet,
    corrected: incident.corrected_code,
    learned_at: new Date().toISOString(),
  };

  fs.writeFileSync(learnFile, JSON.stringify(learned, null, 2));

  // Invalidate cache so next load picks up changes
  cachedIndexes = null;
}

// When IDE detects incident closed:
async function onIncidentResolved(
  incidentId: string,
  resolution: string,
  projectRoot: string
): Promise<void> {
  const incidentDir = path.join(projectRoot, '.planekey', 'operator', 'incidents');
  const incidentFile = path.join(incidentDir, \`\${incidentId}.json\`);

  if (!fs.existsSync(incidentFile)) return;

  const incident = JSON.parse(fs.readFileSync(incidentFile, 'utf8'));

  // Sync to memory
  await syncIncidentToMemory(incident, projectRoot);

  // Trigger memory rebuild if needed
  const learnPatterns = fs.readdirSync(
    path.join(projectRoot, '.planekey', 'learned-patterns'),
    { withFileTypes: true }
  ).length;

  if (learnPatterns > 5) {
    // Rebuild memory every 5 new patterns
    console.log('[PlaneKey] Rebuilding memory after incident learning...');
    await rebuildMemory(projectRoot);
  }
}

async function rebuildMemory(projectRoot: string): Promise<void> {
  const cmd = 'pk-memory';
  const args = [
    'memory',
    'build',
    projectRoot,
    '--name',
    \`learned-\${Date.now()}\`,
    '--out',
    path.join(projectRoot, '.planekey', 'memory'),
  ];

  return new Promise((resolve, reject) => {
    cp.spawn(cmd, args, { cwd: projectRoot }).on('close', (code) => {
      if (code === 0) {
        cachedIndexes = null; // Invalidate cache
        resolve();
      } else {
        reject(new Error(\`pk-memory rebuild failed\`));
      }
    });
  });
}

// ============================================================================
// VS CODE PROVIDER: Inline Completion
// ============================================================================

export class PredictiveTypingProvider implements vscode.InlineCompletionItemProvider {
  constructor(private projectRoot: string) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.InlineCompletionItem[]> {
    const indexes = await loadAllIndexes(this.projectRoot);
    if (!indexes) return [];

    const line = document.lineAt(position);
    const linePrefix = line.text.substring(0, position.character);

    const intent = parseIntent(linePrefix, document.fileName);
    if (!intent) return [];

    const results = queryMemoryByIntent(indexes, intent);

    return results.map((r) => ({
      insertText: r.completion,
      label: r.label,
      detail: r.detail,
      range: new vscode.Range(position, position),
      sortText: r.sortKey,
    }));
  }
}

// ============================================================================
// EXTENSION ACTIVATION
// ============================================================================

export async function activate(context: vscode.ExtensionContext) {
  const projectRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  // Register inline completion provider
  const provider = new PredictiveTypingProvider(projectRoot);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      [
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'typescript' },
        { scheme: 'file', language: 'typescriptreact' },
        { scheme: 'file', language: 'html' },
        { scheme: 'file', language: 'json' },
      ],
      provider
    )
  );

  // Command: Index codebase
  context.subscriptions.push(
    vscode.commands.registerCommand('planekey.indexCodebase', async () => {
      const term = vscode.window.createTerminal('PlaneKey: Index Codebase');
      term.sendText(\`pk-memory memory build \${projectRoot} --name canonical-\${Date.now()}\`);
      term.show();
    })
  );

  // Command: Refresh memory
  context.subscriptions.push(
    vscode.commands.registerCommand('planekey.refreshMemory', async () => {
      cachedIndexes = null;
      vscode.window.showInformationMessage('✓ Memory cache cleared');
    })
  );

  // Listen for file changes to auto-refresh memory
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (e) => {
      if (e.document.fileName.includes('.planekey/operator/incidents')) {
        // Incident changed - possibly resolved
        const match = e.document.fileName.match(/incidents\/(inc-[^.]+)\.json/);
        if (match) {
          const incId = match[1];
          const incident = JSON.parse(e.document.getText());
          if (incident.status === 'closed') {
            await onIncidentResolved(incId, incident.resolution, projectRoot);
          }
        }
      }
    })
  );

  console.log('[PlaneKey] Predictive typing activated');
}

export function deactivate() {
  cachedIndexes = null;
}
