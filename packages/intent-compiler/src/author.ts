/**
 * `runAuthoringSession` — the natural-language authoring prototype (M3.5).
 *
 * A single deterministic orchestrator that drives one natural-language
 * request all the way through the M3.2–M3.4 surface to a committed document,
 * or stops honestly at the first thing only a human can decide:
 *
 *   adapter session (extract) → compileFacets → clarify → answer resolution
 *   → applyClarificationAnswers → requiredConfirmations → apply (the gate)
 *
 * This is the reusable engine the Phase 5 `iap create` command (M5.3) will
 * wrap — the CLI adds argument parsing, interactive prompting, and rendering;
 * the authoring logic and every normative boundary live here.
 *
 * Determinism and the boundary (ch. 19 / phase-3 exit criteria):
 * - No clock and no randomness. Every audit timestamp is INJECTED by the
 *   caller (`options.timestamp`); identical inputs produce byte-identical
 *   committed output (exit criterion 4).
 * - The engine only ever emits DATA up to the gate — facets, a proposal
 *   batch, questions, prose. `apply` is the sole path to document bytes; an
 *   LLM adapter never writes YAML (OP-1).
 * - Low-confidence and assumption-bearing operations require a confirmation
 *   (OP-3); destructive operations require an EXPLICIT acknowledgment and are
 *   never auto-acknowledged unless the caller opts in (§19.6, design
 *   decision 8). Absent that, the session stops at `needs-input` rather than
 *   guessing a human "yes".
 */
import type { IaPDocument } from '@iap/model';
import type {
  AdapterRefusal,
  AdapterSessionConfig,
  AuthoringRequest,
  ModelAdapter,
} from './adapter.js';
import { createAdapterSession, rulesAdapter } from './adapter.js';
import type { CompileResult, UnresolvedSubject } from './compile.js';
import { compileFacets } from './compile.js';
import type { ClarificationAnswer, ClarificationQuestion, ClarifyResult } from './clarify.js';
import { applyClarificationAnswers, clarify, requiredConfirmations } from './clarify.js';
import { emptyDocument } from './operations.js';
import type { OperationBatch } from './operations.js';
import type { ExtractionResult, IntentFacet, UnparsedSpan, UnsupportedFinding } from './facets.js';
import type { ClarificationTrigger } from './clarify.js';
import { apply } from './gate.js';
import type { CommittedBatch, ConfirmationRecord } from './gate.js';
import type { OperationRefusal } from './errors.js';
import { explainBatch } from './explain.js';
import type { ExplainResult } from './explain.js';

/** How a session ended. Closed vocabulary. */
export const AUTHORING_OUTCOMES = [
  /** The request committed to a valid document through the full ch. 8 pipeline. */
  'committed',
  /** The explain directive was given: the engine narrated, it did not author (§3.5). */
  'explained',
  /** Nothing derivable — the request compiled to no operations (e.g. wholly unsupported). */
  'no-operations',
  /** A human decision is required: unanswered questions or unacknowledged destructive change. */
  'needs-input',
  /** Refused: an adapter refusal, or the gate rejected the batch for a non-human-gate reason. */
  'refused',
] as const;

export type AuthoringOutcome = (typeof AUTHORING_OUTCOMES)[number];

export interface AuthoringSessionOptions {
  /** The model adapter to drive. Default: the in-repo deterministic `rulesAdapter()`. */
  adapter?: ModelAdapter;
  /** Enforcement middleware configuration (limits, redactors, residency). */
  sessionConfig?: AdapterSessionConfig;
  /** The base document to author into. Default: `emptyDocument(documentName)`. */
  document?: IaPDocument;
  /** Name for the default empty document when `document` is omitted. Default `authoring-session`. */
  documentName?: string;
  /** Request identity; source spans and fixture recordings key off it. Default `authoring-request`. */
  requestId?: string;
  /** Profile the whole flow is relative to (`null`/omitted = base document). */
  profile?: string | null;
  /** Audit actor recorded on answers and confirmations. Default `authoring-prototype`. */
  actor?: string;
  /** REQUIRED injected audit instant (RFC 3339). Never read from a clock. */
  timestamp: string;
  /** OP-3 confidence threshold; default 0.8 (design decision 2). */
  confidenceThreshold?: number;
  /** Explicit answers to clarification questions (by question id). */
  answers?: ClarificationAnswer[];
  /**
   * Auto-select each unanswered closed question's recommended default
   * (`recommendedOptionId`), when the recommended option needs no value.
   * Free-form and value-requiring questions still stop the session.
   */
  autoAnswerDefaults?: boolean;
  /**
   * Acknowledge destructive operations on the caller's behalf (§19.6 human
   * gate). Default false: destructive changes stop the session at
   * `needs-input` so a human can explicitly acknowledge them.
   */
  acknowledgeDestructive?: boolean;
}

