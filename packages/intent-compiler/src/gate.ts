/**
 * The operation gate (IEP-0009 pipeline; phase-3 design decision 4):
 *
 *   proposal → structural validation (strict ajv, embedded companion schema)
 *            → target resolution against the current document
 *            → transactional dry-run apply (copy-on-write document clone)
 *            → full ch. 8 pipeline on the result via @iap/sdk
 *            → confirmation gate (OP-3) + destructive acknowledgment
 *            → commit: document', log entries, canonical hash, preview diff
 *
 * The gate is airtight by construction (OP-1): the ONLY byte-producing path
 * this package exports is the `serialize` method on the committed result,
 * a closure created here after every stage passed. Proposals are data;
 * nothing else in the public surface turns them into document bytes.
 *
 * Batches are atomic (IEP-0009 rule 1): any refusal returns the closed
 * refusal set and the caller's document untouched — `apply` never mutates
 * its input. Determinism: no clock, no randomness, no floating-point
 * arithmetic on any hashed path; confidence values are data compared against
 * the injected threshold, and timestamps/actors arrive only inside
 * caller-supplied confirmation records.
 */

import { canonicalize } from '@iap/model';
import type { Finding, IaPDocument } from '@iap/model';
import { load, validateExtensions } from '@iap/sdk';
import { applyOperationInPlace } from './apply.js';
import type { AppliedStep } from './apply.js';
import type { OperationRefusal } from './errors.js';
import { refuse } from './errors.js';
import type { OperationLogEntry } from './log.js';
import type { ConfirmationChannel, OperationEnvelope } from './operations.js';
import { CONFIRMATION_CHANNELS, DEFAULT_CONFIDENCE_THRESHOLD } from './operations.js';
import type { DestructiveOperation, PreviewDiff } from './preview.js';
import { buildPreviewDiff } from './preview.js';
import type { FieldProvenanceRecord } from './provenance.js';
import { attachProvenance } from './provenance.js';
import { validateBatchStructure } from './schema.js';

/** RFC 3339-style instant; the timestamp is INJECTED by the caller, never read from a clock. */
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Explicit human acceptance of one operation (OP-3). All members are
 * caller-supplied — the gate never generates actors or timestamps from
 * ambient state.
 */
export interface ConfirmationRecord {
  /** The operation this confirmation accepts. */
  operationId: string;
  /** Who accepted (audit identity). */
  actor: string;
  /** How the acceptance happened (IEP-0009 rule 3 channel detail). */
  channel: ConfirmationChannel;
  /** RFC 3339 instant of the acceptance, injected by the caller. */
  timestamp: string;
  /** Required (true) when the operation is flagged destructive (design decision 8). */
  acknowledgeDestructive?: boolean;
}

export interface ApplyOptions {
  /** Confidence threshold for OP-3; default 0.8 (design decision 2). */
  confidenceThreshold?: number;
  /** Confirmation records accepting low-confidence/assumption-bearing/destructive operations. */
  confirmations?: ConfirmationRecord[];
  /** Profile the dry-run validation and canonicalization are relative to (`null`/omitted = base). */
  profile?: string | null;
}

/** Serialization formats of the committed result (the sdk round-trip surface). */
export type CommitSerializeFormat = 'yaml' | 'canonical-json';

/** The gate's commit output — the only source of serializable document bytes (OP-1). */
export interface CommittedBatch {
  /** The resulting document object (a fresh copy; the input document is untouched). */
  document: IaPDocument;
  /** One append-only log entry per operation, in batch order (OP-2). */
  logEntries: OperationLogEntry[];
  /** SHA-256 hex of the resulting document's canonical projection. */
  canonicalHash: string;
  /** Semantic preview of the whole batch, with destructive classification. */
  previewDiff: PreviewDiff;
  /** Per-field provenance records citing operation ids, sorted by path (OP-4). */
  provenance: FieldProvenanceRecord[];
  /** The dry run's surviving findings (warnings only — errors refuse commit). */
  findings: Finding[];
  /** Serialize the committed document: round-trip YAML or the canonical byte projection. */
  serialize(format?: CommitSerializeFormat): string;
}

export type ApplyResult =
  { ok: true; result: CommittedBatch } | { ok: false; refusals: OperationRefusal[] };

