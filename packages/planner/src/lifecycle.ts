/**
 * Lifecycle-action determination: the closed rule order of phase-7 design
 * decision 4 over the semantic diff (ch. 14 §14.2, IEP-0010 import
 * semantics), plus the reversibility classification of ch. 14 §14.6 using
 * the roadmap's rollback classes.
 *
 * Rule order (first match wins, evaluated per logical id):
 *   1. desired, absent from state                     → create
 *   2. desired, present but unmanaged                 → import (never a blind update)
 *   3. desired, managed, a replaceOn field (or the
 *      provider type) differs                         → replace   (destructive)
 *   4. desired, managed, any other attribute differs  → update-in-place
 *   5. desired, managed, no difference                → no-op (excluded from the plan)
 *   6. undesired, present, managed                    → delete    (destructive)
 *   7. undesired, present, unmanaged                  → outside the diff scope entirely
 *      (mirrors the mock executor's M6.2 decision 1: out-of-band objects are
 *      invisible until imported).
 */

import { CORE_KINDS, compareCodePoints } from '@iap/model';
import type { CoreKind } from '@iap/model';
import { abstractOutputsForKind, resolveKindField } from '@iap/provider-sdk';
import type { AttributeProvenance, ProviderPlan } from '@iap/provider-sdk';
import type { StateSnapshot } from './inputs.js';
import { diffResources } from './diff.js';
import type { ResourceDiff } from './diff.js';

/** Closed action vocabulary (ch. 14 §14.2 + import). */
export const PLAN_ACTIONS = ['create', 'update-in-place', 'replace', 'delete', 'import'] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

/** Closed reversibility vocabulary (ch. 14 §14.6; roadmap rollback classes). */
export const REVERSIBILITY_CLASSES = [
  'fully-reversible',
  'reversible-with-data-risk',
  'replacement-based-recovery',
  'manual-recovery-required',
  'irreversible',
] as const;
export type ReversibilityClass = (typeof REVERSIBILITY_CLASSES)[number];

/** Kinds designated stateful by ch. 14 §14.2 (auto-replace prohibition set). */
export const STATEFUL_KINDS = [
  'Database',
  'Volume',
  'ObjectStore',
  'Queue',
  'Topic',
  'Secret',
] as const satisfies readonly CoreKind[];

export type Statefulness = 'stateful' | 'stateless';

/** Determinism-input identity element names (the keys of content.inputs). */
export const IDENTITY_ELEMENTS = [
  'documentHash',
  'target',
  'profileHashes',
  'policyBundles',
  'extensionVersions',
  'mappingVersions',
  'discoverySnapshot',
  'pricingSnapshot',
  'stateRevision',
  'stateIntegrity',
  'plannerVersion',
] as const;
export type IdentityElement = (typeof IDENTITY_ELEMENTS)[number];

/** Provenance carried by one action entry (IEP-0011 artifact sketch). */
export interface ActionProvenance {
  /**
   * The input identity responsible for the change: `documentHash` for
   * create/update-in-place/replace/delete (declared intent changed relative
   * to state), `stateRevision` for import (the state snapshot contains an
   * existing unmanaged object).
   */
  changedBy: IdentityElement;
  /**
   * Touched field path → its mapping-level source, encoded from the provider
   * plan's per-attribute provenance: `constant`, `from:<canonical path>`,
   * `map:<canonical path>`, or `state` for paths present only in the
   * snapshot (removed attributes carry no desired-side provenance).
   */
  fieldSources: Record<string, string>;
}

/** One scheduled lifecycle action (a `waves` entry of the plan artifact). */
export interface PlanActionEntry {
  /** Logical id `<resourceId>.<targetType>` the action applies to. */
  resource: string;
  action: PlanAction;
  /**
   * Attribute paths the action touches, sorted: every desired attribute for
   * create; changed/added/removed attributes for update-in-place and replace
   * (plus the pseudo-field `type` on a provider-type change); drifted
   * attributes for import; empty for delete (the action is total). Names
   * only, never values (PL-5).
   */
  fields: string[];
  provenance: ActionProvenance;
  /** True exactly for replace and delete (PL-3). */
  destructive: boolean;
  reversibility: ReversibilityClass;
}

