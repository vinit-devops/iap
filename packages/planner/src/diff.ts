/**
 * Semantic diff of the desired provider-resource model (`ProviderPlan`, the
 * output of `@iap/provider-sdk`'s `applyMapping`) against the actual state
 * snapshot, per attribute (ch. 14 §14.1 stage 3, §14.2).
 *
 * Comparison is exact equality on canonical values: both sides are already
 * canonical (the mapping engine derives attributes from the canonical
 * document; the snapshot records attributes as last applied), so equality of
 * their canonical serializations is the deterministic "semantically equal"
 * test — no tolerance bands, no floating-point arithmetic.
 */

import { canonicalJsonStringify, compareCodePoints } from '@iap/model';
import type { PlanResource, ProviderPlan, Scalar } from '@iap/provider-sdk';
import type { StateObject, StateSnapshot } from './inputs.js';

/** Attribute-level diff between one desired resource and one state object. */
export interface AttributeDiff {
  /** Attribute paths present desired-side only, sorted. */
  added: string[];
  /** Attribute paths present actual-side only, sorted. */
  removed: string[];
  /** Attribute paths present on both sides with unequal canonical values, sorted. */
  changed: string[];
}

/** True when the diff records no difference at all. */
export function isEmptyDiff(diff: AttributeDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/** Exact canonical-value equality (deterministic; -0 and 0 canonicalize alike). */
function canonicallyEqual(a: Scalar, b: Scalar): boolean {
  return canonicalJsonStringify(a) === canonicalJsonStringify(b);
}

/** Diff two flat attribute maps per attribute path. */
export function diffAttributes(
  desired: Record<string, Scalar>,
  actual: Record<string, Scalar>,
): AttributeDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(desired)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      added.push(key);
    } else if (!canonicallyEqual(desired[key] as Scalar, actual[key] as Scalar)) {
      changed.push(key);
    }
  }
  for (const key of Object.keys(actual)) {
    if (!Object.prototype.hasOwnProperty.call(desired, key)) removed.push(key);
  }
  return {
    added: added.sort(compareCodePoints),
    removed: removed.sort(compareCodePoints),
    changed: changed.sort(compareCodePoints),
  };
}

/** One logical id's desired/actual pairing with its attribute diff. */
export interface ResourceDiff {
  /** Deterministic identity `<resourceId>.<targetType>`. */
  logicalId: string;
  /** Desired plan resource; null when the id exists only in state. */
  desired: PlanResource | null;
  /** State object; null when the id exists only in the desired plan. */
  actual: StateObject | null;
  /** Attribute-level differences (empty maps diffed when a side is null). */
  attributes: AttributeDiff;
  /**
   * True when both sides exist with different provider resource types. The
   * logical id embeds the target type, so this cannot arise from a correct
   * pipeline; it is treated as an implicit replace trigger (fail closed).
   */
  typeChanged: boolean;
}

/**
 * Diff every desired resource against the snapshot by logical id, in
 * lexicographic logical-id order (C5 ordering discipline). Ids on either
 * side appear exactly once; ids on neither side do not exist.
 */
export function diffResources(desired: ProviderPlan, state: StateSnapshot): ResourceDiff[] {
  const byId = new Map<string, PlanResource>();
  for (const resource of desired.resources) byId.set(resource.logicalId, resource);

  const ids = [...new Set([...byId.keys(), ...Object.keys(state.objects)])].sort(compareCodePoints);

  return ids.map((logicalId) => {
    const desiredResource = byId.get(logicalId) ?? null;
    const actualObject = state.objects[logicalId] ?? null;
    return {
      logicalId,
      desired: desiredResource,
      actual: actualObject,
      attributes: diffAttributes(
        desiredResource?.desiredAttributes ?? {},
        actualObject?.attributes ?? {},
      ),
      typeChanged:
        desiredResource !== null &&
        actualObject !== null &&
        desiredResource.type !== actualObject.type,
    };
  });
}
