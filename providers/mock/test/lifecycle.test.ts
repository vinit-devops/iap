/**
 * Execution-level lifecycle suite (IEP-0012 certification level execution):
 * create/update/replace/delete/import/verify against the in-memory
 * substrate, with wave ordering (ch. 14 §14.4), halt-wave failure recovery
 * (§14.7), idempotent convergence (CE-5), secret hygiene (CE-6), and
 * injectable failures throughout. Everything runs off injected counters —
 * no clock, no randomness.
 */

import { describe, expect, it } from 'vitest';
import type { IaPDocument, RelationshipEdge } from '@iap/model';
import type { PlanResource, ProviderPlan } from '@iap/provider-sdk';
import {
  MockSubstrate,
  REDACTED,
  executePlan,
  importObject,
  readObject,
  verifyConvergence,
} from '../src/index';
import { webshopPlan } from './helpers';

const IDS = {
  token: 'api-token.mock:core:SecretBox',
  emails: 'emails.mock:core:Queue',
  jobs: 'jobs.mock:core:Queue',
  dbSecret: 'orders-db.mock:core:SecretBox',
  dbStore: 'orders-db.mock:core:Store',
  web: 'web.mock:core:Compute',
} as const;

const WAVE_ZERO = [IDS.token, IDS.emails, IDS.jobs, IDS.dbSecret, IDS.dbStore];

const planA = (): ProviderPlan => webshopPlan();

/** Plan with emails.messageRetention shortened — an update-in-place diff. */
const planRetention = (): ProviderPlan =>
  webshopPlan({
    mutate: (document) => {
      (document.resources['emails']?.spec as Record<string, unknown>)['messageRetention'] = '1d';
    },
  });

/** Plan with orders-db.engine flipped — an immutable attribute, so replace. */
const planEngineFlip = (): ProviderPlan =>
  webshopPlan({
    mutate: (document) => {
      (document.resources['orders-db']?.spec as Record<string, unknown>)['engine'] = 'mysql';
    },
  });

/** Plan without the emails queue (and without web's edge to it). */
const planWithoutEmails = (): ProviderPlan =>
  webshopPlan({
    mutate: (document) => {
      delete document.resources['emails'];
      const web = document.resources['web'] as { relationships?: RelationshipEdge[] };
      web.relationships = (web.relationships ?? []).filter((edge) => edge.target !== 'emails');
    },
  });

/** Teardown plan: only the api-token secret remains. */
const planTokenOnly = (): ProviderPlan =>
  webshopPlan({
    profile: null,
    mutate: (document) => {
      const token = document.resources['api-token'];
      if (!token) throw new Error('missing api-token');
      document.resources = { 'api-token': token };
      delete (document as IaPDocument & { profiles?: unknown }).profiles;
    },
  });

const planResource = (plan: ProviderPlan, logicalId: string): PlanResource => {
  const resource = plan.resources.find((r) => r.logicalId === logicalId);
  if (!resource) throw new Error(`plan has no resource ${logicalId}`);
  return resource;
};

const opsBy = (result: ReturnType<typeof executePlan>, status?: string) =>
  result.operations
    .filter((op) => status === undefined || op.status === status)
    .map((op) => `${op.action} ${op.logicalId}`);

describe('create: wave-ordered initial apply', () => {
  it('provisions everything in dependency waves and converges', () => {
    const substrate = new MockSubstrate();
    const plan = planA();
    const result = executePlan(substrate, plan);

    expect(result.outcome).toBe('succeeded');
    expect(result.waves).toEqual([WAVE_ZERO, [IDS.web]]);
    expect(result.operations).toHaveLength(6);
    expect(result.operations.every((op) => op.action === 'create' && op.status === 'applied')).toBe(
      true,
    );
    // Deterministic identity from the injected counter, in apply order.
    expect(substrate.getRecord(IDS.token)?.outputs.id).toBe('mock-1');
    expect(substrate.getRecord(IDS.dbStore)?.outputs.id).toBe('mock-5');
    expect(substrate.getRecord(IDS.web)?.outputs.id).toBe('mock-6');

    const convergence = verifyConvergence(substrate, plan);
    expect(convergence).toEqual({ converged: true, differences: [] });
  });

  it('is fully deterministic across substrates', () => {
    const first = executePlan(new MockSubstrate(), planA());
    const second = executePlan(new MockSubstrate(), planA());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.stateHash).toBe(second.stateHash);
  });

  it('identity generation runs off the injected counter', () => {
    let next = 100;
    const substrate = new MockSubstrate({
      nextSequence: () => {
        next += 1;
        return next;
      },
    });
    executePlan(substrate, planA());
    expect(substrate.getRecord(IDS.token)?.outputs.id).toBe('mock-101');
  });
});

