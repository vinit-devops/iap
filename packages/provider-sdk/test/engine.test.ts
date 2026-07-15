import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { CanonicalModel, IaPDocument } from '@iap/model';
import { canonicalJsonStringify, canonicalize, sha256Hex } from '@iap/model';
import { loadDocument } from '@iap/parser';
import type { MappingArtifact, MappingDiagnostic, ProviderPlan } from '../src/index';
import { MAPPING_DIAGNOSTIC_REASONS, applyMapping } from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
const fixtures = join(__dirname, 'fixtures');

const webappMapping = parse(
  readFileSync(join(fixtures, 'webapp.iap-map.yaml'), 'utf8'),
) as MappingArtifact;
const tinyMapping = parse(
  readFileSync(join(fixtures, 'tiny-provider', 'mappings', 'core.iap-map.yaml'), 'utf8'),
) as MappingArtifact;

function webappModel(): CanonicalModel {
  const text = readFileSync(join(repoRoot, 'spec', 'examples', 'basic-webapp.iap.yaml'), 'utf8');
  const parsed = loadDocument(text);
  expect(parsed.ok).toBe(true);
  // basic-webapp declares a production profile; canonicalize against it.
  return canonicalize(parsed.document as IaPDocument, { profile: 'production' }).model;
}

function databaseDoc(spec: Record<string, unknown>): IaPDocument {
  return {
    apiVersion: 'iap.dev/v1',
    metadata: { name: 'engine-fixture' },
    resources: { 'orders-db': { kind: 'Database', spec } },
  } as IaPDocument;
}

const validDatabaseSpec = {
  class: 'relational',
  engine: 'postgresql',
  availability: 'high',
  encryption: { atRest: 'required', inTransit: 'required' },
};

function modelOf(doc: IaPDocument): CanonicalModel {
  return canonicalize(doc, { profile: null }).model;
}

function cloneMapping(mapping: MappingArtifact): MappingArtifact {
  return structuredClone(mapping);
}

function reasonsOf(result: ReturnType<typeof applyMapping>): string[] {
  return result.ok ? [] : result.diagnostics.map((d) => d.reason);
}

