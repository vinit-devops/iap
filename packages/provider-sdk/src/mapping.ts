/**
 * Mapping artifact types and shared helpers (spec ch. 12).
 *
 * The normative contract is `spec/schema/iap-mapping-v1.schema.json`, embedded
 * and exported by `@iap/model`; the types here mirror it for strongly typed
 * consumption. This module also carries the machine-readable table of
 * per-kind abstract output attributes (spec ch. 3 §3.3) that output-binding
 * verification requires, and the field-path/domain helpers shared by the
 * static coverage verifier and the mapping engine.
 */

import type { ValidateFunction } from 'ajv';
import type { CanonicalResource, CoreKind, RelationshipType } from '@iap/model';
import { iisDocumentSchema, iisMappingSchema, isCoreKind } from '@iap/model';
import { createValidator } from '@iap/parser';

/** Scalar values as they appear in mapping artifacts and plans. */
export type Scalar = string | number | boolean;

export const MAPPING_API_VERSION = 'mapping.iap.dev/v1' as const;

export interface SupportsMatrix {
  /** Every supported field path on the kind (dot path into the resource entry). */
  fields: string[];
  /** Per-field allowed values where the mapping supports only a subset of the enum. */
  values?: Record<string, Scalar[]>;
  /** Relationship verbs realizable for edges whose source is this kind (omitted = none). */
  relationships?: RelationshipType[];
  [xKey: `x-${string}`]: unknown;
}

/**
 * One derive entry: exactly one of `constant`, `from` alone, or `from`+`map`
 * (ch. 12 §12.4 rule 4). The schema admits the property combinations; the
 * loader's static verification enforces the exactly-one-form rule.
 */
export interface DeriveSpec {
  from?: string;
  map?: Record<string, Scalar>;
  constant?: Scalar;
}

export interface RealizeRule {
  /** Field path → exact value; all must hold. Omitted = always matches. */
  when?: Record<string, Scalar>;
  /** Provider resource types produced (e.g. aws:rds:DBInstance). */
  targets: string[];
  /**
   * Provider attribute derivations. Keys are either `<target>.<attribute>`
   * (explicit target) or a bare attribute name (assigned to the rule's first
   * target).
   */
  derive?: Record<string, DeriveSpec>;
  [xKey: `x-${string}`]: unknown;
}

export interface OutputBindingSpec {
  /** Provider plan attribute path: `<target>.<attribute>`. */
  from: string;
}

export interface KindMapping {
  supports: SupportsMatrix;
  realize: RealizeRule[];
  outputs?: Record<string, OutputBindingSpec>;
  [xKey: `x-${string}`]: unknown;
}

/** A provider mapping artifact (`*.iap-map.yaml`, apiVersion mapping.iap.dev/v1). */
export interface MappingArtifact {
  apiVersion: typeof MAPPING_API_VERSION;
  provider: string;
  version: string;
  specCompat: string;
  description?: string;
  mappings: Record<string, KindMapping>;
  [xKey: `x-${string}`]: unknown;
}

let mappingValidator: ValidateFunction | undefined;

export type MappingValidation =
  { ok: true; artifact: MappingArtifact } | { ok: false; errors: string[] };

/** Validate a parsed mapping artifact against the normative mapping schema. */
export function validateMappingArtifact(value: unknown): MappingValidation {
  mappingValidator ??= createValidator(iisMappingSchema());
  if (mappingValidator(value)) {
    return { ok: true, artifact: value as MappingArtifact };
  }
  const errors = (mappingValidator.errors ?? []).map(
    (error) => `${error.instancePath || '/'} ${error.message ?? 'schema violation'}`,
  );
  return { ok: false, errors };
}

/* ------------------------------------------------------------------ */
/* Abstract output attributes (spec ch. 3 §3.3)                        */
/* ------------------------------------------------------------------ */

/**
 * Per-kind abstract output attributes a realization must provide, from the
 * normative summary table in ch. 3 §3.3 and each kind's **Outputs**
 * subsection (§3.4–§3.16): `identifier` on every provisionable kind,
 * `endpoint` on every addressable kind, `connectionSecret` on every
 * authenticated kind. `@iap/model` does not export this table, so the
 * provider SDK owns the machine-readable copy; output-binding verification
 * (ch. 12 §12.5, CM-4) requires every listed attribute to be bound by any
 * mapping that supports the kind. Reserved kinds declare no abstract outputs
 * in v1.
 */
export const ABSTRACT_OUTPUT_ATTRIBUTES: Readonly<Record<CoreKind, readonly string[]>> = {
  Application: ['identifier'],
  Service: ['identifier', 'endpoint'],
  Job: ['identifier'],
  Function: ['identifier', 'endpoint'],
  Gateway: ['identifier', 'endpoint'],
  Database: ['identifier', 'endpoint', 'connectionSecret'],
  Cache: ['identifier', 'endpoint', 'connectionSecret'],
  ObjectStore: ['identifier', 'endpoint'],
  Volume: ['identifier'],
  Queue: ['identifier', 'endpoint'],
  Topic: ['identifier', 'endpoint'],
  Identity: ['identifier'],
  Secret: ['identifier'],
};

/** Abstract output attributes declared for a kind (empty for reserved kinds). */
export function abstractOutputsForKind(kind: string): readonly string[] {
  return isCoreKind(kind) ? ABSTRACT_OUTPUT_ATTRIBUTES[kind] : [];
}

/* ------------------------------------------------------------------ */
/* Field paths and value domains over the canonical resource entry     */
/* ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve a dot path (e.g. `spec.encryption.atRest`) against a canonical
 * resource entry. Returns undefined when any segment is missing.
 */