describe('idempotent convergence (CE-5)', () => {
  it('re-executing the same plan is a no-op with an unchanged state hash', () => {
    const substrate = new MockSubstrate();
    const plan = planA();
    const first = executePlan(substrate, plan);
    const second = executePlan(substrate, plan);

    expect(second.outcome).toBe('succeeded');
    expect(second.operations).toEqual([]);
    expect(second.waves).toEqual([]);
    expect(second.stateHash).toBe(first.stateHash);
    expect(verifyConvergence(substrate, plan).converged).toBe(true);
  });
});

describe('update: in-place modification with verify nodes', () => {
  it('updates only the changed object; impacted dependents re-verify', () => {
    const substrate = new MockSubstrate();
    executePlan(substrate, planA());
    const before = substrate.getRecord(IDS.emails);
    const result = executePlan(substrate, planRetention());

    expect(result.outcome).toBe('succeeded');
    expect(result.waves).toEqual([[IDS.emails], [IDS.web]]);
    expect(opsBy(result)).toEqual([`update ${IDS.emails}`, `verify ${IDS.web}`]);
    const after = substrate.getRecord(IDS.emails);
    expect(after?.desiredAttributes.retention).toBe('1d');
    // In-place: same identity, incremented generation.
    expect(after?.outputs.id).toBe(before?.outputs.id);
    expect(after?.sequence).toBe(before?.sequence);
    expect(after?.generation).toBe(2);
  });
});

describe('replace: immutable-after-create attributes force a successor', () => {
  it('an engine flip on the Store replaces the object with a new identity', () => {
    const substrate = new MockSubstrate();
    executePlan(substrate, planA());
    const before = substrate.getRecord(IDS.dbStore);
    const result = executePlan(substrate, planEngineFlip());

    expect(result.outcome).toBe('succeeded');
    expect(opsBy(result)).toEqual([`replace ${IDS.dbStore}`, `verify ${IDS.web}`]);
    const after = substrate.getRecord(IDS.dbStore);
    expect(after?.desiredAttributes.engine).toBe('mysql');
    // Successor object: fresh sequence and generated outputs (§14.2).
    expect(after?.sequence).not.toBe(before?.sequence);
    expect(after?.outputs.id).not.toBe(before?.outputs.id);
    expect(after?.generation).toBe(2);
  });
});

describe('delete: objects absent from the plan are deprovisioned', () => {
  it('removes the abandoned queue and leaves the rest untouched', () => {
    const substrate = new MockSubstrate();
    executePlan(substrate, planA());
    const plan = planWithoutEmails();
    const result = executePlan(substrate, plan);

    expect(result.outcome).toBe('succeeded');
    expect(opsBy(result)).toEqual([`delete ${IDS.emails}`]);
    expect(substrate.getRecord(IDS.emails)).toBeUndefined();
    expect(verifyConvergence(substrate, plan).converged).toBe(true);
  });

  it('delete waves run in reverse dependency order — dependents first', () => {
    const substrate = new MockSubstrate();
    executePlan(substrate, planA());
    const result = executePlan(substrate, planTokenOnly());

    expect(result.outcome).toBe('succeeded');
    expect(result.waves).toEqual([[IDS.web], [IDS.emails, IDS.jobs, IDS.dbSecret, IDS.dbStore]]);
    expect(substrate.listRecords().map((r) => r.logicalId)).toEqual([IDS.token]);
  });

  it('a failed delete cancels the deletes it still depends on', () => {
    const substrate = new MockSubstrate();
    executePlan(substrate, planA());
    substrate.setFailures([{ logicalId: IDS.web, operation: 'delete' }]);
    const result = executePlan(substrate, planTokenOnly());

    expect(result.outcome).toBe('partial');
    expect(opsBy(result, 'failed')).toEqual([`delete ${IDS.web}`]);
    expect(opsBy(result, 'cancelled')).toEqual([
      `delete ${IDS.emails}`,
      `delete ${IDS.jobs}`,
      `delete ${IDS.dbSecret}`,
      `delete ${IDS.dbStore}`,
    ]);
    expect(substrate.getRecord(IDS.web)?.status).toBe('failed');
    expect(substrate.getRecord(IDS.dbStore)).toBeDefined();
  });

  it('unmanaged out-of-band objects are never deleted', () => {
    const substrate = new MockSubstrate();
    substrate.seedUnmanaged({
      logicalId: 'ghost.mock:core:Store',
      type: 'mock:core:Store',
      attributes: { engine: 'postgres' },
    });
    const plan = planA();
    const result = executePlan(substrate, plan);
    expect(result.operations.some((op) => op.logicalId === 'ghost.mock:core:Store')).toBe(false);
    expect(substrate.getRecord('ghost.mock:core:Store')).toBeDefined();
    // Unmanaged objects are out of scope for convergence too.
    expect(verifyConvergence(substrate, plan).converged).toBe(true);
  });
});

