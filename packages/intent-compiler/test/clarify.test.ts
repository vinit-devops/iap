/**
 * M3.2 clarification engine: every §3.3 trigger fires on a crafted case and
 * does NOT fire on its negation (clarification-precision groundwork for the
 * M3.5 benchmark), questions are machine-answerable with recommended
 * defaults and impact explanations, and answers flow into confirmations with
 * channel confirmed-clarification.
 */
import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_TRIGGERS,
  HA_DATABASE_BUDGET_FLOOR_USD,
  apply,
  applyClarificationAnswers,
  clarify,
  compileFacets,
  emptyDocument,
  extractRules,
  requiredConfirmations,
} from '../src/index';
import type { ClarificationQuestion, ClarifyResult, IntentFacet } from '../src/index';
import { batch, fixtureDocument, op } from './helpers';

const IDENTITY = { actor: 'reviewer@example.com', timestamp: '2026-07-11T12:00:00Z' };

async function clarifyText(
  input: string,
  document = emptyDocument('shop'),
): Promise<ClarifyResult & { facets: IntentFacet[] }> {
  const extraction = extractRules(input, { inputId: 'req-1', document });
  const compiled = compileFacets(extraction.facets, document, {});
  const result = await clarify({
    document,
    batch: compiled.batch,
    facets: extraction.facets,
    unresolved: compiled.unresolved,
    unparsed: extraction.unparsed,
  });
  return { ...result, facets: extraction.facets };
}

const byTrigger = (result: ClarifyResult, trigger: string): ClarificationQuestion[] =>
  result.questions.filter((question) => question.trigger === trigger);

describe('the trigger vocabulary is closed', () => {
  it('exactly the eight §3.3 triggers exist', () => {
    expect(CLARIFICATION_TRIGGERS).toEqual([
      'required-field',
      'divergent-interpretation',
      'cost-availability-conflict',
      'destructive-update',
      'compliance-scope',
      'provider-selection',
      'unresolved-reference',
      'policy-conflict',
    ]);
  });
});

describe('trigger: required field cannot be deterministically defaulted', () => {
  it('a workload without an artifact asks a free-form question and blocks the operation', async () => {
    const result = await clarifyText('We need a web app');
    const questions = byTrigger(result, 'required-field');
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      id: 'q-artifact-web',
      field: 'spec.artifact.reference',
      operationIds: ['op-create-web'],
      options: [],
    });
    const blocked = result.batch?.operations.find((entry) => entry.operationId === 'op-create-web');
    expect(blocked?.requiredClarifications).toEqual([
      { id: 'q-artifact-web', question: questions[0]?.question, field: 'spec.artifact.reference' },
    ]);
  });

  it('negation: a stated artifact asks nothing', async () => {
    const result = await clarifyText('We need a web app running image e.com/w:1.0.0');
    expect(byTrigger(result, 'required-field')).toEqual([]);
  });

  it('answering supplies the artifact, clears the block, and confirms on the clarification channel', async () => {
    const result = await clarifyText('We need a web app');
    const answered = applyClarificationAnswers(
      result.batch,
      result.questions,
      [{ questionId: 'q-artifact-web', value: 'registry.example.com/web:2.0.0' }],
      IDENTITY,
    );
    const create = answered.batch?.operations.find(
      (entry) => entry.operationId === 'op-create-web',
    );
    expect((create?.change as { spec: { artifact: unknown } }).spec.artifact).toEqual({
      type: 'container-image',
      reference: 'registry.example.com/web:2.0.0',
    });
    expect(create?.requiredClarifications).toEqual([]);
    expect(answered.confirmations).toEqual([
      {
        operationId: 'op-create-web',
        actor: IDENTITY.actor,
        channel: 'confirmed-clarification',
        timestamp: IDENTITY.timestamp,
      },
    ]);
    const outcome = await apply(emptyDocument('shop'), answered.batch, {
      confirmations: answered.confirmations,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (outcome.ok) {
      expect(
        outcome.result.provenance.find(
          (record) => record.path === 'resources.web.spec.artifact.reference',
        )?.source,
      ).toBe('confirmed-clarification');
    }
  });

  it('an unanswered question keeps the batch uncommittable (fail closed)', async () => {
    const result = await clarifyText('We need a web app');
    const outcome = await apply(emptyDocument('shop'), result.batch, {});
    expect(outcome.ok).toBe(false);
  });
});

