#!/usr/bin/env node
'use strict';

/**
 * PlaneKey Client v0.1.5.7
 * Local archive manager + manifest generator + patch/bundle/export tool.
 * Dependency-free Node.js implementation.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { mmxPackBytes, mmxUnpackBytes } = require('../lib/mmx.js');
const { spawnSync } = require('child_process');
const CLIENT_ROOT = path.resolve(__dirname, '..');

const VERSION = '0.1.5.14';

const DEFAULT_CONFIG = {
  project: 'pkclient',
  workingTreeName: 'planekey-cli-current',
  snapshotPrefix: 'cc',
  /** defaultAllowedFiles: [
   * 'server.js',
    *'package.json',
   * 'package-lock.json',
   * 'render.yaml',
    *'public/**',
    *'admin/**',
   * 'server/**',
   * 'tools/**',
   * 'migrations/**',
   * 'PLANEKEY_INTEGRATION.md',
  *  'README.md',
  *  'CHANGELOG.md'
  *],
  */
  defaultForbiddenPaths: [
    '.env',
    '.env.*',
    'node_modules/**',
    '.git/**',
    'planekey-history/**',
    'debug/**',
    'shell-snapshots/**',
    'uploads/**',
    'database/**',
    'sessions/**',
    'tmp/**',
    'logs/**',
    '.planekey/rabbit/**',
    '*.rabbit',
    '*.pem',
    '*.key',
    '*.p12',
    '*.sqlite',
    '*.db'
  ],
  rootRabbit: {
    enabled: true,
    requiredFiles: [
      'server.js'
    ],
    installedFiles: [
      'server/security/root-rabbit.js',
      'server.js',
      'admin/planekey.html'
    ],
    sensitivePaths: [
      'server.js',
      'server/security/root-rabbit.js',
      'admin/planekey.html',
      'public/js/ui-template.js',
      'public/ui-tools/**',
      'migrations/**'
    ],
    runtimeForbiddenPaths: [
      '.planekey/rabbit/**',
      '*.rabbit'
    ],
    minimumZonesWhenInstalled: 3
  },
  safetyNet: {
    enabled: true,
    hutchEnabled: true,
    flightEnabled: true,
    preferProjectTools: true,
    bundledToolsDir: 'tools',
    hutchScript: 'hutch.js',
    flightScript: 'flight.js',
    minimumHutchScore: 0.85,
    minimumFlightScore: 0.85,
    failOnHutchFailures: true,
    failOnFlightTurbulence: true
  },
  publicRepo: {
    enabled: true,
    failOnSecretHits: true,
    maxTextFileBytes: 2 * 1024 * 1024,
    allowedEnvExampleFiles: [
      '.env.example',
      'env.example',
      'example.env',
      'sample.env'
    ],
    privateFilePatterns: [
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      '*.p12',
      '*.pfx',
      '*.sqlite',
      '*.sqlite3',
      '*.db',
      'id_rsa',
      'id_dsa',
      'id_ecdsa',
      'id_ed25519',
      'service-account*.json',
      '*credentials*.json',
      '*secret*.json'
    ],
    allowPlaceholderValues: [
      '',
      'REDACTED',
      'CHANGE_ME',
      'CHANGEME',
      'TODO',
      'your-value-here',
      'your_key_here',
      'example',
      'example-value',
      '<secret>',
      '<redacted>'
    ]
  },
  exportExclude: [
    '.env',
    '.env.*',
    'node_modules/**',
    '.git/**',
    'planekey-history/**',
    'debug/**',
    'shell-snapshots/**',
    'uploads/**',
    'database/**',
    'sessions/**',
    'tmp/**',
    'logs/**',
    '.planekey/rabbit/**',
    '*.rabbit',
    'vault/**',
    'inventory/**',
    'patches/**',
    'bundles/**',
    'reports/**',
    'exports/**',
    '*.zip',
    '*.rar',
    '*.7z',
    '*.pem',
    '*.key',
    '*.p12',
    '*.sqlite',
    '*.db'
  ]
};

function nowIso() {
  return new Date().toISOString();
}

function safeDateStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'snapshot';
}

function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function writeText(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, 'utf8');
}

function exists(p) {
  return fs.existsSync(p);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function relUnix(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function normalizePattern(pattern) {
  return String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
}

function patternToRegex(pattern) {
  let p = normalizePattern(pattern);
  let out = '^';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    const next = p[i + 1];
    if (ch === '*' && next === '*') {
      out += '.*';
      i++;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if ('\\.^$+?()[]{}|'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  out += '$';
  return new RegExp(out);
}

function matchesAny(rel, patterns) {
  const r = normalizePattern(rel);
  return (patterns || []).some((pattern) => {
    const p = normalizePattern(pattern);
    if (!p) return false;
    if (p.endsWith('/**')) {
      const base = p.slice(0, -3);
      return r === base || r.startsWith(base + '/');
    }
    return patternToRegex(p).test(r);
  });
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const raw = token.slice(2);
      const eq = raw.indexOf('=');
      if (eq >= 0) {
        flags[raw.slice(0, eq)] = raw.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[raw] = next;
          i++;
        } else {
          flags[raw] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function uniqueList(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function loadConfig(root) {
  const cfgFile = path.join(root, 'client.config.json');
  const fromDisk = readJsonIfExists(cfgFile, {});
  const merged = {
    ...DEFAULT_CONFIG,
    ...fromDisk,
    rootRabbit: {
      ...(DEFAULT_CONFIG.rootRabbit || {}),
      ...((fromDisk && fromDisk.rootRabbit) || {})
    },
    safetyNet: {
      ...(DEFAULT_CONFIG.safetyNet || {}),
      ...((fromDisk && fromDisk.safetyNet) || {})
    },
    publicRepo: {
      ...(DEFAULT_CONFIG.publicRepo || {}),
      ...((fromDisk && fromDisk.publicRepo) || {})
    }
  };

  // Backfill new safety rails into older client.config.json files without
  // forcing users to manually regenerate their workspace config.
  merged.defaultAllowedFiles = uniqueList([
    ...(fromDisk.defaultAllowedFiles || DEFAULT_CONFIG.defaultAllowedFiles || []),
    'server/**'
  ]);
  merged.defaultForbiddenPaths = uniqueList([
    ...(fromDisk.defaultForbiddenPaths || DEFAULT_CONFIG.defaultForbiddenPaths),
    '.planekey/rabbit/**',
    '*.rabbit'
  ]);
  merged.exportExclude = uniqueList([
    ...(fromDisk.exportExclude || DEFAULT_CONFIG.exportExclude),
    '.planekey/rabbit/**',
    '*.rabbit'
  ]);
  merged.rootRabbit.runtimeForbiddenPaths = uniqueList([
    ...((merged.rootRabbit && merged.rootRabbit.runtimeForbiddenPaths) || []),
    '.planekey/rabbit/**',
    '*.rabbit'
  ]);
  merged.publicRepo.privateFilePatterns = uniqueList([
    ...((merged.publicRepo && merged.publicRepo.privateFilePatterns) || []),
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    '*.sqlite',
    '*.sqlite3',
    '*.db'
  ]);
  merged.publicRepo.allowedEnvExampleFiles = uniqueList([
    ...((merged.publicRepo && merged.publicRepo.allowedEnvExampleFiles) || []),
    '.env.example'
  ]);
  return merged;
}

function paths(root, config = loadConfig(root)) {
  return {
    root,
    configFile: path.join(root, 'client.config.json'),
    vault: path.join(root, 'vault'),
    rawDownloads: path.join(root, 'vault', 'raw-downloads'),
    originalZips: path.join(root, 'vault', 'original-zips'),
    frozenSnapshots: path.join(root, 'vault', 'frozen-snapshots'),
    inventory: path.join(root, 'inventory'),
    snapshotsIndex: path.join(root, 'inventory', 'snapshots.json'),
    fileManifest: path.join(root, 'inventory', 'file_manifest.json'),
    folderIndex: path.join(root, 'inventory', 'folder_index.csv'),
    duplicateReport: path.join(root, 'inventory', 'duplicate_report.md'),
    sanitizedMap: path.join(root, 'inventory', 'sanitized_vs_live_map.md'),
    working: path.join(root, 'working'),
    workingTree: path.join(root, 'working', config.workingTreeName),
    workingMeta: path.join(root, 'working', '.planekey-working-source.json'),
    patches: path.join(root, 'patches'),
    patchesPending: path.join(root, 'patches', 'pending'),
    patchesApplied: path.join(root, 'patches', 'applied'),
    patchesRejected: path.join(root, 'patches', 'rejected'),
    patchesSuperseded: path.join(root, 'patches', 'superseded'),
    bundles: path.join(root, 'bundles'),
    bundlesOutgoing: path.join(root, 'bundles', 'outgoing'),
    bundlesAccepted: path.join(root, 'bundles', 'accepted'),
    bundlesRejected: path.join(root, 'bundles', 'rejected'),
    reports: path.join(root, 'reports'),
    compareReports: path.join(root, 'reports', 'compare_reports'),
    deployReports: path.join(root, 'reports', 'deploy_readiness'),
    serverReports: path.join(root, 'reports', 'server_verification'),
    rootRabbitReports: path.join(root, 'reports', 'rootrabbit'),
    safetyNetReports: path.join(root, 'reports', 'safetynet'),
    rebuildReports: path.join(root, 'reports', 'rebuild'),
    debugReports: path.join(root, 'reports', 'debug_action_maps'),
    exports: path.join(root, 'exports'),
    githubReady: path.join(root, 'exports', 'github-ready')
  };
}

async function ensureWorkspace(root) {
  const config = loadConfig(root);
  const p = paths(root, config);
  const dirs = [
    p.rawDownloads,
    p.originalZips,
    p.frozenSnapshots,
    p.inventory,
    p.working,
    p.patchesPending,
    p.patchesApplied,
    p.patchesRejected,
    p.patchesSuperseded,
    p.bundlesOutgoing,
    p.bundlesAccepted,
    p.bundlesRejected,
    p.compareReports,
    p.deployReports,
    p.serverReports,
    p.rootRabbitReports,
    p.safetyNetReports,
    p.rebuildReports,
    p.debugReports,
    p.exports
  ];
  for (const d of dirs) await fsp.mkdir(d, { recursive: true });
  if (!exists(p.configFile)) await writeJson(p.configFile, DEFAULT_CONFIG);
  if (!exists(p.snapshotsIndex)) await writeJson(p.snapshotsIndex, { created_at: nowIso(), snapshots: [] });
  if (!exists(p.sanitizedMap)) {
    await writeText(p.sanitizedMap, `# Sanitized vs Live Map\n\nGenerated: ${nowIso()}\n\n## Known sanitized snapshots\n\n- Add snapshots with \`pk-client import\`.\n\n## Known live-only / do not overwrite blindly\n\n- .env\n- node_modules/\n- planekey-history/\n- debug/\n- shell-snapshots/\n- uploads/\n- database/\n- sessions/\n- runtime logs\n- .planekey/rabbit/ runtime nap records\n- *.rabbit runtime zone records\n\n## Notes\n\nUse this as the manual truth map when comparing local sanitized exports against the live PlaneKey server.\n`);
  }
}

async function walkFiles(root, options = {}) {
  const skipPatterns = options.skipPatterns || [];
  const includeDirs = options.includeDirs || false;
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = relUnix(root, abs);
      if (matchesAny(rel, skipPatterns)) continue;
      if (entry.isDirectory()) {
        if (includeDirs) out.push({ abs, rel, type: 'dir' });
        await walk(abs);
      } else if (entry.isFile()) {
        out.push({ abs, rel, type: 'file' });
      }
    }
  }
  await walk(root);
  return out;
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function manifestForDir(dir, options = {}) {
  const files = await walkFiles(dir, { skipPatterns: options.skipPatterns || [] });
  const entries = [];
  let totalBytes = 0;
  for (const f of files) {
    const stat = await fsp.stat(f.abs);
    totalBytes += stat.size;
    entries.push({
      path: f.rel,
      size: stat.size,
      mtime_ms: Math.round(stat.mtimeMs),
      sha256: await sha256File(f.abs)
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    generated_at: nowIso(),
    root: dir,
    file_count: entries.length,
    total_bytes: totalBytes,
    files: entries
  };
}

async function copyRecursive(src, dest, options = {}) {
  const skipPatterns = options.skipPatterns || [];
  const srcStat = await fsp.stat(src);
  if (srcStat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(src, entry.name);
      const rel = relUnix(src, abs);
      if (matchesAny(rel, skipPatterns)) continue;
      await copyRecursive(abs, path.join(dest, entry.name), options);
    }
  } else if (srcStat.isFile()) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
}

async function emptyDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
}

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { stdio: options.stdio || 'pipe', encoding: 'utf8', cwd: options.cwd || undefined });
  return res;
}

async function extractZip(zipFile, dest) {
  await fsp.mkdir(dest, { recursive: true });
  if (process.platform === 'win32') {
    const ps = run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath ${JSON.stringify(zipFile)} -DestinationPath ${JSON.stringify(dest)} -Force`
    ]);
    if (ps.status !== 0) throw new Error(`Expand-Archive failed: ${ps.stderr || ps.stdout}`);
    return;
  }
  const unzip = run('unzip', ['-q', zipFile, '-d', dest]);
  if (unzip.status !== 0) throw new Error(`unzip failed: ${unzip.stderr || unzip.stdout || 'unzip command unavailable'}`);
}

async function normalizedSourceDir(extractedDir) {
  const entries = (await fsp.readdir(extractedDir, { withFileTypes: true })).filter((e) => e.name !== '__MACOSX');
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractedDir, entries[0].name);
  }
  return extractedDir;
}

function loadSnapshotsIndex(root) {
  const p = paths(root);
  return readJsonIfExists(p.snapshotsIndex, { created_at: nowIso(), snapshots: [] });
}

async function saveSnapshotsIndex(root, index) {
  const p = paths(root);
  index.updated_at = nowIso();
  await writeJson(p.snapshotsIndex, index);
}

function findSnapshot(root, idOrName) {
  const index = loadSnapshotsIndex(root);
  const needle = String(idOrName || '').toLowerCase();
  const found = index.snapshots.find((s) =>
    String(s.id).toLowerCase() === needle ||
    String(s.name || '').toLowerCase() === needle ||
    String(s.id).toLowerCase().includes(needle)
  );
  if (!found) return null;
  return found;
}

async function commandInit(rootArg) {
  const root = path.resolve(rootArg || process.cwd());
  await ensureWorkspace(root);
  console.log(`PlaneKey Client workspace initialized: ${root}`);
  console.log('Next: pk-client import <folder-or-zip> --name <label>');
}

// Snapshot skip patterns. `.git`/`node_modules` (never useful in a snapshot),
// `target` (multi-GB Rust build output — used to time out the import), `vault`
// (pkclient's own raw-download store — would recurse into prior snapshots), and
// `todoReview` (staging copies like the rescued docs — excluded so a snapshot
// can reverse-search their content against the REAL tree, not their own copy).
const SNAPSHOT_SKIP = ['.git/**', 'node_modules/**', 'target/**', 'vault/**', 'todoReview/**'];

async function commandImport(root, source, flags) {
  if (!source) throw new Error('Missing source path. Usage: pk-client import <folder-or-zip> [--name label]');
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const absSource = path.resolve(source);
  if (!exists(absSource)) throw new Error(`Source does not exist: ${absSource}`);

  const sourceBase = path.basename(absSource).replace(/\.[^.]+$/, '');
  const name = flags.name ? slugify(flags.name) : slugify(sourceBase);
  const id = `${safeDateStamp()}_${config.snapshotPrefix}_${name}`;
  const snapshotRoot = path.join(p.rawDownloads, id);
  const sourceDest = path.join(snapshotRoot, 'source');
  const metaFile = path.join(snapshotRoot, 'snapshot.meta.json');
  await fsp.mkdir(snapshotRoot, { recursive: true });

  const sourceStat = await fsp.stat(absSource);
  let importType = sourceStat.isDirectory() ? 'folder' : 'file';
  let originalZipCopy = null;

  if (sourceStat.isFile() && absSource.toLowerCase().endsWith('.zip')) {
    importType = 'zip';
    originalZipCopy = path.join(p.originalZips, `${id}.zip`);
    await fsp.copyFile(absSource, originalZipCopy);
    const extractTmp = path.join(snapshotRoot, '_extract_tmp');
    await extractZip(absSource, extractTmp);
    const normalized = await normalizedSourceDir(extractTmp);
    await copyRecursive(normalized, sourceDest);
    await fsp.rm(extractTmp, { recursive: true, force: true });
  } else if (sourceStat.isDirectory()) {
    await copyRecursive(absSource, sourceDest, { skipPatterns: SNAPSHOT_SKIP });
  } else {
    await fsp.mkdir(sourceDest, { recursive: true });
    await fsp.copyFile(absSource, path.join(sourceDest, path.basename(absSource)));
  }

  const manifest = await manifestForDir(sourceDest, { skipPatterns: SNAPSHOT_SKIP });
  const meta = {
    id,
    name,
    project: config.project,
    imported_at: nowIso(),
    source_path: absSource,
    import_type: importType,
    original_zip_copy: originalZipCopy,
    source_dir: sourceDest,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes
  };
  await writeJson(metaFile, meta);
  await writeJson(path.join(snapshotRoot, 'manifest.json'), manifest);
  await writeText(path.join(snapshotRoot, 'SOURCE_NOTE.md'), `# Source Note\n\nSnapshot: ${id}\nImported: ${meta.imported_at}\nSource: ${absSource}\nType: ${importType}\n\nDo not edit files in this snapshot. Use \`pk-client set-working ${id}\` to create an editable working tree.\n`);

  const index = loadSnapshotsIndex(root);
  index.snapshots = index.snapshots.filter((s) => s.id !== id);
  index.snapshots.push(meta);
  await saveSnapshotsIndex(root, index);

  console.log(`Imported snapshot: ${id}`);
  console.log(`Files: ${manifest.file_count}`);
  console.log(`Bytes: ${manifest.total_bytes}`);
}

async function commandList(root) {
  await ensureWorkspace(root);
  const index = loadSnapshotsIndex(root);
  if (!index.snapshots.length) {
    console.log('No snapshots imported yet.');
    return;
  }
  console.log('Snapshots:');
  for (const s of index.snapshots) {
    console.log(`- ${s.id}`);
    console.log(`  name: ${s.name}`);
    console.log(`  files: ${s.file_count || 0}`);
    console.log(`  source: ${s.source_path}`);
  }
}

async function commandInventory(root) {
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const index = loadSnapshotsIndex(root);
  const snapshots = [];
  const hashMap = new Map();

  for (const s of index.snapshots) {
    const sourceDir = s.source_dir || path.join(p.rawDownloads, s.id, 'source');
    if (!isDir(sourceDir)) continue;
    const manifest = await manifestForDir(sourceDir, { skipPatterns: ['.git/**', 'node_modules/**'] });
    await writeJson(path.join(p.rawDownloads, s.id, 'manifest.json'), manifest);
    snapshots.push({ ...s, manifest });
    for (const f of manifest.files) {
      const arr = hashMap.get(f.sha256) || [];
      arr.push({ snapshot_id: s.id, path: f.path, size: f.size });
      hashMap.set(f.sha256, arr);
    }
  }

  const duplicates = [];
  for (const [sha256, refs] of hashMap.entries()) {
    if (refs.length > 1) duplicates.push({ sha256, refs });
  }
  duplicates.sort((a, b) => b.refs.length - a.refs.length);

  const manifestOut = {
    generated_at: nowIso(),
    project: config.project,
    snapshot_count: snapshots.length,
    snapshots: snapshots.map((s) => ({
      id: s.id,
      name: s.name,
      imported_at: s.imported_at,
      source_path: s.source_path,
      file_count: s.manifest.file_count,
      total_bytes: s.manifest.total_bytes
    }))
  };

  await writeJson(p.fileManifest, manifestOut);
  await writeJson(path.join(p.inventory, 'duplicates.json'), { generated_at: nowIso(), duplicate_hashes: duplicates });

  const csv = ['snapshot_id,name,imported_at,file_count,total_bytes,source_path'];
  for (const s of manifestOut.snapshots) {
    csv.push([s.id, s.name, s.imported_at, s.file_count, s.total_bytes, s.source_path]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  }
  await writeText(p.folderIndex, csv.join('\n') + '\n');

  let md = `# Duplicate Report\n\nGenerated: ${nowIso()}\n\nDuplicate SHA groups: ${duplicates.length}\n\n`;
  for (const group of duplicates.slice(0, 100)) {
    md += `## ${group.sha256}\n\n`;
    for (const ref of group.refs.slice(0, 30)) {
      md += `- ${ref.snapshot_id}: \`${ref.path}\` (${ref.size} bytes)\n`;
    }
    if (group.refs.length > 30) md += `- ... ${group.refs.length - 30} more\n`;
    md += '\n';
  }
  await writeText(p.duplicateReport, md);

  console.log(`Inventory written: ${p.fileManifest}`);
  console.log(`Folder index written: ${p.folderIndex}`);
  console.log(`Duplicate report written: ${p.duplicateReport}`);
}

function manifestMap(manifest) {
  const m = new Map();
  for (const f of manifest.files || []) m.set(f.path, f);
  return m;
}

function diffManifests(a, b) {
  const ma = manifestMap(a);
  const mb = manifestMap(b);
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  const all = new Set([...ma.keys(), ...mb.keys()]);
  for (const k of [...all].sort()) {
    const fa = ma.get(k);
    const fb = mb.get(k);
    if (!fa && fb) added.push(fb);
    else if (fa && !fb) removed.push(fa);
    else if (fa.sha256 !== fb.sha256 || fa.size !== fb.size) changed.push({ before: fa, after: fb });
    else unchanged.push(fb);
  }
  return { added, removed, changed, unchanged };
}

async function loadSnapshotManifest(root, idOrName) {
  const snap = findSnapshot(root, idOrName);
  if (!snap) throw new Error(`Snapshot not found: ${idOrName}`);
  const config = loadConfig(root);
  const p = paths(root, config);
  const manifestFile = path.join(p.rawDownloads, snap.id, 'manifest.json');
  let manifest = readJsonIfExists(manifestFile, null);
  if (!manifest) {
    const sourceDir = snap.source_dir || path.join(p.rawDownloads, snap.id, 'source');
    manifest = await manifestForDir(sourceDir, { skipPatterns: ['.git/**', 'node_modules/**'] });
    await writeJson(manifestFile, manifest);
  }
  return { snap, manifest };
}


function readTextIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

function nodeSyntaxCheck(file) {
  if (!isFile(file)) return { ok: false, skipped: true, error: 'file not found' };
  const res = run(process.execPath, ['--check', file]);
  return {
    ok: res.status === 0,
    skipped: false,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.status === 0 ? null : String(res.stderr || res.stdout || 'node --check failed').trim()
  };
}

function parseRootRabbitZones(serverJsText) {
  const zones = [];
  const zoneRegex = /zone_id\s*:\s*['"]([^'"]+)['"][\s\S]*?target\s*:\s*['"]([^'"]+)['"][\s\S]*?risk\s*:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = zoneRegex.exec(serverJsText)) !== null) {
    zones.push({ zone_id: m[1], target: m[2], risk: m[3] });
  }
  if (!zones.length) {
    const loose = /zone_id\s*:\s*['"]([^'"]+)['"]/g;
    while ((m = loose.exec(serverJsText)) !== null) zones.push({ zone_id: m[1], target: null, risk: null });
  }
  const seen = new Set();
  return zones.filter((z) => {
    if (seen.has(z.zone_id)) return false;
    seen.add(z.zone_id);
    return true;
  });
}

function rootRabbitMarkdown(report) {
  const lines = [];
  lines.push('# RootRabbit Client Preflight', '');
  lines.push('Generated: ' + report.generated_at);
  lines.push('Target: `' + report.target_dir + '`');
  if (report.edition) lines.push('Server-core edition: **' + report.edition + '**');
  lines.push('Status: **' + report.status.toUpperCase() + '**');
  lines.push('Installed: ' + (report.installed ? 'yes' : 'no'));
  lines.push('Partial install: ' + (report.partial_install ? 'yes' : 'no'));
  lines.push('Safe for bundle: ' + (report.safe_for_bundle ? 'yes' : 'NO'));
  lines.push('');
  lines.push('## Findings', '');
  lines.push('- RootRabbit source: ' + (report.findings.root_source ? 'present' : 'missing'));
  lines.push('- Server require: ' + (report.findings.server_require ? 'present' : 'missing'));
  lines.push('- Zone definitions: ' + report.findings.zone_count);
  lines.push('- RootRabbit instance: ' + (report.findings.root_instance ? 'present' : 'missing'));
  lines.push('- Admin API routes: ' + report.findings.admin_api_routes_present + '/' + report.findings.admin_api_routes_expected);
  lines.push('- Admin UI hooks: ' + report.findings.admin_ui_hooks_present + '/' + report.findings.admin_ui_hooks_expected);
  lines.push('- Runtime rabbit files included: ' + report.findings.runtime_hits.length);
  lines.push('- Sanitized broken literals: ' + report.findings.sanitized_literal_hits.length);
  lines.push('');
  if (report.zones.length) {
    lines.push('## Zones', '');
    report.zones.forEach((z) => lines.push('- `' + z.zone_id + '` → `' + (z.target || 'unknown') + '`' + (z.risk ? ' (' + z.risk + ')' : '')));
    lines.push('');
  }
  if (report.changed_paths && report.changed_paths.length) {
    lines.push('## Changed Paths Under Review', '');
    report.changed_paths.forEach((x) => lines.push('- `' + x + '`'));
    lines.push('');
  }
  if (report.impact_hits && report.impact_hits.length) {
    lines.push('## RootRabbit Impact Hits', '');
    report.impact_hits.forEach((x) => lines.push('- `' + x + '`'));
    lines.push('');
  }
  if (report.blocking.length) {
    lines.push('## Blocking Issues', '');
    report.blocking.forEach((x) => lines.push('- ' + x));
    lines.push('');
  }
  if (report.warnings.length) {
    lines.push('## Warnings', '');
    report.warnings.forEach((x) => lines.push('- ' + x));
    lines.push('');
  }
  lines.push('## Safety Model', '');
  lines.push('RootRabbit is treated as a local package-safety canary. The client never copies `.planekey/rabbit/` nap records or `*.rabbit` runtime files into deploy bundles. If Rabbit wiring is partially present or broken, the bundle is marked unsafe until reviewed.');
  return lines.join('\n') + '\n';
}

function rootRabbitPreflight(targetDir, config, options = {}) {
  const changedPaths = (options.changedPaths || []).map(normalizePattern).sort();
  const requireInstalled = !!options.requireInstalled;
  const rrCfg = config.rootRabbit || DEFAULT_CONFIG.rootRabbit;
  const blocking = [];
  const warnings = [];
  const serverJsPath = path.join(targetDir, 'server.js');
  const rootSourcePath = path.join(targetDir, 'server', 'security', 'root-rabbit.js');
  const adminPath = path.join(targetDir, 'admin', 'planekey.html');
  const serverText = readTextIfExists(serverJsPath);
  const adminText = readTextIfExists(adminPath);

  const serverExists = isFile(serverJsPath);
  const adminExists = isFile(adminPath);

  // ── server-core edition detection ───────────────────────────────────
  // server-core ships in two editions that provide the SAME RootRabbit
  // capability in different languages:
  //   node — server.js + server/security/root-rabbit.js (the original)
  //   rust — Cargo.toml + src/main.rs, RootRabbit wired via
  //          src/rootrabbit_classifier.rs + actix `.service(rootrabbit_*)`
  //          routes, naps persisted to the rootrabbit_observations table.
  // The validator was Node-only and FAILED the Rust edition on a missing
  // server.js even though RootRabbit was fully wired. Detect the edition
  // and validate the real equivalents instead of demanding Node.
  const cargoPath = path.join(targetDir, 'Cargo.toml');
  const mainRsPath = path.join(targetDir, 'src', 'main.rs');
  const rustEdition = !serverExists && isFile(cargoPath) && isFile(mainRsPath);
  const edition = serverExists ? 'node' : (rustEdition ? 'rust' : 'none');

  // Rust signals: concatenate src/*.rs so route/admin needles registered
  // across handler modules are visible (the Node path reads only server.js).
  let rustSrcText = '';
  if (edition === 'rust') {
    try {
      const srcDir = path.join(targetDir, 'src');
      for (const f of fs.readdirSync(srcDir)) {
        if (f.endsWith('.rs')) rustSrcText += '\n' + readTextIfExists(path.join(srcDir, f));
      }
    } catch (_) {}
  }
  const isRust = edition === 'rust';

  // ── edition-aware RootRabbit signals ────────────────────────────────
  const rootSource = isRust
    ? isFile(path.join(targetDir, 'src', 'rootrabbit_classifier.rs'))
    : isFile(rootSourcePath);
  const serverRequire = isRust
    ? (/\.service\(\s*rootrabbit/.test(rustSrcText) || /rootrabbit_classifier/.test(rustSrcText))
    : (/require\(['"]\.\/server\/security\/root-rabbit['"]\)/.test(serverText) || /RootRabbit/.test(serverText));
  const zones = isRust
    // v0.3.0 gateway consolidation versioned the bridge surface under /v1/*,
    // so a RootRabbit self-health zone is now "/v1/rootrabbit/..." — accept
    // both the legacy bare prefix and the versioned one.
    ? [...new Set(rustSrcText.match(/"\/(?:v1\/)?rootrabbit\/[a-z0-9/{}_-]*"/gi) || [])]
        .map((z) => ({ zone_id: z.replace(/"/g, ''), target: 'actix-route' }))
    : parseRootRabbitZones(serverText);
  const rootInstance = isRust
    ? /\.service\(\s*rootrabbit/.test(rustSrcText)
    : /new\s+RootRabbit\s*\(/.test(serverText);
  const usesPlanekeyRabbitDir = isRust
    ? /rootrabbit_observations/.test(rustSrcText)   // Rust persists naps to the DB, not .planekey/rabbit/
    : (/\.planekey\/rabbit/.test(serverText) || /\.planekey\\\/rabbit/.test(serverText));
  const adminApiNeedles = isRust
    ? ['/api/admin/planekey/verify', '/api/admin/planekey/snapshot', '/api/admin/planekey/scan', '/api/admin/planekey/apply']
    : ['/api/admin/planekey/rabbit', '/api/admin/planekey/rabbit/enabled', '/api/admin/planekey/rabbit/pulse', '/api/admin/planekey/rabbit/recovery'];
  const adminApiHaystack = isRust ? rustSrcText : serverText;
  const adminApiPresent = adminApiNeedles.filter((x) => adminApiHaystack.includes(x));
  const adminUiNeedles = [
    'data-planekey-tab="rabbit"',
    'loadRabbitStatus',
    'toggleRabbit',
    'pulseRabbit'
  ];
  const adminUiPresent = adminUiNeedles.filter((x) => adminText.includes(x));
  const runtimeHits = changedPaths.filter((rel) => matchesAny(rel, rrCfg.runtimeForbiddenPaths || []));
  const impactHits = changedPaths.filter((rel) => matchesAny(rel, rrCfg.sensitivePaths || []));
  const sanitizedLiteralHits = [];
  // REDACTED-placeholder logic is a JS-sanitizer concern; scan the JS/HTML
  // surfaces (Rust has no equivalent broken-literal failure mode).
  const sanitizedRegex = /typeof\s+[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)?\s*(?:!==|===|!=|==)\s*['"]REDACTED['"]/g;
  for (const [label, text] of [['server.js', serverText], ['admin/planekey.html', adminText]]) {
    let m;
    while ((m = sanitizedRegex.exec(text)) !== null) sanitizedLiteralHits.push({ file: label, match: m[0] });
  }

  const anyRabbitSignal = rootSource || serverRequire || rootInstance || zones.length > 0 || adminApiPresent.length > 0 || adminUiPresent.length > 0;
  const installed = rootSource && serverRequire && rootInstance && zones.length >= (rrCfg.minimumZonesWhenInstalled || 1) && adminApiPresent.length === adminApiNeedles.length;
  const partialInstall = anyRabbitSignal && !installed;

  if (edition === 'none') blocking.push('No recognizable server-core: need server.js (Node edition) or Cargo.toml + src/main.rs (Rust edition); cannot validate route/package safety.');
  if (runtimeHits.length) blocking.push('Bundle/change set includes RootRabbit runtime nap files; `.planekey/rabbit/**` and `*.rabbit` must stay live/local only.');
  if (sanitizedLiteralHits.length) blocking.push('Sanitized source placeholder logic found (`REDACTED` comparison literals). This is not a secret leak; it is broken sanitized code that must be repaired or live-verified before deploy.');

  if (requireInstalled && !installed) blocking.push('RootRabbit was required by command/config but is not fully installed.');
  if (partialInstall) blocking.push('RootRabbit is partially wired. Finish or remove the partial wiring before bundling.');
  // Node syntax checks apply to the Node edition only; the client can't
  // cheaply run `cargo check` on the Rust edition, so it validates wiring
  // by signal presence instead (cargo check is the bridge crate's own CI).
  if (edition === 'node') {
    if (rootSource) {
      const syntax = nodeSyntaxCheck(rootSourcePath);
      if (!syntax.ok) blocking.push('server/security/root-rabbit.js failed Node syntax check: ' + syntax.error);
    }
    if (serverExists) {
      const serverSyntax = nodeSyntaxCheck(serverJsPath);
      if (!serverSyntax.ok) blocking.push('server.js failed Node syntax check: ' + serverSyntax.error);
    }
  }
  if (edition === 'rust') warnings.push('Rust server-core edition: RootRabbit wiring validated by signal presence; `cargo check` is the bridge crate CI, not run by this client.');
  if (rootSource && !usesPlanekeyRabbitDir && edition === 'node') warnings.push('RootRabbit source exists but server.js does not clearly reference `.planekey/rabbit` runtime storage.');
  if (!anyRabbitSignal) warnings.push('RootRabbit is not installed in this target. Package can still be organized, but Rabbit route-canary coverage is unavailable.');
  if (impactHits.length && !installed) warnings.push('Changed paths touch RootRabbit-sensitive areas, but RootRabbit is not fully installed to validate route-canary coverage.');
  if (adminExists && anyRabbitSignal && adminUiPresent.length < adminUiNeedles.length) warnings.push('Admin UI appears to be missing some RabbitRoot controls.');

  const status = blocking.length ? 'fail' : (warnings.length ? 'warn' : 'pass');
  const safeForBundle = blocking.length === 0;
  return {
    generated_at: nowIso(),
    target_dir: targetDir,
    edition,
    status,
    safe_for_bundle: safeForBundle,
    installed,
    partial_install: partialInstall,
    changed_paths: changedPaths,
    impact_hits: impactHits,
    blocking,
    warnings,
    zones,
    findings: {
      root_source: rootSource,
      server_exists: serverExists,
      server_require: serverRequire,
      root_instance: rootInstance,
      uses_planekey_rabbit_dir: usesPlanekeyRabbitDir,
      zone_count: zones.length,
      admin_api_routes_expected: adminApiNeedles.length,
      admin_api_routes_present: adminApiPresent.length,
      missing_admin_api_routes: adminApiNeedles.filter((x) => !adminApiPresent.includes(x)),
      admin_ui_hooks_expected: adminUiNeedles.length,
      admin_ui_hooks_present: adminUiPresent.length,
      missing_admin_ui_hooks: adminUiNeedles.filter((x) => !adminUiPresent.includes(x)),
      runtime_hits: runtimeHits,
      sanitized_literal_hits: sanitizedLiteralHits
    }
  };
}

async function resolveTargetDir(root, target, config) {
  const p = paths(root, config);
  if (!target) {
    if (isDir(p.workingTree)) return { dir: p.workingTree, label: 'working-tree' };
    throw new Error('No target provided and working tree does not exist. Use rootrabbit scan <folder-or-snapshot>.');
  }
  const asPath = path.resolve(target);
  if (isDir(asPath)) return { dir: asPath, label: asPath };
  const snap = findSnapshot(root, target);
  if (snap) return { dir: snap.source_dir || path.join(p.rawDownloads, snap.id, 'source'), label: snap.id };
  throw new Error('Target is not a folder or known snapshot: ' + target);
}

async function commandRootRabbitScan(root, target, flags) {
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const resolved = await resolveTargetDir(root, target, config);
  const report = rootRabbitPreflight(resolved.dir, config, { requireInstalled: !!flags.require });
  const name = flags.name ? slugify(flags.name) : 'rootrabbit-' + safeDateStamp();
  const jsonFile = path.join(p.rootRabbitReports, name + '.json');
  const mdFile = path.join(p.rootRabbitReports, name + '.md');
  await writeJson(jsonFile, report);
  await writeText(mdFile, rootRabbitMarkdown(report));
  console.log('RootRabbit status: ' + report.status.toUpperCase());
  console.log('Installed: ' + (report.installed ? 'yes' : 'no') + ', Zones: ' + report.zones.length + ', Blocking: ' + report.blocking.length + ', Warnings: ' + report.warnings.length);
  console.log('Report written: ' + mdFile);
  if (report.blocking.length) {
    console.log('Blocking issues:');
    report.blocking.forEach((x) => console.log('- ' + x));
  }
}

function parseShaManifestFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const map = new Map();
  const rejected = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const m = line.match(/^([a-fA-F0-9]{64})\s+(.+)$/);
    if (!m) {
      rejected.push({ line: i + 1, text: line });
      return;
    }
    const rel = normalizePattern(m[2].trim());
    map.set(rel, m[1].toLowerCase());
  });
  return { file, map, rejected };
}

function compareShaMaps(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  const same = [];
  for (const [rel, beforeSha] of before.entries()) {
    if (!after.has(rel)) removed.push(rel);
    else if (after.get(rel) !== beforeSha) changed.push({ path: rel, before: beforeSha, after: after.get(rel) });
    else same.push(rel);
  }
  for (const [rel, afterSha] of after.entries()) {
    if (!before.has(rel)) added.push({ path: rel, sha256: afterSha });
  }
  added.sort((a, b) => a.path.localeCompare(b.path));
  removed.sort();
  changed.sort((a, b) => a.path.localeCompare(b.path));
  same.sort();
  return {
    counts: { same: same.length, changed: changed.length, added: added.length, removed: removed.length },
    same, changed, added, removed
  };
}

function shaCompareMarkdown(report) {
  const lines = [];
  lines.push('# PlaneKey SHA Compare Report', '');
  lines.push('Generated: ' + report.generated_at, '');
  lines.push('## Inputs', '');
  lines.push('- Before: ' + report.before.file);
  lines.push('- After: ' + report.after.file);
  lines.push('- Before hashes: ' + report.before.count);
  lines.push('- After hashes: ' + report.after.count);
  lines.push('');
  lines.push('## Summary', '');
  lines.push('- Same: ' + report.diff.counts.same);
  lines.push('- Changed: ' + report.diff.counts.changed);
  lines.push('- Added: ' + report.diff.counts.added);
  lines.push('- Removed: ' + report.diff.counts.removed);
  lines.push('');
  lines.push('## Changed', '');
  if (report.diff.changed.length) {
    for (const x of report.diff.changed) {
      lines.push('- ' + x.path);
      lines.push('  - before: ' + x.before);
      lines.push('  - after: ' + x.after);
    }
  } else lines.push('None.');
  lines.push('', '## Added', '');
  if (report.diff.added.length) report.diff.added.forEach((x) => lines.push('- ' + x.path + ' — ' + x.sha256));
  else lines.push('None.');
  lines.push('', '## Removed', '');
  if (report.diff.removed.length) report.diff.removed.forEach((x) => lines.push('- ' + x));
  else lines.push('None.');
  if (report.before.rejected.length || report.after.rejected.length) {
    lines.push('', '## Rejected input lines', '');
    if (report.before.rejected.length) lines.push('- Before rejected lines: ' + report.before.rejected.length);
    if (report.after.rejected.length) lines.push('- After rejected lines: ' + report.after.rejected.length);
  }
  return lines.join('\n') + '\n';
}

function loadToolModule(scriptPath) {
  try {
    const resolved = require.resolve(scriptPath);
    delete require.cache[resolved];
    return { module: require(resolved), error: null };
  } catch (err) {
    return { error: err.message, module: null };
  }
}

function resolveSafetyTool(targetDir, config, toolName) {
  const sn = config.safetyNet || DEFAULT_CONFIG.safetyNet;
  const scriptName = toolName === 'hutch' ? sn.hutchScript : sn.flightScript;
  const projectTool = path.join(targetDir, 'tools', scriptName);
  const bundledTool = path.join(CLIENT_ROOT, sn.bundledToolsDir || 'tools', scriptName);
  if (sn.preferProjectTools && isFile(projectTool)) return { source: 'project', path: projectTool };
  if (isFile(bundledTool)) return { source: 'client-bundled', path: bundledTool };
  if (isFile(projectTool)) return { source: 'project', path: projectTool };
  return { source: 'missing', path: null };
}

function runWithCwd(cwd, fn) {
  const oldCwd = process.cwd();
  try {
    process.chdir(cwd);
    return fn();
  } finally {
    process.chdir(oldCwd);
  }
}

function hutchPreflight(targetDir, config) {
  const sn = config.safetyNet || DEFAULT_CONFIG.safetyNet;
  const tool = resolveSafetyTool(targetDir, config, 'hutch');
  const blocking = [];
  const warnings = [];
  let report = null;
  if (!sn.hutchEnabled) {
    return { generated_at: nowIso(), target_dir: targetDir, enabled: false, tool, status: 'skipped', safe_for_bundle: true, blocking, warnings, report };
  }
  // Detect the bridge-talker entry point via the shared lib/detect
  // module — single source of truth for project topology, consumed
  // by Hutch, Flight, `pk-client detect`, the action.yml metrics
  // step. See pk-client-npm/lib/detect.js for the candidate list
  // and detection priority.
  const detect = (() => {
    try { return require('../lib/detect.js'); } catch { return null; }
  })();
  let entry, entryKind;
  if (detect) {
    const result = detect.detectProject(targetDir);
    if (result.kind === 'unknown' || !result.entryPoint) {
      blocking.push('Hutch cannot run — pk-tools/detect found no bridge-talker entry point. Tried: '
        + (result.candidatesTried || []).join(', '));
      return { generated_at: nowIso(), target_dir: targetDir, enabled: true, tool, status: 'fail', safe_for_bundle: false, blocking, warnings, report };
    }
    entry = { file: result.entryPoint, kind: result.kind };
    entryKind = result.kind;
  } else {
    blocking.push('Hutch cannot run — pk-tools/detect module missing (expected pk-client-npm/lib/detect.js).');
    return { generated_at: nowIso(), target_dir: targetDir, enabled: true, tool, status: 'fail', safe_for_bundle: false, blocking, warnings, report };
  }
  const serverFile = path.join(targetDir, entry.file);
  if (!tool.path) {
    warnings.push('Hutch tool not found in project tools/ or bundled client tools/.');
    return { generated_at: nowIso(), target_dir: targetDir, enabled: true, tool, status: 'warn', safe_for_bundle: true, blocking, warnings, report };
  }
  const loaded = loadToolModule(tool.path);
  if (!loaded.module || typeof loaded.module.run !== 'function') {
    blocking.push('Hutch tool failed to load: ' + (loaded.error || 'missing run() export'));
    return { generated_at: nowIso(), target_dir: targetDir, enabled: true, tool, status: 'fail', safe_for_bundle: false, blocking, warnings, report };
  }
  try {
    report = runWithCwd(targetDir, () => loaded.module.run(entry.file, entryKind));
    const score = Number(report && report.score || 0);
    const failures = Number(report && report.summary && report.summary.failures || 0);
    if (score < Number(sn.minimumHutchScore || 0.85)) blocking.push('Hutch score below threshold: ' + score + ' < ' + Number(sn.minimumHutchScore || 0.85));
    if (sn.failOnHutchFailures && failures > 0) blocking.push('Hutch found ' + failures + ' failing runtime/config checks.');
    const status = blocking.length ? 'fail' : ((report && report.status === 'HEALTHY') ? 'pass' : 'warn');
    return { generated_at: nowIso(), target_dir: targetDir, enabled: true, tool, status, safe_for_bundle: blocking.length === 0, blocking, warnings, report };
  } catch (err) {
    blocking.push('Hutch execution failed: ' + err.message);
    return { generated_at: nowIso(), target_dir: targetDir, enabled: true, tool, status: 'fail', safe_for_bundle: false, blocking, warnings, report };
  }
}

function flightPreflight(targetDir, config) {
  const sn = config.safetyNet || DEFAULT_CONFIG.safetyNet;
  const tool = resolveSafetyTool(targetDir, config, 'flight');
  const blocking = [];
  const warnings = [];
  let report = null;
  if (!sn.flightEnabled) {
    return { generated_at: nowIso(), target_dir: targetDir, enabled: false, tool, status: 'skipped', safe_for_bundle: true, blocking, warnings, report };
  }
  if (!tool.path) {
    warnings.push('Flight tool not found in project tools/ or bundled client tools/.');
    return { generated_at: nowIso(), target_dir: targetDir, enabled: true, tool, status: 'warn', safe_for_bundle: true, blocking, warnings, report };
  }
  const loaded = loadToolModule(tool.path);
  if (!loaded.module || typeof loaded.module.run !== 'function') {
    blocking.push('Flight tool failed to load: ' + (loaded.error || 'missing run() export'));
    return { generated_at: nowIso(), target_dir: targetDir, enabled: true, tool, status: 'fail', safe_for_bundle: false, blocking, warnings, report };
  }
  try {
    report = runWithCwd(targetDir, () => loaded.module.run([]));
    const score = Number(report && report.score || 0);
    if (score < Number(sn.minimumFlightScore || 0.85)) blocking.push('Flight score below threshold: ' + score + ' < ' + Number(sn.minimumFlightScore || 0.85));
    if (sn.failOnFlightTurbulence && report && report.status !== 'LANDED') blocking.push('Flight route graph status is ' + report.status + '.');
    const deadEnds = Number(report && report.summary && report.summary.dead_ends || 0);
    const cycles = Number(report && report.summary && report.summary.cycles_detected || 0);
    if (cycles > 0) blocking.push('Flight found ' + cycles + ' route/navigation cycle(s).');
    if (deadEnds > 0) warnings.push('Flight found ' + deadEnds + ' possible dead-end route reference(s).');
    const status = blocking.length ? 'fail' : ((report && report.status === 'LANDED') ? (warnings.length ? 'warn' : 'pass') : 'warn');
    return { generated_at: nowIso(), target_dir: targetDir, enabled: true, tool, status, safe_for_bundle: blocking.length === 0, blocking, warnings, report };
  } catch (err) {
    blocking.push('Flight execution failed: ' + err.message);
    return { generated_at: nowIso(), target_dir: targetDir, enabled: true, tool, status: 'fail', safe_for_bundle: false, blocking, warnings, report };
  }
}


function isAllowedEnvExample(rel, config) {
  const name = path.basename(rel).toLowerCase();
  const allowed = (config.publicRepo && config.publicRepo.allowedEnvExampleFiles) || [];
  return allowed.map((x) => String(x).toLowerCase()).includes(name);
}

function looksTextReadable(file, stat, config) {
  const max = (config.publicRepo && config.publicRepo.maxTextFileBytes) || (2 * 1024 * 1024);
  if (stat.size > max) return false;
  const ext = path.extname(file).toLowerCase();
  const binaryExts = new Set(['.png','.jpg','.jpeg','.gif','.webp','.ico','.woff','.woff2','.ttf','.eot','.mp4','.mp3','.wav','.pdf','.zip','.rar','.7z','.gz','.tar','.sqlite','.db']);
  if (binaryExts.has(ext)) return false;
  return true;
}

// Variable-name patterns that look like secret env vars by lexical accident
// but are actually code identifiers (regex captures, type names, in-memory
// caches). When the LHS matches one of these the value is never a credential
// — it's a Rust generic, a Python compiled regex, a Map handle, etc.
function isNonCredentialIdentifier(name) {
  const n = String(name || '');
  if (/^(?:RE_|RX_)/.test(n)) return true;
  if (/_PATTERN$/.test(n)) return true;
  if (/_CACHE$/.test(n)) return true;
  if (/_RE$/.test(n)) return true;
  if (/^TOKEN_(?:PATTERN|CACHE|REGEX|RE)$/.test(n)) return true;
  return false;
}

function isPlaceholderSecretValue(value, config) {
  // Strip leading/trailing quote chars AND markdown backticks (which leak from
  // code-fenced placeholder examples written inside docs/comments).
  const raw = String(value || '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
  const allowed = new Set(((config.publicRepo && config.publicRepo.allowPlaceholderValues) || []).map((x) => String(x).trim()));
  if (allowed.has(raw)) return true;
  // Single env var reference: $VAR, ${VAR}
  if (/^\$\{?[A-Z0-9_]+\}?$/i.test(raw)) return true;
  // Render / GitHub Actions / CDK template syntax: ${{ Var.Path }} (double-brace)
  // Accept partial captures too — assignmentRe stops at first `}` so what we
  // see is often `${{Postgres-A.DATABASE_PUBLIC_URL` with no closing braces.
  if (/^\$\{\{[^}]+\}\}$/.test(raw) || /\$\{\{[^}]+\}\}/.test(raw)) return true;
  if (/^\$\{\{/.test(raw)) return true;
  // JS/TS env reads
  if (/^(process\.env\.|import\.meta\.env\.|Deno\.env)/.test(raw)) return true;
  // Common placeholder prefixes
  if (/^(your-|example-|test-|dummy-|fake-|sample-|placeholder-|change-me)/i.test(raw)) return true;
  // Anything with "..." continuation
  if (/\.\.\./.test(raw)) return true;
  // Trivially-bogus DB URLs (localhost / example / username placeholders)
  if (/^(postgresql|postgres|mysql|redis|mongodb):\/\/(localhost|example|user|username|host|\.\.\.)/i.test(raw)) return true;
  // GCP Secret Manager references — `secret` + `name` + `:latest`, etc.
  // These are POINTERS to secrets in GCP; the actual secret value lives in GCP.
  // (Pattern fragmented to avoid matching this very source line in self-scan.)
  if (new RegExp('^[a-z0-9][a-z0-9-]{2,62}:(?:' + 'latest' + '|[0-9]+)$', 'i').test(raw)) return true;
  // Angle-bracket placeholders: <secret>, <auth/bridge>, <PASSWORD>, <YOUR_TOKEN>, etc.
  // Common in tutorial / handoff docs where the bracket marks "fill in your value here".
  // The closing `>` is sometimes truncated by the line-tail regex (e.g. captured
  // value is `<auth/bridge` without the `>`), so accept both forms.
  if (/^<[^>]+>?$/.test(raw)) return true;
  // RepoGuard's own sanitize-emitted replacement token, e.g.
  // REDACTED_ec0332e4b673c152 — see commandRepoGuardSanitize.
  if (/^REDACTED_[a-f0-9]{12,32}$/i.test(raw)) return true;
  // Literal uppercase placeholder words: PASSWORD, REDACTED, SECRET, TODO, TBD, FIXME, REPLACE_ME
  if (/^[A-Z_]{4,20}$/.test(raw)) return true;
  // Rust/TypeScript generic type identifiers like `Mutex<TokenCache>` —
  // these get caught by the `TOKEN_CACHE` shape match but aren't secret values.
  if (/^[A-Z][A-Za-z0-9_]*<[A-Z][A-Za-z0-9_]*>?$/.test(raw)) return true;
  // Vault / Doppler / SOPS style refs: `vault:path/to/secret`, `op://Vault/Item/field`
  if (/^(vault|op|sops|secretsmanager|asm|kms):\/?\S/i.test(raw)) return true;
  // Anything that's mostly punctuation / brackets (no actual entropy)
  if (raw.length < 8 || /^[a-z]+-[a-z]+(-[a-z]+)*$/i.test(raw)) return true;
  return false;
}

// Ignore archived / snapshot directories that aren't real source.
// Source-of-truth-as-TOML target — when pk-client ports to Rust / Python, this
// list moves to config/repoguard-rules.toml so all polyglot ports consume the
// same authoritative set. Until then, this JS array is the canon.
function isArchivePath(rel) {
  // Top-level archive folders (historical snapshots, not live source).
  if (/^(?:19|20|fullto20|Planekeyglobal|Planekeystarter|messy_uploads|flight-reports|Claude pk db|archive)\//.test(rel)) return true;
  if (/^(?:19|20)$/.test(rel)) return true;
  // Nested archive folders anywhere in tree.
  if (/\/(?:Planekeyglobal|Claude pk db|archive)\//.test(rel)) return true;
  // RepoGuard reports — scanning them re-flags the placeholders inside
  // prior scan output, creating a feedback loop. Reports are build artifacts.
  if (/^reports\/safetynet\//.test(rel)) return true;
  // Bridge .patch files vendored from older Render/Railway iterations.
  if (/^products\/bridge\/patches\//.test(rel)) return true;
  // Bridge upstream-reference dumps (rgano MCP sources etc.) — not our source.
  if (/^products\/bridge\/reference\//.test(rel)) return true;
  return false;
}

function scanTextForSecrets(text, rel, config) {
  const hits = [];
  const add = (kind, match, severity = 'block') => {
    const line = text.slice(0, Math.max(0, match.index || 0)).split(/\r?\n/).length;
    const sample = String(match[0] || '').slice(0, 120).replace(/\r?\n/g, ' ');
    hits.push({ file: rel, line, kind, severity, sample });
  };

  const explicitPatterns = [
    ['private-key-block', /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, 'block'],
    ['stripe-secret-key', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g, 'block'],
    ['stripe-webhook-secret', /\bwhsec_[A-Za-z0-9]{16,}\b/g, 'block'],
    ['openai-api-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g, 'block'],
    ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, 'block'],
    ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'block'],
    ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, 'block'],
    ['aws-access-key-id', /\bAKIA[0-9A-Z]{16}\b/g, 'block'],
    ['jwt-token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'block']
  ];
  for (const [kind, re, severity] of explicitPatterns) {
    let m;
    while ((m = re.exec(text)) !== null) add(kind, m, severity);
  }

  const envExample = isAllowedEnvExample(rel, config);
  const assignmentRe = /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASS|PRIVATE_KEY|API_KEY|DATABASE_URL|DB_URL|MONGO_URI|REDIS_URL|WEBHOOK_SECRET|CLIENT_SECRET)[A-Z0-9_]*)\b\s*[:=]\s*['"]?([^'"\r\n#;,} ]{12,})['"]?/g;
  let m;
  while (!envExample && (m = assignmentRe.exec(text)) !== null) {
    const value = m[2] || '';
    if (isNonCredentialIdentifier(m[1])) continue;
    if (!isPlaceholderSecretValue(value, config)) add('secret-assignment:' + m[1], m, 'block');
  }
  return hits;
}

async function publicRepoPreflight(targetDir, config) {
  const repoCfg = config.publicRepo || DEFAULT_CONFIG.publicRepo;
  const blocking = [];
  const warnings = [];
  const privateFileHits = [];
  const secretHits = [];
  const sanitizedSourceHits = [];
  if (repoCfg.enabled === false) {
    return { generated_at: nowIso(), target_dir: targetDir, enabled: false, status: 'skip', safe_for_public_repo: true, blocking, warnings, private_file_hits: [], secret_hits: [], sanitized_source_hits: [] };
  }
  const files = await walkFiles(targetDir, { skipPatterns: ['node_modules/**', '.git/**'] });
  const sanitizedRegex = /typeof\s+[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)?\s*(?:!==|===|!=|==)\s*['"]REDACTED['"]/g;
  for (const f of files) {
    const rel = normalizePattern(f.rel);
    // Skip archive / snapshot directories entirely — they aren't live source
    // and they carry historical placeholder strings that flag false positives.
    if (isArchivePath(rel)) continue;
    if (matchesAny(rel, repoCfg.privateFilePatterns || []) && !isAllowedEnvExample(rel, config)) {
      privateFileHits.push(rel);
    }
    let stat;
    try { stat = await fsp.stat(f.abs); } catch (_) { continue; }
    if (!looksTextReadable(f.abs, stat, config)) continue;
    let text = '';
    try { text = await fsp.readFile(f.abs, 'utf8'); } catch (_) { continue; }
    secretHits.push(...scanTextForSecrets(text, rel, config));
    let m;
    while ((m = sanitizedRegex.exec(text)) !== null) {
      const line = text.slice(0, Math.max(0, m.index || 0)).split(/\r?\n/).length;
      sanitizedSourceHits.push({ file: rel, line, sample: m[0] });
    }
  }
  if (privateFileHits.length) blocking.push('Private/runtime files are present in the public repo candidate: ' + privateFileHits.join(', '));
  if (secretHits.length && repoCfg.failOnSecretHits !== false) blocking.push('Possible real secret values detected in source/config. Replace with environment references or .env.example placeholders before committing.');
  if (sanitizedSourceHits.length) warnings.push('Sanitized `REDACTED` placeholder logic detected. This is not a secret leak, but it is deploy-unsafe source that should be repaired or live-verified.');
  const status = blocking.length ? 'fail' : (warnings.length ? 'warn' : 'pass');
  return {
    generated_at: nowIso(),
    target_dir: targetDir,
    enabled: true,
    status,
    safe_for_public_repo: blocking.length === 0,
    blocking,
    warnings,
    private_file_hits: privateFileHits,
    secret_hits: secretHits,
    sanitized_source_hits: sanitizedSourceHits
  };
}

function publicRepoMarkdown(report) {
  const lines = [];
  lines.push('# PlaneKey Public RepoGuard Report', '');
  lines.push('Generated: ' + report.generated_at);
  lines.push('Target: `' + report.target_dir + '`');
  lines.push('Status: **' + report.status.toUpperCase() + '**');
  lines.push('Safe for public repo: ' + (report.safe_for_public_repo ? 'yes' : 'NO'));
  lines.push('');
  lines.push('## Rule', '');
  lines.push('Public repos get templates and environment variable names, never real runtime secrets. `.env.example` is allowed; `.env`, private keys, databases, runtime nap records, and credential-bearing files are blocked.');
  lines.push('');
  if (report.blocking.length) {
    lines.push('## Blocking Issues', '');
    report.blocking.forEach((x) => lines.push('- ' + x));
    lines.push('');
  }
  if (report.warnings.length) {
    lines.push('## Warnings', '');
    report.warnings.forEach((x) => lines.push('- ' + x));
    lines.push('');
  }
  if (report.private_file_hits.length) {
    lines.push('## Private File Hits', '');
    report.private_file_hits.forEach((x) => lines.push('- `' + x + '`'));
    lines.push('');
  }
  if (report.secret_hits.length) {
    lines.push('## Possible Secret Hits', '');
    report.secret_hits.forEach((x) => lines.push('- `' + x.file + ':' + x.line + '` ' + x.kind + ' — `' + x.sample.replace(/`/g, '\\`') + '`'));
    lines.push('');
  }
  if (report.sanitized_source_hits.length) {
    lines.push('## Sanitized Source Placeholders', '');
    lines.push('These are not secrets. They are broken sanitized source logic and should not be deployed as-is.');
    report.sanitized_source_hits.forEach((x) => lines.push('- `' + x.file + ':' + x.line + '` `' + x.sample.replace(/`/g, '\\`') + '`'));
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function safetyNetMarkdown(report) {
  const lines = [];
  lines.push('# PlaneKey SafetyNet Report', '');
  lines.push('Generated: ' + report.generated_at);
  lines.push('Target: `' + report.target_dir + '`');
  lines.push('Status: **' + report.status.toUpperCase() + '**');
  lines.push('Safe for bundle: ' + (report.safe_for_bundle ? 'yes' : 'NO'));
  lines.push('');
  lines.push('## Summary', '');
  lines.push('| Check | Status | Blocking | Warnings |');
  lines.push('|---|---:|---:|---:|');
  lines.push('| RootRabbit | ' + report.rootrabbit.status + ' | ' + report.rootrabbit.blocking.length + ' | ' + report.rootrabbit.warnings.length + ' |');
  lines.push('| Hutch | ' + report.hutch.status + ' | ' + report.hutch.blocking.length + ' | ' + report.hutch.warnings.length + ' |');
  lines.push('| Flight | ' + report.flight.status + ' | ' + report.flight.blocking.length + ' | ' + report.flight.warnings.length + ' |');
  lines.push('');
  if (report.blocking.length) {
    lines.push('## Blocking Issues', '');
    report.blocking.forEach((x) => lines.push('- ' + x));
    lines.push('');
  }
  if (report.warnings.length) {
    lines.push('## Warnings', '');
    report.warnings.forEach((x) => lines.push('- ' + x));
    lines.push('');
  }
  if (report.hutch.report) {
    lines.push('## Hutch Runtime/Package Check', '');
    lines.push('- Tool source: `' + report.hutch.tool.source + '`');
    lines.push('- Score: ' + report.hutch.report.score);
    lines.push('- Status: ' + report.hutch.report.status);
    lines.push('- Failures: ' + report.hutch.report.summary.failures);
    lines.push('- Warnings: ' + report.hutch.report.summary.warnings);
    lines.push('');
  }
  if (report.flight.report) {
    lines.push('## Flight Route Graph Check', '');
    lines.push('- Tool source: `' + report.flight.tool.source + '`');
    lines.push('- Score: ' + report.flight.report.score);
    lines.push('- Status: ' + report.flight.report.status);
    lines.push('- Routes: ' + report.flight.report.summary.routes_found);
    lines.push('- Navigation edges: ' + report.flight.report.summary.navigation_edges);
    lines.push('- Cycles: ' + report.flight.report.summary.cycles_detected);
    lines.push('- Dead ends: ' + report.flight.report.summary.dead_ends);
    lines.push('');
  }
  lines.push('## Interpretation', '');
  lines.push('RootRabbit is the live canary/nap route guardian. Hutch is the runtime/package checker. Flight is the route/navigation edge detector. SafetyNet combines all three so a bundle can be organized locally without becoming a route-breaking package.');
  return lines.join('\n') + '\n';
}

function safetyNetPreflight(targetDir, config, options = {}) {
  const rootrabbit = rootRabbitPreflight(targetDir, config, { changedPaths: options.changedPaths || [], requireInstalled: !!options.requireRabbit });
  const hutch = hutchPreflight(targetDir, config);
  const flight = flightPreflight(targetDir, config);
  const blocking = [
    ...rootrabbit.blocking.map((x) => 'RootRabbit: ' + x),
    ...hutch.blocking.map((x) => 'Hutch: ' + x),
    ...flight.blocking.map((x) => 'Flight: ' + x)
  ];
  const warnings = [
    ...rootrabbit.warnings.map((x) => 'RootRabbit: ' + x),
    ...hutch.warnings.map((x) => 'Hutch: ' + x),
    ...flight.warnings.map((x) => 'Flight: ' + x)
  ];
  const status = blocking.length ? 'fail' : (warnings.length ? 'warn' : 'pass');
  return {
    generated_at: nowIso(),
    target_dir: targetDir,
    status,
    safe_for_bundle: blocking.length === 0,
    blocking,
    warnings,
    rootrabbit,
    hutch,
    flight
  };
}


async function commandRepoGuardScan(root, target, flags) {
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const resolved = await resolveTargetDir(root, target, config);
  const report = await publicRepoPreflight(resolved.dir, config);
  const p = paths(root, config);
  const name = flags.name ? slugify(flags.name) : 'repoguard-' + safeDateStamp();

  // Default mode: append to reports/safetynet/repoguard.sqlbook (set up by
  // sqlbooks/profiles/safetynet-reports/build-migrate.py). One file
  // accumulates every run instead of dropping a fresh .repoguard.{json,md}
  // pair per scan. Pass --flat to emit the legacy flat-pair files instead
  // (useful for one-off diff inspection or when no sqlite3 cli is around).
  if (flags.flat) {
    const jsonFile = path.join(p.safetyNetReports, name + '.repoguard.json');
    const mdFile = path.join(p.safetyNetReports, name + '.repoguard.md');
    await writeJson(jsonFile, report);
    await writeText(mdFile, publicRepoMarkdown(report));
    console.log('Report: ' + mdFile);
  } else {
    const sqlbook = path.join(p.safetyNetReports, 'repoguard.sqlbook');
    await appendRepoGuardSqlbookRun(sqlbook, report, name + '.repoguard.json');
    console.log('Report appended to: ' + sqlbook + ' (run source_file=' + name + '.repoguard.json)');
  }

  console.log('RepoGuard: ' + report.status.toUpperCase() + ' (' + report.blocking.length + ' blocking, ' + report.warnings.length + ' warnings)');
  console.log('Safe for public repo: ' + (report.safe_for_public_repo ? 'yes' : 'NO'));
}

// Append one RepoGuard run as a row in the sqlbook ledger. Schema matches
// sqlbooks/profiles/safetynet-reports/build-migrate.py — keep them in sync.
//
// Implemented with a Python helper because pk-client doesn't currently
// ship sqlite3 bindings; we already require Python in the workflow.
async function appendRepoGuardSqlbookRun(sqlbookPath, report, sourceFileName) {
  const payload = JSON.stringify({ report, source_file: sourceFileName });
  // Use a heredoc-style stdin write to avoid an arg-length limit on big reports.
  const py = require('child_process').spawnSync(
    'python3', ['-c', `
import json, os, sqlite3, sys
data = json.loads(sys.stdin.read())
report = data['report']
source = data['source_file']
sqlbook = ${JSON.stringify(sqlbookPath)}
os.makedirs(os.path.dirname(sqlbook), exist_ok=True)
conn = sqlite3.connect(sqlbook)
conn.executescript('''
  CREATE TABLE IF NOT EXISTS book (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, version TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    profile TEXT NOT NULL DEFAULT 'safetynet-reports');
  CREATE TABLE IF NOT EXISTS run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generated_at TEXT NOT NULL, target_dir TEXT NOT NULL,
    status TEXT NOT NULL,
    blocking_count INTEGER NOT NULL, warning_count INTEGER NOT NULL,
    secret_hit_count INTEGER NOT NULL, sanitized_source_count INTEGER NOT NULL,
    source_file TEXT UNIQUE NOT NULL);
  CREATE TABLE IF NOT EXISTS secret_hit (
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    file TEXT NOT NULL, line INTEGER NOT NULL, kind TEXT NOT NULL,
    severity TEXT NOT NULL, sample TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS warning (
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    message TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sanitized (
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    file TEXT NOT NULL, line INTEGER NOT NULL, sample TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_secret_hit_run ON secret_hit(run_id);
  CREATE INDEX IF NOT EXISTS idx_secret_hit_kind ON secret_hit(kind);
  CREATE INDEX IF NOT EXISTS idx_warning_run ON warning(run_id);
  CREATE INDEX IF NOT EXISTS idx_sanitized_run ON sanitized(run_id);
  CREATE INDEX IF NOT EXISTS idx_run_generated ON run(generated_at DESC);
''')
from datetime import datetime, timezone
conn.execute(
  '''INSERT INTO book(id, title, version, updated_at, profile)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at''',
  ('safetynet-reports', 'PlaneKey SafetyNet report ledger',
   '1.0.0', datetime.now(timezone.utc).isoformat(),
   'safetynet-reports'))
cur = conn.cursor()
cur.execute(
  '''INSERT INTO run(generated_at, target_dir, status, blocking_count,
                     warning_count, secret_hit_count,
                     sanitized_source_count, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_file) DO NOTHING''',
  (report.get('generated_at',''), report.get('target_dir',''),
   report.get('status',''),
   len(report.get('blocking',[])), len(report.get('warnings',[])),
   len(report.get('secret_hits',[])), len(report.get('sanitized_source_hits',[])),
   source))
if cur.lastrowid:
  run_id = cur.lastrowid
  for h in report.get('secret_hits', []):
    cur.execute(
      'INSERT INTO secret_hit(run_id, file, line, kind, severity, sample) VALUES (?, ?, ?, ?, ?, ?)',
      (run_id, h.get('file',''), int(h.get('line',0)), h.get('kind',''),
       h.get('severity',''), h.get('sample','')))
  for w in report.get('warnings', []):
    cur.execute('INSERT INTO warning(run_id, message) VALUES (?, ?)',
                (run_id, w))
  for s in report.get('sanitized_source_hits', []):
    cur.execute(
      'INSERT INTO sanitized(run_id, file, line, sample) VALUES (?, ?, ?, ?)',
      (run_id, s.get('file',''), int(s.get('line',0)), s.get('sample','')))
conn.commit()
conn.close()
`],
    { input: payload, stdio: ['pipe', 'inherit', 'inherit'] }
  );
  if (py.status !== 0) {
    throw new Error('Failed to append RepoGuard run to sqlbook (exit ' + py.status + ')');
  }
}

// pk-client repoguard sanitize <target>
//
// For each blocking secret_hit in a fresh scan, replaces the captured value in
// the source file with REDACTED_<hash6> and emits a receipt at
// reports/safetynet/sanitize-<ts>.receipt.json mapping
//   file:line:kind -> { original_prefix, sha256_16, replacement_token }.
//
// Use case: audit sqlbooks under sqlbooks/profiles/dependency-audit/ that
// intentionally store known-leaked-key strings as triage records. Sanitize
// keeps the audit value (prefix + hash anchor proves what was there) while
// stopping the explicit pattern matcher from re-flagging the full key.
//
// Flags:
//   --dry-run       compute receipts, print plan, don't modify any file.
//   --include-kinds  comma-separated list of kinds to sanitize (default: all
//                   blocking kinds in scan output).
//   --name           receipt filename slug (default: sanitize-<ts>).
async function commandRepoGuardSanitize(root, target, flags) {
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const resolved = await resolveTargetDir(root, target, config);
  const report = await publicRepoPreflight(resolved.dir, config);
  const p = paths(root, config);
  const includeKinds = flags.includeKinds
    ? new Set(String(flags.includeKinds).split(',').map((s) => s.trim()))
    : null;
  const hits = (report.secret_hits || []).filter((h) => h.severity === 'block')
    .filter((h) => !includeKinds || includeKinds.has(String(h.kind).split(':')[0]));
  const receipt = {
    schema: 'planekey.repoguard-sanitize.v1',
    generated_at: nowIso(),
    client_version: VERSION,
    target_dir: resolved.dir,
    dry_run: !!flags.dryRun,
    source_scan_status: report.status,
    rewrites: []
  };
  for (const h of hits) {
    const abs = path.join(resolved.dir, h.file);
    let text;
    try { text = await fsp.readFile(abs, 'utf8'); } catch (_) {
      receipt.rewrites.push({ file: h.file, line: h.line, kind: h.kind, skipped: 'unreadable' });
      continue;
    }
    const lines = text.split(/\r?\n/);
    const idx = (h.line || 1) - 1;
    if (idx < 0 || idx >= lines.length) {
      receipt.rewrites.push({ file: h.file, line: h.line, kind: h.kind, skipped: 'line-out-of-range' });
      continue;
    }
    const line = lines[idx];
    const matched = h.sample || '';
    if (!matched || !line.includes(matched.split(' ')[0])) {
      receipt.rewrites.push({ file: h.file, line: h.line, kind: h.kind, skipped: 'sample-not-on-line' });
      continue;
    }
    const valueMatch = matched.match(/(?:=|:)\s*['"]?([^'"\s)]+)/);
    const original = valueMatch ? valueMatch[1] : matched;
    const hash16 = crypto.createHash('sha256').update(original).digest('hex').slice(0, 16);
    const prefix = original.slice(0, 6);
    const replacement = 'REDACTED_' + hash16;
    const newLine = line.split(original).join(replacement);
    lines[idx] = newLine;
    receipt.rewrites.push({
      file: h.file,
      line: h.line,
      kind: h.kind,
      original_prefix: prefix + '...',
      sha256_16: hash16,
      replacement_token: replacement,
      applied: !flags.dryRun
    });
    if (!flags.dryRun) await fsp.writeFile(abs, lines.join('\n'), 'utf8');
  }
  const name = flags.name ? slugify(flags.name) : 'sanitize-' + safeDateStamp();
  const receiptFile = path.join(p.safetyNetReports, name + '.receipt.json');
  await writeJson(receiptFile, receipt);
  const applied = receipt.rewrites.filter((r) => r.applied).length;
  const skipped = receipt.rewrites.filter((r) => r.skipped).length;
  console.log('RepoGuard sanitize: ' + receipt.rewrites.length + ' hit(s), ' +
    applied + ' applied' + (flags.dryRun ? ' (dry-run)' : '') + ', ' + skipped + ' skipped');
  console.log('Receipt: ' + receiptFile);
}

async function commandSafetyNetScan(root, target, flags) {
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const resolved = await resolveTargetDir(root, target, config);
  const report = safetyNetPreflight(resolved.dir, config, { requireRabbit: !!(flags.requireRabbit || flags.require) });
  const name = flags.name ? slugify(flags.name) : 'safetynet-' + safeDateStamp();
  const jsonFile = path.join(p.safetyNetReports, name + '.json');
  const mdFile = path.join(p.safetyNetReports, name + '.md');
  await writeJson(jsonFile, report);
  await writeText(mdFile, safetyNetMarkdown(report));
  console.log('SafetyNet status: ' + report.status.toUpperCase());
  console.log('Safe for bundle: ' + (report.safe_for_bundle ? 'yes' : 'NO'));
  console.log('RootRabbit: ' + report.rootrabbit.status.toUpperCase() + ', Hutch: ' + report.hutch.status.toUpperCase() + ', Flight: ' + report.flight.status.toUpperCase());
  console.log('Report written: ' + mdFile);
  if (report.blocking.length) {
    console.log('Blocking issues:');
    report.blocking.forEach((x) => console.log('- ' + x));
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// Rebuild / Reverse-Zip Matrix Overlap
// Consumes the outputs produced by flatten/extract/unpack/dedup cleanup passes:
//   _unpacked/   canonical structure with in-place version buckets
//   _all_files/  same-name buckets from every nested zip
//   _all_zips/   flattened nested zip evidence
// This is intentionally conservative: it selects coherent whole-file versions,
// writes a graft plan for branch-only features, and never invents merged code.
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_EXTS = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.htm', '.css', '.md', '.txt', '.yaml', '.yml', '.env', '.example', '.sql']);

function safeReadBuffer(file) {
  try { return fs.readFileSync(file); } catch (_) { return Buffer.alloc(0); }
}

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isProbablyTextFile(file, buf) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTS.has(ext)) return true;
  if (!buf || !buf.length) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let zeroes = 0;
  for (const b of sample) if (b === 0) zeroes++;
  return zeroes === 0;
}

function readTextForAnalysis(file) {
  const buf = safeReadBuffer(file);
  if (!isProbablyTextFile(file, buf)) return '';
  return buf.toString('utf8');
}

function looksLikeVersionBucket(absDir) {
  if (!isDir(absDir)) return false;
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (_) { return false; }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  if (!files.length) return false;
  const baseName = path.basename(absDir);
  const baseExt = path.extname(baseName).toLowerCase();
  const versionish = files.filter((name) => /^v\d{2,}__/.test(name));
  if (versionish.length >= 1 && baseExt) return true;
  return versionish.length >= 2;
}

function parseVersionFileName(name) {
  const m = /^v(\d{2,})__(.*)$/.exec(name);
  if (!m) return { order: 9999, source_label: name, raw_label: name };
  return {
    order: Number(m[1]),
    source_label: m[2].replace(/__/g, '::'),
    raw_label: m[2]
  };
}

function normalizeRouteTarget(value) {
  return String(value || '').trim().replace(/\?.*$/, '').replace(/#.*$/, '') || '/';
}

function extractFeatureSignature(file, text) {
  const sig = {
    routes: [],
    navigation: [],
    requires: [],
    imports: [],
    functions: [],
    classes: [],
    domIds: [],
    features: [],
    zones: [],
    sanitizedLiteralHits: [],
    syntax: { checked: false, ok: null, error: null }
  };
  if (!text) return sig;

  let m;
  const routeRe = /(?:app|router)\.(get|post|put|delete|patch|use)\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = routeRe.exec(text)) !== null) sig.routes.push(`${m[1].toUpperCase()} ${normalizeRouteTarget(m[2])}`);

  const redirectRe = /(?:res\.redirect\(\s*(?:\d+\s*,\s*)?|window\.location\.(?:href|replace)\s*(?:=|\()\s*|location\.href\s*=\s*)['"`]([^'"`]+)['"`]/g;
  while ((m = redirectRe.exec(text)) !== null) sig.navigation.push(normalizeRouteTarget(m[1]));

  const fetchRe = /fetch\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = fetchRe.exec(text)) !== null) sig.navigation.push('FETCH ' + normalizeRouteTarget(m[1]));

  const requireRe = /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  while ((m = requireRe.exec(text)) !== null) sig.requires.push(m[1]);

  const importRe = /import\s+(?:[^'"`]+\s+from\s+)?['"`]([^'"`]+)['"`]/g;
  while ((m = importRe.exec(text)) !== null) sig.imports.push(m[1]);

  const fnRe = /(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|async\s+function\s+([A-Za-z_$][\w$]*))/g;
  while ((m = fnRe.exec(text)) !== null) sig.functions.push(m[1] || m[2] || m[3]);

  const classRe = /class\s+([A-Za-z_$][\w$]*)/g;
  while ((m = classRe.exec(text)) !== null) sig.classes.push(m[1]);

  const idRe = /id=["']([^"']+)["']/g;
  while ((m = idRe.exec(text)) !== null) sig.domIds.push(m[1]);

  const featureNeedles = [
    ['rootrabbit', /RootRabbit|root-rabbit|rabbitRoot|data-planekey-tab=["']rabbit/i],
    ['planekey', /PlaneKey|planekey/i],
    ['hutch', /hutch/i],
    ['flight', /flight/i],
    ['chainlinks', /chainlink|parent_map|parentMap|child_map|deeper dive/i],
    ['tiles', /tile|narrative arc|share tile|tile-share/i],
    ['stripe', /stripe|checkout|billing portal|buy\.stripe/i],
    ['auth', /passport|session|login|logout|signup|password/i],
    ['teams', /team|member|invite/i],
    ['analytics', /analytics|event|track/i],
    ['limits', /daily limit|quota|referral|usage/i],
    ['verticals', /scientific|legal|financial|vertical/i]
  ];
  for (const [label, re] of featureNeedles) if (re.test(text)) sig.features.push(label);

  sig.zones = parseRootRabbitZones(text).map((z) => z.zone_id);

  const redactedRe = /typeof\s+[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)?\s*(?:!==|===|!=|==)\s*['"]REDACTED['"]/g;
  while ((m = redactedRe.exec(text)) !== null) sig.sanitizedLiteralHits.push(m[0]);

  sig.routes = uniqueList(sig.routes).sort();
  sig.navigation = uniqueList(sig.navigation).sort();
  sig.requires = uniqueList(sig.requires).sort();
  sig.imports = uniqueList(sig.imports).sort();
  sig.functions = uniqueList(sig.functions).sort();
  sig.classes = uniqueList(sig.classes).sort();
  sig.domIds = uniqueList(sig.domIds).sort();
  sig.features = uniqueList(sig.features).sort();
  sig.zones = uniqueList(sig.zones).sort();

  const ext = path.extname(file).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const syntax = nodeSyntaxCheck(file);
    sig.syntax = { checked: true, ok: syntax.ok, error: syntax.error || null };
  }
  return sig;
}

function tokenSetFromSignature(sig) {
  const out = [];
  for (const r of sig.routes || []) out.push('route:' + r);
  for (const n of sig.navigation || []) out.push('nav:' + n);
  for (const r of sig.requires || []) out.push('require:' + r);
  for (const i of sig.imports || []) out.push('import:' + i);
  for (const f of sig.functions || []) out.push('fn:' + f);
  for (const c of sig.classes || []) out.push('class:' + c);
  for (const id of sig.domIds || []) out.push('id:' + id);
  for (const f of sig.features || []) out.push('feature:' + f);
  for (const z of sig.zones || []) out.push('zone:' + z);
  return uniqueList(out).sort();
}

function scoreVersion(version, consensus, fileRel) {
  const tokens = new Set(version.tokens || []);
  const consensusTokens = consensus.tokens || [];
  const consensusRoutes = consensus.routes || [];
  const routes = new Set((version.signature && version.signature.routes) || []);
  const features = new Set((version.signature && version.signature.features) || []);
  const zones = (version.signature && version.signature.zones) || [];
  const tokenOverlap = consensusTokens.length ? consensusTokens.filter((t) => tokens.has(t)).length / consensusTokens.length : 1;
  const routeOverlap = consensusRoutes.length ? consensusRoutes.filter((r) => routes.has(r)).length / consensusRoutes.length : 1;
  let score = 0;
  score += 36 * tokenOverlap;
  score += 28 * routeOverlap;
  score += Math.min(10, Math.log10(Math.max(1, version.size)) * 2.2);
  if (version.order === 1) score += 10;
  if (version.signature && version.signature.syntax.checked) score += version.signature.syntax.ok ? 14 : -55;
  if (version.signature && version.signature.sanitizedLiteralHits.length) score -= 40;
  if (features.has('rootrabbit')) score += 12;
  if (features.has('planekey')) score += 8;
  if (features.has('chainlinks')) score += 7;
  if (features.has('tiles')) score += 7;
  if (features.has('stripe')) score += 5;
  if (features.has('analytics')) score += 4;
  if (zones.length) score += Math.min(12, zones.length * 1.5);
  if (/server\.js$/i.test(fileRel)) score += Math.min(20, routes.size * 0.55);
  if (/root-rabbit\.js$/i.test(fileRel) && features.has('rootrabbit')) score += 18;
  if (/planekey\.html$/i.test(fileRel) && features.has('rootrabbit')) score += 8;
  return Math.round(score * 1000) / 1000;
}

function buildConsensus(versions) {
  const tokenCounts = new Map();
  const routeCounts = new Map();
  for (const v of versions) {
    for (const t of v.tokens || []) tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
    for (const r of (v.signature && v.signature.routes) || []) routeCounts.set(r, (routeCounts.get(r) || 0) + 1);
  }
  const minCount = versions.length > 1 ? 2 : 1;
  const tokens = [...tokenCounts.entries()].filter(([, n]) => n >= minCount).map(([t]) => t).sort();
  const routes = [...routeCounts.entries()].filter(([, n]) => n >= minCount).map(([r]) => r).sort();
  return { tokens, routes, tokenCounts: Object.fromEntries([...tokenCounts.entries()].sort()), routeCounts: Object.fromEntries([...routeCounts.entries()].sort()) };
}

function branchFeatureDelta(selected, versions) {
  const selectedTokens = new Set(selected ? selected.tokens || [] : []);
  const deltas = [];
  for (const v of versions) {
    if (selected && v.file === selected.file) continue;
    const extra = (v.tokens || []).filter((t) => !selectedTokens.has(t));
    const interesting = extra.filter((t) => /^(route|nav|require|import|feature|zone):/.test(t));
    if (interesting.length) {
      deltas.push({
        candidate: v.name,
        source_label: v.source_label,
        score: v.score,
        extra_tokens: interesting.slice(0, 60),
        extra_count: interesting.length
      });
    }
  }
  deltas.sort((a, b) => b.extra_count - a.extra_count || b.score - a.score);
  return deltas;
}

function resolveRebuildCanonicalDir(inputDir) {
  const abs = path.resolve(inputDir || process.cwd());
  const unpacked = path.join(abs, '_unpacked');
  if (isDir(unpacked)) return { collector_root: abs, canonical_root: unpacked, mode: 'collector-with-_unpacked' };
  if (path.basename(abs) === '_unpacked' || isFile(path.join(abs, '_index.txt'))) return { collector_root: path.dirname(abs), canonical_root: abs, mode: 'unpacked-root' };
  return { collector_root: abs, canonical_root: abs, mode: 'raw-folder' };
}

async function collectRebuildBuckets(canonicalRoot, config) {
  const buckets = [];
  async function walk(current) {
    if (matchesAny(relUnix(canonicalRoot, current), ['_all_files/**', '_all_zips/**'])) return;
    if (looksLikeVersionBucket(current)) {
      const rel = relUnix(canonicalRoot, current);
      const names = fs.readdirSync(current).filter((n) => isFile(path.join(current, n))).sort();
      const versions = [];
      for (const name of names) {
        const file = path.join(current, name);
        const buf = safeReadBuffer(file);
        const text = readTextForAnalysis(file);
        const parsed = parseVersionFileName(name);
        const signature = extractFeatureSignature(file, text);
        const tokens = tokenSetFromSignature(signature);
        versions.push({
          name,
          file,
          path: rel,
          source_label: parsed.source_label,
          order: parsed.order,
          sha256: sha256Bytes(buf),
          size: buf.length,
          signature,
          tokens
        });
      }
      const consensus = buildConsensus(versions);
      for (const v of versions) v.score = scoreVersion(v, consensus, rel);
      versions.sort((a, b) => b.score - a.score || a.order - b.order || b.size - a.size);
      const selected = versions[0] || null;
      buckets.push({
        path: rel,
        kind: rel.startsWith('_unmapped/') ? 'unmapped-version-bucket' : 'version-bucket',
        version_count: versions.length,
        consensus,
        selected,
        versions,
        branch_deltas: branchFeatureDelta(selected, versions)
      });
      return;
    }
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(current, e.name);
      const rel = relUnix(canonicalRoot, abs);
      if (e.isDirectory()) {
        if (['node_modules', '.git', '__MACOSX'].includes(e.name)) continue;
        await walk(abs);
      } else if (e.isFile()) {
        if (e.name === '_index.txt') continue;
        const buf = safeReadBuffer(abs);
        const text = readTextForAnalysis(abs);
        const signature = extractFeatureSignature(abs, text);
        const tokens = tokenSetFromSignature(signature);
        const version = { name: e.name, file: abs, path: rel, source_label: 'canonical-single-file', order: 1, sha256: sha256Bytes(buf), size: buf.length, signature, tokens, score: 100 };
        buckets.push({ path: rel, kind: rel.startsWith('_unmapped/') ? 'unmapped-single-file' : 'single-file', version_count: 1, consensus: buildConsensus([version]), selected: version, versions: [version], branch_deltas: [] });
      }
    }
  }
  await walk(canonicalRoot);
  buckets.sort((a, b) => a.path.localeCompare(b.path));
  return buckets;
}

function summarizeRebuildAnalysis(analysis) {
  const selectedByPath = new Map();
  for (const b of analysis.buckets) if (b.selected) selectedByPath.set(b.path, b.selected);
  const server = analysis.buckets.find((b) => b.path === 'server.js');
  const serverSelected = server && server.selected;
  const allSelectedFeatures = new Set();
  const allSelectedRoutes = new Set();
  let sanitizedHits = 0;
  let syntaxFailures = 0;
  for (const b of analysis.buckets) {
    const s = b.selected;
    if (!s || !s.signature) continue;
    for (const f of s.signature.features || []) allSelectedFeatures.add(f);
    for (const r of s.signature.routes || []) allSelectedRoutes.add(r);
    sanitizedHits += (s.signature.sanitizedLiteralHits || []).length;
    if (s.signature.syntax && s.signature.syntax.checked && !s.signature.syntax.ok) syntaxFailures++;
  }
  const graftCandidates = [];
  for (const b of analysis.buckets) {
    for (const d of b.branch_deltas || []) {
      graftCandidates.push({ path: b.path, ...d });
    }
  }
  graftCandidates.sort((a, b) => b.extra_count - a.extra_count || b.score - a.score);
  return {
    bucket_count: analysis.buckets.length,
    version_bucket_count: analysis.buckets.filter((b) => b.version_count > 1).length,
    unmapped_bucket_count: analysis.buckets.filter((b) => b.path.startsWith('_unmapped/')).length,
    selected_feature_flags: [...allSelectedFeatures].sort(),
    selected_route_count: allSelectedRoutes.size,
    sanitized_literal_hits: sanitizedHits,
    selected_syntax_failures: syntaxFailures,
    base_design: serverSelected ? {
      path: 'server.js',
      selected: serverSelected.name,
      source_label: serverSelected.source_label,
      score: serverSelected.score,
      routes: (serverSelected.signature && serverSelected.signature.routes || []).length,
      features: serverSelected.signature && serverSelected.signature.features || [],
      zones: serverSelected.signature && serverSelected.signature.zones || []
    } : null,
    top_graft_candidates: graftCandidates.slice(0, 40)
  };
}

async function analyzeRebuildInput(inputDir, config) {
  const resolved = resolveRebuildCanonicalDir(inputDir);
  const buckets = await collectRebuildBuckets(resolved.canonical_root, config);
  const analysis = {
    generated_at: nowIso(),
    client_version: VERSION,
    input: path.resolve(inputDir || process.cwd()),
    collector_root: resolved.collector_root,
    canonical_root: resolved.canonical_root,
    mode: resolved.mode,
    buckets,
    summary: null
  };
  analysis.summary = summarizeRebuildAnalysis(analysis);
  return analysis;
}


// ─────────────────────────────────────────────────────────────────────────────
// Reverse-Zip Collector
// Consumes a directory full of flattened/nested zip evidence directly, selects a
// base archive by route/RootRabbit matrix scoring, builds an _unpacked-style
// collector, then reuses the rebuild matrix to materialize a clean project.
// ─────────────────────────────────────────────────────────────────────────────

const REVERSE_ZIP_SKIP_NAME_RE = /(__MACOSX|YOLO-World|Polsia-main|pk-client|planekey-client|cc_project_check_report|\.DS_Store)/i;
const REVERSE_ZIP_INCLUDE_NAME_RE = /(conversationchain|rootrabbit|root-rabbit|chainlinks|tiles|planekey|final_archive|claudecode)/i;

function safeCollectorLabel(value) {
  return String(value || 'source')
    .replace(/::/g, '__')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 140) || 'source';
}

function shouldUseEvidenceZip(zipFile, flags) {
  const name = path.basename(zipFile);
  if (flags.allZips || flags.allzips || flags.all) return !/__MACOSX/i.test(name) && path.extname(name).toLowerCase() === '.zip';
  if (REVERSE_ZIP_SKIP_NAME_RE.test(name)) return false;
  return REVERSE_ZIP_INCLUDE_NAME_RE.test(name) && path.extname(name).toLowerCase() === '.zip';
}

function shouldSkipReverseZipFile(rel, config) {
  const normalized = rel.replace(/\\/g, '/');
  if (!normalized || normalized.endsWith('/')) return true;
  const parts = normalized.split('/');
  if (parts.some((p) => ['node_modules', '.git', '__MACOSX', '.cache', 'dist', 'build'].includes(p))) return true;
  if (parts.some((p) => p.startsWith('._'))) return true;
  const base = path.basename(normalized);
  if (['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(base)) return true;
  if (/\.(zip|rar|7z)$/i.test(base)) return true;
  if (config && Array.isArray(config.exportExclude) && matchesAny(normalized, config.exportExclude)) return true;
  return false;
}

async function listEvidenceZips(zipFolder, flags) {
  const root = path.resolve(zipFolder);
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', '__MACOSX'].includes(e.name)) continue;
        await walk(abs);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.zip')) {
        if (shouldUseEvidenceZip(abs, flags || {})) out.push(abs);
      }
    }
  }
  await walk(root);
  return out;
}

async function collectFilesFromExtractedZip(zipFile, extractRoot, config, label) {
  const entries = [];
  let sourceRoot = extractRoot;
  try { sourceRoot = await normalizedSourceDir(extractRoot); } catch (_) {}
  async function walk(dir) {
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const abs = path.join(dir, item.name);
      const rel = relUnix(sourceRoot, abs);
      if (item.isDirectory()) {
        if (['node_modules', '.git', '__MACOSX'].includes(item.name)) continue;
        await walk(abs);
      } else if (item.isFile()) {
        if (shouldSkipReverseZipFile(rel, config)) continue;
        const buf = safeReadBuffer(abs);
        const text = readTextForAnalysis(abs);
        const signature = extractFeatureSignature(abs, text);
        entries.push({
          zip: zipFile,
          zip_label: label,
          rel,
          abs,
          sha256: sha256Bytes(buf),
          size: buf.length,
          signature,
          tokens: tokenSetFromSignature(signature)
        });
      }
    }
  }
  await walk(sourceRoot);
  return entries;
}

function scoreReverseZipBase(zipInfo) {
  const server = zipInfo.entries.find((e) => e.rel === 'server.js') || zipInfo.entries.find((e) => /(^|\/)server\.js$/i.test(e.rel));
  const paths = new Set(zipInfo.entries.map((e) => e.rel));
  let score = 0;
  if (server) {
    const sig = server.signature || {};
    score += 80;
    score += ((sig.routes || []).length * 1.25);
    score += ((sig.functions || []).length * 0.15);
    score += ((sig.features || []).length * 4);
    score += ((sig.zones || []).length * 3);
    if (sig.features && sig.features.includes('rootrabbit')) score += 35;
    if (sig.features && sig.features.includes('planekey')) score += 20;
    if (sig.features && sig.features.includes('chainlinks')) score += 14;
    if (sig.features && sig.features.includes('tiles')) score += 14;
    if (sig.syntax && sig.syntax.checked && sig.syntax.ok) score += 25;
    if (sig.syntax && sig.syntax.checked && !sig.syntax.ok) score -= 75;
    if (sig.sanitizedLiteralHits && sig.sanitizedLiteralHits.length) score -= 45;
  }
  if (paths.has('server/security/root-rabbit.js')) score += 40;
  if (paths.has('admin/planekey.html')) score += 25;
  if (paths.has('tools/hutch.js')) score += 12;
  if (paths.has('tools/flight.js')) score += 12;
  if (paths.has('package.json')) score += 10;
  // Large unrelated repos often have many files but no ConversationChain routes;
  // avoid rewarding raw size too much.
  score += Math.min(20, zipInfo.entries.length * 0.12);
  return Math.round(score * 1000) / 1000;
}

async function buildReverseZipCollector(workspaceRoot, zipFolder, config, flags) {
  const p = paths(workspaceRoot, config);
  const name = flags.name ? slugify(flags.name) : 'reverse-zips-' + safeDateStamp();
  const collectorRoot = path.join(p.rebuildReports, 'collectors', name + '-collector');
  const extractionRoot = path.join(collectorRoot, '_extract');
  const unpackedRoot = path.join(collectorRoot, '_unpacked');
  if (exists(collectorRoot) && !flags.force) throw new Error('Collector exists. Use --force or choose another --name: ' + collectorRoot);
  await emptyDir(collectorRoot);
  await fsp.mkdir(extractionRoot, { recursive: true });
  await fsp.mkdir(unpackedRoot, { recursive: true });

  const zips = await listEvidenceZips(zipFolder, flags);
  if (!zips.length) throw new Error('No usable zip files found in: ' + zipFolder + ' (try --allZips if the names are unusual)');

  const zipInfos = [];
  for (let i = 0; i < zips.length; i++) {
    const zipFile = zips[i];
    const label = path.basename(zipFile);
    const extractTo = path.join(extractionRoot, String(i + 1).padStart(4, '0') + '__' + safeCollectorLabel(label));
    await emptyDir(extractTo);
    try {
      await extractZip(zipFile, extractTo);
      const entries = await collectFilesFromExtractedZip(zipFile, extractTo, config, label);
      const info = { zip: zipFile, label, entries, score: 0 };
      info.score = scoreReverseZipBase(info);
      zipInfos.push(info);
    } catch (err) {
      zipInfos.push({ zip: zipFile, label, entries: [], score: -999, error: String(err && err.message || err) });
    }
  }

  zipInfos.sort((a, b) => b.score - a.score || b.entries.length - a.entries.length || a.label.localeCompare(b.label));
  const base = zipInfos[0];
  if (!base || !base.entries.length) throw new Error('Zip extraction produced no usable files.');
  const basePaths = new Set(base.entries.map((e) => e.rel));

  const byPath = new Map();
  for (const info of zipInfos) {
    for (const e of info.entries) {
      const mappedRel = basePaths.has(e.rel) ? e.rel : '_unmapped/' + e.rel;
      if (!byPath.has(mappedRel)) byPath.set(mappedRel, []);
      byPath.get(mappedRel).push({ ...e, mappedRel, source_label: info.label + '::' + e.rel, zip_score: info.score });
    }
  }

  const selectedIndex = [];
  for (const mappedRel of [...byPath.keys()].sort()) {
    const versionsRaw = byPath.get(mappedRel) || [];
    const seen = new Set();
    const versions = [];
    for (const v of versionsRaw) {
      if (seen.has(v.sha256)) continue;
      seen.add(v.sha256);
      versions.push(v);
    }
    const destBase = path.join(unpackedRoot, ...mappedRel.split('/'));
    if (versions.length === 1) {
      await fsp.mkdir(path.dirname(destBase), { recursive: true });
      await fsp.copyFile(versions[0].abs, destBase);
      selectedIndex.push({ path: mappedRel, versions: 1, copied_as: mappedRel, source: versions[0].source_label, sha256: versions[0].sha256 });
    } else {
      await fsp.mkdir(destBase, { recursive: true });
      const ext = path.extname(mappedRel);
      for (let i = 0; i < versions.length; i++) {
        const v = versions[i];
        const sourceShort = safeCollectorLabel(v.source_label.replace('::' + (mappedRel.replace(/^_unmapped\//, '')), '')).slice(0, 120);
        const verName = 'v' + String(i + 1).padStart(2, '0') + '__' + sourceShort + ext;
        await fsp.copyFile(v.abs, path.join(destBase, verName));
      }
      selectedIndex.push({ path: mappedRel, versions: versions.length, copied_as: mappedRel + '/', sources: versions.map((v) => v.source_label), sha256s: versions.map((v) => v.sha256) });
    }
  }

  const report = {
    generated_at: nowIso(),
    client_version: VERSION,
    input_zip_folder: path.resolve(zipFolder),
    collector_root: collectorRoot,
    unpacked_root: unpackedRoot,
    zip_count: zips.length,
    used_zip_count: zipInfos.filter((z) => z.entries.length).length,
    base_zip: base ? { label: base.label, zip: base.zip, score: base.score, file_count: base.entries.length } : null,
    zip_ranking: zipInfos.slice(0, 50).map((z) => ({ label: z.label, zip: z.zip, score: z.score, file_count: z.entries.length, error: z.error || null })),
    mapped_paths: selectedIndex.filter((x) => !x.path.startsWith('_unmapped/')).length,
    unmapped_paths: selectedIndex.filter((x) => x.path.startsWith('_unmapped/')).length,
    selected_index: selectedIndex
  };
  await writeJson(path.join(collectorRoot, 'REVERSE_ZIP_COLLECTOR.json'), report);
  let md = '# Reverse Zip Collector\n\n';
  md += '- Input: `' + path.resolve(zipFolder) + '`\n';
  md += '- Collector: `' + collectorRoot + '`\n';
  md += '- Usable zips: ' + report.used_zip_count + '/' + report.zip_count + '\n';
  md += '- Base zip: `' + (report.base_zip ? report.base_zip.label : 'none') + '` score `' + (report.base_zip ? report.base_zip.score : 'n/a') + '`\n';
  md += '- Mapped paths: ' + report.mapped_paths + '\n';
  md += '- Unmapped paths: ' + report.unmapped_paths + '\n\n';
  md += '## Zip ranking\n\n';
  for (const z of report.zip_ranking.slice(0, 25)) md += '- `' + z.label + '` score `' + z.score + '` files `' + z.file_count + '`' + (z.error ? ' **error:** ' + z.error : '') + '\n';
  await writeText(path.join(collectorRoot, 'REVERSE_ZIP_COLLECTOR.md'), md);
  return report;
}

async function commandRebuildScanZips(root, zipFolder, flags) {
  await ensureWorkspace(root);
  if (!zipFolder) throw new Error('Usage: pk-client rebuild scan-zips <zip-folder> [--name report-name] [--allZips]');
  const config = loadConfig(root);
  const collector = await buildReverseZipCollector(root, zipFolder, config, flags || {});
  const analysis = await analyzeRebuildInput(collector.unpacked_root, config);
  const p = paths(root, config);
  const name = flags.name ? slugify(flags.name) : 'reverse-zips-scan-' + safeDateStamp();
  const dir = path.join(p.rebuildReports || path.join(p.reports, 'rebuild'));
  await fsp.mkdir(dir, { recursive: true });
  const jsonFile = path.join(dir, name + '.json');
  const mdFile = path.join(dir, name + '.md');
  await writeJson(jsonFile, slimRebuildAnalysis(analysis));
  await writeText(mdFile, rebuildMarkdown(analysis, null));
  console.log('Reverse zip scan complete.');
  console.log('Collector: ' + collector.collector_root);
  console.log('Base zip: ' + (collector.base_zip ? collector.base_zip.label : 'none'));
  console.log('Buckets: ' + analysis.summary.bucket_count + ', multi-version: ' + analysis.summary.version_bucket_count + ', unmapped: ' + analysis.summary.unmapped_bucket_count);
  console.log('Report written: ' + mdFile);
}

async function commandRebuildFromZips(root, zipFolder, flags) {
  await ensureWorkspace(root);
  if (!zipFolder) throw new Error('Usage: pk-client rebuild from-zips <zip-folder> [--name rebuilt-name] [--force] [--includeUnmapped] [--requireRabbit] [--allZips]');
  const config = loadConfig(root);
  const collector = await buildReverseZipCollector(root, zipFolder, config, flags || {});
  const analysis = await analyzeRebuildInput(collector.unpacked_root, config);
  // Keep names stable: collector uses <name>-collector, export uses <name>.
  const materialized = await materializeRebuild(root, analysis, flags || {});
  await writeJson(path.join(materialized.out_dir, 'REVERSE_ZIP_COLLECTOR.json'), collector);
  let addendum = '\n\n---\n\n# Reverse Zip Collector Used\n\n';
  addendum += '- Source zip folder: `' + collector.input_zip_folder + '`\n';
  addendum += '- Collector root: `' + collector.collector_root + '`\n';
  addendum += '- Base zip: `' + (collector.base_zip ? collector.base_zip.label : 'none') + '`\n';
  addendum += '- Usable zips: ' + collector.used_zip_count + '/' + collector.zip_count + '\n';
  await fsp.appendFile(path.join(materialized.out_dir, 'PLANKEY_REBUILD_REPORT.md'), addendum, 'utf8');
  console.log('Reverse zip rebuild materialized: ' + materialized.out_dir);
  if (materialized.zip_path) console.log('Rebuild zip: ' + materialized.zip_path);
  console.log('Collector: ' + collector.collector_root);
  console.log('Base zip: ' + (collector.base_zip ? collector.base_zip.label : 'none'));
  console.log('Copied files: ' + materialized.copied_count);
  console.log('Skipped unmapped candidates: ' + materialized.skipped_unmapped.length);
  if (materialized.auto_included_grafts.length) console.log('Auto-included critical grafts: ' + materialized.auto_included_grafts.length);
  console.log('SafetyNet: ' + materialized.safety.status.toUpperCase() + ' (' + materialized.safety.blocking.length + ' blocking, ' + materialized.safety.warnings.length + ' warnings)');
  console.log('RepoGuard: ' + materialized.repoGuard.status.toUpperCase() + ' (' + materialized.repoGuard.blocking.length + ' blocking, ' + materialized.repoGuard.warnings.length + ' warnings)');
}

function slimVersion(v) {
  return {
    name: v.name,
    source_label: v.source_label,
    order: v.order,
    sha256: v.sha256,
    size: v.size,
    score: v.score,
    routes: (v.signature && v.signature.routes || []).length,
    features: v.signature && v.signature.features || [],
    zones: v.signature && v.signature.zones || [],
    syntax: v.signature && v.signature.syntax,
    sanitized_literal_hits: v.signature && v.signature.sanitizedLiteralHits ? v.signature.sanitizedLiteralHits.length : 0
  };
}

function slimRebuildAnalysis(analysis) {
  return {
    generated_at: analysis.generated_at,
    client_version: analysis.client_version,
    input: analysis.input,
    collector_root: analysis.collector_root,
    canonical_root: analysis.canonical_root,
    mode: analysis.mode,
    summary: analysis.summary,
    buckets: analysis.buckets.map((b) => ({
      path: b.path,
      kind: b.kind,
      version_count: b.version_count,
      selected: b.selected ? slimVersion(b.selected) : null,
      versions: b.versions.map(slimVersion),
      branch_deltas: b.branch_deltas
    }))
  };
}

function rebuildMarkdown(analysis, materialized) {
  const s = analysis.summary;
  const lines = [];
  lines.push('# PlaneKey Rebuild Matrix Report', '');
  lines.push('Generated: ' + analysis.generated_at);
  lines.push('Client: ' + VERSION);
  lines.push('Input: `' + analysis.input + '`');
  lines.push('Canonical root: `' + analysis.canonical_root + '`');
  if (materialized) lines.push('Materialized output: `' + materialized.out_dir + '`');
  lines.push('');
  lines.push('## Summary', '');
  lines.push('- Buckets: ' + s.bucket_count);
  lines.push('- Multi-version buckets: ' + s.version_bucket_count);
  lines.push('- Unmapped buckets: ' + s.unmapped_bucket_count);
  lines.push('- Selected route count: ' + s.selected_route_count);
  lines.push('- Selected feature flags: ' + (s.selected_feature_flags.join(', ') || 'none'));
  lines.push('- Sanitized literal hits in selected files: ' + s.sanitized_literal_hits);
  lines.push('- Selected syntax failures: ' + s.selected_syntax_failures);
  lines.push('');
  if (s.base_design) {
    lines.push('## Base Design Candidate', '');
    lines.push('- Path: `server.js`');
    lines.push('- Selected version: `' + s.base_design.selected + '`');
    lines.push('- Source: `' + s.base_design.source_label + '`');
    lines.push('- Score: ' + s.base_design.score);
    lines.push('- Routes: ' + s.base_design.routes);
    lines.push('- Features: ' + (s.base_design.features.join(', ') || 'none'));
    lines.push('- RootRabbit zones: ' + (s.base_design.zones.join(', ') || 'none'));
    lines.push('');
  }
  lines.push('## Version Selections', '');
  for (const b of analysis.buckets.filter((x) => x.version_count > 1).slice(0, 80)) {
    lines.push('### `' + b.path + '`', '');
    if (b.selected) lines.push('- Selected: `' + b.selected.name + '` from `' + b.selected.source_label + '` score `' + b.selected.score + '`');
    for (const v of b.versions.slice(0, 8)) {
      const flags = [];
      if (v.signature && v.signature.syntax && v.signature.syntax.checked && !v.signature.syntax.ok) flags.push('syntax-fail');
      if (v.signature && v.signature.sanitizedLiteralHits.length) flags.push('sanitized-redacted');
      lines.push('  - `' + v.name + '` score `' + v.score + '` features: ' + ((v.signature.features || []).join(', ') || 'none') + (flags.length ? ' **' + flags.join(', ') + '**' : ''));
    }
    lines.push('');
  }
  lines.push('## Branch Feature Graft Candidates', '');
  if (!s.top_graft_candidates.length) {
    lines.push('- none detected', '');
  } else {
    for (const g of s.top_graft_candidates.slice(0, 30)) {
      lines.push('- `' + g.path + '` candidate `' + g.candidate + '` adds ' + g.extra_count + ' token(s): ' + g.extra_tokens.slice(0, 8).map((x) => '`' + x + '`').join(', '));
    }
    lines.push('');
  }
  lines.push('## Rule', '');
  lines.push('This command rebuilds by selecting coherent whole-file versions using route/import/feature overlap. It does not splice JavaScript fragments together. Branch-only features are listed as graft candidates so they can be incorporated intentionally instead of duct-taped.');
  return lines.join('\n') + '\n';
}

async function materializeRebuild(root, analysis, flags) {
  const config = loadConfig(root);
  const p = paths(root, config);
  const name = flags.name ? slugify(flags.name) : 'rebuilt-' + safeDateStamp();
  const out = flags.out ? path.resolve(flags.out) : path.join(p.exports, name);
  if (exists(out) && !flags.force) throw new Error('Output exists. Use --force or choose --out/--name: ' + out);
  await emptyDir(out);
  const includeUnmapped = !!flags.includeUnmapped;
  const copied = [];
  const skippedUnmapped = [];
  const autoIncludedGrafts = [];
  for (const b of analysis.buckets) {
    if (!b.selected) continue;
    const rel = b.path.startsWith('_unmapped/') ? b.path.replace(/^_unmapped\//, '') : b.path;
    const isCriticalRabbitGraft = !!flags.requireRabbit && b.path.startsWith('_unmapped/') && (rel === 'server/security/root-rabbit.js' || rel.startsWith('server/security/'));
    if (b.path.startsWith('_unmapped/') && !includeUnmapped && !isCriticalRabbitGraft) {
      skippedUnmapped.push(b.path);
      continue;
    }
    if (isCriticalRabbitGraft && !includeUnmapped) autoIncludedGrafts.push(b.path);
    if (matchesAny(rel, config.exportExclude)) continue;
    const dest = path.join(out, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(b.selected.file, dest);
    copied.push({ path: rel, selected: b.selected.name, source_label: b.selected.source_label, sha256: b.selected.sha256, score: b.selected.score });
  }
  const manifest = await manifestForDir(out, { skipPatterns: ['node_modules/**', '.git/**'] });
  const safety = safetyNetPreflight(out, config, { requireRabbit: !!flags.requireRabbit });
  const repoGuard = await publicRepoPreflight(out, config);
  const materialized = { out_dir: out, copied_count: copied.length, skipped_unmapped: skippedUnmapped, auto_included_grafts: autoIncludedGrafts, manifest, safety, repoGuard };
  await writeJson(path.join(out, 'PLANKEY_REBUILD_PLAN.json'), slimRebuildAnalysis(analysis));
  await writeText(path.join(out, 'PLANKEY_REBUILD_REPORT.md'), rebuildMarkdown(analysis, materialized));
  await writeJson(path.join(out, 'PLANKEY_REBUILD_SELECTED_FILES.json'), { generated_at: nowIso(), copied, skipped_unmapped: skippedUnmapped, auto_included_grafts: autoIncludedGrafts });
  await writeJson(path.join(out, 'SAFETYNET_PREFLIGHT.json'), safety);
  await writeText(path.join(out, 'SAFETYNET_PREFLIGHT.md'), safetyNetMarkdown(safety));
  await writeJson(path.join(out, 'PUBLIC_REPOGUARD.json'), repoGuard);
  await writeText(path.join(out, 'PUBLIC_REPOGUARD.md'), publicRepoMarkdown(repoGuard));
  if (skippedUnmapped.length || autoIncludedGrafts.length) {
    let graftText = '# Unmapped Graft Candidates\n\n';
    if (autoIncludedGrafts.length) graftText += '## Auto-included critical grafts\n\nThese were pulled from `_unmapped/` because `--requireRabbit` needs them for complete RootRabbit wiring.\n\n' + autoIncludedGrafts.map((x) => '- `' + x + '`').join('\n') + '\n\n';
    if (skippedUnmapped.length) graftText += '## Skipped unmapped candidates\n\nThese paths were present under `_unmapped/` and were not auto-copied. Use `--includeUnmapped` only after review.\n\n' + skippedUnmapped.map((x) => '- `' + x + '`').join('\n') + '\n';
    await writeText(path.join(out, 'UNMAPPED_GRAFT_CANDIDATES.md'), graftText);
  }
  const zipPath = out + '.zip';
  const zip = run(process.platform === 'win32' ? 'powershell.exe' : 'zip',
    process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Compress-Archive -Path ${JSON.stringify(path.join(out, '*'))} -DestinationPath ${JSON.stringify(zipPath)} -Force`]
      : ['-qr', zipPath, '.'],
    process.platform === 'win32' ? {} : { cwd: out });
  if (zip.status === 0) materialized.zip_path = zipPath;
  return materialized;
}

async function commandRebuildScan(root, inputDir, flags) {
  await ensureWorkspace(root);
  if (!inputDir) throw new Error('Usage: pk-client rebuild scan <_unpacked-or-collector-folder> [--name report-name]');
  const config = loadConfig(root);
  const p = paths(root, config);
  const analysis = await analyzeRebuildInput(inputDir, config);
  const name = flags.name ? slugify(flags.name) : 'rebuild-scan-' + safeDateStamp();
  const dir = path.join(p.rebuildReports || path.join(p.reports, 'rebuild'));
  await fsp.mkdir(dir, { recursive: true });
  const jsonFile = path.join(dir, name + '.json');
  const mdFile = path.join(dir, name + '.md');
  await writeJson(jsonFile, slimRebuildAnalysis(analysis));
  await writeText(mdFile, rebuildMarkdown(analysis, null));
  console.log('Rebuild scan complete.');
  console.log('Buckets: ' + analysis.summary.bucket_count + ', multi-version: ' + analysis.summary.version_bucket_count + ', unmapped: ' + analysis.summary.unmapped_bucket_count);
  if (analysis.summary.base_design) console.log('Base design: server.js ← ' + analysis.summary.base_design.selected + ' score ' + analysis.summary.base_design.score);
  console.log('Report written: ' + mdFile);
}

async function commandRebuildCreate(root, inputDir, flags) {
  await ensureWorkspace(root);
  if (!inputDir) throw new Error('Usage: pk-client rebuild create <_unpacked-or-collector-folder> [--name rebuilt-name] [--force] [--includeUnmapped] [--requireRabbit]');
  const config = loadConfig(root);
  const analysis = await analyzeRebuildInput(inputDir, config);
  const materialized = await materializeRebuild(root, analysis, flags);
  console.log('Rebuild materialized: ' + materialized.out_dir);
  if (materialized.zip_path) console.log('Rebuild zip: ' + materialized.zip_path);
  console.log('Copied files: ' + materialized.copied_count);
  console.log('Skipped unmapped candidates: ' + materialized.skipped_unmapped.length);
  if (materialized.auto_included_grafts.length) console.log('Auto-included critical grafts: ' + materialized.auto_included_grafts.length);
  console.log('SafetyNet: ' + materialized.safety.status.toUpperCase() + ' (' + materialized.safety.blocking.length + ' blocking, ' + materialized.safety.warnings.length + ' warnings)');
  console.log('RepoGuard: ' + materialized.repoGuard.status.toUpperCase() + ' (' + materialized.repoGuard.blocking.length + ' blocking, ' + materialized.repoGuard.warnings.length + ' warnings)');
}

async function commandShaCompare(root, beforeFile, afterFile, flags) {
  await ensureWorkspace(root);
  if (!beforeFile || !afterFile) throw new Error('Usage: pk-client sha-compare <before.sha> <after.sha> [--name report-name]');
  const before = parseShaManifestFile(path.resolve(beforeFile));
  const after = parseShaManifestFile(path.resolve(afterFile));
  const diff = compareShaMaps(before.map, after.map);
  const report = {
    generated_at: nowIso(),
    before: { file: before.file, count: before.map.size, rejected: before.rejected },
    after: { file: after.file, count: after.map.size, rejected: after.rejected },
    diff
  };
  const p = paths(root);
  const name = flags.name ? slugify(flags.name) : 'sha-compare-' + safeDateStamp();
  const jsonFile = path.join(p.compareReports, name + '.json');
  const mdFile = path.join(p.compareReports, name + '.md');
  await writeJson(jsonFile, report);
  await writeText(mdFile, shaCompareMarkdown(report));
  console.log('SHA compare report written: ' + mdFile);
  console.log('JSON report written: ' + jsonFile);
  console.log('Same: ' + diff.counts.same + ', Changed: ' + diff.counts.changed + ', Added: ' + diff.counts.added + ', Removed: ' + diff.counts.removed);
  if (diff.changed.length) {
    console.log('Changed files:');
    diff.changed.forEach((x) => console.log('- ' + x.path));
  }
}

async function commandCompare(root, left, right, flags) {
  if (!left || !right) throw new Error('Usage: pk-client compare <snapshot-a> <snapshot-b>');
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const a = await loadSnapshotManifest(root, left);
  const b = await loadSnapshotManifest(root, right);
  const diff = diffManifests(a.manifest, b.manifest);
  const reportId = `${safeDateStamp()}_compare_${slugify(a.snap.name)}_to_${slugify(b.snap.name)}`;
  const jsonFile = path.join(p.compareReports, `${reportId}.json`);
  const mdFile = path.join(p.compareReports, `${reportId}.md`);
  await writeJson(jsonFile, { generated_at: nowIso(), left: a.snap, right: b.snap, diff });

  let md = `# Snapshot Compare\n\nGenerated: ${nowIso()}\n\nLeft: ${a.snap.id}\nRight: ${b.snap.id}\n\n`;
  md += `| Type | Count |\n|---|---:|\n| Added | ${diff.added.length} |\n| Removed | ${diff.removed.length} |\n| Changed | ${diff.changed.length} |\n| Unchanged | ${diff.unchanged.length} |\n\n`;
  if (diff.changed.length) {
    md += `## Changed\n\n`;
    for (const c of diff.changed.slice(0, 300)) md += `- \`${c.after.path}\`\n`;
    if (diff.changed.length > 300) md += `- ... ${diff.changed.length - 300} more\n`;
    md += '\n';
  }
  if (diff.added.length) {
    md += `## Added in right\n\n`;
    for (const f of diff.added.slice(0, 300)) md += `- \`${f.path}\`\n`;
    if (diff.added.length > 300) md += `- ... ${diff.added.length - 300} more\n`;
    md += '\n';
  }
  if (diff.removed.length) {
    md += `## Removed from right\n\n`;
    for (const f of diff.removed.slice(0, 300)) md += `- \`${f.path}\`\n`;
    if (diff.removed.length > 300) md += `- ... ${diff.removed.length - 300} more\n`;
    md += '\n';
  }
  await writeText(mdFile, md);

  console.log(`Added: ${diff.added.length}`);
  console.log(`Removed: ${diff.removed.length}`);
  console.log(`Changed: ${diff.changed.length}`);
  console.log(`Reports: ${mdFile}`);
}

async function commandSetWorking(root, idOrName, flags) {
  if (!idOrName) throw new Error('Usage: pk-client set-working <snapshot-id-or-name> [--force]');
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const snap = findSnapshot(root, idOrName);
  if (!snap) throw new Error(`Snapshot not found: ${idOrName}`);
  const sourceDir = snap.source_dir || path.join(p.rawDownloads, snap.id, 'source');
  if (!isDir(sourceDir)) throw new Error(`Snapshot source missing: ${sourceDir}`);

  if (exists(p.workingTree)) {
    const backupName = `${safeDateStamp()}_before_set-working_${slugify(snap.name)}`;
    const backupDir = path.join(p.frozenSnapshots, backupName);
    await copyRecursive(p.workingTree, backupDir, { skipPatterns: ['node_modules/**', '.git/**'] });
    if (!flags.force) {
      console.log(`Existing working tree backed up to: ${backupDir}`);
    }
    await fsp.rm(p.workingTree, { recursive: true, force: true });
  }

  await copyRecursive(sourceDir, p.workingTree, { skipPatterns: ['node_modules/**', '.git/**'] });
  const manifest = await manifestForDir(p.workingTree, { skipPatterns: ['node_modules/**', '.git/**'] });
  await writeJson(p.workingMeta, {
    created_at: nowIso(),
    source_snapshot_id: snap.id,
    source_snapshot_name: snap.name,
    working_tree: p.workingTree,
    baseline_manifest: manifest
  });
  console.log(`Working tree set from snapshot: ${snap.id}`);
  console.log(`Working tree: ${p.workingTree}`);
}

async function commandPatchAdd(root, patchPath, flags) {
  if (!patchPath) throw new Error('Usage: pk-client patch add <patch-file> [--status pending|applied|rejected|superseded]');
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const abs = path.resolve(patchPath);
  if (!isFile(abs)) throw new Error(`Patch file not found: ${abs}`);
  const status = String(flags.status || 'pending').toLowerCase();
  const targetDir = {
    pending: p.patchesPending,
    applied: p.patchesApplied,
    rejected: p.patchesRejected,
    superseded: p.patchesSuperseded
  }[status];
  if (!targetDir) throw new Error('Invalid patch status. Use pending, applied, rejected, or superseded.');
  const destName = `${safeDateStamp()}_${slugify(path.basename(abs))}`;
  const dest = path.join(targetDir, destName);
  await fsp.copyFile(abs, dest);
  const sha = await sha256File(dest);
  await writeJson(`${dest}.meta.json`, {
    added_at: nowIso(),
    source_path: abs,
    status,
    sha256: sha,
    size: (await fsp.stat(dest)).size
  });
  console.log(`Patch added: ${dest}`);
}

async function commandDetect(root, target, flags) {
  // Shared project-detection entrypoint. Customers + action.yml both
  // consume this so the substrate's understanding of "what kind of
  // project is this" stays consistent across every PlaneKey tool.
  const detect = require('../lib/detect.js');
  const at = target ? path.resolve(target) : (root || process.cwd());
  const result = detect.detectProject(at);
  if (flags && flags.table) {
    console.log('root:        ' + result.root);
    console.log('kind:        ' + result.kind);
    console.log('entry-point: ' + (result.entryPoint || '(none)'));
    if (result.label) console.log('label:       ' + result.label);
    if (result.entries && result.entries.length > 1) {
      console.log('all matches:');
      for (const m of result.entries) console.log('  - ' + m.kind.padEnd(8) + ' ' + m.entry);
    }
    if (result.signals && result.signals.manifestFiles.length) {
      console.log('manifests:   ' + result.signals.manifestFiles.join(', '));
    }
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// `pk-client docs` — opens pk-docs.sqlbook in the local sqlbooks reader
//
// Per docs/HANDOFF-sqlbooks.md:
//   - The reader is at sqlbooks/reader/index.html (vanilla JS + sql.js)
//   - The book is at planekey-site/pk-docs.sqlbook (3 tables: book/section/xref,
//     136 sections of content)
//   - The free tier exists primarily to deliver users into the docs
//
// Usage:
//   pk-client docs                       open in browser at the TOC
//   pk-client docs <slug>                open at the given section anchor
//   pk-client docs --list                print chapter/slug/title to stdout
//   pk-client docs --search "<term>"     filter sections by LIKE on body_md
//   pk-client docs --port 8765           override the local server port
//   pk-client docs --no-open             start the server but don't open browser
//
// Implementation: starts a tiny localhost HTTP server because browsers block
// file:// → file:// fetches (sql.js needs to fetch the .sqlbook). Server
// shuts itself down after 30 min of inactivity or on SIGINT.
async function commandDocs(root, slugOrFlag, flags) {
  flags = flags || {};
  // Two real arg shapes:
  //   pk-client docs            → slugOrFlag undefined, flags={}
  //   pk-client docs bean       → slugOrFlag='bean'
  //   pk-client docs --list     → slugOrFlag undefined (flag was caught earlier)
  //   pk-client docs --search "x" → flags.search is set
  const projectRoot = root || process.cwd();

  // 1. Resolve the sqlbook + reader paths.
  //    Look in workspace first, then walk up.
  const candidates = [
    path.join(projectRoot, 'planekey-site', 'pk-docs.sqlbook'),
    path.join(projectRoot, 'pk-docs.sqlbook'),
    path.join(__dirname, '..', '..', 'planekey-site', 'pk-docs.sqlbook'),
  ];
  const sqlbookPath = candidates.find(isFile);
  if (!sqlbookPath) {
    console.error('pk-client docs: could not find pk-docs.sqlbook (looked in: '
      + candidates.join(', ') + ')');
    process.exit(2);
  }

  const readerRootCandidates = [
    path.join(projectRoot, 'sqlbooks', 'reader'),
    path.join(__dirname, '..', '..', 'sqlbooks', 'reader'),
  ];
  const readerRoot = readerRootCandidates.find((d) => isFile(path.join(d, 'index.html')));
  if (!readerRoot) {
    console.error('pk-client docs: could not find sqlbooks/reader/ (looked in: '
      + readerRootCandidates.join(', ') + ')');
    process.exit(2);
  }

  // 2. --list / --search → run as direct sqlite queries via `sqlite3` binary.
  //    Falls back to opening browser if sqlite3 isn't installed.
  if (flags.list || flags.search) {
    const cp = require('child_process');
    let sql;
    if (flags.search) {
      const term = String(flags.search).replace(/'/g, "''");
      sql = `SELECT chapter || '|' || slug || '|' || title FROM section
             WHERE status != 'deprecated' AND (
               body_md LIKE '%${term}%' OR title LIKE '%${term}%' OR slug LIKE '%${term}%'
             ) ORDER BY chapter, ord;`;
    } else {
      sql = `SELECT chapter || '|' || slug || '|' || title FROM section
             WHERE status != 'draft' AND status != 'deprecated'
             ORDER BY chapter, ord;`;
    }
    try {
      const out = cp.execFileSync('sqlite3', [sqlbookPath, sql], { encoding: 'utf8' });
      const lines = out.split('\n').filter(Boolean);
      let currentChapter = '';
      for (const line of lines) {
        const [chap, slug, title] = line.split('|');
        if (chap !== currentChapter) {
          console.log('');
          console.log('▶ ' + chap);
          currentChapter = chap;
        }
        console.log('  ' + slug.padEnd(36) + ' ' + title);
      }
      if (!lines.length) console.log('(no matches)');
      return;
    } catch (err) {
      console.error('pk-client docs --list/--search needs the `sqlite3` binary on PATH. Falling back to opening the browser. ('
        + (err.message || err) + ')');
      // fall through to server-spawn path
    }
  }

  // 3. Start a tiny static HTTP server on a chosen port. Serves /reader/...
  //    out of readerRoot and /pk-docs.sqlbook out of sqlbookPath.
  const http = require('http');
  const port = Number(flags.port || 0); // 0 = OS picks
  const server = http.createServer((req, res) => {
    let urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/') urlPath = '/reader/index.html';
    if (urlPath === '/reader' || urlPath === '/reader/') urlPath = '/reader/index.html';

    if (urlPath === '/pk-docs.sqlbook') {
      try {
        const buf = fs.readFileSync(sqlbookPath);
        res.writeHead(200, { 'content-type': 'application/x-sqlite3', 'content-length': buf.length });
        return res.end(buf);
      } catch (err) {
        res.writeHead(500); return res.end('read failed');
      }
    }
    if (urlPath.startsWith('/reader/')) {
      const file = urlPath.slice('/reader/'.length);
      const full = path.join(readerRoot, file.replace(/\.\./g, ''));
      try {
        const buf = fs.readFileSync(full);
        const ct = full.endsWith('.html') ? 'text/html; charset=utf-8'
                 : full.endsWith('.js') ? 'application/javascript'
                 : full.endsWith('.css') ? 'text/css'
                 : full.endsWith('.sqlbook') ? 'application/x-sqlite3'
                 : 'application/octet-stream';
        res.writeHead(200, { 'content-type': ct, 'content-length': buf.length });
        return res.end(buf);
      } catch (err) {
        res.writeHead(404); return res.end('not found');
      }
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const realPort = server.address().port;

  // 4. Build the URL: reader, with ?book pointing at our served sqlbook,
  //    and #slug if a slug was supplied positionally.
  const slug = (slugOrFlag && !slugOrFlag.startsWith('--')) ? slugOrFlag : null;
  const url = `http://127.0.0.1:${realPort}/reader/index.html?book=/pk-docs.sqlbook`
            + (slug ? ('#' + slug) : '');

  console.log('pk-client docs: serving on ' + url);
  console.log('  reader:  ' + readerRoot);
  console.log('  sqlbook: ' + sqlbookPath);
  console.log('Press Ctrl+C to stop.');

  // 5. Open the URL unless --no-open. Best-effort across platforms.
  if (!flags['no-open']) {
    const cp = require('child_process');
    const cmd = process.platform === 'darwin' ? 'open'
             : process.platform === 'win32' ? 'start'
             : 'xdg-open';
    try {
      const child = cp.spawn(cmd, [url], { detached: true, stdio: 'ignore' });
      child.on('error', () => {
        // No GUI / no opener (sandbox, CI, headless server). User can
        // copy the URL printed above. Don't crash the server process.
      });
      child.unref();
    } catch (err) { /* same fallback path */ }
  }

  // 6. Auto-shutdown after 30 min idle. (Keeps the process clean if the
  //    user forgets it in the background.)
  let lastReq = Date.now();
  server.on('request', () => { lastReq = Date.now(); });
  const idleTimer = setInterval(() => {
    if (Date.now() - lastReq > 30 * 60 * 1000) {
      console.log('pk-client docs: 30 min idle, shutting down.');
      server.close(); clearInterval(idleTimer);
    }
  }, 60 * 1000);

  // 7. Clean shutdown on Ctrl+C.
  process.on('SIGINT', () => {
    console.log('\npk-client docs: stopping.');
    server.close(); clearInterval(idleTimer);
    process.exit(0);
  });
}

async function commandStatus(root) {
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const index = loadSnapshotsIndex(root);
  const workingMeta = readJsonIfExists(p.workingMeta, null);
  const countFiles = async (dir) => isDir(dir) ? (await walkFiles(dir)).length : 0;
  console.log(`PlaneKey Client v${VERSION}`);
  console.log(`Workspace: ${root}`);
  console.log(`Project: ${config.project}`);
  console.log(`Snapshots: ${index.snapshots.length}`);
  console.log(`Working tree: ${exists(p.workingTree) ? p.workingTree : '(not set)'}`);
  if (workingMeta) console.log(`Working source: ${workingMeta.source_snapshot_id}`);
  console.log(`Pending patches: ${await countFiles(p.patchesPending)}`);
  console.log(`Outgoing bundles: ${await countFiles(p.bundlesOutgoing)}`);
}

async function commandWorkingManifest(root) {
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  if (!isDir(p.workingTree)) throw new Error(`Working tree not found: ${p.workingTree}`);
  const manifest = await manifestForDir(p.workingTree, { skipPatterns: ['node_modules/**', '.git/**'] });
  const out = path.join(p.inventory, 'working_manifest.json');
  await writeJson(out, manifest);
  console.log(`Working manifest written: ${out}`);
}

async function commandBundleCreate(root, name, flags) {
  if (!name) throw new Error('Usage: pk-client bundle create <name> [--base snapshot-id] [--allow file1,file2]');
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  if (!isDir(p.workingTree)) throw new Error(`Working tree not found. Use pk-client set-working first.`);

  const workingMeta = readJsonIfExists(p.workingMeta, null);
  const baseId = flags.base || (workingMeta && workingMeta.source_snapshot_id);
  if (!baseId) throw new Error('No base snapshot known. Use --base <snapshot-id> or run set-working first.');

  const base = await loadSnapshotManifest(root, baseId);
  const after = await manifestForDir(p.workingTree, { skipPatterns: ['node_modules/**', '.git/**'] });
  const diff = diffManifests(base.manifest, after);
  const bundleId = `${safeDateStamp()}_${slugify(name)}`;
  const bundleRoot = path.join(p.bundlesOutgoing, bundleId);
  const filesRoot = path.join(bundleRoot, 'files');
  await fsp.mkdir(filesRoot, { recursive: true });

  const changedPaths = [
    ...diff.added.map((f) => f.path),
    ...diff.changed.map((c) => c.after.path)
  ].sort();
  for (const rel of changedPaths) {
    const src = path.join(p.workingTree, rel);
    const dest = path.join(filesRoot, rel);
    if (isFile(src)) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
    }
  }

  const allowedFiles = flags.allow
    ? String(flags.allow).split(',').map((s) => s.trim()).filter(Boolean)
    : config.defaultAllowedFiles;

  const forbiddenHits = changedPaths.filter((rel) => matchesAny(rel, config.defaultForbiddenPaths));
  const outsideAllowed = changedPaths.filter((rel) => !matchesAny(rel, allowedFiles));
  const rabbitReport = rootRabbitPreflight(p.workingTree, config, {
    changedPaths,
    requireInstalled: !!flags.requireRabbit
  });
  const safetyReport = safetyNetPreflight(p.workingTree, config, {
    changedPaths,
    requireRabbit: !!flags.requireRabbit
  });
  const request = {
    bundle_id: bundleId,
    created_at: nowIso(),
    created_by: 'planekey-client',
    project: config.project,
    intent: String(flags.intent || name),
    base_snapshot_id: base.snap.id,
    working_tree: p.workingTree,
    apply_mode: 'manual_approval_only',
    requires_backup: true,
    requires_hash_match: true,
    allowed_files: allowedFiles,
    forbidden_paths: config.defaultForbiddenPaths,
    changed_file_count: changedPaths.length,
    removed_file_count: diff.removed.length,
    validation: {
      forbidden_hits: forbiddenHits,
      outside_allowed_files: outsideAllowed,
      rootrabbit_status: rabbitReport.status,
      rootrabbit_blocking: rabbitReport.blocking,
      rootrabbit_warnings: rabbitReport.warnings,
      rootrabbit_impact_hits: rabbitReport.impact_hits,
      safetynet_status: safetyReport.status,
      safetynet_blocking: safetyReport.blocking,
      safetynet_warnings: safetyReport.warnings,
      hutch_status: safetyReport.hutch.status,
      flight_status: safetyReport.flight.status,
      safe_to_submit: forbiddenHits.length === 0 && outsideAllowed.length === 0 && rabbitReport.safe_for_bundle && safetyReport.safe_for_bundle
    }
  };

  await writeJson(path.join(bundleRoot, 'request.json'), request);
  await writeJson(path.join(bundleRoot, 'manifest.before.json'), base.manifest);
  await writeJson(path.join(bundleRoot, 'manifest.after.json'), after);
  await writeJson(path.join(bundleRoot, 'changed-files.json'), { changedPaths, removed: diff.removed.map((f) => f.path), diff });
  await writeJson(path.join(bundleRoot, 'rootrabbit-preflight.json'), rabbitReport);
  await writeText(path.join(bundleRoot, 'ROOTRABBIT_PREFLIGHT.md'), rootRabbitMarkdown(rabbitReport));
  await writeJson(path.join(bundleRoot, 'safetynet-preflight.json'), safetyReport);
  await writeText(path.join(bundleRoot, 'SAFETYNET_PREFLIGHT.md'), safetyNetMarkdown(safetyReport));

  let notes = `# PlaneKey Bundle\n\nBundle: ${bundleId}\nCreated: ${request.created_at}\nBase: ${base.snap.id}\n\n`;
  notes += `## Summary\n\n- Added: ${diff.added.length}\n- Changed: ${diff.changed.length}\n- Removed: ${diff.removed.length}\n- Forbidden hits: ${forbiddenHits.length}\n- Outside allowed: ${outsideAllowed.length}\n- RootRabbit status: ${rabbitReport.status}\n- RootRabbit blocking issues: ${rabbitReport.blocking.length}\n- SafetyNet status: ${safetyReport.status}\n- SafetyNet blocking issues: ${safetyReport.blocking.length}\n\n`;
  if (forbiddenHits.length) notes += `## Forbidden hits\n\n${forbiddenHits.map((x) => `- \`${x}\``).join('\n')}\n\n`;
  if (outsideAllowed.length) notes += `## Outside allowed files\n\n${outsideAllowed.map((x) => `- \`${x}\``).join('\n')}\n\n`;
  if (rabbitReport.blocking.length) notes += `## RootRabbit blocking issues\n\n${rabbitReport.blocking.map((x) => `- ${x}`).join('\n')}\n\n`;
  if (rabbitReport.warnings.length) notes += `## RootRabbit warnings\n\n${rabbitReport.warnings.map((x) => `- ${x}`).join('\n')}\n\n`;
  if (safetyReport.blocking.length) notes += `## SafetyNet blocking issues\n\n${safetyReport.blocking.map((x) => `- ${x}`).join('\n')}\n\n`;
  if (safetyReport.warnings.length) notes += `## SafetyNet warnings\n\n${safetyReport.warnings.map((x) => `- ${x}`).join('\n')}\n\n`;
  notes += `## Changed files\n\n${changedPaths.map((x) => `- \`${x}\``).join('\n') || '- none'}\n`;
  await writeText(path.join(bundleRoot, 'notes.md'), notes);

  // Optional zip if system zip is available.
  const zipPath = path.join(p.bundlesOutgoing, `${bundleId}.zip`);
  const zip = run(process.platform === 'win32' ? 'powershell.exe' : 'zip',
    process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Compress-Archive -Path ${JSON.stringify(path.join(bundleRoot, '*'))} -DestinationPath ${JSON.stringify(zipPath)} -Force`]
      : ['-qr', zipPath, '.'],
    process.platform === 'win32' ? {} : { cwd: bundleRoot });
  if (zip.status === 0) request.zip_path = zipPath;
  await writeJson(path.join(bundleRoot, 'request.json'), request);

  console.log(`Bundle created: ${bundleRoot}`);
  if (request.zip_path) console.log(`Bundle zip: ${request.zip_path}`);
  console.log(`Safe to submit: ${request.validation.safe_to_submit ? 'yes' : 'NO - review notes.md'}`);
}

async function commandExportGithub(root, flags) {
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  if (!isDir(p.workingTree)) throw new Error(`Working tree not found. Use pk-client set-working first.`);
  const name = flags.name ? slugify(flags.name) : 'github-ready';
  const out = path.join(p.exports, name);
  await emptyDir(out);
  await copyRecursive(p.workingTree, out, { skipPatterns: config.exportExclude });

  const gitignore = `# PlaneKey / local-only\n.env\n.env.*\nnode_modules/\nplanekey-history/\ndebug/\nshell-snapshots/\nuploads/\ndatabase/\nsessions/\ntmp/\nlogs/\nvault/\ninventory/\npatches/\nbundles/\nreports/\nexports/\n*.zip\n*.rar\n*.7z\n*.pem\n*.key\n*.p12\n*.sqlite\n*.db\n`;
  await writeText(path.join(out, '.gitignore'), gitignore);
  if (!exists(path.join(out, '.env.example'))) {
    await writeText(path.join(out, '.env.example'), `# Copy to .env locally or configure these in Render.\n# Do not commit real secrets.\n\nNODE_ENV=production\nPORT=3000\nDATABASE_URL=\nSESSION_SECRET=\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\n`);
  }
  const manifest = await manifestForDir(out, { skipPatterns: ['node_modules/**', '.git/**'] });
  const rabbitReport = rootRabbitPreflight(out, config, { requireInstalled: !!flags.requireRabbit });
  const safetyReport = safetyNetPreflight(out, config, { requireRabbit: !!flags.requireRabbit });
  const repoGuardReport = await publicRepoPreflight(out, config);
  await writeJson(path.join(out, 'PLANKEY_EXPORT_MANIFEST.json'), manifest);
  await writeJson(path.join(out, 'ROOTRABBIT_PREFLIGHT.json'), rabbitReport);
  await writeText(path.join(out, 'ROOTRABBIT_PREFLIGHT.md'), rootRabbitMarkdown(rabbitReport));
  await writeJson(path.join(out, 'SAFETYNET_PREFLIGHT.json'), safetyReport);
  await writeText(path.join(out, 'SAFETYNET_PREFLIGHT.md'), safetyNetMarkdown(safetyReport));
  await writeJson(path.join(out, 'PUBLIC_REPOGUARD.json'), repoGuardReport);
  await writeText(path.join(out, 'PUBLIC_REPOGUARD.md'), publicRepoMarkdown(repoGuardReport));
  await writeText(path.join(out, 'PLANKEY_EXPORT_NOTE.md'), `# PlaneKey GitHub Export\n\nGenerated: ${nowIso()}\nSource working tree: ${p.workingTree}\nRootRabbit status: ${rabbitReport.status}\nSafetyNet status: ${safetyReport.status}\nRepoGuard status: ${repoGuardReport.status}\n\nThis export excludes local vaults, runtime folders, secrets, debug logs, shell snapshots, uploads, databases, dependency folders, and RootRabbit runtime nap records. Public repos should contain \`.env.example\` templates only; real secrets belong in Render environment variables or GitHub Secrets, not committed source. Sanitized \`REDACTED\` comparison literals are not secrets, but they are deploy-unsafe source placeholders.\n`);
  console.log(`GitHub-ready export written: ${out}`);
  console.log(`RootRabbit preflight: ${rabbitReport.status.toUpperCase()} (${rabbitReport.blocking.length} blocking, ${rabbitReport.warnings.length} warnings)`);
  console.log(`SafetyNet preflight: ${safetyReport.status.toUpperCase()} (${safetyReport.blocking.length} blocking, ${safetyReport.warnings.length} warnings)`);
  console.log(`RepoGuard preflight: ${repoGuardReport.status.toUpperCase()} (${repoGuardReport.blocking.length} blocking, ${repoGuardReport.warnings.length} warnings)`);
}


function normalizeActionPath(rawPath) {
  if (!rawPath) return null;
  let p = String(rawPath).trim().replace(/^['"]|['"]$/g, '');
  p = p.replace(/\\/g, '/');
  p = p.replace(/\.tmp\.\d+\.\d+$/, '');
  const markers = [
    '/conversationchain/',
    '/opt/render/project/src/',
    'conversationchain/',
    'ConversationChain_Master/'
  ];
  for (const marker of markers) {
    const idx = p.indexOf(marker);
    if (idx >= 0) {
      p = p.slice(idx + marker.length);
      break;
    }
  }
  p = p.replace(/^\.\//, '').replace(/^\/+/, '');
  if (!p || p.startsWith('opt/') || p.startsWith('tmp/')) return p || null;
  return p;
}

function actionPathRisk(rel) {
  if (!rel) return 'unknown';
  const lower = rel.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.') || lower.includes('secret') || lower.includes('credential') || lower.endsWith('.pem') || lower.endsWith('.key') || lower.includes('credentials.json') || lower.includes('service-account')) return 'secret/private';
  if (isAgentRuntimePath(lower)) return 'evidence/agent-runtime';
  if (lower.startsWith('debug/') || lower.startsWith('shell-snapshots/') || lower.startsWith('todos/')) return 'evidence/runtime';
  if (lower === 'server.js' || lower.startsWith('server/') || lower.startsWith('migrations/') || lower === 'package.json' || lower === 'package-lock.json' || lower === 'render.yaml') return 'high-code';
  if (lower.startsWith('admin/') || lower.startsWith('public/')) return 'ui-route-code';
  if (lower.startsWith('tools/')) return 'tooling';
  return 'normal';
}

function classifyActionKind(message) {
  if (/Failed to save config with lock|ENOENT.*\.claude|lstat .*\.claude|config with lock/i.test(message)) return 'agent_config_lock_error';
  if (/File .* written atomically/.test(message)) return 'atomic_write';
  if (/Writing to temp file:/.test(message)) return 'temp_write';
  if (/Renaming .* to /.test(message)) return 'rename_commit';
  if (/Creating snapshot at:/.test(message)) return 'shell_snapshot_created';
  if (/Applying permission update:/.test(message)) return 'permission_policy_update';
  if (/MCP server .*Initialized|Initialized for company|proxy mode|PROXY MODE/.test(message)) return 'mcp_service_init';
  if (/STRIPE_SECRET_KEY not configured|Stripe MCP|Stripe Service/.test(message)) return 'stripe_runtime_signal';
  if (/ERROR/.test(message)) return 'error';
  if (/WARN/.test(message)) return 'warning';
  return 'log_signal';
}

const AGENT_PROVIDER_RULES = [
  {
    id: 'anthropic_claude',
    label: 'Anthropic / Claude',
    text: /\b(claude|anthropic|claude-code|claude\.ai)\b|\.claude(?:\.json|\/)/i,
    path: /(^|\/)\.claude(?:\/|$)|(^|\/)\.claude\.json|claude/i
  },
  {
    id: 'openai',
    label: 'OpenAI / ChatGPT / Codex',
    text: /\b(openai|chatgpt|codex|gpt-4|gpt-5|responses api|assistants api|oai)\b|OPENAI_API_KEY/i,
    path: /(^|\/)(\.openai|openai)(\/|\.|$)|openai|codex/i
  },
  {
    id: 'google_gemini',
    label: 'Google / Gemini / Vertex',
    text: /\b(gemini|google ai|google-ai|vertex ai|vertexai|google generative|GOOGLE_API_KEY|GEMINI_API_KEY)\b/i,
    path: /(^|\/)(\.gemini|gemini|vertex|google-ai)(\/|\.|$)|google.*credentials|gemini/i
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    text: /\b(huggingface|hugging face|hf hub|transformers|HF_TOKEN|HUGGINGFACEHUB_API_TOKEN)\b/i,
    path: /(^|\/)(\.cache\/huggingface|\.huggingface|huggingface|hf)(\/|\.|$)/i
  },
  {
    id: 'ibm_watsonx',
    label: 'IBM / watsonx',
    text: /\b(ibm|watsonx|watson ai|IBM_CLOUD_API_KEY|WATSONX_APIKEY)\b/i,
    path: /(^|\/)(\.ibm|ibm|watsonx|watson)(\/|\.|$)/i
  },
  {
    id: 'microsoft_azure',
    label: 'Microsoft / Azure OpenAI',
    text: /\b(azure openai|azure ai|AZURE_OPENAI|AZURE_AI|cognitive services)\b/i,
    path: /(^|\/)(\.azure|azure)(\/|\.|$)/i
  },
  {
    id: 'aws_bedrock',
    label: 'AWS / Bedrock',
    text: /\b(bedrock|aws ai|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\b/i,
    path: /(^|\/)(\.aws|aws|bedrock)(\/|\.|$)/i
  },
  {
    id: 'meta_llama',
    label: 'Meta / Llama',
    text: /\b(llama|llama-\d|meta ai|llamaindex)\b/i,
    path: /(^|\/)(llama|llamaindex|meta-ai)(\/|\.|$)/i
  },
  {
    id: 'local_agents',
    label: 'Local agents / Ollama / LocalAI / LangChain',
    text: /\b(ollama|localai|langchain|llamaindex|autogen|crewai|agent runtime|tool call|mcp server)\b/i,
    path: /(^|\/)(\.ollama|ollama|localai|langchain|llamaindex|agents?)(\/|\.|$)/i
  }
];

function isAgentRuntimePath(lowerPath) {
  return /(^|\/)\.claude(\/|\.|$)/.test(lowerPath)
    || /(^|\/)\.openai(\/|\.|$)/.test(lowerPath)
    || /(^|\/)\.gemini(\/|\.|$)/.test(lowerPath)
    || /(^|\/)\.huggingface(\/|\.|$)/.test(lowerPath)
    || /(^|\/)\.cache\/huggingface(\/|$)/.test(lowerPath)
    || /(^|\/)\.ibm(\/|\.|$)/.test(lowerPath)
    || /(^|\/)\.azure(\/|\.|$)/.test(lowerPath)
    || /(^|\/)\.aws(\/|\.|$)/.test(lowerPath)
    || /(^|\/)(agents?|agent-state|mcp|llm-runtime|model-runtime)(\/|$)/.test(lowerPath);
}

function classifyAgentOperation(kind, message) {
  if (kind === 'agent_config_lock_error') return 'config_lock_error';
  if (kind === 'atomic_write') return 'config_atomic_write';
  if (kind === 'temp_write') return 'config_temp_write';
  if (kind === 'rename_commit') return 'config_rename_commit';
  if (/\b(Read|Loading|Loaded|ConfigFile|readFile)\b/i.test(message)) return 'config_read_or_load';
  if (/MCP server .*Initialized|Initialized for company|proxy mode|PROXY MODE/i.test(message)) return 'agent_service_init';
  if (/token|api[_-]?key|secret|credential/i.test(message)) return 'credential_signal';
  if (/error|failed|ENOENT|EACCES|EPERM/i.test(message)) return 'agent_error';
  return 'agent_runtime_signal';
}

function detectAgentSignals(message, filesHit) {
  const signals = [];
  const text = String(message || '');
  const paths = (filesHit || []).filter(Boolean);
  for (const rule of AGENT_PROVIDER_RULES) {
    const textHit = rule.text.test(text);
    const pathHits = paths.filter((p) => rule.path.test(String(p).toLowerCase()));
    if (textHit || pathHits.length) {
      signals.push({ provider: rule.id, label: rule.label, text_hit: !!textHit, paths: pathHits });
    }
  }
  const dedup = new Map();
  for (const s of signals) {
    if (!dedup.has(s.provider)) dedup.set(s.provider, s);
    else dedup.get(s.provider).paths = [...new Set([...(dedup.get(s.provider).paths || []), ...(s.paths || [])])];
  }
  return [...dedup.values()];
}

function medianNumber(values) {
  if (!values.length) return null;
  const nums = [...values].sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function summarizeAgentStorms(agentEvents) {
  const grouped = new Map();
  const writeOps = new Set(['config_atomic_write', 'config_temp_write', 'config_rename_commit', 'config_lock_error']);
  for (const ev of agentEvents) {
    const fileKey = (ev.files && ev.files[0]) || '(message-only)';
    const key = ev.provider + '|' + fileKey;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(ev);
  }
  const storms = [];
  for (const [key, evs] of grouped.entries()) {
    const [provider, file] = key.split('|');
    const writeEvents = evs.filter((e) => writeOps.has(e.operation));
    const times = writeEvents.map((e) => Date.parse(e.ts)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 1000);
    let burstMax10s = 0;
    for (let i = 0; i < times.length; i++) {
      let j = i;
      while (j < times.length && times[j] - times[i] <= 10000) j++;
      burstMax10s = Math.max(burstMax10s, j - i);
    }
    const lockErrors = evs.filter((e) => e.operation === 'config_lock_error').length;
    const tempWrites = evs.filter((e) => e.operation === 'config_temp_write').length;
    const atomicWrites = evs.filter((e) => e.operation === 'config_atomic_write').length;
    const renames = evs.filter((e) => e.operation === 'config_rename_commit').length;
    const medianGapSeconds = medianNumber(gaps);
    const severe = burstMax10s >= 10 || (writeEvents.length >= 100 && (medianGapSeconds === null || medianGapSeconds <= 1)) || lockErrors >= 10;
    const warning = severe || burstMax10s >= 5 || writeEvents.length >= 25 || lockErrors >= 3;
    if (warning) {
      storms.push({
        provider,
        file,
        severity: severe ? 'storm' : 'churn',
        total_events: evs.length,
        write_events: writeEvents.length,
        lock_errors: lockErrors,
        temp_writes: tempWrites,
        atomic_writes: atomicWrites,
        rename_commits: renames,
        max_write_burst_10s: burstMax10s,
        median_write_gap_seconds: medianGapSeconds,
        first_ts: evs.map((e) => e.ts).sort()[0] || null,
        last_ts: evs.map((e) => e.ts).sort().slice(-1)[0] || null,
        meaning: severe ? 'agent runtime persistence storm; do not treat this as app source activity' : 'agent runtime churn; keep as forensic evidence only'
      });
    }
  }
  return storms.sort((a, b) => (a.severity === b.severity ? b.write_events - a.write_events : (a.severity === 'storm' ? -1 : 1)));
}

function extractRoutesFromText(text) {
  const routes = new Set();
  const rx = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+((?:\/api|\/admin|\/app|\/legal|\/scientific|\/financial|\/terms)[^\s'"`),}]*)|(['"`])((?:\/api\/)[^'"`\s]+)\2/g;
  let m;
  while ((m = rx.exec(text))) {
    routes.add(m[1] || m[3]);
  }
  return [...routes].sort();
}

function extractFilesFromMessage(message) {
  const files = [];
  let m;
  const regexes = [
    /File\s+(.+?)\s+written atomically/g,
    /Writing to temp file:\s+(.+?)(?:\s|$)/g,
    /Renaming\s+(.+?)\s+to\s+(.+?)(?:\s|$)/g,
    /Creating snapshot at:\s+(.+?)(?:\s|$)/g,
    /(?:Read|Write|Edit)\(([^)]+)\)/g
  ];
  for (const rx of regexes) {
    while ((m = rx.exec(message))) {
      for (let i = 1; i < m.length; i++) {
        if (!m[i]) continue;
        const rel = normalizeActionPath(m[i]);
        if (rel) files.push(rel);
      }
    }
  }
  return [...new Set(files)];
}

function parseDebugLine(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+\[([^\]]+)\]\s+(.*)$/);
  if (!m) return null;
  return { ts: m[1], level: m[2], message: m[3] };
}

async function resolveDebugInput(root, input, flags) {
  if (!input) {
    const config = loadConfig(root);
    const p = paths(root, config);
    const workingDebug = path.join(p.workingTree, 'debug');
    if (isDir(workingDebug)) return { sourceRoot: p.workingTree, debugDirs: [workingDebug], shellDirs: [path.join(p.workingTree, 'shell-snapshots')].filter(isDir), tempRoot: null };
    throw new Error('Usage: pk-client debug map <debug-folder-or-full-export.zip> [--name report-name] [--base canon-folder]');
  }
  const abs = path.resolve(input);
  const config = loadConfig(root);
  const p = paths(root, config);
  const name = flags.name ? slugify(flags.name) : 'debug-map-' + safeDateStamp();
  if (isFile(abs) && abs.toLowerCase().endsWith('.zip')) {
    const tempRoot = path.join(p.debugReports, name + '-extract');
    await emptyDir(tempRoot);
    await extractZip(abs, tempRoot);
    const normalized = await normalizedSourceDir(tempRoot);
    const debugDirs = [];
    const shellDirs = [];
    const dirs = await walkFiles(normalized, { includeDirs: true });
    if (isDir(path.join(normalized, 'debug'))) debugDirs.push(path.join(normalized, 'debug'));
    if (isDir(path.join(normalized, 'shell-snapshots'))) shellDirs.push(path.join(normalized, 'shell-snapshots'));
    for (const d of dirs.filter((x) => x.type === 'dir')) {
      if (d.rel.endsWith('/debug') || d.rel === 'debug') debugDirs.push(d.abs);
      if (d.rel.endsWith('/shell-snapshots') || d.rel === 'shell-snapshots') shellDirs.push(d.abs);
    }
    return { sourceRoot: normalized, debugDirs: [...new Set(debugDirs)], shellDirs: [...new Set(shellDirs)], tempRoot };
  }
  if (isDir(abs)) {
    const base = path.basename(abs).toLowerCase();
    if (base === 'debug') return { sourceRoot: path.dirname(abs), debugDirs: [abs], shellDirs: [path.join(path.dirname(abs), 'shell-snapshots')].filter(isDir), tempRoot: null };
    const debugDirs = [];
    const shellDirs = [];
    if (isDir(path.join(abs, 'debug'))) debugDirs.push(path.join(abs, 'debug'));
    if (isDir(path.join(abs, 'shell-snapshots'))) shellDirs.push(path.join(abs, 'shell-snapshots'));
    const dirs = await walkFiles(abs, { includeDirs: true });
    for (const d of dirs.filter((x) => x.type === 'dir')) {
      if (d.rel.endsWith('/debug') || d.rel === 'debug') debugDirs.push(d.abs);
      if (d.rel.endsWith('/shell-snapshots') || d.rel === 'shell-snapshots') shellDirs.push(d.abs);
    }
    return { sourceRoot: abs, debugDirs: [...new Set(debugDirs)], shellDirs: [...new Set(shellDirs)], tempRoot: null };
  }
  throw new Error('Debug input not found or unsupported: ' + abs);
}

async function buildDebugActionMap(sourceRoot, debugDirs, shellDirs, options = {}) {
  const sessionReports = [];
  const actions = [];
  const fileMap = new Map();
  const routeSet = new Set();
  const serviceMap = new Map();
  const agentEvents = [];
  const agentProviderMap = new Map();
  const agentFileMap = new Map();
  let lineCount = 0;
  let errorCount = 0;
  let warnCount = 0;

  for (const debugDir of debugDirs) {
    const files = (await walkFiles(debugDir)).filter((f) => f.rel.toLowerCase().endsWith('.txt'));
    for (const f of files) {
      const logId = path.basename(f.abs, path.extname(f.abs));
      const text = await fsp.readFile(f.abs, 'utf8').catch(() => '');
      const lines = text.split(/\r?\n/);
      let firstTs = null;
      let lastTs = null;
      let writes = 0;
      let tempWrites = 0;
      let renames = 0;
      let errors = 0;
      let warnings = 0;
      const touched = new Set();
      const sessionRoutes = new Set();
      const sessionServices = new Set();
      const sessionAgents = new Set();
      for (let idx = 0; idx < lines.length; idx++) {
        const parsed = parseDebugLine(lines[idx]);
        if (!parsed) continue;
        lineCount++;
        if (!firstTs) firstTs = parsed.ts;
        lastTs = parsed.ts;
        if (parsed.level === 'ERROR') { errorCount++; errors++; }
        if (parsed.level === 'WARN' || parsed.level === 'WARNING') { warnCount++; warnings++; }
        const kind = classifyActionKind(parsed.message);
        const filesHit = extractFilesFromMessage(parsed.message);
        const routes = extractRoutesFromText(parsed.message);
        routes.forEach((r) => { routeSet.add(r); sessionRoutes.add(r); });
        const svc = parsed.message.match(/MCP server "([^"]+)"|\[([^\]]*MCP[^\]]*)\]/);
        if (svc) {
          const service = svc[1] || svc[2];
          sessionServices.add(service);
          serviceMap.set(service, (serviceMap.get(service) || 0) + 1);
        }
        const agentSignals = detectAgentSignals(parsed.message, filesHit);
        if (agentSignals.length) {
          for (const sig of agentSignals) {
            sessionAgents.add(sig.provider);
            agentProviderMap.set(sig.provider, (agentProviderMap.get(sig.provider) || 0) + 1);
            const operation = classifyAgentOperation(kind, parsed.message);
            const ev = {
              ts: parsed.ts,
              log_id: logId,
              source_file: relUnix(sourceRoot, f.abs),
              line: idx + 1,
              provider: sig.provider,
              label: sig.label,
              operation,
              kind,
              files: sig.paths.length ? sig.paths : filesHit.filter((x) => isAgentRuntimePath(String(x).toLowerCase())),
              text_hit: sig.text_hit,
              message_sample: parsed.message.slice(0, 300)
            };
            agentEvents.push(ev);
            for (const ap of ev.files) {
              if (!agentFileMap.has(ap)) agentFileMap.set(ap, { path: ap, providers: new Set(), events: 0, writes: 0, lock_errors: 0, first_ts: parsed.ts, last_ts: parsed.ts });
              const rec = agentFileMap.get(ap);
              rec.providers.add(sig.provider);
              rec.events++;
              if (operation.startsWith('config_')) rec.writes++;
              if (operation === 'config_lock_error') rec.lock_errors++;
              rec.first_ts = rec.first_ts && rec.first_ts < parsed.ts ? rec.first_ts : parsed.ts;
              rec.last_ts = rec.last_ts && rec.last_ts > parsed.ts ? rec.last_ts : parsed.ts;
            }
          }
        }
        if (kind === 'atomic_write') writes++;
        if (kind === 'temp_write') tempWrites++;
        if (kind === 'rename_commit') renames++;
        if (filesHit.length || routes.length || agentSignals.length || kind !== 'log_signal') {
          const action = {
            ts: parsed.ts,
            log_id: logId,
            source_file: relUnix(sourceRoot, f.abs),
            line: idx + 1,
            level: parsed.level,
            kind,
            files: filesHit,
            routes,
            agent_signals: agentSignals.map((s) => s.provider),
            risk: filesHit.map(actionPathRisk).includes('secret/private') ? 'secret/private' : (filesHit.map(actionPathRisk).includes('high-code') ? 'high-code' : (filesHit.map(actionPathRisk).includes('ui-route-code') ? 'ui-route-code' : (kind === 'error' ? 'error' : 'evidence'))),
            message_sample: parsed.message.slice(0, 300)
          };
          actions.push(action);
        }
        for (const rel of filesHit) {
          touched.add(rel);
          if (!fileMap.has(rel)) fileMap.set(rel, { path: rel, touches: 0, atomic_writes: 0, temp_writes: 0, rename_commits: 0, logs: new Set(), first_ts: parsed.ts, last_ts: parsed.ts, risk: actionPathRisk(rel), exists_in_base: null, base_sha256: null });
          const rec = fileMap.get(rel);
          rec.touches++;
          rec.logs.add(logId);
          rec.first_ts = rec.first_ts && rec.first_ts < parsed.ts ? rec.first_ts : parsed.ts;
          rec.last_ts = rec.last_ts && rec.last_ts > parsed.ts ? rec.last_ts : parsed.ts;
          if (kind === 'atomic_write') rec.atomic_writes++;
          if (kind === 'temp_write') rec.temp_writes++;
          if (kind === 'rename_commit') rec.rename_commits++;
        }
      }
      sessionReports.push({
        log_id: logId,
        source_file: relUnix(sourceRoot, f.abs),
        bytes: (await fsp.stat(f.abs)).size,
        first_ts: firstTs,
        last_ts: lastTs,
        parsed_lines: lines.length,
        action_lines: writes + tempWrites + renames,
        atomic_writes: writes,
        temp_writes: tempWrites,
        rename_commits: renames,
        errors,
        warnings,
        touched_files: [...touched].sort(),
        routes: [...sessionRoutes].sort(),
        services: [...sessionServices].sort(),
        agents: [...sessionAgents].sort()
      });
    }
  }

  const shellSnapshots = [];
  for (const shellDir of shellDirs) {
    const files = await walkFiles(shellDir);
    for (const f of files) {
      const text = await fsp.readFile(f.abs, 'utf8').catch(() => '');
      const pathLine = (text.match(/^export PATH=(.*)$/m) || [])[1] || '';
      shellSnapshots.push({ file: relUnix(sourceRoot, f.abs), bytes: (await fsp.stat(f.abs)).size, has_render_path: pathLine.includes('/opt/render/project'), has_node_modules_bin: pathLine.includes('node_modules/.bin'), path_sample: pathLine.slice(0, 300) });
    }
  }

  if (options.baseDir && isDir(options.baseDir)) {
    for (const rec of fileMap.values()) {
      const baseFile = path.join(options.baseDir, rec.path);
      rec.exists_in_base = isFile(baseFile);
      if (rec.exists_in_base) rec.base_sha256 = await sha256File(baseFile).catch(() => null);
    }
  }

  const touchedFiles = [...fileMap.values()].map((x) => ({ ...x, logs: [...x.logs].sort() })).sort((a, b) => {
    const riskOrder = { 'secret/private': 0, 'high-code': 1, 'ui-route-code': 2, tooling: 3, normal: 4, 'evidence/runtime': 5, unknown: 6 };
    return (riskOrder[a.risk] ?? 9) - (riskOrder[b.risk] ?? 9) || b.touches - a.touches || a.path.localeCompare(b.path);
  });

  const highRisk = touchedFiles.filter((f) => ['secret/private', 'high-code', 'ui-route-code'].includes(f.risk));
  const routeActions = actions.filter((a) => a.routes.length || a.files.some((f) => f === 'server.js' || f.startsWith('server/') || f.startsWith('admin/') || f.startsWith('public/')));
  const agentRuntimeFiles = [...agentFileMap.values()].map((x) => ({ ...x, providers: [...x.providers].sort() })).sort((a, b) => b.events - a.events || a.path.localeCompare(b.path));
  const agentProviders = [...agentProviderMap.entries()].map(([provider, count]) => {
    const rule = AGENT_PROVIDER_RULES.find((r) => r.id === provider);
    return { provider, label: rule ? rule.label : provider, count };
  }).sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));
  const agentPersistenceStorms = summarizeAgentStorms(agentEvents);
  return {
    generated_at: nowIso(),
    client_version: VERSION,
    source_root: sourceRoot,
    debug_dirs: debugDirs,
    shell_dirs: shellDirs,
    summary: {
      debug_file_count: sessionReports.length,
      parsed_log_lines: lineCount,
      action_count: actions.length,
      touched_file_count: touchedFiles.length,
      high_risk_touched_file_count: highRisk.length,
      route_signal_count: routeSet.size,
      shell_snapshot_count: shellSnapshots.length,
      error_count: errorCount,
      warning_count: warnCount,
      agent_event_count: agentEvents.length,
      agent_provider_count: agentProviders.length,
      agent_runtime_file_count: agentRuntimeFiles.length,
      agent_persistence_storm_count: agentPersistenceStorms.length
    },
    sessions: sessionReports.sort((a, b) => String(a.first_ts || '').localeCompare(String(b.first_ts || ''))),
    touched_files: touchedFiles,
    routes: [...routeSet].sort(),
    services: [...serviceMap.entries()].map(([service, count]) => ({ service, count })).sort((a, b) => b.count - a.count || a.service.localeCompare(b.service)),
    agent_providers: agentProviders,
    agent_runtime_files: agentRuntimeFiles,
    agent_persistence_storms: agentPersistenceStorms,
    agent_events: agentEvents.sort((a, b) => String(a.ts).localeCompare(String(b.ts))).slice(0, options.maxActions || 5000),
    actions: actions.sort((a, b) => String(a.ts).localeCompare(String(b.ts))).slice(0, options.maxActions || 5000),
    route_actions: routeActions.slice(0, options.maxActions || 5000),
    shell_snapshots: shellSnapshots
  };
}

function debugActionMapMarkdown(map) {
  let md = '# PlaneKey Debug Action Map\n\n';
  md += '- Generated: `' + map.generated_at + '`\n';
  md += '- Source root: `' + map.source_root + '`\n';
  md += '- Debug files: `' + map.summary.debug_file_count + '`\n';
  md += '- Parsed log lines: `' + map.summary.parsed_log_lines + '`\n';
  md += '- Extracted actions: `' + map.summary.action_count + '`\n';
  md += '- Touched files: `' + map.summary.touched_file_count + '`\n';
  md += '- High-risk touched files: `' + map.summary.high_risk_touched_file_count + '`\n';
  md += '- Route signals: `' + map.summary.route_signal_count + '`\n';
  md += '- Errors: `' + map.summary.error_count + '`\n\n';
  md += '## Meaning\n\nThis report maps what the Polsia/PlaneKey sessions appear to have touched. It does **not** replay actions and it is not deployable source. Treat it as forensic evidence to compare against your canon project base before grafting updates.\n\n';
  md += '## Agent/runtime signals\n\n';
  md += '- Agent events: `' + (map.summary.agent_event_count || 0) + '`\n';
  md += '- Agent providers: `' + (map.summary.agent_provider_count || 0) + '`\n';
  md += '- Agent runtime files: `' + (map.summary.agent_runtime_file_count || 0) + '`\n';
  md += '- Persistence storms/churn groups: `' + (map.summary.agent_persistence_storm_count || 0) + '`\n\n';
  if (map.agent_providers && map.agent_providers.length) {
    md += '### Providers seen\n\n';
    for (const p of map.agent_providers.slice(0, 30)) md += '- `' + p.label + '` (`' + p.provider + '`) count `' + p.count + '`\n';
    md += '\n';
  }
  if (map.agent_persistence_storms && map.agent_persistence_storms.length) {
    md += '### Persistence storms / config churn\n\n';
    for (const st of map.agent_persistence_storms.slice(0, 50)) md += '- `' + st.provider + '` file `' + st.file + '` severity `' + st.severity + '` writes `' + st.write_events + '` lock_errors `' + st.lock_errors + '` burst10s `' + st.max_write_burst_10s + '` median_gap_s `' + st.median_write_gap_seconds + '` — ' + st.meaning + '\n';
    md += '\n';
  }
  if (map.agent_runtime_files && map.agent_runtime_files.length) {
    md += '### Agent runtime files\n\n';
    for (const f of map.agent_runtime_files.slice(0, 80)) md += '- `' + f.path + '` providers `' + f.providers.join('|') + '` events `' + f.events + '` writes `' + f.writes + '` lock_errors `' + f.lock_errors + '`\n';
    md += '\n';
  }
  md += '## High-risk touched files\n\n';
  const high = map.touched_files.filter((f) => ['secret/private', 'high-code', 'ui-route-code'].includes(f.risk)).slice(0, 80);
  if (!high.length) md += '- none detected\n';
  for (const f of high) md += '- `' + f.path + '` risk `' + f.risk + '` touches `' + f.touches + '` atomic `' + f.atomic_writes + '` base `' + (f.exists_in_base === null ? 'not checked' : (f.exists_in_base ? 'exists' : 'missing')) + '`\n';
  md += '\n## Route/API signals\n\n';
  if (!map.routes.length) md += '- none detected\n';
  for (const r of map.routes.slice(0, 120)) md += '- `' + r + '`\n';
  md += '\n## Services seen\n\n';
  if (!map.services.length) md += '- none detected\n';
  for (const s of map.services.slice(0, 80)) md += '- `' + s.service + '` count `' + s.count + '`\n';
  md += '\n## Session timeline\n\n';
  for (const sess of map.sessions.slice(0, 120)) {
    md += '- `' + sess.log_id + '` `' + (sess.first_ts || 'n/a') + '` → `' + (sess.last_ts || 'n/a') + '` writes `' + sess.atomic_writes + '` temp `' + sess.temp_writes + '` renames `' + sess.rename_commits + '` errors `' + sess.errors + '` touched `' + sess.touched_files.length + '`\n';
  }
  md += '\n## Most-touched files\n\n';
  for (const f of [...map.touched_files].sort((a, b) => b.touches - a.touches).slice(0, 80)) md += '- `' + f.path + '` touches `' + f.touches + '` risk `' + f.risk + '` logs `' + f.logs.length + '`\n';
  return md;
}

async function commandDebugMap(root, input, flags) {
  await ensureWorkspace(root);
  if (!input) throw new Error('Usage: pk-client debug map <debug-folder-or-full-export.zip> [--name report-name] [--base canon-folder]');
  const config = loadConfig(root);
  const p = paths(root, config);
  const name = flags.name ? slugify(flags.name) : 'debug-action-map-' + safeDateStamp();
  const resolved = await resolveDebugInput(root, input, flags || {});
  if (!resolved.debugDirs.length) throw new Error('No debug directories found in: ' + input);
  const baseDir = flags.base ? path.resolve(flags.base) : null;
  const map = await buildDebugActionMap(resolved.sourceRoot, resolved.debugDirs, resolved.shellDirs, { baseDir, maxActions: Number(flags.maxActions || 5000) });
  const outDir = path.join(p.debugReports, name);
  if (exists(outDir) && !flags.force) throw new Error('Debug map exists. Use --force or choose another --name: ' + outDir);
  await emptyDir(outDir);
  await writeJson(path.join(outDir, 'PLANKEY_ACTION_MAP.json'), map);
  await writeText(path.join(outDir, 'PLANKEY_ACTION_MAP.md'), debugActionMapMarkdown(map));
  const touchedCsv = ['path,risk,touches,atomic_writes,temp_writes,rename_commits,exists_in_base,logs'];
  for (const f of map.touched_files) touchedCsv.push([f.path, f.risk, f.touches, f.atomic_writes, f.temp_writes, f.rename_commits, f.exists_in_base, f.logs.join('|')].map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(','));
  await writeText(path.join(outDir, 'touched-files.csv'), touchedCsv.join('\n') + '\n');
  await writeJson(path.join(outDir, 'route-actions.json'), map.route_actions);
  await writeJson(path.join(outDir, 'agent-runtime-events.json'), map.agent_events || []);
  await writeJson(path.join(outDir, 'agent-runtime-files.json'), map.agent_runtime_files || []);
  await writeJson(path.join(outDir, 'agent-persistence-storms.json'), map.agent_persistence_storms || []);
  await writeJson(path.join(outDir, 'sessions.json'), map.sessions);
  console.log('Debug action map written: ' + outDir);
  console.log('Debug files: ' + map.summary.debug_file_count + ', actions: ' + map.summary.action_count + ', touched files: ' + map.summary.touched_file_count);
  console.log('High-risk touched files: ' + map.summary.high_risk_touched_file_count + ', route signals: ' + map.summary.route_signal_count + ', errors: ' + map.summary.error_count);
  console.log('Agent events: ' + (map.summary.agent_event_count || 0) + ', providers: ' + (map.summary.agent_provider_count || 0) + ', persistence storms/churn: ' + (map.summary.agent_persistence_storm_count || 0));
  console.log('Open: ' + path.join(outDir, 'PLANKEY_ACTION_MAP.md'));
}

async function commandDebugAgents(root, input, flags) {
  await ensureWorkspace(root);
  if (!input) throw new Error('Usage: pk-client debug agents <debug-folder-or-full-export.zip> [--name report-name] [--force]');
  const config = loadConfig(root);
  const p = paths(root, config);
  const name = flags.name ? slugify(flags.name) : 'agent-runtime-map-' + safeDateStamp();
  const resolved = await resolveDebugInput(root, input, flags || {});
  if (!resolved.debugDirs.length) throw new Error('No debug directories found in: ' + input);
  const map = await buildDebugActionMap(resolved.sourceRoot, resolved.debugDirs, resolved.shellDirs, { maxActions: Number(flags.maxActions || 10000) });
  const outDir = path.join(p.debugReports, name);
  if (exists(outDir) && !flags.force) throw new Error('Agent runtime report exists. Use --force or choose another --name: ' + outDir);
  await emptyDir(outDir);
  const agentOnly = {
    generated_at: map.generated_at,
    client_version: map.client_version,
    source_root: map.source_root,
    summary: {
      agent_event_count: map.summary.agent_event_count || 0,
      agent_provider_count: map.summary.agent_provider_count || 0,
      agent_runtime_file_count: map.summary.agent_runtime_file_count || 0,
      agent_persistence_storm_count: map.summary.agent_persistence_storm_count || 0
    },
    agent_providers: map.agent_providers || [],
    agent_runtime_files: map.agent_runtime_files || [],
    agent_persistence_storms: map.agent_persistence_storms || [],
    agent_events: map.agent_events || []
  };
  await writeJson(path.join(outDir, 'AGENT_RUNTIME_MAP.json'), agentOnly);
  let md = '# PlaneKey Agent Runtime Map\n\n';
  md += '- Generated: `' + agentOnly.generated_at + '`\n';
  md += '- Source root: `' + agentOnly.source_root + '`\n';
  md += '- Agent events: `' + agentOnly.summary.agent_event_count + '`\n';
  md += '- Providers: `' + agentOnly.summary.agent_provider_count + '`\n';
  md += '- Runtime files: `' + agentOnly.summary.agent_runtime_file_count + '`\n';
  md += '- Persistence storms/churn: `' + agentOnly.summary.agent_persistence_storm_count + '`\n\n';
  md += '## Meaning\n\nThis report separates agent control-plane noise from app source activity. Claude, OpenAI, Google/Gemini, Hugging Face, IBM/watsonx, Azure, AWS/Bedrock, Meta/Llama, and local agent runtimes are treated as forensic evidence unless explicitly promoted. Do not merge agent runtime files into canon or public repo exports.\n\n';
  md += '## Providers\n\n';
  if (!agentOnly.agent_providers.length) md += '- none detected\n';
  for (const pr of agentOnly.agent_providers) md += '- `' + pr.label + '` (`' + pr.provider + '`) count `' + pr.count + '`\n';
  md += '\n## Persistence storms / churn\n\n';
  if (!agentOnly.agent_persistence_storms.length) md += '- none detected\n';
  for (const st of agentOnly.agent_persistence_storms) md += '- `' + st.provider + '` file `' + st.file + '` severity `' + st.severity + '` writes `' + st.write_events + '` lock_errors `' + st.lock_errors + '` burst10s `' + st.max_write_burst_10s + '` median_gap_s `' + st.median_write_gap_seconds + '`\n';
  md += '\n## Agent runtime files\n\n';
  if (!agentOnly.agent_runtime_files.length) md += '- none detected\n';
  for (const f of agentOnly.agent_runtime_files.slice(0, 120)) md += '- `' + f.path + '` providers `' + f.providers.join('|') + '` events `' + f.events + '` writes `' + f.writes + '` lock_errors `' + f.lock_errors + '`\n';
  await writeText(path.join(outDir, 'AGENT_RUNTIME_MAP.md'), md);
  console.log('Agent runtime map written: ' + outDir);
  console.log('Agent events: ' + agentOnly.summary.agent_event_count + ', providers: ' + agentOnly.summary.agent_provider_count + ', persistence storms/churn: ' + agentOnly.summary.agent_persistence_storm_count);
  console.log('Open: ' + path.join(outDir, 'AGENT_RUNTIME_MAP.md'));
}



// ── Self update / install safety ─────────────────────────────────────────────

const SELF_UPDATE_FILE_ALLOW = new Set([
  'package.json',
  'README.md',
  'client.config.example.json'
]);
const SELF_UPDATE_DIR_ALLOW = new Set(['bin', 'tools', 'docs', 'deploy', 'server']);
const SELF_UPDATE_PROTECTED = new Set(['vault', 'inventory', 'working', 'patches', 'bundles', 'reports', 'exports']);

function semverish(value) {
  return String(value || '0').split(/[.-]/).map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function compareVersions(a, b) {
  const aa = semverish(a);
  const bb = semverish(b);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = (aa[i] || 0) - (bb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function findClientPackageRoot(dir) {
  const directBin = path.join(dir, 'bin', 'pk-client.js');
  const directPkg = path.join(dir, 'package.json');
  if (exists(directBin) && exists(directPkg)) return dir;

  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === '__MACOSX') continue;
    const cand = path.join(dir, e.name);
    if (exists(path.join(cand, 'bin', 'pk-client.js')) && exists(path.join(cand, 'package.json'))) return cand;
  }
  return null;
}

async function manifestForSelfDir(dir) {
  const skip = [
    '.git/**',
    'node_modules/**',
    'vault/**',
    'inventory/**',
    'working/**',
    'patches/**',
    'bundles/**',
    'reports/**',
    'exports/**',
    '.self-update-backups/**',
    '.planekey-client-updates/**'
  ];
  return manifestForDir(dir, { skipPatterns: skip });
}

function packageVersionAt(dir) {
  const pkg = readJsonIfExists(path.join(dir, 'package.json'), {});
  return String(pkg.version || '').replace('-', '.');
}

async function copySelfAllowed(candidateRoot, destRoot) {
  const entries = await fsp.readdir(candidateRoot, { withFileTypes: true });
  for (const e of entries) {
    const name = e.name;
    if (name === '__MACOSX' || name === 'node_modules' || name === '.git') continue;
    if (SELF_UPDATE_PROTECTED.has(name)) continue;
    const src = path.join(candidateRoot, name);
    const dest = path.join(destRoot, name);
    if (e.isDirectory()) {
      if (!SELF_UPDATE_DIR_ALLOW.has(name)) continue;
      await fsp.rm(dest, { recursive: true, force: true });
      await copyRecursive(src, dest, { skipPatterns: ['node_modules/**', '.git/**', '__MACOSX/**'] });
    } else if (e.isFile()) {
      if (!SELF_UPDATE_FILE_ALLOW.has(name)) continue;
      await fsp.copyFile(src, dest);
    }
  }
}

async function backupCurrentClient(destRoot, backupRoot) {
  await fsp.mkdir(backupRoot, { recursive: true });
  for (const name of [...SELF_UPDATE_DIR_ALLOW, ...SELF_UPDATE_FILE_ALLOW]) {
    const src = path.join(destRoot, name);
    if (!exists(src)) continue;
    const dest = path.join(backupRoot, name);
    const stat = await fsp.stat(src);
    if (stat.isDirectory()) await copyRecursive(src, dest, { skipPatterns: ['node_modules/**', '.git/**'] });
    else if (stat.isFile()) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
    }
  }
}

async function restoreClientBackup(destRoot, backupRoot) {
  await copySelfAllowed(backupRoot, destRoot);
}

function runClientHelp(clientRoot) {
  return run(process.execPath, [path.join(clientRoot, 'bin', 'pk-client.js'), '--help'], { cwd: clientRoot });
}

async function commandSelfVersion(root, flags) {
  const pkg = readJsonIfExists(path.join(CLIENT_ROOT, 'package.json'), {});
  const manifest = flags.manifest ? await manifestForSelfDir(CLIENT_ROOT) : null;
  console.log('PlaneKey Client self');
  console.log('  version: ' + VERSION);
  console.log('  package: ' + (pkg.version || 'unknown'));
  console.log('  client_root: ' + CLIENT_ROOT);
  console.log('  node: ' + process.version);
  console.log('  platform: ' + process.platform + ' ' + process.arch);
  if (manifest) {
    console.log('  files: ' + manifest.file_count);
    console.log('  bytes: ' + manifest.total_bytes);
    console.log('  manifest_sha256: ' + sha256Bytes(Buffer.from(JSON.stringify(manifest.files.map(f => [f.path, f.sha256])))));
  }
}

async function commandSelfDoctor(root) {
  const checks = [];
  function add(name, ok, detail) { checks.push({ name, ok, detail }); }
  add('client root exists', exists(CLIENT_ROOT), CLIENT_ROOT);
  add('package.json exists', exists(path.join(CLIENT_ROOT, 'package.json')), path.join(CLIENT_ROOT, 'package.json'));
  add('bin/pk-client.js exists', exists(path.join(CLIENT_ROOT, 'bin', 'pk-client.js')), path.join(CLIENT_ROOT, 'bin', 'pk-client.js'));
  const helpRun = runClientHelp(CLIENT_ROOT);
  add('--help self-test', helpRun.status === 0, (helpRun.stdout || helpRun.stderr || '').split('\n')[0] || 'no output');
  const writableProbe = path.join(CLIENT_ROOT, '.planekey-client-updates', '.write-test-' + Date.now());
  try {
    await writeText(writableProbe, 'ok');
    await fsp.rm(writableProbe, { force: true });
    add('install root writable', true, CLIENT_ROOT);
  } catch (e) {
    add('install root writable', false, e.message);
  }
  const ok = checks.every(c => c.ok);
  console.log('PlaneKey Client self doctor: ' + (ok ? 'PASS' : 'FAIL'));
  for (const c of checks) console.log((c.ok ? '  OK   ' : '  FAIL ') + c.name + ' — ' + c.detail);
  if (!ok) process.exitCode = 1;
}

async function commandSelfUpdate(root, source, flags) {
  if (!source) throw new Error('Missing update package. Usage: pk-client self update <planekey-client.zip-or-folder> [--target install-folder] [--dryRun] [--force]');
  const absSource = path.resolve(source);
  if (!exists(absSource)) throw new Error('Update source does not exist: ' + absSource);
  const destRoot = path.resolve(flags.target || CLIENT_ROOT);
  if (!exists(destRoot)) throw new Error('Target install folder does not exist: ' + destRoot);
  if (!exists(path.join(destRoot, 'bin', 'pk-client.js')) || !exists(path.join(destRoot, 'package.json'))) {
    throw new Error('Target install folder does not look like a PlaneKey Client install: ' + destRoot);
  }

  const stamp = safeDateStamp();
  const tmpRoot = path.join(os.tmpdir(), 'planekey-self-update-' + stamp);
  await fsp.rm(tmpRoot, { recursive: true, force: true });
  await fsp.mkdir(tmpRoot, { recursive: true });
  let candidateRoot;
  const st = await fsp.stat(absSource);
  if (st.isFile() && absSource.toLowerCase().endsWith('.zip')) {
    const extractRoot = path.join(tmpRoot, 'extract');
    await extractZip(absSource, extractRoot);
    candidateRoot = await findClientPackageRoot(extractRoot);
  } else if (st.isDirectory()) {
    candidateRoot = await findClientPackageRoot(absSource);
  }
  if (!candidateRoot) throw new Error('Update package does not contain package.json + bin/pk-client.js');

  const currentPackageVersion = packageVersionAt(destRoot) || VERSION;
  const candidatePackageVersion = packageVersionAt(candidateRoot) || '0.0.0';
  const currentManifest = await manifestForSelfDir(destRoot);
  const candidateManifest = await manifestForSelfDir(candidateRoot);

  const test = runClientHelp(candidateRoot);
  if (test.status !== 0) {
    throw new Error('Candidate failed self-test: ' + (test.stderr || test.stdout || 'unknown error'));
  }
  const delta = compareVersions(candidatePackageVersion, currentPackageVersion);
  if (delta < 0 && !flags.force) throw new Error('Candidate version ' + candidatePackageVersion + ' is older than current ' + currentPackageVersion + '. Use --force to downgrade.');
  if (delta === 0 && !flags.force) throw new Error('Candidate version ' + candidatePackageVersion + ' equals current ' + currentPackageVersion + '. Use --force to reinstall.');

  const plan = {
    generated_at: nowIso(),
    action: 'self_update',
    running_client_root: CLIENT_ROOT,
    target_client_root: destRoot,
    source: absSource,
    candidate_root: candidateRoot,
    current_version: currentPackageVersion,
    candidate_version: candidatePackageVersion,
    current_files: currentManifest.file_count,
    candidate_files: candidateManifest.file_count,
    dry_run: Boolean(flags.dryRun || flags['dry-run']),
    update_dirs: [...SELF_UPDATE_DIR_ALLOW].sort(),
    update_files: [...SELF_UPDATE_FILE_ALLOW].sort(),
    protected_workspace_dirs: [...SELF_UPDATE_PROTECTED].sort()
  };

  const updateLogDir = path.join(destRoot, '.planekey-client-updates');
  await fsp.mkdir(updateLogDir, { recursive: true });
  await writeJson(path.join(updateLogDir, 'self-update-plan-' + stamp + '.json'), plan);

  if (plan.dry_run) {
    console.log('Self update dry-run PASS');
    console.log('  current:   ' + currentPackageVersion);
    console.log('  candidate: ' + candidatePackageVersion);
    console.log('  source:    ' + absSource);
    console.log('  target:    ' + destRoot);
    console.log('  plan:      ' + path.join(updateLogDir, 'self-update-plan-' + stamp + '.json'));
    await fsp.rm(tmpRoot, { recursive: true, force: true });
    return;
  }

  const backupRoot = path.join(destRoot, '.self-update-backups', stamp + '_v' + currentPackageVersion.replace(/[^a-zA-Z0-9._-]+/g, '_'));
  await backupCurrentClient(CLIENT_ROOT, backupRoot);
  let installed = false;
  try {
    await copySelfAllowed(candidateRoot, destRoot);
    const post = runClientHelp(destRoot);
    if (post.status !== 0) throw new Error('Installed client failed --help: ' + (post.stderr || post.stdout || 'unknown error'));
    installed = true;
    const installedManifest = await manifestForSelfDir(destRoot);
    const result = {
      ...plan,
      installed_at: nowIso(),
      backup_root: backupRoot,
      installed_files: installedManifest.file_count,
      status: 'installed'
    };
    await writeJson(path.join(updateLogDir, 'self-update-result-' + stamp + '.json'), result);
    console.log('Self update installed successfully.');
    console.log('  old:    ' + currentPackageVersion);
    console.log('  new:    ' + candidatePackageVersion);
    console.log('  target: ' + destRoot);
    console.log('  backup: ' + backupRoot);
    console.log('  test:   pk-client.cmd --help');
  } catch (e) {
    if (!installed) await restoreClientBackup(destRoot, backupRoot).catch(() => {});
    await writeJson(path.join(updateLogDir, 'self-update-result-' + stamp + '.json'), { ...plan, backup_root: backupRoot, status: 'rolled_back', error: e.message });
    throw new Error('Self update failed and rollback was attempted: ' + e.message);
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function commandTree(root) {
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const lines = [
    'PlaneKey Client workspace layout:',
    '',
    root + '/',
    '├── client.config.json',
    '├── vault/',
    '│   ├── raw-downloads/',
    '│   ├── original-zips/',
    '│   └── frozen-snapshots/',
    '├── inventory/',
    '├── working/',
    `│   └── ${config.workingTreeName}/`,
    '├── patches/',
    '│   ├── pending/',
    '│   ├── applied/',
    '│   ├── rejected/',
    '│   └── superseded/',
    '├── bundles/',
    '│   ├── outgoing/',
    '│   ├── accepted/',
    '│   └── rejected/',
    '├── reports/',
    '└── exports/'
  ];
  console.log(lines.join('\n'));
}


// ── Private integrity / tri-layer PlaneKey bus ─────────────────────────────

const PLANEKEY_AGENT_RUNTIME_PATTERNS = [
  '.claude/**', '.claude.json', '.claude*.json',
  '.openai/**', '.gemini/**', '.huggingface/**', '.cache/huggingface/**',
  '.ibm/**', '.watsonx/**', '.azure/**', '.aws/**',
  'agents/**', 'agent-state/**', 'mcp/**', 'llm-runtime/**', 'model-runtime/**'
];

const PLANEKEY_TRI_LAYER_FORBIDDEN = [
  '.env', '.env.*', 'node_modules/**', '.git/**',
  'debug/**', 'shell-snapshots/**', 'planekey-history/**', '.planekey/rabbit/**', '*.rabbit',
  'uploads/**', 'database/**', 'sessions/**', 'tmp/**', 'logs/**',
  ...PLANEKEY_AGENT_RUNTIME_PATTERNS,
  '*.pem', '*.key', '*.p12', '*.pfx', '*.sqlite', '*.sqlite3', '*.db'
];

function getPlaneKeySecret(flags = {}, options = {}) {
  const explicit = flags.secret || flags.key || flags.indexSecret;
  const envValue = process.env.PLANEKEY_INDEX_SECRET || process.env.PLANEKEY_PRIVATE_HASH_SECRET || process.env.PLANEKEY_TOKEN || '';
  const value = explicit || envValue;
  if (!value && options.required !== false) {
    throw new Error('Missing private index secret. Set $env:PLANEKEY_INDEX_SECRET="..." or pass --secret <value>.');
  }
  return String(value || '');
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex');
}

function shortId(value, n = 16) {
  return String(value || '').replace(/[^a-fA-F0-9]/g, '').slice(0, n) || String(value || '').slice(0, n);
}

async function privateIntegrityIndexForDir(targetDir, options = {}) {
  const secret = options.secret || getPlaneKeySecret({}, { required: true });
  const layer = options.layer || 'dev';
  const sourceLabel = options.sourceLabel || targetDir;
  const includeRawSha = !!options.includeRawSha;
  const redactPaths = !!options.redactPaths;
  const skipPatterns = uniqueList([...(options.skipPatterns || []), ...PLANEKEY_TRI_LAYER_FORBIDDEN]);
  const files = await walkFiles(targetDir, { skipPatterns });
  const records = [];
  let totalBytes = 0;

  for (const f of files) {
    const stat = await fsp.stat(f.abs);
    totalBytes += stat.size;
    const sha = await sha256File(f.abs);
    const pathTag = hmacHex(secret, 'path:' + f.rel);
    const contentTag = hmacHex(secret, 'content:' + sha);
    const integrityTag = hmacHex(secret, ['integrity', f.rel, stat.size, sha].join('\n'));
    const record = {
      path: redactPaths ? undefined : f.rel,
      path_tag: pathTag,
      path_tag_short: pathTag.slice(0, 16),
      size: stat.size,
      mtime_ms: Math.round(stat.mtimeMs),
      content_hmac: contentTag,
      content_hmac_short: contentTag.slice(0, 16),
      integrity_hmac: integrityTag,
      integrity_hmac_short: integrityTag.slice(0, 16)
    };
    if (includeRawSha) record.sha256 = sha;
    records.push(record);
  }
  records.sort((a, b) => String(a.path || a.path_tag).localeCompare(String(b.path || b.path_tag)));
  const canonical = records.map((r) => [r.path || r.path_tag, r.size, r.integrity_hmac].join('\t')).join('\n');
  const indexHmac = hmacHex(secret, 'index:' + canonical);
  const sourceFingerprint = hmacHex(secret, 'source:' + path.resolve(targetDir));
  return {
    schema: 'planekey.private-integrity-index.v1',
    generated_at: nowIso(),
    client_version: VERSION,
    project: 'conversationchain',
    layer,
    source_label: sourceLabel,
    source_fingerprint: sourceFingerprint,
    hash_mode: 'hmac-sha256-over-sha256',
    raw_sha256_included: includeRawSha,
    path_redaction: redactPaths ? 'hmac-only' : 'plaintext-path-plus-hmac',
    forbidden_patterns_applied: skipPatterns,
    file_count: records.length,
    total_bytes: totalBytes,
    index_hmac: indexHmac,
    index_hmac_short: indexHmac.slice(0, 20),
    records
  };
}

function privateIndexMap(index) {
  const m = new Map();
  for (const r of index.records || []) {
    const key = r.path || r.path_tag;
    m.set(key, r);
  }
  return m;
}

function comparePrivateIntegrityIndexes(left, right) {
  const ml = privateIndexMap(left);
  const mr = privateIndexMap(right);
  const keys = [...new Set([...ml.keys(), ...mr.keys()])].sort();
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const k of keys) {
    const a = ml.get(k);
    const b = mr.get(k);
    if (!a && b) added.push(b);
    else if (a && !b) removed.push(a);
    else if (a.integrity_hmac !== b.integrity_hmac || a.size !== b.size) changed.push({ before: a, after: b });
    else unchanged.push(b);
  }
  const secretCompatible = left.hash_mode === right.hash_mode && (unchanged.length > 0 || added.length + removed.length + changed.length === 0);
  const riskFiles = [];
  const isRisk = (p) => {
    const rel = String(p || '');
    return /^(server\.js|package\.json|render\.yaml|admin\/planekey\.html|public\/|server\/|migrations\/|tools\/)/i.test(rel);
  };
  for (const c of changed) {
    const p = (c.after && c.after.path) || (c.before && c.before.path) || '';
    if (isRisk(p)) riskFiles.push(p);
  }
  for (const r of removed) if (isRisk(r.path)) riskFiles.push(r.path);
  const status = riskFiles.length ? 'fail' : (added.length || removed.length || changed.length ? 'warn' : 'pass');
  return {
    generated_at: nowIso(),
    schema: 'planekey.private-integrity-comparison.v1',
    left: {
      layer: left.layer,
      source_label: left.source_label,
      file_count: left.file_count,
      index_hmac_short: left.index_hmac_short
    },
    right: {
      layer: right.layer,
      source_label: right.source_label,
      file_count: right.file_count,
      index_hmac_short: right.index_hmac_short
    },
    status,
    secret_compatible_hint: secretCompatible,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length
    },
    risk_files: uniqueList(riskFiles),
    added,
    removed,
    changed,
    unchanged_count: unchanged.length
  };
}

function privateIntegrityMarkdown(index) {
  const lines = [];
  lines.push('# PlaneKey Private Integrity Index');
  lines.push('');
  lines.push(`Generated: ${index.generated_at}`);
  lines.push(`Layer: ${index.layer}`);
  lines.push(`Source: ${index.source_label}`);
  lines.push(`Hash mode: ${index.hash_mode}`);
  lines.push(`Raw SHA stored: ${index.raw_sha256_included ? 'YES — local/private only' : 'NO'}`);
  lines.push(`File count: ${index.file_count}`);
  lines.push(`Total bytes: ${index.total_bytes}`);
  lines.push(`Index fingerprint: ${index.index_hmac_short}`);
  lines.push('');
  lines.push('## Security note');
  lines.push('');
  lines.push('This index stores HMAC fingerprints, not plaintext SHA256 hashes. Dev, builder, and live can compare integrity only when they share the private PlaneKey index secret. Do not commit the secret.');
  lines.push('');
  lines.push('## First records');
  lines.push('');
  for (const r of (index.records || []).slice(0, 40)) {
    lines.push(`- ${r.path || r.path_tag_short} — size ${r.size}, integrity ${r.integrity_hmac_short}`);
  }
  if ((index.records || []).length > 40) lines.push(`- ... ${(index.records || []).length - 40} more`);
  lines.push('');
  return lines.join('\n');
}

function privateComparisonMarkdown(report) {
  const lines = [];
  lines.push('# PlaneKey Tri-Layer Integrity Comparison');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Status: ${String(report.status).toUpperCase()}`);
  lines.push('');
  lines.push(`Left: ${report.left.layer} / ${report.left.source_label} / ${report.left.index_hmac_short}`);
  lines.push(`Right: ${report.right.layer} / ${report.right.source_label} / ${report.right.index_hmac_short}`);
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push(`- Added: ${report.counts.added}`);
  lines.push(`- Removed: ${report.counts.removed}`);
  lines.push(`- Changed: ${report.counts.changed}`);
  lines.push(`- Unchanged: ${report.counts.unchanged}`);
  lines.push('');
  if (report.risk_files.length) {
    lines.push('## High-risk changed/removed paths');
    lines.push('');
    for (const p of report.risk_files.slice(0, 80)) lines.push(`- ${p}`);
    if (report.risk_files.length > 80) lines.push(`- ... ${report.risk_files.length - 80} more`);
    lines.push('');
  }
  lines.push('## Interpretation');
  lines.push('');
  if (report.status === 'pass') lines.push('The compared layers match under the private PlaneKey index secret.');
  else if (report.status === 'warn') lines.push('The layers differ, but no high-risk app paths were detected. Review before trusting.');
  else lines.push('High-risk source paths changed or disappeared. Builder/dev/live should block automatic deployment until reconciled.');
  lines.push('');
  return lines.join('\n');
}

async function commandIntegrityPrivate(root, target, flags) {
  if (!target) throw new Error('Usage: pk-client integrity private <folder-or-snapshot> [--layer dev|builder|live] [--name label] [--secret value] [--redactPaths] [--includeRawSha]');
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const resolved = await resolveTargetDir(root, target, config);
  const secret = getPlaneKeySecret(flags, { required: true });
  const layer = String(flags.layer || 'dev').toLowerCase();
  const name = slugify(flags.name || `${layer}-${path.basename(resolved.label || resolved.dir)}-${safeDateStamp()}`);
  const outDir = path.join(p.reports, 'private_integrity', name);
  await fsp.mkdir(outDir, { recursive: true });
  const index = await privateIntegrityIndexForDir(resolved.dir, {
    secret,
    layer,
    sourceLabel: resolved.label,
    includeRawSha: !!flags.includeRawSha,
    redactPaths: !!flags.redactPaths
  });
  await writeJson(path.join(outDir, 'PLANKEY_PRIVATE_INDEX.json'), index);
  await writeText(path.join(outDir, 'PLANKEY_PRIVATE_INDEX.md'), privateIntegrityMarkdown(index));
  console.log(`Private integrity index written: ${path.join(outDir, 'PLANKEY_PRIVATE_INDEX.json')}`);
  console.log(`Layer: ${index.layer}; files: ${index.file_count}; fingerprint: ${index.index_hmac_short}; raw SHA stored: ${index.raw_sha256_included ? 'YES' : 'NO'}`);
}

async function commandLayerAttest(root, layer, target, flags) {
  if (!layer || !target) throw new Error('Usage: pk-client layer attest <dev|builder|live> <folder-or-snapshot> [--name label] [--secret value]');
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const resolved = await resolveTargetDir(root, target, config);
  const secret = getPlaneKeySecret(flags, { required: true });
  const cleanLayer = String(layer).toLowerCase();
  if (!['dev', 'builder', 'live'].includes(cleanLayer)) throw new Error('Layer must be one of: dev, builder, live');
  const name = slugify(flags.name || `${cleanLayer}-attestation-${safeDateStamp()}`);
  const outDir = path.join(p.reports, 'layers', name);
  await fsp.mkdir(outDir, { recursive: true });
  const index = await privateIntegrityIndexForDir(resolved.dir, { secret, layer: cleanLayer, sourceLabel: resolved.label, redactPaths: !!flags.redactPaths });
  const attestationPayload = {
    schema: 'planekey.tri-layer-attestation.v1',
    generated_at: nowIso(),
    client_version: VERSION,
    project: 'conversationchain',
    layer: cleanLayer,
    source_label: resolved.label,
    file_count: index.file_count,
    total_bytes: index.total_bytes,
    index_hmac: index.index_hmac,
    index_hmac_short: index.index_hmac_short,
    policy: {
      raw_hashes_public: false,
      agent_runtime_quarantined: true,
      repo_secrets_blocked: true,
      dev_builder_live_bus: true
    }
  };
  const signature = hmacHex(secret, JSON.stringify(attestationPayload));
  const attestation = { ...attestationPayload, signature_hmac: signature, signature_hmac_short: signature.slice(0, 20), private_index_file: 'PLANKEY_PRIVATE_INDEX.json' };
  await writeJson(path.join(outDir, 'PLANKEY_PRIVATE_INDEX.json'), index);
  await writeJson(path.join(outDir, 'PLANKEY_LAYER_ATTESTATION.json'), attestation);
  await writeText(path.join(outDir, 'PLANKEY_LAYER_ATTESTATION.md'), `# PlaneKey Layer Attestation\n\nLayer: ${cleanLayer}\n\nSource: ${resolved.label}\n\nFiles: ${index.file_count}\n\nIndex fingerprint: ${index.index_hmac_short}\n\nSignature: ${attestation.signature_hmac_short}\n\nRaw hashes stored publicly: no\n\nThis attestation can be exchanged between dev, builder, and live without exposing plaintext hashes.\n`);
  console.log(`Layer attestation written: ${path.join(outDir, 'PLANKEY_LAYER_ATTESTATION.json')}`);
  console.log(`Layer: ${cleanLayer}; files: ${index.file_count}; fingerprint: ${index.index_hmac_short}; signature: ${attestation.signature_hmac_short}`);
}

async function commandLayerCompare(root, leftFile, rightFile, flags) {
  if (!leftFile || !rightFile) throw new Error('Usage: pk-client layer compare <left-private-index.json> <right-private-index.json> [--name report-name]');
  await ensureWorkspace(root);
  const p = paths(root);
  const left = readJsonIfExists(path.resolve(leftFile), null);
  const right = readJsonIfExists(path.resolve(rightFile), null);
  if (!left || !right) throw new Error('Could not read one or both private index files.');
  const report = comparePrivateIntegrityIndexes(left, right);
  const name = slugify(flags.name || `${left.layer || 'left'}-vs-${right.layer || 'right'}-${safeDateStamp()}`);
  const outDir = path.join(p.reports, 'layers', name);
  await fsp.mkdir(outDir, { recursive: true });
  await writeJson(path.join(outDir, 'PLANKEY_LAYER_COMPARISON.json'), report);
  await writeText(path.join(outDir, 'PLANKEY_LAYER_COMPARISON.md'), privateComparisonMarkdown(report));
  console.log(`Layer compare status: ${report.status.toUpperCase()}`);
  console.log(`Added: ${report.counts.added}; Removed: ${report.counts.removed}; Changed: ${report.counts.changed}; Unchanged: ${report.counts.unchanged}`);
  console.log(`Report written: ${path.join(outDir, 'PLANKEY_LAYER_COMPARISON.md')}`);
}

async function commandLayerAlert(root, leftFile, rightFile, flags) {
  if (!leftFile || !rightFile) throw new Error('Usage: pk-client layer alert <left-private-index.json> <right-private-index.json> [--name alert-name]');
  await ensureWorkspace(root);
  const p = paths(root);
  const left = readJsonIfExists(path.resolve(leftFile), null);
  const right = readJsonIfExists(path.resolve(rightFile), null);
  if (!left || !right) throw new Error('Could not read one or both private index files.');
  const cmp = comparePrivateIntegrityIndexes(left, right);
  const severity = cmp.status === 'fail' ? 'critical' : (cmp.status === 'warn' ? 'review' : 'clear');
  const alert = {
    schema: 'planekey.tri-layer-alert.v1',
    generated_at: nowIso(),
    severity,
    status: cmp.status,
    from_layer: left.layer,
    to_layer: right.layer,
    message: severity === 'critical'
      ? 'High-risk integrity drift detected. Block automatic update/deploy until dev, builder, and live reconcile.'
      : severity === 'review'
        ? 'Integrity drift detected outside high-risk paths. Review before applying updates.'
        : 'No integrity drift detected.',
    comparison: cmp,
    recommended_action: severity === 'critical'
      ? 'Create a rebuild ticket, compare against canon base, do not overwrite live, and require PlaneKey server verification.'
      : severity === 'review'
        ? 'Review changed/added/removed records and regenerate bundle if expected.'
        : 'Proceed if SafetyNet and RepoGuard also pass.'
  };
  const name = slugify(flags.name || `alert-${left.layer || 'left'}-${right.layer || 'right'}-${safeDateStamp()}`);
  const outDir = path.join(p.reports, 'layers', name);
  await fsp.mkdir(outDir, { recursive: true });
  await writeJson(path.join(outDir, 'PLANKEY_LAYER_ALERT.json'), alert);
  await writeText(path.join(outDir, 'PLANKEY_LAYER_ALERT.md'), `# PlaneKey Layer Alert\n\nSeverity: ${severity.toUpperCase()}\n\nStatus: ${cmp.status.toUpperCase()}\n\nFrom: ${left.layer} / ${left.source_label}\n\nTo: ${right.layer} / ${right.source_label}\n\nMessage: ${alert.message}\n\nRecommended action: ${alert.recommended_action}\n\nChanged: ${cmp.counts.changed}; Added: ${cmp.counts.added}; Removed: ${cmp.counts.removed}; High-risk files: ${cmp.risk_files.length}\n`);
  console.log(`Layer alert severity: ${severity.toUpperCase()}`);
  console.log(`Alert written: ${path.join(outDir, 'PLANKEY_LAYER_ALERT.md')}`);
}

async function commandLayerPolicy(root) {
  await ensureWorkspace(root);
  const p = paths(root);
  const outDir = path.join(p.reports, 'layers');
  await fsp.mkdir(outDir, { recursive: true });
  const md = `# PlaneKey Tri-Layer Integrity Policy\n\nPlaneKey now treats development, builder, and live as three separate trust layers.\n\n## Layers\n\n- **dev**: canon source and local working tree.\n- **builder**: Polsia/agent/export/rebuild layer.\n- **live**: deployed Render/PlaneKey server state.\n\n## Private hashes\n\nPlain SHA256 manifests are useful locally, but they should not be public trust artifacts. The private index stores HMAC fingerprints derived from file hashes using PLANEKEY_INDEX_SECRET. A leaked private index does not reveal raw SHA values unless the secret is also leaked.\n\n## Bus behavior\n\n- Live can alert builder/dev when deployed files drift unexpectedly.\n- Builder can alert dev when a rebuild includes live leak artifacts or would fail against canon.\n- Dev can block a bundle if builder/live private attestations do not match expected fingerprints.\n\n## Forbidden in source/export\n\n.env, runtime logs, debug logs, shell snapshots, agent runtime folders, RootRabbit nap records, database files, keys, and private credentials.\n`;
  await writeText(path.join(outDir, 'TRI_LAYER_INTEGRITY_POLICY.md'), md);
  console.log(md);
  console.log('Policy written: ' + path.join(outDir, 'TRI_LAYER_INTEGRITY_POLICY.md'));
}



// ── Edge / Cloudflare attack-avoidance planning ────────────────────────────

const PLANEKEY_EDGE_TEXT_EXTS = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.md', '.txt', '.yml', '.yaml'
]);

const PLANEKEY_KNOWN_SAFE_DOMAINS = [
  'conversationchain.com',
  'conversationchain.app',
  'localhost',
  '127.0.0.1'
];

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCsvFlag(value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function isProbablyTextPath(file) {
  const ext = path.extname(file).toLowerCase();
  return PLANEKEY_EDGE_TEXT_EXTS.has(ext);
}

async function readTextLimited(file, maxBytes = 2 * 1024 * 1024) {
  const stat = await fsp.stat(file);
  if (stat.size > maxBytes) return null;
  const buf = await fsp.readFile(file);
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

function extractDomains(text) {
  const found = new Set();
  const patterns = [
    /https?:\/\/([a-z0-9.-]+)(?::\d+)?[\/_?#"')\s>]*/gi,
    /src=["']https?:\/\/([a-z0-9.-]+)(?::\d+)?/gi,
    /href=["']https?:\/\/([a-z0-9.-]+)(?::\d+)?/gi,
    /action=["']https?:\/\/([a-z0-9.-]+)(?::\d+)?/gi,
    /connect-src\s+[^;]*https?:\/\/([a-z0-9.-]+)/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) found.add(String(m[1] || '').toLowerCase());
  }
  return [...found].filter(Boolean).sort();
}

function domainAllowed(domain, allowedDomains) {
  const d = String(domain || '').toLowerCase();
  if (!d) return true;
  return allowedDomains.some((base) => {
    const b = String(base || '').toLowerCase();
    return d === b || d.endsWith('.' + b);
  });
}

function lineHits(text, rel, specs, limit = 120) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const spec of specs) {
      const re = spec.regex instanceof RegExp ? spec.regex : new RegExp(spec.regex, spec.flags || 'i');
      if (re.test(line)) {
        out.push({
          type: spec.type,
          severity: spec.severity || 'warn',
          file: rel,
          line: i + 1,
          evidence: line.trim().slice(0, 220),
          reason: spec.reason || spec.type
        });
        break;
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

function edgeScanSpecs() {
  return [
    { type: 'tracking_pixel', severity: 'warn', reason: 'hidden/small tracking pixel or beacon pattern', regex: /(<img[^>]+(?:width=["']?1|height=["']?1|display\s*:\s*none|tracking|pixel|beacon)|navigator\.sendBeacon|\/collect\?|\/pixel\?|analytics)/i },
    { type: 'email_capture', severity: 'warn', reason: 'email capture or mailing endpoint pattern', regex: /(type=["']email["']|name=["']email["']|email_capture|email-capture|\/api\/email|mailchimp|convertkit|hubspot|klaviyo|sendgrid)/i },
    { type: 'prompt_injection_string', severity: 'fail', reason: 'prompt-injection style instruction found in source', regex: /(ignore (all )?(previous|prior) instructions|system prompt|developer message|jailbreak|prompt injection|do not tell the user|hidden instruction)/i },
    { type: 'script_injection_risk', severity: 'fail', reason: 'dynamic JavaScript execution or document injection', regex: /(\beval\s*\(|new Function\s*\(|document\.write\s*\(|\.innerHTML\s*=|insertAdjacentHTML\s*\()/i },
    { type: 'remote_script', severity: 'warn', reason: 'remote script source', regex: /<script[^>]+src=["']https?:\/\//i },
    { type: 'external_form_action', severity: 'warn', reason: 'form posts to external endpoint', regex: /<form[^>]+action=["']https?:\/\//i },
    { type: 'third_party_iframe', severity: 'warn', reason: 'third-party iframe/embed surface', regex: /<(iframe|embed)[^>]+src=["']https?:\/\//i },
    { type: 'open_redirect_hint', severity: 'warn', reason: 'redirect parameter pattern', regex: /(redirect_uri|returnTo|return_to|next=|url=|continue=)/i },
    { type: 'cloudflare_bypass_hint', severity: 'warn', reason: 'origin or bypass wording found', regex: /(x-forwarded-for|cf-connecting-ip|bypass cloudflare|direct origin|origin ip)/i }
  ];
}

function edgeSeverityScore(findings) {
  let score = 0;
  for (const f of findings || []) {
    if (f.severity === 'fail' || f.severity === 'critical') score += 12;
    else if (f.severity === 'warn') score += 4;
    else score += 1;
  }
  return score;
}

async function edgeScanDir(targetDir, options = {}) {
  const allowedDomains = uniqueList([
    ...PLANEKEY_KNOWN_SAFE_DOMAINS,
    ...parseCsvFlag(options.allowedDomains),
    ...parseCsvFlag(options.domain),
    ...parseCsvFlag(options.zone)
  ]);
  const skipPatterns = uniqueList([
    ...PLANEKEY_TRI_LAYER_FORBIDDEN,
    'node_modules/**', '.git/**', 'vault/**', 'reports/**', 'exports/**', 'bundles/**', 'inventory/**'
  ]);
  const files = await walkFiles(targetDir, { skipPatterns });
  const specs = edgeScanSpecs();
  const findings = [];
  const domains = new Map();
  const fileStats = [];
  for (const f of files) {
    if (!isProbablyTextPath(f.rel)) continue;
    const text = await readTextLimited(f.abs, Number(options.maxBytes || 2 * 1024 * 1024));
    if (text == null) continue;
    const hits = lineHits(text, f.rel, specs);
    findings.push(...hits);
    const ds = extractDomains(text);
    for (const d of ds) {
      const rec = domains.get(d) || { domain: d, count: 0, files: [] };
      rec.count += 1;
      if (rec.files.length < 20) rec.files.push(f.rel);
      domains.set(d, rec);
    }
    fileStats.push({ file: f.rel, bytes: Buffer.byteLength(text, 'utf8'), findings: hits.length, domains: ds.length });
  }
  const thirdPartyDomains = [...domains.values()]
    .filter((d) => !domainAllowed(d.domain, allowedDomains))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  for (const d of thirdPartyDomains) {
    findings.push({
      type: 'third_party_domain',
      severity: 'warn',
      file: d.files[0] || '',
      line: 0,
      evidence: d.domain,
      reason: 'domain is not in the allowed ConversationChain/Cloudflare domain set',
      domain: d.domain,
      files: d.files
    });
  }
  const counts = {};
  for (const f of findings) counts[f.type] = (counts[f.type] || 0) + 1;
  const score = edgeSeverityScore(findings) + thirdPartyDomains.length * 2;
  const status = findings.some((f) => f.severity === 'fail' || f.severity === 'critical') ? 'fail' : (score ? 'warn' : 'pass');
  const riskLevel = score >= 80 || status === 'fail' ? 'red' : score >= 25 ? 'orange' : score > 0 ? 'yellow' : 'green';
  return {
    schema: 'planekey.edge-risk-scan.v1',
    generated_at: nowIso(),
    client_version: VERSION,
    target_dir: targetDir,
    status,
    risk_level: riskLevel,
    risk_score: score,
    allowed_domains: allowedDomains,
    counts,
    third_party_domains: thirdPartyDomains,
    findings,
    scanned_text_files: fileStats.length,
    file_stats: fileStats.sort((a, b) => b.findings - a.findings || a.file.localeCompare(b.file)).slice(0, 200)
  };
}

function edgeScanMarkdown(report) {
  const lines = [];
  lines.push('# PlaneKey Edge Risk Scan');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Status: ${String(report.status).toUpperCase()}`);
  lines.push(`Risk level: ${String(report.risk_level).toUpperCase()}`);
  lines.push(`Risk score: ${report.risk_score}`);
  lines.push(`Text files scanned: ${report.scanned_text_files}`);
  lines.push('');
  lines.push('## Finding counts');
  lines.push('');
  const entries = Object.entries(report.counts || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) lines.push('- None');
  for (const [k, v] of entries) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push('## Third-party domains');
  lines.push('');
  if (!(report.third_party_domains || []).length) lines.push('- None outside allowed domain set.');
  for (const d of (report.third_party_domains || []).slice(0, 60)) lines.push(`- ${d.domain} — ${d.count} file(s); first: ${d.files[0] || 'unknown'}`);
  lines.push('');
  lines.push('## Notable findings');
  lines.push('');
  for (const f of (report.findings || []).slice(0, 100)) {
    const loc = f.line ? `${f.file}:${f.line}` : (f.file || 'global');
    lines.push(`- **${f.severity || 'info'} / ${f.type}** — ${loc} — ${f.reason}`);
    if (f.evidence) lines.push(`  - ${String(f.evidence).replace(/\s+/g, ' ').slice(0, 180)}`);
  }
  if ((report.findings || []).length > 100) lines.push(`- ... ${(report.findings || []).length - 100} more findings`);
  lines.push('');
  return lines.join('\n');
}

async function loadEdgeInput(root, input, flags = {}) {
  if (!input) throw new Error('Missing input. Use a folder, snapshot, edge scan JSON, layer alert JSON, or action plan JSON.');
  const config = loadConfig(root);
  const asPath = path.resolve(input);
  if (isFile(asPath)) {
    const obj = readJsonIfExists(asPath, null);
    if (!obj) throw new Error('Input file is not valid JSON: ' + asPath);
    return { kind: obj.schema || 'json', data: obj, source: asPath };
  }
  if (isDir(asPath)) {
    // If it is a report folder, prefer known JSON files. Otherwise scan it as source.
    const candidates = [
      'EDGE_RISK_SCAN.json',
      'CLOUDFLARE_ACTION_PLAN.json',
      'SECURITY_DASHBOARD.json',
      'PLANKEY_LAYER_ALERT.json',
      'PLANKEY_PRIVATE_COMPARISON.json',
      'PLANKEY_ACTION_MAP.json'
    ];
    for (const c of candidates) {
      const f = path.join(asPath, c);
      if (isFile(f)) return { kind: readJsonIfExists(f, {}).schema || 'json', data: readJsonIfExists(f, {}), source: f };
    }
    return { kind: 'planekey.edge-risk-scan.v1', data: await edgeScanDir(asPath, flags), source: asPath };
  }
  const snap = findSnapshot(root, input);
  if (snap) {
    const p = paths(root, config);
    const dir = snap.source_dir || path.join(p.rawDownloads, snap.id, 'source');
    return { kind: 'planekey.edge-risk-scan.v1', data: await edgeScanDir(dir, flags), source: dir };
  }
  throw new Error('Input is not a folder, file, or known snapshot: ' + input);
}

function normalizeRiskSignals(inputObj) {
  const schema = String(inputObj.schema || '');
  const signals = [];
  if (schema.includes('edge-risk-scan')) {
    for (const f of inputObj.findings || []) {
      signals.push({
        type: f.type,
        severity: f.severity || 'warn',
        path: f.file || '',
        evidence: f.evidence || '',
        reason: f.reason || f.type,
        domain: f.domain || ''
      });
    }
  } else if (schema.includes('tri-layer-alert') || schema.includes('private-integrity-comparison')) {
    const cmp = inputObj.comparison || inputObj;
    for (const pth of cmp.risk_files || []) {
      signals.push({ type: 'integrity_drift', severity: 'critical', path: pth, reason: 'high-risk file drift across PlaneKey layers' });
    }
    if ((cmp.counts || {}).changed) signals.push({ type: 'integrity_change_count', severity: cmp.status === 'fail' ? 'critical' : 'warn', evidence: String(cmp.counts.changed), reason: 'changed private integrity records' });
    if ((cmp.counts || {}).removed) signals.push({ type: 'integrity_removed_count', severity: 'critical', evidence: String(cmp.counts.removed), reason: 'removed private integrity records' });
  } else if (schema.includes('debug-action-map')) {
    for (const f of inputObj.high_risk_touched_files || []) signals.push({ type: 'builder_touched_high_risk', severity: 'warn', path: f, reason: 'builder/debug session touched high-risk path' });
  }
  return signals;
}

function cloudflareActionPlan(inputObj, flags = {}) {
  const signals = normalizeRiskSignals(inputObj);
  const zone = flags.zone || flags.domain || 'conversationchain.app';
  const actions = [];
  const has = (type) => signals.some((s) => s.type === type || String(s.type).includes(type));
  const severity = signals.some((s) => s.severity === 'critical') ? 'critical'
    : signals.some((s) => s.severity === 'fail') ? 'high'
    : signals.some((s) => s.severity === 'warn') ? 'medium'
    : 'clear';

  if (has('integrity_drift') || has('script_injection_risk') || has('prompt_injection')) {
    actions.push({
      id: 'edge-quarantine-app',
      severity: 'critical',
      mode: 'approval-required',
      cloudflare_capability: 'Load Balancing / WAF Custom Rules / Maintenance route',
      action: 'Route affected app/API paths away from unsafe origin or challenge/block until PlaneKey layers reconcile.',
      suggested_rules: [
        'Disable affected origin pool only after human approval.',
        'Challenge /app and /api/* while incident is open.',
        'Serve maintenance/safe-status page for high-risk paths if no clean origin exists.'
      ]
    });
  }
  if (has('email_capture') || has('open_redirect')) {
    actions.push({
      id: 'protect-forms-and-redirects',
      severity: 'high',
      mode: 'approval-required',
      cloudflare_capability: 'WAF Custom Rules + Rate Limiting + Turnstile',
      action: 'Increase challenge/rate-limit posture for login, signup, email capture, and redirect endpoints.',
      suggested_rules: [
        'Managed Challenge on suspicious POST traffic to /login, /signup, /api/auth/*, and email endpoints.',
        'Rate limit repeated POSTs by IP/session fingerprint.',
        'Require server-validated Turnstile on public forms.'
      ]
    });
  }
  if (has('tracking_pixel') || has('remote_script') || has('third_party_domain') || has('third_party_iframe')) {
    const domains = uniqueList((inputObj.third_party_domains || []).map((d) => d.domain).concat(signals.map((s) => s.domain).filter(Boolean)));
    actions.push({
      id: 'third-party-trust-dashboard',
      severity: domains.length ? 'medium' : 'low',
      mode: 'safe-report-only',
      cloudflare_capability: 'Security dashboard / Access-protected incident page',
      action: 'Generate third-party trust dashboard and quarantine unexpected external scripts/pixels until reviewed.',
      third_party_domains: domains.slice(0, 80),
      suggested_rules: [
        'Review and approve each third-party domain before public export/deploy.',
        'Use CSP/report-only first, then enforce after expected domains are confirmed.',
        'Block or challenge pages loading unknown scripts/pixels when risk level is red/orange.'
      ]
    });
  }
  if (!actions.length) {
    actions.push({
      id: 'monitor-only',
      severity: 'clear',
      mode: 'monitor',
      cloudflare_capability: 'Analytics / Logs / Security Events',
      action: 'No edge enforcement recommended. Continue monitoring.'
    });
  }
  const blockAutoDeploy = ['critical', 'high'].includes(severity);
  return {
    schema: 'planekey.cloudflare-action-plan.v1',
    generated_at: nowIso(),
    client_version: VERSION,
    zone,
    severity,
    block_auto_deploy: blockAutoDeploy,
    source_schema: inputObj.schema || 'unknown',
    signal_count: signals.length,
    signals: signals.slice(0, 300),
    actions,
    api_safety: {
      dry_run_default: true,
      requires_explicit_apply: true,
      requires_cloudflare_api_token: true,
      recommended_token_scope: 'Zone:Read, WAF:Edit/Rulesets:Edit only for chosen zone; Load Balancing:Edit only if using pool failover',
      never_store_token_in_repo: true
    }
  };
}

function cloudflarePlanMarkdown(plan) {
  const lines = [];
  lines.push('# PlaneKey Cloudflare / Edge Action Plan');
  lines.push('');
  lines.push(`Generated: ${plan.generated_at}`);
  lines.push(`Zone/domain: ${plan.zone}`);
  lines.push(`Severity: ${String(plan.severity).toUpperCase()}`);
  lines.push(`Block auto-deploy: ${plan.block_auto_deploy ? 'YES' : 'NO'}`);
  lines.push(`Signals: ${plan.signal_count}`);
  lines.push('');
  lines.push('## Actions');
  lines.push('');
  for (const a of plan.actions || []) {
    lines.push(`### ${a.id}`);
    lines.push('');
    lines.push(`- Severity: ${a.severity}`);
    lines.push(`- Mode: ${a.mode}`);
    lines.push(`- Cloudflare capability: ${a.cloudflare_capability}`);
    lines.push(`- Action: ${a.action}`);
    if ((a.third_party_domains || []).length) lines.push(`- Third-party domains: ${a.third_party_domains.slice(0, 20).join(', ')}${a.third_party_domains.length > 20 ? ' ...' : ''}`);
    if ((a.suggested_rules || []).length) {
      lines.push('- Suggested rules:');
      for (const r of a.suggested_rules) lines.push(`  - ${r}`);
    }
    lines.push('');
  }
  lines.push('## API safety');
  lines.push('');
  lines.push('- This plan is report-first. It does not mutate Cloudflare by itself.');
  lines.push('- Use scoped API tokens only. Never commit Cloudflare tokens.');
  lines.push('- Keep destructive actions approval-gated.');
  lines.push('');
  return lines.join('\n');
}

function securityDashboardHtml(plan, inputObj) {
  const severity = plan.severity || 'unknown';
  const title = `PlaneKey Security Dashboard — ${severity.toUpperCase()}`;
  const actions = (plan.actions || []).map((a) => `
    <section class="card">
      <h2>${escapeHtml(a.id)}</h2>
      <p><strong>Severity:</strong> ${escapeHtml(a.severity)} &nbsp; <strong>Mode:</strong> ${escapeHtml(a.mode)}</p>
      <p><strong>Capability:</strong> ${escapeHtml(a.cloudflare_capability)}</p>
      <p>${escapeHtml(a.action)}</p>
      ${(a.third_party_domains || []).length ? `<p><strong>Third-party domains:</strong> ${escapeHtml(a.third_party_domains.slice(0, 50).join(', '))}</p>` : ''}
      ${(a.suggested_rules || []).length ? `<ul>${a.suggested_rules.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
    </section>`).join('\n');
  const signals = (plan.signals || []).slice(0, 120).map((s) => `<tr><td>${escapeHtml(s.severity)}</td><td>${escapeHtml(s.type)}</td><td>${escapeHtml(s.path || s.domain || '')}</td><td>${escapeHtml(s.reason || '')}</td></tr>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; --bg:#080911; --card:#121522; --border:#293044; --text:#eef1ff; --muted:#9aa3bc; --bad:#ff6b6b; --warn:#ffd166; --ok:#70e000; --accent:#7c5cff; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
  header { padding:32px; border-bottom:1px solid var(--border); background:linear-gradient(135deg,#11162a,#090b13); }
  h1 { margin:0 0 8px; font-size:28px; }
  main { max-width:1100px; margin:0 auto; padding:24px; }
  .badge { display:inline-block; padding:6px 10px; border-radius:999px; background:${severity === 'critical' || severity === 'high' ? 'var(--bad)' : severity === 'medium' ? 'var(--warn)' : 'var(--ok)'}; color:#071017; font-weight:700; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:18px; margin:14px 0; box-shadow:0 10px 30px rgba(0,0,0,.18); }
  .muted { color:var(--muted); }
  table { width:100%; border-collapse:collapse; overflow:hidden; border-radius:12px; }
  th,td { border-bottom:1px solid var(--border); padding:10px; text-align:left; vertical-align:top; }
  th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
  code { background:#0b0e18; padding:2px 5px; border-radius:5px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <p class="muted">Generated ${escapeHtml(plan.generated_at)} by PlaneKey Client ${escapeHtml(VERSION)}</p>
  <span class="badge">${escapeHtml(String(severity).toUpperCase())}</span>
</header>
<main>
<section class="card">
  <h2>Summary</h2>
  <p><strong>Zone:</strong> ${escapeHtml(plan.zone)}<br>
  <strong>Signals:</strong> ${escapeHtml(plan.signal_count)}<br>
  <strong>Block auto-deploy:</strong> ${plan.block_auto_deploy ? 'YES' : 'NO'}</p>
  <p class="muted">This dashboard is evidence-based. It reports observed drift/signals and recommended defensive routing actions; it does not accuse a third party of compromise without confirmation.</p>
</section>
${actions}
<section class="card">
  <h2>Signals</h2>
  <table><thead><tr><th>Severity</th><th>Type</th><th>Path/domain</th><th>Reason</th></tr></thead><tbody>${signals || '<tr><td colspan="4">No signals.</td></tr>'}</tbody></table>
</section>
</main>
</body>
</html>`;
}

async function commandEdgeScan(root, target, flags) {
  if (!target) throw new Error('Usage: pk-client edge scan <folder-or-snapshot> [--name report-name] [--allowedDomains domain1,domain2]');
  await ensureWorkspace(root);
  const config = loadConfig(root);
  const p = paths(root, config);
  const resolved = await resolveTargetDir(root, target, config);
  const report = await edgeScanDir(resolved.dir, flags);
  const name = slugify(flags.name || 'edge-scan-' + safeDateStamp());
  const outDir = path.join(p.reports, 'edge', name);
  await fsp.mkdir(outDir, { recursive: true });
  await writeJson(path.join(outDir, 'EDGE_RISK_SCAN.json'), report);
  await writeText(path.join(outDir, 'EDGE_RISK_SCAN.md'), edgeScanMarkdown(report));
  console.log(`Edge scan status: ${report.status.toUpperCase()} (${report.risk_level}, score ${report.risk_score})`);
  console.log('Report written: ' + path.join(outDir, 'EDGE_RISK_SCAN.md'));
}

async function commandEdgePlan(root, input, flags) {
  if (!input) throw new Error('Usage: pk-client edge plan <folder-or-report-json> [--name report-name] [--zone conversationchain.app]');
  await ensureWorkspace(root);
  const p = paths(root);
  const loaded = await loadEdgeInput(root, input, flags);
  const plan = cloudflareActionPlan(loaded.data, flags);
  plan.source = loaded.source;
  const name = slugify(flags.name || 'edge-plan-' + safeDateStamp());
  const outDir = path.join(p.reports, 'edge', name);
  await fsp.mkdir(outDir, { recursive: true });
  await writeJson(path.join(outDir, 'CLOUDFLARE_ACTION_PLAN.json'), plan);
  await writeText(path.join(outDir, 'CLOUDFLARE_ACTION_PLAN.md'), cloudflarePlanMarkdown(plan));
  console.log(`Edge plan severity: ${plan.severity.toUpperCase()}`);
  console.log('Plan written: ' + path.join(outDir, 'CLOUDFLARE_ACTION_PLAN.md'));
}

async function commandEdgeDashboard(root, input, flags) {
  if (!input) throw new Error('Usage: pk-client edge dashboard <edge-plan-or-report-json-or-folder> [--name dashboard-name] [--zone conversationchain.app]');
  await ensureWorkspace(root);
  const p = paths(root);
  const loaded = await loadEdgeInput(root, input, flags);
  let plan = loaded.data;
  if (!String(plan.schema || '').includes('cloudflare-action-plan')) plan = cloudflareActionPlan(loaded.data, flags);
  const name = slugify(flags.name || 'security-dashboard-' + safeDateStamp());
  const outDir = path.join(p.reports, 'edge', name);
  await fsp.mkdir(outDir, { recursive: true });
  const dashboard = {
    schema: 'planekey.security-dashboard.v1',
    generated_at: nowIso(),
    client_version: VERSION,
    source: loaded.source,
    plan
  };
  await writeJson(path.join(outDir, 'SECURITY_DASHBOARD.json'), dashboard);
  await writeText(path.join(outDir, 'SECURITY_DASHBOARD.html'), securityDashboardHtml(plan, loaded.data));
  await writeText(path.join(outDir, 'SECURITY_DASHBOARD.md'), `# PlaneKey Security Dashboard\n\nSeverity: ${String(plan.severity).toUpperCase()}\n\nHTML: SECURITY_DASHBOARD.html\n\nThis dashboard is safe to share after reviewing that no secrets/payloads were included in the source report.\n`);
  console.log(`Security dashboard severity: ${String(plan.severity).toUpperCase()}`);
  console.log('Dashboard written: ' + path.join(outDir, 'SECURITY_DASHBOARD.html'));
}

async function commandCloudflarePolicy(root) {
  await ensureWorkspace(root);
  const p = paths(root);
  const outDir = path.join(p.reports, 'edge');
  await fsp.mkdir(outDir, { recursive: true });
  const md = `# PlaneKey + Cloudflare Defensive Routing Policy\n\nPlaneKey does not replace Cloudflare. PlaneKey produces trust signals; Cloudflare enforces edge actions.\n\n## Trust inputs\n\n- RootRabbit route matrix and live-route canaries\n- PlaneKey private dev/builder/live integrity indexes\n- Hutch package/runtime sanity\n- Flight route graph sanity\n- RepoGuard public-repo secret checks\n- Edge scan for tracking pixels, email captures, remote scripts, prompt injection strings, dynamic JS execution, and unexpected third-party domains\n\n## Action ladder\n\n1. **Clean** — normal routing.\n2. **Suspicious** — log, alert, increase monitoring.\n3. **Abuse** — rate-limit or managed challenge affected paths.\n4. **Tamper/injection** — route around unsafe origin or challenge/block until layers reconcile.\n5. **Confirmed compromise** — disable unsafe origin/pool, freeze deployment, open dashboard.\n6. **Third-party risk** — quarantine integration, stop sending sensitive data, share evidence-based security dashboard.\n\n## Safety rails\n\n- Cloudflare API tokens must be scoped to the zone and minimum capabilities.\n- Dry-run/report mode is default.\n- Destructive actions require explicit approval.\n- Dashboards must be evidence-based and must not expose secrets, payloads, or exploit steps.\n`;
  await writeText(path.join(outDir, 'CLOUDFLARE_DEFENSIVE_ROUTING_POLICY.md'), md);
  console.log(md);
  console.log('Policy written: ' + path.join(outDir, 'CLOUDFLARE_DEFENSIVE_ROUTING_POLICY.md'));
}

async function commandCloudflareApply(root, input, flags) {
  if (!input) throw new Error('Usage: pk-client cloudflare apply <CLOUDFLARE_ACTION_PLAN.json> --dryRun');
  await ensureWorkspace(root);
  const plan = readJsonIfExists(path.resolve(input), null);
  if (!plan || !String(plan.schema || '').includes('cloudflare-action-plan')) throw new Error('Input is not a Cloudflare action plan JSON.');
  if (!flags.dryRun) {
    throw new Error('Cloudflare mutation is intentionally disabled in v1.5.7. Re-run with --dryRun to generate/apply-review output only. Direct API mutation belongs behind a future signed approval gate.');
  }
  const p = paths(root);
  const name = slugify(flags.name || 'cloudflare-dryrun-' + safeDateStamp());
  const outDir = path.join(p.reports, 'edge', name);
  await fsp.mkdir(outDir, { recursive: true });
  const lines = [];
  lines.push('# Cloudflare Dry-Run Apply Plan');
  lines.push('');
  lines.push(`Zone: ${plan.zone}`);
  lines.push(`Severity: ${plan.severity}`);
  lines.push(`Block auto-deploy: ${plan.block_auto_deploy ? 'YES' : 'NO'}`);
  lines.push('');
  for (const a of plan.actions || []) {
    lines.push(`## ${a.id}`);
    lines.push('');
    lines.push(`Capability: ${a.cloudflare_capability}`);
    lines.push(`Mode: ${a.mode}`);
    lines.push(`Action: ${a.action}`);
    lines.push('');
  }
  lines.push('No Cloudflare API calls were made.');
  await writeText(path.join(outDir, 'CLOUDFLARE_DRYRUN_APPLY.md'), lines.join('\n'));
  await writeJson(path.join(outDir, 'CLOUDFLARE_DRYRUN_APPLY.json'), { generated_at: nowIso(), dry_run: true, plan });
  console.log('Cloudflare dry-run written: ' + path.join(outDir, 'CLOUDFLARE_DRYRUN_APPLY.md'));
}


// ─────────────────────────────────────────────────────────────────────────────
// PixelGuard / ResidueGuard (v1.5.7)
// ─────────────────────────────────────────────────────────────────────────────

const PIXELGUARD_TEXT_EXTS = PLANEKEY_EDGE_TEXT_EXTS;

function pixelGuardSpecs() {
  return [
    {
      type: 'polsia_tracking_reference',
      category: 'builder_residue',
      severity: 'review',
      disposition: 'review',
      reason: 'Polsia domain reference that may be hosted-builder residue, tracking, attribution, or old launch URL',
      regex: /(conversationchain\.polsia\.app|polsia\.app|polsia\.com)/i
    },
    {
      type: 'polsia_hidden_pixel_or_beacon',
      category: 'tracking_residue',
      severity: 'fail',
      disposition: 'remove',
      reason: 'Polsia reference appears on a hidden/small image, beacon, analytics call, or tracking-style surface',
      regex: /((<img[^>]+(?:polsia|conversationchain\.polsia\.app)[^>]*(?:width=["']?1|height=["']?1|display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0))|(navigator\.sendBeacon\([^)]*polsia)|(fetch\([^)]*polsia[^)]*(collect|track|pixel|event|analytics))|(polsia[^\n]{0,80}(collect|track|pixel|beacon|analytics)))/i
    },
    {
      type: 'hidden_tracking_pixel',
      category: 'tracking_residue',
      severity: 'fail',
      disposition: 'remove',
      reason: 'Hidden or 1x1 tracking pixel/web beacon pattern',
      regex: /<img[^>]+(?:width=["']?1|height=["']?1|display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|tracking|pixel|beacon)/i
    },
    {
      type: 'analytics_beacon',
      category: 'tracking_residue',
      severity: 'review',
      disposition: 'review',
      reason: 'Analytics/event beacon surface that should be allowlisted or removed',
      regex: /(navigator\.sendBeacon|\/collect\?|\/track\?|\/pixel\?|analytics|gtag\(|dataLayer|plausible\(|posthog|segment\.com|mixpanel|amplitude)/i
    },
    {
      type: 'email_capture_surface',
      category: 'data_capture_residue',
      severity: 'fail',
      disposition: 'review_or_remove',
      reason: 'Email capture field/form/API surface; verify consent, policy, and destination',
      regex: /(<input[^>]+type=["']email["']|name=["']email["']|email_capture|email-capture|\/api\/email|\/api\/capture|mailchimp|convertkit|hubspot|klaviyo|sendgrid)/i
    },
    {
      type: 'builder_attribution_or_policy_link',
      category: 'builder_residue',
      severity: 'info',
      disposition: 'keep_or_replace',
      reason: 'Visible builder/policy/attribution style reference; may be legitimate but should be explicit',
      regex: /(how we operate|powered by|built with|hosted by|polsia policy|polsia\.com)/i
    },
    {
      type: 'stale_hosted_url',
      category: 'builder_residue',
      severity: 'warn',
      disposition: 'replace',
      reason: 'Stale hosted URL/canonical/meta reference should point to conversationchain.com or conversationchain.app',
      regex: /((canonical|og:url|twitter:url|href=|src=|action=)[^\n]{0,160}conversationchain\.polsia\.app)/i
    },
    {
      type: 'remote_script_dependency',
      category: 'edge_dependency',
      severity: 'warn',
      disposition: 'review',
      reason: 'Remote script dependency changes page trust boundary',
      regex: /<script[^>]+src=["']https?:\/\//i
    },
    {
      type: 'third_party_iframe_or_embed',
      category: 'edge_dependency',
      severity: 'warn',
      disposition: 'review',
      reason: 'Third-party iframe/embed surface',
      regex: /<(iframe|embed)[^>]+src=["']https?:\/\//i
    },
    {
      type: 'external_form_action',
      category: 'data_capture_residue',
      severity: 'warn',
      disposition: 'review',
      reason: 'Form posts to external endpoint',
      regex: /<form[^>]+action=["']https?:\/\//i
    },
    {
      type: 'agent_runtime_residue',
      category: 'agent_runtime',
      severity: 'warn',
      disposition: 'quarantine',
      reason: 'Agent/runtime state or control-plane reference should stay forensic-only',
      regex: /(\.claude|\.openai|\.gemini|\.huggingface|agent-state|llm-runtime|model-runtime|mcp\/|mcp\\)/i
    },
    {
      type: 'prompt_injection_residue',
      category: 'injection_residue',
      severity: 'fail',
      disposition: 'remove',
      reason: 'Prompt-injection style text found in source or residue',
      regex: /(ignore (all )?(previous|prior) instructions|system prompt|developer message|jailbreak|prompt injection|do not tell the user|hidden instruction)/i
    },
    {
      type: 'dynamic_js_injection_surface',
      category: 'code_injection_surface',
      severity: 'fail',
      disposition: 'review_or_remove',
      reason: 'Dynamic JS/HTML injection surface',
      regex: /(\beval\s*\(|new Function\s*\(|document\.write\s*\(|\.innerHTML\s*=|insertAdjacentHTML\s*\()/i
    }
  ];
}

async function resolveScanInputDir(root, input, prefix, flags = {}) {
  const config = loadConfig(root);
  const p = paths(root, config);
  if (!input) throw new Error('Missing input path.');
  const abs = path.resolve(input);
  if (isDir(abs)) return { dir: abs, label: abs, cleanup: null };
  if (isFile(abs) && abs.toLowerCase().endsWith('.zip')) {
    const tmp = path.join(os.tmpdir(), `planekey-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fsp.mkdir(tmp, { recursive: true });
    await extractZip(abs, tmp);
    return { dir: tmp, label: abs, cleanup: tmp };
  }
  const snap = findSnapshot(root, input);
  if (snap) return { dir: snap.source_dir || path.join(p.rawDownloads, snap.id, 'source'), label: snap.id, cleanup: null };
  throw new Error('Input is not a folder, zip, or known snapshot: ' + input);
}

function pixelRiskScore(findings) {
  let score = 0;
  for (const f of findings || []) {
    if (f.severity === 'fail' || f.severity === 'critical') score += 15;
    else if (f.severity === 'warn') score += 6;
    else if (f.severity === 'review') score += 3;
    else score += 1;
  }
  return score;
}

function pixelDispositionSummary(findings) {
  const out = {};
  for (const f of findings || []) {
    const k = f.disposition || 'review';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

async function pixelGuardScanDir(targetDir, flags = {}) {
  const specs = pixelGuardSpecs();
  const allowedDomains = uniqueList([
    ...PLANEKEY_KNOWN_SAFE_DOMAINS,
    ...parseCsvFlag(flags.allowedDomains),
    ...parseCsvFlag(flags.domain),
    ...parseCsvFlag(flags.zone)
  ]);
  const skipPatterns = uniqueList([
    ...PLANEKEY_TRI_LAYER_FORBIDDEN,
    'node_modules/**', '.git/**', 'vault/**', 'reports/**', 'exports/**', 'bundles/**', 'inventory/**'
  ]);
  const files = await walkFiles(targetDir, { skipPatterns });
  const findings = [];
  const domains = new Map();
  const fileStats = [];
  for (const f of files) {
    if (!PIXELGUARD_TEXT_EXTS.has(path.extname(f.rel).toLowerCase())) continue;
    const text = await readTextLimited(f.abs, Number(flags.maxBytes || 2 * 1024 * 1024));
    if (text == null) continue;
    const hits = lineHits(text, f.rel, specs, 300).map((h) => {
      const spec = specs.find((s) => s.type === h.type) || {};
      return { ...h, category: spec.category || 'residue', disposition: spec.disposition || 'review' };
    });
    findings.push(...hits);
    const ds = extractDomains(text);
    for (const d of ds) {
      const rec = domains.get(d) || { domain: d, count: 0, files: [] };
      rec.count += 1;
      if (rec.files.length < 40) rec.files.push(f.rel);
      domains.set(d, rec);
    }
    fileStats.push({ file: f.rel, findings: hits.length, bytes: Buffer.byteLength(text, 'utf8'), domains: ds.length });
  }
  const thirdPartyDomains = [...domains.values()]
    .filter((d) => !domainAllowed(d.domain, allowedDomains))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  for (const d of thirdPartyDomains) {
    findings.push({
      type: /polsia/i.test(d.domain) ? 'polsia_domain_residue' : 'third_party_domain_residue',
      category: /polsia/i.test(d.domain) ? 'builder_residue' : 'edge_dependency',
      severity: /polsia/i.test(d.domain) ? 'review' : 'warn',
      disposition: /polsia/i.test(d.domain) ? 'replace_or_allowlist' : 'review',
      file: d.files[0] || '',
      line: 0,
      evidence: d.domain,
      reason: 'Domain is outside the allowed ConversationChain/Cloudflare domain set',
      domain: d.domain,
      files: d.files
    });
  }
  const counts = {};
  const categories = {};
  for (const f of findings) {
    counts[f.type] = (counts[f.type] || 0) + 1;
    categories[f.category || 'residue'] = (categories[f.category || 'residue'] || 0) + 1;
  }
  const score = pixelRiskScore(findings);
  const status = findings.some((f) => f.severity === 'fail' || f.severity === 'critical') ? 'fail' : (findings.length ? 'warn' : 'pass');
  const riskLevel = status === 'fail' || score >= 80 ? 'red' : score >= 35 ? 'orange' : score > 0 ? 'yellow' : 'green';
  return {
    schema: 'planekey.pixelguard-scan.v1',
    generated_at: nowIso(),
    client_version: VERSION,
    target_dir: targetDir,
    status,
    risk_level: riskLevel,
    risk_score: score,
    allowed_domains: allowedDomains,
    counts,
    categories,
    disposition_summary: pixelDispositionSummary(findings),
    findings,
    third_party_domains: thirdPartyDomains,
    scanned_text_files: fileStats.length,
    file_stats: fileStats.sort((a, b) => b.findings - a.findings || a.file.localeCompare(b.file)).slice(0, 300)
  };
}

function pixelGuardMarkdown(report) {
  const lines = [];
  lines.push('# PlaneKey PixelGuard Scan');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Status: ${String(report.status).toUpperCase()}`);
  lines.push(`Risk level: ${String(report.risk_level).toUpperCase()}`);
  lines.push(`Risk score: ${report.risk_score}`);
  lines.push(`Text files scanned: ${report.scanned_text_files}`);
  lines.push('');
  lines.push('## Categories');
  lines.push('');
  for (const [k, v] of Object.entries(report.categories || {}).sort((a,b)=>b[1]-a[1])) lines.push(`- ${k}: ${v}`);
  if (!Object.keys(report.categories || {}).length) lines.push('- None');
  lines.push('');
  lines.push('## Dispositions');
  lines.push('');
  for (const [k, v] of Object.entries(report.disposition_summary || {}).sort((a,b)=>b[1]-a[1])) lines.push(`- ${k}: ${v}`);
  if (!Object.keys(report.disposition_summary || {}).length) lines.push('- None');
  lines.push('');
  lines.push('## Finding counts');
  lines.push('');
  for (const [k, v] of Object.entries(report.counts || {}).sort((a,b)=>b[1]-a[1])) lines.push(`- ${k}: ${v}`);
  if (!Object.keys(report.counts || {}).length) lines.push('- None');
  lines.push('');
  lines.push('## Notable findings');
  lines.push('');
  for (const f of (report.findings || []).slice(0, 160)) {
    const loc = f.line ? `${f.file}:${f.line}` : (f.file || 'global');
    lines.push(`- **${f.severity}/${f.type}** [${f.category || 'residue'} → ${f.disposition || 'review'}] — ${loc}`);
    lines.push(`  - ${f.reason || ''}`.trimEnd());
    if (f.evidence) lines.push(`  - evidence: ${String(f.evidence).replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  if ((report.findings || []).length > 160) lines.push(`- ... ${(report.findings || []).length - 160} more findings`);
  lines.push('');
  return lines.join('\n');
}

async function commandPixelGuardScan(root, target, flags) {
  if (!target) throw new Error('Usage: pk-client pixelguard scan <folder-or-snapshot-or-zip> [--name report-name] [--allowedDomains domain1,domain2]');
  await ensureWorkspace(root);
  const p = paths(root);
  const resolved = await resolveScanInputDir(root, target, 'pixelguard', flags);
  try {
    const report = await pixelGuardScanDir(resolved.dir, flags);
    report.source = resolved.label;
    const name = slugify(flags.name || 'pixelguard-' + safeDateStamp());
    const outDir = path.join(p.reports, 'pixelguard', name);
    await fsp.mkdir(outDir, { recursive: true });
    await writeJson(path.join(outDir, 'PIXELGUARD_SCAN.json'), report);
    await writeText(path.join(outDir, 'PIXELGUARD_SCAN.md'), pixelGuardMarkdown(report));
    console.log(`PixelGuard status: ${report.status.toUpperCase()} (${report.risk_level}, score ${report.risk_score})`);
    console.log('Report written: ' + path.join(outDir, 'PIXELGUARD_SCAN.md'));
  } finally {
    if (resolved.cleanup && !flags.keepTemp) await fsp.rm(resolved.cleanup, { recursive: true, force: true }).catch(() => {});
  }
}

function residueReportFromPixel(pixel, flags = {}) {
  const findings = pixel.findings || [];
  const grouped = {};
  for (const f of findings) {
    const k = f.category || 'residue';
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(f);
  }
  const recommendations = [];
  const addRec = (condition, text) => { if (condition) recommendations.push(text); };
  addRec((pixel.counts || {}).polsia_hidden_pixel_or_beacon || (pixel.counts || {}).hidden_tracking_pixel, 'Remove hidden pixel/beacon surfaces before public repo or live deployment.');
  addRec((pixel.counts || {}).email_capture_surface, 'Review or remove email capture surfaces; verify consent/policy and destination.');
  addRec((pixel.counts || {}).stale_hosted_url || (pixel.counts || {}).polsia_domain_residue, 'Replace stale Polsia-hosted URLs with conversationchain.com/app or explicitly allowlist visible attribution.');
  addRec((pixel.counts || {}).agent_runtime_residue, 'Quarantine agent runtime/control-plane residue as forensic evidence only.');
  addRec((pixel.counts || {}).dynamic_js_injection_surface, 'Review dynamic JS/HTML injection surfaces before accepting branch grafts.');
  if (!recommendations.length) recommendations.push('No residue removals required by PixelGuard. Keep standard RepoGuard/SafetyNet checks in place.');
  // ── Health: a bounded, interpretable read instead of an uncapped raw sum.
  // The raw risk_score grows with repo size (a big project always looks "RED"),
  // which reads to a customer like their whole system is dead. Normalize to a
  // 0-100% files-clean figure and split findings by what they actually demand:
  //   actionable   — must fix before ship (remove / replace / block)
  //   forensic      — quarantine-by-design (honeypot, agent residue): intentional
  //   advisory      — review, not blocking
  const _findings = pixel.findings || [];
  const _scanned = Number(pixel.scanned_text_files || 0);
  const _flaggedFiles = new Set(_findings.map(f => f.file).filter(Boolean)).size;
  const _cleanPct = _scanned > 0 ? Math.round(100 * (1 - _flaggedFiles / _scanned)) : 100;
  const _disp = pixel.disposition_summary || {};
  const _actionable = (_disp.remove || 0) + (_disp.replace_or_allowlist || 0) + (_disp.block || 0);
  const _forensic = (_disp.quarantine || 0);
  const _advisory = (_disp.review || 0) + (_disp.review_or_remove || 0);
  const _severity = _actionable === 0 ? (_advisory ? 'advisory' : 'clean')
    : _actionable <= 5 ? 'low' : _actionable <= 25 ? 'medium' : 'high';
  const health = {
    files_scanned: _scanned,
    files_flagged: _flaggedFiles,
    files_clean_percent: _cleanPct,
    files_clean_basis_points: _cleanPct * 100,   // repo idiom (per-10,000)
    actionable: _actionable,
    forensic_by_design: _forensic,
    advisory: _advisory,
    severity: _severity,
  };
  return {
    schema: 'planekey.residue-map.v1',
    generated_at: nowIso(),
    client_version: VERSION,
    source: pixel.source || pixel.target_dir,
    status: pixel.status,
    health,
    risk_level: pixel.risk_level,
    risk_score: pixel.risk_score,
    risk_score_note: 'uncapped raw weighted sum — grows with repo size; use `health` for an interpretable read',
    categories: pixel.categories || {},
    counts: pixel.counts || {},
    disposition_summary: pixel.disposition_summary || {},
    grouped_findings: Object.fromEntries(Object.entries(grouped).map(([k, arr]) => [k, arr.slice(0, 200)])),
    recommendations,
    pixelguard: pixel
  };
}

function residueMapMarkdown(map) {
  const lines = [];
  lines.push('# PlaneKey Residue Map');
  lines.push('');
  lines.push(`Generated: ${map.generated_at}`);
  const h = map.health || {};
  // Lead with the interpretable health read, not the scary raw sum.
  lines.push('');
  lines.push('## Health');
  lines.push('');
  lines.push(`**${h.files_clean_percent ?? '—'}% of files clean** ` +
    `(${(h.files_scanned || 0) - (h.files_flagged || 0)}/${h.files_scanned || 0} scanned files with no residue). ` +
    `Severity: **${h.severity || 'n/a'}**.`);
  lines.push('');
  lines.push('| bucket | count | meaning |');
  lines.push('|---|--:|---|');
  lines.push(`| actionable | ${h.actionable ?? 0} | must fix before ship (remove / replace / block) |`);
  lines.push(`| forensic-by-design | ${h.forensic_by_design ?? 0} | quarantine — intentional (honeypot / agent residue), keep as evidence |`);
  lines.push(`| advisory | ${h.advisory ?? 0} | review, not blocking |`);
  lines.push('');
  lines.push(`> The raw **risk score ${map.risk_score}** below is an *uncapped weighted sum* — it grows with ` +
    `repo size, so a large project always looks alarming. Read the **% clean + actionable count** above ` +
    `instead; that is the real signal.`);
  lines.push('');
  lines.push(`Status: ${String(map.status).toUpperCase()} · Risk level: ${String(map.risk_level).toUpperCase()} · Raw risk score: ${map.risk_score}`);
  lines.push('');
  lines.push('## Recommendations');
  lines.push('');
  for (const r of map.recommendations || []) lines.push('- ' + r);
  lines.push('');
  lines.push('## Categories');
  lines.push('');
  for (const [k, v] of Object.entries(map.categories || {}).sort((a,b)=>b[1]-a[1])) lines.push(`- ${k}: ${v}`);
  if (!Object.keys(map.categories || {}).length) lines.push('- None');
  lines.push('');
  lines.push('## Residue groups');
  lines.push('');
  for (const [cat, arr] of Object.entries(map.grouped_findings || {})) {
    lines.push(`### ${cat} (${arr.length})`);
    lines.push('');
    for (const f of arr.slice(0, 40)) {
      const loc = f.line ? `${f.file}:${f.line}` : (f.file || 'global');
      lines.push(`- **${f.type}** ${loc} — ${f.disposition || 'review'} — ${f.reason || ''}`);
    }
    if (arr.length > 40) lines.push(`- ... ${arr.length - 40} more`);
    lines.push('');
  }
  return lines.join('\n');
}

async function commandResidueMap(root, target, flags) {
  if (!target) throw new Error('Usage: pk-client residue map <folder-or-snapshot-or-zip> [--name report-name]');
  await ensureWorkspace(root);
  const p = paths(root);
  const resolved = await resolveScanInputDir(root, target, 'residue', flags);
  try {
    const pixel = await pixelGuardScanDir(resolved.dir, flags);
    pixel.source = resolved.label;
    const map = residueReportFromPixel(pixel, flags);
    const name = slugify(flags.name || 'residue-map-' + safeDateStamp());
    const outDir = path.join(p.reports, 'residue', name);
    await fsp.mkdir(outDir, { recursive: true });
    await writeJson(path.join(outDir, 'RESIDUE_MAP.json'), map);
    await writeText(path.join(outDir, 'RESIDUE_MAP.md'), residueMapMarkdown(map));
    await writeJson(path.join(outDir, 'PIXELGUARD_SCAN.json'), pixel);
    const h = map.health || {};
    console.log(`Residue map: ${h.files_clean_percent}% files clean · ${h.actionable} actionable · ` +
      `${h.forensic_by_design} forensic-by-design · ${h.advisory} advisory · severity ${h.severity} ` +
      `(raw score ${map.risk_score}, uncapped)`);
    console.log('Report written: ' + path.join(outDir, 'RESIDUE_MAP.md'));
  } finally {
    if (resolved.cleanup && !flags.keepTemp) await fsp.rm(resolved.cleanup, { recursive: true, force: true }).catch(() => {});
  }
}

function findingKey(f) {
  return [f.type || '', f.file || '', f.line || 0, String(f.evidence || '').slice(0, 120)].join('|');
}

function residueCompareMarkdown(cmp) {
  const lines = [];
  lines.push('# PlaneKey Residue Compare');
  lines.push('');
  lines.push(`Generated: ${cmp.generated_at}`);
  lines.push(`Status: ${String(cmp.status).toUpperCase()}`);
  lines.push(`Risk level: ${String(cmp.risk_level).toUpperCase()}`);
  lines.push(`New findings: ${cmp.counts.new_findings}`);
  lines.push(`Resolved findings: ${cmp.counts.resolved_findings}`);
  lines.push('');
  lines.push('## New residue introduced by candidate');
  lines.push('');
  if (!cmp.new_findings.length) lines.push('- None');
  for (const f of cmp.new_findings.slice(0, 120)) {
    const loc = f.line ? `${f.file}:${f.line}` : (f.file || 'global');
    lines.push(`- **${f.severity}/${f.type}** [${f.category || 'residue'} → ${f.disposition || 'review'}] — ${loc}`);
    if (f.evidence) lines.push(`  - ${String(f.evidence).replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  if (cmp.new_findings.length > 120) lines.push(`- ... ${cmp.new_findings.length - 120} more`);
  lines.push('');
  lines.push('## Residue resolved by candidate');
  lines.push('');
  if (!cmp.resolved_findings.length) lines.push('- None');
  for (const f of cmp.resolved_findings.slice(0, 80)) {
    const loc = f.line ? `${f.file}:${f.line}` : (f.file || 'global');
    lines.push(`- **${f.type}** — ${loc}`);
  }
  return lines.join('\n');
}

async function commandResidueCompare(root, canon, candidate, flags) {
  if (!canon || !candidate) throw new Error('Usage: pk-client residue compare <canon-folder-or-snapshot-or-zip> <candidate-folder-or-snapshot-or-zip> [--name report-name]');
  await ensureWorkspace(root);
  const p = paths(root);
  const left = await resolveScanInputDir(root, canon, 'residue-left', flags);
  const right = await resolveScanInputDir(root, candidate, 'residue-right', flags);
  try {
    const leftScan = await pixelGuardScanDir(left.dir, flags); leftScan.source = left.label;
    const rightScan = await pixelGuardScanDir(right.dir, flags); rightScan.source = right.label;
    const leftKeys = new Set((leftScan.findings || []).map(findingKey));
    const rightKeys = new Set((rightScan.findings || []).map(findingKey));
    const newFindings = (rightScan.findings || []).filter((f) => !leftKeys.has(findingKey(f)));
    const resolvedFindings = (leftScan.findings || []).filter((f) => !rightKeys.has(findingKey(f)));
    const newScore = pixelRiskScore(newFindings);
    const status = newFindings.some((f) => f.severity === 'fail' || f.severity === 'critical') ? 'fail' : (newFindings.length ? 'warn' : 'pass');
    const riskLevel = status === 'fail' || newScore >= 80 ? 'red' : newScore >= 35 ? 'orange' : newScore > 0 ? 'yellow' : 'green';
    const cmp = {
      schema: 'planekey.residue-compare.v1',
      generated_at: nowIso(),
      client_version: VERSION,
      canon_source: left.label,
      candidate_source: right.label,
      status,
      risk_level: riskLevel,
      risk_score: newScore,
      counts: {
        canon_findings: (leftScan.findings || []).length,
        candidate_findings: (rightScan.findings || []).length,
        new_findings: newFindings.length,
        resolved_findings: resolvedFindings.length
      },
      new_findings: newFindings,
      resolved_findings: resolvedFindings,
      canon_scan: leftScan,
      candidate_scan: rightScan
    };
    const name = slugify(flags.name || 'residue-compare-' + safeDateStamp());
    const outDir = path.join(p.reports, 'residue', name);
    await fsp.mkdir(outDir, { recursive: true });
    await writeJson(path.join(outDir, 'RESIDUE_COMPARE.json'), cmp);
    await writeText(path.join(outDir, 'RESIDUE_COMPARE.md'), residueCompareMarkdown(cmp));
    console.log(`Residue compare status: ${cmp.status.toUpperCase()} (${cmp.risk_level}, new findings ${newFindings.length})`);
    console.log('Report written: ' + path.join(outDir, 'RESIDUE_COMPARE.md'));
  } finally {
    if (left.cleanup && !flags.keepTemp) await fsp.rm(left.cleanup, { recursive: true, force: true }).catch(() => {});
    if (right.cleanup && !flags.keepTemp) await fsp.rm(right.cleanup, { recursive: true, force: true }).catch(() => {});
  }
}

async function commandResidueExplain(root, input, flags) {
  if (!input) throw new Error('Usage: pk-client residue explain <RESIDUE_MAP.json|RESIDUE_COMPARE.json|report-folder> [--name report-name]');
  await ensureWorkspace(root);
  const p = paths(root);
  let file = path.resolve(input);
  if (isDir(file)) {
    for (const c of ['RESIDUE_COMPARE.json', 'RESIDUE_MAP.json', 'PIXELGUARD_SCAN.json']) {
      const f = path.join(file, c);
      if (isFile(f)) { file = f; break; }
    }
  }
  const obj = readJsonIfExists(file, null);
  if (!obj) throw new Error('Could not read residue report JSON: ' + file);
  let md;
  if (String(obj.schema || '').includes('residue-compare')) md = residueCompareMarkdown(obj);
  else if (String(obj.schema || '').includes('residue-map')) md = residueMapMarkdown(obj);
  else if (String(obj.schema || '').includes('pixelguard')) md = pixelGuardMarkdown(obj);
  else throw new Error('Input is not a PixelGuard/Residue report: ' + file);
  const name = slugify(flags.name || 'residue-explain-' + safeDateStamp());
  const outDir = path.join(p.reports, 'residue', name);
  await fsp.mkdir(outDir, { recursive: true });
  const explainer = '# PlaneKey Residue Explanation\n\nThis report separates hosted-builder/platform residue from deployable application source. It is intended for canon merge review, not automatic deletion.\n\n' + md;
  await writeText(path.join(outDir, 'RESIDUE_EXPLANATION.md'), explainer);
  console.log('Residue explanation written: ' + path.join(outDir, 'RESIDUE_EXPLANATION.md'));
}

// ───────────────────────────────────────────────────────────────────────────
// Bridge client — v0.1.5.8 (closes the adapter-to-bridge loop for the five
// one-shot adapters in bridge/tools/. The MCP env-observer adapter is a
// long-running daemon and lives outside this CLI.)
//
// DEPLOYMENT TIERS (canon, 2026-06-23):
//
//   TIER 1 — Personal / SMB. Auth + operational both run through the
//            PlaneKey home bridge (https://bridge.planekey.dev). No
//            customer-side bridge. Default config; no env vars needed.
//
//   TIER 2 — Enterprise (non-mirror). Operational bridge deployed inside
//            the enterprise infrastructure boundary. Auth is STILL the
//            PlaneKey home bridge — their employees' accounts are
//            PlaneKey accounts; the enterprise controls only the
//            company-scoped range of those accounts (employee roster,
//            role assignments, entitlements within their workspace).
//            PLANEKEY_BRIDGE_URL points at the enterprise bridge for
//            operational traffic; auth calls still hit the home bridge.
//
//   TIER 3 — Enterprise (mirror-opted). Same as Tier 2, plus the
//            enterprise has opted into PlaneKey's network-node /
//            mirror service, becoming a federated auth replica. They
//            get closer to "full auth" — but the PlaneKey home bridge
//            stays the canonical authority cosmos-wide. Mirror nodes
//            REPLICATE the auth state; they do not OWN it. Future flag:
//            PLANEKEY_MIRROR_NODE=true + PLANEKEY_MIRROR_ID=<uuid>.
//
//   AUTH BRIDGE — locked at `https://bridge.planekey.dev` for all three
//                 tiers. The "auth central" is cosmos-wide; even mirror
//                 nodes follow it, not the other way around.
//
// Resolution order for the OPERATIONAL bridge (first match wins):
//   --operational-bridge-url <url>   CLI flag
//   PLANEKEY_BRIDGE_URL=<url>        env var
//   client.config.json bridge.url
//   AUTH_BRIDGE_URL                  (default — same as auth)
//
// AUTH_BRIDGE_URL is intentionally not surfaced as a flag or env var on
// non-test builds — it's a security anchor, not a knob. Test/dev builds
// can override via PLANEKEY_AUTH_BRIDGE_URL but production refuses it.
//
// Per-user config:
//   --operational-bridge-url | PLANEKEY_BRIDGE_URL    | bridge.url
//   --bridge-token           | PLANEKEY_SESSION_TOKEN | bridge.token
//   --hmac-secret            | PLANEKEY_HMAC_SECRET   | bridge.hmacSecret
//   --service                | (no env)               | bridge.serviceId
//
// HMAC payload formats per endpoint (mirrored from src/main.rs handlers):
//   /reports/update       service_id:report_hash:base_runtime_hash:proposed_runtime_hash
//   /reports/runtime      service_id:expected_runtime_hash:observed_runtime_hash
//   /reports/closure      service_id:linked_update_report_hash:expected_runtime_hash:post_fix_runtime_hash
//   /canon/analyze        service_id:source_bundle_hash:functions_total:duplicate_patterns:canon_score_basis_points
//   /forensics/attribution service_id:artifact_hash:attribution_kind:confidence_basis_points
//   /rootrabbit/health-report region_code:route_hash:latency_ms:packet_loss_basis_points:drift_score_basis_points:runtime_match
//   /rgano/signature-packet  (no HMAC; idempotent on signature_hash)
// ───────────────────────────────────────────────────────────────────────────

// AUTH BRIDGE — locked cosmos-wide. Every account anchors here.
const AUTH_BRIDGE_URL = (process.env.NODE_ENV === 'test' && process.env.PLANEKEY_AUTH_BRIDGE_URL)
  ? process.env.PLANEKEY_AUTH_BRIDGE_URL
  : 'https://bridge.planekey.dev';

// OPERATIONAL BRIDGE — defaults to auth; enterprise can override.
function resolveOperationalBridgeUrl(root, flags) {
  if (flags && flags['--operational-bridge-url']) return flags['--operational-bridge-url'];
  if (flags && flags['--bridge-url']) return flags['--bridge-url']; // back-compat
  if (process.env.PLANEKEY_BRIDGE_URL) return process.env.PLANEKEY_BRIDGE_URL;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'client.config.json'), 'utf8'));
    if (cfg.bridge && cfg.bridge.url) return cfg.bridge.url;
  } catch (_) {}
  return AUTH_BRIDGE_URL;
}

// Back-compat: existing call sites reference BRIDGE_URL as a constant.
// Points at the auth bridge because that's where auth-flavored calls land
// (register, login, session). Callers doing operational work
// (reports, attestations, transport) should switch to
// resolveOperationalBridgeUrl(root, flags).
const BRIDGE_URL = AUTH_BRIDGE_URL;

function loadBridgeConfig(root, flags) {
  const fromFile = (() => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, 'client.config.json'), 'utf8'));
      return cfg.bridge || {};
    } catch { return {}; }
  })();
  const token =
    flags['bridge-token']
    || process.env.PLANEKEY_SESSION_TOKEN
    || fromFile.token
    || '';
  const hmacSecret =
    flags['hmac-secret']
    || process.env.PLANEKEY_HMAC_SECRET
    || fromFile.hmacSecret
    || '';
  const serviceId =
    flags.service
    || flags['service-id']
    || fromFile.serviceId
    || 'planekey-home-bridge';
  return { url: BRIDGE_URL, token, hmacSecret, serviceId };
}

async function saveEnvelope(root, kind, envelope) {
  const dir = path.join(root, 'reports', 'bridge-envelopes');
  await fsp.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${ts}_${kind}.json`);
  await fsp.writeFile(file, JSON.stringify(envelope, null, 2));
  return file;
}

function wantsSubmit(flags) {
  return flags.submit === true || flags.submit === 'true';
}

function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function signEnvelope(secret, envelope, payloadFn) {
  const signaturePayload = payloadFn(envelope);
  const signature = secret ? hmacHex(secret, signaturePayload) : '';
  return { ...envelope, signature, signature_payload: signaturePayload };
}

async function postBridge(bridge, routePath, body) {
  const u = new URL(routePath, bridge.url + '/');
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  const data = Buffer.from(JSON.stringify(body));
  const opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    headers: {
      'content-type': 'application/json',
      'content-length': data.length,
      'user-agent': `pk-client/${VERSION}`,
    },
  };
  if (bridge.token) opts.headers['authorization'] = `Bearer ${bridge.token}`;
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function saveReceipt(root, kind, receipt) {
  const dir = path.join(root, 'reports', 'bridge-receipts');
  await fsp.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${ts}_${kind}.json`);
  await fsp.writeFile(file, JSON.stringify(receipt, null, 2));
  return file;
}

function bridgeError(label, response) {
  const detail = response.body && response.body.error
    ? response.body.error
    : JSON.stringify(response.body);
  throw new Error(`${label}: bridge returned ${response.status} — ${detail}`);
}

// ── Cluster: flight reports ────────────────────────────────────────────────
//
// Absorbs the logic of bridge/tools/pk-flight-report.js. Walks --dir, hashes
// every file, computes base/proposed/changed-files hashes, builds the three
// report envelopes (update, runtime, closure), signs each, posts to the
// matching bridge route. Writes the bundle + per-report files locally so
// the user has a reviewable audit trail.

function walkFlightFiles(dir) {
  const out = [];
  function recurse(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'target' || entry.name === 'reports') continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) recurse(p);
      else out.push(p);
    }
  }
  recurse(dir);
  return out;
}

async function commandFlightReport(root, flags) {
  if (!flags.base || !flags.proposed) {
    throw new Error('flight report requires --base <version> --proposed <version>');
  }
  const dir = path.resolve(flags.dir || root);
  const bridge = loadBridgeConfig(root, flags);
  const files = walkFlightFiles(dir)
    .map((p) => {
      const rel = path.relative(dir, p).split(path.sep).join('/');
      const buf = fs.readFileSync(p);
      return { path: rel, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const manifestJson = JSON.stringify(files);
  const changedFilesHash = crypto.createHash('sha256').update(manifestJson).digest('hex');
  const proposedRuntimeHash = crypto.createHash('sha256').update(`${bridge.serviceId}:${flags.proposed}:${changedFilesHash}`).digest('hex');
  const baseRuntimeHash = crypto.createHash('sha256').update(`${bridge.serviceId}:${flags.base}`).digest('hex');
  const reportHash = crypto.createHash('sha256').update(`${bridge.serviceId}:${baseRuntimeHash}:${proposedRuntimeHash}:${changedFilesHash}`).digest('hex');
  const generatedAt = new Date().toISOString();
  const bridgeId = flags['bridge-id'] || null;

  const updateUnsigned = {
    service_id: bridge.serviceId,
    bridge_id: bridgeId,
    report_hash: reportHash,
    base_runtime_hash: baseRuntimeHash,
    proposed_runtime_hash: proposedRuntimeHash,
    changed_files_hash: changedFilesHash,
    closure_check_passed: flags.closurePassed !== 'false',
  };
  const update = signEnvelope(bridge.hmacSecret, updateUnsigned, (e) =>
    `${e.service_id}:${e.report_hash}:${e.base_runtime_hash}:${e.proposed_runtime_hash}`);

  const runtimeUnsigned = {
    service_id: bridge.serviceId,
    bridge_id: bridgeId,
    expected_runtime_hash: proposedRuntimeHash,
    observed_runtime_hash: proposedRuntimeHash,
    route_hash: flags['route-hash'] || null,
  };
  const runtime = signEnvelope(bridge.hmacSecret, runtimeUnsigned, (e) =>
    `${e.service_id}:${e.expected_runtime_hash}:${e.observed_runtime_hash}`);

  const closureUnsigned = {
    service_id: bridge.serviceId,
    bridge_id: bridgeId,
    linked_update_report_hash: reportHash,
    expected_runtime_hash: proposedRuntimeHash,
    post_fix_runtime_hash: proposedRuntimeHash,
    route_verified: true,
    semantic_packet_ready: true,
  };
  const closure = signEnvelope(bridge.hmacSecret, closureUnsigned, (e) =>
    `${e.service_id}:${e.linked_update_report_hash}:${e.expected_runtime_hash}:${e.post_fix_runtime_hash}`);

  const flightBundle = {
    kind: 'planekey.flight_report_bundle',
    version: '0.2.2',
    generated_at: generatedAt,
    service_id: bridge.serviceId,
    base_version: flags.base,
    proposed_version: flags.proposed,
    private_manifest: { files_count: files.length, changed_files_hash: changedFilesHash, files },
    reports: { update, runtime, closure },
  };

  const outDir = path.join(root, 'flight-reports');
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, 'planekey-flight-report-bundle.json'), JSON.stringify(flightBundle, null, 2));
  await fsp.writeFile(path.join(outDir, 'planekey-update-report.json'), JSON.stringify(update, null, 2));
  await fsp.writeFile(path.join(outDir, 'planekey-runtime-report.json'), JSON.stringify(runtime, null, 2));
  await fsp.writeFile(path.join(outDir, 'planekey-closure-report.json'), JSON.stringify(closure, null, 2));

  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({ ok: true, submitted: false, outDir, reportHash, filesCount: files.length, hint: 'pass --submit to POST these to bridge.planekey.dev' }, null, 2));
    return;
  }
  if (!bridge.hmacSecret) {
    throw new Error('--hmac-secret or PLANEKEY_HMAC_SECRET required for --submit (omit --submit to keep the run local)');
  }

  const results = {};
  for (const [routeName, envelope] of [['update', update], ['runtime', runtime], ['closure', closure]]) {
    const res = await postBridge(bridge, `/v1/reports/${routeName}`, envelope);
    if (res.status >= 400) bridgeError(`flight ${routeName}`, res);
    results[routeName] = res.body;
  }
  const receiptFile = await saveReceipt(root, 'flight', { generatedAt, bundle: flightBundle, results });
  console.log(JSON.stringify({ ok: true, reportHash, filesCount: files.length, results, receipt: receiptFile }, null, 2));
}

// ── Cluster: canon + forensics ─────────────────────────────────────────────

async function commandCanonAnalyze(root, inputPath, flags) {
  if (!inputPath) throw new Error('canon analyze requires <input.json>');
  const bridge = loadBridgeConfig(root, flags);
  const raw = JSON.parse(await fsp.readFile(path.resolve(inputPath), 'utf8'));
  const functions = raw.functions || raw.function_records || raw.records || [];
  const duplicatePatterns = raw.duplicate_patterns ?? raw.duplicates ?? raw.duplicateCount ?? 0;
  const overlapPatterns = raw.overlap_patterns ?? raw.overlaps ?? raw.overlapCount ?? 0;
  const cleanupCandidates = raw.cleanup_candidates ?? raw.cleanupCandidates ?? 0;
  const functionsTotal = raw.functions_total ?? raw.functionsTotal ?? functions.length ?? 0;
  const canonScore = raw.canon_score_basis_points ?? raw.canonScoreBasisPoints
    ?? Math.max(0, 10000 - (duplicatePatterns * 10) - (overlapPatterns * 5));
  const sourceBundleHash = raw.source_bundle_hash || raw.bundle_hash
    || crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex');

  const unsigned = {
    service_id: bridge.serviceId,
    source_bundle_hash: sourceBundleHash,
    analyzer_version: raw.analyzer_version || raw.version || 'pk-client',
    functions_total: functionsTotal,
    duplicate_patterns: duplicatePatterns,
    overlap_patterns: overlapPatterns,
    cleanup_candidates: cleanupCandidates,
    canon_score_basis_points: canonScore,
    function_records: functions.slice(0, 5000).map((f) => ({
      file_path: f.file_path || f.file || f.path || 'unknown',
      function_name: f.function_name || f.name || f.symbol || 'unknown',
      signature_hash: f.signature_hash || crypto.createHash('sha256').update(JSON.stringify(f.signature || f.name || f)).digest('hex'),
      body_hash: f.body_hash || crypto.createHash('sha256').update(JSON.stringify(f.body || f.source || f)).digest('hex'),
      line_start: f.line_start ?? f.start ?? null,
      line_end: f.line_end ?? f.end ?? null,
      language: f.language || f.lang || null,
    })),
  };
  const envelope = signEnvelope(bridge.hmacSecret, unsigned, (e) =>
    `${e.service_id}:${e.source_bundle_hash}:${e.functions_total}:${e.duplicate_patterns}:${e.canon_score_basis_points}`);

  if (!wantsSubmit(flags)) {
    const file = await saveEnvelope(root, 'canon-analyze', envelope);
    console.log(JSON.stringify({ ok: true, submitted: false, envelopeFile: file, hint: 'pass --submit to POST to bridge.planekey.dev' }, null, 2));
    return;
  }
  if (!bridge.hmacSecret) {
    throw new Error('--hmac-secret or PLANEKEY_HMAC_SECRET required for --submit (omit --submit to keep the run local)');
  }
  const res = await postBridge(bridge, '/v1/canon/analyze', envelope);
  if (res.status >= 400) bridgeError('canon analyze', res);
  const receipt = await saveReceipt(root, 'canon-analyze', { envelope, response: res.body });
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body, receipt }, null, 2));
}

async function commandForensicsAttribution(root, inputPath, flags) {
  if (!inputPath) throw new Error('forensics attribution requires <input.json>');
  const bridge = loadBridgeConfig(root, flags);
  const raw = JSON.parse(await fsp.readFile(path.resolve(inputPath), 'utf8'));
  const artifactHash = raw.artifact_hash || raw.hash || raw.source_hash
    || crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex');
  const confidence = raw.confidence_basis_points ?? raw.confidenceBasisPoints
    ?? Math.round((raw.confidence || 0.6) * 10000);
  const kind = raw.attribution_kind || raw.kind || 'forensic_analysis';

  const unsigned = {
    service_id: bridge.serviceId,
    artifact_hash: artifactHash,
    attribution_kind: kind,
    suspected_source: raw.suspected_source || raw.source || null,
    confidence_basis_points: confidence,
    evidence_hashes: raw.evidence_hashes || raw.evidenceHashes || [],
    summary: raw.summary || raw.finding || 'Forensic attribution submitted via pk-client.',
  };
  const envelope = signEnvelope(bridge.hmacSecret, unsigned, (e) =>
    `${e.service_id}:${e.artifact_hash}:${e.attribution_kind}:${e.confidence_basis_points}`);

  if (!wantsSubmit(flags)) {
    const file = await saveEnvelope(root, 'forensics-attribution', envelope);
    console.log(JSON.stringify({ ok: true, submitted: false, envelopeFile: file, hint: 'pass --submit to POST to bridge.planekey.dev' }, null, 2));
    return;
  }
  if (!bridge.hmacSecret) {
    throw new Error('--hmac-secret or PLANEKEY_HMAC_SECRET required for --submit (omit --submit to keep the run local)');
  }
  const res = await postBridge(bridge, '/v1/forensics/attribution', envelope);
  if (res.status >= 400) bridgeError('forensics attribution', res);
  const receipt = await saveReceipt(root, 'forensics-attribution', { envelope, response: res.body });
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body, receipt }, null, 2));
}

// ── Cluster: rgano signature packet ────────────────────────────────────────
//
// Absorbs bridge/tools/rgano_packet_adapter.py. The bridge endpoint
// (POST /rgano/signature-packet, v0.2.11) is idempotent on signature_hash
// and does NOT require an HMAC signature, so no envelope signing step.

const RGANO_EXTRACTOR_DOMAIN = {
  'rgano_scene.py': 'scene',
  'rgano_image.py': 'image',
  'rgano_taxonomy.py': 'taxonomy',
  'rgano_coastline.py': 'coastline',
  'rgano_phase.py': 'phase',
  'rgano_aerial.py': 'aerial',
  'rgano_geo_recon.py': 'geo',
  'rgano_label_transfer.py': 'label_transfer',
  'container_annotation_and_proposal_tool.py': 'container_annotation',
};
const RGANO_NUMERIC_FIELDS = [
  'edge_density', 'region_count', 'region_size_variance',
  'flat_ratio', 'normal_entropy', 'max_gravity',
];

function deriveRganoSignatureHash(extractor, domain, raw, sourceNodeId) {
  const canon = {
    extractor,
    domain,
    source_node_id: sourceNodeId || null,
    labels: [...(raw.labels || [])].sort(),
    features: Object.fromEntries(
      RGANO_NUMERIC_FIELDS.filter((k) => k in raw).map((k) => [k, raw[k]])
    ),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon, Object.keys(canon).sort())).digest('hex');
}

async function commandRganoPacket(root, extractor, rawPath, flags) {
  if (!extractor || !rawPath) {
    throw new Error('rgano packet requires <extractor.py> <raw.json>');
  }
  if (!(extractor in RGANO_EXTRACTOR_DOMAIN)) {
    throw new Error(`unknown extractor: ${extractor}. Known: ${Object.keys(RGANO_EXTRACTOR_DOMAIN).join(', ')}`);
  }
  const bridge = loadBridgeConfig(root, flags);
  const raw = JSON.parse(await fsp.readFile(path.resolve(rawPath), 'utf8'));
  const domain = RGANO_EXTRACTOR_DOMAIN[extractor];
  const sourceNodeId = flags['source-node-id'] || null;
  const signatureHash = raw.signature_hash || deriveRganoSignatureHash(extractor, domain, raw, sourceNodeId);

  const packet = {
    service_id: bridge.serviceId,
    signature_hash: signatureHash,
    signature_kind: flags['signature-kind'] || raw.signature_kind || 'mesh_geometry',
    domain,
    extractor,
    extractor_version: flags['extractor-version'] || 'v0.1',
    payload: {},
  };
  if (sourceNodeId) packet.source_node_id = sourceNodeId;
  for (const k of RGANO_NUMERIC_FIELDS) {
    if (k in raw && raw[k] !== null && raw[k] !== undefined) packet[k] = raw[k];
  }
  if (raw.labels) packet.labels = raw.labels;
  if (raw.geometry) packet.geometry = raw.geometry;
  if (raw.confidence) packet.confidence = raw.confidence;
  if (raw.feature_vector) packet.feature_vector = raw.feature_vector;
  if (flags['signing-key-pub']) packet.signing_key_pub = flags['signing-key-pub'];
  if (flags.signature) packet.signature = flags.signature;
  // Move extractor-specific extras into payload
  const reserved = new Set([
    'signature_hash', 'signature_kind', 'domain', 'extractor', 'labels',
    'geometry', 'confidence', 'feature_vector', ...RGANO_NUMERIC_FIELDS,
  ]);
  for (const [k, v] of Object.entries(raw)) {
    if (!reserved.has(k)) packet.payload[k] = v;
  }

  if (!wantsSubmit(flags)) {
    const file = await saveEnvelope(root, 'rgano-packet', packet);
    console.log(JSON.stringify({ ok: true, submitted: false, envelopeFile: file, hint: 'pass --submit to POST to bridge.planekey.dev' }, null, 2));
    return;
  }
  const res = await postBridge(bridge, '/v1/rgano/signature-packet', packet);
  if (res.status >= 400) bridgeError('rgano packet', res);
  const receipt = await saveReceipt(root, 'rgano-packet', { packet, response: res.body });
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body, receipt }, null, 2));
}

// ── Cluster: rootrabbit health (closest extant endpoint for the nap adapter) ─

async function commandRootRabbitHealth(root, inputPath, flags) {
  if (!inputPath) throw new Error('rootrabbit health requires <observation.json>');
  const bridge = loadBridgeConfig(root, flags);
  const raw = JSON.parse(await fsp.readFile(path.resolve(inputPath), 'utf8'));
  if (!raw.target_route && !raw.route_hash) {
    throw new Error('observation must include target_route or route_hash');
  }
  const routeHash = raw.route_hash
    || crypto.createHash('sha256').update(raw.target_route).digest('hex');

  const unsigned = {
    mirror_id: raw.mirror_id || flags['mirror-id'] || null,
    region_code: raw.region_code,
    route_hash: routeHash,
    latency_ms: raw.latency_ms ?? 0,
    packet_loss_basis_points: raw.packet_loss_basis_points ?? 0,
    drift_score_basis_points: raw.drift_score_basis_points ?? 0,
    runtime_match: raw.runtime_match ?? true,
  };
  const envelope = signEnvelope(bridge.hmacSecret, unsigned, (e) =>
    `${e.region_code}:${e.route_hash}:${e.latency_ms}:${e.packet_loss_basis_points}:${e.drift_score_basis_points}:${e.runtime_match}`);

  if (!wantsSubmit(flags)) {
    const file = await saveEnvelope(root, 'rootrabbit-health', envelope);
    console.log(JSON.stringify({ ok: true, submitted: false, envelopeFile: file, hint: 'pass --submit to POST to bridge.planekey.dev' }, null, 2));
    return;
  }
  if (!bridge.hmacSecret) {
    throw new Error('--hmac-secret or PLANEKEY_HMAC_SECRET required for --submit (omit --submit to keep the run local)');
  }
  const res = await postBridge(bridge, '/v1/rootrabbit/health-report', envelope);
  if (res.status >= 400) bridgeError('rootrabbit health', res);
  const receipt = await saveReceipt(root, 'rootrabbit-health', { envelope, response: res.body });
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body, receipt }, null, 2));
}

// ── Cluster: bridge consumers (v0.1.5.9, closes the trio Cluster B gap) ────
//
// One subcommand per /bridge/* route the trio audit found unwired from
// pk-client. The audit ran against the canonical cross-reference
// databases (databases:rpg/products-rpg/rpg.sqlite and
// timeline/products-canon/pk-timeline.sqlite); see
// products:docs/TRIO_WIRING_AUDIT.md for the 0/7 starting state these
// commands move toward 7/7.
//
// All routes accept a session-bearer (PLANEKEY_SESSION_TOKEN); none
// require HMAC. Local-only by default — `--submit` POSTs to
// bridge.planekey.dev.

async function getBridge(bridge, routePath, queryParams) {
  const u = new URL(routePath, bridge.url + '/');
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
  }
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  const opts = {
    method: 'GET',
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    headers: { 'user-agent': `pk-client/${VERSION}` },
  };
  if (bridge.token) opts.headers['authorization'] = `Bearer ${bridge.token}`;
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function commandBridgeProbe(root, flags) {
  const bridge = loadBridgeConfig(root, flags);
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({ ok: true, submitted: false, target: `${bridge.url}/api/planekey/bridge/probe`, hint: 'pass --submit to probe bridge.planekey.dev' }, null, 2));
    return;
  }
  // Health probe path on the embedded server-core admin surface.
  const res = await getBridge(bridge, '/api/planekey/bridge/probe');
  if (res.status >= 400) bridgeError('bridge probe', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

async function commandBridgeAttest(root, inputPath, flags) {
  if (!inputPath) throw new Error('bridge attest requires <input.json>');
  const bridge = loadBridgeConfig(root, flags);
  const raw = JSON.parse(await fsp.readFile(path.resolve(inputPath), 'utf8'));
  if (!raw.service_id || !raw.layer || !raw.layer_index_hash) {
    throw new Error('attestation requires service_id, layer (dev|builder|live), and layer_index_hash');
  }
  if (!['dev', 'builder', 'live'].includes(raw.layer)) {
    throw new Error('layer must be dev|builder|live');
  }
  const envelope = {
    service_id: raw.service_id,
    layer: raw.layer,
    layer_index_hash: raw.layer_index_hash,
    index_payload: raw.index_payload || null,
    signing_key_pub: raw.signing_key_pub || flags['signing-key-pub'] || null,
    signature: raw.signature || flags.signature || null,
    source_kind: raw.source_kind || 'pk-client',
    source_id: raw.source_id || null,
  };
  if (!wantsSubmit(flags)) {
    const file = await saveEnvelope(root, 'bridge-attest', envelope);
    console.log(JSON.stringify({ ok: true, submitted: false, envelopeFile: file, hint: 'pass --submit to POST to bridge.planekey.dev' }, null, 2));
    return;
  }
  const res = await postBridge(bridge, '/v1/bridge/attest', envelope);
  if (res.status >= 400) bridgeError('bridge attest', res);
  const receipt = await saveReceipt(root, 'bridge-attest', { envelope, response: res.body });
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body, receipt }, null, 2));
}

async function commandBridgeAttestations(root, flags) {
  const bridge = loadBridgeConfig(root, flags);
  if (!wantsSubmit(flags)) {
    const query = { service_id: flags.service || flags['service-id'], layer: flags.layer, limit: flags.limit };
    console.log(JSON.stringify({ ok: true, submitted: false, target: `${bridge.url}/v1/bridge/attestations`, query, hint: 'pass --submit to fetch from bridge.planekey.dev' }, null, 2));
    return;
  }
  const res = await getBridge(bridge, '/v1/bridge/attestations', {
    service_id: flags.service || flags['service-id'],
    layer: flags.layer,
    limit: flags.limit,
  });
  if (res.status >= 400) bridgeError('bridge attestations', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

async function commandBridgeCompare(root, leftPath, rightPath, flags) {
  if (!leftPath || !rightPath) {
    throw new Error('bridge compare requires <left-index.json> <right-index.json>');
  }
  const bridge = loadBridgeConfig(root, flags);
  const left = JSON.parse(await fsp.readFile(path.resolve(leftPath), 'utf8'));
  const right = JSON.parse(await fsp.readFile(path.resolve(rightPath), 'utf8'));
  const envelope = {
    left_attestation_id: flags['left-attestation-id'] || null,
    right_attestation_id: flags['right-attestation-id'] || null,
    left: { layer: left.layer || 'dev', files: left.files || [] },
    right: { layer: right.layer || 'builder', files: right.files || [] },
  };
  if (!wantsSubmit(flags)) {
    const file = await saveEnvelope(root, 'bridge-compare', envelope);
    console.log(JSON.stringify({ ok: true, submitted: false, envelopeFile: file, leftFiles: envelope.left.files.length, rightFiles: envelope.right.files.length, hint: 'pass --submit to POST to bridge.planekey.dev' }, null, 2));
    return;
  }
  const res = await postBridge(bridge, '/v1/bridge/compare', envelope);
  if (res.status >= 400) bridgeError('bridge compare', res);
  const receipt = await saveReceipt(root, 'bridge-compare', { envelope, response: res.body });
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body, receipt }, null, 2));
}

async function commandBridgeIncident(root, inputPath, flags) {
  if (!inputPath) throw new Error('bridge incident requires <input.json>');
  const bridge = loadBridgeConfig(root, flags);
  const raw = JSON.parse(await fsp.readFile(path.resolve(inputPath), 'utf8'));
  if (!raw.service_id || !raw.incident_kind) {
    throw new Error('incident requires service_id and incident_kind');
  }
  const envelope = {
    service_id: raw.service_id,
    incident_kind: raw.incident_kind,
    severity: raw.severity || 'info',
    title: raw.title || null,
    summary: raw.summary || null,
    payload: raw.payload || null,
  };
  if (!wantsSubmit(flags)) {
    const file = await saveEnvelope(root, 'bridge-incident', envelope);
    console.log(JSON.stringify({ ok: true, submitted: false, envelopeFile: file, hint: 'pass --submit to POST to bridge.planekey.dev' }, null, 2));
    return;
  }
  const res = await postBridge(bridge, '/v1/bridge/incident', envelope);
  if (res.status >= 400) bridgeError('bridge incident', res);
  const receipt = await saveReceipt(root, 'bridge-incident', { envelope, response: res.body });
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body, receipt }, null, 2));
}

async function commandBridgePolicy(root, flags) {
  const bridge = loadBridgeConfig(root, flags);
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({ ok: true, submitted: false, target: `${bridge.url}/v1/bridge/policy`, hint: 'pass --submit to fetch from bridge.planekey.dev' }, null, 2));
    return;
  }
  const res = await getBridge(bridge, '/v1/bridge/policy');
  if (res.status >= 400) bridgeError('bridge policy', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

async function commandBridgeDashboard(root, incidentId, flags) {
  if (!incidentId) throw new Error('bridge dashboard requires <incident-id>');
  const bridge = loadBridgeConfig(root, flags);
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({ ok: true, submitted: false, target: `${bridge.url}/v1/bridge/dashboard/${incidentId}`, hint: 'pass --submit to fetch from bridge.planekey.dev' }, null, 2));
    return;
  }
  const res = await getBridge(bridge, `/v1/bridge/dashboard/${encodeURIComponent(incidentId)}`);
  if (res.status >= 400) bridgeError('bridge dashboard', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

// ── Cluster: zero translation (v0.1.5.10, agent-language adapter) ──────────
//
// Translate zerolang.ai compiler JSON into planekey.patch.v1 so Zero's
// repair plans, diagnostics, and symbol graphs flow through the same
// bridge self-update endpoint every other patch already uses. No new
// receiver, no new schema. The mapping doc lives at
// products:docs/INTEGRATIONS_ZERO.md.
//
// Zero is "Pre-1 experiment, no production guarantees" so field-name
// lookups are defensive (synonym sets, graceful fallback).

const ZERO_FIELD_SYNONYMS = {
  file: ['file', 'path', 'file_path'],
  message: ['message', 'text', 'explanation'],
  code: ['code', 'diagnostic_code', 'id'],
  severity: ['severity', 'level'],
  start_line: ['start_line', 'line'],
  end_line: ['end_line'],
};

function zeroFirst(obj, ...keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function zeroDiagnosticToTarget(diag) {
  const repair = zeroFirst(diag, 'repair', 'repair_plan', 'suggestion') || {};
  const filePath = zeroFirst(diag, ...ZERO_FIELD_SYNONYMS.file) || '<unknown>';
  const code = zeroFirst(diag, ...ZERO_FIELD_SYNONYMS.code);
  const message = zeroFirst(diag, ...ZERO_FIELD_SYNONYMS.message) || '';
  const severity = zeroFirst(diag, ...ZERO_FIELD_SYNONYMS.severity) || 'info';

  let startLine = zeroFirst(diag, ...ZERO_FIELD_SYNONYMS.start_line);
  let endLine = zeroFirst(diag, ...ZERO_FIELD_SYNONYMS.end_line) ?? startLine;
  let op = 'zero_diagnostic';
  let replacement = null;
  let explanation = message;

  if (Object.keys(repair).length > 0) {
    op = 'zero_repair_' + (zeroFirst(repair, 'kind', 'op') || 'replace');
    replacement = zeroFirst(repair, 'replacement', 'replace_with', 'fix') ?? null;
    explanation = zeroFirst(repair, 'explanation', 'rationale') || message;
    startLine = zeroFirst(repair, 'start_line') ?? startLine;
    endLine = zeroFirst(repair, 'end_line') ?? endLine;
  }

  const payload = { source: 'zerolang.ai', diagnostic_code: code || null, severity, message, explanation };
  if (startLine !== undefined) payload.start_line = startLine;
  if (endLine !== undefined) payload.end_line = endLine;
  if (replacement !== null) payload.replacement = replacement;

  return {
    path: filePath,
    op,
    after_hash: zeroFirst(repair, 'after_hash') ?? null,
    payload,
  };
}

function zeroSymbolToTarget(sym) {
  return {
    path: zeroFirst(sym, ...ZERO_FIELD_SYNONYMS.file) || '<unknown>',
    op: 'zero_symbol',
    after_hash: zeroFirst(sym, 'body_hash', 'content_hash') ?? null,
    payload: {
      source: 'zerolang.ai/symbol-graph',
      symbol_name: zeroFirst(sym, 'name', 'symbol') || null,
      kind: zeroFirst(sym, 'kind', 'symbol_type') || null,
      start_line: zeroFirst(sym, 'start_line') ?? null,
      end_line: zeroFirst(sym, 'end_line') ?? null,
    },
  };
}

function buildZeroPatch(zeroOutput, opts = {}) {
  const diagnostics = zeroFirst(zeroOutput, 'diagnostics', 'messages', 'issues') || [];
  const symbols = zeroFirst(zeroOutput, 'symbols', 'symbol_graph') || [];
  const zeroVersion = zeroFirst(zeroOutput, 'version', 'zero_version') || 'zero/unknown';

  const targets = diagnostics
    .filter((d) => d && typeof d === 'object')
    .map(zeroDiagnosticToTarget);
  if (opts.includeSymbols) {
    for (const s of symbols) {
      if (s && typeof s === 'object') targets.push(zeroSymbolToTarget(s));
    }
  }

  const patchId = 'zero-' + crypto
    .createHash('sha256')
    .update(JSON.stringify(targets))
    .digest('hex')
    .slice(0, 12);

  const repairCount = targets.filter((t) => t.op !== 'zero_symbol').length;
  const symbolCount = targets.filter((t) => t.op === 'zero_symbol').length;

  return {
    schema: 'planekey.patch.v1',
    patch_id: patchId,
    generated_at: new Date().toISOString(),
    source: 'pk-client zero translate',
    zero_version: zeroVersion,
    summary:
      opts.summary
      || `Translated ${targets.length} target(s) from ${zeroVersion} `
         + `(${repairCount} diagnostic(s), ${symbolCount} symbol(s))`,
    targets,
  };
}

async function commandZeroTranslate(root, inputPath, flags) {
  if (!inputPath) throw new Error('zero translate requires <zero-output.json>');
  const raw = await fsp.readFile(path.resolve(inputPath), 'utf8');
  let zeroOutput;
  try {
    zeroOutput = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid zero json: ${e.message}`);
  }

  const manifest = buildZeroPatch(zeroOutput, {
    includeSymbols: Boolean(flags['include-symbols']),
    summary: flags.summary,
  });

  // Local-only by default. --out writes the manifest to disk; --submit
  // additionally POSTs to the bridge self-update endpoint (admin-gated;
  // bearer token via --bridge-token or PLANEKEY_SESSION_TOKEN).
  const outPath = flags.out
    || path.join(root, 'reports', 'bridge-envelopes',
        `${new Date().toISOString().replace(/[:.]/g, '-')}_zero-patch.json`);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify(manifest, null, 2));

  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({
      ok: true,
      submitted: false,
      manifestFile: outPath,
      targets: manifest.targets.length,
      patch_id: manifest.patch_id,
      hint: 'pass --submit to POST to bridge.planekey.dev/admin/health/self-update',
    }, null, 2));
    return;
  }

  const bridge = loadBridgeConfig(root, flags);
  if (!bridge.token) {
    throw new Error('--submit needs an admin bootstrap token (--bridge-token or PLANEKEY_SESSION_TOKEN)');
  }
  const res = await postBridge(bridge, '/v1/admin/health/self-update', manifest);
  if (res.status >= 400) bridgeError('zero translate submit', res);
  const receipt = await saveReceipt(root, 'zero-translate', { manifest, response: res.body });
  console.log(JSON.stringify({
    ok: true,
    submitted: true,
    manifestFile: outPath,
    targets: manifest.targets.length,
    patch_id: manifest.patch_id,
    response: res.body,
    receipt,
  }, null, 2));
}

// ── Cluster: RPG queries (absorbed from pk-client-rpg.js, v0.1.5.11) ──────
// Reads any rpg.sqlite produced by `pk-memory memory rpg`. Default --db
// search order: ./reports/rpg/*/rpg.sqlite, ./databases/rpg/products-rpg/
// rpg.sqlite, /tmp/dbs-rpg/rpg/products-rpg/rpg.sqlite.
// Shells to system sqlite3 CLI (zero-dep rule).

function rpgFindDb(root, flags) {
  if (flags.db) return path.resolve(flags.db);
  const candidates = [
    path.join(root || '.', 'reports', 'rpg'),
    path.join(root || '.', 'databases', 'rpg', 'products-rpg'),
    '/tmp/dbs-rpg/rpg/products-rpg',
  ];
  for (const dir of candidates) {
    if (!exists(dir)) continue;
    try {
      const direct = path.join(dir, 'rpg.sqlite');
      if (exists(direct)) return direct;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const inner = path.join(dir, entry.name, 'rpg.sqlite');
          if (exists(inner)) return inner;
        }
      }
    } catch { /* skip */ }
  }
  throw new Error(
    'No rpg.sqlite found. Pass --db <path>, or run `pk-memory memory rpg <folder>` first,\n'
    + 'or mount the databases branch worktree: git worktree add /tmp/dbs-rpg databases'
  );
}

function rpgSqlite(db, sql) {
  // maxBuffer: default Node spawnSync cap is 1MB, which the old v1 stub
  // dependency graph (co_located-only, ~1 edge per symbol) never came close
  // to. A real call-edge graph (see pk-memory's extractCallsFromBody) can
  // emit tens of thousands of edges — `rpg reachable`'s full-table SELECT
  // over rpg_symbol_dependencies blew past 1MB and failed with ENOBUFS
  // instead of returning results. 64MB covers real repo-scale graphs.
  const res = spawnSync('sqlite3', ['-json', db, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      throw new Error('sqlite3 CLI not found in PATH. Install it (apt install sqlite3, brew install sqlite).');
    }
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`sqlite3 exited ${res.status}: ${res.stderr || res.stdout}`);
  }
  const out = (res.stdout || '').trim();
  return out ? JSON.parse(out) : [];
}

function rpgEmitTable(rows, title) {
  if (!rows.length) { process.stderr.write('(no rows)\n'); return; }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  if (title) process.stderr.write(`\n# ${title}\n\n`);
  process.stderr.write(cols.map((c, i) => c.padEnd(widths[i])).join('  ') + '\n');
  process.stderr.write(cols.map((_, i) => '-'.repeat(widths[i])).join('  ') + '\n');
  for (const r of rows) {
    process.stderr.write(cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  ') + '\n');
  }
}

function rpgEmit(rows, flags, title) {
  if (flags.table) rpgEmitTable(rows, title);
  console.log(JSON.stringify(rows, null, 2));
}

async function commandRpgCapabilities(root, flags) {
  const db = rpgFindDb(root, flags);
  const rows = rpgSqlite(db, `
    SELECT c.name AS capability,
           COUNT(DISTINCT cm.module_id) AS modules,
           COUNT(DISTINCT s.id) AS symbols
    FROM rpg_capabilities c
    LEFT JOIN rpg_capability_modules cm ON cm.capability_id = c.id
    LEFT JOIN rpg_symbols s ON s.module_id = cm.module_id
    GROUP BY c.id, c.name
    ORDER BY symbols DESC
  `);
  rpgEmit(rows, flags, 'capabilities');
}

async function commandRpgSymbols(root, flags) {
  const cap = flags.capability || flags.cap;
  if (!cap) throw new Error('rpg symbols requires --capability <name>');
  const db = rpgFindDb(root, flags);
  const limit = parseInt(flags.limit || '50', 10);
  const safe = cap.replace(/'/g, "''");
  const rows = rpgSqlite(db, `
    SELECT m.name AS module, s.symbol_name, s.symbol_type, s.language,
           s.start_line, s.end_line, SUBSTR(s.body_hash, 1, 12) AS body_hash_short
    FROM rpg_capabilities c
    JOIN rpg_capability_modules cm ON cm.capability_id = c.id
    JOIN rpg_modules m ON m.id = cm.module_id
    JOIN rpg_symbols s ON s.module_id = m.id
    WHERE c.name = '${safe}'
    ORDER BY m.name, s.start_line
    LIMIT ${limit}
  `);
  rpgEmit(rows, flags, `symbols in capability '${cap}'`);
}

async function commandRpgModule(root, modName, flags) {
  if (!modName) throw new Error('rpg module requires <name>');
  const db = rpgFindDb(root, flags);
  const safe = modName.replace(/'/g, "''");
  const symbols = rpgSqlite(db, `
    SELECT s.symbol_name, s.symbol_type, s.language, s.start_line, s.end_line,
           SUBSTR(s.body_hash, 1, 12) AS body_hash_short, s.route
    FROM rpg_symbols s
    JOIN rpg_modules m ON m.id = s.module_id
    WHERE m.name = '${safe}'
    ORDER BY s.start_line
  `);
  const deps = rpgSqlite(db, `
    SELECT caller.symbol_name AS caller, callee.symbol_name AS callee,
           d.dependency_type
    FROM rpg_symbol_dependencies d
    JOIN rpg_symbols caller ON caller.id = d.caller_id
    JOIN rpg_symbols callee ON callee.id = d.callee_id
    JOIN rpg_modules m ON m.id = caller.module_id
    WHERE m.name = '${safe}'
    LIMIT 50
  `);
  const out = { module: modName, symbols, dependencies: deps };
  if (flags.table) {
    rpgEmitTable(symbols, `symbols in ${modName}`);
    rpgEmitTable(deps, `dependencies originating in ${modName}`);
  }
  console.log(JSON.stringify(out, null, 2));
}

async function commandRpgQuery(root, text, flags) {
  if (!text) throw new Error('rpg query requires <text>');
  const db = rpgFindDb(root, flags);
  const limit = parseInt(flags.limit || '20', 10);
  const safe = text.replace(/'/g, "''");
  const pattern = `%${safe}%`;
  const rows = rpgSqlite(db, `
    SELECT m.name AS module, s.symbol_name, s.symbol_type, s.language, s.start_line,
           CASE
             WHEN s.symbol_name LIKE '${pattern}' THEN 'symbol_match'
             WHEN m.name LIKE '${pattern}' THEN 'module_match'
             WHEN s.route LIKE '${pattern}' THEN 'route_match'
             ELSE 'unknown'
           END AS match_kind
    FROM rpg_symbols s
    JOIN rpg_modules m ON m.id = s.module_id
    WHERE s.symbol_name LIKE '${pattern}' OR m.name LIKE '${pattern}' OR s.route LIKE '${pattern}'
    ORDER BY match_kind, m.name, s.start_line
    LIMIT ${limit}
  `);
  rpgEmit(rows, flags, `query: '${text}'`);
}

function rpgCapabilitySet(db) {
  const rows = rpgSqlite(db, `
    SELECT c.name AS capability, COUNT(DISTINCT cm.module_id) AS modules
    FROM rpg_capabilities c
    LEFT JOIN rpg_capability_modules cm ON cm.capability_id = c.id
    GROUP BY c.id, c.name
  `);
  return Object.fromEntries(rows.map((r) => [r.capability, r.modules]));
}

async function commandRpgDrift(root, leftPath, rightPath, flags) {
  if (!leftPath || !rightPath) throw new Error('rpg drift requires <left.sqlite> <right.sqlite>');
  if (!exists(leftPath)) throw new Error(`left db not found: ${leftPath}`);
  if (!exists(rightPath)) throw new Error(`right db not found: ${rightPath}`);
  const left = rpgCapabilitySet(leftPath);
  const right = rpgCapabilitySet(rightPath);
  const all = new Set([...Object.keys(left), ...Object.keys(right)]);
  const drift = [];
  for (const cap of [...all].sort()) {
    const l = left[cap] || 0, r = right[cap] || 0;
    if (l !== r) drift.push({ capability: cap, left_modules: l, right_modules: r, delta: r - l });
  }
  const summary = {
    left_db: leftPath,
    right_db: rightPath,
    capabilities_in_left_only: [...all].filter((c) => left[c] && !right[c]),
    capabilities_in_right_only: [...all].filter((c) => right[c] && !left[c]),
    drift_rows: drift,
    drift_count: drift.length,
    verdict: drift.length === 0 ? 'stable' : 'drifted',
  };
  if (flags.table && drift.length) rpgEmitTable(drift, 'capability drift');
  console.log(JSON.stringify(summary, null, 2));
}

// ── Cluster: matrix carry-forward (v0.1.5.12, audit-named SELECT #4) ──────
// Compares two PLANEKEY_*_PRIVATE_INDEX.json snapshots and reports which
// file content_hashes carried forward (preserved), dropped (regression
// candidates), or are new in the right snapshot.

async function commandMatrixCarryForward(root, leftVersion, rightVersion, flags) {
  if (!leftVersion || !rightVersion) {
    throw new Error('matrix carry-forward requires <left-version> <right-version> (e.g. 0.2.17 0.2.18)');
  }
  const ts = trustStateScan(root);
  if (!ts.found) throw new Error(`no provenance/ found from root ${root}`);

  function pickIndex(version, scope) {
    // Prefer canonical scope if available, else any matching version
    const filtered = ts.attestations.filter(a => a.version === version);
    if (!filtered.length) return null;
    return filtered.find(a => a.scope === (scope || 'canonical')) || filtered[0];
  }
  const leftAtt = pickIndex(leftVersion, flags.scope);
  const rightAtt = pickIndex(rightVersion, flags.scope);
  if (!leftAtt || !rightAtt) {
    console.log(JSON.stringify({
      ok: false,
      reason: `version not found in provenance/`,
      available_versions: ts.summary.versions_indexed,
      left_found: !!leftAtt,
      right_found: !!rightAtt,
    }, null, 2));
    return;
  }

  const provenance = ts.provenance_dir;
  const left = JSON.parse(fs.readFileSync(path.join(provenance, leftAtt.file), 'utf8'));
  const right = JSON.parse(fs.readFileSync(path.join(provenance, rightAtt.file), 'utf8'));

  const leftByHash = new Map((left.files || []).map(f => [f.sha256, f]));
  const rightByHash = new Map((right.files || []).map(f => [f.sha256, f]));
  const leftByPath = new Map((left.files || []).map(f => [f.path, f]));
  const rightByPath = new Map((right.files || []).map(f => [f.path, f]));

  const preserved = [];  // same hash, same path
  const renamed = [];    // same hash, different path
  const modified = [];   // same path, different hash
  const dropped = [];    // path in left only
  const added = [];      // path in right only

  for (const lf of (left.files || [])) {
    const rf = rightByPath.get(lf.path);
    if (rf) {
      if (rf.sha256 === lf.sha256) preserved.push(lf.path);
      else modified.push({ path: lf.path, left_sha256: lf.sha256.slice(0, 12), right_sha256: rf.sha256.slice(0, 12) });
    } else {
      // Path missing in right — was it renamed (hash present elsewhere)?
      const rfByHash = rightByHash.get(lf.sha256);
      if (rfByHash) renamed.push({ from: lf.path, to: rfByHash.path, sha256_short: lf.sha256.slice(0, 12) });
      else dropped.push(lf.path);
    }
  }
  for (const rf of (right.files || [])) {
    if (!leftByPath.has(rf.path) && !leftByHash.has(rf.sha256)) added.push(rf.path);
  }

  const result = {
    ok: true,
    left_version: leftAtt.version,
    right_version: rightAtt.version,
    left_artifact: leftAtt.artifact,
    right_artifact: rightAtt.artifact,
    left_files: (left.files || []).length,
    right_files: (right.files || []).length,
    summary: {
      preserved: preserved.length,
      modified: modified.length,
      renamed: renamed.length,
      dropped: dropped.length,
      added: added.length,
    },
    preserved: preserved.slice(0, 30),
    modified: modified.slice(0, 30),
    renamed,
    dropped,
    added,
  };
  if (flags.table) {
    process.stderr.write(`\n# carry-forward ${leftAtt.version} -> ${rightAtt.version}\n\n`);
    process.stderr.write(`  preserved:  ${result.summary.preserved}\n`);
    process.stderr.write(`  modified:   ${result.summary.modified}\n`);
    process.stderr.write(`  renamed:    ${result.summary.renamed}\n`);
    process.stderr.write(`  dropped:    ${result.summary.dropped}\n`);
    process.stderr.write(`  added:      ${result.summary.added}\n\n`);
    if (modified.length) {
      process.stderr.write('modified files (top 5):\n');
      for (const m of modified.slice(0, 5)) {
        process.stderr.write(`  ${m.path}  ${m.left_sha256} -> ${m.right_sha256}\n`);
      }
      process.stderr.write('\n');
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

// ── Cluster: rpg reachability (v0.1.5.12, audit-named SELECT #3) ──────────
// Walks rpg_symbol_dependencies outward from rpg_symbols.route handlers.
// Answers Cloudflare-stage-6: "does attacker-controlled input actually
// reach the bug from outside the system?" — by tracing call paths from
// route handlers to the named target symbol.

async function commandRpgReachable(root, targetSymbol, flags) {
  if (!targetSymbol) throw new Error('rpg reachable requires <symbol-name>');
  const db = rpgFindDb(root, flags);
  const maxDepth = parseInt(flags.depth || '6', 10);
  const safe = targetSymbol.replace(/'/g, "''");

  // Find target symbol IDs.
  const targets = rpgSqlite(db, `
    SELECT s.id, s.symbol_name, s.file_path, s.start_line, m.name AS module
    FROM rpg_symbols s
    JOIN rpg_modules m ON m.id = s.module_id
    WHERE s.symbol_name = '${safe}'
  `);
  if (!targets.length) {
    console.log(JSON.stringify({ ok: false, reason: `no symbol named '${targetSymbol}' in rpg`, db }, null, 2));
    return;
  }

  // BFS backward through dependencies from target to any route handler.
  // Pre-fetch all edges + the route-bearing symbols (the externally
  // reachable set). Schema-drift defense: support both v1 column shape
  // (caller_id/callee_id) and v0.2.21 bridge schema (caller_function_id/
  // callee_function_id) by introspecting columns.
  const cols = rpgSqlite(db, `PRAGMA table_info(rpg_symbol_dependencies)`);
  const callerCol = cols.find(c => c.name === 'caller_id') ? 'caller_id' : 'caller_function_id';
  const calleeCol = cols.find(c => c.name === 'callee_id') ? 'callee_id' : 'callee_function_id';

  const edges = rpgSqlite(db, `SELECT ${callerCol} AS caller, ${calleeCol} AS callee FROM rpg_symbol_dependencies`);
  const callees = new Map();   // callee -> [caller, ...]
  for (const e of edges) {
    if (!callees.has(e.callee)) callees.set(e.callee, []);
    callees.get(e.callee).push(e.caller);
  }
  const routeHandlers = rpgSqlite(db, `
    SELECT s.id, s.symbol_name, s.route, s.file_path, s.start_line, m.name AS module
    FROM rpg_symbols s JOIN rpg_modules m ON m.id = s.module_id
    WHERE s.route IS NOT NULL
  `);
  const routeIds = new Set(routeHandlers.map(r => r.id));
  const routeById = new Map(routeHandlers.map(r => [r.id, r]));

  const symMeta = new Map();
  const allSymbols = rpgSqlite(db, `
    SELECT s.id, s.symbol_name, s.start_line, s.file_path, m.name AS module
    FROM rpg_symbols s JOIN rpg_modules m ON m.id = s.module_id
  `);
  for (const s of allSymbols) symMeta.set(s.id, s);

  // BFS backward from each target.
  const paths = [];
  for (const tgt of targets) {
    // A target that IS itself a route handler is trivially reachable — the
    // actix router calls it directly, so it has zero *incoming* call edges
    // by design and would otherwise fall out of the BFS below as a false
    // "unreachable" (the `id !== tgt.id` guard in the loop exists so a
    // handler doesn't get "discovered via itself" mid-graph, but it was
    // also silently swallowing this depth-0 case for every route handler
    // queried directly, e.g. `rpg reachable close_account`).
    if (routeIds.has(tgt.id)) {
      const rh = routeById.get(tgt.id);
      paths.push({
        reachable: true,
        target_symbol: tgt.symbol_name,
        target_at: `${tgt.module}:${tgt.start_line}`,
        via_route: rh.route,
        via_handler: `${rh.module}:${rh.symbol_name}@${rh.start_line}`,
        path_length: 1,
        path: [`${rh.module}:${rh.symbol_name}@${rh.start_line}`],
      });
    }
    const visited = new Map();  // id -> depth
    const queue = [[tgt.id, 0, [tgt.id]]];
    while (queue.length) {
      const [id, depth, path] = queue.shift();
      if (visited.has(id) && visited.get(id) <= depth) continue;
      visited.set(id, depth);
      if (routeIds.has(id) && id !== tgt.id) {
        const rh = routeById.get(id);
        paths.push({
          reachable: true,
          target_symbol: tgt.symbol_name,
          target_at: `${tgt.module}:${tgt.start_line}`,
          via_route: rh.route,
          via_handler: `${rh.module}:${rh.symbol_name}@${rh.start_line}`,
          path_length: path.length,
          path: path.reverse().map(pid => {
            const s = symMeta.get(pid);
            return s ? `${s.module}:${s.symbol_name}@${s.start_line}` : `id:${pid}`;
          }),
        });
        continue;
      }
      if (depth >= maxDepth) continue;
      const callers = callees.get(id) || [];
      for (const c of callers) queue.push([c, depth + 1, [...path, c]]);
    }
  }

  paths.sort((a, b) => a.path_length - b.path_length);
  // Quality signal: a v1 dependency-graph stub emits only co_located edges
  // (intra-module). True reachability needs cross-module call extraction,
  // tracked in pk-memory's build_dependency_graph.py refinement ticket.
  const kindRows = rpgSqlite(db, `SELECT DISTINCT dependency_type FROM rpg_symbol_dependencies`);
  const kinds = kindRows.map(r => r.dependency_type);
  const isV1Stub = kinds.length === 1 && kinds[0] === 'co_located';
  const result = {
    ok: true,
    target_symbol: targetSymbol,
    target_matches: targets.length,
    reachable_routes: paths.length,
    max_depth_searched: maxDepth,
    dependency_kinds_present: kinds,
    dependency_graph_quality: isV1Stub
      ? 'v1-stub (co_located only — no real cross-module call extraction yet; reachability across modules will be 0 until pk-memory build_dependency_graph extracts true call edges)'
      : 'real (cross-module edges present)',
    verdict: paths.length > 0
      ? 'reachable'
      : (isV1Stub ? 'unreachable — and the dependency graph is v1-stub quality, so this 0 is expected. Refine pk-memory build_dependency_graph for real reachability.'
                  : 'unreachable from any indexed route handler'),
    paths: paths.slice(0, 20),
  };
  if (flags.table && paths.length) {
    process.stderr.write(`\n# reachability paths to '${targetSymbol}'\n\n`);
    process.stderr.write('hops  via_route                                 via_handler\n');
    process.stderr.write('----  ----------------------------------------  ------------------------------------------\n');
    for (const p of paths.slice(0, 10)) {
      process.stderr.write(`${String(p.path_length).padStart(4)}  ${(p.via_route || '?').padEnd(40)}  ${(p.via_handler || '?').slice(0, 50)}\n`);
    }
    process.stderr.write('\n');
  }
  console.log(JSON.stringify(result, null, 2));
}

// ── Cluster: trust state (v0.1.5.12, the first of 5 audit-named SELECTs) ──
// Reads products/bridge/provenance/*PRIVATE_INDEX.json — the per-version
// dev/builder/live attestation snapshots that already ship in the repo.
// Replaces the 'trust_state: null' placeholder in the coherence pack with
// real attestation rows.

function trustStateScan(root) {
  const dirs = [
    path.join(root || '.', 'products', 'bridge', 'provenance'),
    path.join(root || '.', 'bridge', 'provenance'),
    path.join(root || '.', 'provenance'),
  ];
  let provenanceDir = null;
  for (const d of dirs) { if (exists(d)) { provenanceDir = d; break; } }
  if (!provenanceDir) return { found: false, dir_searched: dirs, attestations: [] };

  const files = fs.readdirSync(provenanceDir)
    .filter(f => f.endsWith('PRIVATE_INDEX.json'))
    .sort();
  const attestations = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(provenanceDir, f), 'utf8'));
      attestations.push({
        file: f,
        version: j.version || null,
        artifact: j.artifact || null,
        generated_at: j.generated_at || null,
        files_count: (j.files || []).length,
        patch_name: j.patch_name || null,
        endpoints_added: (j.endpoints_added || []).length,
        tables_added: (j.tables_added || []).length,
        modules_added: (j.modules_added || []).length,
        cargo_check_online: j.cargo_check_online ?? null,
        cargo_check_offline: j.cargo_check_offline ?? null,
        scope: f.toLowerCase().includes('canonical') ? 'canonical'
             : f.toLowerCase().includes('home_bridge') ? 'home-bridge'
             : f.toLowerCase().includes('repo_db') ? 'repo-db'
             : 'unknown',
      });
    } catch (e) {
      attestations.push({ file: f, error: e.message });
    }
  }
  attestations.sort((a, b) => String(a.generated_at).localeCompare(String(b.generated_at)));

  const latest = attestations[attestations.length - 1];
  const canonical = attestations.filter(a => a.scope === 'canonical');
  const lastCanonical = canonical[canonical.length - 1];

  return {
    found: true,
    provenance_dir: provenanceDir,
    attestations,
    summary: {
      total: attestations.length,
      latest_version: latest ? latest.version : null,
      latest_generated_at: latest ? latest.generated_at : null,
      latest_canonical_version: lastCanonical ? lastCanonical.version : null,
      latest_canonical_files: lastCanonical ? lastCanonical.files_count : null,
      cargo_check_online: lastCanonical ? lastCanonical.cargo_check_online : null,
      cargo_check_offline: lastCanonical ? lastCanonical.cargo_check_offline : null,
      versions_indexed: attestations.map(a => a.version).filter(Boolean),
    },
  };
}

async function commandTrustState(root, flags) {
  const state = trustStateScan(root);
  if (!state.found) {
    console.log(JSON.stringify({
      ok: false,
      reason: 'no provenance/*PRIVATE_INDEX.json found',
      dirs_searched: state.dir_searched,
    }, null, 2));
    return;
  }
  if (flags.table) {
    process.stderr.write('\n# trust state — committed attestations\n\n');
    process.stderr.write('version   files  scope        artifact\n');
    process.stderr.write('--------  -----  -----------  ------------------------------------------\n');
    for (const a of state.attestations) {
      process.stderr.write(
        `${(a.version || '?').padEnd(8)}  ${String(a.files_count).padStart(5)}  ${(a.scope || '?').padEnd(11)}  ${(a.artifact || '?').slice(0, 50)}\n`
      );
    }
    process.stderr.write('\n');
  }
  console.log(JSON.stringify({
    ok: true,
    summary: state.summary,
    attestations: state.attestations,
  }, null, 2));
}

// ── Cluster: coherence pack (absorbed from pk-client-coherence.js, v0.1.5.11) ──
// Emits planekey.coherence-pack.v1 — the 60-second AI grounding artifact.

// ── Cluster: database schema artifact (the 4th pkclient citizen) ────────────
//
// `pk-client schema [scan]` reconciles a database's three layers — migrations
// (declared), bridge/src SQL (required), and the setup bundle (deployed) — and
// writes a receipt, exactly as compare/flight do for repos/programs. Static,
// no live DB needed. See lib/schema.js.
async function commandSchemaScan(root, flags) {
  const { analyzeSchema } = require('../lib/schema.js');
  const report = analyzeSchema(root);

  // Receipt (JSON + MD) under reports/schema/, alongside compare/flight kin.
  const dir = path.join(root, 'reports', 'schema');
  await fsp.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonFile = path.join(dir, `${ts}_schema-drift.json`);
  await fsp.writeFile(jsonFile, JSON.stringify(report, null, 2));

  const L = [];
  L.push(`# Schema drift — migrations vs code vs bundle`);
  L.push(`Generated: ${report.generatedAt}\n`);
  L.push(`| DB | migrations | tables | views | in bundle | bundle gaps |`);
  L.push(`|----|-----------|--------|-------|-----------|-------------|`);
  for (const d of report.databases) {
    L.push(`| ${d.label} | ${d.migrations} | ${d.tables} | ${d.views} | ${d.bundlePresent}/${d.migrations} | ${d.bundleMissing.join(', ') || '—'} |`);
  }
  L.push(`\n## Code↔schema BREAKS (high confidence): ${report.breaks.length}`);
  for (const b of report.breaks) L.push(`- **${b.kind}** — ${b.detail}${b.files ? `  (${b.files.join(', ')})` : ''}`);
  if (!report.breaks.length) L.push(`- none — every code write target + INSERT column resolves against a migration.`);
  L.push(`\n## Advisories (low confidence): ${report.advisories.length}`);
  for (const a of report.advisories) L.push(`- ${a.kind} — ${a.detail}`);
  const mdFile = path.join(dir, `${ts}_schema-drift.md`);
  await fsp.writeFile(mdFile, L.join('\n') + '\n');

  // Console summary.
  console.log(`Schema drift scan — ${report.databases.length} databases`);
  for (const d of report.databases) {
    const gap = d.bundleMissing.length ? `  ⚠ bundle missing: ${d.bundleMissing.join(', ')}` : '  ✓ bundle current';
    console.log(`  ${d.label}: ${d.migrations} migrations, ${d.tables} tables${gap}`);
  }
  console.log(`Code↔schema breaks: ${report.summary.breaks}  |  advisories: ${report.summary.advisories}  |  bundle gaps: ${report.summary.bundleGaps}`);
  for (const b of report.breaks) console.log(`  BREAK: ${b.detail}`);
  console.log(`Receipt: ${path.relative(root, mdFile)}`);
  return { jsonFile, mdFile, report };
}

async function commandCoherence(root, flags) {
  const dbs = flags.dbs || '/tmp/dbs-rpg';
  if (!exists(dbs)) {
    throw new Error(
      `databases worktree not found at ${dbs}\n`
      + `mount it: git worktree add ${dbs} databases`
    );
  }
  const tlCanon = path.join(dbs, 'timeline/products-canon/pk-timeline.sqlite');
  const rpg = path.join(dbs, 'rpg/products-rpg/rpg.sqlite');
  const matrix = path.join(dbs, 'matrix/canon-audit/matrix.sqlite');

  function safeQuery(db, sql, fallback) {
    if (!exists(db)) return fallback;
    try { return rpgSqlite(db, sql); } catch { return fallback; }
  }

  const caps = safeQuery(rpg, `
    SELECT c.name AS capability,
           COUNT(DISTINCT cm.module_id) AS modules,
           COUNT(DISTINCT s.id) AS symbols
    FROM rpg_capabilities c
    LEFT JOIN rpg_capability_modules cm ON cm.capability_id = c.id
    LEFT JOIN rpg_symbols s ON s.module_id = cm.module_id
    GROUP BY c.id, c.name
    ORDER BY symbols DESC
  `, []);

  const routes = safeQuery(rpg, `
    SELECT s.route, s.file_path, s.symbol_name, s.start_line, s.language
    FROM rpg_symbols s WHERE s.route IS NOT NULL
    ORDER BY s.route LIMIT 200
  `, []);

  const tmrfsCounts = safeQuery(tlCanon, `
    SELECT COUNT(*) AS files,
           SUM(CASE WHEN content_hash IS NOT NULL AND length(content_hash) > 0 THEN 1 ELSE 0 END) AS hashed,
           COUNT(DISTINCT language) AS languages
    FROM tmrfs_nodes
  `, [{}]);
  const rganoCounts = safeQuery(tlCanon, `SELECT COUNT(*) AS signatures FROM rgano_signatures`, [{}]);
  const rpgCounts = safeQuery(rpg, `
    SELECT COUNT(*) AS symbols,
           SUM(CASE WHEN body_hash IS NOT NULL AND length(body_hash) > 0 THEN 1 ELSE 0 END) AS with_body_hash
    FROM rpg_symbols
  `, [{}]);
  const matrixCounts = safeQuery(matrix, `
    SELECT (SELECT COUNT(*) FROM matrix_layers) AS layers,
           (SELECT COUNT(*) FROM matrix_shared_assets) AS shared_assets,
           (SELECT COUNT(*) FROM matrix_overlaps) AS overlap_rows
  `, [{}]);
  const drift = safeQuery(matrix, `
    SELECT MAX(c) AS max_paths_per_hash,
           SUM(CASE WHEN c > 1 THEN 1 ELSE 0 END) AS aliased_hashes
    FROM (SELECT COUNT(DISTINCT file_path) AS c FROM matrix_shared_assets GROUP BY content_hash)
  `, [{}]);
  const routesByLang = safeQuery(tlCanon, `
    SELECT source_language, COUNT(*) AS routes
    FROM route_definitions GROUP BY source_language ORDER BY routes DESC
  `, []);

  const tmrfs = tmrfsCounts[0] || {};
  const rpgR = rpgCounts[0] || {};
  const mtx = matrixCounts[0] || {};
  const drR = drift[0] || {};
  const bodyHashPct = rpgR.symbols ? Math.round((rpgR.with_body_hash / rpgR.symbols) * 1000) / 10 : 0;
  const contentHashPct = tmrfs.files ? Math.round((tmrfs.hashed / tmrfs.files) * 1000) / 10 : 0;

  const pack = {
    schema: 'planekey.coherence-pack.v1',
    generated_at: new Date().toISOString(),
    service_id: flags['service-id'] || 'planekey-multi-product',
    source: 'pk-client coherence',
    capability_map: caps,
    routes: {
      total_indexed: routes.length,
      by_language: routesByLang,
      sample: routes.slice(0, 25),
    },
    audit_substrate: {
      tmrfs_files: tmrfs.files || 0,
      tmrfs_content_hash_pct: contentHashPct,
      tmrfs_languages: tmrfs.languages || 0,
      rgano_signatures: (rganoCounts[0] || {}).signatures || 0,
      rpg_symbols: rpgR.symbols || 0,
      rpg_body_hash_pct: bodyHashPct,
      matrix_layers: mtx.layers || 0,
      matrix_shared_assets: mtx.shared_assets || 0,
      matrix_overlap_rows: mtx.overlap_rows || 0,
    },
    drift_signal: {
      max_paths_per_content_hash: drR.max_paths_per_hash || 0,
      content_hashes_with_aliases: drR.aliased_hashes || 0,
      interpretation: (drR.max_paths_per_hash || 0) > 1
        ? 'path-keying loses identity: the same content_hash appears at multiple paths'
        : 'path-keying is currently lossless on this dataset',
    },
    trust_state: (function () {
      // v0.1.5.12 — populated from provenance/*PRIVATE_INDEX.json (Past-Audit
      // query #1: trust-state hydration).
      const ts = trustStateScan(root);
      if (!ts.found) {
        return {
          found: false,
          hint: 'no provenance/*PRIVATE_INDEX.json — run pk-client trust state from a repo root that contains products/bridge/provenance/',
        };
      }
      return {
        found: true,
        attestation_count: ts.summary.total,
        latest_version: ts.summary.latest_version,
        latest_generated_at: ts.summary.latest_generated_at,
        latest_canonical_version: ts.summary.latest_canonical_version,
        latest_canonical_files: ts.summary.latest_canonical_files,
        cargo_check_online: ts.summary.cargo_check_online,
        cargo_check_offline: ts.summary.cargo_check_offline,
        versions_indexed: ts.summary.versions_indexed,
      };
    })(),
    agent_orientation: {
      branching_model: 'messy_uploads (workspace) -> products (canonical) -> deployable per-product',
      docs_to_read: [
        'AGENTS.md', 'docs/SOURCE_SYSTEM_STACK.md',
        'docs/SOURCE_SYSTEM_CONSOLIDATION.md', 'docs/TRIO_WIRING_AUDIT.md',
      ],
      ai_coherence_loop: 'pk-client layer attest dev . -> change -> pk-client layer attest builder . -> pk-client layer compare',
    },
  };

  const text = JSON.stringify(pack, null, 2) + '\n';
  if (flags.out) {
    fs.writeFileSync(flags.out, text);
    process.stderr.write(`wrote coherence pack to ${flags.out}\n`);
  } else {
    process.stdout.write(text);
  }
}

// ── Cluster: bridge aggregates (v0.1.5.13, audit-named SELECTs #2 + #5) ────
//
// Two consumers of the new /bridge/decisions/distribution and
// /bridge/operator/actions endpoints. These are read-mostly aggregate
// queries — local-only mode returns the target URL so AI agents can
// plan; --submit actually pulls from bridge.planekey.dev.

async function commandDecisionsDistribution(root, flags) {
  const bridge = loadBridgeConfig(root, flags);
  const params = {};
  if (flags.service || flags['service-id']) params.service_id = flags.service || flags['service-id'];
  if (flags.sinceDays || flags['since-days']) params.since_days = String(flags.sinceDays || flags['since-days']);
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const target = `${bridge.url}/v1/bridge/decisions/distribution${qs ? '?' + qs : ''}`;
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({
      ok: true,
      submitted: false,
      target,
      hint: 'aggregates canon_analyses.decision + forensic_attributions.decision + route_health_metrics.decision; pass --submit to fetch from bridge.planekey.dev',
      filter: params,
    }, null, 2));
    return;
  }
  const res = await getBridge(bridge, '/v1/bridge/decisions/distribution', params);
  if (res.status >= 400) bridgeError('decisions distribution', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

async function commandOperatorReplay(root, flags) {
  const bridge = loadBridgeConfig(root, flags);
  const params = {};
  if (flags.service || flags['service-id']) params.service_id = flags.service || flags['service-id'];
  if (flags.kind || flags['action-kind']) params.action_kind = flags.kind || flags['action-kind'];
  if (flags.sinceDays || flags['since-days']) params.since_days = String(flags.sinceDays || flags['since-days']);
  if (flags.limit) params.limit = String(flags.limit);
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const target = `${bridge.url}/v1/bridge/operator/actions${qs ? '?' + qs : ''}`;
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({
      ok: true,
      submitted: false,
      target,
      hint: 'replays operator_actions (patch_apply | soft_delete | wipe_apply | ...); pass --submit to fetch from bridge.planekey.dev',
      filter: params,
    }, null, 2));
    return;
  }
  const res = await getBridge(bridge, '/v1/bridge/operator/actions', params);
  if (res.status >= 400) bridgeError('operator replay', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

// ── Cluster: RootRabbit messenger (v0.1.5.14, E2EE subdept of RR) ────────
//
// Per founder direction: "everything should already have rootrabbit
// integration so instead of a standalone message program make it a sub
// departmental tool in rr." These subcommands live under the existing
// `rootrabbit` verb and consume bridge migration 018 + rootrabbit_messaging.rs.
//
// Crypto stack (all from Node stdlib `crypto`, zero npm deps):
//   - Ed25519 identity keypair (long-lived, hex)        → signing_key_pub
//   - X25519  key-agreement keypair (long-lived, hex)   → key_agreement_pub
//   - Per-message ephemeral X25519 keypair              → forward secrecy
//   - HKDF-SHA256(shared_secret) → ChaCha20-Poly1305 key
//   - Ed25519 sig over (kind || sender_kx_pub || recipient_kx_pub || nonce_b64 || ciphertext_b64 || aad)
//
// The bridge stores ciphertext + envelope metadata + signature only.
// It cannot decrypt. See docs/ROOTRABBIT_MESSENGER.md.

const BURROW_KEYSTORE_DIR = () => path.join(process.env.HOME || '.', '.planekey', 'burrow-keys');

function burrowEnsureKeystore() {
  fs.mkdirSync(BURROW_KEYSTORE_DIR(), { recursive: true, mode: 0o700 });
}

function burrowKeyPath(accountId, kind) {
  return path.join(BURROW_KEYSTORE_DIR(), `${accountId}.${kind}.pem`);
}

function burrowPubHex(pubKeyObject) {
  // Export raw 32-byte public key from KeyObject (jwk or der → raw)
  const jwk = pubKeyObject.export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url').toString('hex');
}

function burrowLoadPrivate(accountId, kind) {
  const p = burrowKeyPath(accountId, kind);
  if (!fs.existsSync(p)) throw new Error(`no ${kind} private key on file for ${accountId}; run: pk-client burrow keygen --account ${accountId}`);
  return crypto.createPrivateKey({ key: fs.readFileSync(p, 'utf8'), format: 'pem' });
}

function burrowPrivateToPub(privKeyObject) {
  return crypto.createPublicKey(privKeyObject);
}

async function commandBurrowKeygen(root, flags) {
  const accountId = flags.account || flags['account-id'];
  if (!accountId) throw new Error('burrow keygen requires --account <uuid>');
  const force = !!flags.force;
  burrowEnsureKeystore();
  const out = { account_id: accountId, generated: {} };
  for (const kind of ['ed25519', 'x25519']) {
    const p = burrowKeyPath(accountId, kind);
    if (fs.existsSync(p) && !force) {
      out.generated[kind] = { existed: true, path: p };
      continue;
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync(kind);
    fs.writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    out.generated[kind] = { existed: false, path: p, public_hex: burrowPubHex(publicKey) };
  }
  // Also dump the public keys for convenience
  const edPriv = burrowLoadPrivate(accountId, 'ed25519');
  const xPriv  = burrowLoadPrivate(accountId, 'x25519');
  out.signing_key_pub = burrowPubHex(burrowPrivateToPub(edPriv));
  out.key_agreement_pub = burrowPubHex(burrowPrivateToPub(xPriv));
  out.hint = `next: pk-client rootrabbit keys announce --account ${accountId} --submit`;
  console.log(JSON.stringify(out, null, 2));
}

async function commandBurrowKeys(root, flags) {
  const accountId = flags.account || flags['account-id'];
  if (!accountId) throw new Error('rootrabbit keys announce requires --account <uuid>');
  const bridge = loadBridgeConfig(root, flags);
  const edPriv = burrowLoadPrivate(accountId, 'ed25519');
  const xPriv  = burrowLoadPrivate(accountId, 'x25519');
  const signingPub  = burrowPubHex(burrowPrivateToPub(edPriv));
  const kxPub       = burrowPubHex(burrowPrivateToPub(xPriv));
  const canonical   = `${accountId}|${signingPub}|${kxPub}`;
  const proofSig    = crypto.sign(null, Buffer.from(canonical, 'utf8'), edPriv).toString('hex');
  // v0.3.0: pubkey announce merged into the WBT gateway (POST /v1/wbt
  // {kind:'pubkey'}); the bridge's PubkeyAnnounceRequest wants
  // key_agreement_pub_x25519. signing_key_pub/proof_signature are carried for
  // the client preview + future proof-of-key; the bridge ignores unknown fields.
  const payload = {
    kind: 'pubkey',
    account_id: accountId,
    key_agreement_pub_x25519: kxPub,
    signing_key_pub: signingPub,
    proof_signature: proofSig,
  };
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({
      ok: true, submitted: false,
      target: `${bridge.url}/v1/wbt`,
      hint: 'pass --submit to publish your public keys to bridge.planekey.dev. The private keys NEVER leave this machine.',
      payload,
    }, null, 2));
    return;
  }
  const res = await postBridge(bridge, '/v1/wbt', payload);
  if (res.status >= 400) bridgeError('rootrabbit keys announce', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

function burrowCanonicalBytes(kind, senderKxPub, recipientKxPub, nonceB64, ciphertextB64, aad) {
  const parts = [kind, senderKxPub, recipientKxPub, nonceB64, ciphertextB64, aad || ''];
  // Same separator scheme as products/bridge/src/rootrabbit_messaging.rs::canonical_envelope_bytes
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(Buffer.from(parts[i], 'utf8'));
    if (i < parts.length - 1) out.push(Buffer.from([0]));
  }
  return Buffer.concat(out);
}

function burrowHkdf(sharedSecret, info = 'planekey/rootrabbit/messenger/v1') {
  // HKDF-Extract+Expand → 32-byte symmetric key for ChaCha20-Poly1305
  return crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from(info), 32);
}

function burrowEncrypt({ plaintext, senderEdPriv, recipientKxPubHex, envelopeKind, aad }) {
  // Generate ephemeral X25519 keypair for forward secrecy
  const { privateKey: ephSk, publicKey: ephPk } = crypto.generateKeyPairSync('x25519');
  const senderKxPubHex = burrowPubHex(ephPk);
  // X25519 ECDH
  const recipientKxPubObj = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'), // X25519 SPKI prefix
      Buffer.from(recipientKxPubHex, 'hex'),
    ]),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = Buffer.from(crypto.diffieHellman({ privateKey: ephSk, publicKey: recipientKxPubObj }));
  const symKey = Buffer.from(burrowHkdf(sharedSecret));
  // ChaCha20-Poly1305 with 12-byte nonce
  const nonce = crypto.randomBytes(12);
  const aadBuf = Buffer.from(aad || '', 'utf8');
  const cipher = crypto.createCipheriv('chacha20-poly1305', symKey, nonce, { authTagLength: 16 });
  if (aadBuf.length > 0) cipher.setAAD(aadBuf, { plaintextLength: Buffer.byteLength(plaintext) });
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([enc, tag]);
  const nonceB64 = nonce.toString('base64');
  const ciphertextB64 = ciphertext.toString('base64');
  const canonical = burrowCanonicalBytes(envelopeKind, senderKxPubHex, recipientKxPubHex, nonceB64, ciphertextB64, aad || '');
  const signature = crypto.sign(null, canonical, senderEdPriv).toString('hex');
  return {
    sender_kx_pub: senderKxPubHex,
    recipient_kx_pub: recipientKxPubHex,
    nonce_b64: nonceB64,
    ciphertext_b64: ciphertextB64,
    envelope_kind: envelopeKind,
    aad: aad || '',
    signature,
  };
}

function burrowDecrypt({ envelope, recipientXPriv }) {
  const senderKxPubObj = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'),
      Buffer.from(envelope.sender_kx_pub, 'hex'),
    ]),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = Buffer.from(crypto.diffieHellman({ privateKey: recipientXPriv, publicKey: senderKxPubObj }));
  const symKey = Buffer.from(burrowHkdf(sharedSecret));
  const nonce = Buffer.from(envelope.nonce_b64, 'base64');
  const ciphertextWithTag = Buffer.from(envelope.ciphertext_b64, 'base64');
  const tag = ciphertextWithTag.slice(ciphertextWithTag.length - 16);
  const ciphertext = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);
  const decipher = crypto.createDecipheriv('chacha20-poly1305', symKey, nonce, { authTagLength: 16 });
  if (envelope.aad) decipher.setAAD(Buffer.from(envelope.aad, 'utf8'), { plaintextLength: ciphertext.length });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// MMX-frame the whole Burrow envelope into ONE self-describing blob (base64).
// It rides the bridge's opaque body_ciphertext_b64 column — so the nonce +
// kx pubkeys the recipient needs to decrypt travel WITH the ciphertext (the
// loose-field wire dropped them, breaking decryption). Byte-compatible with
// uknocked-mmx, so a Rust server-core unframes the same bytes.
function burrowFrameEnvelope(envelope) {
  const json = Buffer.from(JSON.stringify(envelope), 'utf8');
  return Buffer.from(mmxPackBytes(json)).toString('base64');
}
function burrowUnframeEnvelope(framedB64) {
  const json = mmxUnpackBytes(Buffer.from(framedB64, 'base64'));
  return JSON.parse(Buffer.from(json).toString('utf8'));
}

// Tier routing:
//   send  → /burrow (autoroutes server-side to hop)
//   hop   → /burrow/hop  (free)
//   run   → /burrow/run  (free; sender anonymized + delivery jitter)
//   vault → /burrow/vault (paid OR system-kind; cosigs + allowlist)
async function burrowSendTier(root, recipient, text, flags, tier) {
  if (!recipient || !text) throw new Error(`burrow ${tier} requires <recipient-account-id> <text>`);
  const senderId = flags.account || flags['account-id'];
  if (!senderId) throw new Error('--account <sender-uuid> required');
  const bridge = loadBridgeConfig(root, flags);
  const senderEdPriv = burrowLoadPrivate(senderId, 'ed25519');

  let recipientKxPubHex = flags['recipient-kx-pub'];
  if (!recipientKxPubHex) {
    if (!wantsSubmit(flags)) {
      console.log(JSON.stringify({
        ok: true, submitted: false, tier,
        hint: 'local-only: pass --recipient-kx-pub <hex> OR --submit to fetch from bridge',
      }, null, 2));
      return;
    }
    const lookup = await getBridge(bridge, `/v1/wbt/pubkey/${encodeURIComponent(recipient)}`);
    if (lookup.status >= 400) bridgeError('burrow keys get', lookup);
    recipientKxPubHex = lookup.body.key_agreement_pub;
  }

  const envelope = burrowEncrypt({
    plaintext: text,
    senderEdPriv,
    recipientKxPubHex,
    envelopeKind: flags.kind || 'text/utf8',
    aad: flags.aad || '',
  });

  // MMX-frame the envelope → rides the bridge's opaque ciphertext column,
  // carrying the nonce + kx pubkeys. Match the bridge's BurrowSendRequest:
  // tier in the BODY (per-tier paths were consolidated into one endpoint),
  // signature alongside, envelope_kind/aad mirrored for the bridge's metadata
  // dispatch (stored without reading the ciphertext).
  const payload = {
    kind: 'burrow', // v0.3.0 WBT gateway: POST /v1/wbt dispatches on `kind`
    recipient_account_id: recipient,
    burrow_tier: tier === 'send' ? 'hop' : tier,
    ciphertext_b64: burrowFrameEnvelope(envelope),
    signature_b64: envelope.signature,
    sender_account_id: senderId,
    envelope_kind: envelope.envelope_kind,
    aad: envelope.aad,
  };

  // Tier-specific extras (bridge ignores fields it doesn't model yet).
  if (tier === 'vault') {
    const cosignWith = [].concat(flags['cosign-with'] || []);  // may be repeated
    const cosignSigs = [].concat(flags['cosign-sig']  || []);
    if (cosignWith.length === 0 || cosignSigs.length !== cosignWith.length) {
      throw new Error('burrow vault requires ≥1 cosigner: --cosign-with <signer-uuid> --cosign-sig <hex> (repeatable, equal counts)');
    }
    payload.cosigner_signatures = cosignWith.map((uuid, i) => ({
      signer_account_id: uuid,
      signature_hex: cosignSigs[i],
    }));
    if (flags['witness-sig']) payload.witness_signature = flags['witness-sig'];
  }
  if (tier === 'run') {
    payload.routed_via = []; // future: pre-routed mirror hop list
  }

  const targetPath = '/v1/wbt';
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({
      ok: true, submitted: false, tier,
      target: `${bridge.url}${targetPath}`,
      proof_bridge_can_decrypt: false,
      proof_ciphertext_is_opaque: envelope.ciphertext_b64.slice(0, 40) + '...',
      payload_size_bytes: Buffer.byteLength(text, 'utf8'),
      hint: 'pass --submit to deliver via bridge.planekey.dev',
    }, null, 2));
    return;
  }
  const res = await postBridge(bridge, targetPath, payload);
  if (res.status >= 400) bridgeError(`burrow ${tier}`, res);
  console.log(JSON.stringify({ ok: true, submitted: true, tier, response: res.body }, null, 2));
}

async function commandBurrowSend (root, recipient, text, flags) { return burrowSendTier(root, recipient, text, flags, 'send'); }
async function commandBurrowHop  (root, recipient, text, flags) { return burrowSendTier(root, recipient, text, flags, 'hop'); }
async function commandBurrowRun  (root, recipient, text, flags) { return burrowSendTier(root, recipient, text, flags, 'run'); }
async function commandBurrowVault(root, recipient, text, flags) { return burrowSendTier(root, recipient, text, flags, 'vault');
}

async function commandBurrowInbox(root, flags) {
  const accountId = flags.account || flags['account-id'];
  if (!accountId) throw new Error('rootrabbit message inbox requires --account <uuid>');
  const bridge = loadBridgeConfig(root, flags);
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({
      ok: true, submitted: false,
      target: `${bridge.url}/v1/wbt/inbox?lane=burrow&recipient_account_id=${accountId}`,
      hint: 'pass --submit to pull ciphertexts (decryption happens locally with your X25519 private key)',
    }, null, 2));
    return;
  }
  const xPriv = burrowLoadPrivate(accountId, 'x25519');
  const res = await getBridge(bridge, '/v1/wbt/inbox', { lane: 'burrow', recipient_account_id: accountId, limit: String(flags.limit || 50) });
  if (res.status >= 400) bridgeError('rootrabbit messages inbox', res);
  // warren_inbox returns METADATA only; fetch each envelope by id, unframe the
  // MMX blob back to the envelope, then decrypt locally with the X25519 key.
  const items = (res.body && res.body.items) || [];
  const decrypted = [];
  for (const item of items) {
    const oid = item.observation_id;
    try {
      const fr = await getBridge(bridge, `/v1/wbt/message/${oid}`, { recipient_account_id: accountId });
      if (fr.status >= 400) { decrypted.push({ id: oid, fetch_error: `status ${fr.status}` }); continue; }
      const envelope = burrowUnframeEnvelope(fr.body.ciphertext_b64);
      const plaintext = burrowDecrypt({ envelope, recipientXPriv: xPriv });
      decrypted.push({
        id: oid, sender_account_id: item.sender_account_id,
        created_at: item.created_at, envelope_kind: envelope.envelope_kind,
        plaintext,
      });
    } catch (e) {
      decrypted.push({ id: oid, sender_account_id: item.sender_account_id, decrypt_error: e.message });
    }
  }
  console.log(JSON.stringify({ ok: true, submitted: true, count: decrypted.length, messages: decrypted }, null, 2));
}

// Local-only smoke proof that the bridge cannot decrypt — no network needed.
async function commandBurrowProof(root, flags) {
  burrowEnsureKeystore();
  const senderId    = `00000000-0000-0000-0000-000000000aaa`;
  const recipientId = `00000000-0000-0000-0000-000000000bbb`;
  // Generate ephemeral keys (don't pollute the real keystore)
  const senderEd = crypto.generateKeyPairSync('ed25519');
  const recipX   = crypto.generateKeyPairSync('x25519');
  const recipKxPubHex = burrowPubHex(recipX.publicKey);

  const plaintext = flags.text || 'PlaneKey RootRabbit E2EE proof — the bridge will see ciphertext only.';
  const envelope = burrowEncrypt({
    plaintext,
    senderEdPriv: senderEd.privateKey,
    recipientKxPubHex: recipKxPubHex,
    envelopeKind: 'text/utf8',
    aad: 'rr-proof',
  });

  // Simulate "bridge attempts decrypt without the recipient X25519 private key"
  let bridgeAttemptResult = null;
  try {
    // Bridge does NOT have recipX.privateKey. Best it can do is try with
    // whatever it has — which is nothing. We model that as trying a *wrong*
    // private key (a freshly generated one) to demonstrate AEAD failure.
    const wrongX = crypto.generateKeyPairSync('x25519');
    burrowDecrypt({ envelope, recipientXPriv: wrongX.privateKey });
    bridgeAttemptResult = 'WHAT — the bridge decrypted ciphertext without the recipient key. This should never happen.';
  } catch (e) {
    bridgeAttemptResult = `correctly failed: ${e.message.split('\n')[0]}`;
  }

  // Recipient decrypt path
  const recovered = burrowDecrypt({ envelope, recipientXPriv: recipX.privateKey });
  const ok = recovered === plaintext;

  console.log(JSON.stringify({
    ok,
    proof: 'end-to-end-encryption round trip',
    sender_account_id_simulated: senderId,
    recipient_account_id_simulated: recipientId,
    plaintext_in: plaintext,
    plaintext_out: recovered,
    plaintext_round_trip_matches: ok,
    bridge_attempt_to_decrypt_without_recipient_private_key: bridgeAttemptResult,
    envelope_metadata_visible_to_bridge: {
      sender_kx_pub: envelope.sender_kx_pub,
      recipient_kx_pub: envelope.recipient_kx_pub,
      nonce_b64: envelope.nonce_b64,
      ciphertext_b64_prefix: envelope.ciphertext_b64.slice(0, 40) + '...',
      envelope_kind: envelope.envelope_kind,
      aad: envelope.aad,
      signature_prefix: envelope.signature.slice(0, 32) + '...',
    },
    proof_summary: ok
      ? 'recipient with X25519 private key decrypted successfully; same-shape attempt without that private key fails AEAD verify — bridge cannot read content.'
      : 'round-trip FAILED — protocol bug; do not ship.',
  }, null, 2));
}

// ── Cluster: Warren (mesh) — read-only views over the existing substrate ──

async function commandWarrenRecommended(root, flags) {
  const bridge = loadBridgeConfig(root, flags);
  const params = {};
  if (flags.region) params.region = flags.region;
  const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const target = `${bridge.url}/warren${qs ? '?' + qs : ''}`;
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({ ok: true, submitted: false, target, hint: '--submit to fetch from bridge' }, null, 2));
    return;
  }
  const res = await getBridge(bridge, '/v1/rootrabbit/recommended-bridge', params);
  if (res.status >= 400) bridgeError('warren', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

async function commandWarrenMirrors(root, flags) {
  const bridge = loadBridgeConfig(root, flags);
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({ ok: true, submitted: false, target: `${bridge.url}/v1/wbt/warren/mirrors`, hint: '--submit to fetch' }, null, 2));
    return;
  }
  const res = await getBridge(bridge, '/v1/wbt/warren/mirrors');
  if (res.status >= 400) bridgeError('warren mirrors', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

async function commandWarrenHealth(root, flags) {
  const bridge = loadBridgeConfig(root, flags);
  const params = {};
  if (flags.region) params.region = flags.region;
  if (flags.limit) params.limit = String(flags.limit);
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({ ok: true, submitted: false, target: `${bridge.url}/v1/wbt/warren/health`, filter: params, hint: '--submit to fetch' }, null, 2));
    return;
  }
  const res = await getBridge(bridge, '/v1/wbt/warren/health', params);
  if (res.status >= 400) bridgeError('warren health', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

async function commandWarrenFailovers(root, flags) {
  const bridge = loadBridgeConfig(root, flags);
  const params = {};
  if (flags['since-days']) params.since_days = String(flags['since-days']);
  if (flags.limit) params.limit = String(flags.limit);
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({ ok: true, submitted: false, target: `${bridge.url}/v1/wbt/warren/failovers`, filter: params, hint: '--submit to fetch' }, null, 2));
    return;
  }
  const res = await getBridge(bridge, '/v1/wbt/warren/failovers', params);
  if (res.status >= 400) bridgeError('warren failovers', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

// ── Cluster: Thump (signed broadcast) ────────────────────────────────────

async function commandThumpSend(root, flags) {
  const accountId = flags.account || flags['account-id'];
  if (!accountId) throw new Error('thump send requires --account <uuid>');
  const kind = flags.kind || 'note';
  const severity = flags.severity || 'info';
  const region = flags.region || 'global';
  const target = flags.target || '';
  let payload;
  try {
    payload = flags.payload ? JSON.parse(flags.payload) : { message: flags.message || '' };
  } catch (e) {
    throw new Error(`--payload must be JSON: ${e.message}`);
  }
  const bridge = loadBridgeConfig(root, flags);
  const edPriv = burrowLoadPrivate(accountId, 'ed25519');
  const canonical = `${accountId}|${kind}|${severity}|${region}|${target}|${JSON.stringify(payload)}`;
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), edPriv).toString('hex');
  // Thump is a signed SIREN: only a fingerprint + broadcast_kind travel to the
  // bridge (ThumpSendRequest) — never the payload. Fingerprint the signed
  // canonical so the fingerprint and the ed25519 signature share one base.
  const body = {
    kind: 'thump', // v0.3.0 WBT gateway discriminator (POST /v1/wbt)
    sender_account_id: accountId,
    broadcast_kind: kind, // the alert type (incident_open | failover | …)
    body_fingerprint_hash: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex'),
    signature_ed25519_hex: signature,
  };
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({ ok: true, submitted: false, target: `${bridge.url}/v1/wbt`, body, hint: '--submit to broadcast' }, null, 2));
    return;
  }
  const res = await postBridge(bridge, '/v1/wbt', body);
  if (res.status >= 400) bridgeError('thump send', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

async function commandThumpFeed(root, flags) {
  const bridge = loadBridgeConfig(root, flags);
  const params = {};
  if (flags.kind) params.kind = flags.kind;
  if (flags.severity) params.severity = flags.severity;
  if (flags.region) params.region = flags.region;
  if (flags['since-days']) params.since_days = String(flags['since-days']);
  if (flags.limit) params.limit = String(flags.limit);
  params.lane = 'thump'; // v0.3.0: thump feed is the thump lane of GET /v1/wbt/inbox
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({ ok: true, submitted: false, target: `${bridge.url}/v1/wbt/inbox?lane=thump`, filter: params, hint: '--submit to fetch' }, null, 2));
    return;
  }
  const res = await getBridge(bridge, '/v1/wbt/inbox', params);
  if (res.status >= 400) bridgeError('thump feed', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

async function commandThumpConsensus(root, flags) {
  const bridge = loadBridgeConfig(root, flags);
  if (!wantsSubmit(flags)) {
    console.log(JSON.stringify({ ok: true, submitted: false, target: `${bridge.url}/v1/wbt/thump/consensus`, hint: '--submit to fetch' }, null, 2));
    return;
  }
  const res = await getBridge(bridge, '/v1/wbt/thump/consensus');
  if (res.status >= 400) bridgeError('thump consensus', res);
  console.log(JSON.stringify({ ok: true, submitted: true, response: res.body }, null, 2));
}

function help() {
  return `PlaneKey Client v${VERSION}\n\nUsage:\n  pk-client init [workspace]\n  pk-client import <folder-or-zip> [--name label]\n  pk-client list\n  pk-client inventory\n  pk-client compare <snapshot-a> <snapshot-b>\n  pk-client sha-compare <before.sha> <after.sha> [--name report-name]\n  pk-client set-working <snapshot-id-or-name> [--force]\n  pk-client working-manifest\n  pk-client rootrabbit scan [folder-or-snapshot] [--require]\n  pk-client safetynet scan [folder-or-snapshot] [--requireRabbit]\n  pk-client repoguard scan [folder-or-snapshot]\n  pk-client debug map <debug-folder-or-full-export.zip> [--name report-name] [--base canon-folder] [--force]\n  pk-client debug agents <debug-folder-or-full-export.zip> [--name report-name] [--force]\n  pk-client integrity private <folder-or-snapshot> [--layer dev|builder|live] [--name label] [--secret value] [--redactPaths]\n  pk-client layer attest <dev|builder|live> <folder-or-snapshot> [--name label] [--secret value]\n  pk-client layer compare <left-private-index.json> <right-private-index.json> [--name report-name]\n  pk-client layer alert <left-private-index.json> <right-private-index.json> [--name alert-name]\n  pk-client layer policy\n  pk-client edge scan <folder-or-snapshot> [--name report-name] [--allowedDomains domain1,domain2]\n  pk-client edge plan <folder-or-report-json> [--name report-name] [--zone conversationchain.app]\n  pk-client edge dashboard <edge-plan-or-report-json-or-folder> [--name dashboard-name]\n  pk-client cloudflare policy\n  pk-client cloudflare map <folder-or-snapshot> [--name report-name]\n  pk-client cloudflare plan <folder-or-report-json> [--name report-name] [--zone conversationchain.app]\n  pk-client cloudflare dashboard <edge-plan-or-report-json-or-folder> [--name dashboard-name]\n  pk-client cloudflare apply <CLOUDFLARE_ACTION_PLAN.json> --dryRun\n  pk-client self version [--manifest]\n  pk-client self doctor\n  pk-client self update <planekey-client.zip-or-folder> [--target install-folder] [--dryRun] [--force]\n  pk-client rebuild scan <_unpacked-or-collector-folder> [--name report-name]\n  pk-client rebuild create <_unpacked-or-collector-folder> [--name rebuilt-name] [--force] [--includeUnmapped] [--requireRabbit]\n  pk-client rebuild scan-zips <zip-folder> [--name report-name] [--allZips]\n  pk-client rebuild from-zips <zip-folder> [--name rebuilt-name] [--force] [--includeUnmapped] [--requireRabbit] [--allZips]\n  pk-client patch add <patch-file> [--status pending|applied|rejected|superseded]\n  pk-client bundle create <name> [--base snapshot-id] [--allow file1,file2] [--intent text] [--requireRabbit]\n  pk-client export github-ready [--name folder-name] [--requireRabbit]\n  pk-client status\n  pk-client tree\n  pk-client detect [path] [--table]                              # project-shape detection (lib/detect.js)\n\nSqlbooks docs (v0.1.6.0 — per docs/HANDOFF-sqlbooks.md):\n  pk-client docs                                                 # open pk-docs.sqlbook in local browser\n  pk-client docs <slug>                                          # open at a specific section\n  pk-client docs --list                                          # print TOC to stdout (needs sqlite3 binary)\n  pk-client docs --search \"<term>\"                               # filter sections by LIKE on body_md\n  pk-client docs --port <N> --no-open                            # explicit port; don't auto-open browser\n\nBridge consumers (v0.1.5.8) — default is local-only; pass --submit to POST to bridge.planekey.dev:\n  pk-client flight report --base <ver> --proposed <ver> [--dir .] [--service id] [--submit]\n  pk-client canon analyze <input.json> [--service id] [--submit]\n  pk-client forensics attribution <input.json> [--service id] [--submit]\n  pk-client rgano packet <extractor.py> <raw.json> [--service-id id] [--submit]\n  pk-client rootrabbit health <observation.json> [--service id] [--submit]\n\nBridge consumers (v0.1.5.9 — closes trio Cluster B per docs/TRIO_WIRING_AUDIT.md):\n  pk-client bridge probe [--submit]\n  pk-client bridge attest <input.json> [--submit]\n  pk-client bridge attestations [--service id] [--layer dev|builder|live] [--limit 50] [--submit]\n  pk-client bridge compare <left-index.json> <right-index.json> [--submit]\n  pk-client bridge incident <input.json> [--submit]\n  pk-client bridge policy [--submit]\n  pk-client bridge dashboard <incident-id> [--submit]\n\nZero/patch translator (v0.1.5.10 — see docs/INTEGRATIONS_ZERO.md on products):\n  pk-client zero translate <zero-output.json> [--include-symbols] [--out file] [--summary text] [--submit]\n\nRPG queries (v0.1.5.11 — absorbed from pk-client-rpg.js):\n  pk-client rpg capabilities [--db path] [--table]\n  pk-client rpg symbols --capability <name> [--db path] [--limit 50] [--table]\n  pk-client rpg module <name> [--db path] [--table]\n  pk-client rpg query <text> [--db path] [--limit 20] [--table]\n  pk-client rpg drift <left.sqlite> <right.sqlite> [--table]\n  pk-client rpg reachable <symbol-name> [--db path] [--depth 6] [--table]\n\nAI-agent coherence pack (v0.1.5.11 — absorbed from pk-client-coherence.js):\n  pk-client coherence [--dbs <databases-worktree>] [--service-id id] [--out file]\n\nTrust state (v0.1.5.12 — reads products/bridge/provenance/*PRIVATE_INDEX.json):\n  pk-client trust state [--table]                                # latest dev/builder/live attestations from committed provenance\n  pk-client matrix carry-forward <left-ver> <right-ver> [--scope canonical|home-bridge|repo-db] [--table]\n                                                                 # file-hash carry-forward between two provenance snapshots\n\nBridge aggregates (v0.1.5.13 — audit-named SELECTs #2 + #5; default local-only, --submit hits bridge.planekey.dev):\n  pk-client decisions distribution [--service id] [--since-days 30] [--submit]\n                                                                 # histogram over canon/forensics/route_health decision columns\n  pk-client operator replay [--service id] [--kind patch_apply] [--since-days 30] [--limit 200] [--submit]\n                                                                 # replays the bridge intent log (operator_actions table)\n\nBurrow — E2EE 1:1 channel, three security tiers (v0.1.5.14):\n  pk-client burrow keygen --account <uuid> [--force]             # generate keypair in ~/.planekey/burrow-keys/\n  pk-client burrow keys --account <uuid> [--submit]              # publish pubkeys to bridge\n  pk-client burrow send  <to> <text> --account <uuid> [--submit] # autoroutes to hop (default casual tier)\n  pk-client burrow hop   <to> <text> --account <uuid> [--submit] # tier 1 — sender visible, direct      (free)\n  pk-client burrow run   <to> <text> --account <uuid> [--submit] # tier 2 — sender anonymized + jitter  (free)\n  pk-client burrow vault <to> <text> --account <uuid> \\\n      --cosign-with <signer-uuid> --cosign-sig <hex> [--cosign-with ... --cosign-sig ...] \\\n      [--witness-sig <hex>] [--submit]                            # tier 3 — cosigs + allowlist + entitlement (paid OR system kind)\n  pk-client burrow inbox --account <uuid> [--limit 50] [--submit]\n  pk-client burrow proof [--text "..."]                          # offline proof: bridge cannot decrypt at ANY tier\n\nWarren — mesh / routing (v0.1.5.14, read-only):\n  pk-client warren [--region us-east] [--submit]                 # recommended mirror\n  pk-client warren mirrors [--submit]\n  pk-client warren health [--region us-east] [--limit 50] [--submit]\n  pk-client warren failovers [--since-days 30] [--limit 100] [--submit]\n\nThump — signed broadcast / alert (v0.1.5.14):\n  pk-client thump send --account <uuid> --kind <kind> --severity info|warn|critical \\\n                       [--region global] [--target /path] [--message "..."|--payload '{...}'] [--submit]\n  pk-client thump feed [--kind ...] [--severity ...] [--region ...] [--since-days 7] [--limit 100] [--submit]\n  pk-client thump consensus [--submit]\n\nEnv vars for --submit:\n  PLANEKEY_SESSION_TOKEN     bearer token for the user's bridge account\n  PLANEKEY_HMAC_SECRET       shared secret for HMAC-gated routes\n\nExamples:\n  pk-client init ./ConversationChain_Master\n  cd ./ConversationChain_Master\n  pk-client import ~/Downloads/conversationchain.zip --name polsia-fresh-download\n  pk-client inventory\n  pk-client list\n  pk-client sha-compare ./cc8_orig.sha ./cc8_updated.sha --name cc8-update\n  pk-client set-working 20260503T..._cc_polsia-fresh-download\n  pk-client rootrabbit scan\n  pk-client repoguard scan\n  pk-client debug map ./conversationchain-full-export.zip --name polsia-debug-map --base ./working/conversationchain-current\n  pk-client debug agents ./conversationchain-full-export.zip --name polsia-agent-runtime\n  pk-client integrity private ./working/conversationchain-current --layer dev --name dev-private-index\n  pk-client layer attest dev ./working/conversationchain-current --name dev-canon\n  pk-client layer compare ./reports/layers/dev-canon/PLANKEY_PRIVATE_INDEX.json ./reports/layers/live/PLANKEY_PRIVATE_INDEX.json\n  pk-client edge scan ./working/conversationchain-current --name app-edge-risk\n  pk-client edge plan ./reports/edge/app-edge-risk/EDGE_RISK_SCAN.json --zone conversationchain.app\n  pk-client edge dashboard ./reports/edge/app-edge-risk/EDGE_RISK_SCAN.json --name shareable-security-dashboard\n  pk-client self update ./planekey-client-v1.5.4.zip --dryRun\n  pk-client self update ./planekey-client-v1.5.4.zip\n  pk-client rebuild from-zips ./_all_zips --name cc-rebuild --force --requireRabbit\n  pk-client export github-ready\n`;
}

// --- Scoped help router -------------------------------------------------
// The full usage block in help() is the single source of truth. These
// helpers derive per-family help by filtering those same lines, so scoped
// help can never drift from the real command list.

function usageLines() {
  return help().split('\n');
}

// Set of every command/family token that appears as the first word after
// `pk-client ` in the usage block (e.g. rpg, burrow, layer, edge, ...).
function helpTopics() {
  const set = new Set();
  for (const line of usageLines()) {
    const m = line.match(/^\s*pk-client\s+([A-Za-z][\w-]*)/);
    if (m) set.add(m[1]);
  }
  return set;
}

// Print ONLY the usage lines whose command token matches `topic`, plus a
// one-line footer. Returns true if it printed anything, false if the topic
// has no usage lines (caller can then fall back to the error path).
function printScopedHelp(topic) {
  const escaped = String(topic).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^\\s*pk-client\\s+' + escaped + '\\b');
  const matched = usageLines().filter((l) => re.test(l));
  if (matched.length === 0) return false;
  console.log(`PlaneKey Client v${VERSION}\n`);
  console.log(`Usage for '${topic}':`);
  for (const l of matched) console.log(l);
  console.log(`\nRun 'pk-client --help' for all commands.`);
  return true;
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));

  // Scoped help router. `--help`/`-h`/`help` with a known family token drills
  // into that family; without one it prints the full global usage (unchanged).
  const knownTopics = helpTopics();
  const helpConsumed = ('help' in flags) ? flags.help : ('h' in flags ? flags.h : null);
  const helpRequested =
    ('help' in flags) || ('h' in flags) ||
    positionals.includes('-h') || positionals[0] === 'help';
  if (helpRequested) {
    // Prefer an explicit command token in the positionals; otherwise fall
    // back to a token that `--help <token>` may have swallowed as its value.
    let topic = positionals.find((p) => knownTopics.has(p));
    if (!topic && typeof helpConsumed === 'string' && knownTopics.has(helpConsumed)) {
      topic = helpConsumed;
    }
    if (topic && printScopedHelp(topic)) return;
    console.log(help());
    return;
  }
  if (!positionals[0]) {
    console.log(help());
    return;
  }

  const cmd = positionals[0];
  const sub = positionals[1];
  const root = path.resolve(flags.root || process.cwd());

  if (cmd === 'init') return commandInit(positionals[1] || process.cwd());
  if (cmd === 'import') return commandImport(root, positionals[1], flags);
  if (cmd === 'list') return commandList(root);
  if (cmd === 'inventory') return commandInventory(root);
  if (cmd === 'compare') return commandCompare(root, positionals[1], positionals[2], flags);
  if (cmd === 'sha-compare') return commandShaCompare(root, positionals[1], positionals[2], flags);
  if (cmd === 'set-working') return commandSetWorking(root, positionals[1], flags);
  if (cmd === 'working-manifest') return commandWorkingManifest(root);
  if (cmd === 'status') return commandStatus(root);
  if (cmd === 'tree') return commandTree(root);
  if (cmd === 'detect') return commandDetect(root, positionals[1], flags);
  if (cmd === 'docs') return commandDocs(root, positionals[1], flags);
  if (cmd === 'rootrabbit' && sub === 'scan') return commandRootRabbitScan(root, positionals[2], flags);
  if (cmd === 'safetynet' && sub === 'scan') return commandSafetyNetScan(root, positionals[2], flags);
  if (cmd === 'repoguard' && sub === 'scan') return commandRepoGuardScan(root, positionals[2], flags);
  if (cmd === 'repoguard' && sub === 'sanitize') return commandRepoGuardSanitize(root, positionals[2], flags);
  if (cmd === 'debug' && sub === 'map') return commandDebugMap(root, positionals[2], flags);
  if (cmd === 'debug' && sub === 'agents') return commandDebugAgents(root, positionals[2], flags);
  if (cmd === 'integrity' && sub === 'private') return commandIntegrityPrivate(root, positionals[2], flags);
  if (cmd === 'layer' && sub === 'attest') return commandLayerAttest(root, positionals[2], positionals[3], flags);
  if (cmd === 'layer' && sub === 'compare') return commandLayerCompare(root, positionals[2], positionals[3], flags);
  if (cmd === 'layer' && sub === 'alert') return commandLayerAlert(root, positionals[2], positionals[3], flags);
  if (cmd === 'layer' && sub === 'policy') return commandLayerPolicy(root);
  if (cmd === 'edge' && sub === 'scan') return commandEdgeScan(root, positionals[2], flags);
  if (cmd === 'edge' && sub === 'plan') return commandEdgePlan(root, positionals[2], flags);
  if (cmd === 'pixelguard' && sub === 'scan') return commandPixelGuardScan(root, positionals[2], flags);
  if (cmd === 'residue' && sub === 'map') return commandResidueMap(root, positionals[2], flags);
  if (cmd === 'residue' && sub === 'compare') return commandResidueCompare(root, positionals[2], positionals[3], flags);
  if (cmd === 'residue' && sub === 'explain') return commandResidueExplain(root, positionals[2], flags);
  if (cmd === 'edge' && sub === 'dashboard') return commandEdgeDashboard(root, positionals[2], flags);
  if (cmd === 'cloudflare' && sub === 'policy') return commandCloudflarePolicy(root);
  if (cmd === 'cloudflare' && sub === 'map') return commandEdgeScan(root, positionals[2], flags);
  if (cmd === 'cloudflare' && sub === 'plan') return commandEdgePlan(root, positionals[2], flags);
  if (cmd === 'cloudflare' && sub === 'dashboard') return commandEdgeDashboard(root, positionals[2], flags);
  if (cmd === 'cloudflare' && sub === 'apply') return commandCloudflareApply(root, positionals[2], flags);
  if (cmd === 'self' && sub === 'version') return commandSelfVersion(root, flags);
  if (cmd === 'self' && sub === 'doctor') return commandSelfDoctor(root);
  if (cmd === 'self' && sub === 'update') return commandSelfUpdate(root, positionals[2], flags);
  if (cmd === 'rebuild' && sub === 'scan') return commandRebuildScan(root, positionals[2], flags);
  if (cmd === 'rebuild' && sub === 'create') return commandRebuildCreate(root, positionals[2], flags);
  if (cmd === 'rebuild' && sub === 'scan-zips') return commandRebuildScanZips(root, positionals[2], flags);
  if (cmd === 'rebuild' && sub === 'from-zips') return commandRebuildFromZips(root, positionals[2], flags);
  if (cmd === 'patch' && sub === 'add') return commandPatchAdd(root, positionals[2], flags);
  if (cmd === 'bundle' && sub === 'create') return commandBundleCreate(root, positionals[2], flags);
  if (cmd === 'export' && sub === 'github-ready') return commandExportGithub(root, flags);

  // v0.1.5.8 — bridge consumers for adapters in bridge/tools/
  if (cmd === 'flight' && sub === 'report') return commandFlightReport(root, flags);
  if (cmd === 'canon' && sub === 'analyze') return commandCanonAnalyze(root, positionals[2], flags);
  if (cmd === 'forensics' && sub === 'attribution') return commandForensicsAttribution(root, positionals[2], flags);
  if (cmd === 'rgano' && sub === 'packet') return commandRganoPacket(root, positionals[2], positionals[3], flags);
  if (cmd === 'rootrabbit' && sub === 'health') return commandRootRabbitHealth(root, positionals[2], flags);

  // v0.1.5.9 — Cluster B closure (trio wiring audit).
  // Subcommands map 1:1 to /bridge/* routes the audit found unwired from pk-client.
  if (cmd === 'bridge' && sub === 'probe') return commandBridgeProbe(root, flags);
  if (cmd === 'bridge' && sub === 'attest') return commandBridgeAttest(root, positionals[2], flags);
  if (cmd === 'bridge' && sub === 'attestations') return commandBridgeAttestations(root, flags);
  if (cmd === 'bridge' && sub === 'compare') return commandBridgeCompare(root, positionals[2], positionals[3], flags);
  if (cmd === 'bridge' && sub === 'incident') return commandBridgeIncident(root, positionals[2], flags);
  if (cmd === 'bridge' && sub === 'policy') return commandBridgePolicy(root, flags);
  if (cmd === 'bridge' && sub === 'dashboard') return commandBridgeDashboard(root, positionals[2], flags);

  // v0.1.5.10 — zero/patch translator. Reads zerolang.ai compiler JSON
  // (diagnostics + repair plans + symbol graph) and emits a
  // planekey.patch.v1 manifest that flows through the bridge's existing
  // /admin/health/self-update endpoint. See docs/INTEGRATIONS_ZERO.md
  // on the products branch for the full mapping table.
  if (cmd === 'zero' && sub === 'translate') return commandZeroTranslate(root, positionals[2], flags);

  // v0.1.5.11 — absorbed from pk-client-rpg.js + pk-client-coherence.js siblings
  if (cmd === 'rpg' && sub === 'capabilities') return commandRpgCapabilities(root, flags);
  if (cmd === 'rpg' && sub === 'symbols') return commandRpgSymbols(root, flags);
  if (cmd === 'rpg' && sub === 'module') return commandRpgModule(root, positionals[2], flags);
  if (cmd === 'rpg' && sub === 'query') return commandRpgQuery(root, positionals[2], flags);
  if (cmd === 'rpg' && sub === 'drift') return commandRpgDrift(root, positionals[2], positionals[3], flags);
  if (cmd === 'rpg' && sub === 'reachable') return commandRpgReachable(root, positionals[2], flags);
  if (cmd === 'matrix' && sub === 'carry-forward') return commandMatrixCarryForward(root, positionals[2], positionals[3], flags);
  if (cmd === 'coherence') return commandCoherence(root, flags);
  if (cmd === 'schema' && (sub === 'scan' || !sub)) return commandSchemaScan(root, flags);
  if (cmd === 'trust' && sub === 'state') return commandTrustState(root, flags);

  // v0.1.5.13 — bridge aggregate consumers (audit-named SELECTs #2 + #5)
  if (cmd === 'decisions' && (sub === 'distribution' || !sub)) return commandDecisionsDistribution(root, flags);
  if (cmd === 'operator' && sub === 'replay') return commandOperatorReplay(root, flags);

  // v0.1.5.14 — Burrow (E2EE) / Warren (mesh) / Thump (broadcast)
  if (cmd === 'burrow' && sub === 'keygen') return commandBurrowKeygen(root, flags);
  if (cmd === 'burrow' && sub === 'keys')   return commandBurrowKeys(root, flags);
  if (cmd === 'burrow' && sub === 'send')   return commandBurrowSend(root,  positionals[2], positionals.slice(3).join(' '), flags);
  if (cmd === 'burrow' && sub === 'hop')    return commandBurrowHop(root,   positionals[2], positionals.slice(3).join(' '), flags);
  if (cmd === 'burrow' && sub === 'run')    return commandBurrowRun(root,   positionals[2], positionals.slice(3).join(' '), flags);
  if (cmd === 'burrow' && sub === 'vault')  return commandBurrowVault(root, positionals[2], positionals.slice(3).join(' '), flags);
  if (cmd === 'burrow' && sub === 'inbox')  return commandBurrowInbox(root, flags);
  if (cmd === 'burrow' && sub === 'proof')  return commandBurrowProof(root, flags);

  if (cmd === 'warren' && (!sub || sub === 'recommended')) return commandWarrenRecommended(root, flags);
  if (cmd === 'warren' && sub === 'mirrors')               return commandWarrenMirrors(root, flags);
  if (cmd === 'warren' && sub === 'health')                return commandWarrenHealth(root, flags);
  if (cmd === 'warren' && sub === 'failovers')             return commandWarrenFailovers(root, flags);

  if (cmd === 'thump' && sub === 'send')      return commandThumpSend(root, flags);
  if (cmd === 'thump' && (!sub || sub === 'feed')) return commandThumpFeed(root, flags);
  if (cmd === 'thump' && sub === 'consensus') return commandThumpConsensus(root, flags);

  // A bare (or unrecognized-sub) known family shows that family's scoped help
  // instead of the global dump / "Unknown command" error. Genuinely unknown
  // tokens still error as before.
  if (knownTopics.has(cmd) && printScopedHelp(cmd)) return;

  throw new Error(`Unknown command: ${positionals.join(' ')}\n\n${help()}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