describe('halt-wave failure recovery (§14.7)', () => {
  it('a failed create halts dependent waves; independent branches complete', () => {
    const substrate = new MockSubstrate({
      failures: [{ logicalId: IDS.dbStore, operation: 'create' }],
    });
    const plan = planA();
    const result = executePlan(substrate, plan);

    expect(result.outcome).toBe('partial');
    expect(opsBy(result, 'failed')).toEqual([`create ${IDS.dbStore}`]);
    expect(opsBy(result, 'cancelled')).toEqual([`create ${IDS.web}`]);
    expect(opsBy(result, 'applied')).toEqual([
      `create ${IDS.token}`,
      `create ${IDS.emails}`,
      `create ${IDS.jobs}`,
      `create ${IDS.dbSecret}`,
    ]);
    expect(substrate.getRecord(IDS.dbStore)?.status).toBe('failed');
    expect(substrate.getRecord(IDS.web)).toBeUndefined();
    expect(verifyConvergence(substrate, plan).converged).toBe(false);
  });

  it('operations later in the same wave still run to completion', () => {
    const substrate = new MockSubstrate({
      failures: [{ logicalId: IDS.token, operation: 'create' }],
    });
    const result = executePlan(substrate, planA());
    // api-token fails first in wave 0; its wave siblings all still apply.
    expect(opsBy(result, 'applied')).toEqual([
      `create ${IDS.emails}`,
      `create ${IDS.jobs}`,
      `create ${IDS.dbSecret}`,
      `create ${IDS.dbStore}`,
    ]);
    expect(opsBy(result, 'cancelled')).toEqual([`create ${IDS.web}`]);
  });

  it('recovery is re-execution: the diff emits exactly the unfinished work', () => {
    const substrate = new MockSubstrate({
      failures: [{ logicalId: IDS.dbStore, operation: 'create' }],
    });
    const plan = planA();
    executePlan(substrate, plan);
    substrate.setFailures([]);
    const retry = executePlan(substrate, plan);

    expect(retry.outcome).toBe('succeeded');
    // The failed object retries as update-in-place (§14.2); the cancelled
    // object creates; converged objects are no-ops and do not reappear.
    expect(opsBy(retry)).toEqual([`update ${IDS.dbStore}`, `create ${IDS.web}`]);
    expect(substrate.getRecord(IDS.dbStore)?.status).toBe('ready');
    expect(verifyConvergence(substrate, plan)).toEqual({ converged: true, differences: [] });
  });

  it('an injected update failure marks the object failed and cancels dependents', () => {
    const substrate = new MockSubstrate();
    executePlan(substrate, planA());
    substrate.setFailures([{ logicalId: IDS.emails, operation: 'update' }]);
    const result = executePlan(substrate, planRetention());

    expect(result.outcome).toBe('partial');
    expect(opsBy(result, 'failed')).toEqual([`update ${IDS.emails}`]);
    expect(opsBy(result, 'cancelled')).toEqual([`verify ${IDS.web}`]);
    expect(substrate.getRecord(IDS.emails)?.status).toBe('failed');

    substrate.setFailures([]);
    const retry = executePlan(substrate, planRetention());
    expect(retry.outcome).toBe('succeeded');
    expect(substrate.getRecord(IDS.emails)?.desiredAttributes.retention).toBe('1d');
    expect(substrate.getRecord(IDS.emails)?.status).toBe('ready');
  });
});

