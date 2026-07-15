/**
 * Graph scheduler: waves per ch. 14 §14.3–§14.4.
 *
 * Forward actions (create / update-in-place / replace / import) are layered
 * by longest dependency path (Kahn layering) over the desired plan's
 * `dependsOn` edges, restricted to scheduled nodes; where an unscheduled
 * (no-op) node lies on a path between two scheduled nodes, the transitive
 * ordering edge is inserted so ordering guarantees survive restriction
 * (§14.3). A replace occupies a single node at its position in the DAG: the
 * §14.2 sequence "create successor, rebind, delete predecessor" is one
 * atomic scheduled step, so changed dependents of a replaced node schedule
 * in strictly later waves via their ordering edge, and unchanged dependents
 * stay out of the wave schedule (they surface in `verification` instead —
 * a documented narrowing of §14.3's verify nodes; engines re-verify per
 * §14.4 regardless).
 *
 * Delete actions schedule AFTER every forward wave, in reverse dependency
 * order among themselves (§14.3: a deleted resource is removed only after
 * every deleted resource that depends on it), using the deployed-time
 * `dependsOn` edges recorded in the state snapshot; chains through
 * non-deleted state objects are preserved transitively. Within every wave,
 * entries sort lexicographically by resource identifier (§14.4, CP-2).
 */

import { compareCodePoints } from '@iap/model';
import type { ProviderPlan } from '@iap/provider-sdk';
import type { StateSnapshot } from './inputs.js';
import type { PlanActionEntry } from './lifecycle.js';

/**
 * Longest-path layer per node over `edges` (node → its prerequisites).
 * Prerequisites outside `nodes` are resolved transitively through
 * `passthrough` (unscheduled nodes on the path); anything else is ignored.
 * Throws on a prerequisite cycle (ordering cycles fail document validation
 * long before planning — ch. 14 §14.1 step 2 — so a cycle here means a
 * malformed provider plan or snapshot, refused rather than mis-scheduled).
 */
function layer(
  nodes: ReadonlySet<string>,
  prerequisitesOf: (node: string) => readonly string[],
  passthrough: ReadonlySet<string>,
): Map<string, number> {
  const layers = new Map<string, number>();
  const visiting = new Set<string>();

  /** Scheduled prerequisites of `node`, resolved through passthrough nodes. */
  const resolve = (node: string, seen: Set<string>): string[] => {
    const out: string[] = [];
    for (const dep of prerequisitesOf(node)) {
      if (nodes.has(dep)) {
        out.push(dep);
      } else if (passthrough.has(dep) && !seen.has(dep)) {
        seen.add(dep);
        out.push(...resolve(dep, seen));
      }
    }
    return out;
  };

  const layerOf = (node: string): number => {
    const known = layers.get(node);
    if (known !== undefined) return known;
    if (visiting.has(node)) {
      throw new Error(
        `dependency cycle involving "${node}" — ordering cycles must fail validation before planning (ch. 14 §14.1)`,
      );
    }
    visiting.add(node);
    let value = 0;
    for (const dep of resolve(node, new Set([node]))) {
      value = Math.max(value, layerOf(dep) + 1);
    }
    visiting.delete(node);
    layers.set(node, value);
    return value;
  };

  for (const node of nodes) layerOf(node);
  return layers;
}

function toWaves(entries: PlanActionEntry[], layers: Map<string, number>): PlanActionEntry[][] {
  const waves: PlanActionEntry[][] = [];
  for (const entry of entries) {
    const index = layers.get(entry.resource) as number;
    (waves[index] ??= []).push(entry);
  }
  for (const wave of waves) wave.sort((a, b) => compareCodePoints(a.resource, b.resource));
  return waves.filter((wave) => wave.length > 0);
}

/**
 * Schedule the determined actions into waves: forward waves first, delete
 * waves after them. Pure and deterministic; input order does not matter.
 */
export function scheduleWaves(
  actions: PlanActionEntry[],
  desired: ProviderPlan,
  state: StateSnapshot,
): PlanActionEntry[][] {
  const forward = actions.filter((entry) => entry.action !== 'delete');
  const deletes = actions.filter((entry) => entry.action === 'delete');

  // Forward layering over the desired plan's dependsOn edges. Unscheduled
  // desired resources (no-ops) are passthrough for transitive ordering.
  const desiredDeps = new Map<string, readonly string[]>();
  for (const resource of desired.resources) {
    desiredDeps.set(resource.logicalId, resource.dependsOn);
  }
  const forwardNodes = new Set(forward.map((entry) => entry.resource));
  const forwardPassthrough = new Set([...desiredDeps.keys()].filter((id) => !forwardNodes.has(id)));
  const forwardLayers = layer(
    forwardNodes,
    (node) => desiredDeps.get(node) ?? [],
    forwardPassthrough,
  );

  // Delete layering over REVERSED deployed-time edges: a delete's
  // prerequisites are the deleted objects that depend on it (dependents
  // first, §14.3). Non-deleted state objects are passthrough so chains
  // through retained objects still order correctly.
  const deleteNodes = new Set(deletes.map((entry) => entry.resource));
  const dependentsOf = new Map<string, string[]>();
  for (const [logicalId, object] of Object.entries(state.objects)) {
    for (const dep of object.dependsOn ?? []) {
      const dependents = dependentsOf.get(dep) ?? [];
      dependents.push(logicalId);
      dependentsOf.set(dep, dependents);
    }
  }
  const deletePassthrough = new Set(
    Object.keys(state.objects).filter((id) => !deleteNodes.has(id)),
  );
  const deleteLayers = layer(
    deleteNodes,
    (node) => dependentsOf.get(node) ?? [],
    deletePassthrough,
  );

  return [...toWaves(forward, forwardLayers), ...toWaves(deletes, deleteLayers)];
}
