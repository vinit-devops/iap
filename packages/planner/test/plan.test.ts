import { describe, expect, it } from 'vitest';
import {
  PLANNER_VERSION,
  PLAN_API_VERSION,
  buildPlan,
  canonicalPlanSerialization,
  computeInputsHash,
  emptySnapshot,
  plan,
  validatePlanArtifact,
} from '../src/index';
import type { DeterminismInputs, PlanArtifact, RiskAnnotator } from '../src/index';
import {
  removeResource,
  reverseKeys,
  stateFromPlan,
  syntheticPlan,
  webshopDocument,
  webshopPlan,
} from './helpers';

function assertValid(artifact: PlanArtifact): void {
  const result = validatePlanArtifact(artifact);
  if (!result.ok) throw new Error(`schema-invalid plan: ${result.errors.join('; ')}`);
}

describe('empty state ⇒ full create plan', () => {
  const desired = webshopPlan();
  const artifact = plan(desired, emptySnapshot());

  it('emits a schema-valid plan.iap.dev/v1 artifact without envelope', () => {
    expect(artifact.apiVersion).toBe(PLAN_API_VERSION);
    expect(artifact.planId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact.envelope).toBeUndefined();
    assertValid(artifact);
  });

  it('schedules all creates in dependsOn-respecting waves', () => {
    expect(artifact.content.waves.map((wave) => wave.map((entry) => entry.resource))).toEqual([
      [
        'api-token.mock:core:SecretBox',
        'emails.mock:core:Queue',
        'jobs.mock:core:Queue',
        'orders-db.mock:core:SecretBox',
        'orders-db.mock:core:Store',
      ],
      ['web.mock:core:Compute'],
    ]);
    for (const wave of artifact.content.waves) {
      for (const entry of wave) expect(entry.action).toBe('create');
    }
  });

  it('lists destructiveActions as an always-present empty array', () => {
    expect(artifact.content.destructiveActions).toEqual([]);
  });

  it('emits one verification entry per scheduled resource', () => {
    expect(artifact.content.verification).toHaveLength(6);
    expect(new Set(artifact.content.verification.map((v) => v.check))).toEqual(
      new Set(['created']),
    );
  });

  it('marks every output-bound attribute as an unknown value', () => {
    expect(artifact.content.unknownValues).toEqual([
      { resource: 'api-token.mock:core:SecretBox', attribute: 'id', reason: 'output-binding' },
      { resource: 'emails.mock:core:Queue', attribute: 'endpoint', reason: 'output-binding' },
      { resource: 'emails.mock:core:Queue', attribute: 'id', reason: 'output-binding' },
      { resource: 'jobs.mock:core:Queue', attribute: 'endpoint', reason: 'output-binding' },
      { resource: 'jobs.mock:core:Queue', attribute: 'id', reason: 'output-binding' },
      { resource: 'orders-db.mock:core:SecretBox', attribute: 'ref', reason: 'output-binding' },
      { resource: 'orders-db.mock:core:Store', attribute: 'endpoint', reason: 'output-binding' },
      { resource: 'orders-db.mock:core:Store', attribute: 'id', reason: 'output-binding' },
      { resource: 'web.mock:core:Compute', attribute: 'endpoint', reason: 'output-binding' },
      { resource: 'web.mock:core:Compute', attribute: 'id', reason: 'output-binding' },
    ]);
  });

  it('records the derived identities and a recomputable inputsHash', () => {
    const inputs = artifact.content.inputs;
    expect(inputs.documentHash).toBe(`sha256:${desired.documentHash}`);
    expect(inputs.target).toEqual({ provider: 'mock', profile: 'production' });
    expect(inputs.mappingVersions).toEqual({ mock: '1.1.0' });
    expect(inputs.stateRevision).toBe(0);
    expect(inputs.plannerVersion).toBe(PLANNER_VERSION);
    const { inputsHash, ...identities } = inputs;
    expect(inputsHash).toBe(computeInputsHash(identities));
  });

  it('emits the honest default deltas and the rollback contract', () => {
    expect(artifact.content.deltas.cost).toEqual({
      status: 'unavailable',
      reason: 'no-pricing-snapshot',
    });
    // Creates establish security posture, so their exposure/encryption-
    // sourced fields surface as security deltas too (design decision 5).
    expect(artifact.content.deltas.security).toEqual([
      {
        resource: 'orders-db.mock:core:Store',
        field: 'encrypted',
        source: 'spec.encryption.atRest',
      },
      { resource: 'web.mock:core:Compute', field: 'reachable', source: 'spec.exposure' },
      {
        resource: 'web.mock:core:Compute',
        field: 'tlsInternal',
        source: 'spec.encryption.inTransit',
      },
    ]);
    expect(artifact.content.deltas.compliance).toEqual({ deferred: 'phase-11', findings: [] });
    expect(artifact.content.rollback).toEqual({
      strategy: 're-plan-to-revision',
      limitations: [],
    });
    expect(artifact.content.approvalsRequired).toEqual([]);
  });

  it('annotates risk from the default rule table (creates + security boundary)', () => {
    expect(artifact.content.risk).toEqual({
      score: 27, // 6 creates × 2 + 3 security-boundary entries × 5
      class: 'medium',
      factors: [
        {
          id: 'create',
          weight: 12,
          resources: [
            'api-token.mock:core:SecretBox',
            'emails.mock:core:Queue',
            'jobs.mock:core:Queue',
            'orders-db.mock:core:SecretBox',
            'orders-db.mock:core:Store',
            'web.mock:core:Compute',
          ],
        },
        {
          id: 'security-boundary-change',
          weight: 15,
          resources: ['orders-db.mock:core:Store', 'web.mock:core:Compute'],
        },
      ],
    });
  });
});

