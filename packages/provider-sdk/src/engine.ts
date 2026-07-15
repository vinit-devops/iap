/**
 * Pure mapping engine (spec ch. 12; phase-6 design decisions 3–5).
 *
 * `applyMapping(canonicalModel, mapping, { profile, inputs })` is a pure
 * function: it touches nothing but its arguments — no clock, no network, no
 * environment, no filesystem — and never mutates the input model (which is
 * deep-frozen on entry; CM-6 non-interference). For identical inputs it
 * produces byte-identical canonical plans, verified by `planHash`.
 *
 * Fail-closed (ch. 12 §12.3): any kind, field, value, or relationship verb
 * outside the mapping's supports matrix produces a structured diagnostic
 * naming exactly what is unsupported; a field is never silently dropped.
 * Diagnostics use their own closed reason taxonomy, not IaP codes — the
 * ch. 8 registry covers document-validation stages, while ch. 12 requires
 * loud rejection but assigns no codes (design decision 3).
 */

import type { CanonicalModel, CanonicalResource } from '@iap/model';
import { canonicalJsonStringify, compareCodePoints, isCoreKind, sha256Hex } from '@iap/model';
import { IAP_SPEC_VERSION } from './manifest.js';
import { satisfiesRange } from './semver.js';
import type { KindMapping, MappingArtifact, RealizeRule, Scalar } from './mapping.js';
import {
  abstractOutputsForKind,
  collectSpecLeafPaths,
  getValueAtPath,
  isPathCovered,
  resolveKindField,
  splitTargetAttribute,
} from './mapping.js';

/** Closed mapping-time diagnostic reason set (phase-6 design decision 3). */
export const MAPPING_DIAGNOSTIC_REASONS = [
  'unsupported-kind',
  'unsupported-field',
  'unsupported-value',
  'unsupported-relationship',
  'no-realize-rule',
  'derive-map-gap',
  'unbound-output',
  'spec-compat',
  'newer-minor-construct',
] as const;

export type MappingDiagnosticReason = (typeof MAPPING_DIAGNOSTIC_REASONS)[number];

export interface MappingDiagnostic {
  reason: MappingDiagnosticReason;
  message: string;
  kind?: string;
  resourceId?: string;
  field?: string;
  value?: Scalar;
  verb?: string;
}

/** Explicit mapping inputs: named scalar parameters, part of the hashed identity. */
export type MappingInputs = Readonly<Record<string, Scalar>>;

/** Why a plan attribute has its value (design decision 4 — every parameter traceable). */
export interface AttributeProvenance {
  /** Derive form used: constant, verbatim from, or from+map lookup. */
  form: 'constant' | 'from' | 'map';
  /** Canonical source field path (absent for constants). */
  source?: string;
  /** Index of the realize rule (document order) that produced the attribute. */
  ruleIndex: number;
}

export interface PlanResourceLifecycle {
  createOnly: string[];
  updateInPlace: string[];
  replaceOn: string[];
}

export interface PlanResource {
  /** Provider resource type (e.g. aws:rds:DBInstance). */
  type: string;
  /** Deterministic identity: `<resourceId>.<targetType>`. */
  logicalId: string;
  desiredAttributes: Record<string, Scalar>;
  /** Logical ids this resource depends on, derived from canonical edges, sorted. */
  dependsOn: string[];
  /**
   * Attribute lifecycle classification. mapping.iap.dev/v1 carries no
   * lifecycle metadata, so v1 plans emit the neutral empty classification;
   * the shape is fixed now so a future mapping-schema minor can fill it
   * without changing the plan format.
   */
  lifecycle: PlanResourceLifecycle;
  /** Attribute names carrying sensitive values (none derivable from mapping v1). */
  sensitiveFields: string[];
  /** Per-attribute provenance: exactly one record per desiredAttributes entry. */
  provenance: Record<string, AttributeProvenance>;
}

export interface OutputBinding {
  /** Plan resource the abstract attribute is bound to. */
  logicalId: string;
  /** Provider attribute path on that resource. */
  attribute: string;
}