export function getValueAtPath(resource: CanonicalResource, path: string): unknown {
  let node: unknown = resource;
  for (const segment of path.split('.')) {
    if (!isPlainObject(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Collect the index-free dot paths of every leaf under a resource's spec:
 * object keys are joined with `.`, array indices are skipped (so every item
 * of `spec.ports` contributes paths like `spec.ports.port`), and empty
 * containers contribute their own path. Keys starting with `x-` are
 * non-semantic annotations (ch. 24 exempts them from core-position rules)
 * and are excluded, at every depth.
 */
export function collectSpecLeafPaths(spec: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      if (value.length === 0) out.add(path);
      for (const item of value) walk(item, path);
      return;
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value).filter((key) => !key.startsWith('x-'));
      if (keys.length === 0) out.add(path);
      for (const key of keys) walk(value[key], `${path}.${key}`);
      return;
    }
    out.add(path);
  };
  for (const key of Object.keys(spec).filter((key) => !key.startsWith('x-'))) {
    walk(spec[key], `spec.${key}`);
  }
  return [...out].sort();
}

/** True when `path` or any of its dot-prefixes appears in `fields`. */
export function isPathCovered(path: string, fields: readonly string[]): boolean {
  const set = new Set(fields);
  const segments = path.split('.');
  for (let i = segments.length; i >= 1; i -= 1) {
    if (set.has(segments.slice(0, i).join('.'))) return true;
  }
  return false;
}

export interface FieldSchemaInfo {
  /** False when the specification schema does not declare the field at all. */
  known: boolean;
  /**
   * The closed value domain of the field: its enum (or [true, false] for
   * booleans), or null when the domain is unbounded (free strings,
   * quantities, integers).
   */
  domain: Scalar[] | null;
  /** True when the field carries a specification default (always present canonically). */
  hasDefault: boolean;
  /** True when the field is required by its immediate parent object. */
  requiredByParent: boolean;
}

let cachedSchemaRoot: JsonObject | undefined;

function schemaRoot(): JsonObject {
  cachedSchemaRoot ??= iisDocumentSchema() as JsonObject;
  return cachedSchemaRoot;
}

function resolvePointer(ref: string): JsonObject | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = schemaRoot();
  for (const raw of ref.slice(2).split('/')) {
    if (!isPlainObject(node)) return undefined;
    node = node[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return isPlainObject(node) ? node : undefined;
}

function deref(schema: JsonObject): JsonObject {
  let node = schema;
  for (let depth = 0; depth < 16 && typeof node.$ref === 'string'; depth += 1) {
    const target = resolvePointer(node.$ref);
    if (!target) break;
    const siblings = { ...node };
    delete siblings.$ref;
    node = { ...target, ...siblings };
  }
  return node;
}

const UNKNOWN_FIELD: FieldSchemaInfo = {
  known: false,
  domain: null,
  hasDefault: false,
  requiredByParent: false,
};

/**
 * Resolve a `spec.*` field path against the normative kind subschema
 * (`$defs/kinds/<Kind>` of the embedded IaP document schema), descending
 * through object properties and array `items` (index-free path semantics).
 * Non-core kinds and non-spec paths resolve as unknown.
 */
export function resolveKindField(kind: string, fieldPath: string): FieldSchemaInfo {
  if (!isCoreKind(kind)) return UNKNOWN_FIELD;
  const segments = fieldPath.split('.');
  if (segments[0] !== 'spec' || segments.length < 2) return UNKNOWN_FIELD;

  let node = deref({ $ref: `#/$defs/kinds/${kind}` });
  let requiredByParent = false;
  for (const segment of segments.slice(1)) {
    while (isPlainObject(node.items) && !isPlainObject(node.properties)) {
      node = deref(node.items);
    }
    const properties = isPlainObject(node.properties) ? node.properties : undefined;
    const child = properties?.[segment];
    if (!isPlainObject(child)) return UNKNOWN_FIELD;
    requiredByParent = Array.isArray(node.required) && node.required.includes(segment);
    node = deref(child);
  }

  let domain: Scalar[] | null = null;
  if (Array.isArray(node.enum)) {
    domain = node.enum as Scalar[];
  } else if (node.type === 'boolean') {
    domain = [true, false];
  } else if (node.const !== undefined && !isPlainObject(node.const)) {
    domain = [node.const as Scalar];
  }
  return { known: true, domain, hasDefault: 'default' in node, requiredByParent };
}

/**
 * The value domain the supports matrix admits for a field: the matrix's own
 * `values` constraint when present, otherwise the specification's full
 * domain (ch. 12 §12.4 rule 4). Null when unbounded.
 */
export function supportedDomain(
  kind: string,
  fieldPath: string,
  supports: SupportsMatrix,
): Scalar[] | null {
  const constrained = supports.values?.[fieldPath];
  if (constrained !== undefined) return constrained;
  return resolveKindField(kind, fieldPath).domain;
}

/**
 * Split a derive key or output-binding path into its target type and
 * attribute name using longest-prefix matching against the declared targets
 * (target types contain `:` and may contain `.`, so a plain split is not
 * enough). A key with no target prefix belongs to `targets[0]` per the
 * bare-name convention.
 */
export function splitTargetAttribute(
  key: string,
  targets: readonly string[],
): { target: string; attribute: string } | null {
  let best: string | null = null;
  for (const target of targets) {
    if (key.startsWith(`${target}.`) && (best === null || target.length > best.length)) {
      best = target;
    }
  }
  if (best !== null) return { target: best, attribute: key.slice(best.length + 1) };
  if (key.includes(':')) return null; // looks target-qualified but matches no declared target
  const first = targets[0];
  return first === undefined ? null : { target: first, attribute: key };
}
