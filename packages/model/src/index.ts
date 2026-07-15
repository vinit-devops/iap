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

/** Fully specified v1 kinds (spec ch. 3). */
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

/** Reserved registry kinds (spec ch. 3 §3.17, ch. 5) — loose validation, IAP801 warning. */
export const RESERVED_KINDS = [
  'Network',
  'Certificate',
  'DnsZone',
  'Stream',
  'Workflow',
  'SearchIndex',
  'Registry',
  'Dashboard',
  'Alert',
] as const;

export const KINDS = [...CORE_KINDS, ...RESERVED_KINDS] as const;

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
