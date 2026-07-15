import { describe, expect, it } from 'vitest';
import {
  classifyReversibility,
  deriveStatefulness,
  determineActions,
  emptySnapshot,
  resourceIdOf,
} from '../src/index';
import type { PlanAction, ReversibilityClass, Statefulness } from '../src/index';
import { removeResource, stateFromPlan, syntheticPlan, webshopPlan } from './helpers';

describe('resourceIdOf', () => {
  it('extracts the originating resource id from a logical id', () => {
    expect(resourceIdOf('orders-db.mock:core:Store')).toBe('orders-db');
    expect(resourceIdOf('plain')).toBe('plain');
  });
});

describe('classifyReversibility (ch. 14 §14.6 table)', () => {
  const table: Array<[PlanAction, Statefulness, ReversibilityClass]> = [
    ['create', 'stateless', 'fully-reversible'],
    ['create', 'stateful', 'fully-reversible'],
    ['update-in-place', 'stateless', 'fully-reversible'],
    ['update-in-place', 'stateful', 'fully-reversible'],
    ['import', 'stateless', 'fully-reversible'],
    ['import', 'stateful', 'fully-reversible'],
    ['replace', 'stateless', 'replacement-based-recovery'],
    ['replace', 'stateful', 'reversible-with-data-risk'],
    ['delete', 'stateless', 'replacement-based-recovery'],
    ['delete', 'stateful', 'irreversible'],
  ];
  it.each(table)('%s of a %s resource is %s', (action, statefulness, expected) => {
    expect(classifyReversibility(action, statefulness)).toBe(expected);
  });
});

describe('deriveStatefulness (kind reconstruction from provenance + bindings)', () => {
  it('classifies the webshop resources per ch. 14 §14.2 statefulness', () => {
    const statefulness = deriveStatefulness(webshopPlan());
    expect(statefulness).toEqual({
      'api-token': 'stateful', // Secret
      emails: 'stateful', // Queue (Topic also matches; both stateful)
      jobs: 'stateful',
      'orders-db': 'stateful', // Database (engineVersion/capacity.storage exclude Cache)
      web: 'stateless', // Service
    });
  });

  it('fails toward stateful when the kind is undecidable', () => {
    const plan = syntheticPlan([{ logicalId: 'x.mock:test:Thing' }]); // no provenance, no bindings
    expect(deriveStatefulness(plan)).toEqual({ x: 'stateful' });
  });
});

