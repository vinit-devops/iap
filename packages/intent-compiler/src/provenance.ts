/**
 * Per-field operation provenance (OP-4; phase-3 design decision 6).
 *
 * Every field written by a committed operation gets a record citing the
 * operation id. The source vocabulary is CLOSED; `mapping-default` is
 * reserved — mapping defaults exist right of the boundary and never flow
 * back into documents, but the vocabulary records the value for
 * completeness. Defaults and profile materialization keep their existing
 * canonicalization provenance (`@iap/model`); these records cover the
 * authored writes only. M3.3 extends this model with the clarification
 * engine's answer provenance.
 */

import type {
  ConfirmationChannel,
  OperationEnvelope,
  OperationProvenanceSource,
} from './operations.js';

/** The closed provenance source vocabulary (design decision 6). */
export const PROVENANCE_SOURCES = [
  'explicit-user',
  'confirmed-clarification',
  'organization-profile',
  'policy',
  'iap-default',
  'mapping-default',
  'accepted-recommendation',
] as const;

/** One per-field provenance record: this document path was written by this operation. */
export interface FieldProvenanceRecord {
  /** Document-root dot path of the written field. */
  path: string;
  /** The writing operation's id (OP-4). */
  operationId: string;
  source: OperationProvenanceSource;
}

/**
 * The effective source for fields an operation wrote: the envelope's claimed
 * source, upgraded by the confirmation channel when a human accepted the
 * operation through a clarification or recommendation flow (IEP-0009 rule 3).
 */
export function effectiveSource(
  envelope: OperationEnvelope,
  confirmationChannel: ConfirmationChannel | undefined,
): OperationProvenanceSource {
  if (confirmationChannel === 'confirmed-clarification') return 'confirmed-clarification';
  if (confirmationChannel === 'accepted-recommendation') return 'accepted-recommendation';
  return envelope.provenance.source;
}

/**
 * Attach records for every written path of one operation. Later operations
 * writing the same path overwrite the earlier record (last writer wins), so
 * the batch's record set is total over its written fields.
 */
export function attachProvenance(
  records: Map<string, FieldProvenanceRecord>,
  envelope: OperationEnvelope,
  writes: string[],
  confirmationChannel: ConfirmationChannel | undefined,
): void {
  const source = effectiveSource(envelope, confirmationChannel);
  for (const path of writes) {
    records.set(path, { path, operationId: envelope.operationId, source });
  }
}
