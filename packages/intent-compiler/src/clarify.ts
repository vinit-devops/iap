/**
 * The deterministic clarification engine (M3.2, roadmap §3.3): the closed
 * trigger list evaluated as rules over (facets, proposal batch, current
 * document) — never model output (phase-3 design decision 7). Questions are
 * machine-readable: each carries the trigger that fired, the operations it
 * blocks, closed options with per-option impact explanations and a
 * recommended default, and machine-executable effects so UIs and text flows
 * apply answers identically.
 *
 * Answer flow: `applyClarificationAnswers` edits the PROPOSAL (never the
 * document), removes the answered question from the blocked operations, and
 * produces `ConfirmationRecord`s with channel `confirmed-clarification`
 * (IEP-0009 rule 3). Unanswered blocking questions stay in
 * `requiredClarifications`, which the M3.1 gate refuses to commit (OP-3) —
 * the batch is uncommittable until every blocking question is answered.
 */

import type { IaPDocument, Kind, ResourceEntry } from '@iap/model';
import { applyOperationInPlace } from './apply.js';
import { load } from '@iap/sdk';
import type { ConfirmationRecord } from './gate.js';
import type { BudgetFacet, IntentFacet, UnparsedSpan } from './facets.js';
import type { UnresolvedSubject } from './compile.js';
import type {
  ChangeSetUnset,
  Clarification,
  CreateResourceChange,
  OperationBatch,
  OperationEnvelope,
} from './operations.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, OPERATIONS_API_VERSION } from './operations.js';
import { isReplaceEligibleChange, isStatefulKind } from './preview.js';

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

/** The closed §3.3 trigger vocabulary — questions are asked ONLY for these. */
export const CLARIFICATION_TRIGGERS = [
  'required-field',
  'divergent-interpretation',
  'cost-availability-conflict',
  'destructive-update',
  'compliance-scope',
  'provider-selection',
  'unresolved-reference',
  'policy-conflict',
] as const;

export type ClarificationTrigger = (typeof CLARIFICATION_TRIGGERS)[number];

/** Logical grouping label per trigger (questions are grouped, §3.3). */
const TRIGGER_GROUPS: Readonly<Record<ClarificationTrigger, string>> = {
  'required-field': 'requirements',
  'divergent-interpretation': 'requirements',
  'cost-availability-conflict': 'cost',
  'destructive-update': 'risk',
  'compliance-scope': 'compliance',
  'provider-selection': 'provider',
  'unresolved-reference': 'references',
  'policy-conflict': 'policy',
};

/**
 * Monthly USD floor below which a multi-zone (high/maximum availability)
 * relational database conflicts with the stated budget (the roadmap §3.3
 * worked example). A deterministic integer constant — compared, never
 * computed.
 */
export const HA_DATABASE_BUDGET_FLOOR_USD = 400;

/** One value write inside an answer effect; `fromAnswer` takes the answer's supplied value. */
export interface AmendSet {
  path: string;
  value?: unknown;
  fromAnswer?: boolean;
}

/** Machine-executable consequence of choosing an option (applied to the PROPOSAL, never the document). */
export type AnswerEffect =
  | { kind: 'no-change' }
  | { kind: 'remove-operation'; operationId: string }
  | { kind: 'acknowledge-destructive'; operationId: string }
  | { kind: 'retarget'; operationId: string; resourceId: string }
  | { kind: 'amend-create'; operationId: string; set: AmendSet[] }
  | { kind: 'amend-set'; operationId: string; set: AmendSet[] }
  | { kind: 'add-operations'; operations: OperationEnvelope[] };

/** One closed, machine-answerable option. */
export interface ClarificationOption {
  id: string;
  label: string;
  /** What choosing this option means for the architecture (impact explanation, §3.3). */
  impact: string;
  effects: AnswerEffect[];
  /** The answer must supply a value (e.g. the new budget amount). */
  requiresValue?: boolean;
}

/**
 * One question of the clarification engine. The `clarification` member is
 * the minimal envelope projection attached to the blocked operations'
 * `requiredClarifications`; everything else is the rich rendering/answering
 * contract shared by UIs and text flows.
 */
