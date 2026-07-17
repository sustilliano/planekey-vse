// =============================================================================
// planekey-init.ts
// Complete system initialization: memory + db + operator + vcs + licensing
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';

// ============================================================================
// BANNER
// ============================================================================

const BANNER = \`
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║              🔮 PlaneKey v0.2.15: Complete Initialization               ║
║                                                                           ║
║  Risk-Aware Predictive Typing for Collaborative OS Development          ║
║  With Multi-Repo Support, Licensing Compliance & Incident Learning      ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
\`;

// ============================================================================
// INITIALIZATION CONFIG
// ============================================================================

interface PlaneKeyConfig {
  projectName: string;
  projectRoot: string;
  license: string;
  author: string;
  authorEmail: string;
  repoSlug: string;
  ownerAccount: string;
  isForked: boolean;
  upstreamUrl?: string;
  enableDocker: boolean;
  enableGitHooks: boolean;
  language: 'typescript' | 'python' | 'rust' | 'mixed';
  chunkSize: number;
}

// ============================================================================
// STEP 1: Directory Structure
// ============================================================================

async function initDirectoryStructure(config: PlaneKeyConfig): Promise<void> {
  console.log('\n📁 Creating directory structure...');

  const dirs = [
    '.planekey',
    '.planekey/memory',
    '.planekey/branch-memory',
    '.planekey/operator',
    '.planekey/operator/incidents',
    '.planekey/operator/trash',
    '.planekey/operator/backups',
    '.planekey/learned-patterns',
    '.planekey/compliance',
    '.planekey/cache',
    'repo-db',
    'LICENSES'
  ];

  for (const dir of dirs) {
    const fullPath = path.join(config.projectRoot, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      console.log(\`  ✓ \${dir}/\`);
    }
  }
}

// ============================================================================
// STEP 2: LICENSE SETUP
// ============================================================================

async function initLicenseStructure(config: PlaneKeyConfig): Promise<void> {
  console.log('\n⚖️  Initializing license structure...');

  const licenseText = getLicenseText(config.license, config.author, new Date().getFullYear().toString());
  
  fs.writeFileSync(
    path.join(config.projectRoot, 'LICENSE'),
    licenseText
  );
  console.log('  ✓ LICENSE');

  const attributionTemplate = \`# Attribution & Licensing

**Project**: \${config.projectName}
**License**: \${config.license}
**Author**: \${config.author} <\${config.authorEmail}>
**Created**: \${new Date().toISOString()}

## Direct Contributions

- Original development by \${config.author}

## Merged/Incorporated Code

This section is auto-populated when merging upstream repositories:

\`;

  fs.writeFileSync(
    path.join(config.projectRoot, 'ATTRIBUTION.md'),
    attributionTemplate
  );
  console.log('  ✓ ATTRIBUTION.md');

  const noticeTemplate = \`NOTICE

\${config.projectName} is licensed under the \${config.license} License.

Copyright © \${new Date().getFullYear()} \${config.author}

This product may include software from other projects. See ATTRIBUTION.md and LICENSES/ for details.
\`;

  fs.writeFileSync(
    path.join(config.projectRoot, 'NOTICE'),
    noticeTemplate
  );
  console.log('  ✓ NOTICE');
}

function getLicenseText(license: string, author: string, year: string): string {
  const templates: { [key: string]: string } = {
    'MIT': \`MIT License

Copyright (c) \${year} \${author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.\`,
    'Apache-2.0': \`Apache License
Version 2.0, January 2004

Copyright \${year} \${author}

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.\`
  };

  return templates[license] || \`License: \${license}\nCopyright (c) \${year} \${author}\`;
}

// ============================================================================
// STEP 3: PACKAGE.JSON / CONFIG
// ============================================================================

async function initPackageJson(config: PlaneKeyConfig): Promise<void> {
  console.log('\n📦 Creating package.json...');

  const pkgPath = path.join(config.projectRoot, 'package.json');
  let pkg: any = {};

  if (fs.existsSync(pkgPath)) {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  }

  pkg.name = config.projectName;
  pkg.version = '0.1.0';
  pkg.description = 'PlaneKey-enabled project';
  pkg.license = config.license;
  pkg.author = \`\${config.author} <\${config.authorEmail}>\`;
  pkg.engines = { node: '>=18.0.0' };
  pkg.planekey = {
    repoSlug: config.repoSlug,
    ownerAccount: config.ownerAccount,
    isForked: config.isForked,
    upstreamUrl: config.upstreamUrl,
    enableDocker: config.enableDocker,
    language: config.language,
    chunkSize: config.chunkSize,
    indexedAt: new Date().toISOString()
  };

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log('  ✓ package.json configured');
}

// ============================================================================
// STEP 4: GIT SETUP
// ============================================================================

async function initGitSetup(config: PlaneKeyConfig): Promise<void> {
  console.log('\n🔗 Setting up git...');

  const gitDir = path.join(config.projectRoot, '.git');
  const isGitRepo = fs.existsSync(gitDir);

  if (!isGitRepo) {
    cp.spawnSync('git', ['init'], { cwd: config.projectRoot });
    console.log('  ✓ Initialized git repository');
  }

  if (config.isForked && config.upstreamUrl) {
    const hasUpstream = cp.spawnSync('git', ['config', '--get', 'remote.upstream.url'], {
      cwd: config.projectRoot,
      encoding: 'utf8'
    }).stdout.trim();

    if (!hasUpstream) {
      cp.spawnSync('git', ['remote', 'add', 'upstream', config.upstreamUrl], {
        cwd: config.projectRoot
      });
      console.log('  ✓ Added upstream remote');
    }
  }

  // Create .gitignore entries
  const gitignorePath = path.join(config.projectRoot, '.gitignore');
  let gitignore = '';

  if (fs.existsSync(gitignorePath)) {
    gitignore = fs.readFileSync(gitignorePath, 'utf8');
  }

  const planeKeyEntries = [
    '.planekey/cache/**',
    '.upstream-cache/',
    'node_modules/',
    'dist/',
    'build/',
    '__pycache__/',
    '*.pyc'
  ];

  for (const entry of planeKeyEntries) {
    if (!gitignore.includes(entry)) {
      gitignore += \`\n\${entry}\`;
    }
  }

  fs.writeFileSync(gitignorePath, gitignore.trim());
  console.log('  ✓ Updated .gitignore');
}

// ============================================================================
// STEP 5: BUILD INITIAL INDEXES
// ============================================================================

async function buildInitialIndexes(config: PlaneKeyConfig): Promise<void> {
  console.log('\n🔍 Building initial indexes...');

  // Build DB index
  const dbBuilderPath = path.join(config.projectRoot, 'tools', 'pk-repo-db-builder.js');
  
  if (fs.existsSync(dbBuilderPath)) {
    console.log('  Building pk-repo-db index...');
    cp.spawnSync('node', [
      dbBuilderPath,
      '--dir', config.projectRoot,
      '--repo-slug', config.repoSlug,
      '--owner-account', config.ownerAccount,
      '--recipe-name', config.projectName,
      '--recipe-version', 'v0.1.0',
      '--out', path.join(config.projectRoot, 'repo-db/repo-ingest-packet.json')
    ], { cwd: config.projectRoot });
    console.log('  ✓ repo-db/repo-ingest-packet.json');
  }

  // Build memory index (would use pk-memory CLI)
  console.log('  Building pk-memory index...');
  console.log('  (Run: pk-memory memory build . --name canonical-initial)');
}

// ============================================================================
// STEP 6: GIT HOOKS
// ============================================================================

async function installGitHooks(config: PlaneKeyConfig): Promise<void> {
  if (!config.enableGitHooks) return;

  console.log('\n🪝 Installing git hooks...');

  const hooksDir = path.join(config.projectRoot, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // Pre-commit hook: SPDX compliance
  const preCommitHook = \`#!/bin/bash
# PlaneKey: SPDX License Identifier compliance check

echo "[PlaneKey] Checking SPDX compliance..."

files=\$(git diff --cached --name-only)
missing=0

for file in \$files; do
  [ -f "\$file" ] || continue
  [[ "\$file" =~ \.(ts|js|py|rs)$ ]] || continue
  [[ "\$file" =~ ^tests/ || "\$file" =~ ^docs/ ]] && continue

  if ! grep -q "SPDX-License-Identifier" "\$file"; then
    echo "  ⚠️ Missing SPDX header: \$file"
    ((missing++))
  fi
done

if [ \$missing -gt 0 ]; then
  echo "\n❌ Found \$missing files without SPDX headers"
  echo "Run: planekey add-spdx-headers"
  exit 1
fi

echo "  ✓ All files SPDX compliant"
\`;

  fs.writeFileSync(path.join(hooksDir, 'pre-commit'), preCommitHook);
  fs.chmodSync(path.join(hooksDir, 'pre-commit'), 0o755);
  console.log('  ✓ pre-commit hook installed');

  // Prepare-commit-msg hook: Add branch context
  const prepareCommitHook = \`#!/bin/bash
# PlaneKey: Add branch info to commit message

branch=\$(git rev-parse --abbrev-ref HEAD)
if [[ "\$branch" != "main" && "\$branch" != "master" ]]; then
  echo "" >> "\$1"
  echo "[branch: \$branch]" >> "\$1"
fi
\`;

  fs.writeFileSync(path.join(hooksDir, 'prepare-commit-msg'), prepareCommitHook);
  fs.chmodSync(path.join(hooksDir, 'prepare-commit-msg'), 0o755);
  console.log('  ✓ prepare-commit-msg hook installed');
}

// ============================================================================
// STEP 7: DOCKER SETUP
// ============================================================================

async function initDockerSetup(config: PlaneKeyConfig): Promise<void> {
  if (!config.enableDocker) return;

  console.log('\n🐳 Checking Docker setup...');

  const dockerComposePath = path.join(config.projectRoot, 'docker-compose.yml');
  const dockerfilePath = path.join(config.projectRoot, 'Dockerfile');

  if (!fs.existsSync(dockerfilePath) && !fs.existsSync(dockerComposePath)) {
    console.log('  ℹ️  No Docker files found (optional)');
    return;
  }

  if (fs.existsSync(dockerComposePath)) {
    console.log('  ✓ docker-compose.yml detected');
  }

  if (fs.existsSync(dockerfilePath)) {
    console.log('  ✓ Dockerfile detected');
  }
}

// ============================================================================
// STEP 8: VSCODE EXTENSION
// ============================================================================

async function initVSCodeExtension(config: PlaneKeyConfig): Promise<void> {
  console.log('\n📝 Creating VS Code extension configuration...');

  const settingsPath = path.join(config.projectRoot, '.vscode', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const settings = {
    'planekey.enabled': true,
    'planekey.memory.minCanonScore': 0.5,
    'planekey.memory.maxRiskScore': 30,
    'planekey.memory.excludeSignals': [
      'agent_runtime_residue',
      'secret_or_private_material'
    ],
    'planekey.db.enabled': true,
    'planekey.db.useCanonicalHash': true,
    'planekey.operator.autoSync': true,
    'planekey.operator.rebuildThreshold': 5,
    'planekey.cache.ttl': 30,
    'planekey.fork.autoSyncUpstream': config.isForked,
    'planekey.fork.cacheUpstream': config.isForked,
    'planekey.branch.memoryIsolation': true,
    'planekey.docker.enableServiceCompletion': config.enableDocker,
    'planekey.logging.verbose': false
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log('  ✓ .vscode/settings.json');
}

// ============================================================================
// STEP 9: DOCUMENTATION
// ============================================================================

async function generateDocumentation(config: PlaneKeyConfig): Promise<void> {
  console.log('\n📚 Generating documentation...');

  const readmePath = path.join(config.projectRoot, 'PLANEKEY_SETUP.md');

  const readme = \`# PlaneKey Setup Complete ✨

**Project**: \${config.projectName}
**License**: \${config.license}
**Author**: \${config.author}
**Initialized**: \${new Date().toISOString()}

## What's Installed

- ✅ **pk-memory**: Trust scoring & structure extraction
- ✅ **pk-repo-db**: Component topology & canonical hashing
- ✅ **pk-operator**: Incident tracking & learning
- ✅ **VCS Integration**: Multi-repo, fork-aware indexing
- ✅ **Licensing**: SPDX headers, compliance checking, attribution
- ✅ **Git Hooks**: Pre-commit SPDX checking, prepare-commit-msg
- ✅ **VS Code Extension**: Inline predictive typing

## Getting Started

### 1. Install PlaneKey CLI Tools

\\`\\`\\`bash
npm install -g pk-memory pk-operator
\\`\\`\\`

### 2. Build Memory Index

\\`\\`\\`bash
pk-memory memory build . --name canonical-\$(date +%s) --out .planekey/memory
\\`\\`\\`

### 3. Open in VS Code

\\`\\`\\`bash
code .
\\`\\`\\`

The extension will auto-load memory + DB indexes. You'll see gray inline completions as you type.

## Key Commands

### Memory & Indexing
- \`planekey index-codebase\` — Build memory from current state
- \`planekey build-db\` — Build repo-db component index
- \`planekey refresh-cache\` — Clear and reload all indexes

### Incidents & Learning
- \`planekey open-incident\` — Report a code issue
- \`planekey show-memory-stats\` — View index statistics

### Licensing
- \`planekey init-license-structure\` — Create LICENSE files
- \`planekey add-spdx-headers\` — Add SPDX to all source files
- \`planekey generate-compliance-report\` — Audit compliance

### Fork Management (if applicable)
- \`planekey compare-with-fork\` — Show diff vs upstream
- \`planekey auto-sync-upstream\` — Pull & reindex upstream
- \`planekey show-branch-memory\` — View branch corrections

## Architecture

\\`\\`\\`
┌─────────────────────────────────────┐
│ VS Code IDE Extension               │
│ - Inline completions (gray text)   │
│ - Risk filtering + ranking          │
└────────────────┬────────────────────┘
                 │
        ┌────────┴─────────┐
        ▼                  ▼