describe('trigger: materially divergent interpretations', () => {
  it('unspecified messaging asks queue-vs-topic with a recommended default and impacts', async () => {
    const result = await clarifyText('An api running image e.com/a:1 and a messaging system');
    const [question] = byTrigger(result, 'divergent-interpretation');
    expect(question).toMatchObject({
      id: 'q-messaging-messages',
      recommendedOptionId: 'point-to-point-queue',
      operationIds: ['op-create-messages'],
    });
    expect(question?.options.map((option) => option.id)).toEqual([
      'point-to-point-queue',
      'publish-subscribe-topic',
    ]);
    expect(question?.options.every((option) => option.impact.length > 0)).toBe(true);
  });

  it('negation: an explicit queue asks nothing', async () => {
    const result = await clarifyText('An api running image e.com/a:1 and a task queue');
    expect(byTrigger(result, 'divergent-interpretation')).toEqual([]);
  });

  it('answering "topic" rewrites the proposed kind in the PROPOSAL, never the document', async () => {
    const result = await clarifyText('An api running image e.com/a:1 and a messaging system');
    const answered = applyClarificationAnswers(
      result.batch,
      result.questions,
      [{ questionId: 'q-messaging-messages', optionId: 'publish-subscribe-topic' }],
      IDENTITY,
    );
    const create = answered.batch?.operations.find(
      (entry) => entry.operationId === 'op-create-messages',
    );
    expect((create?.change as { kind: string }).kind).toBe('Topic');
    expect(answered.confirmations[0]?.channel).toBe('confirmed-clarification');
  });

  it('"Reduce expected cost" asks which reduction is intended; the chosen option ADDS operations', async () => {
    const document = fixtureDocument();
    const extraction = extractRules('Reduce expected cost', { inputId: 'r', document });
    const compiled = compileFacets(extraction.facets, document, {});
    expect(compiled.batch).toBeNull(); // nothing is guessed
    const result = await clarify({ document, batch: compiled.batch, facets: extraction.facets });
    const [question] = byTrigger(result, 'divergent-interpretation');
    expect(question?.id).toBe('q-reduce-cost');
    expect(question?.options.some((option) => option.id === 'cancel')).toBe(true);
    const availabilityOption = question?.options.find(
      (option) => option.id === 'use-standard-availability',
    );
    expect(availabilityOption).toBeUndefined(); // the fixture has no high availability set
  });

  it('a wholly unparsed request yields the rephrase question, not silence', async () => {
    const result = await clarifyText('flurble the womble');
    expect(result.questions.map((question) => question.id)).toEqual(['q-unparsed-request']);
  });
});