export interface ClarificationQuestion {
  id: string;
  question: string;
  /** Target-relative dot path of the blocked field, when one is attributable. */
  field?: string;
  trigger: ClarificationTrigger;
  group: string;
  /** Why the engine asked (overall impact explanation). */
  impact: string;
  /** Operations this question blocks; empty = informational (nothing to block). */
  operationIds: string[];
  /** Closed options where possible; empty = free-form value answer. */
  options: ClarificationOption[];
  recommendedOptionId?: string;
  /** Effects applied with the free-form answer value when `options` is empty. */
  freeFormEffects?: AnswerEffect[];
}

export interface ClarifyInput {
  document: IaPDocument;
  /** The proposal batch (null when compilation derived no operations). */
  batch: OperationBatch | null;
  /** The facets the proposal was compiled from (facet-level triggers). */
  facets?: IntentFacet[];
  /** Unresolved subject references reported by the compiler. */
  unresolved?: UnresolvedSubject[];
  /** Unparsed spans reported by the extractor. */
  unparsed?: UnparsedSpan[];
  /** Profile the policy dry run is relative to. */
  profile?: string | null;
}

export interface ClarifyResult {
  questions: ClarificationQuestion[];
  /** A clone of the input batch with each blocking question attached to its operations' requiredClarifications. */
  batch: OperationBatch | null;
}

export interface ClarificationAnswer {
  questionId: string;
  /** The chosen option (closed questions). */
  optionId?: string;
  /** The supplied value (free-form questions and `requiresValue` options). */
  value?: unknown;
}

/** Who answered and when; the timestamp is INJECTED by the caller — never read from a clock. */
export interface AnswerIdentity {
  actor: string;
  timestamp: string;
}