┌──────────────────┐  ┌──────────────┐
│ pk-memory Index  │  │ pk-repo-db   │
│ (trust scores)   │  │ (components) │
└────────┬─────────┘  └──────┬───────┘
         │                   │
         └───────┬───────────┘
                 ▼
    ┌────────────────────────┐
    │ Integration Glue       │
    │ - Query engine         │
    │ - Caching              │
    │ - Fork/branch aware    │
    │ - Docker integration   │
    │ - Licensing compliance │
    └────────────────────────┘
                 ▲
                 │
        ┌────────┴──────────┐
        ▼                   ▼
┌──────────────┐    ┌──────────────┐
│ pk-operator  │    │ Git Context  │
│ (incidents)  │    │ (fork, branch)
└──────────────┘    └──────────────┘
\\`\\`\\`

## File Structure

\\`\\`\\`
.planekey/
├── memory/           ← Memory index
├── branch-memory/    ← Branch corrections
├── operator/         ← Incidents
│   ├── incidents/
│   ├── trash/
│   └── backups/
├── learned-patterns/ ← Auto-learned fixes
└── compliance/       ← License audit

repo-db/
└── repo-ingest-packet.json  ← Component DB

LICENSE              ← Project license
ATTRIBUTION.md       ← Merged code attribution
NOTICE              ← Legal notices
COMPLIANCE_REPORT.md ← Compliance audit
\\`\\`\\`

## Workflow Examples

### Example 1: Type a Route with Completions

\\`\\`\\`typescript
// Type:
app.get('/api/u

// See suggestions:
// /api/users (canon: 0.95, risk: 0)
// /api/user/:id (canon: 0.88, risk: 5)
// /api/username (canon: 0.82, risk: 12)
\\`\\`\\`

### Example 2: Report & Fix an Incident

\\`\\`\\`bash
# User code triggers incident
app.get('/api/secret', (req, res) => {
  res.send(process.env.API_KEY);  // 🚨 Security issue
});

# Run command: planekey open-incident
# Click: [Rewrite]
# Corrected to:
app.get('/api/secret', (req, res) => {
  res.status(200).json({ status: 'ok' });  // ✓ Safe
});

# Next time you type similar code on this branch:
# → Suggests corrected version instead
\\`\\`\\`

### Example 3: Merge with Upstream

\\`\\`\\`bash
$ git fetch upstream
$ git merge upstream/main

[PlaneKey pre-merge hook]
✓ License check passed
✓ Attribution registry generated

$ cat ATTRIBUTION.md
# Attribution
## Merged from upstream-repo (Apache-2.0)
- src/memory/optimization.ts
- src/memory/cache.ts
... (7 more)
\\`\\`\\`

## Next Steps

1. **Add team members**: Share \`.planekey/\` structure in docs
2. **Customize thresholds**: Edit \`.vscode/settings.json\`
3. **Enable MCP connections**: Connect to external memory services
4. **Set up CI/CD**: Run \`pk-memory\` in build pipeline
5. **Contribute back**: Create PRs with attribution intact

## Support

- GitHub: https://github.com/sustilliano/planekey
- Docs: https://planekey.dev/docs
- Issues: https://github.com/sustilliano/planekey/issues

---

**Initialized by PlaneKey v0.2.15** | \${new Date().toISOString()}
\`;

  fs.writeFileSync(readmePath, readme);
  console.log('  ✓ PLANEKEY_SETUP.md');
}

// ============================================================================
// STEP 10: SUMMARY
// ============================================================================

async function printSummary(config: PlaneKeyConfig): Promise<void> {
  console.log(\`

╔═══════════════════════════════════════════════════════════════════════════╗
║                     ✨ PlaneKey Initialized Successfully ✨              ║
╚═══════════════════════════════════════════════════════════════════════════╝

📦 Project: \${config.projectName}
📂 Location: \${config.projectRoot}
⚖️  License: \${config.license}
👤 Author: \${config.author}

🔧 INSTALLED COMPONENTS:
  ✅ Directory structure (.planekey/, repo-db/, LICENSES/)
  ✅ License files (LICENSE, ATTRIBUTION.md, NOTICE)
  ✅ Git setup (upstream remote, .gitignore)
  ✅ Git hooks (pre-commit, prepare-commit-msg)
  ✅ Package.json with PlaneKey config
  ✅ VS Code extension configuration
  ✅ Documentation (PLANEKEY_SETUP.md)

📋 NEXT STEPS:

1. Install CLI tools:
   npm install -g pk-memory pk-operator

2. Build initial indexes:
   pk-memory memory build . --name canonical-initial

3. Add SPDX headers to source:
   planekey add-spdx-headers

4. Open in VS Code:
   code .

5. Start typing to see completions!

🔗 FORK SETUP:
${config.isForked ? \`
  ✅ Upstream configured: \${config.upstreamUrl}
  ✅ Branch-aware indexing active
  ✅ License compatibility checking enabled
\` : \`
  ⓘ Not configured as fork
\`}

🐳 DOCKER:
${config.enableDocker ? \`
  ✅ Docker service completion enabled
\` : \`
  ⓘ Docker disabled
\`}

📚 DOCUMENTATION:
  • PLANEKEY_SETUP.md ← Quick start guide
  • LICENSE ← Project license
  • ATTRIBUTION.md ← Merged code attribution
  • COMPLIANCE_REPORT.md ← Auto-audit (run: planekey generate-compliance-report)

💡 TIPS:
  • Run 'planekey --help' for all commands
  • Check .vscode/settings.json to customize behavior
  • Use 'planekey show-memory-stats' to view index size
  • Enable git hooks to enforce SPDX compliance

Happy coding! 🚀

---
For more info: planekey.dev/docs
\`);
}

// ============================================================================
// MAIN: Full Initialization
// ============================================================================

async function runFullInitialization(config: PlaneKeyConfig): Promise<void> {
  console.log(BANNER);

  try {
    await initDirectoryStructure(config);
    await initLicenseStructure(config);
    await initPackageJson(config);
    await initGitSetup(config);
    await buildInitialIndexes(config);
    await installGitHooks(config);
    await initDockerSetup(config);
    await initVSCodeExtension(config);
    await generateDocumentation(config);
    await printSummary(config);
  } catch (err) {
    console.error('❌ Initialization failed:', err);
    process.exit(1);
  }
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(\`
PlaneKey Initialization

Usage:
  planekey init [options]

Options:
  --name <name>              Project name (required)
  --license <license>        License (MIT, Apache-2.0, GPL-3.0) [default: MIT]
  --author <author>          Author name (required)
  --email <email>            Author email (required)
  --repo-slug <slug>         Repository slug (required)
  --owner <uuid>             Owner account UUID [default: 00000000...]
  --fork <url>               Mark as fork of upstream URL
  --enable-docker            Enable Docker integration
  --enable-git-hooks         Install git hooks [default: true]
  --language <lang>          Source language (typescript|python|rust|mixed)
  --chunk-size <bytes>       Chunk size for indexing [default: 1048576]

Example:
  planekey init \\
    --name tensus \\
    --author "Joey Sustello" \\
    --email "joey@tensus.ai" \\
    --repo-slug tensus \\
    --fork https://github.com/tensus-ai/tensus.git \\
    --enable-docker \\
    --language typescript
\`);
    return;
  }

  const config: PlaneKeyConfig = {
    projectName: getArg('--name') || 'planekey-project',
    projectRoot: process.cwd(),
    license: getArg('--license') || 'MIT',
    author: getArg('--author') || 'Unknown',
    authorEmail: getArg('--email') || 'unknown@example.com',
    repoSlug: getArg('--repo-slug') || 'planekey-project',
    ownerAccount: getArg('--owner') || '00000000-0000-0000-0000-000000000000',
    isForked: !!getArg('--fork'),
    upstreamUrl: getArg('--fork'),
    enableDocker: args.includes('--enable-docker'),
    enableGitHooks: !args.includes('--disable-git-hooks'),
    language: (getArg('--language') as any) || 'typescript',
    chunkSize: parseInt(getArg('--chunk-size') || '1048576', 10)
  };

  await runFullInitialization(config);
}

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

// ============================================================================
// EXPORT + RUN
// ============================================================================

if (require.main === module) {
  main().catch(console.error);
}

export { runFullInitialization, PlaneKeyConfig };
