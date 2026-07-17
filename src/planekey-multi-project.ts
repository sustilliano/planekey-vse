// =============================================================================
// planekey-multi-project.ts
// Workspace-level project management + context switching
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// PROJECT REGISTRY: Global multi-project management
// ============================================================================

interface ProjectConfig {
  id: string;                    // UUID
  name: string;                  // tensus, redox, aquaos
  rootPath: string;              // /home/dev/tensus
  language: string;              // typescript, python, rust
  license: string;               // MIT, Apache-2.0
  isForked: boolean;
  upstreamUrl?: string;
  createdAt: string;
  lastAccessedAt: string;
  status: 'active' | 'archived' | 'paused';
}

interface ProjectRegistry {
  version: string;
  globalStoragePath: string;
  projects: ProjectConfig[];
  currentProject?: string;       // Currently active project ID
  lastUpdated: string;
}

// Global registry: ~/.planekey/registry.json
async function loadGlobalRegistry(): Promise<ProjectRegistry> {
  const registryPath = path.join(os.homedir(), '.planekey', 'registry.json');
  
  if (!fs.existsSync(registryPath)) {
    return {
      version: '0.2.15',
      globalStoragePath: path.join(os.homedir(), '.planekey'),
      projects: [],
      lastUpdated: new Date().toISOString()
    };
  }

  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}

