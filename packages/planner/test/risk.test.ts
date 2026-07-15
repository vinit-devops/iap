import { describe, expect, it } from 'vitest';
import {
  ACTION_WEIGHTS,
  RISK_CLASS_THRESHOLDS,
  RISK_RULE_TABLE_VERSION,
  SECURITY_BOUNDARY_FACTOR_ID,
  SECURITY_BOUNDARY_WEIGHT,
  classifyRiskScore,
  emptySnapshot,
  plan,
  riskFactorIdOf,
  riskRuleTableV1,
} from '../src/index';
import type { PlanActionEntry, RiskInput, SecurityDelta } from '../src/index';
import { removeResource, stateFromPlan, webshopPlan } from './helpers';

function entry(partial: Partial<PlanActionEntry> & { resource: string }): PlanActionEntry {
  return {
    action: 'create',
    fields: [],
    provenance: { changedBy: 'documentHash', fieldSources: {} },
    destructive: false,
    reversibility: 'fully-reversible',
    ...partial,
  };
}

function contentWith(waves: PlanActionEntry[][], security: SecurityDelta[] = []): RiskInput {
  return {
    inputs: {
      documentHash: `sha256:${'a'.repeat(64)}`,
      target: { provider: 'mock', profile: null },
      profileHashes: {},
      policyBundles: {},
      extensionVersions: {},
      mappingVersions: { mock: '1.1.0' },
      discoverySnapshot: null,
      pricingSnapshot: null,
      stateRevision: 0,
      stateIntegrity: `sha256:${'b'.repeat(64)}`,
      plannerVersion: '0.2.0',
      inputsHash: `sha256:${'c'.repeat(64)}`,
    },
    waves,
    destructiveActions: [],
    unknownValues: [],
    deltas: {
      cost: { status: 'unavailable', reason: 'no-pricing-snapshot' },
      security,
      compliance: { deferred: 'phase-11', findings: [] },
    },
    rollback: { strategy: 're-plan-to-revision', limitations: [] },
    verification: [],
    approvalsRequired: [],
  };
}

describe('rule table v1 shape (design decision 8)', () => {
  it('is version 1, folded into the planner version — never a tenth identity', () => {
    expect(RISK_RULE_TABLE_VERSION).toBe(1);
  });

  it('uses integer weights only, ranked delete-stateful ≫ replace ≫ import/create ≫ update', () => {
    for (const byReversibility of Object.values(ACTION_WEIGHTS)) {
      for (const weight of Object.values(byReversibility)) {
        expect(Number.isInteger(weight)).toBe(true);
        expect(weight).toBeGreaterThan(0);
      }
    }
    const deleteStateful = ACTION_WEIGHTS.delete.irreversible;
    const replaceStateful = ACTION_WEIGHTS.replace['reversible-with-data-risk'];
    const replaceStateless = ACTION_WEIGHTS.replace['replacement-based-recovery'];
    expect(deleteStateful).toBeGreaterThan(replaceStateful);
    expect(replaceStateful).toBeGreaterThan(replaceStateless);
    expect(replaceStateless).toBeGreaterThan(ACTION_WEIGHTS.import['fully-reversible']);
    expect(ACTION_WEIGHTS.import['fully-reversible']).toBeGreaterThan(
      ACTION_WEIGHTS.create['fully-reversible'],
    );
    expect(ACTION_WEIGHTS.create['fully-reversible']).toBeGreaterThan(
      ACTION_WEIGHTS['update-in-place']['fully-reversible'],
    );
    expect(Number.isInteger(SECURITY_BOUNDARY_WEIGHT)).toBe(true);
  });

  it('derives factor ids from action alone, qualified by reversibility when destructive', () => {
    expect(riskFactorIdOf('create', 'fully-reversible')).toBe('create');
    expect(riskFactorIdOf('import', 'fully-reversible')).toBe('import');
    expect(riskFactorIdOf('update-in-place', 'fully-reversible')).toBe('update-in-place');
    expect(riskFactorIdOf('replace', 'reversible-with-data-risk')).toBe(
      'replace-reversible-with-data-risk',
    );
    expect(riskFactorIdOf('delete', 'irreversible')).toBe('delete-irreversible');
  });
});

