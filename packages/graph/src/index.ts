/**
 * @iap/graph — typed graph engine over canonical IaP edges (M2.5).
 *
 * Consumes the normalized edge set produced by `@iap/model`'s `flattenEdges`
 * (ch. 4 §4.7) and provides:
 *
 * - the graph structure itself (`buildGraph`): node kinds plus outgoing /
 *   incoming / by-verb edge indexes;
 * - the normative verb/target-kind constraint tables of ch. 4 §4.3.1 and the
 *   attribute/verb validity matrix of ch. 4 §4.4 (`verbKindViolation`,
 *   `attributeViolations`) — the constraint surface validation phase 3 reads;
 * - dependency derivation per ch. 9 §9.2 (`deriveOrdering`): every verb except
 *   `dependsOn` implies *target before source*, `dependsOn` is the pure
 *   ordering arc, `replicatesTo` contributes no arc;
 * - cycle detection with full path reporting (`detectCycles`, Tarjan SCC),
 *   execution-wave layering (`executionWaves`, Kahn with lexicographic
 *   tie-break per ch. 9 §9.4), and impact/reachability queries
 *   (`dependents`, `dependencies`, `pathExists`).
 *
 * Everything here is deterministic: identical normalized edge sets yield
 * identical orderings, cycles, and waves regardless of resource-map insertion
 * order (ch. 9 §9.1).
 */

import { compareCodePoints } from '@iap/model';
import type { CanonicalEdge, RelationshipType } from '@iap/model';

/* ------------------------------------------------------------------ */
/* Graph construction                                                  */
/* ------------------------------------------------------------------ */

export interface IaPGraph {
  /** Resource id → kind, for every resource (including isolated nodes). */
  nodes: Map<string, string>;
  /** The canonical edge list the graph was built from (index-stable). */
  edges: CanonicalEdge[];
  /** Source id → edges declared by it (canonical order preserved). */
  outgoing: Map<string, CanonicalEdge[]>;
  /** Target id → edges pointing at it (canonical order preserved). */
  incoming: Map<string, CanonicalEdge[]>;
  /** Verb → edges of that verb (canonical order preserved). */
  edgesByType: Map<RelationshipType, CanonicalEdge[]>;
}

/**
 * Build the typed graph over a resources map and its normalized edge set
 * (ch. 4 §4.7 step 6 output). Edges with endpoints outside the resources map
 * are indexed anyway — dangling references are phase 2's concern (IAP201),
 * not the graph's.
 */
export function buildGraph(
  resources: Record<string, { kind: string }>,
  edges: CanonicalEdge[],
): IaPGraph {
  const nodes = new Map<string, string>();
  for (const [id, entry] of Object.entries(resources)) {
    nodes.set(id, entry.kind);
  }
  const outgoing = new Map<string, CanonicalEdge[]>();
  const incoming = new Map<string, CanonicalEdge[]>();
  const edgesByType = new Map<RelationshipType, CanonicalEdge[]>();
  for (const edge of edges) {
    push(outgoing, edge.source, edge);
    push(incoming, edge.target, edge);
    push(edgesByType, edge.type, edge);
  }
  return { nodes, edges: [...edges], outgoing, incoming, edgesByType };
}

function push<K>(map: Map<K, CanonicalEdge[]>, key: K, edge: CanonicalEdge): void {
  const list = map.get(key);
  if (list) {
    list.push(edge);
  } else {
    map.set(key, [edge]);
  }
}

/* ------------------------------------------------------------------ */
/* Verb/target-kind constraints (ch. 4 §4.3.1 — normative)             */
/* ------------------------------------------------------------------ */

/**
 * Closed target-kind lists per verb (ch. 4 §4.3.1). Verbs absent from this
 * table (`dependsOn`, `connectsTo`, `replicatesTo`, `protectedBy`) are
 * constrained by the dedicated rules below instead of a closed list.
 */
export const VERB_TARGET_KINDS: Readonly<Partial<Record<RelationshipType, readonly string[]>>> = {
  routesTo: ['Service', 'Function', 'Gateway'],
  publishesTo: ['Topic', 'Queue'],
  consumesFrom: ['Queue', 'Topic', 'Stream'],
  storesDataIn: ['ObjectStore', 'Volume', 'Database'],
  authenticatedBy: ['Identity'],
  monitoredBy: ['Dashboard', 'Alert'],
};

