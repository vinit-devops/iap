/**
 * @iap/model — Canonical Infrastructure Model types for IaP v1 (`iap.dev/v1`).
 *
 * The normative machine-readable contract is `spec/schema/iap-v1.schema.json`
 * (ADR-0002). The types here mirror the schema for ergonomic, strongly typed
 * consumption; a drift test asserts the constants below stay identical to the
 * schema's enums, and the embedded schema copies stay byte-identical to the
 * spec's. Where these types and the schema disagree, the schema governs.
 */

export const API_VERSION = 'iap.dev/v1' as const;

/**
 * Pre-release `apiVersion` values that are NO LONGER SUPPORTED after the hard
 * IIS→IaP rename (ADR-0003, IEP-0014). These are NOT accepted: a document
 * declaring one is REJECTED (IAP101), with a clearer message pointing at
 * {@link API_VERSION}. Retained only to drive that rejection message and the
 * regression test — there is no compatibility window and no normalization.
 */
export const LEGACY_API_VERSIONS = ['iis.dev/v1'] as const;

export type LegacyApiVersion = (typeof LEGACY_API_VERSIONS)[number];

/** DNS-label grammar for resource identifiers (spec ch. 2 §2.6.1). */
export const RESOURCE_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Kinds fully specified since 1.0.0 (spec ch. 3 §3.4–§3.16). Deliberately
 * NOT extended by the 1.1.0 or 1.2.0 graduations: downstream tables keyed by
 * CORE_KINDS (e.g. the provider-sdk abstract-output registry and the
 * planner's kind reconstruction) cover exactly these thirteen kinds until
 * provider support for the graduated kinds lands (M23.2 onward). Use
 * {@link GRADUATED_KINDS} / {@link isSpecifiedKind} for the graduated tiers.
 */
export const CORE_KINDS = [
  'Application',
  'Service',
  'Job',
  'Function',
  'Gateway',
  'Database',
  'Cache',
  'ObjectStore',
  'Volume',
  'Queue',
  'Topic',
  'Identity',
  'Secret',
] as const;

/**
 * Kinds graduated from the reserved registry to fully specified kinds, in two
 * waves: `Certificate`, `DnsZone`, `Registry`, `Dashboard`, `Alert` in spec
 * 1.1.0 (IEP-0015, ch. 3 §3.17–§3.21) and `Network`, `Stream`, `Workflow`,
 * `SearchIndex` in spec 1.2.0 (IEP-0016, ch. 3 §3.22–§3.25), both via the
 * ch. 5 §5.6 promotion process. Each is schema-validated against its own
 * `$defs/kinds/<Kind>` definition; IAP801 no longer applies to any of them.
 * After 1.2.0 this tier holds all nine originally reserved kinds and the
 * reserved registry is empty.
 */
export const GRADUATED_KINDS = [
  'Certificate',
  'DnsZone',
  'Registry',
  'Dashboard',
  'Alert',
  'Network',
  'Stream',
  'Workflow',
  'SearchIndex',
] as const;

/**
 * Reserved registry kinds (spec ch. 5 §5.3) — loose validation, IAP801
 * warning. EMPTY as of spec 1.2.0 (IEP-0016): all nine kinds reserved in
 * 1.0.0 have graduated (five in 1.1.0, four in 1.2.0). The registry and its
 * machinery ({@link isReservedKind}, the validator's IAP801 emission, the
 * ReservedKind subschema) are retained deliberately: a future minor MAY
 * reserve new kind names, at which point IAP801 fires for them again.
 */
export const RESERVED_KINDS = [] as const satisfies readonly string[];

/**
 * Kinds introduced directly as new fully specified core-vocabulary kinds in a
 * minor — NOT graduations of a previously reserved name. `Cdn` (content
 * delivery / edge distribution) and `EventBus` (event routing) were added in
 * spec 1.3.0 (IEP-0017, ch. 3 §3.27–§3.28) via the ch. 5 §5.7 direct-
 * introduction process. Each is schema-validated against its own
 * `$defs/kinds/<Kind>` definition and is a {@link isSpecifiedKind}.
 *
 * They are deliberately a SEPARATE tier from {@link CORE_KINDS}: downstream
 * tables keyed on `CORE_KINDS` (the provider-sdk abstract-output registry,
 * which the drift test asserts equals `CORE_KINDS` exactly, and the planner's
 * kind reconstruction) cover exactly the 1.0.0 thirteen until provider support
 * for these kinds lands (M24.2 onward) — the M23.1 lesson, preserved. Growing
 * `CORE_KINDS` would break those tables; growing this tier does not.
 */
export const NEW_KINDS = ['Cdn', 'EventBus'] as const;

/**
 * The closed v1 kind vocabulary, pinned to the exact order of the normative
 * `$defs/kindName` enum (the drift test asserts equality). The enum order is
 * frozen since 1.0.0, so core and reserved names interleave here: the five
 * kinds graduated in 1.1.0 keep their original registry positions, and the two
 * kinds introduced in 1.3.0 (`Cdn`, `EventBus`) are appended at the end.
 */
export const KINDS = [
  'Application',
  'Service',
  'Job',
  'Function',
  'Gateway',
  'Database',
  'Cache',
  'ObjectStore',
  'Volume',
  'Queue',
  'Topic',
  'Identity',
  'Secret',
  'Network',
  'Certificate',
  'DnsZone',
  'Stream',
  'Workflow',
  'SearchIndex',
  'Registry',
  'Dashboard',
  'Alert',
  'Cdn',
  'EventBus',
] as const;

/** Closed v1 relationship verb set (spec ch. 4 §4.3). */
export const RELATIONSHIP_TYPES = [
  'dependsOn',
  'connectsTo',
  'routesTo',
  'publishesTo',
  'consumesFrom',
  'replicatesTo',
  'storesDataIn',
  'protectedBy',
  'monitoredBy',
  'authenticatedBy',
] as const;

export const POLICY_OPERATORS = [
  'equals',
  'not-equals',
  'in',
  'not-in',
  'exists',
  'absent',
  'greater-than',
  'less-than',
  'matches',
] as const;

export const COMPLIANCE_FRAMEWORKS = [
  'soc2',
  'pci-dss-4.0',
  'hipaa',
  'iso27001-2022',
  'nist-800-53-r5',
  'cis-8.0',
] as const;

export type CoreKind = (typeof CORE_KINDS)[number];
export type GraduatedKind = (typeof GRADUATED_KINDS)[number];
export type NewKind = (typeof NEW_KINDS)[number];
export type ReservedKind = (typeof RESERVED_KINDS)[number];
export type Kind = (typeof KINDS)[number];
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];
export type PolicyOperator = (typeof POLICY_OPERATORS)[number];
export type ComplianceFramework = (typeof COMPLIANCE_FRAMEWORKS)[number];