describe('applyMapping — plan shape (design decision 4)', () => {
  const model = webappModel();
  const result = applyMapping(model, webappMapping);

  it('produces a plan for the full basic-webapp example (production profile)', () => {
    expect(result.ok).toBe(true);
  });

  const plan = (result as { ok: true; plan: ProviderPlan }).plan;

  it('carries the plan envelope fields', () => {
    expect(plan.formatVersion).toBe(1);
    expect(plan.provider).toBe('tiny');
    expect(plan.mappingVersion).toBe('1.0.0');
    expect(plan.specVersion).toBe('1.0.0');
    expect(plan.profile).toBe('production');
    expect(plan.documentHash).toBe(model.hash);
    expect(plan.inputs).toEqual({});
  });

  it('emits resources sorted by resource ID with deterministic logical ids', () => {
    expect(plan.resources.map((r) => r.logicalId)).toEqual([
      'assets.tiny:blob:Bucket',
      'edge.tiny:lb:LoadBalancer',
      'edge.tiny:certs:Certificate',
      'orders-db.tiny:sql:Instance',
      'orders-db.tiny:secrets:Secret',
      'session-cache.tiny:cache:Cluster',
      'session-cache.tiny:secrets:Secret',
      'storefront-app.tiny:group:Group',
      'web.tiny:compute:Service',
      'web-identity.tiny:iam:Role',
    ]);
    for (const resource of plan.resources) {
      expect(resource.logicalId).toBe(`${resource.logicalId.split('.', 1)[0]}.${resource.type}`);
      expect(resource.lifecycle).toEqual({ createOnly: [], replaceOn: [], updateInPlace: [] });
      expect(resource.sensitiveFields).toEqual([]);
    }
  });

  it('derives profile-merged attribute values through maps, verbatim and constants', () => {
    const web = plan.resources.find((r) => r.logicalId === 'web.tiny:compute:Service');
    expect(web?.desiredAttributes).toMatchObject({
      cpu: 2048, // size l via the production profile
      replicasMin: 2,
      replicasMax: 6,
      image: 'registry.example.com/storefront:1.4.2',
    });
    const db = plan.resources.find((r) => r.logicalId === 'orders-db.tiny:sql:Instance');
    expect(db?.desiredAttributes).toMatchObject({
      engine: 'postgres',
      multiZone: true, // availability high via the production profile
      encrypted: true,
      storage: '20Gi',
      public: false,
    });
  });

  it('EVERY desiredAttributes entry has exactly one provenance record', () => {
    for (const resource of plan.resources) {
      expect(Object.keys(resource.provenance).sort()).toEqual(
        Object.keys(resource.desiredAttributes).sort(),
      );
      for (const record of Object.values(resource.provenance)) {
        expect(['constant', 'from', 'map']).toContain(record.form);
        expect(typeof record.ruleIndex).toBe('number');
        if (record.form !== 'constant') expect(record.source).toMatch(/^spec\./);
      }
    }
  });

  it('records the derive form and source field per attribute', () => {
    const db = plan.resources.find((r) => r.logicalId === 'orders-db.tiny:sql:Instance');
    expect(db?.provenance.engine).toEqual({ form: 'map', source: 'spec.engine', ruleIndex: 0 });
    expect(db?.provenance.storage).toEqual({
      form: 'from',
      source: 'spec.capacity.storage',
      ruleIndex: 0,
    });
    expect(db?.provenance.public).toEqual({ form: 'constant', ruleIndex: 0 });
  });

  it('binds every abstract output attribute of every kind (ch. 12 §12.5)', () => {
    expect(plan.outputBindings['orders-db']).toEqual({
      connectionSecret: { logicalId: 'orders-db.tiny:secrets:Secret', attribute: 'ref' },
      endpoint: { logicalId: 'orders-db.tiny:sql:Instance', attribute: 'endpoint' },
      identifier: { logicalId: 'orders-db.tiny:sql:Instance', attribute: 'id' },
    });
    expect(plan.outputBindings.web).toEqual({
      endpoint: { logicalId: 'web.tiny:compute:Service', attribute: 'dnsName' },
      identifier: { logicalId: 'web.tiny:compute:Service', attribute: 'id' },
    });
    expect(Object.keys(plan.outputBindings).sort()).toEqual([
      'assets',
      'edge',
      'orders-db',
      'session-cache',
      'storefront-app',
      'web',
      'web-identity',
    ]);
  });

  it('derives dependsOn from canonical edges, sorted', () => {
    const web = plan.resources.find((r) => r.logicalId === 'web.tiny:compute:Service');
    expect(web?.dependsOn).toEqual([
      'assets.tiny:blob:Bucket',
      'orders-db.tiny:secrets:Secret',
      'orders-db.tiny:sql:Instance',
      'session-cache.tiny:cache:Cluster',
      'session-cache.tiny:secrets:Secret',
      'web-identity.tiny:iam:Role',
    ]);
    const edge = plan.resources.find((r) => r.logicalId === 'edge.tiny:lb:LoadBalancer');
    expect(edge?.dependsOn).toEqual(['web.tiny:compute:Service']);
    const group = plan.resources.find((r) => r.logicalId === 'storefront-app.tiny:group:Group');
    expect(group?.dependsOn).toEqual([]);
  });

  it('planHash is the SHA-256 of the canonical plan serialization excluding planHash', () => {
    const { planHash, ...content } = plan;
    expect(planHash).toBe(sha256Hex(canonicalJsonStringify(content)));
  });
});

describe('applyMapping — determinism and purity (CM-6, PC-3)', () => {
  it('double-run produces byte-identical canonical plans and equal hashes', () => {
    const modelA = webappModel();
    const modelB = webappModel();
    const runA = applyMapping(modelA, webappMapping);
    const runB = applyMapping(modelB, webappMapping);
    expect(runA.ok && runB.ok).toBe(true);
    if (runA.ok && runB.ok) {
      expect(canonicalJsonStringify(runA.plan)).toBe(canonicalJsonStringify(runB.plan));
      expect(runA.plan.planHash).toBe(runB.plan.planHash);
    }
  });

  it('never modifies the input model (non-interference) and deep-freezes it', () => {
    const model = webappModel();
    const before = canonicalJsonStringify(model);
    const hashBefore = model.hash;
    const result = applyMapping(model, webappMapping);
    expect(result.ok).toBe(true);
    expect(canonicalJsonStringify(model)).toBe(before);
    expect(model.hash).toBe(hashBefore);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.resources)).toBe(true);
    expect(Object.isFrozen(model.resources['orders-db']?.spec)).toBe(true);
    expect(() => {
      (model.resources['orders-db'] as { kind: string }).kind = 'Cache';
    }).toThrow(TypeError);
  });

  it('explicit mapping inputs are recorded in the plan and change its hash', () => {
    const base = applyMapping(webappModel(), webappMapping);
    const withInputs = applyMapping(webappModel(), webappMapping, {
      inputs: { discoverySnapshot: 'disc-01' },
    });
    expect(base.ok && withInputs.ok).toBe(true);
    if (base.ok && withInputs.ok) {
      expect(withInputs.plan.inputs).toEqual({ discoverySnapshot: 'disc-01' });
      expect(withInputs.plan.planHash).not.toBe(base.plan.planHash);
    }
  });

  it('throws TypeError on a profile mismatch (the model owns profile merging)', () => {
    expect(() => applyMapping(webappModel(), webappMapping, { profile: 'development' })).toThrow(
      TypeError,
    );
  });

  it('throws TypeError on non-scalar mapping inputs', () => {
    expect(() =>
      applyMapping(webappModel(), webappMapping, {
        inputs: { snapshot: { nested: true } } as never,
      }),
    ).toThrow(TypeError);
  });
});

