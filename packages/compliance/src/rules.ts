/**
 * Control-rule evaluation (spec ch. 17). A control expresses a condition that
 * MUST hold for a targeted resource to be compliant. Two forms: a field rule (a
 * dot-path leaf over the resource) and a derived rule (a closed set of
 * edge/graph checks, e.g. least-privilege). Every rule is a deterministic
 * function of the canonical document — reproducible by any validator (§17.2).
 */
import type { CanonicalModel, CanonicalResource } from '@iap/model';

export const DATA_KINDS = new Set(['Database', 'Cache', 'ObjectStore', 'Volume']);
export const WORKLOAD_KINDS = new Set(['Service', 'Job', 'Function']);

/** A leaf condition over a resource field (dot path from the resource root). */
export interface FieldRule {
  kind: 'field';
  field: string;
  operator: 'equals' | 'not-equals' | 'in' | 'not-in' | 'exists' | 'gte-version';
  value?: unknown;
}

/** Closed set of graph/edge-derived checks a control can reference. */
export type DerivedCheck =
  | 'every-data-edge-has-access'
  | 'no-admin-to-data'
  | 'workloads-authenticated'
  | 'no-undeclared-reachability';

export interface DerivedRule {
  kind: 'derived';
  check: DerivedCheck;
}

export type ControlRule = FieldRule | DerivedRule;

function resolve(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const seg of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/** Compare dotted numeric versions: `a >= b`. `1.3` >= `1.2`. */
function versionGte(a: unknown, b: unknown): boolean {
  const parse = (v: unknown): number[] =>
    typeof v === 'string' || typeof v === 'number'
      ? String(v)
          .split('.')
          .map((n) => Number(n) || 0)
      : [-1];
  const [av, bv] = [parse(a), parse(b)];
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Does a field rule HOLD for one resource? */
export function fieldRuleHolds(resource: CanonicalResource, rule: FieldRule): boolean {
  const actual = resolve(resource, rule.field);
  switch (rule.operator) {
    case 'equals':
      return actual === rule.value;
    case 'not-equals':
      return actual !== rule.value;
    case 'in':
      return Array.isArray(rule.value) && rule.value.includes(actual);
    case 'not-in':
      return Array.isArray(rule.value) && !rule.value.includes(actual);
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'gte-version':
      return actual !== undefined && versionGte(actual, rule.value);
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* Derived checks — return the resource ids that VIOLATE the check      */
/* ------------------------------------------------------------------ */

/** Ids of resources violating a derived check (empty = satisfied for all). */
export function derivedViolations(model: CanonicalModel, check: DerivedCheck): string[] {
  const kindOf = (id: string): string | undefined => model.resources[id]?.kind;
  const workloadDataEdges = model.edges.filter(
    (e) =>
      (e.type === 'connectsTo' || e.type === 'storesDataIn') &&
      WORKLOAD_KINDS.has(kindOf(e.source) ?? '') &&
      DATA_KINDS.has(kindOf(e.target) ?? ''),
  );

  switch (check) {
    case 'every-data-edge-has-access':
      return [
        ...new Set(
          workloadDataEdges
            .filter((e) => typeof e.attributes.access !== 'string')
            .map((e) => e.target),
        ),
      ].sort();
    case 'no-admin-to-data':
      return [
        ...new Set(
          workloadDataEdges.filter((e) => e.attributes.access === 'admin').map((e) => e.target),
        ),
      ].sort();
    case 'workloads-authenticated': {
      const authenticated = new Set(
        model.edges.filter((e) => e.type === 'authenticatedBy').map((e) => e.source),
      );
      return [
        ...new Set(
          workloadDataEdges.filter((e) => !authenticated.has(e.source)).map((e) => e.source),
        ),
      ].sort();
    }
    case 'no-undeclared-reachability':
      // Zero-trust by construction (ch. 15 §15.4): reachability is exactly the
      // declared edges, so this control is always satisfied by the model.
      return [];
    default:
      return [];
  }
}
