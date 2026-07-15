/**
 * `iap deploy | destroy | drift | state` — Phase 19 (M19.3) execution lifecycle.
 *
 * SAFETY: every test here drives an INJECTED FAKE executor via
 * `setExecutorFactory`. The real `AwsExecutor` is NEVER constructed and NO AWS
 * SDK call is issued — the fake records what the CLI asked it to do (plan vs a
 * gated apply) so we can assert the live gate directly. State is written to a
 * throwaway temp directory.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ApplyReport, PlanReport } from '@iap/deploy-aws';
import type { ProviderPlan } from '@iap/provider-sdk';
import { run } from '../src/cli';
import {
  setExecutorFactory,
  type Executor,
  type ExecutorApplyOptions,
  type ExecutorPlanOptions,
} from '../src/commands/execution';

const repoRoot = join(__dirname, '..', '..', '..');
const BASIC = join(repoRoot, 'spec', 'examples', 'basic-webapp.iap.yaml');
const MOCK_PACKAGE = join(repoRoot, 'providers', 'mock');

interface Execution {
  code: number;
  stdout: string;
  stderr: string;
}

async function exec(argv: string[]): Promise<Execution> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    stdout: { write: (t: string) => void out.push(t) },
    stderr: { write: (t: string) => void err.push(t) },
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/**
 * A fake executor with the same `plan()` / `apply()` shape as `AwsExecutor`.
 * It records every call so the live gate can be asserted, and never performs a
 * real mutation. `unmanagedId` marks one logical id whose delete is refused
 * (mimicking the real managed-only guard).
 */
class FakeExecutor implements Executor {
  planCalls: ExecutorPlanOptions[] = [];
  applyCalls: ExecutorApplyOptions[] = [];
  /** True once apply() was invoked with the live gate open. */
  mutated = false;

  constructor(
    private readonly opts: {
      driftIds?: string[];
      unmanagedId?: string;
      region?: string;
    } = {},
  ) {}

  async plan(providerPlan: ProviderPlan, options: ExecutorPlanOptions = {}): Promise<PlanReport> {
    this.planCalls.push(options);
    const destroy = options.destroy === true;
    return {
      planId: providerPlan.planHash,
      region: this.opts.region ?? 'us-east-1',
      mode: 'plan',
      destroy,
      items: providerPlan.resources.map((r) => {
        const action = destroy
          ? 'delete'
          : (this.opts.driftIds ?? []).includes(r.logicalId)
            ? 'update'
            : 'create';
        return {
          logicalId: r.logicalId,
          targetType: r.type,
          action,
          reason: `fake ${action}`,
        };
      }),
    };
  }

  async apply(
    providerPlan: ProviderPlan,
    options: ExecutorApplyOptions = {},
  ): Promise<ApplyReport> {
    this.applyCalls.push(options);
    const gateOpen = options.apply === true;
    if (gateOpen) this.mutated = true;
    const destroy = options.destroy === true;
    const errors: string[] = [];
    const items = providerPlan.resources.map((r) => {
      const action = destroy ? 'delete' : 'create';
      if (destroy && r.logicalId === this.opts.unmanagedId) {
        const error = `refusing to delete ${r.logicalId}: not tagged iap:managed=true (managed-only destroy)`;
        errors.push(error);
        return { logicalId: r.logicalId, targetType: r.type, action, applied: false, error };
      }
      return {
        logicalId: r.logicalId,
        targetType: r.type,
        action,
        applied: gateOpen,
        ...(gateOpen ? { identifier: `arn:fake:${r.logicalId}` } : {}),
      };
    });
    return {
      planId: providerPlan.planHash,
      region: this.opts.region ?? 'us-east-1',
      applied: gateOpen,
      mode: gateOpen ? 'apply' : 'dry-run',
      destroy,
      items,
      errors,
    };
  }
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iap-deploy-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => setExecutorFactory(null)); // always restore the production path
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const base = (extra: string[]): string[] => [
  '-f',
  BASIC,
  '--profile',
  'production',
  '--mapping',
  MOCK_PACKAGE,
  ...extra,
];

describe('iap deploy — the live gate', () => {
  it('without --confirm is a dry run: prints the plan, exits 0, issues NO mutation', async () => {
    const fake = new FakeExecutor();
    setExecutorFactory(() => fake);
    const result = await exec(['deploy', ...base([])]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Plan (plan)');
    expect(result.stdout).toContain('dry-run: no changes applied; re-run with --confirm');
    // Read-only plan ran; apply was never invoked → no mutation happened.
    expect(fake.planCalls.length).toBe(1);
    expect(fake.applyCalls.length).toBe(0);
    expect(fake.mutated).toBe(false);
  });

  it('--confirm opens the gate: apply({apply:true}) runs and state is written', async () => {
    const fake = new FakeExecutor();
    setExecutorFactory(() => fake);
    const stateDir = tempDir();
    const result = await exec(['deploy', ...base(['--confirm', '--state', stateDir])]);
    expect(result.code).toBe(0);
    expect(fake.applyCalls.length).toBe(1);
    expect(fake.applyCalls[0]?.apply).toBe(true);
    expect(fake.mutated).toBe(true);
    // A durable snapshot was persisted under the temp state dir.
    expect(readdirSync(stateDir).length).toBeGreaterThan(0);
    // …and `iap state` surfaces it.
    const state = await exec([
      'state',
      '-f',
      BASIC,
      '--profile',
      'production',
      '--state',
      stateDir,
    ]);
    expect(state.code).toBe(0);
    expect(state.stdout).toContain('State basic-webapp/production @ revision 1');
    expect(state.stdout).toContain('object(s)');
  });
});

/** Discover the real logical ids the mock plan produces for basic-webapp. */
async function planLogicalIds(): Promise<string[]> {
  setExecutorFactory(() => new FakeExecutor());
  const listing = await exec(['drift', ...base(['-o', 'json'])]);
  const ids = (JSON.parse(listing.stdout) as { drift: { logicalId: string }[] }).drift.map(
    (d) => d.logicalId,
  );
  setExecutorFactory(null);
  return ids;
}

describe('iap destroy — managed-only guard', () => {
  it('--confirm refuses an unmanaged resource and exits nonzero', async () => {
    const ids = await planLogicalIds();
    expect(ids.length).toBeGreaterThan(0);
    const target = ids[0] as string;

    const fake = new FakeExecutor({ unmanagedId: target });
    setExecutorFactory(() => fake);
    const result = await exec(['destroy', ...base(['--confirm', '--state', tempDir()])]);

    expect(fake.applyCalls[0]?.apply).toBe(true);
    expect(fake.applyCalls[0]?.destroy).toBe(true);
    expect(result.code).toBe(3); // per-resource failure → operation failure
    expect(result.stdout + result.stderr).toContain('refusing to delete');
  });
});

describe('iap drift — read-only', () => {
  it('reports drift from the executor plan and never applies', async () => {
    const ids = await planLogicalIds();
    const fake = new FakeExecutor({ driftIds: [ids[0] as string] });
    setExecutorFactory(() => fake);
    const result = await exec(['drift', ...base([])]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Drift: \d+ resource\(s\) diverge/);
    expect(result.stdout).toContain('update');
    expect(fake.planCalls.length).toBe(1);
    expect(fake.applyCalls.length).toBe(0); // read-only: never applies
  });
});

describe('iap state — snapshot', () => {
  it('reports "never deployed" for an empty state dir', async () => {
    const result = await exec([
      'state',
      '-f',
      BASIC,
      '--profile',
      'production',
      '--state',
      tempDir(),
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('never deployed');
  });
});
