// =============================================================================
// planekey-vcs-hooks.ts
// Git hooks + merge workflows for licensing compliance
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';

// ============================================================================
// MERGE WORKFLOW: Before merging upstream/main
// ============================================================================

async function runPreMergeChecks(
  projectRoot: string,
  upstreamRepo: string,
  upstreamBranch: string
): Promise<MergeCheckResult> {
  const result: MergeCheckResult = {
    canMerge: true,
    blocks: [],
    warnings: [],
    actions: []
  };

  // Step 1: Detect licenses
  const yourLicense = (await detectLicense(projectRoot))[0]?.license || 'Unknown';
  const upstreamLicense = (await detectLicense(path.join(projectRoot, '.upstream-cache')))[0]?.license || 'Unknown';

  // Step 2: Check compatibility
  const compat = checkLicenseCompatibility(yourLicense, upstreamLicense);

  if (!compat.compatible) {
    result.blocks.push(\`⚠️ License incompatibility: \${compat.reason}\`);
    result.canMerge = false;
    result.actions.push(...compat.recommendations);
  }

  // Step 3: Check compliance
  const compliance = await checkComplianceStatus(projectRoot, upstreamRepo, upstreamLicense);

  for (const issue of compliance.issues) {
    if (issue.severity === 'error') {
      result.blocks.push(\`❌ \${issue.message}\`);
      result.canMerge = false;
      result.actions.push(issue.fix);
    }
  }

  for (const warn of compliance.warnings) {
    result.warnings.push(\`⚠️ \${warn.message}\`);
  }

  // Step 4: Generate attribution
  if (compat.compatible) {
    const registry = await buildAttributionRegistry(projectRoot, upstreamRepo, upstreamLicense);
    const md = await generateAttributionMarkdown(registry);

    // Save attribution
    const attributionPath = path.join(projectRoot, 'ATTRIBUTION.md');
    fs.writeFileSync(attributionPath, md);

    result.actions.push(\`✓ Attribution registry generated: ATTRIBUTION.md\`);
  }

  return result;
}

interface MergeCheckResult {
  canMerge: boolean;
  blocks: string[];
  warnings: string[];
  actions: string[];
}

// ============================================================================
// GIT HOOK: Pre-commit (Licensing Check)
// ============================================================================

async function installPreCommitHook(projectRoot: string): Promise<void> {
  const hooksDir = path.join(projectRoot, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = path.join(hooksDir, 'pre-commit');

  const hookScript = \`#!/bin/bash
# PlaneKey: License compliance pre-commit hook

PROJECT_ROOT="\$(git rev-parse --show-toplevel)"
cd "\$PROJECT_ROOT"

# Check if any files have SPDX headers
echo "[PlaneKey] Checking SPDX compliance..."

node -e "
const fs = require('fs');
const path = require('path');
const files = require('child_process')
  .spawnSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' })
  .stdout.trim()
  .split('\n');

let missingHeaders = 0;
for (const file of files) {
  if (!file || file.startsWith('tests/') || file.startsWith('docs/')) continue;
  if (!/\.(ts|js|py|rs)$/.test(file)) continue;

  const content = fs.readFileSync(file, 'utf8');
  if (!content.includes('SPDX-License-Identifier')) {
    console.log(\`  ⚠️ Missing SPDX header: \${file}\`);
    missingHeaders++;
  }
}

if (missingHeaders > 0) {
  console.log(\`\n  Found \${missingHeaders} files without SPDX headers\`);
  console.log('  Run: planekey add-spdx-headers');
  process.exit(1);
}

console.log('  ✓ All files have SPDX headers');
"

exit \$?
\`;

  fs.writeFileSync(hookPath, hookScript);
  fs.chmodSync(hookPath, 0o755);

  console.log('[PlaneKey] Installed pre-commit hook');
}

// ============================================================================
// GIT HOOK: Pre-merge (License Check)
// ============================================================================

async function installPreMergeHook(projectRoot: string): Promise<void> {
  const hooksDir = path.join(projectRoot, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = path.join(hooksDir, 'pre-merge-commit');

  const hookScript = \`#!/bin/bash
# PlaneKey: License compliance pre-merge hook

PROJECT_ROOT="\$(git rev-parse --show-toplevel)"
cd "\$PROJECT_ROOT"

echo "[PlaneKey] Checking license compatibility before merge..."

UPSTREAM_REPO=\$(git config --get remote.upstream.url)
if [ -z "\$UPSTREAM_REPO" ]; then
  exit 0
fi

# Run license checks via node
node -e "
const compliance = require('./.planekey/scripts/check-merge-license.js');
const result = compliance.checkMergeLicense(process.cwd());

if (!result.canMerge) {
  console.log('\n❌ MERGE BLOCKED: License incompatibility');
  result.blocks.forEach(b => console.log('  ' + b));
  process.exit(1);
}

console.log('\n✓ License check passed');
result.warnings.forEach(w => console.log('  ⚠️ ' + w));
"

exit \$?
\`;

  fs.writeFileSync(hookPath, hookScript);
  fs.chmodSync(hookPath, 0o755);

  console.log('[PlaneKey] Installed pre-merge hook');
}

// ============================================================================
// COMMAND: Add SPDX Headers to All Files
// ============================================================================

async function addSPDXHeadersCommand(
  projectRoot: string,
  license: string,
  author: string,
  year: string
): Promise<void> {
  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) {
    vscode.window.showErrorMessage('src/ directory not found');
    return;
  }

  const extensions = ['.ts', '.js', '.py', '.rs', '.sh'];
  let updated = 0;

  function walkDir(dir: string) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walkDir(fullPath);
      } else if (extensions.some(ext => file.endsWith(ext))) {
        const content = fs.readFileSync(fullPath, 'utf8');

        if (!content.includes('SPDX-License-Identifier')) {
          const language = file.endsWith('.ts') ? 'typescript'
            : file.endsWith('.py') ? 'python'
            : file.endsWith('.rs') ? 'rust'
            : 'bash';

          const header = generateFileHeader(license as any, language, author, year);
          const newContent = header + '\n\n' + content;

          fs.writeFileSync(fullPath, newContent);
          updated++;
        }
      }
    }
  }

  walkDir(srcDir);

  vscode.window.showInformationMessage(
    \`✓ Added SPDX headers to \${updated} files\`,
    { modal: false }
  );
}

// ============================================================================
// COMMAND: Generate Compliance Report
// ============================================================================

async function generateComplianceReportCommand(projectRoot: string): Promise<void> {
  const reportPath = path.join(projectRoot, 'COMPLIANCE_REPORT.md');

  const yourLicense = (await detectLicense(projectRoot))[0];
  const compliance = await checkComplianceStatus(projectRoot, '', 'Unknown');

  const report = [
    '# Compliance Report',
    \`Generated: \${new Date().toISOString()}\`,
    '',
    '## Project License',
    \`License: \${yourLicense?.license || 'Unknown'}\`,
    \`Detected from: \${yourLicense?.file}\`,
    \`Confidence: \${((yourLicense?.confidence || 0) * 100).toFixed(0)}%\`,
    '',
    '## Compliance Issues',
    compliance.issues.length === 0 ? '✓ No issues' : '',
    ...compliance.issues.map(i => \`- [\${i.severity.toUpperCase()}] \${i.message}\`),
    '',
    '## Warnings',
    compliance.warnings.length === 0 ? '✓ No warnings' : '',
    ...compliance.warnings.map(w => \`- ⚠️ \${w.message}\`),
    '',
    '## Recommendations',
    ...compliance.recommendations.map(r => \`- \${r}\`),
  ].filter(x => x || x === '').join('\n');

  fs.writeFileSync(reportPath, report);

  vscode.window.showInformationMessage(
    \`✓ Compliance report generated: COMPLIANCE_REPORT.md\`,
    { modal: false }
  );
}

// ============================================================================
// COMMAND: Show Fork Merge Summary
// ============================================================================

async function showForkMergeSummaryCommand(projectRoot: string): Promise<void> {
  const gitCtx = await detectGitContext(projectRoot);
  if (!gitCtx?.isForked) {
    vscode.window.showWarningMessage('Not a forked repository');
    return;
  }

  const result = await runPreMergeChecks(projectRoot, gitCtx.upstreamUrl || '', 'main');

  const html = \`
    <h2>Merge Check: Upstream → Your Fork</h2>
    
    <div style="padding: 10px; background: \${result.canMerge ? '#d4edda' : '#f8d7da'}; border-radius: 4px;">
      <h3>\${result.canMerge ? '✓ Safe to Merge' : '❌ Merge Blocked'}</h3>
    </div>

    \${result.blocks.length > 0 ? \`
      <h4>Blocking Issues:</h4>
      <ul>
        \${result.blocks.map(b => \`<li>\${b}</li>\`).join('')}
      </ul>
    \` : ''}

    \${result.warnings.length > 0 ? \`
      <h4>Warnings:</h4>
      <ul>
        \${result.warnings.map(w => \`<li>\${w}</li>\`).join('')}
      </ul>
    \` : ''}

    \${result.actions.length > 0 ? \`
      <h4>Actions Required:</h4>
      <ol>
        \${result.actions.map(a => \`<li>\${a}</li>\`).join('')}
      </ol>
    \` : ''}
  \`;

  const panel = vscode.window.createWebviewPanel(
    'planekey.mergeSummary',
    'Merge Compliance Check',
    vscode.ViewColumn.Two
  );

  panel.webview.html = html;
}

// ============================================================================
// GENERATED FILES: Auto-Create License Structure
// ============================================================================

async function initializeLicenseStructure(
  projectRoot: string,
  license: string,
  author: string
): Promise<void> {
  // Create LICENSES/ directory
  const licensesDir = path.join(projectRoot, 'LICENSES');
  fs.mkdirSync(licensesDir, { recursive: true });

  // Create main LICENSE file
  const licenseText = getLicenseText(license as any, author, new Date().getFullYear().toString());
  fs.writeFileSync(path.join(projectRoot, 'LICENSE'), licenseText);

  // Create ATTRIBUTION.md template
  const attributionTemplate = \`# Attribution

This project includes code from various sources. See below for details.

## Direct Contributions

- Original Authors: [List here]

## Merged/Incorporated Code

[Attribution entries will be added automatically when merging upstream code]

## Dependencies

See package.json, requirements.txt, Cargo.toml for dependency licenses.
\`;

  fs.writeFileSync(path.join(projectRoot, 'ATTRIBUTION.md'), attributionTemplate);

  // Create NOTICE template (if applicable)
  const noticeTemplate = \`NOTICE

This product includes software developed by:
[Original authors/organizations]

[Additional notices]
\`;

  fs.writeFileSync(path.join(projectRoot, 'NOTICE'), noticeTemplate);

  console.log('[PlaneKey] License structure initialized');
}

function getLicenseText(license: string, author: string, year: string): string {
  const templates: { [key: string]: string } = {
    'MIT': \`MIT License

Copyright (c) \${year} \${author}

Permission is hereby granted, free of charge, to any person obtaining a copy...
[Full MIT text]\`,
    'Apache-2.0': \`Apache License
Version 2.0, January 2004

Copyright [yyyy] \${author}

Licensed under the Apache License, Version 2.0...
[Full Apache text]\`,
    'GPL-3.0': \`GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007

Copyright (c) \${year} \${author}

[Full GPL text]\`
  };

  return templates[license] || \`License: \${license}\nCopyright (c) \${year} \${author}\`;
}

// ============================================================================
// EXPORT
// ============================================================================

export {
  runPreMergeChecks,
  installPreCommitHook,
  installPreMergeHook,
  addSPDXHeadersCommand,
  generateComplianceReportCommand,
  showForkMergeSummaryCommand,
  initializeLicenseStructure,
  MergeCheckResult
};