export type Labels = Record<string, string>;

/** Namespaced, non-normative provider refinements (spec ch. 11). */
export type Extensions = Record<string, Record<string, unknown>>;

export interface Metadata {
  name: string;
  description?: string;
  owner?: string;
  organization?: string;
  labels?: Labels;
  annotations?: Record<string, string>;
  [xKey: `x-${string}`]: unknown;
}

/** Inline edge declared on the source resource (spec ch. 4 §4.5.1). */
export interface RelationshipEdge {
  type: RelationshipType;
  target: string;
  description?: string;
  port?: number;
  protocol?: 'tcp' | 'udp' | 'http' | 'https' | 'grpc' | 'amqp' | 'mqtt';
  access?: 'read' | 'write' | 'read-write' | 'admin';
  path?: string;
  host?: string;
  [xKey: `x-${string}`]: unknown;
}

export interface Selector {
  kinds?: Kind[];
  labels: Labels;
  [xKey: `x-${string}`]: unknown;
}

/** Selector-based rule edge (spec ch. 4 §4.5.2) — top-level `relationships` only. */
export interface RuleEdge {
  type: RelationshipType;
  source: { selector: Selector };
  target: string;
  description?: string;
  port?: number;
  protocol?: 'tcp' | 'udp' | 'http' | 'https' | 'grpc' | 'amqp' | 'mqtt';
  access?: 'read' | 'write' | 'read-write' | 'admin';
  [xKey: `x-${string}`]: unknown;
}

export type PolicyCondition =
  | { field: string; operator: PolicyOperator; value?: unknown }
  | { allOf: PolicyCondition[] }
  | { anyOf: PolicyCondition[] }
  | { not: PolicyCondition };