/** One clarification the engine answered, with the option it chose. */
export interface ResolvedAnswer {
  questionId: string;
  /** The chosen option id, or undefined for a free-form value answer. */
  optionId?: string | undefined;
  /** The supplied value, when the answer carried one. */
  value?: unknown;
  /** True when the engine chose the recommended default rather than the caller. */
  fromRecommendedDefault: boolean;
}

export interface AuthoringSessionResult {
  outcome: AuthoringOutcome;
  /** The request as driven (post-defaulting of ids/document). */
  request: AuthoringRequest;
  /** Everything the extractor produced (facets + unparsed + unsupported + explain flag). */
  extraction: ExtractionResult;
  facets: IntentFacet[];
  unparsed: UnparsedSpan[];
  /** Capabilities the request asked for that v1 core cannot express. */
  unsupported: UnsupportedFinding[];
  /** Subject references the compiler could not resolve. */
  unresolved: UnresolvedSubject[];
  /** The compiled proposal, before clarification attachment (null = no operations). */
  compiledBatch: OperationBatch | null;
  /** The proposal actually driven to the gate (post clarification/answers). */
  batch: OperationBatch | null;
  /** Every clarification question the engine surfaced. */
  questions: ClarificationQuestion[];
  /** Distinct triggers that fired, sorted — the clarification-precision signal. */
  firedTriggers: ClarificationTrigger[];
  /** Questions the engine answered (explicitly or via recommended defaults). */
  answered: ResolvedAnswer[];
  /** Questions still blocking a commit (a human must decide). */
  unanswered: ClarificationQuestion[];
  /** The confirmation records assembled for the commit. */
  confirmations: ConfirmationRecord[];
  /** A deterministic prose preview of the change, when a batch existed. */
  explain?: ExplainResult | undefined;
  /** The committed document and its provenance, when `outcome === 'committed'`. */
  committed?: CommittedBatch | undefined;
  /** Adapter and/or gate refusals, when the session did not commit. */
  refusals: (AdapterRefusal | OperationRefusal)[];
}

const DEFAULT_ACTOR = 'authoring-prototype';

function distinctSortedTriggers(questions: ClarificationQuestion[]): ClarificationTrigger[] {
  return [...new Set(questions.map((q) => q.trigger))].sort();
}

/**
 * Resolve which questions can be answered without a human. Explicit caller
 * answers win. Then, when `acknowledgeDestructive` is set, each destructive
 * question is answered with its acknowledgment option (never the safe default,
 * which cancels the change). Then, when `autoAnswerDefaults` is set, each
 * remaining closed question with a recommended option that needs no value is
 * answered with that default. Everything else is left for a human.
 */
