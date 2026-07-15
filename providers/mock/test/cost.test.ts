/**
 * The mock provider's cost model (spec ch. 16 §16.1: a cost model ships with a
 * provider mapping). Proves it implements the `@iap/cost` `CostModel` contract,
 * prices the mock substrate's realization, and — being a distinct model —
 * produces different numbers than the abstract reference model for the same
 * document.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalModel, CanonicalResource } from '@iap/model';
import { estimateCost, referenceCostModel, referenceSnapshot, validateReport } from '@iap/cost';
import { mockCostModel } from '../src/index';

function model(
  resources: Record<string, Partial<CanonicalResource> & { kind: string }>,
): CanonicalModel {
  const full: Record<string, CanonicalResource> = {};
  for (const [id, r] of Object.entries(resources)) {
    full[id] = {
      kind: r.kind as CanonicalResource['kind'],
      labels: {},
      spec: r.spec ?? {},
      extensions: {},
    };
  }
  return {
    apiVersion: 'iap.dev/v1',
    metadata: { name: 'mock-cost' },
    resources: full,
    edges: [],
    policies: [],
    profile: null,
    hash: '0'.repeat(64),
    provenance: {},
    diagnostics: [],
  } as unknown as CanonicalModel;
}

const SAMPLE = model({
  web: {
    kind: 'Service',
    spec: {
      size: 'm',
      scaling: { min: 1, max: 4 },
      artifact: { type: 'container-image', reference: 'r/x:1' },
    },
  },
  db: { kind: 'Database', spec: { size: 'm', class: 'relational', capacity: { storage: '20Gi' } } },
  bucket: { kind: 'ObjectStore', spec: {} },
  boom: { kind: 'Stream' },
});

describe('mockCostModel', () => {
  it('identifies itself and produces a schema-valid report', () => {
    const report = estimateCost(SAMPLE, {
      costModel: mockCostModel(),
      snapshot: referenceSnapshot(),
    });
    expect(report.costModel).toBe('mock-substrate@1.0.0');
    expect(validateReport(report).ok).toBe(true);
  });

  it('prices the mock realization: one node per managed resource + declared storage', () => {
    const report = estimateCost(SAMPLE, {
      costModel: mockCostModel(),
      snapshot: referenceSnapshot(),
    });
    // Service = 1 node (m: $0.048/hr × 730 = 35.04); no replica math (unlike reference).
    expect(report.resources.web.estimatedMonthly).toBe(35.04);
    expect(report.resources.db.confidence).toBe('estimate');
    expect(report.resources.db.estimatedMonthly).toBeGreaterThan(35.04); // node + 20Gi storage
  });

  it('reports an uncovered kind as unknown', () => {
    const report = estimateCost(SAMPLE, {
      costModel: mockCostModel(),
      snapshot: referenceSnapshot(),
    });
    expect(report.resources.boom.confidence).toBe('unknown');
    expect(report.resources.boom.estimatedMonthly).toBeUndefined();
  });

  it('the same document costs differently under the mock vs the reference model (ch. 16 intent)', () => {
    const mock = estimateCost(SAMPLE, {
      costModel: mockCostModel(),
      snapshot: referenceSnapshot(),
    });
    const ref = estimateCost(SAMPLE, {
      costModel: referenceCostModel(),
      snapshot: referenceSnapshot(),
    });
    expect(mock.resources.web.estimatedMonthly).not.toBe(ref.resources.web.estimatedMonthly);
  });
});