/** `connectsTo` targets must be network-addressable: these kinds are excluded. */
export const CONNECTS_TO_EXCLUDED_TARGET_KINDS: readonly string[] = [
  'Application',
  'Identity',
  'Secret',
];

/**
 * Check one edge against the normative verb/target-kind constraints of
 * ch. 4 §4.3.1. Returns a human-readable violation (an IAP301 condition) or
 * `null` when the combination is legal. Unknown (dangling) endpoint kinds are
 * passed as `undefined` and never reported here — dangling targets are the
 * phase 2 reference check (IAP201).
 */
export function verbKindViolation(
  type: RelationshipType,
  sourceKind: string | undefined,
  targetKind: string | undefined,
): string | null {
  if (sourceKind === undefined || targetKind === undefined) return null;

  // No edge endpoint may be an Application except as dependsOn source/target
  // (an Application is a grouping, not a runtime node).
  if (type !== 'dependsOn') {
    if (sourceKind === 'Application') {
      return `an Application may not be the source of a "${type}" edge — Application participates only in dependsOn (ch. 4 §4.3.1)`;
    }
    if (targetKind === 'Application') {
      return `an Application may not be the target of a "${type}" edge — Application participates only in dependsOn (ch. 4 §4.3.1)`;
    }
  }

  if (type === 'replicatesTo' && sourceKind !== targetKind) {
    return `replicatesTo target must have the same kind as its source (source "${sourceKind}", target "${targetKind}"; ch. 4 §4.3.1)`;
  }

  if (type === 'connectsTo' && CONNECTS_TO_EXCLUDED_TARGET_KINDS.includes(targetKind)) {
    return `connectsTo target must be network-addressable — it must not be a ${CONNECTS_TO_EXCLUDED_TARGET_KINDS.join(', ')} (found "${targetKind}"; ch. 4 §4.3.1)`;
  }

  const allowed = VERB_TARGET_KINDS[type];
  if (allowed && !allowed.includes(targetKind)) {
    return `${type} target must be a ${allowed.join(', ')} (found "${targetKind}"; ch. 4 §4.3.1)`;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Attribute/verb validity (ch. 4 §4.4 — normative)                    */
/* ------------------------------------------------------------------ */

/**
 * The attribute/verb validity matrix of ch. 4 §4.4: `port`/`protocol` on
 * `connectsTo` and `routesTo`; `access` on `connectsTo` and `storesDataIn`;
 * `path`/`host` on `routesTo` only. `dependsOn`, `publishesTo`,
 * `consumesFrom` (and the remaining verbs) accept no attributes in v1.
 */
export const EDGE_ATTRIBUTES_BY_VERB: Readonly<Record<RelationshipType, readonly string[]>> = {
  dependsOn: [],
  connectsTo: ['port', 'protocol', 'access'],
  routesTo: ['port', 'protocol', 'path', 'host'],
  publishesTo: [],
  consumesFrom: [],
  replicatesTo: [],
  storesDataIn: ['access'],
  protectedBy: [],
  monitoredBy: [],
  authenticatedBy: [],
};

/**
 * Return the attribute names present on `edge` that are invalid for its verb
 * (each an IAP302 condition), sorted lexicographically for determinism.
 */
export function attributeViolations(edge: CanonicalEdge): string[] {
  const allowed = EDGE_ATTRIBUTES_BY_VERB[edge.type] ?? [];
  return Object.keys(edge.attributes)
    .filter((name) => !allowed.includes(name))
    .sort(compareCodePoints);
}

/* ------------------------------------------------------------------ */
/* Dependency derivation (ch. 9 §9.2)                                  */
/* ------------------------------------------------------------------ */

/** One derived ordering arc: `before` must exist before `after`. */
export interface OrderingArc {
  before: string;
  after: string;
  /** The canonical edge the arc was derived from (first in canonical order when several collapse). */
  via: CanonicalEdge;
}

export interface OrderingResult {
  edges: OrderingArc[];
}

/**
 * Derive the dependency graph per ch. 9 §9.2: every edge except
 * `replicatesTo` contributes one *target before source* arc (`dependsOn` is
 * the pure ordering arc; every semantic verb couples the same arc with its
 * assertion; `replicatesTo` contributes none). Multiple constraints between
 * the same pair collapse to a single arc (rule 4), keeping the first
 * contributing edge in canonical order as `via`. Output is sorted by
 * (before, after).
 */
export function deriveOrdering(graph: IaPGraph): OrderingResult {
  const byPair = new Map<string, OrderingArc>();
  for (const edge of graph.edges) {
    if (edge.type === 'replicatesTo') continue;
    const key = `${edge.target} ${edge.source}`;
    if (!byPair.has(key)) {
      byPair.set(key, { before: edge.target, after: edge.source, via: edge });
    }
  }
  const edges = [...byPair.values()].sort(
    (a, b) => compareCodePoints(a.before, b.before) || compareCodePoints(a.after, b.after),
  );
  return { edges };
}

/* ------------------------------------------------------------------ */
/* Cycle detection (ch. 9 §9.3 — IAP401 obligation)                    */
/* ------------------------------------------------------------------ */

interface Adjacency {
  nodes: string[];
  successors: Map<string, string[]>;
}

function orderingAdjacency(ordering: OrderingResult): Adjacency {
  const nodeSet = new Set<string>();
  const successors = new Map<string, string[]>();
  for (const arc of ordering.edges) {
    nodeSet.add(arc.before);
    nodeSet.add(arc.after);
    const list = successors.get(arc.before);
    if (list) {
      if (!list.includes(arc.after)) list.push(arc.after);
    } else {
      successors.set(arc.before, [arc.after]);
    }
  }
  for (const list of successors.values()) list.sort(compareCodePoints);
  return { nodes: [...nodeSet].sort(compareCodePoints), successors };
}

/**
 * Detect ordering cycles (Tarjan strongly connected components). Returns one
 * full cycle path per non-trivial SCC plus one per self-loop, each as the
 * node sequence `[a, b, c]` meaning `a → b → c → a`. Deterministic: nodes are
 * visited in lexicographic order, each cycle starts at its SCC's
 * lexicographically smallest member and follows shortest-path arcs back to
 * it, and the result is sorted by starting node. An empty result means the
 * ordering relation is a DAG (ch. 9 §9.3).
 */
export function detectCycles(ordering: OrderingResult): string[][] {
  const { nodes, successors } = orderingAdjacency(ordering);

  // Tarjan SCC (iterative, deterministic visit order).
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  interface Frame {
    node: string;
    next: number;
  }

  for (const root of nodes) {
    if (index.has(root)) continue;
    const frames: Frame[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as Frame;
      const succ = successors.get(frame.node) ?? [];
      if (frame.next < succ.length) {
        const child = succ[frame.next] as string;
        frame.next += 1;
        if (!index.has(child)) {
          index.set(child, counter);
          lowLink.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          frames.push({ node: child, next: 0 });
        } else if (onStack.has(child)) {
          const low = Math.min(lowLink.get(frame.node) as number, index.get(child) as number);
          lowLink.set(frame.node, low);
        }
      } else {
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) {
          const low = Math.min(
            lowLink.get(parent.node) as number,
            lowLink.get(frame.node) as number,
          );
          lowLink.set(parent.node, low);
        }
        if (lowLink.get(frame.node) === index.get(frame.node)) {
          const component: string[] = [];
          for (;;) {
            const member = stack.pop() as string;
            onStack.delete(member);
            component.push(member);
            if (member === frame.node) break;
          }
          sccs.push(component);
        }
      }
    }
  }

  const cycles: string[][] = [];
  for (const scc of sccs) {
    if (scc.length === 1) {
      const node = scc[0] as string;
      if ((successors.get(node) ?? []).includes(node)) cycles.push([node]);
    } else {
      cycles.push(cyclePathWithin(new Set(scc), successors));
    }
  }
  cycles.sort((a, b) => compareCodePoints(a[0] ?? '', b[0] ?? ''));
  return cycles;
}

/**
 * One deterministic full cycle path inside a strongly connected component:
 * start at the lexicographically smallest member, BFS (sorted successors)
 * back to the start, and return `[start, …, last]` where `last → start`.
 */
function cyclePathWithin(members: Set<string>, successors: Map<string, string[]>): string[] {
  const start = [...members].sort(compareCodePoints)[0] as string;
  const parent = new Map<string, string>();
  const queue: string[] = [start];
  const seen = new Set<string>([start]);
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const next of successors.get(node) ?? []) {
      if (next === start) {
        // Found the shortest deterministic way back to the start.
        const path: string[] = [node];
        let cursor = node;
        while (cursor !== start) {
          cursor = parent.get(cursor) as string;
          path.push(cursor);
        }
        return path.reverse();
      }
      if (members.has(next) && !seen.has(next)) {
        seen.add(next);
        parent.set(next, node);
        queue.push(next);
      }
    }
  }
  /* c8 ignore next -- unreachable: an SCC of size ≥ 2 always closes a cycle */
  return [start];
}