function resolveAnswers(
  questions: ClarificationQuestion[],
  explicit: ClarificationAnswer[],
  autoAnswerDefaults: boolean,
  acknowledgeDestructive: boolean,
): { answers: ClarificationAnswer[]; resolved: ResolvedAnswer[] } {
  const byId = new Map(explicit.map((a) => [a.questionId, a]));
  const answers: ClarificationAnswer[] = [];
  const resolved: ResolvedAnswer[] = [];

  for (const question of questions) {
    const supplied = byId.get(question.id);
    if (supplied !== undefined) {
      answers.push(supplied);
      resolved.push({
        questionId: supplied.questionId,
        optionId: supplied.optionId,
        value: supplied.value,
        fromRecommendedDefault: false,
      });
      continue;
    }
    // A destructive question's safe default cancels the change; an explicit
    // acknowledgment authority instead chooses the proceed/acknowledge option.
    if (acknowledgeDestructive && question.trigger === 'destructive-update') {
      const proceed = question.options.find((opt) =>
        opt.effects.some((effect) => effect.kind === 'acknowledge-destructive'),
      );
      if (proceed !== undefined && proceed.requiresValue !== true) {
        answers.push({ questionId: question.id, optionId: proceed.id });
        resolved.push({
          questionId: question.id,
          optionId: proceed.id,
          fromRecommendedDefault: false,
        });
        continue;
      }
    }
    if (!autoAnswerDefaults) continue;
    const recommendedId = question.recommendedOptionId;
    if (recommendedId === undefined) continue;
    const option = question.options.find((opt) => opt.id === recommendedId);
    // A default that still needs a value cannot be chosen unattended; a
    // free-form question (no options) has no default to choose.
    if (option === undefined || option.requiresValue === true) continue;
    const answer: ClarificationAnswer = { questionId: question.id, optionId: recommendedId };
    answers.push(answer);
    resolved.push({
      questionId: question.id,
      optionId: recommendedId,
      fromRecommendedDefault: true,
    });
  }
  return { answers, resolved };
}

/**
 * Build the confirmation records for a commit. Every operation needing OP-3
 * confirmation (low confidence, assumptions, attached clarifications) gets a
 * `user-input` record; clarification-answer confirmations are merged in.
 * Destructive operations named by `destructiveOperationIds` are acknowledged
 * only when `acknowledgeDestructive` is set.
 */
function buildConfirmations(
  batch: OperationBatch,
  clarificationConfirmations: ConfirmationRecord[],
  actor: string,
  timestamp: string,
  confidenceThreshold: number | undefined,
  destructiveOperationIds: Set<string>,
  acknowledgeDestructive: boolean,
): ConfirmationRecord[] {
  const byOp = new Map<string, ConfirmationRecord>();
  for (const record of clarificationConfirmations) byOp.set(record.operationId, record);

  const needs = requiredConfirmations(
    batch,
    confidenceThreshold === undefined ? {} : { confidenceThreshold },
  );
  for (const need of needs) {
    if (!byOp.has(need.operationId)) {
      byOp.set(need.operationId, {
        operationId: need.operationId,
        actor,
        channel: 'user-input',
        timestamp,
      });
    }
  }

  if (acknowledgeDestructive) {
    for (const operationId of destructiveOperationIds) {
      const existing = byOp.get(operationId);
      if (existing === undefined) {
        byOp.set(operationId, {
          operationId,
          actor,
          channel: 'user-input',
          timestamp,
          acknowledgeDestructive: true,
        });
      } else {
        byOp.set(operationId, { ...existing, acknowledgeDestructive: true });
      }
    }
  }

  // Deterministic order: batch operation order.
  return batch.operations
    .map((op) => byOp.get(op.operationId))
    .filter((record): record is ConfirmationRecord => record !== undefined);
}

/**
 * Drive one natural-language request through the whole authoring pipeline.
 * Pure with respect to wall-clock time (the audit timestamp is injected) and
 * never mutates the input document. Resolves to a structured transcript; it
 * throws only for caller misuse surfaced by the underlying gate (an invalid
 * confidence threshold).
 */
