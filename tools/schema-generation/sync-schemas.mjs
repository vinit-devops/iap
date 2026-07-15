#!/usr/bin/env node
/**
 * Copies the normative JSON Schemas from spec/schema/ into the embedded
 * schemas directories of the packages that ship them. The spec copy is the
 * single source of truth (ADR-0002); the embedded copies exist so the
 * published packages are self-contained. Package tests assert byte-equality
 * so the copies can never drift silently.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const src = join(repoRoot, 'spec', 'schema');

const targets = [
  {
    dest: join(repoRoot, 'packages', 'model', 'schemas'),
    files: ['iap-v1.schema.json', 'iap-mapping-v1.schema.json'],
  },
  {
    dest: join(repoRoot, 'packages', 'provider-sdk', 'schemas'),
    files: ['plugin-manifest-v1.schema.json', 'conformance-case-v1.schema.json'],
  },
  {
    dest: join(repoRoot, 'packages', 'planner', 'schemas'),
    files: ['plan-v1.schema.json'],
  },
  {
    dest: join(repoRoot, 'packages', 'intent-compiler', 'schemas'),
    files: ['compiler-operations-v1.schema.json'],
  },
  {
    dest: join(repoRoot, 'packages', 'cost', 'schemas'),
    files: ['price-snapshot-v1.schema.json', 'cost-report-v1.schema.json'],
  },
];

for (const { dest, files } of targets) {
  mkdirSync(dest, { recursive: true });
  for (const file of files) {
    copyFileSync(join(src, file), join(dest, file));
  }
  console.log(`synced ${files.length} schemas -> ${dest}`);
}