describe('determinism (CP-2/CP-3, PL-1 groundwork)', () => {
  it('double-run from scratch is byte-identical with equal planId', () => {
    const first = plan(webshopPlan(), emptySnapshot());
    const second = plan(webshopPlan(), emptySnapshot());
    expect(canonicalPlanSerialization(second.content)).toBe(
      canonicalPlanSerialization(first.content),
    );
    expect(second.planId).toBe(first.planId);
  });

  it('is independent of source key order end-to-end (exit criterion 2)', () => {
    const base = plan(webshopPlan(), emptySnapshot());
    const shuffled = plan(
      webshopPlan({ mutateDocument: () => undefined, profile: 'production' }),
      emptySnapshot(),
    );
    // Shuffle every object key in the parsed document, re-run the pipeline.
    const document = reverseKeys(webshopDocument());
    const shuffledPlan = plan(
      webshopPlan({
        mutateDocument: (target) => {
          for (const key of Object.keys(target)) {
            delete (target as unknown as Record<string, unknown>)[key];
          }
          Object.assign(target, document);
        },
      }),
      emptySnapshot(),
    );
    expect(shuffled.planId).toBe(base.planId);
    expect(shuffledPlan.planId).toBe(base.planId);
    expect(canonicalPlanSerialization(shuffledPlan.content)).toBe(
      canonicalPlanSerialization(base.content),
    );
  });

  it('contains no RFC 3339 timestamps in canonical content (PL-5)', () => {
    const artifact = plan(webshopPlan(), emptySnapshot(), {
      discoverySnapshot: 'disc-2026-07-09-01',
      pricingSnapshot: 'price-2026-07-01',
    });
    const serialized = canonicalPlanSerialization(artifact.content);
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe('update-in-place vs replace (PL-3 groundwork)', () => {
  it('classifies a mutable-field difference as a non-destructive update', () => {
    const desired = webshopPlan();
    const state = stateFromPlan(desired, (objects) => {
      (
        objects['orders-db.mock:core:Store'] as { attributes: Record<string, unknown> }
      ).attributes.multiZone = false;
    });
    const artifact = plan(desired, state);
    assertValid(artifact);
    expect(artifact.content.waves).toEqual([
      [
        expect.objectContaining({
          resource: 'orders-db.mock:core:Store',
          action: 'update-in-place',
          fields: ['multiZone'],
          destructive: false,
        }),
      ],
    ]);
    expect(artifact.content.destructiveActions).toEqual([]);
    expect(artifact.content.verification).toEqual([
      { resource: 'orders-db.mock:core:Store', check: 'attributes-applied' },
    ]);
    // Only the changed resource's late-bound outputs are unknown.
    expect(artifact.content.unknownValues).toEqual([
      { resource: 'orders-db.mock:core:Store', attribute: 'endpoint', reason: 'output-binding' },
      { resource: 'orders-db.mock:core:Store', attribute: 'id', reason: 'output-binding' },
    ]);
  });

  it('classifies a replaceOn-field difference as a destructive replace', () => {
    const desired = webshopPlan({
      mutatePlan: (p) => {
        const store = p.resources.find((r) => r.logicalId === 'orders-db.mock:core:Store');
        if (store) store.lifecycle.replaceOn = ['engine'];
      },
    });
    const state = stateFromPlan(desired, (objects) => {
      (
        objects['orders-db.mock:core:Store'] as { attributes: Record<string, unknown> }
      ).attributes.engine = 'mysql';
    });
    const artifact = plan(desired, state);
    assertValid(artifact);
    const entry = artifact.content.waves[0]?.[0];
    expect(entry?.action).toBe('replace');
    expect(entry?.fields).toEqual(['engine']);
    expect(entry?.destructive).toBe(true);
    expect(artifact.content.destructiveActions).toEqual([
      {
        resource: 'orders-db.mock:core:Store',
        action: 'replace',
        reversibility: 'reversible-with-data-risk',
      },
    ]);
    expect(artifact.content.verification).toEqual([
      { resource: 'orders-db.mock:core:Store', check: 'successor-ready' },
    ]);
    // A stateful replace gates on human approval (ch. 19 §19.6) but is not
    // irreversible, so it produces no rollback limitation.
    expect(artifact.content.approvalsRequired).toEqual([
      { resource: 'orders-db.mock:core:Store', gate: 'stateful-replace' },
    ]);
    expect(artifact.content.rollback.limitations).toEqual([]);
  });

  it('classifies a stateless replace as replacement-based recovery', () => {
    const desired = webshopPlan({
      mutatePlan: (p) => {
        const compute = p.resources.find((r) => r.logicalId === 'web.mock:core:Compute');
        if (compute) compute.lifecycle.replaceOn = ['image'];
      },
    });
    const state = stateFromPlan(desired, (objects) => {
      (
        objects['web.mock:core:Compute'] as { attributes: Record<string, unknown> }
      ).attributes.image = 'registry.example.com/webshop:1.0.0';
    });
    const artifact = plan(desired, state);
    expect(artifact.content.destructiveActions).toEqual([
      {
        resource: 'web.mock:core:Compute',
        action: 'replace',
        reversibility: 'replacement-based-recovery',
      },
    ]);
    expect(artifact.content.approvalsRequired).toEqual([
      { resource: 'web.mock:core:Compute', gate: 'destructive-replace' },
    ]);
    expect(artifact.content.rollback.limitations).toEqual([]);
  });
});

describe('delete ordering and import', () => {
  it('schedules deletes after forward waves in reverse dependency order', () => {
    const full = webshopPlan();
    const desired = webshopPlan({
      mutateDocument: (document) => {
        removeResource(document, 'web');
        removeResource(document, 'orders-db');
        const resources = (document as unknown as { resources: Record<string, unknown> }).resources;
        (resources.jobs as { spec: Record<string, unknown> }).spec.messageRetention = '5d';
      },
    });
    const artifact = plan(desired, stateFromPlan(full));
    assertValid(artifact);
    expect(
      artifact.content.waves.map((wave) => wave.map((e) => `${e.action} ${e.resource}`)),
    ).toEqual([
      ['update-in-place jobs.mock:core:Queue'],
      ['delete web.mock:core:Compute'],
      ['delete orders-db.mock:core:SecretBox', 'delete orders-db.mock:core:Store'],
    ]);
    // PL-3: every delete appears in destructiveActions with reversibility.
    expect(artifact.content.destructiveActions.map((d) => d.resource)).toEqual([
      'orders-db.mock:core:SecretBox',
      'orders-db.mock:core:Store',
      'web.mock:core:Compute',
    ]);
    for (const destructive of artifact.content.destructiveActions) {
      expect(destructive.action).toBe('delete');
      expect(destructive.reversibility).toBe('irreversible');
    }
    // Deletes verify removal; the update verifies applied attributes.
    expect(artifact.content.verification.map((v) => v.check).sort()).toEqual([
      'attributes-applied',
      'removed',
      'removed',
      'removed',
    ]);
    // Unsupported rollback is explicitly reported (exit criterion 4): one
    // limitation per irreversible action, and only for those.
    expect(artifact.content.rollback.limitations.map((l) => l.resource)).toEqual([
      'orders-db.mock:core:SecretBox',
      'orders-db.mock:core:Store',
      'web.mock:core:Compute',
    ]);
    for (const limitation of artifact.content.rollback.limitations) {
      expect(limitation.reason).toContain('no restore source');
    }
    // Every destructive action carries its approval gate (ch. 14/19).
    expect(artifact.content.approvalsRequired).toEqual([
      { resource: 'orders-db.mock:core:SecretBox', gate: 'stateful-delete' },
      { resource: 'orders-db.mock:core:Store', gate: 'stateful-delete' },
      { resource: 'web.mock:core:Compute', gate: 'stateful-delete' },
    ]);
  });

  it('imports an existing unmanaged object — never a blind update', () => {
    const desired = webshopPlan();
    const state = stateFromPlan(desired, (objects) => {
      const web = objects['web.mock:core:Compute'] as {
        managed: boolean;
        attributes: Record<string, unknown>;
      };
      web.managed = false;
      web.attributes.cpuUnits = 512;
    });
    const artifact = plan(desired, state);
    assertValid(artifact);
    const entry = artifact.content.waves[0]?.[0];
    expect(entry?.action).toBe('import');
    expect(entry?.provenance.changedBy).toBe('stateRevision');
    expect(artifact.content.destructiveActions).toEqual([]);
    expect(artifact.content.verification).toEqual([
      { resource: 'web.mock:core:Compute', check: 'adopted' },
    ]);
  });
});

describe('secret hygiene (PL-5 groundwork)', () => {
  it('never embeds sensitive values; marks the attribute as unknown instead', () => {
    const secret = 'S3CR3T-raw-material-never-in-plan';
    const desired = webshopPlan({
      mutatePlan: (p) => {
        const box = p.resources.find((r) => r.logicalId === 'api-token.mock:core:SecretBox');
        if (box) {
          box.sensitiveFields = ['material'];
          box.desiredAttributes.material = secret;
        }
      },
    });
    const artifact = plan(desired, emptySnapshot());
    assertValid(artifact);
    expect(canonicalPlanSerialization(artifact.content)).not.toContain(secret);
    expect(artifact.content.unknownValues).toContainEqual({
      resource: 'api-token.mock:core:SecretBox',
      attribute: 'material',
      reason: 'sensitive',
    });
  });
});

describe('deltas (design decision 5)', () => {
  it('defers cost when a pricing snapshot is pinned', () => {
    const artifact = plan(webshopPlan(), emptySnapshot(), {
      pricingSnapshot: 'price-2026-07-01',
    });
    expect(artifact.content.deltas.cost).toEqual({
      status: 'deferred',
      reason: 'pricing-deferred-phase-10',
      pricingSnapshot: 'price-2026-07-01',
    });
    assertValid(artifact);
  });

  it('derives security deltas from exposure/encryption-sourced changes', () => {
    const desired = webshopPlan();
    const state = stateFromPlan(desired, (objects) => {
      const compute = objects['web.mock:core:Compute'] as {
        attributes: Record<string, unknown>;
      };
      compute.attributes.reachable = 'mesh'; // desired: network (spec.exposure internal)
      compute.attributes.tlsInternal = false; // desired: true (spec.encryption.inTransit)
    });
    const artifact = plan(desired, state);
    expect(artifact.content.deltas.security).toEqual([
      { resource: 'web.mock:core:Compute', field: 'reachable', source: 'spec.exposure' },
      {
        resource: 'web.mock:core:Compute',
        field: 'tlsInternal',
        source: 'spec.encryption.inTransit',
      },
    ]);
    assertValid(artifact);
  });
});

describe('risk annotator seam (M7.3 attachment point)', () => {
  it('injects a pure annotator over the risk-free content', () => {
    const annotator: RiskAnnotator = (content) => ({
      score: content.destructiveActions.length * 10 + content.waves.length,
      class: 'medium',
      factors: [
        {
          id: 'wave-count',
          weight: content.waves.length,
          resources: content.waves.flatMap((wave) => wave.map((e) => e.resource)).sort(),
        },
      ],
    });
    const artifact = plan(webshopPlan(), emptySnapshot(), {}, { risk: annotator });
    assertValid(artifact);
    expect(artifact.content.risk.class).toBe('medium');
    expect(artifact.content.risk.score).toBe(2);
    const stub = plan(webshopPlan(), emptySnapshot());
    expect(artifact.planId).not.toBe(stub.planId); // risk is hashed content
  });
});

describe('fail-closed input verification', () => {
  const desired = webshopPlan();

  it('refuses a provider plan whose planHash does not verify', () => {
    const tampered = { ...desired, planHash: '0'.repeat(64) };
    expect(() => plan(tampered, emptySnapshot())).toThrow(/planHash does not verify/);
  });

  it('refuses a snapshot whose integrity does not verify', () => {
    const state = stateFromPlan(desired);
    const corrupted = { ...state, integrity: `sha256:${'0'.repeat(64)}` };
    expect(() => plan(desired, corrupted)).toThrow(/integrity/);
  });

  const mismatches: Array<[string, (inputs: DeterminismInputs) => void, RegExp]> = [
    ['documentHash', (i) => (i.documentHash = `sha256:${'0'.repeat(64)}`), /documentHash/],
    ['target.provider', (i) => (i.target.provider = 'other'), /target\.provider/],
    ['target.profile', (i) => (i.target.profile = null), /target\.profile/],
    ['mappingVersions', (i) => (i.mappingVersions = { mock: '9.9.9' }), /mappingVersions/],
    ['stateRevision', (i) => (i.stateRevision = 42), /stateRevision/],
    ['stateIntegrity', (i) => (i.stateIntegrity = `sha256:${'0'.repeat(64)}`), /stateIntegrity/],
    ['plannerVersion', (i) => (i.plannerVersion = '9.9.9'), /plannerVersion/],
  ];

  it.each(mismatches)('refuses an identity vector contradicting %s', (_name, corrupt, error) => {
    const state = emptySnapshot();
    const inputs: DeterminismInputs = {
      documentHash: `sha256:${desired.documentHash}`,
      target: { provider: desired.provider, profile: desired.profile },
      profileHashes: {},
      policyBundles: {},
      extensionVersions: {},
      mappingVersions: { [desired.provider]: desired.mappingVersion },
      discoverySnapshot: null,
      pricingSnapshot: null,
      stateRevision: state.revision,
      stateIntegrity: state.integrity,
      plannerVersion: PLANNER_VERSION,
    };
    corrupt(inputs);
    expect(() => buildPlan({ desired, state, inputs })).toThrow(error);
  });
});

describe('envelope handling (§14.5: never hashed)', () => {
  it('validates an enveloped artifact; planId derives from content alone', () => {
    const artifact = plan(webshopPlan(), emptySnapshot());
    const enveloped: PlanArtifact = {
      ...artifact,
      envelope: {
        createdAt: '2026-07-11T00:00:00Z',
        expiresAt: '2026-07-12T00:00:00Z',
        signature: { keyId: 'planner-test-key', alg: 'ed25519', value: 'AAAA' },
      },
    };
    assertValid(enveloped);
    expect(enveloped.planId).toBe(artifact.planId);
    expect(canonicalPlanSerialization(enveloped.content)).toBe(
      canonicalPlanSerialization(artifact.content),
    );
  });
});

describe('synthetic plans through the facade', () => {
  it('plans a base-document (null profile) synthetic provider plan', () => {
    const desired = syntheticPlan([
      { logicalId: 'a.mock:test:Thing', desiredAttributes: { v: 1 } },
    ]);
    const artifact = plan(desired, emptySnapshot());
    assertValid(artifact);
    expect(artifact.content.inputs.target.profile).toBeNull();
    expect(artifact.content.waves[0]?.[0]?.action).toBe('create');
  });
});
