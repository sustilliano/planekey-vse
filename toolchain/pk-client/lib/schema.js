// lib/schema.js — pkclient's database artifact analyzer.
//
// The fourth pkclient citizen. pkclient already snapshots/compares/attests
// repos, programs, and AIs; a DATABASE is the same kind of thing — its schema
// is a declared artifact that drifts from what actually uses it. This module
// reconciles the three layers of a database, mirroring how pkclient reconciles
// canon/live for repos:
//
//   • DECLARED  — the migration files (docs of intent; cheap to add, so they rot)
//   • REQUIRED  — what the code's SQL actually needs (the function / ground truth)
//   • DEPLOYED  — what the unified setup bundle actually contains
//
// It is a STATIC analyzer (no live DB needed), like flight/hutch — it produces
// a receipt, not a runtime probe. A live sqlx probe is a deeper layer to add
// when a DATABASE_URL is present; this is the portable, always-runnable core.
//
// Findings are tiered by confidence so it never cries wolf:
//   BREAK (high)  — code writes to a table/column no migration declares (DML
//                   targets + INSERT column lists are unambiguous).
//   GAP  (high)   — a migration exists but its object is absent from the bundle.
//   ADVISORY(low) — a declared table no code references (candidate doc-only).

'use strict';

const fs = require('fs');
const path = require('path');

// ── Workspace database map ──────────────────────────────────────────────────
function dbConfigs(root) {
  const J = (p) => path.join(root, p);
  return [
    {
      name: 'auth',
      label: 'Auth (Supabase)',
      migrationsDir: J('products/bridge/migrations'),
      migrationFilter: (f) => /^\d{3}_.*\.sql$/.test(f),
      bundle: J('deploy/migrations-bundled/supabase-auth-all.sql'),
    },
    {
      name: 'repo',
      label: 'Repo (Neon)',
      migrationsDir: J('products/bridge/migrations'),
      migrationFilter: (f) => /^repo_db_\d{3}_.*\.sql$/.test(f),
      bundle: J('deploy/migrations-bundled/neon-repo-all.sql'),
    },
    {
      name: 'bean',
      label: 'Bean (Neon)',
      migrationsDir: J('products/planekey-bean/migrations'),
      migrationFilter: (f) => /^\d{3}_.*\.sql$/.test(f),
      bundle: J('deploy/migrations-bundled/neon-bean-all.sql'),
    },
  ];
}

// The code that talks to every DB. All pools live in the bridge.
const CODE_DIRS = ['products/bridge/src'];

function readIf(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function listSql(dir, filter) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((f) => f.endsWith('.sql') && filter(f)).sort();
}

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.rs')) out.push(p);
  }
  return out;
}

