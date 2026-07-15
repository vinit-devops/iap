/**
 * IEP-0009 conformance requirements OP-1 through OP-4, mapped one describe
 * block each. The milestone document cross-references these tests.
 */
import { describe, expect, it } from 'vitest';
import * as compiler from '../src/index';
import { apply, replay } from '../src/index';
import type { OperationEnvelope } from '../src/index';
import { batch, confirm, fixtureDocument, op } from './helpers';

const buildOps = (): OperationEnvelope[] => [
  op(
    'op-1',
    'CreateResource',
    { resourceId: 'cache' },
    {
      kind: 'Cache',
      spec: { engine: 'redis-compatible', capacity: { memory: '1Gi' } },
    },
  ),
  op(
    'op-2',
    'CreateRelationship',
    { resourceId: 'web' },
    {
      type: 'connectsTo',
      target: 'cache',
      port: 6379,
      protocol: 'tcp',
    },
  ),
  op('op-3', 'UpdateResource', { resourceId: 'web' }, { set: { 'spec.size': 'l' } }),
];

describe('OP-1: no byte-producing path bypasses the operation gate', () => {
  it('the public surface is exactly the pinned export set', () => {
    // The pin is the OP-1 mechanism: every export must appear here and pass
    // the no-byte-path audit below. M3.2–M3.4 extended the list ADDITIVELY
    // (all fifteen M3.1 names remain); the authoring-engine exports produce
    // facets, batches, questions, and prose only — never document bytes. M3.5
    // adds the `runAuthoringSession` orchestrator (and its `AUTHORING_OUTCOMES`
    // vocabulary), which only composes the pinned surface above the gate.
    expect(Object.keys(compiler).sort()).toEqual([
      'ADAPTER_ERROR_CODES',
      'AUTHORING_OUTCOMES',
      'CLARIFICATION_TRIGGERS',
      'CONFIDENCE_TIERS',
      'CONFIRMATION_CHANNELS',
      'DEFAULT_CONFIDENCE_THRESHOLD',
      'DEFAULT_RESOURCE_IDS',
      'DESTRUCTIVE_REASONS',
      'EXTRACTION_CHANNELS',
      'FACET_TYPES',
      'HA_DATABASE_BUDGET_FLOOR_USD',
      'OPERATIONS_API_VERSION',
      'OPERATION_ERROR_CODES',
      'OPERATION_TYPES',
      'PROPOSAL_CHANNELS',
      'PROVENANCE_SOURCES',
      'RECOMMENDATION_RULES',
      'REPLACE_ELIGIBLE_PATHS',
      'STATEFUL_KINDS',
      'acceptRecommendations',
      'apply',
      'applyClarificationAnswers',
      'clarify',
      'compileFacets',
      'compilerOperationsSchema',
      'createAdapterSession',
      'emptyDocument',
      'explainBatch',
      'extractRules',
      'fixtureAdapter',
      'getPrompt',
      'intentFacetsSchema',
      'promptRegistry',
      'recommend',
      'replay',
      'requiredConfirmations',
      'rulesAdapter',
      'runAuthoringSession',
      'validateBatchStructure',
      'validateExtractionStructure',
    ]);
  });

  it('no exported value turns a raw proposal or document into serialized bytes', () => {
    // apply/replay return committed results (objects); everything else in
    // the surface returns data (schemas, facets, batches, questions,
    // recommendations, registry entries) or prose (explainBatch renders a
    // human-readable explanation, not a document serialization). The sole
    // serializer is the `serialize` closure ON the committed result —
    // created inside the gate after every stage passed, unreachable for
    // unvalidated proposals by construction.
    const functions = Object.entries(compiler).filter(([, value]) => typeof value === 'function');
    expect(functions.map(([name]) => name).sort()).toEqual([
      'acceptRecommendations',
      'apply',
      'applyClarificationAnswers',
      'clarify',
      'compileFacets',
      'compilerOperationsSchema',
      'createAdapterSession',
      'emptyDocument',
      'explainBatch',
      'extractRules',
      'fixtureAdapter',
      'getPrompt',
      'intentFacetsSchema',
      'promptRegistry',
      'recommend',
      'replay',
      'requiredConfirmations',
      'rulesAdapter',
      'runAuthoringSession',
      'validateBatchStructure',
      'validateExtractionStructure',
    ]);
    expect(typeof compiler.compilerOperationsSchema()).toBe('object');
    expect(typeof compiler.emptyDocument('x')).toBe('object');
    const structure = compiler.validateBatchStructure(batch(...buildOps()));
    expect(typeof structure).toBe('object');
    // The authoring-engine additions return data/prose, never a document
    // serialization: explainBatch on a valid proposal yields prose that is
    // not parseable as a document, and the extractor yields facet data.
    const explanation = compiler.explainBatch(fixtureDocument(), batch(...buildOps()));
    expect(explanation.ok).toBe(true);
    if (explanation.ok) {
      expect(typeof explanation.text).toBe('string');
      expect(() => JSON.parse(explanation.text)).toThrow();
    }
    expect(Array.isArray(compiler.extractRules('a web app').facets)).toBe(true);
  });

  it('a refused batch yields refusals only — no document, no serializer', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(op('op-1', 'UpdateResource', { resourceId: 'ghost' }, { set: { description: 'x' } })),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(Object.keys(outcome).sort()).toEqual(['ok', 'refusals']);
    }
  });
});