describe('applyMapping — fail-closed diagnostics (ch. 12 §12.3, design decision 3)', () => {
  it('the reason taxonomy is closed', () => {
    expect([...MAPPING_DIAGNOSTIC_REASONS]).toEqual([
      'unsupported-kind',
      'unsupported-field',
      'unsupported-value',
      'unsupported-relationship',
      'no-realize-rule',
      'derive-map-gap',
      'unbound-output',
      'spec-compat',
      'newer-minor-construct',
    ]);
  });

  it('unsupported-kind: names the kind and resource', () => {
    const doc = {
      apiVersion: 'iap.dev/v1',
      metadata: { name: 'engine-fixture' },
      resources: {
        'session-cache': { kind: 'Cache', spec: { engine: 'redis-compatible' } },
      },
    } as unknown as IaPDocument;
    const result = applyMapping(modelOf(doc), tinyMapping);
    expect(reasonsOf(result)).toEqual(['unsupported-kind']);
    if (!result.ok) {
      expect(result.diagnostics[0]).toMatchObject({
        kind: 'Cache',
        resourceId: 'session-cache',
      });
    }
  });

  it('unsupported-field: names the exact canonical field path', () => {
    const mapping = cloneMapping(tinyMapping);
    const database = mapping.mappings.Database;
    database!.supports.fields = database!.supports.fields.filter((f) => f !== 'spec.size');
    const result = applyMapping(modelOf(databaseDoc(validDatabaseSpec)), mapping);
    expect(reasonsOf(result)).toEqual(['unsupported-field']);
    if (!result.ok) {
      expect(result.diagnostics[0]).toMatchObject({
        reason: 'unsupported-field',
        resourceId: 'orders-db',
        field: 'spec.size', // materialized default — still never silently dropped
      });
    }
  });

  it('unsupported-value: rejects availability maximum outside the matrix', () => {
    const result = applyMapping(
      modelOf(databaseDoc({ ...validDatabaseSpec, availability: 'maximum' })),
      tinyMapping,
    );
    expect(reasonsOf(result)).toEqual(['unsupported-value']);
    if (!result.ok) {
      expect(result.diagnostics[0]).toMatchObject({
        field: 'spec.availability',
        value: 'maximum',
        resourceId: 'orders-db',
      });
      expect(result.diagnostics[0]?.message).toContain('standard');
    }
  });

  it('unsupported-relationship: names the verb', () => {
    const doc = {
      apiVersion: 'iap.dev/v1',
      metadata: { name: 'engine-fixture' },
      resources: {
        'orders-db': { kind: 'Database', spec: validDatabaseSpec },
        events: {
          kind: 'Queue',
          spec: {},
          relationships: [{ type: 'monitoredBy', target: 'orders-db' }],
        },
      },
    } as unknown as IaPDocument;
    const result = applyMapping(modelOf(doc), tinyMapping);
    expect(reasonsOf(result)).toEqual(['unsupported-relationship']);
    if (!result.ok) {
      expect(result.diagnostics[0]).toMatchObject({
        resourceId: 'events',
        verb: 'monitoredBy',
      });
    }
  });

  it('no-realize-rule: in-matrix resource matched by no rule fails the run', () => {
    const mapping = cloneMapping(tinyMapping);
    mapping.mappings.Database!.realize[0]!.when = { 'spec.engine': 'mysql' };
    const result = applyMapping(modelOf(databaseDoc(validDatabaseSpec)), mapping);
    expect(reasonsOf(result)).toEqual(['no-realize-rule']);
  });

  it('derive-map-gap: value with no map entry is a loud defect, not a fallback', () => {
    const mapping = cloneMapping(tinyMapping);
    const derive = mapping.mappings.Database!.realize[0]!.derive!;
    delete (derive['tiny:sql:Instance.engine']!.map as Record<string, unknown>).postgresql;
    const result = applyMapping(modelOf(databaseDoc(validDatabaseSpec)), mapping);
    expect(reasonsOf(result)).toEqual(['derive-map-gap']);
    if (!result.ok) {
      expect(result.diagnostics[0]).toMatchObject({
        field: 'spec.engine',
        value: 'postgresql',
      });
    }
  });

  it('unbound-output: missing binding for a declared abstract attribute', () => {
    const mapping = cloneMapping(tinyMapping);
    delete mapping.mappings.Database!.outputs!.connectionSecret;
    const result = applyMapping(modelOf(databaseDoc(validDatabaseSpec)), mapping);
    expect(reasonsOf(result)).toEqual(['unbound-output']);
    if (!result.ok) expect(result.diagnostics[0]?.field).toBe('connectionSecret');
  });

  it('unbound-output: binding to a target the matched rule does not produce', () => {
    const mapping = cloneMapping(tinyMapping);
    mapping.mappings.Database!.outputs!.connectionSecret = { from: 'tiny:queue:Queue.ref' };
    const result = applyMapping(modelOf(databaseDoc(validDatabaseSpec)), mapping);
    expect(reasonsOf(result)).toEqual(['unbound-output']);
  });

  it('spec-compat: refuses to plan against an excluded specification version', () => {
    const result = applyMapping(modelOf(databaseDoc(validDatabaseSpec)), tinyMapping, {
      specVersion: '2.5.0',
    });
    expect(reasonsOf(result)).toEqual(['spec-compat']);
  });

  it('newer-minor-construct: unknown spec field is rejected, not IAP804-warned', () => {
    const doc = databaseDoc({ ...validDatabaseSpec, futureKnob: 'on' });
    const result = applyMapping(modelOf(doc), tinyMapping);
    expect(reasonsOf(result)).toEqual(['newer-minor-construct']);
    if (!result.ok) expect(result.diagnostics[0]?.field).toBe('spec.futureKnob');
  });

  it('collects every defect in one run, deterministically ordered', () => {
    const doc = {
      apiVersion: 'iap.dev/v1',
      metadata: { name: 'engine-fixture' },
      resources: {
        'orders-db': {
          kind: 'Database',
          spec: { ...validDatabaseSpec, availability: 'maximum' },
        },
        events: {
          kind: 'Queue',
          spec: {},
          relationships: [{ type: 'monitoredBy', target: 'orders-db' }],
        },
        'session-cache': { kind: 'Cache', spec: { engine: 'redis-compatible' } },
      },
    } as unknown as IaPDocument;
    const runA = applyMapping(modelOf(doc), tinyMapping);
    const runB = applyMapping(modelOf(doc), tinyMapping);
    expect(reasonsOf(runA)).toEqual([
      'unsupported-relationship',
      'unsupported-value',
      'unsupported-kind',
    ]);
    expect(runA).toEqual(runB);
  });

  it('never emits a plan alongside diagnostics (complete or absent)', () => {
    const result = applyMapping(
      modelOf(databaseDoc({ ...validDatabaseSpec, availability: 'maximum' })),
      tinyMapping,
    ) as { ok: false; plan?: unknown; diagnostics: MappingDiagnostic[] };
    expect(result.ok).toBe(false);
    expect(result.plan).toBeUndefined();
  });
});

