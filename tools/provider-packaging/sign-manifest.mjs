#!/usr/bin/env node
/**
 * Provider package signing helper (IEP-0012; phase-6 design decision 2).
 *
 * Given a package directory and an ed25519 private key, recomputes every
 * artifact digest (`sha256:<hex>` over exact file bytes), fills
 * `integrity.digests`, signs the canonical signing form, and rewrites
 * manifest.json in place. Uses the built @iap/provider-sdk so the canonical
 * signing form has exactly one implementation — run `pnpm build` first.
 *
 * Usage:
 *   node tools/provider-packaging/sign-manifest.mjs <packageDir> --key <private.pem> --key-id <id>
 *   node tools/provider-packaging/sign-manifest.mjs --generate-key <outDir> [--prefix <name>]
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fail(message) {
  console.error(`sign-manifest: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--generate-key') args.generateKey = argv[(i += 1)];
    else if (arg === '--prefix') args.prefix = argv[(i += 1)];
    else if (arg === '--key') args.key = argv[(i += 1)];
    else if (arg === '--key-id') args.keyId = argv[(i += 1)];
    else if (arg.startsWith('--')) fail(`unknown option ${arg}`);
    else args.positional.push(arg);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.generateKey !== undefined) {
  const outDir = args.generateKey;
  const prefix = args.prefix ?? 'signing';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(outDir, { recursive: true });
  const privatePath = join(outDir, `${prefix}.private.pem`);
  const publicPath = join(outDir, `${prefix}.public.pem`);
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`wrote ${privatePath}`);
  console.log(`wrote ${publicPath}`);
  process.exit(0);
}

const [packageDir] = args.positional;
if (!packageDir) fail('usage: sign-manifest.mjs <packageDir> --key <private.pem> --key-id <id>');
if (!args.key || !args.keyId) fail('--key <private.pem> and --key-id <id> are required');

const sdk = await import(
  pathToFileURL(join(repoRoot, 'packages/provider-sdk/dist/index.js')).href
).catch(() => fail('@iap/provider-sdk build artifact not found — run `pnpm build` first'));
const { computeArtifactDigest, signManifest, validateManifest } = sdk;

const manifestPath = join(packageDir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/** All files under a directory as sorted package-relative paths. */
function walkFiles(absolute, relative, out) {
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (entry.isDirectory())
      walkFiles(join(absolute, entry.name), `${relative}${entry.name}/`, out);
    else if (entry.isFile()) out.push(`${relative}${entry.name}`);
  }
}

const referenced = [
  ...(manifest.artifacts?.mappings ?? []),
  ...(manifest.artifacts?.extensionSchema ? [manifest.artifacts.extensionSchema] : []),
  ...(manifest.artifacts?.conformanceCases ? [manifest.artifacts.conformanceCases] : []),
  ...(manifest.artifacts?.icons ? [manifest.artifacts.icons] : []),
  ...(manifest.artifacts?.docs ? [manifest.artifacts.docs] : []),
  ...(manifest.attestations ? [manifest.attestations] : []),
];

const files = new Set();
for (const path of referenced) {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const absolute = join(packageDir, trimmed);
  if (statSync(absolute).isDirectory()) {
    const collected = [];
    walkFiles(absolute, `${trimmed}/`, collected);
    for (const file of collected) files.add(file);
  } else {
    files.add(trimmed);
  }
}

const digests = {};
for (const file of [...files].sort()) {
  digests[file] = computeArtifactDigest(readFileSync(join(packageDir, file)));
}
manifest.integrity = { ...(manifest.integrity ?? {}), digests };

const signed = signManifest(manifest, readFileSync(args.key, 'utf8'), args.keyId);
const validation = validateManifest(signed);
if (!validation.ok) {
  fail(`signed manifest does not validate:\n  ${validation.errors.join('\n  ')}`);
}
writeFileSync(manifestPath, `${JSON.stringify(signed, null, 2)}\n`);
console.log(
  `signed ${manifestPath} (${Object.keys(digests).length} artifact digests, keyId ${args.keyId})`,
);