/** Originating resource id of a logical id (`<resourceId>.<targetType>`). */
export function resourceIdOf(logicalId: string): string {
  const dot = logicalId.indexOf('.');
  return dot === -1 ? logicalId : logicalId.slice(0, dot);
}

const STATEFUL_SET: ReadonlySet<string> = new Set(STATEFUL_KINDS);

/**
 * Derive per-resource-id statefulness from the provider plan.
 *
 * A mapping.iap.dev/v1 plan carries no kind field (M6.1 decision 4), so the
 * originating kind is reconstructed from the two kind-correlated channels
 * the plan does carry:
 *
 *  - **provenance** — every non-constant attribute records its canonical
 *    `spec.*` source path, and spec field paths are declared per kind by the
 *    normative schema (`resolveKindField`);
 *  - **output bindings** — the engine binds every abstract output attribute
 *    the kind declares (CM-4), so the bound attribute set for a resource id
 *    equals `abstractOutputsForKind` of its true kind exactly.
 *
 * A core kind is a *candidate* for a resource id when it declares every
 * provenance source path recorded across the id's plan resources and its
 * declared abstract output set equals the id's bound output set. The rule:
 * all candidates stateful → `stateful`; candidates non-empty and none
 * stateful → `stateless`; mixed or empty (including reserved kinds and
 * state-only objects, which have no desired entry at all) → `stateful`,
 * failing toward the destructive extreme (the fail-closed posture of
 * ch. 12 applied to destructiveness). IEP-0011's provider impact assigns
 * real per-action reversibility metadata to mappings; this derivation is
 * the deterministic stand-in until a mapping-schema minor carries it.
 */
export function deriveStatefulness(desired: ProviderPlan): Record<string, Statefulness> {
  const sourcesById = new Map<string, Set<string>>();
  for (const resource of desired.resources) {
    const id = resourceIdOf(resource.logicalId);
    const sources = sourcesById.get(id) ?? new Set<string>();
    for (const record of Object.values(resource.provenance) as AttributeProvenance[]) {
      if (record.source !== undefined) sources.add(record.source);
    }
    sourcesById.set(id, sources);
  }

  const result: Record<string, Statefulness> = {};
  for (const id of [...sourcesById.keys()].sort(compareCodePoints)) {
    const sources = sourcesById.get(id) as Set<string>;
    const boundOutputs = Object.keys(desired.outputBindings[id] ?? {}).sort(compareCodePoints);
    const candidates = CORE_KINDS.filter((kind) => {
      const declared = [...abstractOutputsForKind(kind)].sort(compareCodePoints);
      if (declared.length !== boundOutputs.length) return false;
      if (declared.some((attribute, i) => attribute !== boundOutputs[i])) return false;
      return [...sources].every((path) => resolveKindField(kind, path).known);
    });
    if (candidates.length === 0) {
      result[id] = 'stateful'; // undecidable → destructive extreme
    } else if (candidates.every((kind) => STATEFUL_SET.has(kind))) {
      result[id] = 'stateful';
    } else if (candidates.every((kind) => !STATEFUL_SET.has(kind))) {
      result[id] = 'stateless';
    } else {
      result[id] = 'stateful'; // mixed candidates → destructive extreme
    }
  }
  return result;
}

/**
 * Reversibility classification (ch. 14 §14.6, roadmap rollback classes):
 *
 * | action          | stateless                   | stateful                    |
 * |-----------------|-----------------------------|-----------------------------|
 * | create          | fully-reversible            | fully-reversible            |
 * | update-in-place | fully-reversible            | fully-reversible            |
 * | import          | fully-reversible            | fully-reversible            |
 * | replace         | replacement-based-recovery  | reversible-with-data-risk   |
 * | delete          | replacement-based-recovery  | irreversible                |
 *
 * Rationale: creates/updates/imports are undone by re-planning to the prior
 * revision with no data at stake (§14.6 — rollback is a plan like any
 * other). A replace destroys the predecessor (§14.2: create successor,
 * rebind, delete predecessor) — recoverable by a further replacement when
 * stateless, data-bearing when stateful (§14.6 requires restore steps).
 * A stateless delete is recovered by re-creating a successor; a stateful
 * delete destroys data and, absent a restore source the plan cannot see,
 * is the destructive extreme — `irreversible` (§14.6: silent destruction of
 * data is never permitted; M7.3 surfaces this in rollback.limitations).
 */
