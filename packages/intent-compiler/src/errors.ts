/**
 * The closed operation-error taxonomy (phase-3 design decision 3).
 *
 * These are the gate's OWN refusal codes — package-level, machine-readable,
 * and closed, following the mapping-diagnostics (phase 6) and plan-refusal
 * (phase 7) precedent: ch. 8 owns validation-stage IaP codes only, and
 * registry registration goes to the standing candidate-diagnostics IEP.
 * IaP findings raised by the dry run pass through UNTOUCHED inside a
 * `validation-failed` refusal — the gate never rewrites, renumbers, or
 * summarizes them.
 */

import type { Finding } from '@iap/model';

export const OPERATION_ERROR_CODES = [
  /** The operation `type` is outside the closed twelve-type vocabulary. */
  'invalid-operation-type',
  /** The batch or an envelope violates the companion schema structurally. */
  'schema-violation',
  /** An identifier violates its grammar (resource/profile/policy DNS label, extension namespace). */
  'id-grammar',
  /** The operation's target does not resolve against the document at its point in the batch. */
  'dangling-target',
  /** A (verb, target) relationship reference matches more than one edge. */
  'ambiguous-target',
  /** A create-type operation targets something that already exists. */
  'duplicate-create',
  /** Operations within one batch conflict (duplicate operationIds). */
  'batch-conflict',
  /** A set/unset path is not permitted for the targeted construct. */
  'invalid-change-path',
  /** A core operation reached into `extensions`, or vice versa (ch. 11 non-interference). */
  'extension-namespace-violation',
  /** The dry-run ch. 8 pipeline produced error-severity findings on the resulting document. */
  'validation-failed',
  /** Confidence below the session threshold without a recorded confirmation (OP-3). */
  'below-confidence-threshold',
  /** Non-empty assumptions without a recorded confirmation (OP-3). */
  'unconfirmed-assumptions',
  /** Non-empty requiredClarifications without a recorded confirmation (OP-3). */
  'unconfirmed-clarifications',
  /** A destructive operation without `acknowledgeDestructive` in its confirmation (design decision 8). */
  'unacknowledged-destructive',
  /** A supplied confirmation record is malformed (missing actor, channel, or injected timestamp). */
  'invalid-confirmation',
] as const;

export type OperationErrorCode = (typeof OPERATION_ERROR_CODES)[number];

/**
 * One machine-readable refusal. Batch-level refusals carry no operationId;
 * `findings` is present exactly on `validation-failed`, carrying the dry
 * run's IaP findings with their codes untouched.
 */
export interface OperationRefusal {
  code: OperationErrorCode;
  operationId?: string;
  /** Document or target-relative dot path when one is attributable. */
  path?: string;
  message: string;
  findings?: Finding[];
}

/** Build a refusal without undefined members (exactOptionalPropertyTypes). */
export function refuse(
  code: OperationErrorCode,
  message: string,
  detail: { operationId?: string; path?: string; findings?: Finding[] } = {},
): OperationRefusal {
  const refusal: OperationRefusal = { code, message };
  if (detail.operationId !== undefined) refusal.operationId = detail.operationId;
  if (detail.path !== undefined) refusal.path = detail.path;
  if (detail.findings !== undefined) refusal.findings = detail.findings;
  return refusal;
}
