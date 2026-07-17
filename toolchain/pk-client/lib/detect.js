'use strict';

/**
 * pk-tools/lib/detect — shared project-detection module.
 *
 * Single source of truth for "what kind of project is this and where is
 * its bridge-talker entry point". Every PlaneKey tool that needs to
 * adapt to a project's shape (Hutch, Flight, future SafetyNet refactor,
 * `pk-client detect`, the action.yml metrics step) reads from here so
 * the substrate's understanding of project topology stays consistent.
 *
 * Returns:
 *   {
 *     root:       absolute path to the detected project root
 *     kind:       'trio' | 'tauri' | 'rust' | 'express' | 'workers' |
 *                 'vscode' | 'static' | 'unknown'
 *     entryPoint: relative path to the bridge-talker entry, or null
 *     entries:    array of all matched entry-points (some projects
 *                 have multiple — e.g. a monorepo with both a Tauri
 *                 shell and a server-core)
 *     signals:    { manifestFiles: [], indicatorFiles: [] } — the
 *                 evidence that drove the verdict, for diagnostic
 *                 messages
 *   }
 *
 * Detection priority (high → low):
 *   1. Trio canonical paths (products/server-core/, products/enterprise-bridge/)
 *   2. Tauri shell (products/bridge/tauri/, src/commands.rs + tauri.conf.json)
 *   3. Rust crate (products/bridge/src/main.rs, src/main.rs + Cargo.toml)
 *   4. Cloudflare Worker (src/worker.ts, src/index.ts + wrangler.toml)
 *   5. VS Code extension (src/extension.js + package.json with engines.vscode)
 *   6. Express server (server.js, src/server.js)
 *   7. Static site (index.html + no Node entry)
 *   8. Unknown
 *
 * Each candidate is "real" only if its required indicator files exist
 * — we don't infer kind from a single file. E.g. src/main.rs is
 * 'rust' only if Cargo.toml is also present.
 */

const fs = require('fs');
const path = require('path');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

const CANDIDATES = [
  // ── Trio canonical (server-core was the original auth-holding middle leg) ──
  {
    kind:       'trio',
    entry:      'products/server-core/src/attachPlaneKeyServerCore.js',
    indicators: ['products/server-core/PLANEKEY_SERVER_CORE_MANIFEST.json'],
    label:      'PlaneKey server-core (Trio middle leg)',
  },
  {
    kind:       'trio',
    entry:      'products/enterprise-bridge/src/server.js',
    indicators: ['products/enterprise-bridge/package.json'],
    label:      'PlaneKey enterprise-bridge',
  },
  // ── Tauri shell (server-core successor) ──
  {
    kind:       'tauri',
    entry:      'products/bridge/tauri/src/commands.rs',
    indicators: ['products/bridge/tauri/Cargo.toml', 'products/bridge/tauri/tauri.conf.json'],
    label:      'PlaneKey Tauri desktop shell',
  },
  {
    kind:       'tauri',
    entry:      'src/commands.rs',
    indicators: ['tauri.conf.json'],
    label:      'Tauri app',
  },
  // ── Rust bridge container / generic Rust service ──
  {
    kind:       'rust',
    entry:      'products/bridge/src/main.rs',
    indicators: ['products/bridge/Cargo.toml'],
    label:      'PlaneKey home bridge (Rust container)',
  },
  {
    kind:       'rust',
    entry:      'src/main.rs',
    indicators: ['Cargo.toml'],
    label:      'Rust crate',
  },
  // ── Cloudflare Workers ──
  {
    kind:       'workers',
    entry:      'src/worker.ts',
    indicators: ['wrangler.toml'],
    label:      'Cloudflare Worker',
  },
  {
    kind:       'workers',
    entry:      'src/index.ts',
    indicators: ['wrangler.toml'],
    label:      'Cloudflare Worker (index entry)',
  },
  // ── VS Code extension ──
  {
    kind:       'vscode',
    entry:      'src/extension.js',
    indicators: ['package.json'],
    indicatorTest: (root) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        return !!(pkg.engines && pkg.engines.vscode);
      } catch { return false; }
    },
    label:      'VS Code extension',
  },
  // ── Generic Express ──
  {
    kind:       'express',
    entry:      'server.js',
    indicators: ['package.json'],
    label:      'Express app (root server.js)',
  },
  {
    kind:       'express',
    entry:      'src/server.js',
    indicators: ['package.json'],
    label:      'Express app (src/server.js)',
  },
  // ── Static site ──
  {
    kind:       'static',
    entry:      'index.html',
    indicators: ['index.html'],
    label:      'Static HTML site',
  },
];

function findProjectRoot(start) {
  // Walk up looking for a recognizable workspace marker. Falls back
  // to the starting directory if no marker is found.
  let dir = path.resolve(start || process.cwd());
  const markers = ['.git', 'package.json', 'Cargo.toml', 'wrangler.toml', 'pyproject.toml'];
  while (true) {
    if (markers.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start || process.cwd());
    dir = parent;
  }
}

function detectProject(start) {
  const root = findProjectRoot(start);
  const matches = [];
  for (const c of CANDIDATES) {
    if (!isFile(path.join(root, c.entry))) continue;
    if (c.indicators && !c.indicators.every((i) => fs.existsSync(path.join(root, i)))) continue;
    if (c.indicatorTest && !c.indicatorTest(root)) continue;
    matches.push(c);
  }
  if (matches.length === 0) {
    return {
      root,
      kind:       'unknown',
      entryPoint: null,
      entries:    [],
      signals:    {
        manifestFiles:  [],
        indicatorFiles: [],
      },
      candidatesTried: CANDIDATES.map((c) => c.entry),
    };
  }
  const primary = matches[0];
  return {
    root,
    kind:       primary.kind,
    entryPoint: primary.entry,
    label:      primary.label,
    entries:    matches.map((m) => ({ kind: m.kind, entry: m.entry, label: m.label })),
    signals:    {
      manifestFiles:  [...new Set(matches.flatMap((m) => m.indicators || []))]
                       .filter((f) => fs.existsSync(path.join(root, f))),
      indicatorFiles: matches.map((m) => m.entry),
    },
  };
}

module.exports = { detectProject, findProjectRoot, CANDIDATES };

// CLI form: node detect.js [path]
if (require.main === module) {
  const target = process.argv[2] || process.cwd();
  const result = detectProject(target);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