export async function runAuthoringSession(
  input: string,
  options: AuthoringSessionOptions,
): Promise<AuthoringSessionResult> {
  const actor = options.actor ?? DEFAULT_ACTOR;
  const timestamp = options.timestamp;
  const requestId = options.requestId ?? 'authoring-request';
  const document = options.document ?? emptyDocument(options.documentName ?? 'authoring-session');
  const profile = options.profile ?? null;
  const request: AuthoringRequest = { requestId, input, document, profile };

  const session = createAdapterSession(options.adapter ?? rulesAdapter(), options.sessionConfig);
  const outcome = await session.extract(request);

  // Adapter/middleware refusal: nothing was extracted.
  if (!outcome.ok) {
    const empty: ExtractionResult = { facets: [], unparsed: [], unsupported: [] };
    return {
      outcome: 'refused',
      request,
      extraction: empty,
      facets: [],
      unparsed: [],
      unsupported: [],
      unresolved: [],
      compiledBatch: null,
      batch: null,
      questions: [],
      firedTriggers: [],
      answered: [],
      unanswered: [],
      confirmations: [],
      refusals: outcome.refusals,
    };
  }

  const extraction = outcome.result;
  const compiled: CompileResult = compileFacets(extraction.facets, document, {
    modelId: session.adapterId,
    promptVersion: '1',
  });

  const base = {
    request,
    extraction,
    facets: extraction.facets,
    unparsed: extraction.unparsed,
    unsupported: [...compiled.unsupported, ...extraction.unsupported],
    unresolved: compiled.unresolved,
    compiledBatch: compiled.batch,
  };

  // The explain directive (§3.5): narrate, do not author.
  if (extraction.explain === true) {
    return {
      ...base,
      outcome: 'explained',
      batch: null,
      questions: [],
      firedTriggers: [],
      answered: [],
      unanswered: [],
      confirmations: [],
      refusals: [],
    };
  }

  // No derivable operations (e.g. a wholly unsupported request).
  if (compiled.batch === null) {
    return {
      ...base,
      outcome: 'no-operations',
      batch: null,
      questions: [],
      firedTriggers: [],
      answered: [],
      unanswered: [],
      confirmations: [],
      refusals: [],
    };
  }

  const clarified: ClarifyResult = await clarify({
    document,
    batch: compiled.batch,
    facets: extraction.facets,
    unresolved: compiled.unresolved,
    unparsed: extraction.unparsed,
    profile,
  });
  const questions = clarified.questions;
  const firedTriggers = distinctSortedTriggers(questions);

  const { answers, resolved } = resolveAnswers(
    questions,
    options.answers ?? [],
    options.autoAnswerDefaults === true,
    options.acknowledgeDestructive === true,
  );
  const applied = applyClarificationAnswers(clarified.batch, questions, answers, {
    actor,
    timestamp,
  });
  const batch = applied.batch;

  const preview = batch === null ? undefined : explainBatch(document, batch, { profile });

  // A blocking question a human still has to answer.
  if (applied.unanswered.length > 0 || batch === null) {
    return {
      ...base,
      outcome: 'needs-input',
      batch,
      questions,
      firedTriggers,
      answered: resolved,
      unanswered: applied.unanswered,
      confirmations: [],
      explain: preview,
      refusals: [],
    };
  }

  // Discover destructive operations from the preview (the gate's own
  // classifier), so they can be acknowledged deterministically in one pass.
  const destructiveOperationIds = new Set<string>(
    preview !== undefined && preview.ok
      ? preview.diff.destructiveOperations.map((entry) => entry.operationId)
      : [],
  );

  // A destructive change with no acknowledgment authority: stop for a human.
  if (destructiveOperationIds.size > 0 && options.acknowledgeDestructive !== true) {
    return {
      ...base,
      outcome: 'needs-input',
      batch,
      questions,
      firedTriggers,
      answered: resolved,
      unanswered: [],
      confirmations: [],
      explain: preview,
      refusals: [],
    };
  }

  const confirmations = buildConfirmations(
    batch,
    applied.confirmations,
    actor,
    timestamp,
    options.confidenceThreshold,
    destructiveOperationIds,
    options.acknowledgeDestructive === true,
  );

  const applyOptions =
    options.confidenceThreshold === undefined
      ? { confirmations, profile }
      : { confirmations, profile, confidenceThreshold: options.confidenceThreshold };
  const result = await apply(document, batch, applyOptions);

  if (!result.ok) {
    return {
      ...base,
      outcome: 'refused',
      batch,
      questions,
      firedTriggers,
      answered: resolved,
      unanswered: [],
      confirmations,
      explain: preview,
      refusals: result.refusals,
    };
  }

  return {
    ...base,
    outcome: 'committed',
    batch,
    questions,
    firedTriggers,
    answered: resolved,
    unanswered: [],
    confirmations,
    explain: preview,
    committed: result.result,
    refusals: [],
  };
}
