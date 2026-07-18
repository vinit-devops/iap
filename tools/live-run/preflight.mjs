#!/usr/bin/env node
/**
 * Live-run PRE-FLIGHT (docs/guides/live-run-runbook.md "Pre-flight"; ROADMAP-V4
 * M21.1). Verifies, before any wave touches AWS:
 *
 *   1. region is explicitly chosen (fail-closed, no default assumed)
 *   2. run id follows the `infraasprompt-<epoch>` scheme (generated when omitted)
 *   3. the AWS mapping's integrity digests match the files on disk
 *   4. the provider manifest's ed25519 signature verifies against its keys
 *   5. credentials resolve (STS get-caller-identity)
 *   6. a Budgets alarm exists on the account at or under the roadmap ceiling
 *
 * `--mock` runs the same sequence with canned clean AWS responses (steps 3-4
 * still verify the REAL local mapping artifacts) — zero credentials, zero
 * network. Usage:
 *
 *   node tools/live-run/preflight.mjs --region eu-west-1 [--aws-profile X]
 *        [--run-id infraasprompt-123] [--budget-ceiling 25] [--mock]
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { awsCli, fail, parseArgs, stepper } from './common.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = parseArgs(process.argv.slice(2), {
  region: 'value',
  'aws-profile': 'value',
  'run-id': 'value',
  'budget-ceiling': 'value',
  mock: 'flag',
});

const mock = args.mock === true;
const region = args.region ?? (mock ? 'mock-region-1' : undefined);
const profile = args['aws-profile'];
const ceiling = Number(args['budget-ceiling'] ?? '25');
const runId = args['run-id'] ?? `infraasprompt-${Math.floor(Date.now() / 1000)}`;

// One implementation of the canonical signing form: the built provider-sdk.
const { verifyManifestSignature } = await import(
  pathToFileURL(join(repoRoot, 'packages/provider-sdk/dist/index.js')).href
).catch(() => fail('@iap/provider-sdk build artifact not found — run `pnpm build` first'));

const providerDir = join(repoRoot, 'providers', 'aws');
const manifest = JSON.parse(readFileSync(join(providerDir, 'manifest.json'), 'utf8'));

const report = stepper(`live-run pre-flight${mock ? ' (MOCK)' : ''}: run ${runId}`);

report.step('region explicitly chosen (fail-closed)', () => {
  if (!region) throw new Error('pass --region; no default region is assumed');
  return region;
});

report.step('run id follows the infraasprompt-<epoch> scheme', () => {
  if (!/^infraasprompt-\d+$/.test(runId))
    throw new Error(`"${runId}" does not match ^infraasprompt-\\d+$`);
  return runId;
});

report.step('mapping integrity digests match files on disk', () => {
  const digests = manifest.integrity?.digests ?? {};
  const entries = Object.entries(digests);
  if (entries.length === 0) throw new Error('manifest carries no integrity digests');
  for (const [file, expected] of entries) {
    const actual = `sha256:${createHash('sha256')
      .update(readFileSync(join(providerDir, file)))
      .digest('hex')}`;
    if (actual !== expected) throw new Error(`digest mismatch for ${file}`);
  }
  return `${entries.length} artifacts`;
});

report.step('manifest ed25519 signature verifies against provider trust store', () => {
  const keysDir = join(providerDir, 'keys');
  const trustStore = {};
  for (const file of readdirSync(keysDir)) {
    if (file.endsWith('.public.pem')) {
      trustStore[file.replace('.public.pem', '')] = readFileSync(join(keysDir, file), 'utf8');
    }
  }
  const verification = verifyManifestSignature(manifest, trustStore);
  if (!verification.ok) throw new Error(verification.reason);
  return `keyId ${manifest.signature.keyId}`;
});

report.step('credentials resolve (STS get-caller-identity)', () => {
  const identity = awsCli(['sts', 'get-caller-identity'], {
    mock,
    mockResult: { Account: '000000000000', Arn: 'arn:aws:iam::000000000000:role/mock' },
    profile,
    region,
  });
  if (!identity?.Account) throw new Error('no caller identity returned');
  return mock ? 'mock identity' : 'account REDACTED';
});

report.step(`a budget alarm exists at or under the $${ceiling} ceiling`, () => {
  const identity = awsCli(['sts', 'get-caller-identity'], {
    mock,
    mockResult: { Account: '000000000000' },
    profile,
    region,
  });
  const budgets = awsCli(
    ['budgets', 'describe-budgets', '--account-id', identity.Account, '--max-results', '100'],
    {
      mock,
      mockResult: { Budgets: [{ BudgetName: 'mock-iap-live', BudgetLimit: { Amount: '25' } }] },
      profile,
      region,
    },
  );
  const found = (budgets?.Budgets ?? []).filter(
    (b) => Number(b.BudgetLimit?.Amount ?? Infinity) <= ceiling,
  );
  if (found.length === 0) {
    throw new Error(`no budget at or under $${ceiling} — create one before the first resource`);
  }
  return found.map((b) => b.BudgetName).join(', ');
});

report.finish();