/* ------------------------------------------------------------------ */
/* Execution waves (ch. 9 §9.4)                                        */
/* ------------------------------------------------------------------ */

/**
 * Kahn topological layering: wave *n* contains every node whose longest
 * incoming dependency path has length *n − 1*; nodes within a wave are
 * independent and sorted lexicographically (the deterministic tie-break of
 * ch. 9 §9.4). Isolated resources land in wave 1. Throws when the ordering
 * relation is cyclic — a planner must never be handed a cyclic graph
 * (ch. 9 §9.3); run `detectCycles` for the paths.
 */
export function executionWaves(graph: IaPGraph): string[][] {
  const ordering = deriveOrdering(graph);
  const nodeSet = new Set<string>(graph.nodes.keys());
  for (const arc of ordering.edges) {
    nodeSet.add(arc.before);
    nodeSet.add(arc.after);
  }
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const node of nodeSet) indegree.set(node, 0);
  for (const arc of ordering.edges) {
    indegree.set(arc.after, (indegree.get(arc.after) ?? 0) + 1);
    const list = successors.get(arc.before);
    if (list) {
      list.push(arc.after);
    } else {
      successors.set(arc.before, [arc.after]);
    }
  }

  const waves: string[][] = [];
  let frontier = [...nodeSet].filter((node) => indegree.get(node) === 0).sort(compareCodePoints);
  let placed = 0;
  while (frontier.length > 0) {
    waves.push(frontier);
    placed += frontier.length;
    const next: string[] = [];
    for (const node of frontier) {
      for (const succ of successors.get(node) ?? []) {
        const remaining = (indegree.get(succ) as number) - 1;
        indegree.set(succ, remaining);
        if (remaining === 0) next.push(succ);
      }
    }
    frontier = next.sort(compareCodePoints);
  }
  if (placed < nodeSet.size) {
    throw new Error(
      'the derived ordering relation contains a cycle (IAP401); run detectCycles(deriveOrdering(graph)) for the cycle paths',
    );
  }
  return waves;
}