function validateConfirmations(confirmations: ConfirmationRecord[]): OperationRefusal[] {
  const refusals: OperationRefusal[] = [];
  const seen = new Set<string>();
  confirmations.forEach((record, index) => {
    const where = `confirmations.${index}`;
    if (typeof record.operationId !== 'string' || record.operationId.length === 0) {
      refusals.push(refuse('invalid-confirmation', `${where}: operationId is required`));
      return;
    }
    if (seen.has(record.operationId)) {
      refusals.push(
        refuse(
          'invalid-confirmation',
          `${where}: duplicate confirmation for operation "${record.operationId}"`,
          { operationId: record.operationId },
        ),
      );
      return;
    }
    seen.add(record.operationId);
    if (typeof record.actor !== 'string' || record.actor.length === 0) {
      refusals.push(
        refuse('invalid-confirmation', `${where}: actor is required`, {
          operationId: record.operationId,
        }),
      );
    }
    if (!(CONFIRMATION_CHANNELS as readonly string[]).includes(record.channel)) {
      refusals.push(
        refuse(
          'invalid-confirmation',
          `${where}: channel must be one of ${CONFIRMATION_CHANNELS.join(', ')}`,
          { operationId: record.operationId },
        ),
      );
    }
    if (typeof record.timestamp !== 'string' || !INSTANT_PATTERN.test(record.timestamp)) {
      refusals.push(
        refuse(
          'invalid-confirmation',
          `${where}: timestamp must be an RFC 3339 instant injected by the caller`,
          { operationId: record.operationId },
        ),
      );
    }
  });
  return refusals;
}

function confirmationGate(
  envelope: OperationEnvelope,
  destructive: DestructiveOperation | undefined,
  confirmation: ConfirmationRecord | undefined,
  threshold: number,
): OperationRefusal[] {
  const refusals: OperationRefusal[] = [];
  const operationId = envelope.operationId;
  if (confirmation === undefined) {
    if (envelope.confidence < threshold) {
      refusals.push(
        refuse(
          'below-confidence-threshold',
          `confidence ${envelope.confidence} is below the session threshold ${threshold}; a confirmation record is required (OP-3)`,
          { operationId },
        ),
      );
    }
    if (envelope.assumptions.length > 0) {
      refusals.push(
        refuse(
          'unconfirmed-assumptions',
          `${envelope.assumptions.length} assumption(s) require a confirmation record (OP-3): ${envelope.assumptions.map((a) => a.field).join(', ')}`,
          { operationId },
        ),
      );
    }
    if (envelope.requiredClarifications.length > 0) {
      refusals.push(
        refuse(
          'unconfirmed-clarifications',
          `${envelope.requiredClarifications.length} required clarification(s) are unanswered (OP-3): ${envelope.requiredClarifications.map((c) => c.id).join(', ')}`,
          { operationId },
        ),
      );
    }
  }
  if (destructive !== undefined && confirmation?.acknowledgeDestructive !== true) {
    refusals.push(
      refuse(
        'unacknowledged-destructive',
        `${destructive.reason} on ${destructive.kind} "${destructive.resourceId}" requires a confirmation with acknowledgeDestructive: true (ch. 14 §14.2, design decision 8)`,
        { operationId, path: `resources.${destructive.resourceId}` },
      ),
    );
  }
  return refusals;
}

/**
 * Apply a proposal batch to a document through the full operation gate.
 * Pure with respect to its inputs: the same document, batch, and options
 * produce the same result (byte-identical serialization); the input document
 * is never mutated. Throws `TypeError` only for caller misuse (an invalid
 * threshold) — every document- or proposal-level problem is a refusal.
 */