/** The provider plan (phase-6 design decision 4). */
export interface ProviderPlan {
  formatVersion: 1;
  provider: string;
  mappingVersion: string;
  specVersion: string;
  profile: string | null;
  /** SHA-256 hex of the canonical document (CIM hash). */
  documentHash: string;
  /** Explicit mapping inputs — part of the hashed identity. */
  inputs: Record<string, Scalar>;
  resources: PlanResource[];
  /** resourceId → abstract output attribute → binding. */
  outputBindings: Record<string, Record<string, OutputBinding>>;
  /** SHA-256 hex over the canonical serialization of the plan with planHash excluded. */
  planHash: string;
}

export interface ApplyMappingOptions {
  /**
   * The active profile the canonical model must be relative to. Supplying a
   * profile that differs from `model.profile` is a caller error (the model,
   * not the engine, owns profile merging) and throws TypeError.
   */
  profile?: string | null;
  inputs?: MappingInputs;
  /** Specification version in force; defaults to IAP_SPEC_VERSION. */
  specVersion?: string;
}

export type ApplyMappingResult =
  { ok: true; plan: ProviderPlan } | { ok: false; diagnostics: MappingDiagnostic[] };

/* ------------------------------------------------------------------ */

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function sortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  const record: Record<string, T> = {};
  for (const [key, value] of entries.sort((a, b) => compareCodePoints(a[0], b[0]))) {
    record[key] = value;
  }
  return record;
}

function compareDiagnostics(a: MappingDiagnostic, b: MappingDiagnostic): number {
  return (
    compareCodePoints(a.resourceId ?? '', b.resourceId ?? '') ||
    compareCodePoints(a.reason, b.reason) ||
    compareCodePoints(a.field ?? '', b.field ?? '') ||
    compareCodePoints(a.verb ?? '', b.verb ?? '') ||
    compareCodePoints(String(a.value ?? ''), String(b.value ?? ''))
  );
}

/** First-match-wins rule selection (ch. 12 §12.4): structural equality on canonical field paths. */
function matchRule(resource: CanonicalResource, rules: RealizeRule[]): number {
  for (let i = 0; i < rules.length; i += 1) {
    const when = rules[i]?.when ?? {};
    const matches = Object.entries(when).every(
      ([field, value]) => getValueAtPath(resource, field) === value,
    );
    if (matches) return i;
  }
  return -1;
}

function checkCoverage(
  resourceId: string,
  resource: CanonicalResource,
  km: KindMapping,
  diagnostics: MappingDiagnostic[],
): void {
  const kind = resource.kind;
  const supports = km.supports;

  // Field coverage over the index-free leaf paths of the canonical spec.
  for (const path of collectSpecLeafPaths(resource.spec)) {
    if (isCoreKind(kind) && !resolveKindField(kind, path).known) {
      // A field this engine's specification version does not declare can only
      // come from a newer minor; plans must be complete or absent (ch. 10,
      // ch. 12 §12.3 — reject rather than warn IAP804).
      diagnostics.push({
        reason: 'newer-minor-construct',
        kind,
        resourceId,
        field: path,
        message: `resource "${resourceId}" (${kind}) declares "${path}", which specification ${IAP_SPEC_VERSION} does not define — construct from a newer minor is rejected at mapping time`,
      });
      continue;
    }
    if (!isPathCovered(path, supports.fields)) {
      diagnostics.push({
        reason: 'unsupported-field',
        kind,
        resourceId,
        field: path,
        message: `resource "${resourceId}" (${kind}) declares "${path}", which is outside the mapping's supports matrix`,
      });
    }
  }

  // Value coverage for constrained fields.
  for (const [field, allowed] of Object.entries(supports.values ?? {})) {
    const value = getValueAtPath(resource, field);
    if (value !== undefined && isScalar(value) && !allowed.some((entry) => entry === value)) {
      diagnostics.push({
        reason: 'unsupported-value',
        kind,
        resourceId,
        field,
        value,
        message: `resource "${resourceId}" (${kind}) sets ${field} = ${JSON.stringify(value)}; the mapping supports only ${JSON.stringify(allowed)}`,
      });
    }
  }
}

/**
 * Apply a mapping artifact to a canonical model, producing a provider plan
 * or a complete set of fail-closed diagnostics — never a partial plan.
 */