describe('trigger: cost and availability choices conflict (the roadmap worked example)', () => {
  const INPUT =
    'A highly available postgresql database and an api running image e.com/a:1, with a monthly limit of $300.';

  it('produces the three-option question with the roadmap phrasing and a recommended default', async () => {
    const result = await clarifyText(INPUT);
    const [question] = byTrigger(result, 'cost-availability-conflict');
    expect(question?.question).toBe(
      'You requested high availability and a monthly limit of $300. A multi-zone relational database ' +
        'may exceed that budget. Choose one: raise the budget, use standard availability, or use a ' +
        'lower-cost database class.',
    );
    expect(question?.options.map((option) => option.id)).toEqual([
      'raise-budget',
      'use-standard-availability',
      'lower-cost-database-class',
    ]);
    expect(question?.recommendedOptionId).toBe('use-standard-availability');
    expect(question?.operationIds).toEqual(['op-create-db']);
    expect(question?.options.every((option) => option.impact.length > 0)).toBe(true);
  });

  it('negation: a budget at or above the floor asks nothing', async () => {
    const result = await clarifyText(
      `A highly available postgresql database and an api running image e.com/a:1, with a monthly limit of $${HA_DATABASE_BUDGET_FLOOR_USD}.`,
    );
    expect(byTrigger(result, 'cost-availability-conflict')).toEqual([]);
  });

  it('negation: standard availability under a tight budget asks nothing', async () => {
    const result = await clarifyText(
      'A postgresql database and an api running image e.com/a:1, with a monthly limit of $300.',
    );
    expect(byTrigger(result, 'cost-availability-conflict')).toEqual([]);
  });

  it('choosing standard availability edits the proposal and the batch commits', async () => {
    const result = await clarifyText(INPUT);
    const answered = applyClarificationAnswers(
      result.batch,
      result.questions,
      [{ questionId: 'q-budget-availability-db', optionId: 'use-standard-availability' }],
      IDENTITY,
    );
    const db = answered.batch?.operations.find((entry) => entry.operationId === 'op-create-db');
    expect((db?.change as { spec: { availability: string } }).spec.availability).toBe('standard');
    const confirmations = [
      ...answered.confirmations,
      ...requiredConfirmations(answered.batch as never)
        .filter((need) => need.operationId !== 'op-create-db')
        .map((need) => ({
          operationId: need.operationId,
          actor: IDENTITY.actor,
          channel: 'user-input' as const,
          timestamp: IDENTITY.timestamp,
        })),
    ];
    const outcome = await apply(emptyDocument('shop'), answered.batch, { confirmations });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  });

  it('raising the budget requires a value and rewrites the annotation', async () => {
    const result = await clarifyText(INPUT);
    expect(() =>
      applyClarificationAnswers(
        result.batch,
        result.questions,
        [{ questionId: 'q-budget-availability-db', optionId: 'raise-budget' }],
        IDENTITY,
      ),
    ).toThrow(TypeError);
    const answered = applyClarificationAnswers(
      result.batch,
      result.questions,
      [{ questionId: 'q-budget-availability-db', optionId: 'raise-budget', value: '600' }],
      IDENTITY,
    );
    const budgetOp = answered.batch?.operations.find(
      (entry) => entry.operationId === 'op-set-budget',
    );
    expect(
      (budgetOp?.change as { set: Record<string, string> }).set['annotations.budget-monthly-usd'],
    ).toBe('600');
  });
});

describe('trigger: a destructive update is requested', () => {
  it('removing a stateful resource asks proceed/cancel with cancel recommended', async () => {
    const document = fixtureDocument();
    const result = await clarifyText('Remove the orders-db', document);
    const [question] = byTrigger(result, 'destructive-update');
    expect(question).toMatchObject({
      id: 'q-destructive-op-remove-orders-db',
      recommendedOptionId: 'cancel',
      operationIds: ['op-remove-orders-db'],
    });
    expect(question?.options.map((option) => option.id)).toEqual(['proceed', 'cancel']);
  });

  it('a replace-eligible update (engine change) is flagged destructive', async () => {
    const document = fixtureDocument();
    const proposal = batch(
      op(
        'op-1',
        'UpdateResource',
        { resourceId: 'orders-db' },
        { set: { 'spec.engine': 'mysql' } },
      ),
    );
    const result = await clarify({ document, batch: proposal });
    const [question] = byTrigger(result, 'destructive-update');
    expect(question?.question).toContain('spec.engine');
  });

  it('negation: removing a stateless resource and an in-place update ask nothing', async () => {
    const document = fixtureDocument();
    const inPlace = await clarify({
      document,
      batch: batch(
        op('op-1', 'UpdateResource', { resourceId: 'web' }, { set: { 'spec.size': 'l' } }),
        op('op-2', 'RemoveResource', { resourceId: 'web' }),
      ),
    });
    expect(byTrigger(inPlace, 'destructive-update')).toEqual([]);
  });

  it('answering proceed produces an acknowledging confirmation; cancel drops the operation', async () => {
    const document = fixtureDocument();
    const result = await clarifyText('Remove the scratch', document);
    const questionId = 'q-destructive-op-remove-scratch';
    const proceed = applyClarificationAnswers(
      result.batch,
      result.questions,
      [{ questionId, optionId: 'proceed' }],
      IDENTITY,
    );
    expect(proceed.confirmations[0]).toMatchObject({
      operationId: 'op-remove-scratch',
      channel: 'confirmed-clarification',
      acknowledgeDestructive: true,
    });
    const outcome = await apply(document, proceed.batch, { confirmations: proceed.confirmations });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);

    const cancelled = applyClarificationAnswers(
      result.batch,
      result.questions,
      [{ questionId, optionId: 'cancel' }],
      IDENTITY,
    );
    expect(cancelled.batch).toBeNull();
    expect(cancelled.confirmations).toEqual([]);
  });
});