describe('OP-2: replaying a confirmed batch reproduces a byte-identical document', () => {
  it('replay from log entries yields identical yaml, canonical bytes, and hash', async () => {
    const base = fixtureDocument();
    const outcome = await apply(base, batch(...buildOps()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const replayed = await replay(fixtureDocument(), outcome.result.logEntries);
    expect(replayed.serialize('yaml')).toBe(outcome.result.serialize('yaml'));
    expect(replayed.serialize('canonical-json')).toBe(outcome.result.serialize('canonical-json'));
    expect(replayed.canonicalHash).toBe(outcome.result.canonicalHash);
  });

  it('replay carries recorded confirmations through', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op('op-1', 'RemoveResource', { resourceId: 'scratch' }, undefined, { confidence: 0.5 }),
      ),
      { confirmations: [confirm('op-1', { acknowledgeDestructive: true })] },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const replayed = await replay(fixtureDocument(), outcome.result.logEntries);
    expect(replayed.canonicalHash).toBe(outcome.result.canonicalHash);
    expect(replayed.logEntries[0]?.confirmation?.channel).toBe('user-input');
  });

  it('model independence: two adapters emitting the same batch yield the same IaP', async () => {
    const adapterA = buildOps().map((envelope) => ({
      ...envelope,
      provenance: { ...envelope.provenance, modelId: 'adapter:alpha@1', promptVersion: '3' },
    }));
    const adapterB = buildOps().map((envelope) => ({
      ...envelope,
      provenance: { ...envelope.provenance, modelId: 'adapter:beta@9', promptVersion: '12' },
    }));
    const fromA = await apply(fixtureDocument(), batch(...adapterA));
    const fromB = await apply(fixtureDocument(), batch(...adapterB));
    expect(fromA.ok && fromB.ok).toBe(true);
    if (!fromA.ok || !fromB.ok) return;
    expect(fromA.result.serialize('yaml')).toBe(fromB.result.serialize('yaml'));
    expect(fromA.result.canonicalHash).toBe(fromB.result.canonicalHash);
  });

  it('replay fails closed: wrong base document', async () => {
    const outcome = await apply(fixtureDocument(), batch(...buildOps()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const wrongBase = fixtureDocument();
    delete wrongBase.resources.web;
    await expect(replay(wrongBase, outcome.result.logEntries)).rejects.toThrow(TypeError);
  });

  it('replay fails closed: tampered recorded hash', async () => {
    const outcome = await apply(fixtureDocument(), batch(...buildOps()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const entries = structuredClone(outcome.result.logEntries);
    (entries[1] as { resultingHash: string }).resultingHash = 'f'.repeat(64);
    await expect(replay(fixtureDocument(), entries)).rejects.toThrow(/hash mismatch/);
  });

  it('replay fails closed: non-contiguous log', async () => {
    const outcome = await apply(fixtureDocument(), batch(...buildOps()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const entries = outcome.result.logEntries.filter((entry) => entry.sequence !== 1);
    await expect(replay(fixtureDocument(), entries)).rejects.toThrow(/contiguous/);
  });
});

describe('OP-3: assumptions, clarifications, and sub-threshold confidence block commit', () => {
  const meta = (overrides: Partial<OperationEnvelope>) =>
    batch(op('op-1', 'SetMetadata', {}, { set: { description: 'authored' } }, overrides));

  it('confidence below the default 0.8 threshold blocks without confirmation', async () => {
    const outcome = await apply(fixtureDocument(), meta({ confidence: 0.79 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals[0]?.code).toBe('below-confidence-threshold');
  });

  it('confidence exactly at the threshold commits (strictly below blocks)', async () => {
    const outcome = await apply(fixtureDocument(), meta({ confidence: 0.8 }));
    expect(outcome.ok).toBe(true);
  });

  it('the threshold is configurable per session', async () => {
    const strict = await apply(fixtureDocument(), meta({ confidence: 0.85 }), {
      confidenceThreshold: 0.9,
    });
    expect(strict.ok).toBe(false);
    const lax = await apply(fixtureDocument(), meta({ confidence: 0.85 }));
    expect(lax.ok).toBe(true);
  });

  it('non-empty assumptions block without confirmation, commit with one', async () => {
    const withAssumption = meta({
      assumptions: [{ field: 'description', assumed: 'authored', reason: 'not stated' }],
    });
    const blocked = await apply(fixtureDocument(), withAssumption);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.refusals[0]?.code).toBe('unconfirmed-assumptions');

    const confirmedOutcome = await apply(fixtureDocument(), withAssumption, {
      confirmations: [confirm('op-1', { channel: 'confirmed-clarification' })],
    });
    expect(confirmedOutcome.ok).toBe(true);
    if (confirmedOutcome.ok) {
      expect(confirmedOutcome.result.logEntries[0]?.confirmation?.channel).toBe(
        'confirmed-clarification',
      );
      expect(confirmedOutcome.result.logEntries[0]?.confirmation?.actor).toBe(
        'reviewer@example.com',
      );
      expect(confirmedOutcome.result.logEntries[0]?.confirmation?.timestamp).toBe(
        '2026-07-11T12:00:00Z',
      );
    }
  });

  it('non-empty requiredClarifications block without confirmation, commit with one', async () => {
    const withQuestion = meta({
      requiredClarifications: [{ id: 'q-1', question: 'Which description?', field: 'description' }],
    });
    const blocked = await apply(fixtureDocument(), withQuestion);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.refusals[0]?.code).toBe('unconfirmed-clarifications');
    const confirmedOutcome = await apply(fixtureDocument(), withQuestion, {
      confirmations: [confirm('op-1', { channel: 'confirmed-clarification' })],
    });
    expect(confirmedOutcome.ok).toBe(true);
  });

  it('low-confidence output is never silently treated as intent: all three gates report together', async () => {
    const outcome = await apply(
      fixtureDocument(),
      meta({
        confidence: 0.2,
        assumptions: [{ field: 'description', assumed: 'authored', reason: 'guessed' }],
        requiredClarifications: [{ id: 'q-1', question: 'Sure?' }],
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals).toHaveLength(3);
  });
});

describe('OP-4: every field written by an operation has a provenance record citing the operation id', () => {
  it('create + update writes are all recorded with the writing operation id', async () => {
    const outcome = await apply(fixtureDocument(), batch(...buildOps()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const records = new Map(outcome.result.provenance.map((record) => [record.path, record]));

    // Every leaf of the created cache entry cites op-1.
    for (const path of [
      'resources.cache.kind',
      'resources.cache.spec.engine',
      'resources.cache.spec.capacity.memory',
    ]) {
      expect(records.get(path)?.operationId).toBe('op-1');
      expect(records.get(path)?.source).toBe('explicit-user');
    }
    // Every leaf of the created edge cites op-2.
    for (const path of [
      'resources.web.relationships.1.type',
      'resources.web.relationships.1.target',
      'resources.web.relationships.1.port',
      'resources.web.relationships.1.protocol',
    ]) {
      expect(records.get(path)?.operationId).toBe('op-2');
    }
    // The updated field cites op-3.
    expect(records.get('resources.web.spec.size')?.operationId).toBe('op-3');
    // Records are total over writes: 3 create leaves + 4 edge leaves + 1 update.
    const writtenPaths = [...records.keys()];
    expect(writtenPaths.length).toBe(8);
    expect(outcome.result.provenance.every((record) => record.operationId.length > 0)).toBe(true);
  });

  it('last writer wins when two operations write the same path', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op('op-1', 'UpdateResource', { resourceId: 'web' }, { set: { 'spec.size': 'l' } }),
        op('op-2', 'UpdateResource', { resourceId: 'web' }, { set: { 'spec.size': 'xl' } }),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = outcome.result.provenance.find((r) => r.path === 'resources.web.spec.size');
    expect(record?.operationId).toBe('op-2');
  });

  it('a clarification-channel confirmation upgrades the recorded source', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'SetMetadata',
          {},
          { set: { description: 'clarified' } },
          {
            requiredClarifications: [{ id: 'q-1', question: 'Which?' }],
          },
        ),
      ),
      { confirmations: [confirm('op-1', { channel: 'confirmed-clarification' })] },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = outcome.result.provenance.find((r) => r.path === 'metadata.description');
    expect(record?.source).toBe('confirmed-clarification');
  });

  it('provenance records are sorted by path (deterministic)', async () => {
    const outcome = await apply(fixtureDocument(), batch(...buildOps()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const paths = outcome.result.provenance.map((record) => record.path);
    expect(paths).toEqual([...paths].sort());
  });
});