export interface AnswerApplicationResult {
  batch: OperationBatch | null;
  /** Confirmations (channel `confirmed-clarification`) for operations whose questions are all answered. */
  confirmations: ConfirmationRecord[];
  /** Questions not answered; their operations remain uncommittable (OP-3). */
  unanswered: ClarificationQuestion[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isPlainObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function setAtPath(root: JsonObject, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    const next = current[segment];
    if (isPlainObject(next)) {
      current = next;
    } else {
      const fresh: JsonObject = {};
      current[segment] = fresh;
      current = fresh;
    }
  }
  current[segments[segments.length - 1] as string] = value;
}

const SIZE_STEP_DOWN: Readonly<Record<string, string>> = { xl: 'l', l: 'm', m: 's', s: 'xs' };

const DATA_KINDS: readonly Kind[] = [
  'Database',
  'Cache',
  'ObjectStore',
  'Volume',
  'Queue',
  'Topic',
  'Secret',
];

const ARTIFACT_KINDS = new Set(['Service', 'Job', 'Function']);

function opsById(batch: OperationBatch | null): Map<string, OperationEnvelope> {
  const map = new Map<string, OperationEnvelope>();
  for (const op of batch?.operations ?? []) map.set(op.operationId, op);
  return map;
}

/** Build a clarification-sourced envelope for `add-operations` effects. */
function clarificationOperation(
  operationId: string,
  type: OperationEnvelope['type'],
  target: OperationEnvelope['target'],
  change: unknown,
): OperationEnvelope {
  const envelope: OperationEnvelope = {
    operationId,
    type,
    target,
    confidence: 0.95,
    assumptions: [],
    requiredClarifications: [],
    provenance: { source: 'confirmed-clarification', channel: 'api' },
  };
  if (change !== undefined) envelope.change = change;
  return envelope;
}

/* ------------------------------------------------------------------ */
/* The trigger rules                                                   */
/* ------------------------------------------------------------------ */

/**
 * Evaluate the closed §3.3 trigger list and return the questions plus a
 * batch clone with each blocking question attached to its operations.
 * Async only for the policy-conflict trigger, which runs the document's own
 * policies over the speculatively applied result via the ch. 8 pipeline.
 */
export async function clarify(input: ClarifyInput): Promise<ClarifyResult> {
  const { document } = input;
  const batch = input.batch;
  const facets = input.facets ?? [];
  const questions: ClarificationQuestion[] = [];
  const operations = batch?.operations ?? [];
  const resources = document.resources ?? {};

  /* -- Trigger 1: a required field cannot be deterministically defaulted -- */
  for (const op of operations) {
    if (op.type !== 'CreateResource') continue;
    const change = op.change as CreateResourceChange & JsonObject;
    if (!ARTIFACT_KINDS.has(change.kind)) continue;
    if (getAtPath(change, 'spec.artifact') !== undefined) continue;
    const id = op.target.resourceId as string;
    questions.push({
      id: `q-artifact-${id}`,
      question: `What should ${change.kind.toLowerCase()} "${id}" run? Provide a container image reference (e.g. registry.example.com/app:1.0.0).`,
      field: 'spec.artifact.reference',
      trigger: 'required-field',
      group: TRIGGER_GROUPS['required-field'],
      impact:
        'artifact is a required field with no deterministic default (ch. 3); the document cannot validate without it',
      operationIds: [op.operationId],
      options: [],
      freeFormEffects: [
        {
          kind: 'amend-create',
          operationId: op.operationId,
          set: [
            { path: 'spec.artifact.type', value: 'container-image' },
            { path: 'spec.artifact.reference', fromAnswer: true },
          ],
        },
      ],
    });
  }

  /* -- Trigger 2: materially divergent interpretations -------------------- */
  for (const op of operations) {
    const queueAssumption = op.assumptions.find(
      (assumption) => assumption.field === 'kind' && assumption.assumed === 'Queue',
    );
    if (op.type !== 'CreateResource' || queueAssumption === undefined) continue;
    const id = op.target.resourceId as string;
    questions.push({
      id: `q-messaging-${id}`,
      question:
        'The request asks for messaging without saying whether each message goes to ONE consumer (queue) or EVERY subscriber (topic). Which is intended?',
      field: 'kind',
      trigger: 'divergent-interpretation',
      group: TRIGGER_GROUPS['divergent-interpretation'],
      impact:
        'queue vs topic materially changes the architecture: delivery fan-out, consumer scaling, and retention semantics differ (ch. 3 §3.13/§3.14)',
      operationIds: [op.operationId],
      options: [
        {
          id: 'point-to-point-queue',
          label: 'Queue — each message is delivered to one consumer',
          impact: 'work distribution; consumers compete for messages',
          effects: [{ kind: 'no-change' }],
        },
        {
          id: 'publish-subscribe-topic',
          label: 'Topic — every subscriber receives every message',
          impact: 'event broadcast; each subscriber processes all messages',
          effects: [
            {
              kind: 'amend-create',
              operationId: op.operationId,
              set: [{ path: 'kind', value: 'Topic' }],
            },
          ],
        },
      ],
      recommendedOptionId: 'point-to-point-queue',
    });
  }

  const reduceFacet = facets.find(
    (facet): facet is BudgetFacet => facet.facet === 'budget' && facet.reduce === true,
  );
  if (reduceFacet !== undefined) {
    const sizeOps: OperationEnvelope[] = [];
    const availabilityOps: OperationEnvelope[] = [];
    for (const id of Object.keys(resources).sort()) {
      const entry = resources[id] as ResourceEntry;
      const size = getAtPath(entry, 'spec.size');
      const smaller = typeof size === 'string' ? SIZE_STEP_DOWN[size] : undefined;
      if (smaller !== undefined) {
        sizeOps.push(
          clarificationOperation(
            `op-reduce-size-${id}`,
            'UpdateResource',
            { resourceId: id },
            { set: { 'spec.size': smaller } },
          ),
        );
      }
      const availability = getAtPath(entry, 'spec.availability');
      if (availability === 'high' || availability === 'maximum') {
        availabilityOps.push(
          clarificationOperation(
            `op-reduce-availability-${id}`,
            'UpdateResource',
            { resourceId: id },
            { set: { 'spec.availability': 'standard' } },
          ),
        );
      }
    }
    const options: ClarificationOption[] = [];
    if (sizeOps.length > 0) {
      options.push({
        id: 'reduce-size',
        label: `Reduce compute sizes one step (${sizeOps.length} resource(s))`,
        impact: 'lower capacity per instance; SLO floors unchanged',
        effects: [{ kind: 'add-operations', operations: sizeOps }],
      });
    }
    if (availabilityOps.length > 0) {
      options.push({
        id: 'use-standard-availability',
        label: `Drop high availability to standard (${availabilityOps.length} resource(s))`,
        impact: 'SLO floor drops to 99.9%; single-zone placement becomes acceptable',
        effects: [{ kind: 'add-operations', operations: availabilityOps }],
      });
    }
    options.push({
      id: 'cancel',
      label: 'Do not change anything',
      impact: 'costs stay as they are',
      effects: [{ kind: 'no-change' }],
    });
    questions.push({
      id: 'q-reduce-cost',
      question:
        'Reducing cost can mean smaller compute, lower availability, or both — each changes the architecture differently. Which reduction is intended?',
      trigger: 'divergent-interpretation',
      group: TRIGGER_GROUPS['divergent-interpretation'],
      impact: 'the interpretations materially diverge; none can be assumed (§3.3)',
      operationIds: [],
      options,
      recommendedOptionId: (options[0] as ClarificationOption).id,
    });
  }

  if (facets.length === 0 && (input.unparsed?.length ?? 0) > 0 && operations.length === 0) {
    questions.push({
      id: 'q-unparsed-request',
      question:
        'No part of the request could be parsed into infrastructure intent. Rephrase using concrete vocabulary (e.g. "a web app with a PostgreSQL database behind a gateway").',
      trigger: 'divergent-interpretation',
      group: TRIGGER_GROUPS['divergent-interpretation'],
      impact: 'nothing was extracted; proceeding would mean guessing, which the engine never does',
      operationIds: [],
      options: [],
    });
  }

  /* -- Trigger 3: cost and availability choices conflict ------------------- */
  const budgetFacet = facets.find(
    (facet): facet is BudgetFacet => facet.facet === 'budget' && facet.amountUsd !== undefined,
  );
  if (
    budgetFacet !== undefined &&
    (budgetFacet.amountUsd as number) < HA_DATABASE_BUDGET_FLOOR_USD
  ) {
    const budgetOp = operations.find(
      (op) =>
        op.type === 'SetMetadata' &&
        getAtPath(op.change, 'set') !== undefined &&
        (getAtPath(op.change, 'set') as JsonObject)['annotations.budget-monthly-usd'] !== undefined,
    );
    for (const op of operations) {
      let conflicting = false;
      let amendKind: 'amend-create' | 'amend-set' = 'amend-create';
      if (op.type === 'CreateResource') {
        const change = op.change as CreateResourceChange & JsonObject;
        const availability = getAtPath(change, 'spec.availability');
        conflicting =
          change.kind === 'Database' && (availability === 'high' || availability === 'maximum');
      } else if (op.type === 'UpdateResource') {
        const entry = resources[op.target.resourceId as string] as ResourceEntry | undefined;
        const set = (op.change as ChangeSetUnset).set ?? {};
        const availability = set['spec.availability'];
        conflicting =
          entry?.kind === 'Database' && (availability === 'high' || availability === 'maximum');
        amendKind = 'amend-set';
      }
      if (!conflicting) continue;
      const amount = budgetFacet.amountUsd as number;
      const options: ClarificationOption[] = [
        {
          id: 'raise-budget',
          label: 'Raise the budget',
          impact:
            'keeps the multi-zone database; the recorded monthly budget is raised to the value you provide',
          effects:
            budgetOp !== undefined
              ? [
                  {
                    kind: 'amend-set',
                    operationId: budgetOp.operationId,
                    set: [{ path: 'annotations.budget-monthly-usd', fromAnswer: true }],
                  },
                ]
              : [{ kind: 'no-change' }],
          requiresValue: true,
        },
        {
          id: 'use-standard-availability',
          label: 'Use standard availability',
          impact: `stays within $${amount}/month; the database SLO floor drops to 99.9% and single-zone placement becomes acceptable`,
          effects: [
            {
              kind: amendKind,
              operationId: op.operationId,
              set: [{ path: 'spec.availability', value: 'standard' }],
            },
          ],
        },
        {
          id: 'lower-cost-database-class',
          label: 'Use a lower-cost database class',
          impact: 'keeps the multi-zone SLO floor; the database compute class drops to s',
          effects: [
            {
              kind: amendKind,
              operationId: op.operationId,
              set: [{ path: 'spec.size', value: 's' }],
            },
          ],
        },
      ];
      questions.push({
        id: `q-budget-availability-${op.target.resourceId as string}`,
        question: `You requested high availability and a monthly limit of $${amount}. A multi-zone relational database may exceed that budget. Choose one: raise the budget, use standard availability, or use a lower-cost database class.`,
        field: 'spec.availability',
        trigger: 'cost-availability-conflict',
        group: TRIGGER_GROUPS['cost-availability-conflict'],
        impact: `high availability implies multi-zone topology (ch. 3 §3.2.1), which typically exceeds $${amount}/month for a relational database`,
        operationIds: [op.operationId],
        options,
        recommendedOptionId: 'use-standard-availability',
      });
    }
  }

  /* -- Trigger 4: a destructive update is requested ------------------------ */
  for (const op of operations) {
    const targetId = op.target.resourceId;
    if (targetId === undefined) continue;
    const entry = resources[targetId] as ResourceEntry | undefined;
    if (entry === undefined) continue;
    let reason: string | undefined;
    if (op.type === 'RemoveResource' && isStatefulKind(entry.kind)) {
      reason = `removing ${entry.kind} "${targetId}" destroys stateful data`;
    } else if (op.type === 'UpdateResource') {
      const change = op.change as ChangeSetUnset;
      const touched: string[] = [];
      for (const [path, value] of Object.entries(change.set ?? {})) {
        if (isReplaceEligibleChange(entry.kind, path, getAtPath(entry, path), value))
          touched.push(path);
      }
      for (const path of change.unset ?? []) {
        if (isReplaceEligibleChange(entry.kind, path, getAtPath(entry, path), undefined))
          touched.push(path);
      }
      if (touched.length > 0) {
        reason = `updating ${touched.join(', ')} on ${entry.kind} "${targetId}" is replacement-eligible (destroy and recreate)`;
      }
    }
    if (reason === undefined) continue;
    questions.push({
      id: `q-destructive-${op.operationId}`,
      question: `This change is destructive: ${reason}. Proceed?`,
      trigger: 'destructive-update',
      group: TRIGGER_GROUPS['destructive-update'],
      impact:
        'destructive changes require explicit acknowledgment (ch. 14 §14.2; phase-3 design decision 8)',
      operationIds: [op.operationId],
      options: [
        {
          id: 'proceed',
          label: 'Proceed and acknowledge the destruction',
          impact: 'the resource is destroyed or replaced; data loss is possible',
          effects: [{ kind: 'acknowledge-destructive', operationId: op.operationId }],
        },
        {
          id: 'cancel',
          label: 'Drop this change',
          impact: 'the operation is removed; the resource is untouched',
          effects: [{ kind: 'remove-operation', operationId: op.operationId }],
        },
      ],
      recommendedOptionId: 'cancel',
    });
  }

  /* -- Trigger 5: a compliance requirement lacks scope --------------------- */
  const complianceRequested = facets.some((facet) => facet.facet === 'compliance');
  const policyOps = operations.filter((op) => op.type === 'AddPolicy');
  if (complianceRequested && policyOps.length > 0) {
    const hasDataResource =
      Object.values(resources).some((entry) =>
        DATA_KINDS.includes((entry as ResourceEntry).kind),
      ) ||
      operations.some(
        (op) =>
          op.type === 'CreateResource' &&
          DATA_KINDS.includes((op.change as CreateResourceChange).kind),
      );
    if (!hasDataResource) {
      questions.push({
        id: 'q-compliance-scope',
        question:
          'Compliance controls were requested, but the document has no data services for them to govern. Add the controls anyway?',
        trigger: 'compliance-scope',
        group: TRIGGER_GROUPS['compliance-scope'],
        impact: 'controls without in-scope resources are inert until data services are added',
        operationIds: policyOps.map((op) => op.operationId),
        options: [
          {
            id: 'apply-document-wide',
            label: 'Add the controls now (they apply as data services are added)',
            impact: 'future data services are governed automatically',
            effects: [{ kind: 'no-change' }],
          },
          {
            id: 'drop-controls',
            label: 'Drop the compliance controls',
            impact: 'no policies are added; re-request them once data services exist',
            effects: policyOps.map((op) => ({
              kind: 'remove-operation' as const,
              operationId: op.operationId,
            })),
          },
        ],
        recommendedOptionId: 'apply-document-wide',
      });
    }
  }

  /* -- Trigger 6: provider selection is required ---------------------------- */
  const providerNames = [
    ...new Set(
      facets
        .filter((facet) => facet.facet === 'provider-preference')
        .map((facet) => (facet as { provider: string }).provider),
    ),
  ].sort();
  if (providerNames.length > 1) {
    const providerOp = operations.find(
      (op) =>
        op.type === 'SetMetadata' &&
        (getAtPath(op.change, 'set') as JsonObject | undefined)?.[
          'annotations.provider-preference'
        ] !== undefined,
    );
    questions.push({
      id: 'q-provider-selection',
      question: `The request names more than one provider (${providerNames.join(', ')}). Which one is preferred?`,
      trigger: 'provider-selection',
      group: TRIGGER_GROUPS['provider-selection'],
      impact:
        'the preference is recorded as a non-semantic annotation for planning-time tooling; the document itself stays provider-neutral (ch. 19 §19.5)',
      operationIds: providerOp !== undefined ? [providerOp.operationId] : [],
      options: providerNames.map((provider) => ({
        id: `use-${provider}`,
        label: `Prefer ${provider}`,
        impact: `tooling defaults to ${provider} at planning time`,
        effects:
          providerOp !== undefined
            ? [
                {
                  kind: 'amend-set' as const,
                  operationId: providerOp.operationId,
                  set: [{ path: 'annotations.provider-preference', value: provider }],
                },
              ]
            : [{ kind: 'no-change' as const }],
      })),
      recommendedOptionId: `use-${providerNames[0] as string}`,
    });
  }

  /* -- Trigger 7: an existing-resource reference is unresolved --------------- */
  for (const entry of input.unresolved ?? []) {
    const questionId = `q-ref-${entry.reference.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
    if (questions.some((question) => question.id === questionId)) continue;
    if (entry.candidates.length > 1) {
      const attachedOps =
        entry.operationId !== undefined
          ? [entry.operationId]
          : operations
              .filter(
                (op) =>
                  op.target.resourceId === entry.candidates[0] &&
                  (op.type === 'UpdateResource' ||
                    op.type === 'RemoveResource' ||
                    op.type === 'CreateRelationship'),
              )
              .map((op) => op.operationId);
      questions.push({
        id: questionId,
        question: `"${entry.reference}" matches more than one resource (${entry.candidates.join(', ')}). Which one did you mean?`,
        trigger: 'unresolved-reference',
        group: TRIGGER_GROUPS['unresolved-reference'],
        impact:
          'the proposal currently targets the first match; confirming prevents editing the wrong resource',
        operationIds: attachedOps,
        options: entry.candidates.map((candidate) => ({
          id: `target-${candidate}`,
          label: `Target ${candidate}`,
          impact: `the change applies to ${candidate}`,
          effects: attachedOps.map((operationId) => ({
            kind: 'retarget' as const,
            operationId,
            resourceId: candidate,
          })),
        })),
        recommendedOptionId: `target-${entry.candidates[0] as string}`,
      });
    } else {
      questions.push({
        id: questionId,
        question: `The request refers to "${entry.reference}", which does not resolve to any resource in the document. What should it refer to?`,
        trigger: 'unresolved-reference',
        group: TRIGGER_GROUPS['unresolved-reference'],
        impact: 'no operation was emitted for this part of the request — nothing is guessed',
        operationIds: [],
        options: [],
      });
    }
  }

  /* -- Trigger 8: the request conflicts with policy --------------------------- */
  if (batch !== null && (document.policies ?? []).length > 0) {
    const working = structuredClone(document);
    let applied = true;
    for (const op of batch.operations) {
      const outcome = applyOperationInPlace(working, structuredClone(op));
      if (!outcome.ok) {
        applied = false;
        break;
      }
    }
    if (applied) {
      const ws = await load(JSON.stringify(working), { profile: input.profile ?? null });
      if (ws.document !== undefined) {
        const failures = ws.policies().findings.filter((finding) => finding.severity === 'error');
        const byPolicy = new Map<string, string[]>();
        for (const finding of failures) {
          const policyId = finding.policyId ?? 'policy';
          const paths = byPolicy.get(policyId) ?? [];
          paths.push(finding.path);
          byPolicy.set(policyId, paths);
        }
        for (const [policyId, paths] of [...byPolicy.entries()].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        )) {
          const resourceIds = [
            ...new Set(
              paths
                .map((path) => /^resources\.([^.]+)/.exec(path)?.[1])
                .filter((id): id is string => id !== undefined),
            ),
          ].sort();
          const conflictingOps = batch.operations
            .filter(
              (op) =>
                op.target.resourceId !== undefined && resourceIds.includes(op.target.resourceId),
            )
            .map((op) => op.operationId);
          questions.push({
            id: `q-policy-${policyId}`,
            question: `The requested change violates policy "${policyId}" (${resourceIds.join(', ') || 'document'}). How should this proceed?`,
            trigger: 'policy-conflict',
            group: TRIGGER_GROUPS['policy-conflict'],
            impact:
              'the gate will refuse the batch (validation-failed) while the policy violation stands; only a human may amend the document or the policy (ch. 19 §19.6)',
            operationIds: conflictingOps,
            options: [
              {
                id: 'drop-conflicting-changes',
                label: 'Drop the conflicting change(s)',
                impact: 'the violating operations are removed from the proposal',
                effects: conflictingOps.map((operationId) => ({
                  kind: 'remove-operation' as const,
                  operationId,
                })),
              },
              {
                id: 'keep-and-resolve',
                label: 'Keep the change and resolve the policy separately',
                impact: 'the batch stays uncommittable until the document or policy is amended',
                effects: [{ kind: 'no-change' }],
              },
            ],
            recommendedOptionId: 'drop-conflicting-changes',
          });
        }
      }
    }
  }

  /* -- Deterministic ordering and attachment ---------------------------------- */
  const triggerOrder = new Map(CLARIFICATION_TRIGGERS.map((trigger, index) => [trigger, index]));
  questions.sort((a, b) => {
    const byTrigger =
      (triggerOrder.get(a.trigger) as number) - (triggerOrder.get(b.trigger) as number);
    if (byTrigger !== 0) return byTrigger;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let attached: OperationBatch | null = null;
  if (batch !== null) {
    attached = structuredClone(batch);
    const byId = opsById(attached);
    for (const question of questions) {
      for (const operationId of question.operationIds) {
        const op = byId.get(operationId);
        if (op === undefined) continue;
        if (op.requiredClarifications.some((entry) => entry.id === question.id)) continue;
        const clarification: Clarification = { id: question.id, question: question.question };
        if (question.field !== undefined) clarification.field = question.field;
        op.requiredClarifications.push(clarification);
      }
    }
  }

  return { questions, batch: attached };
}

/* ------------------------------------------------------------------ */
/* Answer application                                                  */
/* ------------------------------------------------------------------ */

/**
 * Apply clarification answers to a proposal batch: execute the chosen
 * options' machine-executable effects, remove the answered questions from
 * the blocked operations, and produce `ConfirmationRecord`s with channel
 * `confirmed-clarification` for every operation whose questions are all
 * answered. Throws `TypeError` for caller misuse (unknown question/option,
 * missing required value, empty identity) — never for document problems.
 */
export function applyClarificationAnswers(
  batch: OperationBatch | null,
  questions: ClarificationQuestion[],
  answers: ClarificationAnswer[],
  identity: AnswerIdentity,
): AnswerApplicationResult {
  if (identity.actor.length === 0 || identity.timestamp.length === 0) {
    throw new TypeError('answer identity requires a non-empty actor and an injected timestamp');
  }
  const working: OperationBatch = structuredClone(
    batch ?? { apiVersion: OPERATIONS_API_VERSION, operations: [] },
  );
  const answered = new Map<string, ClarificationAnswer>();
  for (const answer of answers) {
    const question = questions.find((entry) => entry.id === answer.questionId);
    if (question === undefined) {
      throw new TypeError(`answer references unknown clarification "${answer.questionId}"`);
    }
    answered.set(answer.questionId, answer);
  }

  const removed = new Set<string>();
  const acknowledged = new Set<string>();
  const touchedOps = new Set<string>();
  const opIds = new Set(working.operations.map((op) => op.operationId));

  const findOp = (operationId: string): OperationEnvelope | undefined =>
    working.operations.find((op) => op.operationId === operationId);

  const applyEffect = (effect: AnswerEffect, value: unknown): void => {
    switch (effect.kind) {
      case 'no-change':
        return;
      case 'remove-operation': {
        working.operations = working.operations.filter(
          (op) => op.operationId !== effect.operationId,
        );
        removed.add(effect.operationId);
        return;
      }
      case 'acknowledge-destructive': {
        acknowledged.add(effect.operationId);
        return;
      }
      case 'retarget': {
        const op = findOp(effect.operationId);
        if (op !== undefined) op.target.resourceId = effect.resourceId;
        return;
      }
      case 'amend-create': {
        const op = findOp(effect.operationId);
        if (op === undefined || !isPlainObject(op.change)) return;
        for (const entry of effect.set) {
          const resolved = entry.fromAnswer === true ? value : entry.value;
          if (entry.fromAnswer === true && resolved === undefined) {
            throw new TypeError(`answer for "${effect.operationId}" requires a value`);
          }
          setAtPath(op.change, entry.path, resolved);
        }
        return;
      }
      case 'amend-set': {
        const op = findOp(effect.operationId);
        if (op === undefined) return;
        if (!isPlainObject(op.change)) op.change = {};
        const change = op.change as JsonObject;
        if (!isPlainObject(change.set)) change.set = {};
        for (const entry of effect.set) {
          const resolved = entry.fromAnswer === true ? value : entry.value;
          if (entry.fromAnswer === true && resolved === undefined) {
            throw new TypeError(`answer for "${effect.operationId}" requires a value`);
          }
          (change.set as JsonObject)[entry.path] = resolved;
        }
        return;
      }
      case 'add-operations': {
        for (const op of effect.operations) {
          const clone = structuredClone(op);
          let candidate = clone.operationId;
          let counter = 2;
          while (opIds.has(candidate)) {
            candidate = `${clone.operationId}-${counter}`;
            counter += 1;
          }
          clone.operationId = candidate;
          opIds.add(candidate);
          working.operations.push(clone);
        }
        return;
      }
    }
  };

  // Apply in QUESTION order (deterministic regardless of answer array order).
  for (const question of questions) {
    const answer = answered.get(question.id);
    if (answer === undefined) continue;
    let effects: AnswerEffect[];
    if (question.options.length > 0) {
      const option = question.options.find((entry) => entry.id === answer.optionId);
      if (option === undefined) {
        throw new TypeError(
          `answer for "${question.id}" names unknown option "${answer.optionId ?? '(none)'}"`,
        );
      }
      if (option.requiresValue === true && answer.value === undefined) {
        throw new TypeError(`option "${option.id}" of "${question.id}" requires a value`);
      }
      effects = option.effects;
    } else {
      effects = question.freeFormEffects ?? [];
    }
    for (const effect of effects) applyEffect(effect, answer.value);
    for (const operationId of question.operationIds) {
      const op = findOp(operationId);
      if (op === undefined) continue;
      op.requiredClarifications = op.requiredClarifications.filter(
        (entry) => entry.id !== question.id,
      );
      touchedOps.add(operationId);
    }
  }

  const confirmations: ConfirmationRecord[] = [];
  for (const op of working.operations) {
    if (!touchedOps.has(op.operationId) && !acknowledged.has(op.operationId)) continue;
    if (op.requiredClarifications.length > 0) continue; // still blocked by an unanswered question
    const record: ConfirmationRecord = {
      operationId: op.operationId,
      actor: identity.actor,
      channel: 'confirmed-clarification',
      timestamp: identity.timestamp,
    };
    if (acknowledged.has(op.operationId)) record.acknowledgeDestructive = true;
    confirmations.push(record);
  }

  const unanswered = questions.filter((question) => !answered.has(question.id));
  return {
    batch: working.operations.length > 0 ? working : null,
    confirmations,
    unanswered,
  };
}

/* ------------------------------------------------------------------ */
/* Confirmation report                                                 */
/* ------------------------------------------------------------------ */

export type ConfirmationReason = 'below-confidence-threshold' | 'assumptions' | 'clarifications';

export interface ConfirmationRequirement {
  operationId: string;
  reasons: ConfirmationReason[];
}

/**
 * Report which operations of a proposal cannot commit without a
 * confirmation record (OP-3), and why. A REPORT, not records: the human
 * caller builds the actual `ConfirmationRecord`s — the engine never
 * self-confirms. Destructive acknowledgment is surfaced separately by the
 * `destructive-update` clarification trigger, which needs document context.
 */
export function requiredConfirmations(
  batch: OperationBatch,
  options: { confidenceThreshold?: number } = {},
): ConfirmationRequirement[] {
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const requirements: ConfirmationRequirement[] = [];
  for (const op of batch.operations) {
    const reasons: ConfirmationReason[] = [];
    if (op.confidence < threshold) reasons.push('below-confidence-threshold');
    if (op.assumptions.length > 0) reasons.push('assumptions');
    if (op.requiredClarifications.length > 0) reasons.push('clarifications');
    if (reasons.length > 0) requirements.push({ operationId: op.operationId, reasons });
  }
  return requirements;
}
