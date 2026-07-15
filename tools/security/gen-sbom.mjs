#!/usr/bin/env node
// SBOM generator (Phase 19, M19.6). Emits a CycloneDX 1.5 JSON SBOM for the IaP
// repository: every workspace component (packages/*, providers/*, apps/*,
// extensions/*) plus the resolved external runtime dependencies. Offline — reads
// package.json manifests + resolved versions from node_modules. Deterministic
// (sorted); no timestamps embedded (pass one in if you need it).
//
// Usage: node tools/security/gen-sbom.mjs   → writes docs/security/sbom.cdx.json

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const roots = ['packages', 'providers', 'apps', 'extensions'];

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function purl(name, version) {
  return `pkg:npm/${name.replace('@', '%40')}@${version}`;
}

// --- workspace components ---
const components = [];
const externalSpecs = new Map(); // name -> set of spec ranges (from dependencies)
for (const root of roots) {
  const dir = join(repoRoot, root);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const m = readJson(manifestPath);
    components.push({
      type: 'library',
      'bom-ref': m.name,
      name: m.name,
      version: m.version ?? '0.0.0',
      purl: purl(m.name, m.version ?? '0.0.0'),
      scope: 'required',
      properties: [{ name: 'iap:workspace-path', value: `${root}/${entry.name}` }],
    });
    for (const [dep, range] of Object.entries(m.dependencies ?? {})) {
      if (dep.startsWith('@iap/')) continue; // internal — already a component
      if (!externalSpecs.has(dep)) externalSpecs.set(dep, new Set());
      externalSpecs.get(dep).add(range);
    }
  }
}

// --- external runtime dependencies (resolved version from node_modules) ---
function resolvedVersion(name) {
  try {
    return readJson(join(repoRoot, 'node_modules', name, 'package.json')).version;
  } catch {
    return null;
  }
}
const externals = [];
for (const name of [...externalSpecs.keys()].sort()) {
  const resolved = resolvedVersion(name);
  externals.push({
    type: 'library',
    'bom-ref': name,
    name,
    version: resolved ?? [...externalSpecs.get(name)].join(' || '),
    purl: resolved ? purl(name, resolved) : undefined,
    scope: 'required',
    properties: [{ name: 'iap:specifier', value: [...externalSpecs.get(name)].sort().join(', ') }],
  });
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: 'iap',
      version: '0.1.0',
      description: 'Infrastructure as Prompt — Developer Preview v0.1',
    },
    properties: [
      {
        name: 'iap:sbom-scope',
        value: 'workspace components + runtime dependencies (dev/build tooling excluded)',
      },
      {
        name: 'iap:note',
        value: 'Deterministic; generate timestamp is intentionally omitted for reproducibility.',
      },
    ],
  },
  components: [...components, ...externals],
};

const outDir = join(repoRoot, 'docs', 'security');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'sbom.cdx.json');
writeFileSync(outPath, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(
  `gen-sbom: wrote ${outPath} (${components.length} workspace + ${externals.length} external components)`,
);