describe('applyMapping — edge semantics', () => {
  it('x-* spec annotations are non-semantic passthrough, never unsupported fields', () => {
    const doc = databaseDoc({ ...validDatabaseSpec, 'x-note': 'annotation' });
    const result = applyMapping(modelOf(doc), tinyMapping);
    expect(result.ok).toBe(true);
  });

  it('an absent optional source field yields an absent attribute, not an error', () => {
    const mapping = cloneMapping(tinyMapping);
    mapping.mappings.Database!.realize[0]!.derive!['tiny:sql:Instance.engineVersion'] = {
      from: 'spec.engineVersion',
    };
    const result = applyMapping(modelOf(databaseDoc(validDatabaseSpec)), mapping);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const db = result.plan.resources.find((r) => r.logicalId === 'orders-db.tiny:sql:Instance');
      expect(db?.desiredAttributes).not.toHaveProperty('engineVersion');
      expect(db?.provenance).not.toHaveProperty('engineVersion');
    }
  });

  it('first-match-wins: a fifo queue takes the first rule, everything else the default', () => {
    const doc = {
      apiVersion: 'iap.dev/v1',
      metadata: { name: 'engine-fixture' },
      resources: {
        fast: { kind: 'Queue', spec: { ordering: 'fifo' } },
        slow: { kind: 'Queue', spec: {} },
      },
    } as unknown as IaPDocument;
    const result = applyMapping(modelOf(doc), tinyMapping);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fast = result.plan.resources.find((r) => r.logicalId === 'fast.tiny:queue:Queue');
      const slow = result.plan.resources.find((r) => r.logicalId === 'slow.tiny:queue:Queue');
      expect(fast?.desiredAttributes.fifo).toBe(true);
      expect(fast?.provenance.fifo?.ruleIndex).toBe(0);
      expect(slow?.desiredAttributes.fifo).toBe(false);
      expect(slow?.provenance.fifo?.ruleIndex).toBe(1);
      // bare derive keys bind to the rule's first target
      expect(fast?.desiredAttributes.retention).toBe('7d');
    }
  });
});