describe('trigger: compliance requirement lacks scope', () => {
  it('controls without any data service ask whether to add them anyway', async () => {
    const result = await clarifyText('Add PCI DSS controls');
    const [question] = byTrigger(result, 'compliance-scope');
    expect(question?.id).toBe('q-compliance-scope');
    expect(question?.recommendedOptionId).toBe('apply-document-wide');
    expect(question?.operationIds).toHaveLength(4);
  });

  it('negation: a data service in the batch or document scopes the controls', async () => {
    const withDb = await clarifyText('Add PCI DSS controls and a postgresql database');
    expect(byTrigger(withDb, 'compliance-scope')).toEqual([]);
    const existing = await clarifyText('Add PCI DSS controls', fixtureDocument());
    expect(byTrigger(existing, 'compliance-scope')).toEqual([]);
  });

  it('answering drop-controls removes every policy operation', async () => {
    const result = await clarifyText('Add PCI DSS controls');
    const answered = applyClarificationAnswers(
      result.batch,
      result.questions,
      [{ questionId: 'q-compliance-scope', optionId: 'drop-controls' }],
      IDENTITY,
    );
    expect(answered.batch).toBeNull();
  });
});

describe('trigger: provider selection is required', () => {
  it('two named providers ask which one, with per-provider options', async () => {
    const result = await clarifyText('Deploy on aws or azure: an api running image e.com/a:1');
    const [question] = byTrigger(result, 'provider-selection');
    expect(question?.options.map((option) => option.id)).toEqual(['use-aws', 'use-azure']);
    expect(question?.recommendedOptionId).toBe('use-aws');
    const answered = applyClarificationAnswers(
      result.batch,
      result.questions,
      [{ questionId: 'q-provider-selection', optionId: 'use-azure' }],
      IDENTITY,
    );
    const providerOp = answered.batch?.operations.find(
      (entry) => entry.operationId === 'op-set-provider-preference',
    );
    expect(
      (providerOp?.change as { set: Record<string, string> }).set[
        'annotations.provider-preference'
      ],
    ).toBe('azure');
  });

  it('negation: one provider asks nothing', async () => {
    const result = await clarifyText('Deploy on aws: an api running image e.com/a:1');
    expect(byTrigger(result, 'provider-selection')).toEqual([]);
  });
});

describe('trigger: an existing-resource reference is unresolved', () => {
  it('an ambiguous reference asks which resource, with retargeting options', async () => {
    const document = fixtureDocument();
    (document.resources as Record<string, unknown>)['admin'] = {
      kind: 'Service',
      spec: { artifact: { type: 'container-image', reference: 'e.com/admin:1' } },
    };
    const result = await clarifyText('Make the api internal', document);
    const [question] = byTrigger(result, 'unresolved-reference');
    expect(question?.options.map((option) => option.id)).toEqual(['target-admin', 'target-web']);
    const answered = applyClarificationAnswers(
      result.batch,
      result.questions,
      [{ questionId: question?.id as string, optionId: 'target-web' }],
      IDENTITY,
    );
    expect(answered.batch?.operations[0]?.target.resourceId).toBe('web');
  });

  it('a reference that matches nothing is reported as an informational question — no operation exists', async () => {
    const result = await clarifyText('Remove the reports-db', fixtureDocument());
    const [question] = byTrigger(result, 'unresolved-reference');
    expect(question?.id).toBe('q-ref-reports-db');
    expect(question?.operationIds).toEqual([]);
    expect(result.batch).toBeNull();
  });

  it('negation: a unique reference asks nothing', async () => {
    const result = await clarifyText('Make the api internal', fixtureDocument());
    expect(byTrigger(result, 'unresolved-reference')).toEqual([]);
  });
});

