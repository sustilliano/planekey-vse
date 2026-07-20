'use strict';

/**
 * versionIntegrity.js — version drift as a first-class check.
 * ===========================================================
 * Residue, canon, secrets and license are all "scan the repo and flag what's
 * off." Version governance is the same shape: does the declared version agree
 * with the changelog, the tags, and the size of the change? This runs as part
 * of the snapshot system (and on demand) and returns findings, so the standard
 * in docs/VERSIONING.md is enforced, not just documented.
 *
 * Pure Node, no deps. Findings are { level: 'ok'|'info'|'warn', message }.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const RANK = ['none', 'patch', 'minor', 'major'];

function parseSemver(v) { const m = SEMVER.exec(String(v || '').trim()); return m ? [+m[1], +m[2], +m[3]] : null; }
function cmp(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }
function bumpKind(from, to) { // rank of the delta from -> to (assumes to >= from)
  if (to[0] > from[0]) return 3; if (to[1] > from[1]) return 2; if (to[2] > from[2]) return 1; return 0;
}
function git(root, args) {
  try { return cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (_) { return ''; }
}

function checkVersionIntegrity(root) {
  const findings = [];
  const add = (level, message) => findings.push({ level, message });

  // ── package.json ──
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (_) {}
  const version = pkg && pkg.version ? String(pkg.version) : null;
  if (!version) { add('info', 'No package.json version — version integrity not applicable.'); return summarize(findings, null); }
  const sv = parseSemver(version);
  if (!sv) add('warn', `package.json version "${version}" is not MAJOR.MINOR.PATCH.`);

  // ── changelog ──
  let headings = [];
  try {
    const cl = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    headings = (cl.match(/^##\s+(\d+\.\d+\.\d+)/gm) || []).map(h => h.replace(/^##\s+/, '').trim());
  } catch (_) { add('info', 'No CHANGELOG.md — the standard records each version there.'); }

  if (headings.length) {
    const top = headings[0];
    if (top === version) add('ok', `Version ${version} matches the top of the changelog.`);
    else add('warn', `package.json (${version}) doesn't match the top CHANGELOG heading (${top}).`);

    const count = headings.filter(h => h === version).length;
    if (count === 0) add('warn', `Version ${version} has no CHANGELOG entry.`);
    else if (count > 1) add('warn', `Version ${version} appears ${count}× in the CHANGELOG.`);

    const dupes = [...new Set(headings.filter((h, i) => headings.indexOf(h) !== i))];
    if (dupes.length) add('warn', `Duplicate CHANGELOG headings: ${dupes.join(', ')}.`);

    const unparseable = headings.filter(h => !parseSemver(h));
    if (unparseable.length) add('warn', `Non-SemVer CHANGELOG headings: ${unparseable.join(', ')}.`);
  }

  // ── git tags ──
  const tags = git(root, ['tag', '--list'])
    .split('\n').map(s => s.trim().replace(/^v/, '')).filter(t => parseSemver(t))
    .map(parseSemver).sort(cmp);
  const latest = tags.length ? tags[tags.length - 1] : null;

  if (!latest) {
    add('info', 'No release tags yet — the standard tags each release vX.Y.Z.');
  } else if (sv) {
    const c = cmp(sv, latest);
    if (c > 0) add('info', `Unreleased: ${version} is ahead of the latest tag v${latest.join('.')}.`);
    else if (c === 0) add('ok', `Tagged release v${version}.`);
    else add('warn', `package.json ${version} is behind the latest tag v${latest.join('.')}.`);
  }

  // ── bump adequacy since last tag (conventional commits) ──
  if (latest && sv && cmp(sv, latest) > 0) {
    const subjects = git(root, ['log', `v${latest.join('.')}..HEAD`, '--format=%s']).split('\n').filter(Boolean);
    let implied = 0;
    for (const s of subjects) {
      const m = /^(\w+)(\([^)]*\))?(!)?:/.exec(s);
      if (!m) continue;
      if (m[3]) implied = Math.max(implied, 3);
      else if (m[1] === 'feat') implied = Math.max(implied, 2);
      else if (m[1] === 'fix') implied = Math.max(implied, 1);
    }
    const delta = bumpKind(latest, sv);
    if (implied > delta) {
      add('warn', `Commits since v${latest.join('.')} imply a ${RANK[implied]} bump, but the version moved only ${RANK[delta]} (see docs/VERSIONING.md).`);
    }
  }

  return summarize(findings, version);
}

function summarize(findings, version) {
  const warnings = findings.filter(f => f.level === 'warn').length;
  return { version, ok: warnings === 0, warnings, findings };
}

module.exports = { checkVersionIntegrity };
