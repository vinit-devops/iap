/**
 * The natural-language authoring prototype (M3.5): `runAuthoringSession`
 * drives one request through extract → compile → clarify → answer → confirm →
 * apply, stopping honestly at every human gate. These tests pin the closed
 * outcome taxonomy, the deterministic/clock-free contract, and the boundary
 * (the orchestrator only ever reaches document bytes through the gate).
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IaPDocument } from '@iap/model';
import { load, validateExtensions } from '@iap/sdk';
import { AUTHORING_OUTCOMES, runAuthoringSession } from '../src/index';
import { repoRoot } from './helpers';

const TS = '2026-07-11T12:00:00Z';
const CLEAR =
  'A public web app running image registry.example.com/app:1.0.0 behind a gateway with a ' +
  'highly available postgresql 16 database and a redis cache.';
const EXAMPLE = join(repoRoot, 'spec', 'examples', 'basic-webapp.iap.yaml');

const loadExample = async (): Promise<IaPDocument> => {
  const ws = await load({ path: EXAMPLE });
  return structuredClone(ws.document as IaPDocument);
};

describe('runAuthoringSession — outcome taxonomy', () => {
  it('AUTHORING_OUTCOMES is the closed set the engine can return', () => {
    expect([...AUTHORING_OUTCOMES]).toEqual([
      'committed',
      'explained',
      'no-operations',
      'needs-input',
      'refused',
    ]);
  });

  it('a clear request commits to a document that re-validates green end to end', async () => {
    const result = await runAuthoringSession(CLEAR, { timestamp: TS, documentName: 'shop' });
    expect(result.outcome).toBe('committed');
    expect(result.questions).toEqual([]);
    expect(result.unsupported).toEqual([]);
    expect(result.unparsed).toEqual([]);
    expect(result.committed).toBeDefined();
    if (result.committed === undefined) return;

    expect(Object.keys(result.committed.document.resources).sort()).toEqual([
      'cache',
      'db',
      'edge',
      'web',
    ]);

    // The committed bytes reload and pass the whole ch. 8 pipeline.
    const ws = await load(result.committed.serialize('yaml'));
    expect(ws.ok).toBe(true);
    const findings = [
      ...ws.validate().findings,
      ...ws.policies().findings,
      ...validateExtensions(ws.document as IaPDocument),
    ];
    expect(findings.filter((finding) => finding.severity === 'error')).toEqual([]);

    // Every written field cites an operation (OP-4).
    expect(result.committed.provenance.every((record) => record.operationId.length > 0)).toBe(true);
  });

  it('a missing required field stops at needs-input with the blocking question', async () => {
    const result = await runAuthoringSession('We need a web app', { timestamp: TS });
    expect(result.outcome).toBe('needs-input');
    expect(result.firedTriggers).toEqual(['required-field']);
    expect(result.unanswered.map((q) => q.id)).toEqual(['q-artifact-web']);
    expect(result.committed).toBeUndefined();
    // Nothing was written; the batch never reached a serializer.
    expect(result.confirmations).toEqual([]);
  });

  it('a supplied answer to the blocking question lets the same request commit', async () => {
    const result = await runAuthoringSession('We need a web app', {
      timestamp: TS,
      documentName: 'shop',
      answers: [{ questionId: 'q-artifact-web', value: 'registry.example.com/web:1.0.0' }],
    });
    expect(result.outcome).toBe('committed');
    expect(result.answered.map((a) => a.questionId)).toEqual(['q-artifact-web']);
    expect(result.unanswered).toEqual([]);
  });

  it('a wholly unsupported request derives no operations and never guesses them', async () => {
    const result = await runAuthoringSession('We need a vpn and a dynamodb table', {
      timestamp: TS,
    });
    expect(result.outcome).toBe('no-operations');
    expect(result.unsupported.map((finding) => finding.capability).sort()).toEqual([
      'dynamodb',
      'vpn',
    ]);
    expect(result.batch).toBeNull();
    expect(result.committed).toBeUndefined();
  });

  it('the explain directive narrates instead of authoring', async () => {
    const result = await runAuthoringSession('Explain what changes this request will make', {
      timestamp: TS,
    });
    expect(result.outcome).toBe('explained');
    expect(result.extraction.explain).toBe(true);
    expect(result.batch).toBeNull();
    expect(result.committed).toBeUndefined();
  });
});

describe('runAuthoringSession — clarification and defaults', () => {
  it('the budget-vs-HA conflict raises the cost/availability question and blocks', async () => {
    const result = await runAuthoringSession(
      'A highly available postgresql database on a budget of $200 per month, ' +
        'web app image registry.example.com/app:1.0.0.',
      { timestamp: TS, documentName: 'shop' },
    );
    expect(result.outcome).toBe('needs-input');
    expect(result.firedTriggers).toContain('cost-availability-conflict');
    // Every fired question is closed with a recommended default, machine-answerable.
    const conflict = result.questions.find((q) => q.trigger === 'cost-availability-conflict');
    expect(conflict?.recommendedOptionId).toBeDefined();
    expect(conflict?.options.length ?? 0).toBeGreaterThan(1);
  });

  it('autoAnswerDefaults commits an in-vocabulary incremental edit', async () => {
    const result = await runAuthoringSession('Move to maximum availability', {
      timestamp: TS,
      document: await loadExample(),
      autoAnswerDefaults: true,
    });
    expect(result.outcome).toBe('committed');
    expect(result.committed?.previewDiff.changes).toEqual([
      'resources.orders-db.spec.availability',
      'resources.session-cache.spec.availability',
      'resources.web.spec.availability',
    ]);
  });
});

describe('runAuthoringSession — the destructive human gate (§19.6)', () => {
  const buildTwoResourceDoc = async (): Promise<IaPDocument> => {
    const seeded = await runAuthoringSession(
      'A web app running image registry.example.com/w:1.0.0 and a postgresql database and a redis cache',
      { timestamp: TS, documentName: 'demo', autoAnswerDefaults: true },
    );
    expect(seeded.outcome).toBe('committed');
    if (seeded.committed === undefined) throw new Error('seed failed');
    return structuredClone(seeded.committed.document);
  };

  it('a stateful removal stops at needs-input without acknowledgment authority', async () => {
    const result = await runAuthoringSession('Remove the db', {
      timestamp: TS,
      document: await buildTwoResourceDoc(),
    });
    expect(result.outcome).toBe('needs-input');
    expect(result.firedTriggers).toContain('destructive-update');
    expect(result.committed).toBeUndefined();
  });

  it('acknowledgeDestructive proceeds and the removal commits with an acknowledged confirmation', async () => {
    const result = await runAuthoringSession('Remove the db', {
      timestamp: TS,
      document: await buildTwoResourceDoc(),
      acknowledgeDestructive: true,
    });
    expect(result.outcome).toBe('committed');
    expect(result.committed?.previewDiff.destructive).toBe(true);
    expect(Object.keys(result.committed?.document.resources ?? {}).sort()).toEqual([
      'cache',
      'web',
    ]);
    expect(
      result.confirmations.some(
        (record) => record.operationId === 'op-remove-db' && record.acknowledgeDestructive === true,
      ),
    ).toBe(true);
  });

  it('a removal that would dangle an output reference is refused fail-closed (design decision 10)', async () => {
    // basic-webapp declares outputs.db-connection referencing orders-db.
    const result = await runAuthoringSession('Remove the orders-db', {
      timestamp: TS,
      document: await loadExample(),
      acknowledgeDestructive: true,
    });
    expect(result.outcome).toBe('refused');
    expect(result.refusals.some((r) => 'code' in r && r.code === 'validation-failed')).toBe(true);
    expect(result.committed).toBeUndefined();
  });
});

describe('runAuthoringSession — determinism and clock-freedom', () => {
  it('the same request with the same injected timestamp yields byte-identical output', async () => {
    const a = await runAuthoringSession(CLEAR, { timestamp: TS, documentName: 'shop' });
    const b = await runAuthoringSession(CLEAR, { timestamp: TS, documentName: 'shop' });
    expect(a.outcome).toBe('committed');
    expect(a.committed?.serialize('yaml')).toBe(b.committed?.serialize('yaml'));
    expect(a.committed?.canonicalHash).toBe(b.committed?.canonicalHash);
  });

  it('committed bytes round-trip to the same canonical hash (semantic equivalence)', async () => {
    const result = await runAuthoringSession(CLEAR, { timestamp: TS, documentName: 'shop' });
    expect(result.committed).toBeDefined();
    if (result.committed === undefined) return;
    const reloaded = await load(result.committed.serialize('yaml'));
    expect(reloaded.canonical().hash).toBe(result.committed.canonicalHash);
  });

  it('the input document is never mutated', async () => {
    const base = await loadExample();
    const before = JSON.stringify(base);
    await runAuthoringSession('Move to maximum availability', {
      timestamp: TS,
      document: base,
      autoAnswerDefaults: true,
    });
    expect(JSON.stringify(base)).toBe(before);
  });
});