export function classifyReversibility(
  action: PlanAction,
  statefulness: Statefulness,
): ReversibilityClass {
  switch (action) {
    case 'create':
    case 'update-in-place':
    case 'import':
      return 'fully-reversible';
    case 'replace':
      return statefulness === 'stateful'
        ? 'reversible-with-data-risk'
        : 'replacement-based-recovery';
    case 'delete':
      return statefulness === 'stateful' ? 'irreversible' : 'replacement-based-recovery';
  }
}

function encodeFieldSource(record: AttributeProvenance | undefined): string {
  if (record === undefined) return 'state';
  if (record.form === 'constant') return 'constant';
  return `${record.form}:${record.source ?? ''}`;
}

function fieldSourcesFor(entry: ResourceDiff, fields: string[]): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const field of fields) {
    if (field === 'type' && entry.typeChanged) {
      sources[field] = 'state';
      continue;
    }
    sources[field] = encodeFieldSource(entry.desired?.provenance[field]);
  }
  return sources;
}

function changedFieldSet(entry: ResourceDiff): string[] {
  const fields = [
    ...entry.attributes.added,
    ...entry.attributes.changed,
    ...entry.attributes.removed,
  ];
  if (entry.typeChanged) fields.push('type');
  return fields.sort(compareCodePoints);
}

/**
 * Apply the closed rule order to every diffed logical id, producing the
 * unscheduled action set sorted by logical id. No-op resources (ch. 14
 * §14.2) and undesired unmanaged objects produce no entry.
 */
export function determineActions(desired: ProviderPlan, state: StateSnapshot): PlanActionEntry[] {
  const statefulness = deriveStatefulness(desired);
  const entries: PlanActionEntry[] = [];

  for (const entry of diffResources(desired, state)) {
    const stateful = statefulness[resourceIdOf(entry.logicalId)] ?? 'stateful';

    let action: PlanAction;
    let fields: string[];
    let changedBy: IdentityElement;

    if (entry.desired !== null && entry.actual === null) {
      // Rule 1 — absent from state: provision.
      action = 'create';
      fields = Object.keys(entry.desired.desiredAttributes).sort(compareCodePoints);
      changedBy = 'documentHash';
    } else if (entry.desired !== null && entry.actual !== null && !entry.actual.managed) {
      // Rule 2 — present but unmanaged: import before management, never a
      // blind update (M6.2 decision 9). Fields list the drifted attributes.
      action = 'import';
      fields = changedFieldSet(entry);
      changedBy = 'stateRevision';
    } else if (entry.desired !== null && entry.actual !== null) {
      const changed = changedFieldSet(entry);
      if (changed.length === 0) continue; // Rule 5 — no-op, excluded (§14.2).
      const replaceOn = new Set(entry.desired.lifecycle.replaceOn);
      const replaceTriggered = entry.typeChanged || changed.some((field) => replaceOn.has(field));
      // Rule 3/4 — replaceOn (or provider-type) difference replaces; any
      // other difference updates in place.
      action = replaceTriggered ? 'replace' : 'update-in-place';
      fields = changed;
      changedBy = 'documentHash';
    } else if (entry.actual !== null && entry.actual.managed) {
      // Rule 6 — in state, not desired: deprovision. The action is total;
      // no field-level detail (and no attribute names from state leak
      // beyond what the diff needs).
      action = 'delete';
      fields = [];
      changedBy = 'documentHash';
    } else {
      continue; // Rule 7 — undesired unmanaged objects are invisible.
    }

    const destructive = action === 'replace' || action === 'delete';
    entries.push({
      resource: entry.logicalId,
      action,
      fields,
      provenance: { changedBy, fieldSources: fieldSourcesFor(entry, fields) },
      destructive,
      reversibility: classifyReversibility(action, stateful),
    });
  }

  return entries; // diffResources already iterates in sorted logical-id order
}
