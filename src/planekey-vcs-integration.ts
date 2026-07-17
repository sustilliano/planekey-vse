// =============================================================================
// planekey-vcs-integration.ts
// Branch-aware, fork-aware predictive typing with multi-repo indexing
// =============================================================================

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

// ============================================================================
// GIT CONTEXT DETECTION
// ============================================================================

interface GitContext {
  rootDir: string;
  currentBranch: string;
  remoteUrl: string;
  isForked: boolean;
  upstreamUrl?: string;
  isDirty: boolean;
  stagedFiles: string[];
  unstagedFiles: string[];
}

async function detectGitContext(projectRoot: string): Promise<GitContext | null> {
  try {
    const git = (cmd: string) => {
      const result = cp.spawnSync('git', cmd.split(' '), {
        cwd: projectRoot,
        encoding: 'utf8'
      });
      return result.stdout.trim();
    };

    const currentBranch = git('rev-parse --abbrev-ref HEAD');
    const remoteUrl = git('config --get remote.origin.url');
    const upstreamUrl = git('config --get remote.upstream.url') || undefined;
    
    // Check if dirty
    const status = git('status --porcelain');
    const isDirty = status.length > 0;
    
    // Get staged/unstaged
    const stagedFiles = git('diff --cached --name-only').split('\n').filter(x => x);
    const unstagedFiles = git('diff --name-only').split('\n').filter(x => x);

    return {
      rootDir: projectRoot,
      currentBranch,
      remoteUrl,
      isForked: !!upstreamUrl,
      upstreamUrl,
      isDirty,
      stagedFiles,
      unstagedFiles
    };
  } catch {
    return null;
  }
}

// ============================================================================
// DOCKER CONTEXT DETECTION
// =============================================================================

interface DockerContext {
  hasDockerfile: boolean;
  hasDockerCompose: boolean;
  services: string[];
  buildTargets: string[];
  networks: string[];
  volumes: string[];
  environment: { [key: string]: string };
}

async function detectDockerContext(projectRoot: string): Promise<DockerContext> {
  const dockerfilePath = path.join(projectRoot, 'Dockerfile');
  const composePath = path.join(projectRoot, 'docker-compose.yml');
  const composePath2 = path.join(projectRoot, 'docker-compose.yaml');

  const context: DockerContext = {
    hasDockerfile: fs.existsSync(dockerfilePath),
    hasDockerCompose: fs.existsSync(composePath) || fs.existsSync(composePath2),
    services: [],
    buildTargets: [],
    networks: [],
    volumes: [],
    environment: {}
  };

  if (context.hasDockerfile) {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    const fromMatch = dockerfile.match(/^FROM\s+([^\s]+)/gm);
    if (fromMatch) context.buildTargets = fromMatch.map(m => m.replace(/^FROM\s+/, ''));
  }

  if (context.hasDockerCompose) {
    try {
      const yaml = require('js-yaml');
      const composePath_ = fs.existsSync(composePath) ? composePath : composePath2;
      const compose = yaml.load(fs.readFileSync(composePath_, 'utf8'));
      
      if (compose.services) {
        context.services = Object.keys(compose.services);
      }
      if (compose.networks) {
        context.networks = Object.keys(compose.networks);
      }
      if (compose.volumes) {
        context.volumes = Object.keys(compose.volumes);
      }
    } catch {
      // ignore yaml parse errors
    }
  }

  return context;
}

// ============================================================================
// MULTI-REPO INDEXING (Fork + Upstream)
// ============================================================================

interface RepoIndex {
  local: {
    path: string;
    branch: string;
    memory: any;
    db: any;
  };
  upstream?: {
    path: string;
    branch: string;
    memory: any;
    db: any;
    url: string;
  };
  mergedMemory?: any;
  mergedDB?: any;
}