export function applyMapping(
  model: CanonicalModel,
  mapping: MappingArtifact,
  options: ApplyMappingOptions = {},
): ApplyMappingResult {
  if (options.profile !== undefined && options.profile !== model.profile) {
    throw new TypeError(
      `options.profile (${JSON.stringify(options.profile)}) does not match the model's active profile (${JSON.stringify(model.profile)}); canonicalize against the intended profile first`,
    );
  }
  const inputs = options.inputs ?? {};
  for (const [key, value] of Object.entries(inputs)) {
    if (!isScalar(value)) {
      throw new TypeError(`mapping input "${key}" must be a scalar (string|number|boolean)`);
    }
  }

  deepFreeze(model);

  const specVersion = options.specVersion ?? IAP_SPEC_VERSION;
  const diagnostics: MappingDiagnostic[] = [];

  // Version fail-closed: refuse rather than plan against an excluded spec.
  if (!satisfiesRange(specVersion, mapping.specCompat)) {
    diagnostics.push({
      reason: 'spec-compat',
      message: `mapping ${mapping.provider}@${mapping.version} declares specCompat "${mapping.specCompat}", which excludes specification ${specVersion} (ch. 10)`,
    });
    return { ok: false, diagnostics };
  }

  const resourceIds = Object.keys(model.resources).sort(compareCodePoints);
  const matchedRules = new Map<string, number>();

  for (const resourceId of resourceIds) {
    const resource = model.resources[resourceId] as CanonicalResource;
    const km = mapping.mappings[resource.kind];
    if (!km) {
      diagnostics.push({
        reason: 'unsupported-kind',
        kind: resource.kind,
        resourceId,
        message: `resource "${resourceId}" has kind ${resource.kind}, which the mapping does not support`,
      });
      continue;
    }

    const diagnosticsBefore = diagnostics.length;
    checkCoverage(resourceId, resource, km, diagnostics);

    // Relationship coverage: verbs realizable for edges whose source is this kind.
    const supportedVerbs = new Set<string>(km.supports.relationships ?? []);
    for (const edge of model.edges) {
      if (edge.source !== resourceId) continue;
      if (!supportedVerbs.has(edge.type)) {
        diagnostics.push({
          reason: 'unsupported-relationship',
          kind: resource.kind,
          resourceId,
          verb: edge.type,
          message: `edge ${resourceId} --${edge.type}--> ${edge.target} uses a verb the mapping cannot realize for ${resource.kind}`,
        });
      }
    }

    // A resource already outside the matrix does not proceed to realization:
    // reporting derive/rule consequences of an unsupported input would be
    // cascade noise on top of the precise coverage diagnostic.
    if (diagnostics.length > diagnosticsBefore) continue;

    const ruleIndex = matchRule(resource, km.realize);
    if (ruleIndex === -1) {
      diagnostics.push({
        reason: 'no-realize-rule',
        kind: resource.kind,
        resourceId,
        message: `no realize rule matches resource "${resourceId}" (${resource.kind}) although it is within the supports matrix — supports and realize must tile exactly (ch. 12 §12.4)`,
      });
      continue;
    }
    matchedRules.set(resourceId, ruleIndex);
  }

  // Second pass: derive attributes and bind outputs (only meaningful for
  // resources with a matched rule; diagnostics still accumulate globally so
  // the caller sees every defect at once).
  const planResources: PlanResource[] = [];
  const outputBindings: Record<string, Record<string, OutputBinding>> = {};

  for (const resourceId of resourceIds) {
    const ruleIndex = matchedRules.get(resourceId);
    if (ruleIndex === undefined) continue;
    const resource = model.resources[resourceId] as CanonicalResource;
    const km = mapping.mappings[resource.kind] as KindMapping;
    const rule = km.realize[ruleIndex] as RealizeRule;

    const attributesByTarget = new Map<string, Array<[string, Scalar]>>();
    const provenanceByTarget = new Map<string, Array<[string, AttributeProvenance]>>();
    for (const target of rule.targets) {
      attributesByTarget.set(target, []);
      provenanceByTarget.set(target, []);
    }

    for (const [key, spec] of Object.entries(rule.derive ?? {})) {
      const split = splitTargetAttribute(key, rule.targets);
      if (!split) continue; // load-time verification rejects unresolvable keys
      let value: Scalar | undefined;
      let provenance: AttributeProvenance;
      if (spec.constant !== undefined) {
        value = spec.constant;
        provenance = { form: 'constant', ruleIndex };
      } else {
        const from = spec.from as string;
        const source = getValueAtPath(resource, from);
        if (source === undefined) continue; // absent optional intent → absent attribute
        if (spec.map !== undefined) {
          if (!Object.prototype.hasOwnProperty.call(spec.map, String(source))) {
            diagnostics.push({
              reason: 'derive-map-gap',
              kind: resource.kind,
              resourceId,
              field: from,
              ...(isScalar(source) ? { value: source } : {}),
              message: `derive map for "${key}" has no entry for ${from} = ${JSON.stringify(source)} (CM-3 requires total maps)`,
            });
            continue;
          }
          value = spec.map[String(source)] as Scalar;
          provenance = { form: 'map', source: from, ruleIndex };
        } else {
          if (!isScalar(source)) continue; // verbatim carry-over is scalar-only
          value = source;
          provenance = { form: 'from', source: from, ruleIndex };
        }
      }
      attributesByTarget.get(split.target)?.push([split.attribute, value]);
      provenanceByTarget.get(split.target)?.push([split.attribute, provenance]);
    }

    // Output binding for every abstract attribute the core declares.
    const bindings: Record<string, OutputBinding> = {};
    for (const attribute of abstractOutputsForKind(resource.kind)) {
      const binding = km.outputs?.[attribute];
      const target = binding
        ? rule.targets.find((candidate) => binding.from.startsWith(`${candidate}.`))
        : undefined;
      if (!binding || target === undefined) {
        diagnostics.push({
          reason: 'unbound-output',
          kind: resource.kind,
          resourceId,
          field: attribute,
          message: binding
            ? `outputs.${attribute} binds to "${binding.from}", but the matched realize rule does not produce that target for "${resourceId}"`
            : `abstract output attribute "${attribute}" of ${resource.kind} is not bound by the mapping (ch. 12 §12.5)`,
        });
        continue;
      }
      bindings[attribute] = {
        logicalId: `${resourceId}.${target}`,
        attribute: binding.from.slice(target.length + 1),
      };
    }
    outputBindings[resourceId] = sortedRecord(Object.entries(bindings));

    // dependsOn: every plan resource realized from an edge-target resource,
    // for every canonical edge whose source is this resource.
    const dependsOn = new Set<string>();
    for (const edge of model.edges) {
      if (edge.source !== resourceId) continue;
      const targetRuleIndex = matchedRules.get(edge.target);
      if (targetRuleIndex === undefined) continue;
      const targetResource = model.resources[edge.target] as CanonicalResource;
      const targetRule = mapping.mappings[targetResource.kind]?.realize[targetRuleIndex];
      for (const targetType of targetRule?.targets ?? []) {
        dependsOn.add(`${edge.target}.${targetType}`);
      }
    }
    const dependsOnSorted = [...dependsOn].sort(compareCodePoints);

    for (const target of rule.targets) {
      planResources.push({
        type: target,
        logicalId: `${resourceId}.${target}`,
        desiredAttributes: sortedRecord(attributesByTarget.get(target) ?? []),
        dependsOn: dependsOnSorted,
        lifecycle: { createOnly: [], replaceOn: [], updateInPlace: [] },
        sensitiveFields: [],
        provenance: sortedRecord(provenanceByTarget.get(target) ?? []),
      });
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const unhashed: Omit<ProviderPlan, 'planHash'> = {
    formatVersion: 1,
    provider: mapping.provider,
    mappingVersion: mapping.version,
    specVersion,
    profile: model.profile,
    documentHash: model.hash,
    inputs: sortedRecord(Object.entries(inputs)),
    resources: planResources,
    outputBindings: sortedRecord(Object.entries(outputBindings)),
  };
  const planHash = sha256Hex(canonicalJsonStringify(unhashed));
  return { ok: true, plan: { ...unhashed, planHash } };
}
