#!/usr/bin/env node
// Internal repo rename engine for the IIS -> IaP migration (Phase 19, M19.0.3-0.6).
// Applies ORDERED, EXACT replacements (never a blind "iis"->"iap" global) and
// renames known project artifact files. NOT the user-facing `iap migrate-name`
// command (that lives in the CLI, M19.0.7) — this migrates THIS repo once.
//
// Usage:
//   node tools/rename-iis-to-iap.mjs --dry-run   # report only, no writes
//   node tools/rename-iis-to-iap.mjs --write      # apply
//
// Safety: operates only on an allowlisted set of roots, skips binaries,
// generated output, lockfiles, and files that intentionally retain the old
// name (historical docs + the migration inventory deliverables).

import { readFileSync, writeFileSync, renameSync, statSync, readdirSync } from 'node:fs';
import { join, basename, extname, relative } from 'node:path';

const ROOT = process.cwd();
const WRITE = process.argv.includes('--write');
const DRY = !WRITE;

// Roots to walk for content replacement.
const ROOTS = ['packages', 'providers', 'spec', 'docs', 'tools', 'tests', '.github'];
// Individual root-level files to process.
const ROOT_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'README.md',
  'GOVERNANCE.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'tsconfig.base.json',
  'vitest.config.ts',
  'eslint.config.mjs',
  '.editorconfig',
  '.prettierignore',
  '.prettierrc.json',
  '.gitignore',
];

// Files/dirs excluded from ALL processing.
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo']);
// Files that intentionally retain the legacy name (historical / inventory / plan
// docs, and the subagent-authored migration docs that carry curated before/after
// text). These are allowlisted and must NOT be mechanically rewritten.
const EXCLUDE_FILES = new Set([
  'roadmap',
  'roadmap-v2',
  'ROADMAP.yaml',
  'ROADMAP-V2.yml',
  'CHANGELOG.md',
  'docs/reports/iis-to-iap-inventory.md',
  'docs/migrations/iis-to-iap-map.yaml',
  'docs/migrations/iis-to-iap-allowlist.yaml',
  'docs/migrations/iis-to-iap.md',
  'docs/adr/ADR-0003-iap-naming-migration.md',
  'spec/ieps/IEP-0014-iap-naming-migration.md',
  'tools/rename-iis-to-iap.mjs',
]);
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
  '.lock',
]);
const SKIP_NAME = /pnpm-lock\.yaml$|\.tsbuildinfo$|\.log$/;
// Known text source extensions: always processed even if they contain a raw NUL
// byte (some canonicalization code uses '\0' as a hash-field join separator).
const TEXT_EXT = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.txt',
  '.html',
  '.css',
  '.svg',
]);

// ORDERED replacement rules + applyRules live in the shared module so the
// safety tests (tests/rename-safety.test.ts) exercise the SAME logic.
import { applyRules } from './rename-rules.mjs';

// File renames (path relative to ROOT). Applied after content pass.
function collectFileRenames(allFiles) {
  const renames = [];
  for (const f of allFiles) {
    const b = basename(f);
    let nb = null;
    if (b === 'iis-v1.schema.json') nb = 'iap-v1.schema.json';
    else if (b === 'iis-mapping-v1.schema.json') nb = 'iap-mapping-v1.schema.json';
    else if (b.endsWith('.iis-map.yaml')) nb = b.replace('.iis-map.yaml', '.iap-map.yaml');
    else if (b.endsWith('.iis-map.yml')) nb = b.replace('.iis-map.yml', '.iap-map.yml');
    else if (b.endsWith('.iis.yaml')) nb = b.replace('.iis.yaml', '.iap.yaml');
    else if (b.endsWith('.iis.yml')) nb = b.replace('.iis.yml', '.iap.yml');
    if (nb) renames.push([f, f.slice(0, f.length - b.length) + nb]);
  }
  return renames;
}

function isExcludedFile(rel) {
  if (EXCLUDE_FILES.has(rel)) return true;
  if (SKIP_NAME.test(rel)) return true;
  if (BINARY_EXT.has(extname(rel).toLowerCase())) return true;
  return false;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
}

// --- gather files ---
const files = [];
for (const r of ROOTS) {
  try {
    if (statSync(join(ROOT, r)).isDirectory()) walk(join(ROOT, r), files);
  } catch {
    /* missing root */
  }
}
for (const f of ROOT_FILES) {
  try {
    if (statSync(join(ROOT, f)).isFile()) files.push(join(ROOT, f));
  } catch {
    /* missing */
  }
}

let changedCount = 0,
  byteDelta = 0;
const changedFiles = [];
for (const abs of files) {
  const rel = relative(ROOT, abs);
  if (isExcludedFile(rel)) continue;
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  // Binary guard: skip only NON-text files that contain a NUL byte. Text source
  // (.ts/.js/.json/.yaml/.md/...) is always processed.
  if (!TEXT_EXT.has(extname(rel).toLowerCase()) && text.includes('\x00')) continue;
  const next = applyRules(text);
  if (next !== text) {
    changedCount++;
    byteDelta += next.length - text.length;
    changedFiles.push(rel);
    if (WRITE) writeFileSync(abs, next);
  }
}

// --- file renames ---
const renames = collectFileRenames(files.map((f) => relative(ROOT, f)));
for (const [from, to] of renames) {
  if (WRITE) renameSync(join(ROOT, from), join(ROOT, to));
}

console.log(`mode: ${DRY ? 'DRY-RUN (no writes)' : 'WRITE'}`);
console.log(`files scanned: ${files.length}`);
console.log(`content-changed files: ${changedCount} (byteDelta ${byteDelta})`);
console.log(`file renames: ${renames.length}`);
if (DRY) {
  console.log('\n--- content-changed (first 40) ---');
  console.log(changedFiles.slice(0, 40).join('\n'));
  console.log('\n--- renames (first 60) ---');
  console.log(
    renames
      .slice(0, 60)
      .map(([a, b]) => `${a}  ->  ${b}`)
      .join('\n'),
  );
}