describe('determineActions (closed rule order, design decision 4)', () => {
  it('rule 1: everything creates against the empty snapshot', () => {
    const desired = webshopPlan();
    const actions = determineActions(desired, emptySnapshot());
    expect(actions.map((a) => a.action)).toEqual(Array.from({ length: 6 }, () => 'create'));
    expect(actions.map((a) => a.resource)).toEqual(
      [...desired.resources.map((r) => r.logicalId)].sort(),
    );
    const web = actions.find((a) => a.resource === 'web.mock:core:Compute');
    // create lists every desired attribute path, names only.
    expect(web?.fields).toEqual(
      Object.keys(
        desired.resources.find((r) => r.logicalId === 'web.mock:core:Compute')?.desiredAttributes ??
          {},
      ).sort(),
    );
    expect(web?.destructive).toBe(false);
    expect(web?.provenance.changedBy).toBe('documentHash');
  });

  it('rule 5: an identical managed object is a no-op excluded from the plan', () => {
    const desired = webshopPlan();
    expect(determineActions(desired, stateFromPlan(desired))).toEqual([]);
  });

  it('rule 2: an existing unmanaged object imports — never a blind update', () => {
    const desired = webshopPlan();
    const state = stateFromPlan(desired, (objects) => {
      const web = objects['web.mock:core:Compute'] as {
        managed: boolean;
        attributes: Record<string, unknown>;
      };
      web.managed = false;
      web.attributes.cpuUnits = 512; // drifted vs desired 2048 (production size l)
    });
    const actions = determineActions(desired, state);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('import');
    expect(actions[0]?.resource).toBe('web.mock:core:Compute');
    expect(actions[0]?.fields).toEqual(['cpuUnits']); // drift by name
    expect(actions[0]?.provenance.changedBy).toBe('stateRevision');
    expect(actions[0]?.destructive).toBe(false);
    expect(actions[0]?.reversibility).toBe('fully-reversible');
  });

  it('rule 3: a changed lifecycle.replaceOn field replaces (destructive)', () => {
    const desired = webshopPlan({
      mutatePlan: (plan) => {
        const store = plan.resources.find((r) => r.logicalId === 'orders-db.mock:core:Store');
        if (store) store.lifecycle.replaceOn = ['engine'];
      },
    });
    const state = stateFromPlan(desired, (objects) => {
      (
        objects['orders-db.mock:core:Store'] as { attributes: Record<string, unknown> }
      ).attributes.engine = 'mysql';
    });
    const actions = determineActions(desired, state);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('replace');
    expect(actions[0]?.fields).toEqual(['engine']);
    expect(actions[0]?.destructive).toBe(true);
    expect(actions[0]?.reversibility).toBe('reversible-with-data-risk'); // stateful Database
    expect(actions[0]?.provenance.fieldSources).toEqual({ engine: 'map:spec.engine' });
  });

  it('rule 3: a provider-type change replaces via the type pseudo-field', () => {
    const desired = syntheticPlan([
      { logicalId: 'a.mock:test:Thing', desiredAttributes: { v: 1 } },
    ]);
    const state = stateFromPlan(desired, (objects) => {
      (objects['a.mock:test:Thing'] as { type: string }).type = 'mock:test:Other';
    });
    const actions = determineActions(desired, state);
    expect(actions[0]?.action).toBe('replace');
    expect(actions[0]?.fields).toContain('type');
    expect(actions[0]?.provenance.fieldSources.type).toBe('state');
  });

  it('rule 4: any other attribute difference updates in place', () => {
    const desired = webshopPlan();
    const state = stateFromPlan(desired, (objects) => {
      (
        objects['orders-db.mock:core:Store'] as { attributes: Record<string, unknown> }
      ).attributes.multiZone = false;
    });
    const actions = determineActions(desired, state);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('update-in-place');
    expect(actions[0]?.fields).toEqual(['multiZone']);
    expect(actions[0]?.destructive).toBe(false);
    expect(actions[0]?.reversibility).toBe('fully-reversible');
    expect(actions[0]?.provenance.fieldSources).toEqual({ multiZone: 'map:spec.availability' });
  });

  it('rule 6: a managed object no longer desired deletes (fields empty)', () => {
    const full = webshopPlan();
    const desired = webshopPlan({
      mutateDocument: (document) => removeResource(document, 'web'),
    });
    const actions = determineActions(desired, stateFromPlan(full));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('delete');
    expect(actions[0]?.resource).toBe('web.mock:core:Compute');
    expect(actions[0]?.fields).toEqual([]);
    expect(actions[0]?.destructive).toBe(true);
    // web left the desired plan, so its kind is undecidable → stateful → irreversible.
    expect(actions[0]?.reversibility).toBe('irreversible');
  });

  it('rule 7: an undesired unmanaged object is invisible', () => {
    const desired = webshopPlan();
    const state = stateFromPlan(desired, (objects) => {
      objects['stray.mock:core:Queue'] = {
        type: 'mock:core:Queue',
        attributes: { fifo: false },
        managed: false,
      };
    });
    expect(determineActions(desired, state)).toEqual([]);
  });

  it('encodes constant/from/map field sources from plan provenance', () => {
    const desired = webshopPlan();
    const actions = determineActions(desired, emptySnapshot());
    const store = actions.find((a) => a.resource === 'orders-db.mock:core:Store');
    expect(store?.provenance.fieldSources.public).toBe('constant');
    expect(store?.provenance.fieldSources.engineVersion).toBe('from:spec.engineVersion');
    expect(store?.provenance.fieldSources.engine).toBe('map:spec.engine');
  });
});
