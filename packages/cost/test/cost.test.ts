/**
 * `@iap/cost` — the cost model and estimation engine (spec ch. 16, IEP-0005).
 * Pins the schema/snapshot contract, the three-input determinism property
 * (§16.9), honest uncertainty (unknown carries no numbers; missing prices are
 * visible), roll-ups and their weakest-confidence lower-bound flagging, and the
 * deterministic optimization rules — all against the official example corpus.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from '@iap/sdk';
import type { CanonicalModel, CanonicalResource } from '@iap/model';
import {
  estimateCost,
  parseThroughput,
  quantityToGiB,
  referenceCostModel,
  referenceSnapshot,
  snapshotContentAddress,
  validateReport,
  validateSnapshot,
} from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
const example = (name: string): string => join(repoRoot, 'spec', 'examples', name);
const EXAMPLES = [
  'basic-webapp.iap.yaml',
  'serverless-api.iap.yaml',
  'data-processing.iap.yaml',
  'private-internal-service.iap.yaml',
  'hybrid-environment.iap.yaml',
  'enterprise-pci.iap.yaml',
];

async function modelOf(name: string, profile?: string): Promise<CanonicalModel> {
  const ws = await load({ path: example(name) }, profile === undefined ? {} : { profile });
  return ws.canonical().model;
}

const report = (model: CanonicalModel, snapshot = referenceSnapshot()) =>
  estimateCost(model, { costModel: referenceCostModel(), snapshot });

/** A minimal CanonicalModel for targeted edge cases. */
function miniModel(
  resources: Record<string, Partial<CanonicalResource> & { kind: string }>,
  edges: { source: string; target: string }[] = [],
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
    metadata: { name: 'mini' },
    resources: full,
    edges: edges.map((e) => ({
      source: e.source,
      type: 'connectsTo',
      target: e.target,
      attributes: {},
    })),
    policies: [],
    profile: null,
    hash: '0'.repeat(64),
    provenance: {},
    diagnostics: [],
  } as unknown as CanonicalModel;
}