describe('trigger: the request conflicts with policy', () => {
  const withPolicy = () => {
    const document = fixtureDocument();
    (document.policies as unknown[]).push({
      id: 'no-public-stores',
      target: { kinds: ['ObjectStore'] },
      rule: { field: 'spec.exposure', operator: 'equals', value: 'public' },
      effect: 'deny',
    });
    return document;
  };

  it("a change violating the document's own policies asks how to proceed", async () => {
    const result = await clarifyText('Make the notes public', withPolicy());
    const [question] = byTrigger(result, 'policy-conflict');
    expect(question).toMatchObject({
      id: 'q-policy-no-public-stores',
      recommendedOptionId: 'drop-conflicting-changes',
      operationIds: ['op-update-notes'],
    });
    const answered = applyClarificationAnswers(
      result.batch,
      result.questions,
      [{ questionId: 'q-policy-no-public-stores', optionId: 'drop-conflicting-changes' }],
      IDENTITY,
    );
    expect(answered.batch).toBeNull();
  });

  it('negation: a compliant change asks nothing', async () => {
    const result = await clarifyText('Make the notes private', withPolicy());
    expect(byTrigger(result, 'policy-conflict')).toEqual([]);
  });
});

describe('answer application mechanics', () => {
  it('answers referencing unknown questions or options are caller misuse (TypeError)', async () => {
    const result = await clarifyText('We need a web app');
    expect(() =>
      applyClarificationAnswers(
        result.batch,
        result.questions,
        [{ questionId: 'q-ghost' }],
        IDENTITY,
      ),
    ).toThrow(TypeError);
  });

  it('partially answered operations stay blocked: no confirmation until every question clears', () => {
    const proposal = batch(
      op(
        'op-1',
        'SetMetadata',
        {},
        { set: { description: 'x' } },
        {
          requiredClarifications: [
            { id: 'q-a', question: 'A?' },
            { id: 'q-b', question: 'B?' },
          ],
        },
      ),
    );
    const questions: ClarificationQuestion[] = [
      {
        id: 'q-a',
        question: 'A?',
        trigger: 'divergent-interpretation',
        group: 'requirements',
        impact: 'x',
        operationIds: ['op-1'],
        options: [{ id: 'yes', label: 'Yes', impact: 'x', effects: [{ kind: 'no-change' }] }],
        recommendedOptionId: 'yes',
      },
      {
        id: 'q-b',
        question: 'B?',
        trigger: 'divergent-interpretation',
        group: 'requirements',
        impact: 'x',
        operationIds: ['op-1'],
        options: [{ id: 'yes', label: 'Yes', impact: 'x', effects: [{ kind: 'no-change' }] }],
        recommendedOptionId: 'yes',
      },
    ];
    const partial = applyClarificationAnswers(
      proposal,
      questions,
      [{ questionId: 'q-a', optionId: 'yes' }],
      IDENTITY,
    );
    expect(partial.confirmations).toEqual([]);
    expect(partial.unanswered.map((question) => question.id)).toEqual(['q-b']);
    expect(partial.batch?.operations[0]?.requiredClarifications).toEqual([
      { id: 'q-b', question: 'B?' },
    ]);
    const complete = applyClarificationAnswers(
      proposal,
      questions,
      [
        { questionId: 'q-a', optionId: 'yes' },
        { questionId: 'q-b', optionId: 'yes' },
      ],
      IDENTITY,
    );
    expect(complete.confirmations).toHaveLength(1);
    expect(complete.unanswered).toEqual([]);
  });

  it('questions are logically grouped and deterministically ordered', async () => {
    const result = await clarifyText(
      'We need a web app and a messaging system, with a monthly limit of $300 and a highly available postgresql database',
    );
    const groups = result.questions.map((question) => question.group);
    expect(new Set(groups).size).toBeGreaterThan(1);
    const triggers = result.questions.map((question) =>
      CLARIFICATION_TRIGGERS.indexOf(question.trigger),
    );
    expect(triggers).toEqual([...triggers].sort((a, b) => a - b));
  });

  it('requiredConfirmations reports why each operation needs confirmation, and only those', () => {
    const proposal = batch(
      op('op-low', 'SetMetadata', {}, { set: { description: 'x' } }, { confidence: 0.5 }),
      op(
        'op-assumed',
        'SetMetadata',
        {},
        { set: { owner: 'x' } },
        {
          assumptions: [{ field: 'owner', assumed: 'x', reason: 'guessed' }],
        },
      ),
      op('op-clean', 'SetMetadata', {}, { set: { organization: 'x' } }),
    );
    expect(requiredConfirmations(proposal)).toEqual([
      { operationId: 'op-low', reasons: ['below-confidence-threshold'] },
      { operationId: 'op-assumed', reasons: ['assumptions'] },
    ]);
  });
});
