/**
 * Canonical Infrastructure Model (CIM) types per IEP-0008.
 *
 * The CIM is the normalized, strongly typed in-memory representation of an
 * IaP document that engines consume instead of raw YAML: profile merged (C2),
 * relationships flattened to canonical edges (C3), defaults materialized and
 * quantities/durations normalized (C4). Its byte projection — the canonical
 * JSON of ch. 1 §1.5 steps C5–C6 — is the sole input to hashing and diffing.
 * Provenance and diagnostics are carried out-of-band and never affect the
 * hash (IEP-0008 invariants I1–I2).
 */

import type { API_VERSION } from './index.js';
import type {
  ComplianceFramework,
  Extensions,
  Finding,
  Kind,
  Labels,
  Metadata,
  Output,
  Policy,
  RelationshipType,
} from './index.js';

/** RFC 6901 JSON pointer into the canonical document (e.g. `/resources/web/spec/size`). */
export type JsonPointer = string;

/**
 * Where an effective field value came from. `policy`-sourced values arrive
 * with the policy engine in a later phase (IEP-0008).
 */
export type ProvenanceSource = 'explicit' | 'default' | 'profile';

/** Why a field has its effective value (IEP-0008; roadmap §5.8 — every default is explained). */
export interface ProvenanceRecord {
  source: ProvenanceSource;
  /** Default identifier, profile name, or `document` for authored values. */
  originId: string;
  explanation: string;
}

/**
 * Canonical field pointer → provenance record. Totality (IEP-0008 I4): every
 * effective leaf field of the canonical document has exactly one record.
 */
export type ProvenanceMap = Record<JsonPointer, ProvenanceRecord>;

/**
 * One canonical edge `(source, type, target, attributes)` (ch. 4 §4.2).
 * `description` and `x-*` keys are non-semantic passthrough: they are
 * excluded from edge identity, deduplication, and ordering (ch. 4 §4.7).
 */
export interface CanonicalEdge {
  source: string;
  type: RelationshipType;
  target: string;
  /** Verb-scoped semantic attributes (`port`, `protocol`, `access`, `path`, `host`). */
  attributes: Record<string, string | number>;
  description?: string;
  [xKey: `x-${string}`]: unknown;
}

/**
 * A normalized resource: defaults materialized, quantities/durations
 * canonical. `labels` and `extensions` are always present (empty when the
 * authored document omitted them); the canonical byte projection preserves
 * authored absence, so this normalization never affects the hash.
 */
export interface CanonicalResource {
  kind: Kind;
  labels: Labels;
  /** Kind-specific spec with specification defaults materialized (ch. 1 §1.5.1). */
  spec: Record<string, unknown>;
  extensions: Extensions;
  description?: string;
  [xKey: `x-${string}`]: unknown;
}

/**
 * The Canonical Infrastructure Model: output of the pure function
 * `(document, active profile) → CIM` implemented by `canonicalize()`.
 */
export interface CanonicalModel {
  apiVersion: typeof API_VERSION;
  metadata: Metadata;
  resources: Record<string, CanonicalResource>;
  /** C3 output — sorted by (source, verb enum order, target, serialized attributes). */
  edges: CanonicalEdge[];
  policies: Policy[];
  compliance?: { frameworks?: ComplianceFramework[] };
  /** Namespaced extension bags, preserved verbatim and never interpreted (ch. 11). */
  extensions?: Extensions;
  outputs?: Record<string, Output>;
  /** The active profile the model is relative to; `profiles` is removed post-merge (C2). */
  profile: string | null;
  /** SHA-256 (hex) of the canonical JSON serialization (C5+C6 projection). */
  hash: string;
  provenance: ProvenanceMap;
  /** Non-semantic findings gathered during canonicalization; never affect the hash. */
  diagnostics: Finding[];
}
