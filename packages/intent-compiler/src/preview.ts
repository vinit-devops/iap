/**
 * Preview semantic diff (`iap-semantic-diff/v1`) and destructive
 * classification (phase-3 design decision 8).
 *
 * The diff compares the CANONICAL projections of the base and resulting
 * documents (both canonicalized through `@iap/model`), so authoring noise —
 * key order, quantity spellings — never reports as a change; only effective
 * semantics do. Paths are dot paths from the document root; a subtree
 * present on only one side reports its root path only (IEP-0009 envelope
 * example: `adds: ["resources.orders-db"]`).
 *
 * Destructive classification is the authoring-side mirror of the planner's
 * gates, computed without invoking the planner: `RemoveResource` on a
 * stateful kind (ch. 14 §14.2), or an update touching a replacement-eligible
 * field per the kind's ch. 3 lifecycle rules. Documents declare no
 * `lifecycle.replaceOn` themselves — that channel is mapping/plan-side — so
 * the closed per-kind table below is the deterministic stand-in derived from
 * the normative ch. 3 "Lifecycle" clauses, the same reconstruction posture
 * as the planner's statefulness derivation (M7.1 decision 3). Undecidable
 * comparisons fail toward the destructive extreme.
 */

import { parseQuantity } from '@iap/model';
import type { Kind } from '@iap/model';
import type { StatefulKind } from './operations.js';
import { STATEFUL_KINDS } from './operations.js';

/** Machine-readable destructive reasons (echoed in the preview diff). */
export const DESTRUCTIVE_REASONS = ['stateful-remove', 'replace-eligible-update'] as const;

export type DestructiveReason = (typeof DESTRUCTIVE_REASONS)[number];

/** One destructive-operation classification inside a preview diff. */
export interface DestructiveOperation {
  operationId: string;
  resourceId: string;
  kind: Kind;
  reason: DestructiveReason;
  /** The touched replacement-eligible paths (empty for stateful-remove). */
  paths: string[];
}

/** The batch preview diff returned by the gate (design decision 8, IEP-0009 rule 5). */
export interface PreviewDiff {
  format: 'iap-semantic-diff/v1';
  adds: string[];
  removes: string[];
  changes: string[];
  destructive: boolean;
  destructiveOperations: DestructiveOperation[];
}

/**
 * Replacement-eligible resource-entry paths per kind, from the normative
 * ch. 3 Lifecycle clauses. Kinds absent from the table declare no
 * replacement-eligible field. Directional rules (engineVersion decreases,
 * Volume capacity decreases) are handled by `isReplaceEligibleChange`.
 */
export const REPLACE_ELIGIBLE_PATHS: Readonly<Partial<Record<Kind, readonly string[]>>> = {
  Database: ['spec.class', 'spec.engine'],
  Cache: ['spec.engine'],
  Volume: ['spec.accessMode'],
  Queue: ['spec.delivery', 'spec.ordering'],
  Topic: ['spec.delivery', 'spec.ordering'],
  Secret: ['spec.source'],
};

/** Directionally replacement-eligible paths: destructive only when the value DECREASES (ch. 3). */
const DIRECTIONAL_PATHS: Readonly<Partial<Record<Kind, readonly string[]>>> = {
  Database: ['spec.engineVersion'],
  Volume: ['spec.capacity.storage'],
};

export function isStatefulKind(kind: string): kind is StatefulKind {
  return (STATEFUL_KINDS as readonly string[]).includes(kind);
}

/** One path is a dot-segment prefix of the other (or they are equal). */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * Compare two dotted version spellings without floating point: numeric
 * segments compare as BigInt, missing segments as 0, non-numeric segments by
 * code point. Returns negative / zero / positive.
 */
function compareDottedVersions(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  const length = Math.max(as.length, bs.length);
  for (let i = 0; i < length; i += 1) {
    const sa = as[i] ?? '0';
    const sb = bs[i] ?? '0';
    if (/^[0-9]+$/.test(sa) && /^[0-9]+$/.test(sb)) {
      const na = BigInt(sa);
      const nb = BigInt(sb);
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/** Quantity decrease check on exact-rational milli values; unparsable operands fail destructive. */
function quantityDecreased(oldValue: unknown, newValue: unknown): boolean {
  if (typeof oldValue !== 'string' || typeof newValue !== 'string') return true;
  const before = parseQuantity(oldValue);
  const after = parseQuantity(newValue);
  if (before === null || after === null) return true;
  return after.milli < before.milli;
}

/** Version decrease check; non-string operands fail destructive. */
function versionDecreased(oldValue: unknown, newValue: unknown): boolean {
  if (typeof oldValue !== 'string' || typeof newValue !== 'string') return true;
  return compareDottedVersions(newValue, oldValue) < 0;
}

/**
 * Would writing (or unsetting: `newValue === undefined`) this resource-entry
 * path on a resource of this kind classify as `replace` at plan time?
 * Presence rules flag any overlap with a table path; directional rules flag
 * decreases only. A set path ABOVE a table path (e.g. `spec` wholesale) is
 * flagged regardless of content — the conservative reading.
 */
export function isReplaceEligibleChange(
  kind: Kind,
  path: string,
  oldValue: unknown,
  newValue: unknown,
): boolean {
  for (const eligible of REPLACE_ELIGIBLE_PATHS[kind] ?? []) {
    if (pathsOverlap(path, eligible)) return true;
  }
  for (const directional of DIRECTIONAL_PATHS[kind] ?? []) {
    if (!pathsOverlap(path, directional)) continue;
    if (oldValue === undefined) return false; // establishing a value constrains nothing existing
    if (newValue === undefined) return true; // unsetting falls back to defaults: potential decrease
    if (kind === 'Volume') return quantityDecreased(oldValue, newValue);
    return versionDecreased(oldValue, newValue);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Semantic diff over canonical projections                            */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(prefix: string, segment: string): string {
  return prefix === '' ? segment : `${prefix}.${segment}`;
}

function diffInto(
  base: unknown,
  other: unknown,
  path: string,
  out: { adds: string[]; removes: string[]; changes: string[] },
): void {
  if (isPlainObject(base) && isPlainObject(other)) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(other)])].sort();
    for (const key of keys) {
      const at = joinPath(path, key);
      if (!(key in base)) out.adds.push(at);
      else if (!(key in other)) out.removes.push(at);
      else diffInto(base[key], other[key], at, out);
    }
    return;
  }
  if (Array.isArray(base) && Array.isArray(other)) {
    const length = Math.max(base.length, other.length);
    for (let i = 0; i < length; i += 1) {
      const at = joinPath(path, String(i));
      if (i >= base.length) out.adds.push(at);
      else if (i >= other.length) out.removes.push(at);
      else diffInto(base[i], other[i], at, out);
    }
    return;
  }
  if (JSON.stringify(base) !== JSON.stringify(other)) out.changes.push(path);
}

/**
 * Build the batch preview diff from the two canonical JSON projections
 * (`@iap/model` `canonicalize(...).canonicalJson`) plus the per-operation
 * destructive classifications collected during application.
 */
export function buildPreviewDiff(
  baseCanonicalJson: string,
  resultCanonicalJson: string,
  destructiveOperations: DestructiveOperation[],
): PreviewDiff {
  const out = { adds: [] as string[], removes: [] as string[], changes: [] as string[] };
  diffInto(JSON.parse(baseCanonicalJson), JSON.parse(resultCanonicalJson), '', out);
  return {
    format: 'iap-semantic-diff/v1',
    adds: out.adds,
    removes: out.removes,
    changes: out.changes,
    destructive: destructiveOperations.length > 0,
    destructiveOperations,
  };
}
