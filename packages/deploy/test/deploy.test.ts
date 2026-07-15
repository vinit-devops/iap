/**
 * `@iap/deploy` — the deployment engine (spec ch. 14, IEP-0010). Pins the full
 * lifecycle over the state backend: approval gating, fail-closed locking, atomic
 * state commit, partial-state recovery, post-deploy verification and history,
 * drift detection, and rollback.
 */
import { describe, expect, it } from 'vitest';
import { LocalStateBackend } from '@iap/state';
import type { StateObject, StateRef } from '@iap/state';
import { deploy, detectDrift, fixtureExecutor, rollback } from '../src/index';
import type { DeploymentPlan } from '../src/index';

const REF: StateRef = { document: 'orders', profile: null };
const T0 = '2026-07-01T00:00:00Z';
const obj = (size: string): StateObject => ({
  type: 'mock:core:Store',
  attributes: { size },
  managed: true,
});

const plan = (over: Partial<DeploymentPlan> = {}): DeploymentPlan => ({
  planId: 'p1',
  desired: { web: obj('m'), db: obj('l') },
  destructive: [],
  ...over,
});

const base = (backend = new LocalStateBackend()) => ({
  backend,
  ref: REF,
  actor: 'reviewer',
  timestamp: T0,
});

describe('deploy — the happy path', () => {
  it('applies a plan, commits state at revision 1, verifies, and records history', async () => {
    const backend = new LocalStateBackend();
    const result = await deploy({ ...base(backend), plan: plan(), executor: fixtureExecutor() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('succeeded');
    expect(result.revision).toBe(1);
    expect(result.applied.sort()).toEqual(['db', 'web']);
    expect(result.verification).toBe('converged');

    const state = await backend.read(REF);
    expect(state?.revision).toBe(1);
    expect(Object.keys(state?.objects ?? {}).sort()).toEqual(['db', 'web']);
    const history = await backend.history(REF);
    expect(history[0]).toMatchObject({
      outcome: 'succeeded',
      approvals: [],
      verification: 'converged',
    });
  });

  it('a second deploy advances the revision to 2', async () => {
    const backend = new LocalStateBackend();
    await deploy({ ...base(backend), plan: plan(), executor: fixtureExecutor() });
    const second = await deploy({
      ...base(backend),
      plan: plan({ planId: 'p2', desired: { web: obj('l'), db: obj('l') } }),
      executor: fixtureExecutor(),
    });
    expect(second.ok && second.revision).toBe(2);
  });
});

describe('deploy — safety gates', () => {
  it('refuses a destructive plan with no approval (§19.6)', async () => {
    const result = await deploy({
      ...base(),
      plan: plan({ destructive: ['db'] }),
      executor: fixtureExecutor(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('unapproved-destructive');
  });

  it('proceeds with a destructive plan once approved', async () => {
    const result = await deploy({
      ...base(),
      plan: plan({ destructive: ['db'] }),
      executor: fixtureExecutor(),
      approvals: ['reviewer@example.com'],
    });
    expect(result.ok).toBe(true);
  });

  it('refuses when the state is locked by another holder (fail-closed)', async () => {
    const backend = new LocalStateBackend();
    await backend.acquireLock(REF, { holder: 'other', operation: 'apply', ttlSeconds: 300 }, T0);
    const result = await deploy({ ...base(backend), plan: plan(), executor: fixtureExecutor() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('locked');
  });
});

describe('deploy — partial-state recovery (§14.7)', () => {
  it('commits the applied objects and records the failure on a partial outcome', async () => {
    const backend = new LocalStateBackend();
    const result = await deploy({
      ...base(backend),
      plan: plan(),
      executor: fixtureExecutor({ failOn: ['db'] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('partial');
    expect(result.applied).toEqual(['web']);
    expect(result.failed).toEqual(['db']);
    // The applied object is committed; state is recoverable.
    const state = await backend.read(REF);
    expect(Object.keys(state?.objects ?? {})).toEqual(['web']);
    expect((await backend.history(REF))[0].outcome).toBe('partial');
  });
});

describe('drift and rollback', () => {
  it('detectDrift reports no drift on a converged world', async () => {
    const backend = new LocalStateBackend();
    const executor = fixtureExecutor();
    await deploy({ ...base(backend), plan: plan(), executor });
    const drift = await detectDrift(backend, REF, executor);
    expect(drift.drifted).toBe(false);
    expect(drift.severity).toBe('benign');
  });

  it('detectDrift flags a diverged attribute as intent-violating and reconcilable', async () => {
    const backend = new LocalStateBackend();
    const executor = fixtureExecutor({ driftOn: ['web'] });
    await deploy({ ...base(backend), plan: plan(), executor });
    const drift = await detectDrift(backend, REF, executor);
    expect(drift.drifted).toBe(true);
    expect(drift.disposition).toBe('reconcilable');
    expect(drift.severity).toBe('intent-violating');
  });

  it('rollback re-applies a restoring plan and records it as rolled-back', async () => {
    const backend = new LocalStateBackend();
    await deploy({
      ...base(backend),
      plan: plan({ desired: { web: obj('l') } }),
      executor: fixtureExecutor(),
    });
    const restore = await rollback({
      ...base(backend),
      plan: plan({ planId: 'rb', desired: { web: obj('m') } }),
      executor: fixtureExecutor(),
    });
    expect(restore.ok).toBe(true);
    if (!restore.ok) return;
    expect(restore.revision).toBe(2);
    const history = await backend.history(REF);
    expect(history[history.length - 1].rollback).toBe('performed');
  });
});
