// =============================================================================
// planekey-licensing-compliance.ts
// License detection, compliance checking, attribution tracking
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ============================================================================
// LICENSE DETECTION
// ============================================================================

type LicenseType = 
  | 'MIT' | 'Apache-2.0' | 'GPL-2.0' | 'GPL-3.0' | 'AGPL-3.0'
  | 'BSD-2-Clause' | 'BSD-3-Clause' | 'ISC' | 'MPL-2.0'
  | 'LGPL-2.1' | 'LGPL-3.0' | 'Unlicense' | 'CC0-1.0'
  | 'Proprietary' | 'Commercial' | 'Unknown';

type CopyleftType = 'strong' | 'weak' | 'permissive' | 'proprietary';

interface LicenseInfo {
  type: LicenseType;
  copyleft: CopyleftType;
  requireAttribution: boolean;
  requireCopy: boolean;
  requireNotice: boolean;
  allowCommercial: boolean;
  allowModification: boolean;
  allowDistribution: boolean;
  requireDisclose: boolean;
  reciprocal: boolean;
  compatibleLicenses: LicenseType[];
  spdxId: string;
}

const LICENSE_DATABASE: { [key: string]: LicenseInfo } = {
  'MIT': {
    type: 'MIT',
    copyleft: 'permissive',
    requireAttribution: true,
    requireCopy: true,
    requireNotice: true,
    allowCommercial: true,
    allowModification: true,
    allowDistribution: true,
    requireDisclose: false,
    reciprocal: false,
    compatibleLicenses: ['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause'],
    spdxId: 'MIT'
  },
  'Apache-2.0': {
    type: 'Apache-2.0',
    copyleft: 'permissive',
    requireAttribution: true,
    requireCopy: true,
    requireNotice: true,
    allowCommercial: true,
    allowModification: true,
    allowDistribution: true,
    requireDisclose: false,
    reciprocal: false,
    compatibleLicenses: ['Apache-2.0', 'MIT', 'ISC'],
    spdxId: 'Apache-2.0'
  },
  'GPL-3.0': {
    type: 'GPL-3.0',
    copyleft: 'strong',
    requireAttribution: true,
    requireCopy: true,
    requireNotice: true,
    allowCommercial: true,
    allowModification: true,
    allowDistribution: true,
    requireDisclose: true,
    reciprocal: true,
    compatibleLicenses: ['GPL-3.0', 'AGPL-3.0'],
    spdxId: 'GPL-3.0-or-later'
  },
  'AGPL-3.0': {
    type: 'AGPL-3.0',
    copyleft: 'strong',
    requireAttribution: true,
    requireCopy: true,
    requireNotice: true,
    allowCommercial: true,
    allowModification: true,
    allowDistribution: true,
    requireDisclose: true,
    reciprocal: true,
    compatibleLicenses: ['AGPL-3.0', 'GPL-3.0'],
    spdxId: 'AGPL-3.0-or-later'
  },
  'Proprietary': {
    type: 'Proprietary',
    copyleft: 'proprietary',
    requireAttribution: true,
    requireCopy: true,
    requireNotice: true,
    allowCommercial: false,
    allowModification: false,
    allowDistribution: false,
    requireDisclose: false,
    reciprocal: false,
    compatibleLicenses: [],
    spdxId: 'Proprietary'
  }
};

interface DetectedLicense {
  file: string;
  license: LicenseType;
  confidence: number; // 0-1
  method: 'package.json' | 'LICENSE_FILE' | 'header' | 'SPDX_TAG';
  text?: string;
  author?: string;
  year?: string;
}

