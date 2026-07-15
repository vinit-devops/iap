#!/usr/bin/env node
// Secret scanner (Phase 19, M19.6). Token-scoped scan of the working tree for
// committed secret material. Fails (exit 1) on any finding NOT covered by the
// allowlist. The only permitted key material is the ed25519 TEST keys used by
// the provider-signing tests (named `*-test-*` / `test-only`) — enumerated
// below. Real credentials must never be committed.
//
// Usage: node tools/security/scan-secrets.mjs [--json]

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'dist-pkg']);
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.wasm',
  '.vsix',
]);

// Allowlisted TEST key files (intentional, non-production, used by signing tests).
const ALLOW_TEST_KEYS = new Set([
  'providers/mock/keys/mock-test-2026.private.pem',
  'providers/mock/keys/mock-test-2026.public.pem',
  'providers/aws/keys/aws-test-2026.private.pem',
  'providers/aws/keys/aws-test-2026.public.pem',
  'providers/kubernetes/keys/kubernetes-test-2026.private.pem',
  'providers/kubernetes/keys/kubernetes-test-2026.public.pem',
  'packages/provider-sdk/test/fixtures/keys/test-only.private.pem',
  'packages/provider-sdk/test/fixtures/keys/test-only.public.pem',
]);
// This scanner + docs necessarily contain the pattern strings as literals.
const ALLOW_FILES = new Set(['tools/security/scan-secrets.mjs']);

// Reviewed baseline: findings CONFIRMED (M19.6 audit) to be non-secrets — either
// deliberate fake fixtures that test IaP's own secret-detection, or regex false
// positives on namespaced identifiers. Keyed by "file:kind". Re-review if the
// underlying value changes.
const ALLOW_HITS = new Map([
  [
    'packages/ai-review/test/ai-review.test.ts:github-token',
    'Fake sequential ghp_ token — fixture verifying the review flags embedded secrets.',
  ],
  [
    'packages/planner/test/plan.test.ts:inline-credential',
    'Literal "S3CR3T-raw-material-never-in-plan" — fixture asserting the planner never embeds secrets.',
  ],
  [
    'packages/security/test/security.test.ts:aws-access-key-id',
    "AWS's published example key AKIAIOSFODNN7EXAMPLE — fixture for the security engine's IAP602 secret scan.",
  ],
  [
    'providers/kubernetes/src/index.ts:inline-credential',
    'False positive: "secret: kubernetes:core:Secret" is a target-type identifier, not a credential.',
  ],
  [
    'providers/mock/test/lifecycle.test.ts:inline-credential',
    'False positive: "token: api-token.mock:core:SecretBox" is a resource id, not a credential.',
  ],
  [
    'packages/state/test/file.test.ts:inline-credential',
    'Fake constant "SUPER-SECRET-ATTR-VALUE-…" — fixture asserting FileStateBackend at-rest encryption keeps plaintext OUT of the on-disk bytes.',
  ],
]);

const PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'private-key-block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'aws-access-key-id'],
  [/\bASIA[0-9A-Z]{16}\b/, 'aws-temp-access-key-id'],
  [/\bghp_[A-Za-z0-9]{36}\b/, 'github-token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'slack-token'],
  [
    /\b(?:secret|password|passwd|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    'inline-credential',
  ],
];

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (e.isFile()) out.push(join(dir, e.name));
  }
}

const files = [];
walk(repoRoot, files);
const findings = [];
const allowedTestKeyHits = [];

for (const abs of files) {
  const rel = relative(repoRoot, abs);
  if (BINARY_EXT.has(extname(rel).toLowerCase())) continue;
  if (ALLOW_FILES.has(rel)) continue;
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const [re, kind] of PATTERNS) {
      if (re.test(lines[i])) {
        const hit = { file: rel, line: i + 1, kind };
        if (kind === 'private-key-block' && ALLOW_TEST_KEYS.has(rel)) allowedTestKeyHits.push(hit);
        else if (ALLOW_HITS.has(`${rel}:${kind}`))
          allowedTestKeyHits.push({ ...hit, reason: ALLOW_HITS.get(`${rel}:${kind}`) });
        else findings.push(hit);
        break;
      }
    }
  }
}

const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify({ ok: findings.length === 0, findings, allowedTestKeyHits }, null, 2));
} else if (findings.length === 0) {
  console.log(
    `scan-secrets: OK — no unallowlisted secrets. (${allowedTestKeyHits.length} allowlisted TEST key files: provider-signing fixtures, non-production.)`,
  );
} else {
  console.error(`scan-secrets: ${findings.length} POTENTIAL SECRET(S) found:`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.kind}]`);
  console.error(
    '\nRemove the secret, or (if it is intentional test material) add it to the allowlist in tools/security/scan-secrets.mjs.',
  );
}
process.exit(findings.length === 0 ? 0 : 1);