describe('import: adopting out-of-band objects', () => {
  const seedToken = (substrate: MockSubstrate) =>
    substrate.seedUnmanaged({
      logicalId: IDS.token,
      type: 'mock:core:SecretBox',
      attributes: { material: 'platform', rotationEnabled: true, rotationInterval: '30d' },
    });

  it('an unmanaged object conflicts with create until it is imported', () => {
    const substrate = new MockSubstrate();
    seedToken(substrate);
    const plan = planA();

    const blocked = executePlan(substrate, plan);
    expect(blocked.outcome).toBe('partial');
    const conflict = blocked.operations.find((op) => op.logicalId === IDS.token);
    expect(conflict).toMatchObject({ status: 'failed', reason: 'exists-unmanaged' });
    expect(opsBy(blocked, 'cancelled')).toEqual([`create ${IDS.web}`]);

    const imported = importObject(substrate, planResource(plan, IDS.token));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.drifted).toEqual([]);
    expect(imported.object.managed).toBe(true);

    const result = executePlan(substrate, plan);
    expect(result.outcome).toBe('succeeded');
    expect(opsBy(result)).toEqual([`create ${IDS.web}`]);
    expect(verifyConvergence(substrate, plan).converged).toBe(true);
  });

  it('reports drifted attributes by name on adoption', () => {
    const substrate = new MockSubstrate();
    substrate.seedUnmanaged({
      logicalId: IDS.token,
      type: 'mock:core:SecretBox',
      attributes: { material: 'operator', rotationEnabled: false, rotationInterval: '30d' },
    });
    const imported = importObject(substrate, planResource(planA(), IDS.token));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.drifted).toEqual(['material', 'rotationEnabled']);
  });

  it('fails closed on missing, already-managed, and injected-failure imports', () => {
    const plan = planA();
    const missing = importObject(new MockSubstrate(), planResource(plan, IDS.token));
    expect(missing).toEqual({ ok: false, reason: 'not-found' });

    const managed = new MockSubstrate();
    executePlan(managed, plan);
    expect(importObject(managed, planResource(plan, IDS.token))).toEqual({
      ok: false,
      reason: 'already-managed',
    });

    const failing = new MockSubstrate({
      failures: [{ logicalId: IDS.token, operation: 'import' }],
    });
    seedToken(failing);
    expect(importObject(failing, planResource(plan, IDS.token))).toEqual({
      ok: false,
      reason: 'injected-failure',
    });
  });
});

describe('read handler', () => {
  it('returns the redacted external view of an object', () => {
    const substrate = new MockSubstrate();
    executePlan(substrate, planA());
    const result = readObject(substrate, IDS.dbStore);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.object).toMatchObject({
      logicalId: IDS.dbStore,
      type: 'mock:core:Store',
      status: 'ready',
      managed: true,
      generation: 1,
    });
    expect(result.object.attributes.engine).toBe('postgres');
    expect(result.object.attributes.id).toBe('mock-5');
  });

  it('fails closed on missing objects and injected read failures', () => {
    expect(readObject(new MockSubstrate(), IDS.dbStore)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    const failing = new MockSubstrate({
      failures: [{ logicalId: IDS.dbStore, operation: 'read' }],
    });
    executePlan(failing, planA());
    expect(readObject(failing, IDS.dbStore)).toEqual({ ok: false, reason: 'injected-failure' });
  });
});

describe('secret hygiene (CE-6)', () => {
  it('secret material never appears in execution results, logs, or reads', () => {
    const substrate = new MockSubstrate();
    const result = executePlan(substrate, planA());

    // The substrate generated secret material for both SecretBox objects…
    expect(substrate.getRecord(IDS.token)?.outputs.value).toMatch(/^mock-secret-value-/);
    // …but no externalized surface ever echoes it.
    expect(JSON.stringify(result)).not.toMatch(/mock-secret-value-/);
    expect(result.log.join('\n')).not.toMatch(/mock-secret-value-/);
    expect(JSON.stringify(substrate.snapshot())).not.toMatch(/mock-secret-value-/);

    const read = readObject(substrate, IDS.token);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.object.attributes.value).toBe(REDACTED);
    // Non-sensitive generated outputs stay visible.
    expect(read.object.attributes.ref).toBe('mock-secret-ref-1');
  });

  it('honors sensitiveFields declared on the plan resource itself', () => {
    const plan = structuredClone(planA());
    const store = planResource(plan, IDS.dbStore);
    store.sensitiveFields = ['storage'];
    const substrate = new MockSubstrate();
    executePlan(substrate, plan);
    const read = readObject(substrate, IDS.dbStore);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.object.attributes.storage).toBe(REDACTED);
    expect(read.object.attributes.engine).toBe('postgres');
  });

  it('convergence differences name attributes, never values', () => {
    const substrate = new MockSubstrate();
    executePlan(substrate, planA());
    const drifted = webshopPlan({
      mutate: (document) => {
        const rotation = (document.resources['api-token']?.spec as Record<string, unknown>)[
          'rotation'
        ] as Record<string, unknown>;
        rotation['interval'] = '90d';
      },
    });
    const convergence = verifyConvergence(substrate, drifted);
    expect(convergence.converged).toBe(false);
    expect(convergence.differences).toEqual([
      `${IDS.token}: attribute "rotationInterval" diverges from desired state`,
    ]);
    expect(convergence.differences.join('\n')).not.toMatch(/30d|90d|mock-secret-value/);
  });
});