export async function apply(
  document: IaPDocument,
  batch: unknown,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  if (typeof threshold !== 'number' || Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    throw new TypeError(
      `confidenceThreshold must be a number in [0, 1]; received ${String(threshold)}`,
    );
  }
  const profile = options.profile ?? null;

  // Stage 0 — confirmation records are caller data; malformed ones refuse.
  const confirmationRefusals = validateConfirmations(options.confirmations ?? []);
  if (confirmationRefusals.length > 0) return { ok: false, refusals: confirmationRefusals };

  // Stage 1 — structural validation against the companion schema (strict ajv).
  const structure = validateBatchStructure(batch);
  if (!structure.ok) return { ok: false, refusals: structure.refusals };
  const operations = structure.batch.operations;

  // Stage 1b — batch conflicts: operation ids must be unique within the batch.
  const ids = new Set<string>();
  for (const envelope of operations) {
    if (ids.has(envelope.operationId)) {
      return {
        ok: false,
        refusals: [
          refuse(
            'batch-conflict',
            `duplicate operationId "${envelope.operationId}" within one batch`,
            { operationId: envelope.operationId },
          ),
        ],
      };
    }
    ids.add(envelope.operationId);
  }
  const confirmationsById = new Map<string, ConfirmationRecord>();
  for (const record of options.confirmations ?? []) {
    if (!ids.has(record.operationId)) {
      return {
        ok: false,
        refusals: [
          refuse(
            'invalid-confirmation',
            `confirmation references operation "${record.operationId}" which is not in the batch`,
            { operationId: record.operationId },
          ),
        ],
      };
    }
    confirmationsById.set(record.operationId, record);
  }

  // Stage 2+3 — target resolution and copy-on-write application, in batch
  // order: each operation resolves against the document state its
  // predecessors produced. First failure aborts (later state is undefined).
  const working = structuredClone(document);
  const steps: AppliedStep[] = [];
  const stepHashes: string[] = [];
  for (const envelope of operations) {
    const outcome = applyOperationInPlace(working, envelope);
    if (!outcome.ok) return { ok: false, refusals: [outcome.refusal] };
    steps.push(outcome.step);
    stepHashes.push(canonicalize(working, { profile }).hash);
  }

  // Stage 4 — the full ch. 8 pipeline on the result, via the @iap/sdk facade:
  // parse + phase 1 through the real parser, phases 1–4 via validate(),
  // phase 5 via policies(), and the phase-8 extension subset. IaP findings
  // pass through with their codes untouched.
  const ws = await load(JSON.stringify(working), { profile });
  const findings: Finding[] = [];
  if (ws.document === undefined) {
    findings.push(...ws.findings);
  } else {
    findings.push(...ws.validate().findings);
    findings.push(...ws.policies().findings);
    findings.push(...validateExtensions(ws.document));
  }
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    return {
      ok: false,
      refusals: [
        refuse(
          'validation-failed',
          `the resulting document fails the ch. 8 pipeline with ${errors.length} error(s): ${[...new Set(errors.map((f) => f.code))].join(', ')}`,
          { findings },
        ),
      ],
    };
  }

  // Stage 5 — confirmation gate (OP-3) and destructive acknowledgment.
  const gateRefusals: OperationRefusal[] = [];
  operations.forEach((envelope, index) => {
    const step = steps[index] as AppliedStep;
    gateRefusals.push(
      ...confirmationGate(
        envelope,
        step.destructive,
        confirmationsById.get(envelope.operationId),
        threshold,
      ),
    );
  });
  if (gateRefusals.length > 0) return { ok: false, refusals: gateRefusals };

  // Stage 6 — commit.
  const canonical = ws.canonical();
  const baseCanonical = canonicalize(document, { profile });
  const destructiveOperations = steps.flatMap((step) =>
    step.destructive === undefined ? [] : [step.destructive],
  );
  const previewDiff = buildPreviewDiff(
    baseCanonical.canonicalJson,
    canonical.canonicalJson,
    destructiveOperations,
  );

  const provenanceByPath = new Map<string, FieldProvenanceRecord>();
  const logEntries: OperationLogEntry[] = operations.map((envelope, index) => {
    const step = steps[index] as AppliedStep;
    const confirmation = confirmationsById.get(envelope.operationId);
    attachProvenance(provenanceByPath, envelope, step.writes, confirmation?.channel);
    const entry: OperationLogEntry = {
      sequence: index,
      envelope: structuredClone(envelope),
      resultingHash: stepHashes[index] as string,
    };
    if (confirmation !== undefined) entry.confirmation = { ...confirmation };
    return entry;
  });
  const provenance = [...provenanceByPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  return {
    ok: true,
    result: {
      document: working,
      logEntries,
      canonicalHash: canonical.hash,
      previewDiff,
      provenance,
      findings,
      serialize: (format: CommitSerializeFormat = 'yaml') => ws.serialize(format),
    },
  };
}