// ── Parse migrations → declared schema ──────────────────────────────────────
// Returns: { tables: Map<name,{columns:Set, firstFile}>, views:Set,
//            perFile: [{file, tables:[], views:[]}] }
function parseDeclared(files, dirForRead) {
  const tables = new Map();
  const views = new Set();
  const perFile = [];

  for (const file of files) {
    const sql = readIf(path.join(dirForRead, file)) || '';
    const noComments = sql.replace(/--[^\n]*/g, '');
    const fileTables = [];
    const fileViews = [];

    // CREATE TABLE [IF NOT EXISTS] name ( body )
    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
    let m;
    while ((m = createRe.exec(noComments))) {
      const name = m[1].toLowerCase();
      const body = m[2];
      const cols = new Set();
      // One column per line (SQL convention). Split by LINE, not by ",\n" —
      // trailing whitespace after commas ("NOT NULL,   \n") makes ",\n" miss
      // splits and silently drop columns. Take each line's leading identifier
      // unless it's a constraint / continuation keyword. Over-capturing a stray
      // token (e.g. a bare enum value inside a multi-line CHECK) is HARMLESS —
      // it can only suppress a "dead column" advisory, never fabricate a break.
      // MISSING a real column is the dangerous direction, so we err to capture.
      const SKIP = new Set([
        'primary', 'unique', 'foreign', 'constraint', 'check', 'exclude',
        'references', 'on', 'default', 'using', 'include', 'where',
        'deferrable', 'initially', 'not', 'null', 'collate', 'generated', 'as',
      ]);
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        const cm = line.match(/^([a-z_][a-z0-9_]*)\b/i);
        if (!cm) continue;
        const id = cm[1].toLowerCase();
        if (SKIP.has(id)) continue;
        cols.add(id);
      }
      if (!tables.has(name)) tables.set(name, { columns: new Set(), firstFile: file });
      const t = tables.get(name);
      cols.forEach((c) => t.columns.add(c));
      fileTables.push(name);
    }

    // ALTER TABLE name ADD COLUMN [IF NOT EXISTS] col
    const addRe = /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    while ((m = addRe.exec(noComments))) {
      const name = m[1].toLowerCase();
      const col = m[2].toLowerCase();
      if (!tables.has(name)) tables.set(name, { columns: new Set(), firstFile: file });
      tables.get(name).columns.add(col);
    }

    // ALTER TABLE name RENAME COLUMN old TO new
    const renRe = /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+RENAME\s+COLUMN\s+([a-z_][a-z0-9_]*)\s+TO\s+([a-z_][a-z0-9_]*)/gi;
    while ((m = renRe.exec(noComments))) {
      const name = m[1].toLowerCase();
      const t = tables.get(name);
      if (t) { t.columns.delete(m[2].toLowerCase()); t.columns.add(m[3].toLowerCase()); }
    }

    // CREATE [OR REPLACE] VIEW name  /  MATERIALIZED VIEW
    const viewRe = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    while ((m = viewRe.exec(noComments))) {
      const name = m[1].toLowerCase();
      views.add(name);
      fileViews.push(name);
    }

    perFile.push({ file, tables: fileTables, views: fileViews });
  }

  return { tables, views, perFile };
}

// ── Parse code → required schema ────────────────────────────────────────────
// High-confidence signals only: INSERT INTO / UPDATE targets (real tables), and
// INSERT column lists (unambiguously attributed to their table).
function parseRequired(rootDirs) {
  const dmlTargets = new Map(); // table -> Set(files)  (INSERT INTO / UPDATE)
  const insertCols = new Map(); // table -> Set(columns)
  const allRefTables = new Set(); // FROM/JOIN too (for advisory "unused")
  const files = [];
  for (const d of rootDirs) walk(d, files);

  for (const f of files) {
    const src = readIf(f);
    if (!src) continue;

    // INSERT INTO t (c1, c2, ...)
    const insRe = /INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi;
    let m;
    while ((m = insRe.exec(src))) {
      const t = m[1].toLowerCase();
      if (!dmlTargets.has(t)) dmlTargets.set(t, new Set());
      dmlTargets.get(t).add(path.relative(process.cwd(), f));
      allRefTables.add(t);
      if (!insertCols.has(t)) insertCols.set(t, new Set());
      for (const c of m[2].split(',')) {
        const id = c.trim().toLowerCase().match(/^[a-z_][a-z0-9_]*/);
        if (id) insertCols.get(t).add(id[0]);
      }
    }
    // UPDATE t SET
    const updRe = /UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\b/gi;
    while ((m = updRe.exec(src))) {
      const t = m[1].toLowerCase();
      if (!dmlTargets.has(t)) dmlTargets.set(t, new Set());
      dmlTargets.get(t).add(path.relative(process.cwd(), f));
      allRefTables.add(t);
    }
    // FROM / JOIN t  (may be views/CTEs — used only for advisory "unused")
    const fromRe = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
    while ((m = fromRe.exec(src))) allRefTables.add(m[1].toLowerCase());
  }

  return { dmlTargets, insertCols, allRefTables };
}