/* ------------------------------------------------------------------ */
/* Impact and reachability queries                                     */
/* ------------------------------------------------------------------ */

function closure(start: string, next: Map<string, string[]>): string[] {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const succ of next.get(node) ?? []) {
      if (!seen.has(succ)) {
        seen.add(succ);
        queue.push(succ);
      }
    }
  }
  seen.delete(start);
  return [...seen].sort(compareCodePoints);
}

function orderingSuccessors(graph: IaPGraph, reverse: boolean): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const arc of deriveOrdering(graph).edges) {
    const from = reverse ? arc.after : arc.before;
    const to = reverse ? arc.before : arc.after;
    const list = next.get(from);
    if (list) {
      list.push(to);
    } else {
      next.set(from, [to]);
    }
  }
  return next;
}

/**
 * Transitive impact set: every resource that (directly or transitively)
 * depends on `id` — the resources affected when `id` changes or fails.
 * Sorted lexicographically; excludes `id` itself.
 */
export function dependents(graph: IaPGraph, id: string): string[] {
  return closure(id, orderingSuccessors(graph, false));
}

/**
 * Every resource `id` (directly or transitively) depends on — everything that
 * must exist before it. Sorted lexicographically; excludes `id` itself.
 */
export function dependencies(graph: IaPGraph, id: string): string[] {
  return closure(id, orderingSuccessors(graph, true));
}

/**
 * True when an ordering path exists from `from` to `to`, i.e. `from` must be
 * provisioned before `to` (trivially true when `from === to`).
 */
export function pathExists(graph: IaPGraph, from: string, to: string): boolean {
  if (from === to) return true;
  return dependents(graph, from).includes(to);
}