async function buildMultiRepoIndex(projectRoot: string): Promise<RepoIndex | null> {
  const gitCtx = await detectGitContext(projectRoot);
  if (!gitCtx) return null;

  const index: RepoIndex = {
    local: {
      path: projectRoot,
      branch: gitCtx.currentBranch,
      memory: null,
      db: null
    }
  };

  // Load local indexes
  const localMemory = await loadMemoryIndex(projectRoot);
  const localDB = await loadDBIndex(projectRoot);
  
  if (localMemory) index.local.memory = localMemory;
  if (localDB) index.local.db = localDB;

  // If fork, try to load upstream
  if (gitCtx.isForked && gitCtx.upstreamUrl) {
    const upstreamPath = path.join(projectRoot, '.upstream-cache');
    
    // Clone upstream into cache (shallow, for speed)
    if (!fs.existsSync(upstreamPath)) {
      cp.spawnSync('git', ['clone', '--depth=1', gitCtx.upstreamUrl, upstreamPath], {
        cwd: projectRoot
      });
    } else {
      // Update upstream cache
      cp.spawnSync('git', ['pull'], { cwd: upstreamPath });
    }

    const upstreamMemory = await loadMemoryIndex(upstreamPath);
    const upstreamDB = await loadDBIndex(upstreamPath);

    index.upstream = {
      path: upstreamPath,
      branch: gitCtx.currentBranch, // or 'main'
      memory: upstreamMemory,
      db: upstreamDB,
      url: gitCtx.upstreamUrl
    };

    // Merge indexes
    if (upstreamMemory && localMemory) {
      index.mergedMemory = mergeMemoryIndexes(localMemory, upstreamMemory);
    }
    if (upstreamDB && localDB) {
      index.mergedDB = mergeDBIndexes(localDB, upstreamDB);
    }
  }

  return index;
}