async function detectLicense(repoPath: string): Promise<DetectedLicense[]> {
  const detected: DetectedLicense[] = [];

  // Method 1: Check package.json
  const packageJsonPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (pkg.license) {
        detected.push({
          file: 'package.json',
          license: (pkg.license as LicenseType) || 'Unknown',
          confidence: 0.95,
          method: 'package.json',
          author: pkg.author
        });
      }
    } catch { }
  }

  // Method 2: Check LICENSE file
  const licensePatterns = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE'];
  for (const pattern of licensePatterns) {
    const licensePath = path.join(repoPath, pattern);
    if (fs.existsSync(licensePath)) {
      const text = fs.readFileSync(licensePath, 'utf8');
      const license = inferLicenseFromText(text);
      detected.push({
        file: pattern,
        license,
        confidence: 0.85,
        method: 'LICENSE_FILE',
        text: text.substring(0, 200)
      });
    }
  }

  // Method 3: Check source file headers
  const srcPath = path.join(repoPath, 'src');
  if (fs.existsSync(srcPath)) {
    const files = fs.readdirSync(srcPath);
    for (const file of files.slice(0, 3)) {
      const filePath = path.join(srcPath, file);
      if (fs.lstatSync(filePath).isFile()) {
        const content = fs.readFileSync(filePath, 'utf8');
        const license = extractLicenseHeader(content);
        if (license) {
          detected.push({
            file: \`src/\${file}\`,
            license,
            confidence: 0.75,
            method: 'header'
          });
        }
      }
    }
  }

  // Method 4: Check pyproject.toml, Cargo.toml, etc.
  const configFiles = [
    { path: 'pyproject.toml', key: 'project.license' },
    { path: 'Cargo.toml', key: 'package.license' }
  ];
  
  for (const cfg of configFiles) {
    const cfgPath = path.join(repoPath, cfg.path);
    if (fs.existsSync(cfgPath)) {
      const content = fs.readFileSync(cfgPath, 'utf8');
      const match = content.match(/license\s*=\s*["']([^"']+)["']/);
      if (match) {
        detected.push({
          file: cfg.path,
          license: (match[1] as LicenseType) || 'Unknown',
          confidence: 0.90,
          method: 'SPDX_TAG'
        });
      }
    }
  }

  return detected;
}

function inferLicenseFromText(text: string): LicenseType {
  const upper = text.toUpperCase();
  
  if (upper.includes('MIT LICENSE')) return 'MIT';
  if (upper.includes('APACHE') && upper.includes('2.0')) return 'Apache-2.0';
  if (upper.includes('GNU GENERAL PUBLIC LICENSE') && upper.includes('VERSION 3')) return 'GPL-3.0';
  if (upper.includes('GNU GENERAL PUBLIC LICENSE') && upper.includes('VERSION 2')) return 'GPL-2.0';
  if (upper.includes('AFFERO')) return 'AGPL-3.0';
  if (upper.includes('BSD')) return 'BSD-3-Clause';
  if (upper.includes('PROPRIETARY')) return 'Proprietary';
  
  return 'Unknown';
}

function extractLicenseHeader(content: string): LicenseType | null {
  const lines = content.split('\n').slice(0, 10);
  const header = lines.join(' ').toUpperCase();
  
  if (header.includes('MIT')) return 'MIT';
  if (header.includes('APACHE')) return 'Apache-2.0';
  if (header.includes('GPL')) return 'GPL-3.0';
  
  return null;
}

// ============================================================================
// LICENSE COMPATIBILITY CHECKING
// ============================================================================

interface CompatibilityResult {
  compatible: boolean;
  reason: string;
  restrictions: string[];
  recommendations: string[];
}

function checkLicenseCompatibility(
  yourLicense: LicenseType,
  upstreamLicense: LicenseType
): CompatibilityResult {
  const yourInfo = LICENSE_DATABASE[yourLicense];
  const upstreamInfo = LICENSE_DATABASE[upstreamLicense];

  if (!yourInfo || !upstreamInfo) {
    return {
      compatible: false,
      reason: 'Unknown license type',
      restrictions: ['Manual review required'],
      recommendations: ['Consult with legal team']
    };
  }

  const restrictions: string[] = [];
  const recommendations: string[] = [];

  // Strong copyleft to permissive: NOT compatible
  if (yourInfo.copyleft === 'permissive' && upstreamInfo.copyleft === 'strong') {
    return {
      compatible: false,
      reason: \`\${upstreamLicense}'s strong copyleft requirements conflict with \${yourLicense}'s permissive nature\`,
      restrictions: [
        'Cannot use GPL code in MIT licensed project',
        'Would require your entire project to be GPL'
      ],
      recommendations: [
        'Switch your license to GPL-3.0',
        'Don\'t merge upstream code',
        'Create separate GPL module with clear interface'
      ]
    };
  }

  // Permissive to strong copyleft: OK with restrictions
  if (yourInfo.copyleft === 'strong' && upstreamInfo.copyleft === 'permissive') {
    return {
      compatible: true,
      reason: 'Strong copyleft can incorporate permissive code',
      restrictions: [
        'Must include original copyright notice',
        'Must include original license file'
      ],
      recommendations: [
        'Add upstream license to NOTICES.txt',
        'Maintain attribution chain',
        'Update combined work license'
      ]
    };
  }

  // Proprietary check
  if (yourInfo.copyleft === 'proprietary' || upstreamInfo.copyleft === 'proprietary') {
    return {
      compatible: false,
      reason: 'Proprietary code incompatible with most open-source licenses',
      restrictions: [
        'Cannot use proprietary upstream in open-source project',
        'Cannot apply GPL to proprietary code'
      ],
      recommendations: [
        'Negotiate commercial license',
        'Obtain written permission',
        'Consider alternative implementation'
      ]
    };
  }

  // Check direct compatibility
  if (upstreamInfo.compatibleLicenses.includes(yourLicense)) {
    return {
      compatible: true,
      reason: \`\${upstreamLicense} is directly compatible with \${yourLicense}\`,
      restrictions: [
        'Must maintain copyright attribution',
        'Must include license copy'
      ],
      recommendations: [
        'Add upstream license to LICENSES/ directory',
        'Update ATTRIBUTION.md',
        'Tag merged commit with upstream info'
      ]
    };
  }

  // Same license
  if (yourLicense === upstreamLicense) {
    return {
      compatible: true,
      reason: 'Same license',
      restrictions: [],
      recommendations: [
        'Update copyright year if merging',
        'Update contributor list'
      ]
    };
  }

  return {
    compatible: false,
    reason: 'License combination unclear',
    restrictions: ['Manual compatibility review required'],
    recommendations: ['Consult SPDX license compatibility matrix']
  };
}

// ============================================================================
// ATTRIBUTION TRACKING
// ============================================================================

interface FileAttribution {
  file: string;
  contentHash: string;
  sourceRepo: string;
  sourceLicense: LicenseType;
  originalAuthor?: string;
  copyrightYear?: string;
  attribution: string;
  mergedAt: string;
  commitHash?: string;
}

interface AttributionRegistry {
  projectName: string;
  projectLicense: LicenseType;
  files: FileAttribution[];
  generatedAt: string;
  notices: string[];
}

async function buildAttributionRegistry(
  projectRoot: string,
  upstreamRepo: string,
  upstreamLicense: LicenseType
): Promise<AttributionRegistry> {
  const files: FileAttribution[] = [];
  const notices: string[] = [];

  const gitHash = require('child_process')
    .spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' })
    .stdout.trim();

  const mergedFiles = require('child_process')
    .spawnSync('git', ['diff', '--name-only', 'HEAD~1'], { cwd: projectRoot, encoding: 'utf8' })
    .stdout.trim()
    .split('\n')
    .filter(f => f);

  for (const file of mergedFiles) {
    const fullPath = path.join(projectRoot, file);
    if (!fs.existsSync(fullPath)) continue;

    const content = fs.readFileSync(fullPath, 'utf8');
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    files.push({
      file,
      contentHash,
      sourceRepo: upstreamRepo,
      sourceLicense: upstreamLicense,
      attribution: \`Merged from: \${upstreamRepo} (\${upstreamLicense})\`,
      mergedAt: new Date().toISOString(),
      commitHash: gitHash
    });
  }

  notices.push(\`This project includes code from \${upstreamRepo} licensed under \${upstreamLicense}\`);
  notices.push('See LICENSES/ directory for full license text');
  notices.push('See ATTRIBUTION.md for complete attribution chain');

  return {
    projectName: path.basename(projectRoot),
    projectLicense: (await detectLicense(projectRoot))[0]?.license || 'Unknown',
    files,
    generatedAt: new Date().toISOString(),
    notices
  };
}

async function generateAttributionMarkdown(registry: AttributionRegistry): Promise<string> {
  const md = [
    '# Attribution & License Compliance',
    '',
    \`Project: \${registry.projectName}\`,
    \`Project License: \${registry.projectLicense}\`,
    \`Generated: \${registry.generatedAt}\`,
    '',
    '## Included Works',
    ''
  ];

  // Group by source repo
  const byRepo = new Map<string, FileAttribution[]>();
  for (const file of registry.files) {
    const key = file.sourceRepo;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key)!.push(file);
  }

  for (const [repo, files] of byRepo) {
    md.push(\`### \${repo}\`,
      '',
      \`Files: \${files.length}\`,
      ''
    );

    for (const file of files.slice(0, 10)) {
      md.push(\`- \${file.file} (License: \${file.sourceLicense})\`);
    }

    if (files.length > 10) {
      md.push(\`- ... and \${files.length - 10} more files\`);
    }

    md.push('');
  }

  md.push('## License Notices', '');
  for (const notice of registry.notices) {
    md.push(\`- \${notice}\`);
  }

  return md.join('\n');
}

// ============================================================================
// COMPLIANCE CHECKING
// ============================================================================

interface ComplianceReport {
  compliant: boolean;
  issues: ComplianceIssue[];
  warnings: ComplianceWarning[];
  recommendations: string[];
}

interface ComplianceIssue {
  severity: 'error' | 'warning';
  file?: string;
  message: string;
  fix: string;
}

interface ComplianceWarning {
  file: string;
  message: string;
}

async function checkComplianceStatus(
  projectRoot: string,
  upstreamRepo: string,
  upstreamLicense: LicenseType
): Promise<ComplianceReport> {
  const issues: ComplianceIssue[] = [];
  const warnings: ComplianceWarning[] = [];
  const recommendations: string[] = [];

  // Check 1: Project has license file
  const hasLicense = ['LICENSE', 'LICENSE.txt', 'LICENSE.md']
    .some(f => fs.existsSync(path.join(projectRoot, f)));
  
  if (!hasLicense) {
    issues.push({
      severity: 'error',
      message: 'Project has no LICENSE file',
      fix: 'Create LICENSE file with project license text'
    });
  }

  // Check 2: Project has ATTRIBUTION.md
  const hasAttribution = fs.existsSync(path.join(projectRoot, 'ATTRIBUTION.md'));
  
  if (!hasAttribution) {
    issues.push({
      severity: 'warning',
      message: 'Project missing ATTRIBUTION.md for merged code',
      fix: 'Generate ATTRIBUTION.md with attribution registry'
    });
  }

  // Check 3: Project has LICENSES/ directory
  const hasLicensesDir = fs.existsSync(path.join(projectRoot, 'LICENSES'));
  
  if (!hasLicensesDir) {
    issues.push({
      severity: 'warning',
      message: 'Project missing LICENSES/ directory for included licenses',
      fix: 'Create LICENSES/ directory and include all upstream licenses'
    });
  }

  // Check 4: Check for NOTICE files in upstream
  const upstreamNotice = path.join(projectRoot, '.upstream-cache', 'NOTICE');
  if (fs.existsSync(upstreamNotice)) {
    const hasProjectNotice = fs.existsSync(path.join(projectRoot, 'NOTICE'));
    if (!hasProjectNotice) {
      warnings.push({
        file: 'NOTICE',
        message: 'Upstream has NOTICE file but project does not include it'
      });
      recommendations.push('Copy upstream NOTICE to project NOTICE');
    }
  }

  // Check 5: License compatibility
  const yourLicense = (await detectLicense(projectRoot))[0]?.license || 'Unknown';
  const compatibility = checkLicenseCompatibility(yourLicense, upstreamLicense);
  
  if (!compatibility.compatible) {
    issues.push({
      severity: 'error',
      message: compatibility.reason,
      fix: compatibility.recommendations[0] || 'Review license compatibility'
    });
  }

  // Check 6: Check for vendor/node_modules licenses
  const checkLicensesInDeps = async () => {
    const nodeModules = path.join(projectRoot, 'node_modules');
    if (fs.existsSync(nodeModules)) {
      const count = fs.readdirSync(nodeModules).length;
      recommendations.push(
        \`Review licenses of \${count} npm dependencies via 'npm ls --all'\`
      );
    }
  };
  await checkLicensesInDeps();

  const compliant = issues.filter(i => i.severity === 'error').length === 0;

  return {
    compliant,
    issues,
    warnings,
    recommendations: [
      ...recommendations,
      ...compatibility.recommendations,
      'Use SPDX license identifiers in package.json',
      'Include copyright year in LICENSE header',
      'Maintain clear attribution chain'
    ]
  };
}

// ============================================================================
// GENERATED LICENSE HEADERS
// ============================================================================

function generateFileHeader(
  license: LicenseType,
  language: 'typescript' | 'python' | 'rust' | 'bash',
  author: string,
  year: string
): string {
  const commentChar = {
    typescript: '//',
    python: '#',
    rust: '//',
    bash: '#'
  }[language];

  const spdxId = LICENSE_DATABASE[license]?.spdxId || license;

  const headers = {
    typescript: \`
\${commentChar} =============================================================================
\${commentChar} SPDX-License-Identifier: \${spdxId}
\${commentChar} Copyright (c) \${year} \${author}
\${commentChar} =============================================================================
\`,
    python: \`
\${commentChar} SPDX-License-Identifier: \${spdxId}
\${commentChar} Copyright (c) \${year} \${author}
\`,
    rust: \`
\${commentChar} SPDX-License-Identifier: \${spdxId}
\${commentChar} Copyright (c) \${year} \${author}
\`,
    bash: \`
\${commentChar} SPDX-License-Identifier: \${spdxId}
\${commentChar} Copyright (c) \${year} \${author}
\`
  };

  return headers[language] || '';
}

// ============================================================================
// EXPORT
// ============================================================================

export {
  detectLicense,
  checkLicenseCompatibility,
  buildAttributionRegistry,
  generateAttributionMarkdown,
  checkComplianceStatus,
  generateFileHeader,
  LicenseType,
  CopyleftType,
  LicenseInfo,
  DetectedLicense,
  CompatibilityResult,
  FileAttribution,
  AttributionRegistry,
  ComplianceReport
};
