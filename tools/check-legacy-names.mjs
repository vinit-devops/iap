#!/usr/bin/env node
// Allowlist gate for the IIS -> IaP rename (roadmap-v2 §2.3, M19.0.8 exit
// criterion). FAILS when a project-specific (Category A) legacy-name occurrence
// exists in a file that is NOT covered by docs/migrations/iis-to-iap-allowlist.yaml.
//
// It is intentionally token-scoped (never a blind case-insensitive s/iis/iap/):
// it looks for the exact project patterns the inventory enumerated. Category B
// (legacy-compat code), C (external Microsoft IIS), D (incidental), and E
// (generated) occurrences are permitted ONLY when their file is allowlisted.
//
// Usage:  node tools/check-legacy-names.mjs [--json]
// Exit:   0 = clean (every legacy occurrence is allowlisted); 1 = violations.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { parse } from 'yaml';

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes('--json');

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo']);
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.wasm',
  '.node',
]);

// Project-specific legacy-name patterns (token-scoped). These are the SAME
// families the rename engine targeted; a hit means "unrenamed project name".
const PATTERNS = [
  /@iis\//,
  /iis\.dev/,
  /\biis_/,
  /\bIIS[1-8]/, // error codes / range refs
  /IIS\[/, // error-code regex char classes
  /\bIis[A-Z]/, // PascalCase types
  /\bIISSDK\b/,
  /\bIIS\b/, // standalone product name
  /\biis\b/, // standalone lowercase (CLI cmd, etc.)
  /IaP\[/, // mis-cased error-code regex (should be IAP[)
];

// Always-allowed infrastructure files (lockfiles, and this checker + engine
// which necessarily contain the patterns as string literals).
const ALWAYS_ALLOWED = new Set([
  'pnpm-lock.yaml',
  'tools/check-legacy-names.mjs',
  'tools/rename-iis-to-iap.mjs',
]);

function globToRegExp(glob) {
  // minimal glob: ** => any chars, * => any non-slash chars, escape the rest.
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

// Load the protected-occurrences allowlist -> list of file matchers.
const allowlistPath = 'docs/migrations/iis-to-iap-protected-occurrences.yaml';
const allowlist = parse(readFileSync(join(ROOT, allowlistPath), 'utf8'));
const allowMatchers = [];
for (const entry of allowlist.allow ?? []) {
  const f = entry.file;
  if (typeof f !== 'string') continue;
  // placeholder entries like "(to-be-created ...)" are not real paths; skip.
  if (f.startsWith('(')) continue;
  allowMatchers.push(f.includes('*') ? globToRegExp(f) : f);
}
// Migration deliverables + historical/plan docs inherently contain the legacy
// name; ensure they are covered even if not self-listed.
for (const p of [
  allowlistPath,
  'docs/migrations/iis-to-iap-hard-rename-map.yaml',
  'docs/reports/iis-to-iap-hard-rename-inventory.md',
  'docs/migrations/iis-to-iap.md',
  'docs/adr/ADR-0003-iap-naming-migration.md',
  'spec/ieps/IEP-0014-iap-naming-migration.md',
  // superseded interim stubs (rm blocked; kept as pointers to the hard-rename docs)
  'docs/migrations/iis-to-iap-map.yaml',
  'docs/migrations/iis-to-iap-allowlist.yaml',
  'docs/reports/iis-to-iap-inventory.md',
  'roadmap',
  'roadmap-v2',
  'ROADMAP.yaml',
  'ROADMAP-V2.yml',
  'CHANGELOG.md',
])
  allowMatchers.push(p);

function isAllowed(rel) {
  if (ALWAYS_ALLOWED.has(rel)) return true;
  for (const m of allowMatchers) {
    if (typeof m === 'string') {
      if (m === rel) return true;
    } else if (m.test(rel)) return true;
  }
  return false;
}

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (e.isFile()) out.push(join(dir, e.name));
  }
}

const files = [];
walk(ROOT, files);

const violations = [];
for (const abs of files) {
  const rel = relative(ROOT, abs);
  if (BINARY_EXT.has(extname(rel).toLowerCase())) continue;
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const p of PATTERNS) {
      if (p.test(lines[i])) {
        hits.push({ line: i + 1, text: lines[i].trim().slice(0, 120) });
        break;
      }
    }
  }
  if (hits.length > 0 && !isAllowed(rel)) {
    violations.push({ file: rel, count: hits.length, first: hits[0] });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2));
} else if (violations.length === 0) {
  console.log('check-legacy-names: OK — every legacy IIS occurrence is allowlisted.');
} else {
  console.error(`check-legacy-names: ${violations.length} file(s) with UNCLASSIFIED legacy names:`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.first.line}  (${v.count} hit(s))  ${v.first.text}`);
  }
  console.error('\nEither rename these project-specific occurrences, or add them to');
  console.error(`${allowlistPath} with a category + reason.`);
}

process.exit(violations.length === 0 ? 0 : 1);
