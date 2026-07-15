/**
 * M3.2 facet compiler: pure, deterministic facets → proposal batch. Stable
 * content-derived ids, min-confidence aggregation, assumptions for every
 * defaulted value, explicit unsupported findings, unresolved references —
 * never a guess.
 */
import { describe, expect, it } from 'vitest';
import { CONFIDENCE_TIERS, compileFacets, emptyDocument, extractRules } from '../src/index';
import type { IaPDocument } from '@iap/model';
import type { OperationEnvelope } from '../src/index';
import { fixtureDocument } from './helpers';

const compileText = (input: string, document = emptyDocument('shop')) => {
  const extraction = extractRules(input, { inputId: 'req-1', document });
  return {
    extraction,
    compiled: compileFacets(extraction.facets, document, {}),
  };
};

const opIds = (ops: OperationEnvelope[] | undefined): string[] =>
  (ops ?? []).map((op) => op.operationId);

describe('deterministic compilation', () => {
  const INPUT =
    'A public web app running image registry.example.com/web:1.0.0 behind a gateway with a postgresql database and a redis cache';

  it('the same facets and document produce a deeply identical batch (ids included)', () => {
    const first = compileText(INPUT).compiled;
    const second = compileText(INPUT).compiled;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('operation ids derive from content, never randomness', () => {
    const { compiled } = compileText(INPUT);
    expect(opIds(compiled.batch?.operations)).toEqual([
      'op-create-edge',
      'op-create-web',
      'op-create-db',
      'op-create-cache',
      'op-connectsto-web-db',
      'op-connectsto-web-cache',
      'op-routesto-edge-web',
    ]);
  });

  it('resource ids collide deterministically against the document (suffix, never overwrite)', () => {
    const document = fixtureDocument(); // already contains "web"
    const { compiled } = compileText('a web app running image e.com/w:1', document);
    expect(compiled.batch?.operations[0]?.target.resourceId).toBe('web-2');
  });
});

describe('confidence aggregation (documented rule: minimum of contributing facets)', () => {
  it('a create folds in modifier facets and takes the lowest contributing confidence', () => {
    const { compiled } = compileText(
      'a highly available web app running image e.com/w:1', // workload 0.85, availability 0.95
    );
    const create = compiled.batch?.operations.find((op) => op.operationId === 'op-create-web');
    expect(create?.confidence).toBe(0.85);
    expect((create?.change as { spec: { availability: string } }).spec.availability).toBe('high');
  });

  it('inferred edges carry the inferred-association tier, below the gate threshold', () => {
    const { compiled } = compileText('an api running image e.com/a:1 with a postgresql database');
    const edge = compiled.batch?.operations.find((op) => op.type === 'CreateRelationship');
    expect(edge?.confidence).toBe(CONFIDENCE_TIERS['inferred-association']);
  });
});

describe('assumptions: defaulted values are never silently confident', () => {
  it('a generic cache assumes redis-compatible with a reason', () => {
    const { compiled } = compileText('add a cache for the api', fixtureDocument());
    const create = compiled.batch?.operations.find((op) => op.type === 'CreateResource');
    expect(create?.assumptions).toEqual([
      {
        field: 'spec.engine',
        assumed: 'redis-compatible',
        reason: 'cache engine not stated; redis-compatible is the deterministic default',
      },
    ]);
  });

  it('a generic database assumes class relational; a volume assumes 10Gi', () => {
    const { compiled } = compileText('a database and a persistent volume');
    const ops = compiled.batch?.operations ?? [];
    const db = ops.find((op) => op.operationId === 'op-create-db');
    expect(db?.assumptions[0]).toMatchObject({ field: 'spec.class', assumed: 'relational' });
    const volume = ops.find((op) => op.operationId === 'op-create-data');
    expect(volume?.assumptions[0]).toMatchObject({
      field: 'spec.capacity.storage',
      assumed: '10Gi',
    });
  });

  it('disaster recovery without stated objectives assumes RPO 1d / RTO 4h', () => {
    const { compiled } = compileText('a postgresql database with disaster recovery');
    const db = compiled.batch?.operations.find((op) => op.operationId === 'op-create-db');
    const fields = (db?.assumptions ?? []).map((assumption) => assumption.field).sort();
    expect(fields).toEqual([
      'spec.resilience.recoveryPointObjective',
      'spec.resilience.recoveryTimeObjective',
    ]);
  });

  it('stated objectives are explicit — no assumption entries', () => {
    const { compiled } = compileText(
      'a postgresql database with disaster recovery, RPO of 1 hour and RTO of 2 hours',
    );
    const db = compiled.batch?.operations.find((op) => op.operationId === 'op-create-db');
    expect(db?.assumptions).toEqual([]);
    const spec = (db?.change as { spec: { resilience: Record<string, string> } }).spec;
    expect(spec.resilience).toMatchObject({
      backup: 'required',
      recoveryPointObjective: '1h',
      recoveryTimeObjective: '2h',
    });
  });
});

describe('unsupported findings from compilation', () => {
  it('named provider regions compile to unsupported findings with the neutral suggestion', () => {
    const { compiled } = compileText('an api running image e.com/a:1 in eu-west-1');
    expect(compiled.unsupported).toHaveLength(1);
    expect(compiled.unsupported[0]).toMatchObject({
      capability: 'region eu-west-1',
      suggestion: 'availability: maximum (multi-region-capable, ch. 3 §3.2.1)',
    });
  });

  it('an impossible exposure for a kind is unsupported, never coerced silently', () => {
    const { compiled } = compileText('make the database public', fixtureDocument());
    expect(compiled.batch).toBeNull();
    expect(compiled.unsupported[0]?.capability).toBe('Database exposure public');
  });

  it('a Gateway asked to be private becomes internal WITH an assumption (its most restrictive value)', () => {
    const { compiled } = compileText('a private web app running image e.com/w:1 behind a gateway');
    const gateway = compiled.batch?.operations.find((op) => op.operationId === 'op-create-edge');
    expect((gateway?.change as { spec: { exposure: string } }).spec.exposure).toBe('internal');
    expect(gateway?.assumptions[0]).toMatchObject({ field: 'spec.exposure', assumed: 'internal' });
  });
});

describe('§3.5 updates against an existing document (minimal diffs)', () => {
  const document = fixtureDocument();

  it('"Move to maximum availability" updates exactly the availability-capable resources', () => {
    const { compiled } = compileText('Move to maximum availability', document);
    expect(opIds(compiled.batch?.operations)).toEqual(['op-update-orders-db', 'op-update-web']);
    for (const op of compiled.batch?.operations ?? []) {
      expect(op.change).toEqual({ set: { 'spec.availability': 'maximum' } });
    }
  });

  it('"Remove public access" targets only effectively public resources', () => {
    const { compiled } = compileText('Remove public access', document);
    // The fixture has no authored public exposure and no Gateway: nothing to change.
    expect(compiled.batch).toBeNull();
  });

  it('multiple modifiers on one resource merge into ONE update operation', () => {
    const extraction = extractRules('Make the orders-db internal', { inputId: 'r', document });
    extraction.facets.push({
      facet: 'availability',
      availability: 'high',
      subject: { resourceId: 'orders-db' },
      sourceSpan: { input: 'r', start: 0, end: 4, text: 'Make' },
      confidence: 0.95,
      channel: 'exact-keyword',
    });
    const compiled = compileFacets(extraction.facets, document, {});
    expect(opIds(compiled.batch?.operations)).toEqual(['op-update-orders-db']);
    expect(compiled.batch?.operations[0]?.change).toEqual({
      set: { 'spec.exposure': 'internal', 'spec.availability': 'high' },
    });
  });

  it('removal emits edge cleanup before the resource removal', () => {
    const { compiled } = compileText('Remove the orders-db', document);
    expect(opIds(compiled.batch?.operations)).toEqual([
      'op-remove-edge-web-orders-db',
      'op-remove-orders-db',
    ]);
    expect(compiled.batch?.operations[0]?.target.relationship).toEqual({
      type: 'connectsTo',
      target: 'orders-db',
    });
  });

  it('an unknown removal target compiles to an unresolved report, never an operation', () => {
    const { compiled } = compileText('Remove the reports-db', document);
    expect(compiled.batch).toBeNull();
    expect(compiled.unresolved[0]).toMatchObject({ reference: 'reports-db', candidates: [] });
  });
});

describe('profiles, policies, annotations', () => {
  it('environments compile to ApplyProfile only for profiles the document lacks', () => {
    const { compiled } = compileText(
      'production and staging environments',
      fixtureDocument(), // already has "production"
    );
    expect(opIds(compiled.batch?.operations)).toEqual(['op-profile-staging']);
  });

  it('compliance compiles the deterministic PCI DSS control set, skipping existing policy ids', () => {
    const document = fixtureDocument();
    const first = compileText('Add PCI DSS controls', document).compiled;
    expect(opIds(first.batch?.operations)).toEqual([
      'op-policy-pci-dss-encryption-at-rest',
      'op-policy-pci-dss-encryption-in-transit',
      'op-policy-pci-dss-no-public-data-stores',
      'op-policy-pci-dss-backup-required',
    ]);
    const withExisting = structuredClone(document) as IaPDocument;
    (withExisting.policies as { id: string }[]).push({
      id: 'pci-dss-encryption-at-rest',
    } as never);
    const second = compileText('Add PCI DSS controls', withExisting).compiled;
    expect(opIds(second.batch?.operations)).toEqual([
      'op-policy-pci-dss-encryption-in-transit',
      'op-policy-pci-dss-no-public-data-stores',
      'op-policy-pci-dss-backup-required',
    ]);
  });

  it('budget and provider preference become non-semantic annotations', () => {
    const { compiled } = compileText(
      'an api running image e.com/a:1 on aws with a monthly limit of $300',
    );
    const budget = compiled.batch?.operations.find((op) => op.operationId === 'op-set-budget');
    expect(budget?.change).toEqual({ set: { 'annotations.budget-monthly-usd': '300' } });
    const provider = compiled.batch?.operations.find(
      (op) => op.operationId === 'op-set-provider-preference',
    );
    expect(provider?.change).toEqual({ set: { 'annotations.provider-preference': 'aws' } });
  });
});

describe('provenance stamping', () => {
  it('every operation carries explicit-user provenance with the configured channel and audit ids', () => {
    const extraction = extractRules('a postgresql database', { inputId: 'req-1' });
    const compiled = compileFacets(extraction.facets, emptyDocument('shop'), {
      channel: 'ide-command',
      modelId: 'iap-rules@1',
      promptVersion: '1',
    });
    for (const op of compiled.batch?.operations ?? []) {
      expect(op.provenance).toEqual({
        source: 'explicit-user',
        channel: 'ide-command',
        modelId: 'iap-rules@1',
        promptVersion: '1',
      });
      expect(op.sourceSpan).toBeDefined();
    }
  });
});