export interface Policy {
  id: string;
  description?: string;
  target: { kinds?: Kind[]; selector?: Selector };
  rule: PolicyCondition;
  effect: 'deny' | 'warn' | 'require';
  params?: Record<string, string | number | boolean>;
  [xKey: `x-${string}`]: unknown;
}

export interface Profile {
  description?: string;
  extends?: string;
  /** RFC 7386 JSON Merge Patch applied to the document (spec ch. 6). */
  overrides?: Record<string, unknown>;
  [xKey: `x-${string}`]: unknown;
}

export interface Output {
  resource: string;
  attribute: string;
  description?: string;
  [xKey: `x-${string}`]: unknown;
}

/**
 * One entry of the flat `resources:` map. `spec` is kind-specific and typed
 * as unknown here; schema validation is the structural authority.
 */
export interface ResourceEntry {
  kind: Kind;
  description?: string;
  labels?: Labels;
  spec?: Record<string, unknown>;
  relationships?: RelationshipEdge[];
  extensions?: Extensions;
  [xKey: `x-${string}`]: unknown;
}

/** A parsed IaP v1 document (spec ch. 2). */
export interface IaPDocument {
  apiVersion: typeof API_VERSION;
  metadata: Metadata;
  profiles?: Record<string, Profile>;
  resources: Record<string, ResourceEntry>;
  relationships?: RuleEdge[];
  policies?: Policy[];
  compliance?: { frameworks?: ComplianceFramework[] };
  extensions?: Extensions;
  outputs?: Record<string, Output>;
  [xKey: `x-${string}`]: unknown;
}

/** Validation finding (spec ch. 8 §8.10). */
export interface Finding {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
  policyId?: string;
}

export function isCoreKind(kind: string): kind is CoreKind {
  return (CORE_KINDS as readonly string[]).includes(kind);
}

/** True for the kinds graduated to fully specified in spec 1.1.0/1.2.0 (IEP-0015/0016). */
export function isGraduatedKind(kind: string): kind is GraduatedKind {
  return (GRADUATED_KINDS as readonly string[]).includes(kind);
}

/** True for the kinds introduced directly as new specified kinds in spec 1.3.0 (IEP-0017). */
export function isNewKind(kind: string): kind is NewKind {
  return (NEW_KINDS as readonly string[]).includes(kind);
}

/**
 * True for every fully specified kind — core (1.0.0), graduated (1.1.0/1.2.0),
 * and directly introduced (1.3.0). These kinds have their own
 * `$defs/kinds/<Kind>` schema definition; only {@link RESERVED_KINDS} fall back
 * to the loose ReservedKind subschema.
 */
export function isSpecifiedKind(kind: string): kind is CoreKind | GraduatedKind | NewKind {
  return isCoreKind(kind) || isGraduatedKind(kind) || isNewKind(kind);
}

export function isReservedKind(kind: string): kind is ReservedKind {
  return (RESERVED_KINDS as readonly string[]).includes(kind);
}

export function isValidResourceId(id: string): boolean {
  return RESOURCE_ID_PATTERN.test(id);
}

/* ------------------------------------------------------------------ */
/* Normative schema access                                             */
/* ------------------------------------------------------------------ */

import { readFileSync } from 'node:fs';

export type JsonSchema = Record<string, unknown>;

function loadSchema(name: string): JsonSchema {
  const url = new URL(`../schemas/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as JsonSchema;
}

/** The normative IaP v1 document schema (embedded copy; drift-tested against spec/schema). */
export function iisDocumentSchema(): JsonSchema {
  return loadSchema('iap-v1.schema.json');
}

/** The normative provider-mapping schema. */
export function iisMappingSchema(): JsonSchema {
  return loadSchema('iap-mapping-v1.schema.json');
}

/**
 * The `x-iap-*` annotation vocabulary used by the normative schemas.
 * Validators MUST register these as non-validating annotation keywords
 * (spec ch. 24, CV-6) instead of disabling strict mode globally.
 */
export const X_IIS_ANNOTATION_KEYWORDS = [
  'x-iap-since',
  'x-iap-deprecated',
  'x-iap-capability',
  'x-iap-reserved',
  'x-iap-presence-semantic',
  'x-iap-default-when',
] as const;

/* ------------------------------------------------------------------ */
/* Canonical Infrastructure Model + canonicalization (Phase 2)         */
/* ------------------------------------------------------------------ */

export * from './cim.js';
export * from './quantity.js';
export * from './canonicalize.js';