function mergeMemoryIndexes(local: any, upstream: any): any {
  // Merge strategy:
  // 1. Start with upstream (canonical)
  // 2. Override with local for files that exist locally
  // 3. Prefer local's canon_score for local files (they've been tuned)
  // 4. Keep upstream's canon_score for files only in upstream

  const merged = { ...upstream };

  if (local.nodes && upstream.nodes) {
    const upstreamNodesByPath = new Map(upstream.nodes.map(n => [n.path, n]));
    const localNodesByPath = new Map(local.nodes.map(n => [n.path, n]));

    const allPaths = new Set([...upstreamNodesByPath.keys(), ...localNodesByPath.keys()]);

    merged.nodes = Array.from(allPaths).map(path => {
      const localNode = localNodesByPath.get(path);
      const upstreamNode = upstreamNodesByPath.get(path);

      if (localNode && upstreamNode) {
        // Both exist: prefer local's trust scores (more recent)
        return {
          ...upstreamNode,
          canon_score: localNode.canon_score,
          risk_score: localNode.risk_score,
          residue_signals: localNode.residue_signals,
          source_archive: \`\${upstreamNode.source_archive} (merged with local:\${localNode.source_archive})\`
        };
      } else if (localNode) {
        return localNode;
      } else {
        return upstreamNode;
      }
    });
  }

  return merged;
}

function mergeDBIndexes(local: any, upstream: any): any {
  // Merge strategy:
  // 1. Union all components (both upstream + local)
  // 2. Union all import edges
  // 3. New canonical_recipe_hash reflects merged state

  const merged = { ...upstream };

  if (local.components && upstream.components) {
    const componentMap = new Map();
    
    // Start with upstream (canonical)
    for (const comp of upstream.components) {
      componentMap.set(comp.canonical_hash, comp);
    }

    // Add/override with local
    for (const comp of local.components) {
      const existing = componentMap.get(comp.canonical_hash);
      if (existing) {
        // Prefer local's risk assessment
        componentMap.set(comp.canonical_hash, {
          ...existing,
          risk_score_basis_points: Math.min(
            existing.risk_score_basis_points,
            comp.risk_score_basis_points
          )
        });
      } else {
        componentMap.set(comp.canonical_hash, comp);
      }
    }

    merged.components = Array.from(componentMap.values());
  }

  if (local.importEdges && upstream.importEdges) {
    const edgeSet = new Set<string>();
    for (const edge of [...upstream.importEdges, ...local.importEdges]) {
      edgeSet.add(\`\${edge.from}:\${edge.to}\`);
    }
    merged.importEdges = Array.from(edgeSet).map(e => {
      const [from, to] = e.split(':');
      return { from, to };
    });
  }

  return merged;
}

// ============================================================================
// BRANCH-SPECIFIC MEMORY LAYER
// ============================================================================

interface BranchMemory {
  branch: string;
  createdAt: string;
  lastIndexed: string;
  baselineIndex: any;
  deltaSinceBase: any; // What's new/changed
  suggestionsOverride: { [pattern: string]: string }; // Branch-specific corrections
}

async function loadBranchMemory(projectRoot: string, branch: string): Promise<BranchMemory | null> {
  const branchMemoryPath = path.join(
    projectRoot,
    '.planekey',
    'branch-memory',
    \`\${branch.replace(/\//g, '-')}.json\`
  );

  if (!fs.existsSync(branchMemoryPath)) return null;

  return JSON.parse(fs.readFileSync(branchMemoryPath, 'utf8'));
}

async function saveBranchMemory(
  projectRoot: string,
  branchMemory: BranchMemory
): Promise<void> {
  const branchMemoryDir = path.join(projectRoot, '.planekey', 'branch-memory');
  fs.mkdirSync(branchMemoryDir, { recursive: true });

  const branchMemoryPath = path.join(
    branchMemoryDir,
    \`\${branchMemory.branch.replace(/\//g, '-')}.json\`
  );

  fs.writeFileSync(branchMemoryPath, JSON.stringify(branchMemory, null, 2));
}

// ============================================================================
// DOCKER-AWARE CONTEXT
// ============================================================================

interface DockerService {
  name: string;
  image: string;
  environment: { [key: string]: string };
  ports: string[];
  volumes: string[];
  networks: string[];
  healthCheck?: any;
}

interface DockerContextForPredictions {
  services: Map<string, DockerService>;
  environment: { [key: string]: string };
  networks: Set<string>;
  volumes: Set<string>;
}

function buildDockerContext(dockerCtx: DockerContext): DockerContextForPredictions {
  // Build service map from docker-compose
  const services = new Map<string, DockerService>();
  
  for (const serviceName of dockerCtx.services) {
    services.set(serviceName, {
      name: serviceName,
      image: '',
      environment: {},
      ports: [],
      volumes: [],
      networks: dockerCtx.networks,
      healthCheck: undefined
    });
  }

  return {
    services,
    environment: dockerCtx.environment,
    networks: new Set(dockerCtx.networks),
    volumes: new Set(dockerCtx.volumes)
  };
}

// ============================================================================
// BRANCH + DOCKER AWARE QUERY
// ============================================================================

interface EnhancedQueryIntent {
  type: 'route' | 'import' | 'function' | 'html_id' | 'component';
  prefix: string;
  branch?: string;
  isForked?: boolean;
  dockerService?: string;
  context?: string;
}

function queryMemoryByIntentBranchAware(
  repoIndex: RepoIndex,
  branchMemory: BranchMemory | null,
  dockerCtx: DockerContextForPredictions | null,
  intent: EnhancedQueryIntent
): QueryResult[] {
  const results: QueryResult[] = [];
  const seen = new Set<string>();

  // Determine which indexes to search
  const memoriesToSearch = [
    { memory: repoIndex.local.memory, source: 'local', weight: 1.0 },
    ...(repoIndex.mergedMemory
      ? [{ memory: repoIndex.mergedMemory, source: 'merged', weight: 0.8 }]
      : [])
  ];

  // Search each memory
  for (const { memory, source, weight } of memoriesToSearch) {
    if (!memory?.nodes) continue;

    for (const node of memory.nodes) {
      if (!node.structure) continue;

      let candidates: string[] = [];

      if (intent.type === 'route') {
        candidates = node.structure.routes || [];
      } else if (intent.type === 'import') {
        candidates = node.structure.imports || [];
      } else if (intent.type === 'function') {
        candidates = node.structure.functions || [];
      } else if (intent.type === 'html_id') {
        candidates = node.structure.html_ids || [];
      }

      for (const candidate of candidates) {
        if (!candidate.toLowerCase().startsWith(intent.prefix.toLowerCase())) continue;

        const key = candidate;
        if (seen.has(key)) continue;

        // Apply branch-specific overrides
        let finalCandidate = candidate;
        if (branchMemory?.suggestionsOverride[candidate]) {
          finalCandidate = branchMemory.suggestionsOverride[candidate];
          seen.add(key); // Mark as seen so we don't add original
          seen.add(finalCandidate); // And final too
        } else {
          seen.add(key);
        }

        const trust = memory.trustIndex?.[node.node_id] || {};

        // Risk filtering (same as before)
        if (trust.status === 'quarantine' || trust.status === 'block') continue;
        if (trust.risk_score >= 80) continue;

        results.push({
          completion: finalCandidate,
          label: \`\${finalCandidate} — \${source} (\${node.source_archive})\`,
          detail: \`Risk: \${trust.risk_score} | Canon: \${trust.canon_score?.toFixed(2) || 'N/A'} | Branch: \${repoIndex.local.branch}\`,
          source: source as any,
          canonScore: trust.canon_score || 0,
          riskScore: trust.risk_score || 0,
          sortKey: \`\${(trust.canon_score || 0).toFixed(2)}_\${weight.toFixed(2)}_\${finalCandidate}\`,
        });
      }
    }
  }

  // Add docker-specific context
  if (dockerCtx && intent.type === 'import') {
    for (const [serviceName, service] of dockerCtx.services) {
      if (serviceName.toLowerCase().startsWith(intent.prefix.toLowerCase())) {
        results.push({
          completion: serviceName,
          label: \`\${serviceName} (docker service)\`,
          detail: 'Docker Compose service',
          source: 'docker',
          canonScore: 0.75,
          riskScore: 0,
          sortKey: \`0.75_0.9_\${serviceName}\`,
        });
      }
    }
  }

  // Sort by canonical score + source weight
  results.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  return results.slice(0, 5);
}

// ============================================================================
// BRANCH DIFF AWARENESS (Show what's new on this branch)
// ============================================================================

async function analyzeBranchDiff(gitCtx: GitContext): Promise<{
  newPatterns: string[];
  modifiedPatterns: string[];
  deletedPatterns: string[];
}> {
  // Compare this branch against upstream (if fork) or main (if not)
  const baselineRef = gitCtx.isForked ? 'upstream/main' : 'origin/main';

  try {
    const diff = cp.spawnSync('git', ['diff', baselineRef, '--name-only'], {
      cwd: gitCtx.rootDir,
      encoding: 'utf8'
    }).stdout.trim().split('\n').filter(x => x);

    // Categorize
    const diffStatus = cp.spawnSync('git', ['diff', baselineRef, '--name-status'], {
      cwd: gitCtx.rootDir,
      encoding: 'utf8'
    }).stdout.trim().split('\n').filter(x => x);

    const newPatterns = diffStatus
      .filter(line => line.startsWith('A\t'))
      .map(line => line.split('\t')[1]);

    const modifiedPatterns = diffStatus
      .filter(line => line.startsWith('M\t'))
      .map(line => line.split('\t')[1]);

    const deletedPatterns = diffStatus
      .filter(line => line.startsWith('D\t'))
      .map(line => line.split('\t')[1]);

    return { newPatterns, modifiedPatterns, deletedPatterns };
  } catch {
    return { newPatterns: [], modifiedPatterns: [], deletedPatterns: [] };
  }
}

// ============================================================================
// COMMAND: Compare with Fork (Show difference)
// ============================================================================

async function compareWithFork(projectRoot: string): Promise<void> {
  const gitCtx = await detectGitContext(projectRoot);
  if (!gitCtx?.isForked) {
    vscode.window.showWarningMessage('Not a forked repository');
    return;
  }

  const { newPatterns, modifiedPatterns, deletedPatterns } = await analyzeBranchDiff(gitCtx);

  const output = [
    '# Fork Comparison Report',
    '',
    '## New Files in This Branch',
    ...newPatterns.map(p => \`- \${p}\`),
    '',
    '## Modified Files',
    ...modifiedPatterns.map(p => \`- \${p}\`),
    '',
    '## Deleted Files',
    ...deletedPatterns.map(p => \`- \${p}\`),
  ].join('\n');

  const panel = vscode.window.createWebviewPanel(
    'planekey.forkComparison',
    'Fork Comparison',
    vscode.ViewColumn.Two
  );

  panel.webview.html = \`
    <pre style="white-space: pre-wrap; font-family: monospace;">
      \${output}
    </pre>
  \`;
}

// ============================================================================
// COMMAND: Auto-Sync Upstream (Pull upstream changes)
// ============================================================================

async function autoSyncUpstream(projectRoot: string): Promise<void> {
  const gitCtx = await detectGitContext(projectRoot);
  if (!gitCtx?.isForked) return;

  const term = vscode.window.createTerminal('PlaneKey: Sync Upstream');
  term.sendText(\`git fetch upstream\`);
  term.sendText(\`git merge upstream/main\`);
  term.sendText(\`pk-memory memory build . --name \${gitCtx.currentBranch}-synced\`);
  term.show();
}

// ============================================================================
// EXPORT
// ============================================================================

export {
  detectGitContext,
  detectDockerContext,
  buildMultiRepoIndex,
  mergeMemoryIndexes,
  mergeDBIndexes,
  loadBranchMemory,
  saveBranchMemory,
  buildDockerContext,
  queryMemoryByIntentBranchAware,
  analyzeBranchDiff,
  compareWithFork,
  autoSyncUpstream,
  GitContext,
  DockerContext,
  RepoIndex,
  BranchMemory,
  EnhancedQueryIntent
};
