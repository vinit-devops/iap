/**
 * The append-only operation log (IEP-0009 rule 4, OP-2).
 *
 * Each committed operation appends one entry: the envelope as validated, the
 * confirmation that accepted it (when one was required), and the canonical
 * document hash after the operation applied. Replaying a confirmed batch
 * against the same base document yields a byte-identical serialization; the
 * recorded hashes are verified during replay, so a log cannot silently be
 * replayed against the wrong base (fail closed).
 */

import type { IaPDocument } from '@iap/model';
import type { CommittedBatch, ConfirmationRecord, ApplyOptions } from './gate.js';
import { apply } from './gate.js';
import type { OperationEnvelope } from './operations.js';
import { OPERATIONS_API_VERSION } from './operations.js';

/** One append-only log entry for a committed operation. */
export interface OperationLogEntry {
  /** Zero-based position within the committed batch. */
  sequence: number;
  /** The operation envelope exactly as validated and applied. */
  envelope: OperationEnvelope;
  /** The confirmation that accepted the operation, when one was required (OP-3). */
  confirmation?: ConfirmationRecord;
  /** Canonical document hash (SHA-256 hex) after operations 0..sequence applied. */
  resultingHash: string;
}

/**
 * Replay a committed batch from its log entries against the same base
 * document (OP-2). Throws `TypeError` — caller misuse, never a document
 * problem — when the entries are not a contiguous 0..n-1 sequence, when the
 * gate refuses (the base is not the document the log was recorded against),
 * or when any recorded hash differs from the recomputed one.
 */
export async function replay(
  baseDocument: IaPDocument,
  logEntries: OperationLogEntry[],
  options: ApplyOptions = {},
): Promise<CommittedBatch> {
  const sorted = [...logEntries].sort((a, b) => a.sequence - b.sequence);
  sorted.forEach((entry, index) => {
    if (entry.sequence !== index) {
      throw new TypeError(
        `operation log is not contiguous: expected sequence ${index}, found ${entry.sequence}`,
      );
    }
  });

  const confirmations: ConfirmationRecord[] = [];
  for (const entry of sorted) {
    if (entry.confirmation !== undefined) confirmations.push(entry.confirmation);
  }
  const replayOptions: ApplyOptions = { ...options };
  if (options.confirmations === undefined && confirmations.length > 0) {
    replayOptions.confirmations = confirmations;
  }

  const outcome = await apply(
    baseDocument,
    {
      apiVersion: OPERATIONS_API_VERSION,
      operations: sorted.map((entry) => entry.envelope),
    },
    replayOptions,
  );
  if (!outcome.ok) {
    const codes = outcome.refusals.map((refusal) => refusal.code).join(', ');
    throw new TypeError(
      `replay refused (${codes}) — the base document is not the one the log was recorded against`,
    );
  }
  outcome.result.logEntries.forEach((entry, index) => {
    const recorded = sorted[index] as OperationLogEntry;
    if (entry.resultingHash !== recorded.resultingHash) {
      throw new TypeError(
        `replay hash mismatch at sequence ${index}: recorded ${recorded.resultingHash}, recomputed ${entry.resultingHash}`,
      );
    }
  });
  return outcome.result;
}