// ── Bundle coverage: is each migration's primary object present? ─────────────
function bundleCoverage(perFile, bundleSql) {
  const present = [];
  const missing = [];
  const haystack = (bundleSql || '').toLowerCase();
  for (const pf of perFile) {
    // Primary object = first table created, else first view, else the filename.
    const probe = pf.tables[0] || pf.views[0] || null;
    let found;
    if (probe) {
      // Look for a CREATE of that object in the bundle (not just any mention).
      found = new RegExp(`(create\\s+table[^;]*\\b${probe}\\b|create\\s+(or\\s+replace\\s+)?(materialized\\s+)?view[^;]*\\b${probe}\\b)`, 'i').test(bundleSql || '');
    } else {
      // No create at all (pure ALTER/grant migration, e.g. RLS): probe by filename stem.
      const stem = pf.file.replace(/\.sql$/, '').replace(/^\d+_|^repo_db_\d+_/, '');
      found = haystack.includes(stem.toLowerCase());
    }
    (found ? present : missing).push(pf.file);
  }
  return { present, missing };
}

// Tables that aren't real user tables — never flag these as "missing".
const SYSTEM_TABLES = new Set([
  'information_schema', 'pg_catalog', 'pg_roles', 'pg_constraint', 'pg_class',
  'pg_attribute', 'pg_indexes', 'pg_policies',
]);

function analyzeSchema(root) {
  const configs = dbConfigs(root);

  // Global declared schema across ALL dbs (code hits any pool).
  const declaredTables = new Map(); // name -> { db, columns:Set, firstFile }
  const declaredViews = new Map();  // name -> db
  const dbReports = [];

  for (const cfg of configs) {
    const files = listSql(cfg.migrationsDir, cfg.migrationFilter);
    const declared = parseDeclared(files, cfg.migrationsDir);
    for (const [name, t] of declared.tables) {
      declaredTables.set(name, { db: cfg.name, columns: t.columns, firstFile: t.firstFile });
    }
    for (const v of declared.views) declaredViews.set(v, cfg.name);

    const cov = bundleCoverage(declared.perFile, readIf(cfg.bundle));
    dbReports.push({
      db: cfg.name, label: cfg.label,
      migrations: files.length,
      tables: declared.tables.size,
      views: declared.views.size,
      bundlePresent: cov.present.length,
      bundleMissing: cov.missing,
    });
  }

  const required = parseRequired(CODE_DIRS.map((d) => path.join(root, d)));

  // ── Reconcile ──────────────────────────────────────────────────────────
  const breaks = [];   // high-confidence code↔schema mismatches
  const advisories = []; // low-confidence

  // BREAK: code writes (INSERT/UPDATE) to a table no migration declares.
  for (const [t, filesSet] of required.dmlTargets) {
    if (SYSTEM_TABLES.has(t)) continue;
    if (declaredTables.has(t) || declaredViews.has(t)) continue;
    breaks.push({
      kind: 'missing_table',
      table: t,
      detail: `code writes to "${t}" but no migration declares it`,
      files: [...filesSet].slice(0, 5),
    });
  }

  // BREAK: INSERT column not declared on its (declared) table.
  for (const [t, cols] of required.insertCols) {
    const decl = declaredTables.get(t);
    if (!decl) continue; // table-missing already reported above
    for (const c of cols) {
      if (!decl.columns.has(c)) {
        breaks.push({
          kind: 'missing_column',
          table: t, column: c,
          detail: `code INSERTs "${t}.${c}" but no migration declares that column`,
        });
      }
    }
  }

  // ADVISORY: a declared table never referenced by code (candidate doc-only).
  for (const [name, meta] of declaredTables) {
    if (!required.allRefTables.has(name)) {
      advisories.push({
        kind: 'unused_table',
        table: name, db: meta.db,
        detail: `table "${name}" (${meta.db}, first in ${meta.firstFile}) is not referenced by any bridge/src query`,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    databases: dbReports,
    summary: {
      declaredTables: declaredTables.size,
      declaredViews: declaredViews.size,
      codeWriteTargets: required.dmlTargets.size,
      breaks: breaks.length,
      advisories: advisories.length,
      bundleGaps: dbReports.reduce((n, d) => n + d.bundleMissing.length, 0),
    },
    breaks,
    advisories,
  };
}

module.exports = { analyzeSchema };