async function saveGlobalRegistry(registry: ProjectRegistry): Promise<void> {
  const registryPath = path.join(os.homedir(), '.planekey', 'registry.json');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

// ============================================================================
// PROJECT ISOLATION: Each project has its own .planekey/
// ============================================================================

interface ProjectIndexes {
  projectId: string;
  memory: any;
  db: any;
  branchMemory: Map<string, any>;
  incidents: any[];
}

// Per-project storage structure:
// 
// /home/dev/tensus/.planekey/
//   ├── memory/canonical-*/
//   ├── branch-memory/
//   ├── operator/incidents/
//   └── cache/
//
// /home/dev/redox/.planekey/
//   ├── memory/canonical-*/
//   ├── branch-memory/
//   ├── operator/incidents/
//   └── cache/
//
// /home/dev/aquaos/.planekey/
//   ├── memory/canonical-*/
//   ├── branch-memory/
//   ├── operator/incidents/
//   └── cache/
//
// ~/.planekey/
//   ├── registry.json              ← Global project registry
//   ├── shared-patterns/           ← Patterns reusable across projects
//   ├── shared-incidents/          ← Learn from other projects
//   ├── cache/                     ← Shared cache

async function loadProjectIndexes(projectPath: string): Promise<ProjectIndexes> {
  const projectId = path.basename(projectPath);
  
  // Load project-specific indexes
  const memoryPath = path.join(projectPath, '.planekey', 'memory');
  const dbPath = path.join(projectPath, 'repo-db', 'repo-ingest-packet.json');
  
  let memory = null;
  let db = null;

  if (fs.existsSync(memoryPath)) {
    const latest = fs.readdirSync(memoryPath).sort().reverse()[0];
    const indexPath = path.join(memoryPath, latest, 'TMRFS_MEMORY_INDEX.json');
    if (fs.existsSync(indexPath)) {
      memory = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    }
  }

  if (fs.existsSync(dbPath)) {
    db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  }

  // Load branch memory
  const branchMemoryPath = path.join(projectPath, '.planekey', 'branch-memory');
  const branchMemory = new Map<string, any>();

  if (fs.existsSync(branchMemoryPath)) {
    for (const file of fs.readdirSync(branchMemoryPath)) {
      if (file.endsWith('.json')) {
        const branch = file.replace(/\.json$/, '').replace(/-/g, '/');
        const data = JSON.parse(fs.readFileSync(path.join(branchMemoryPath, file), 'utf8'));
        branchMemory.set(branch, data);
      }
    }
  }

  // Load incidents
  const incidentPath = path.join(projectPath, '.planekey', 'operator', 'incidents');
  const incidents: any[] = [];

  if (fs.existsSync(incidentPath)) {
    for (const file of fs.readdirSync(incidentPath)) {
      if (file.endsWith('.json')) {
        incidents.push(JSON.parse(fs.readFileSync(path.join(incidentPath, file), 'utf8')));
      }
    }
  }

  return { projectId, memory, db, branchMemory, incidents };
}

// ============================================================================
// CONTEXT SWITCHING: Instant project switching
// ============================================================================

async function switchProject(projectId: string): Promise<void> {
  const registry = await loadGlobalRegistry();
  
  const project = registry.projects.find(p => p.id === projectId);
  if (!project) {
    throw new Error(\`Project not found: \${projectId}\`);
  }

  registry.currentProject = projectId;
  project.lastAccessedAt = new Date().toISOString();

  await saveGlobalRegistry(registry);

  console.log(\`✓ Switched to project: \${project.name}\`);
  console.log(\`  Path: \${project.rootPath}\`);
  console.log(\`  Language: \${project.language}\`);
}

// ============================================================================
// CROSS-PROJECT PATTERN SHARING: Reuse safe patterns
// ============================================================================

interface CrossProjectPattern {
  id: string;
  projectSource: string;
  pattern: string;
  corrected: string;
  riskLevel: 'low' | 'medium' | 'high';
  usedInProjects: string[];
  confidence: number;
}

async function sharePatternAcrossProjects(
  sourceProjectId: string,
  pattern: string,
  corrected: string,
  riskLevel: string
): Promise<void> {
  const sharedPatternsPath = path.join(os.homedir(), '.planekey', 'shared-patterns');
  fs.mkdirSync(sharedPatternsPath, { recursive: true });

  const patternId = \`pattern-\${Date.now()}\`;
  const sharedPattern: CrossProjectPattern = {
    id: patternId,
    projectSource: sourceProjectId,
    pattern,
    corrected,
    riskLevel: riskLevel as any,
    usedInProjects: [sourceProjectId],
    confidence: 0.85
  };

  fs.writeFileSync(
    path.join(sharedPatternsPath, \`\${patternId}.json\`),
    JSON.stringify(sharedPattern, null, 2)
  );

  console.log(\`✓ Pattern shared: \${patternId}\`);
}

async function querySharedPatterns(prefix: string): Promise<CrossProjectPattern[]> {
  const sharedPatternsPath = path.join(os.homedir(), '.planekey', 'shared-patterns');

  if (!fs.existsSync(sharedPatternsPath)) return [];

  const results: CrossProjectPattern[] = [];

  for (const file of fs.readdirSync(sharedPatternsPath)) {
    if (!file.endsWith('.json')) continue;

    const pattern = JSON.parse(fs.readFileSync(path.join(sharedPatternsPath, file), 'utf8'));

    if (pattern.pattern.toLowerCase().startsWith(prefix.toLowerCase())) {
      results.push(pattern);
    }
  }

  return results;
}

// ============================================================================
// INCIDENT LEARNING ACROSS PROJECTS: Global knowledge base
// ============================================================================

async function pushIncidentToGlobal(
  projectId: string,
  incident: any
): Promise<void> {
  const globalIncidentsPath = path.join(os.homedir(), '.planekey', 'shared-incidents');
  fs.mkdirSync(globalIncidentsPath, { recursive: true });

  const incident_ = {
    ...incident,
    projectSource: projectId,
    sharedAt: new Date().toISOString()
  };

  fs.writeFileSync(
    path.join(globalIncidentsPath, \`\${incident.id}.json\`),
    JSON.stringify(incident_, null, 2)
  );

  console.log(\`✓ Incident shared globally: \${incident.id}\`);
}

async function queryGlobalIncidents(riskLevel: 'high' | 'medium' | 'low'): Promise<any[]> {
  const globalIncidentsPath = path.join(os.homedir(), '.planekey', 'shared-incidents');

  if (!fs.existsSync(globalIncidentsPath)) return [];

  const results: any[] = [];

  for (const file of fs.readdirSync(globalIncidentsPath)) {
    if (!file.endsWith('.json')) continue;

    const incident = JSON.parse(fs.readFileSync(path.join(globalIncidentsPath, file), 'utf8'));

    if (incident.riskLevel === riskLevel) {
      results.push(incident);
    }
  }

  return results;
}

// ============================================================================
// MULTI-PROJECT MEMORY CONSOLIDATION: Find patterns across projects
// ============================================================================

async function consolidateMemoryAcrossProjects(): Promise<{
  commonPatterns: string[];
  projectsWithPattern: Map<string, string[]>;
}> {
  const registry = await loadGlobalRegistry();

  const commonPatterns = new Set<string>();
  const projectsWithPattern = new Map<string, string[]>();

  for (const project of registry.projects) {
    if (project.status !== 'active') continue;

    const indexes = await loadProjectIndexes(project.rootPath);

    if (!indexes.memory?.nodes) continue;

    for (const node of indexes.memory.nodes) {
      if (!node.structure?.functions) continue;

      for (const fn of node.structure.functions) {
        commonPatterns.add(fn);

        if (!projectsWithPattern.has(fn)) {
          projectsWithPattern.set(fn, []);
        }
        projectsWithPattern.get(fn)!.push(project.id);
      }
    }
  }

  return {
    commonPatterns: Array.from(commonPatterns),
    projectsWithPattern
  };
}

// ============================================================================
// VS CODE MULTI-WORKSPACE: Multiple folders open simultaneously
// ============================================================================

interface MultiProjectWorkspaceConfig {
  folders: Array<{
    path: string;
    name: string;
  }>;
  settings: {
    [key: string]: any;
  };
  extensions: {
    recommendations: string[];
  };
}

async function generateMultiWorkspaceConfig(
  projectPaths: string[]
): Promise<MultiProjectWorkspaceConfig> {
  const folders = projectPaths.map(p => ({
    path: p,
    name: path.basename(p)
  }));

  return {
    folders,
    settings: {
      'planekey.multiProjectMode': true,
      'planekey.projectContextAwareness': true,
      'editor.defaultFormatter': 'esbenp.prettier-vscode',
      'editor.formatOnSave': true
    },
    extensions: {
      recommendations: [
        'planekey.planekey-predictive-typing',
        'esbenp.prettier-vscode',
        'dbaeumer.vscode-eslint',
        'rust-lang.rust-analyzer',
        'ms-python.python'
      ]
    }
  };
}

// ============================================================================
// PROJECT DASHBOARD: Overview of all projects
// ============================================================================

async function generateProjectDashboard(): Promise<string> {
  const registry = await loadGlobalRegistry();

  const dashboard = [
    '# PlaneKey Multi-Project Dashboard',
    \`Generated: \${new Date().toISOString()}\`,
    '',
    '## Active Projects',
    ''
  ];

  for (const project of registry.projects.filter(p => p.status === 'active')) {
    const indexes = await loadProjectIndexes(project.rootPath);

    dashboard.push(\`### \${project.name}\`,
      \`Path: \${project.rootPath}\`,
      \`Language: \${project.language}\`,
      \`License: \${project.license}\`,
      \`Forked: \${project.isForked ? 'Yes (' + project.upstreamUrl + ')' : 'No'}\`,
      \`Last Accessed: \${project.lastAccessedAt}\`,
      '');

    if (indexes.memory?.nodes) {
      dashboard.push(\`- Memory Index: \${indexes.memory.nodes.length} files\`);
    }

    if (indexes.db?.components) {
      dashboard.push(\`- Components: \${indexes.db.components.length}\`);
    }

    if (indexes.incidents.length > 0) {
      dashboard.push(\`- Open Incidents: \${indexes.incidents.filter(i => i.status === 'open').length}\`);
    }

    dashboard.push('');
  }

  dashboard.push('## Cross-Project Insights', '');

  const consolidation = await consolidateMemoryAcrossProjects();
  dashboard.push(\`Common Patterns: \${consolidation.commonPatterns.length}\`);
  dashboard.push('');

  const mostUsed = Array.from(consolidation.projectsWithPattern.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);

  dashboard.push('### Most Reused Patterns', '');
  for (const [pattern, projects] of mostUsed) {
    dashboard.push(\`- \${pattern} (used in \${projects.length} projects)\`);
  }

  return dashboard.join('\n');
}

// ============================================================================
// COMMANDS: Multi-project management
// ============================================================================

async function registerProject(name: string, rootPath: string, language: string, license: string): Promise<string> {
  const registry = await loadGlobalRegistry();

  const projectId = \`proj-\${Date.now()}\`;
  const project: ProjectConfig = {
    id: projectId,
    name,
    rootPath: path.resolve(rootPath),
    language,
    license,
    isForked: false,
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    status: 'active'
  };

  registry.projects.push(project);
  if (!registry.currentProject) {
    registry.currentProject = projectId;
  }

  await saveGlobalRegistry(registry);

  console.log(\`✓ Project registered: \${projectId}\`);
  console.log(\`  Name: \${name}\`);
  console.log(\`  Path: \${rootPath}\`);

  return projectId;
}

async function listProjects(): Promise<void> {
  const registry = await loadGlobalRegistry();

  console.log('\nPlaneKey Projects\n================\n');

  for (const project of registry.projects) {
    const marker = project.id === registry.currentProject ? '→' : ' ';
    const status = project.status === 'active' ? '✓' : '◯';

    console.log(\`\${marker} [\${status}] \${project.name}\`);
    console.log(\`     Path: \${project.rootPath}\`);
    console.log(\`     Lang: \${project.language}\`);
    console.log(\`     Fork: \${project.isForked ? 'Yes' : 'No'}\`);
    console.log('');
  }
}

async function archiveProject(projectId: string): Promise<void> {
  const registry = await loadGlobalRegistry();

  const project = registry.projects.find(p => p.id === projectId);
  if (!project) throw new Error(\`Project not found: \${projectId}\`);

  project.status = 'archived';
  await saveGlobalRegistry(registry);

  console.log(\`✓ Project archived: \${project.name}\`);
}

// ============================================================================
// EXPORT
// ============================================================================

export {
  loadGlobalRegistry,
  saveGlobalRegistry,
  switchProject,
  sharePatternAcrossProjects,
  querySharedPatterns,
  pushIncidentToGlobal,
  consolidateMemoryAcrossProjects,
  generateProjectDashboard,
  registerProject,
  listProjects,
  archiveProject,
  ProjectConfig,
  ProjectRegistry
};