describe('deterministic classification (explicit thresholds)', () => {
  it('classifies exactly at the documented boundaries', () => {
    expect(classifyRiskScore(0)).toBe('low');
    expect(classifyRiskScore(RISK_CLASS_THRESHOLDS.medium - 1)).toBe('low');
    expect(classifyRiskScore(RISK_CLASS_THRESHOLDS.medium)).toBe('medium');
    expect(classifyRiskScore(RISK_CLASS_THRESHOLDS.high - 1)).toBe('medium');
    expect(classifyRiskScore(RISK_CLASS_THRESHOLDS.high)).toBe('high');
    expect(classifyRiskScore(RISK_CLASS_THRESHOLDS.critical - 1)).toBe('high');
    expect(classifyRiskScore(RISK_CLASS_THRESHOLDS.critical)).toBe('critical');
  });

  it('one irreversible delete is high on its own; two are critical', () => {
    const one = riskRuleTableV1(
      contentWith([
        [
          entry({
            resource: 'a.t',
            action: 'delete',
            destructive: true,
            reversibility: 'irreversible',
          }),
        ],
      ]),
    );
    expect(one.score).toBe(ACTION_WEIGHTS.delete.irreversible);
    expect(one.class).toBe('high');
    const two = riskRuleTableV1(
      contentWith([
        [
          entry({
            resource: 'a.t',
            action: 'delete',
            destructive: true,
            reversibility: 'irreversible',
          }),
          entry({
            resource: 'b.t',
            action: 'delete',
            destructive: true,
            reversibility: 'irreversible',
          }),
        ],
      ]),
    );
    expect(two.class).toBe('critical');
  });
});

describe('factor derivation (pure function of plan content)', () => {
  it('groups actions into per-rule factors with weight = unit × resources, sorted', () => {
    const annotation = riskRuleTableV1(
      contentWith([
        [
          entry({ resource: 'b.t', action: 'create' }),
          entry({ resource: 'a.t', action: 'create' }),
        ],
        [entry({ resource: 'c.t', action: 'update-in-place' })],
        [
          entry({
            resource: 'd.t',
            action: 'replace',
            destructive: true,
            reversibility: 'reversible-with-data-risk',
          }),
        ],
      ]),
    );
    expect(annotation.factors).toEqual([
      { id: 'create', weight: 4, resources: ['a.t', 'b.t'] },
      {
        id: 'replace-reversible-with-data-risk',
        weight: ACTION_WEIGHTS.replace['reversible-with-data-risk'],
        resources: ['d.t'],
      },
      { id: 'update-in-place', weight: 1, resources: ['c.t'] },
    ]);
    expect(annotation.score).toBe(4 + ACTION_WEIGHTS.replace['reversible-with-data-risk'] + 1);
  });

  it('adds one boundary factor weighted per security delta entry', () => {
    const annotation = riskRuleTableV1(
      contentWith(
        [[entry({ resource: 'a.t', action: 'update-in-place' })]],
        [
          { resource: 'a.t', field: 'reachable', source: 'spec.exposure' },
          { resource: 'a.t', field: 'tlsInternal', source: 'spec.encryption.inTransit' },
        ],
      ),
    );
    expect(annotation.factors).toContainEqual({
      id: SECURITY_BOUNDARY_FACTOR_ID,
      weight: 2 * SECURITY_BOUNDARY_WEIGHT,
      resources: ['a.t'],
    });
    expect(annotation.score).toBe(1 + 2 * SECURITY_BOUNDARY_WEIGHT);
  });

  it('is deterministic: identical content yields the identical annotation', () => {
    const content = contentWith(
      [
        [
          entry({ resource: 'a.t' }),
          entry({
            resource: 'b.t',
            action: 'import',
            provenance: { changedBy: 'stateRevision', fieldSources: {} },
          }),
        ],
      ],
      [{ resource: 'a.t', field: 'reachable', source: 'spec.exposure' }],
    );
    expect(riskRuleTableV1(content)).toEqual(riskRuleTableV1(content));
  });
});

describe('rule table over the real pipeline', () => {
  it('scores a webshop teardown as critical with the delete factor dominant', () => {
    const full = webshopPlan();
    const desired = webshopPlan({
      mutateDocument: (document) => {
        removeResource(document, 'web');
        removeResource(document, 'orders-db');
      },
    });
    const artifact = plan(desired, stateFromPlan(full));
    const deleteFactor = artifact.content.risk.factors.find(
      (factor) => factor.id === 'delete-irreversible',
    );
    expect(deleteFactor?.resources).toEqual([
      'orders-db.mock:core:SecretBox',
      'orders-db.mock:core:Store',
      'web.mock:core:Compute',
    ]);
    expect(deleteFactor?.weight).toBe(3 * ACTION_WEIGHTS.delete.irreversible);
    expect(artifact.content.risk.class).toBe('critical');
  });

  it('a custom annotator still overrides the default rule table (seam intact)', () => {
    const artifact = plan(
      webshopPlan(),
      emptySnapshot(),
      {},
      { risk: () => ({ score: 0, class: 'low', factors: [] }) },
    );
    expect(artifact.content.risk).toEqual({ score: 0, class: 'low', factors: [] });
  });
});