describe('price snapshot', () => {
  it('the bundled reference snapshot is schema-valid', () => {
    expect(validateSnapshot(referenceSnapshot()).ok).toBe(true);
  });

  it('rejects a structurally invalid snapshot', () => {
    const bad = { ...referenceSnapshot(), currency: 'usd' }; // must be 3 upper-case letters
    expect(validateSnapshot(bad).ok).toBe(false);
  });

  it('the content address is deterministic and changes with the prices', () => {
    const a = snapshotContentAddress(referenceSnapshot());
    expect(a).toBe(snapshotContentAddress(referenceSnapshot()));
    expect(a).toMatch(/^reference-cloud-2026-07-01#sha256:[0-9a-f]{64}$/);
    const mutated = referenceSnapshot();
    mutated.prices['compute.size.m.hour'] = { unit: 'instance-hour', amount: 999 };
    expect(snapshotContentAddress(mutated)).not.toBe(a);
  });

  it('the embedded schema is byte-identical to the spec copy (no drift)', () => {
    for (const file of ['price-snapshot-v1.schema.json', 'cost-report-v1.schema.json']) {
      const embedded = readFileSync(join(__dirname, '..', 'schemas', file), 'utf8');
      const authority = readFileSync(join(repoRoot, 'spec', 'schema', file), 'utf8');
      expect(embedded).toBe(authority);
    }
  });
});

describe('estimation over the official examples', () => {
  it('every example produces a schema-valid cost report (resources expose cost metadata)', async () => {
    for (const name of EXAMPLES) {
      const r = report(await modelOf(name));
      const validation = validateReport(r);
      expect(validation.ok, `${name}: ${validation.errors.join('; ')}`).toBe(true);
      // Every resource has an entry with a confidence.
      expect(Object.keys(r.resources).length).toBeGreaterThan(0);
      for (const entry of Object.values(r.resources)) {
        expect(['exact', 'estimate', 'unknown']).toContain(entry.confidence);
      }
      expect(r.priceSnapshot).toBe(snapshotContentAddress(referenceSnapshot()));
      expect(r.costModel).toBe('reference-abstract@1.0.0');
    }
  });

  it('prices a service by mean replicas across its scaling range', async () => {
    const r = report(await modelOf('basic-webapp.iap.yaml'));
    // web: size m ($0.048/hr) × mean(1,4)=2.5 → 0.12/hr → 87.6/month.
    expect(r.resources.web.estimatedHourly).toBe(0.12);
    expect(r.resources.web.estimatedMonthly).toBe(87.6);
    expect(r.resources.web.confidence).toBe('estimate');
  });

  it('logical resources cost zero at exact confidence; gateways are flat/exact', async () => {
    const r = report(await modelOf('basic-webapp.iap.yaml'));
    expect(r.resources['web-identity']).toMatchObject({ estimatedMonthly: 0, confidence: 'exact' });
    expect(r.resources['storefront-app']).toMatchObject({
      estimatedMonthly: 0,
      confidence: 'exact',
    });
    expect(r.resources.edge.confidence).toBe('exact');
  });
});

describe('honest uncertainty (§16.2)', () => {
  it('an uncovered kind is reported unknown with no numbers and a reason', async () => {
    const r = report(await modelOf('data-processing.iap.yaml'));
    const stream = r.resources.clickstream; // Stream is not priced by the reference model
    expect(stream.confidence).toBe('unknown');
    expect(stream.estimatedMonthly).toBeUndefined();
    expect(stream.estimatedHourly).toBeUndefined();
    expect(stream.assumptions.join(' ')).toContain('does not price');
    // A total that omits an unknown member is a flagged lower bound.
    expect(r.totals.lowerBound).toBe(true);
    expect(r.totals.confidence).toBe('unknown');
  });

  it('a price missing from the snapshot degrades the resource to unknown, visibly', async () => {
    const snapshot = referenceSnapshot();
    delete snapshot.prices['gateway.hour'];
    const r = report(await modelOf('basic-webapp.iap.yaml'), snapshot);
    expect(r.resources.edge.confidence).toBe('unknown');
    expect(r.resources.edge.estimatedMonthly).toBeUndefined();
    expect(r.resources.edge.assumptions.join(' ')).toContain('price missing from snapshot');
    expect(r.resources.edge.assumptions.join(' ')).toContain('gateway.hour');
    expect(r.totals.lowerBound).toBe(true);
  });
});

describe('roll-ups (§16.3)', () => {
  it('sums an application over its components with weakest-member confidence', async () => {
    const r = report(await modelOf('basic-webapp.iap.yaml'));
    const app = r.rollups.byApplication['storefront-app'];
    expect(app.estimatedMonthly).toBe(r.totals.estimatedMonthly); // all resources belong to the app
    expect(app.confidence).toBe('estimate');
    expect(app.lowerBound).toBe(false);
  });

  it('a label roll-up aggregates resources carrying that label', async () => {
    const r = report(await modelOf('basic-webapp.iap.yaml'));
    // basic-webapp labels the web service tier=application.
    expect(Object.keys(r.rollups.byLabel).some((k) => k.startsWith('tier='))).toBe(true);
  });

  it('a roll-up including an unknown member is a flagged lower bound', () => {
    const model = miniModel({
      app: { kind: 'Application', spec: { components: ['db', 'stream'] } },
      db: {
        kind: 'Database',
        spec: { size: 'm', class: 'relational', capacity: { storage: '10Gi' } },
      },
      stream: { kind: 'Stream' },
    });
    const r = report(model);
    const app = r.rollups.byApplication.app;
    expect(app.lowerBound).toBe(true);
    expect(app.confidence).toBe('unknown');
    expect(app.estimatedMonthly).toBe(r.resources.db.estimatedMonthly); // stream omitted
  });
});

describe('determinism (§16.9)', () => {
  it('identical inputs produce a byte-identical report', async () => {
    const model = await modelOf('serverless-api.iap.yaml');
    const a = JSON.stringify(report(model));
    const b = JSON.stringify(report(model));
    expect(a).toBe(b);
  });

  it('the report is reproducible from the stored snapshot and records its inputs', async () => {
    const model = await modelOf('basic-webapp.iap.yaml');
    const r = report(model);
    expect(r.modelHash).toBe(model.hash);
    expect(r.priceSnapshot).toContain('#sha256:');
    // Reloading the same document reproduces the same report bytes.
    const again = report(await modelOf('basic-webapp.iap.yaml'));
    expect(JSON.stringify(again)).toBe(JSON.stringify(r));
  });

  it('a different profile yields a different report (per-profile, §16.3)', async () => {
    const base = report(await modelOf('basic-webapp.iap.yaml'));
    const prod = report(await modelOf('basic-webapp.iap.yaml', 'production'));
    expect(prod.profile).toBe('production');
    expect(base.profile).toBeNull();
    expect(prod.totals.estimatedMonthly).not.toBe(base.totals.estimatedMonthly);
  });
});

describe('optimization suggestions (§16.4)', () => {
  it('excess-availability fires on a high-availability resource with the savings delta', async () => {
    const r = report(await modelOf('serverless-api.iap.yaml'));
    const excess = r.suggestions.find((s) => s.rule === 'excess-availability');
    expect(excess).toBeDefined();
    expect(excess?.estimatedMonthlySavings).toBeGreaterThan(0);
  });

  it('orphaned-resource fires on a stateful resource with no inbound edge', () => {
    const model = miniModel(
      {
        web: {
          kind: 'Service',
          spec: { size: 'm', artifact: { type: 'container-image', reference: 'r/x:1' } },
        },
        lonely: {
          kind: 'Database',
          spec: { size: 'm', class: 'relational', capacity: { storage: '10Gi' } },
        },
        used: { kind: 'Cache', spec: { capacity: { memory: '1Gi' } } },
      },
      [{ source: 'web', target: 'used' }],
    );
    const r = report(model);
    const orphans = r.suggestions
      .filter((s) => s.rule === 'orphaned-resource')
      .map((s) => s.resource);
    expect(orphans).toContain('lonely');
    expect(orphans).not.toContain('used');
  });

  it('suggestions are deterministically ordered by (rule, resource)', () => {
    const model = miniModel({
      dbA: {
        kind: 'Database',
        spec: {
          size: 'm',
          class: 'relational',
          availability: 'high',
          capacity: { storage: '1Gi' },
        },
      },
      dbB: {
        kind: 'Database',
        spec: {
          size: 'm',
          class: 'relational',
          availability: 'high',
          capacity: { storage: '1Gi' },
        },
      },
    });
    const suggestions = report(model).suggestions;
    const keys = suggestions.map((s) => `${s.rule}:${s.resource}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('quantity helpers', () => {
  it('quantityToGiB converts binary quantities exactly', () => {
    expect(quantityToGiB('20Gi')).toBe(20);
    expect(quantityToGiB('512Mi')).toBe(0.5);
    expect(quantityToGiB('nonsense')).toBeNull();
    expect(quantityToGiB(undefined)).toBeNull();
  });

  it('parseThroughput reads the numeric magnitude and unit', () => {
    expect(parseThroughput('2000rps')).toEqual({ value: 2000, unit: 'rps' });
    expect(parseThroughput('20000iops')).toEqual({ value: 20000, unit: 'iops' });
    expect(parseThroughput('fast')).toBeNull();
  });
});
