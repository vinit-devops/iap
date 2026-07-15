/**
 * Budget validation and cost-diff (spec ch. 16 §16.7). A budget is an ordinary
 * `deny`/`warn` policy with `greater-than` over `x-iap-cost.*`, evaluated at
 * plan time against the cost report: a matching deny fails with IAP505; an
 * unknown-cost resource is unevaluable (warning), never silently passed;
 * document-level budgets target the Application roll-up.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalModel, CanonicalResource, Policy } from '@iap/model';
import {
  annotateModel,
  diffReports,
  estimateCost,
  evaluateBudgets,
  referenceCostModel,
  referenceSnapshot,
} from '../src/index';

function model(
  resources: Record<string, Partial<CanonicalResource> & { kind: string }>,
  policies: Policy[] = [],
): CanonicalModel {
  const full: Record<string, CanonicalResource> = {};
  for (const [id, r] of Object.entries(resources)) {
    full[id] = {
      kind: r.kind as CanonicalResource['kind'],
      labels: r.labels ?? {},
      spec: r.spec ?? {},
      extensions: {},
    };
  }
  return {
    apiVersion: 'iap.dev/v1',
    metadata: { name: 'budget-test' },
    resources: full,
    edges: [],
    policies,
    profile: null,
    hash: '0'.repeat(64),
    provenance: {},
    diagnostics: [],
  } as unknown as CanonicalModel;
}

const report = (m: CanonicalModel) =>
  estimateCost(m, { costModel: referenceCostModel(), snapshot: referenceSnapshot() });

const budget = (
  id: string,
  value: number,
  effect: 'deny' | 'warn',
  target: Policy['target'] = { kinds: ['Service'] },
): Policy => ({
  id,
  target,
  rule: { field: 'x-iap-cost.estimatedMonthly', operator: 'greater-than', value },
  effect,
  params: { maxMonthly: value, currency: 'USD' },
});

const service = {
  kind: 'Service',
  spec: {
    size: 'm',
    scaling: { min: 1, max: 4 },
    artifact: { type: 'container-image', reference: 'r/x:1' },
  },
};

describe('evaluateBudgets (§16.7)', () => {
  it('an exceeded deny budget fails with IAP505 naming the amount and threshold', () => {
    const m = model({ web: service }, [budget('web-budget', 50, 'deny')]); // web ≈ 87.60
    const findings = evaluateBudgets(m, report(m));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'IAP505',
      severity: 'error',
      path: '/resources/web',
      policyId: 'web-budget',
    });
    expect(findings[0].message).toContain('> 50');
  });

  it('a budget within limit produces no finding', () => {
    const m = model({ web: service }, [budget('web-budget', 500, 'deny')]);
    expect(evaluateBudgets(m, report(m))).toEqual([]);
  });

  it('an exceeded warn budget is a warning, not an error', () => {
    const m = model({ web: service }, [budget('web-budget', 50, 'warn')]);
    const findings = evaluateBudgets(m, report(m));
    expect(findings[0]).toMatchObject({ code: 'IAP505', severity: 'warning' });
  });

  it('an unknown-cost resource is unevaluable (warning), never silently passed', () => {
    const m = model({ box: { kind: 'Stream' } }, [
      budget('stream-budget', 1, 'deny', { kinds: ['Stream'] }),
    ]);
    const findings = evaluateBudgets(m, report(m));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'IAP505', severity: 'warning' });
    expect(findings[0].message).toContain('unevaluable');
  });

  it('a document-level Application budget evaluates the roll-up', () => {
    const m = model(
      {
        web: service,
        app: { kind: 'Application', spec: { components: ['web'] } },
      },
      [budget('app-budget', 50, 'deny', { kinds: ['Application'] })],
    );
    const findings = evaluateBudgets(m, report(m));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'IAP505',
      severity: 'error',
      path: '/resources/app',
    });
  });

  it('an Application budget over a lower-bound roll-up is unevaluable', () => {
    const m = model(
      {
        stream: { kind: 'Stream' },
        app: { kind: 'Application', spec: { components: ['stream'] } },
      },
      [budget('app-budget', 1, 'deny', { kinds: ['Application'] })],
    );
    const findings = evaluateBudgets(m, report(m));
    expect(findings[0]).toMatchObject({ severity: 'warning' });
    expect(findings[0].message).toContain('lower bound');
  });

  it('a non-budget policy is ignored', () => {
    const m = model({ web: service }, [
      {
        id: 'p',
        target: {},
        rule: { field: 'spec.size', operator: 'equals', value: 'm' },
        effect: 'deny',
      } as Policy,
    ]);
    expect(evaluateBudgets(m, report(m))).toEqual([]);
  });
});

describe('annotateModel (§16.1)', () => {
  it('attaches x-iap-cost to a copy and never mutates the input', () => {
    const m = model({ web: service });
    const r = report(m);
    const annotated = annotateModel(m, r);
    expect((annotated.resources.web as Record<string, unknown>)['x-iap-cost']).toEqual(
      r.resources.web,
    );
    expect((m.resources.web as Record<string, unknown>)['x-iap-cost']).toBeUndefined();
  });
});

describe('diffReports (§16.2 cost delta)', () => {
  it('reports per-resource and total monthly deltas', () => {
    const before = report(
      model({
        web: {
          kind: 'Service',
          spec: { size: 's', artifact: { type: 'container-image', reference: 'r/x:1' } },
        },
      }),
    );
    const after = report(
      model({
        web: {
          kind: 'Service',
          spec: { size: 'l', artifact: { type: 'container-image', reference: 'r/x:1' } },
        },
      }),
    );
    const diff = diffReports(before, after);
    expect(diff.resources.web.delta).toBe(
      Math.round((diff.resources.web.after! - diff.resources.web.before! + Number.EPSILON) * 100) /
        100,
    );
    expect(diff.totalDelta).toBe(
      Math.round((diff.totalAfter - diff.totalBefore + Number.EPSILON) * 100) / 100,
    );
    expect(diff.totalDelta).toBeGreaterThan(0); // l costs more than s
  });

  it('marks added and removed resources with null endpoints', () => {
    const before = report(model({ a: service }));
    const after = report(model({ a: service, b: service }));
    const diff = diffReports(before, after);
    expect(diff.resources.b.before).toBeNull();
    expect(diff.resources.b.delta).toBeNull();
  });
});
