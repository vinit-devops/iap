/**
 * The closed IEP-0009 operation vocabulary and envelope types.
 *
 * The normative machine-readable contract is
 * `spec/schema/compiler-operations-v1.schema.json` (embedded copy under
 * `../schemas/`, drift-tested by byte equality). The types here mirror that
 * schema for strongly typed consumption; where they disagree, the schema
 * governs. A drift test asserts the constants below stay identical to the
 * schema's enums.
 */

import type { Finding, Kind, RelationshipEdge, RelationshipType } from '@iap/model';
import { API_VERSION } from '@iap/model';
import type { IaPDocument } from '@iap/model';

/** Batch artifact format identifier (companion schema `$id` apiVersion). */
export const OPERATIONS_API_VERSION = 'operations.iap.dev/v1' as const;

/** The twelve-operation vocabulary, closed in v1 (IEP-0009 detailed design). */
export const OPERATION_TYPES = [
  'CreateResource',
  'UpdateResource',
  'RemoveResource',
  'CreateRelationship',
  'UpdateRelationship',
  'RemoveRelationship',
  'ApplyProfile',
  'RemoveProfile',
  'AddPolicy',
  'ChangeConstraint',
  'SetMetadata',
  'SetExtensionValue',
] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];

/**
 * Confidence threshold below which an operation cannot commit without a
 * recorded confirmation (IEP-0009 open question 3, resolved to 0.8 by
 * phase-3 design decision 2). Configurable per apply session.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Confirmation channels (IEP-0009 rule 3): how a human accepted an
 * assumption-bearing, low-confidence, or destructive operation.
 */
export const CONFIRMATION_CHANNELS = [
  'user-input',
  'confirmed-clarification',
  'accepted-recommendation',
] as const;

export type ConfirmationChannel = (typeof CONFIRMATION_CHANNELS)[number];

/** Authoring surfaces that produce proposals (IEP-0009 summary; `api` covers programmatic callers). */
export const PROPOSAL_CHANNELS = [
  'natural-language',
  'guided-ui',
  'ide-command',
  'visual-designer',
  'api',
] as const;

export type ProposalChannel = (typeof PROPOSAL_CHANNELS)[number];

/**
 * Stateful kinds (ch. 14 §14.2): RemoveResource on any of these is flagged
 * destructive and requires explicit acknowledgment (design decision 8).
 */
export const STATEFUL_KINDS = [
  'Database',
  'Volume',
  'ObjectStore',
  'Queue',
  'Topic',
  'Secret',
] as const;

export type StatefulKind = (typeof STATEFUL_KINDS)[number];

/** One extracted-but-assumed value; any non-empty list forces confirmation (OP-3). */
export interface Assumption {
  /** Target-relative dot path of the assumed field. */
  field: string;
  /** The assumed value. */
  assumed: unknown;
  /** Why the value was assumed rather than asked for. */
  reason: string;
}

/** One machine-readable clarification question blocking an operation (OP-3; M3.3 engine). */
export interface Clarification {
  id: string;
  question: string;
  /** Target-relative dot path of the field the question blocks. */
  field?: string;
}

/** Where in the source input the operation was extracted from. */
export interface SourceSpan {
  input: string;
  start: number;
  end: number;
  text?: string;
}

/** Closed provenance source vocabulary — see `PROVENANCE_SOURCES` in provenance.ts. */
export type OperationProvenanceSource =
  | 'explicit-user'
  | 'confirmed-clarification'
  | 'organization-profile'
  | 'policy'
  | 'iap-default'
  | 'mapping-default'
  | 'accepted-recommendation';

/** Where a proposal came from; modelId/promptVersion are audit data and never influence application (OP-2). */
export interface ProposalProvenance {
  source: OperationProvenanceSource;
  channel: ProposalChannel;
  modelId?: string;
  promptVersion?: string;
}

/** Explicit update payload (design decision 2): set paths to values, unset paths to remove. */
export interface ChangeSetUnset {
  set?: Record<string, unknown>;
  unset?: string[];
}

/** Identifies one existing inline edge by its (verb, target) pair. */
export interface RelationshipRef {
  type: RelationshipType;
  target: string;
}

/** What an operation addresses; required members depend on the operation type. */
export interface OperationTarget {
  resourceId?: string;
  profile?: string;
  policyId?: string;
  namespace?: string;
  relationship?: RelationshipRef;
}

/** CreateResource payload: the complete entry, minus `extensions` (SetExtensionValue is the sole path). */
export interface CreateResourceChange {
  kind: Kind;
  description?: string;
  labels?: Record<string, string>;
  spec?: Record<string, unknown>;
  relationships?: RelationshipEdge[];
  [xKey: `x-${string}`]: unknown;
}

/** ApplyProfile payload: the complete profile definition (upsert semantics). */
export interface ProfileChange {
  description?: string;
  extends?: string;
  overrides?: Record<string, unknown>;
  [xKey: `x-${string}`]: unknown;
}

/** AddPolicy payload: the policy body; the id comes from `target.policyId`. */
export interface PolicyChange {
  description?: string;
  target: { kinds?: Kind[]; selector?: { kinds?: Kind[]; labels: Record<string, string> } };
  rule: Record<string, unknown>;
  effect: 'deny' | 'warn' | 'require';
  params?: Record<string, string | number | boolean>;
}

/** Gate OUTPUT echoed on stored envelopes; always recomputed, never trusted. */
export interface EchoedValidationResult {
  status: 'pass' | 'fail';
  findings: Finding[];
}

/** Gate OUTPUT echoed on stored envelopes; always recomputed, never trusted. */
export interface EchoedPreviewDiff {
  format: 'iap-semantic-diff/v1';
  adds?: string[];
  removes?: string[];
  changes?: string[];
  destructive?: boolean;
  destructiveOperations?: unknown[];
}

/**
 * One enveloped operation (IEP-0009): the typed change request plus the
 * metadata that makes proposals inspectable, individually validated,
 * replayable, and model-independent. `operationId` is caller-supplied —
 * never generated from ambient state.
 */
export interface OperationEnvelope {
  operationId: string;
  type: OperationType;
  target: OperationTarget;
  /** Payload; shape depends on `type` (schema branches govern). Absent for remove-type operations. */
  change?: unknown;
  sourceSpan?: SourceSpan;
  confidence: number;
  assumptions: Assumption[];
  requiredClarifications: Clarification[];
  provenance: ProposalProvenance;
  validationResult?: EchoedValidationResult;
  previewDiff?: EchoedPreviewDiff;
}

/** An ordered proposal batch, applied transactionally (IEP-0009 rule 1). */
export interface OperationBatch {
  apiVersion: typeof OPERATIONS_API_VERSION;
  operations: OperationEnvelope[];
}

/**
 * A minimal document skeleton to author into: the required top-level keys
 * with an empty `resources` map. Deliberately NOT valid on its own (the
 * document schema requires at least one resource) — only the gate's dry run
 * decides validity of the RESULT; the base may be any parsed document.
 */
export function emptyDocument(name: string): IaPDocument {
  return {
    apiVersion: API_VERSION,
    metadata: { name },
    resources: {},
  };
}
