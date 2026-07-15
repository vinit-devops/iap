/**
 * Security derivation (spec ch. 15). Every control is derived from exactly the
 * canonical document — intent fields, the relationship graph, and policies —
 * never from annotations. This module derives the three review surfaces of
 * §15.9: least-privilege grants (§15.3), the zero-trust reachability graph
 * (§15.4), and the encryption/secret posture (§15.5–§15.6). Pure functions.
 */
import type { CanonicalEdge, CanonicalModel, CanonicalResource } from '@iap/model';

export const WORKLOAD_KINDS = new Set(['Service', 'Job', 'Function']);
export const DATA_KINDS = new Set(['Database', 'Cache', 'ObjectStore', 'Volume']);

/** A single least-privilege grant derived from one edge's `access` attribute. */
export interface Grant {
  /** The identity principal the grant attaches to. */
  principal: string;
  /** The workload the principal is bound to. */
  workload: string;
  /** The target resource. */
  target: string;
  targetKind: string;
  /** `read` | `write` | `read-write` | `admin`, verbatim from the edge. */
  access: string;
  /** The edge verb justifying the grant. */
  via: string;
}

/** Who may initiate traffic to one resource, and on what. */
export interface Reachability {
  target: string;
  kind: string;
  /** `public` | `internal` | `private`. */
  exposure: string;
  /** Declared inbound sources (edge origins), with port/protocol when stated. */
  acceptsFrom: { source: string; port?: number; protocol?: string }[];
  /** True when `exposure` widens ingress beyond declared edges. */
  externallyReachable: boolean;
}

/** Per-resource encryption posture (both dimensions default `required`). */
export interface EncryptionPosture {
  resource: string;
  kind: string;
  atRest: string;
  inTransit: string;
  /** True when either dimension is explicitly downgraded to `preferred`. */
  downgraded: boolean;
}

function edgeAccess(edge: CanonicalEdge): string | undefined {
  const access = edge.attributes.access;
  return typeof access === 'string' ? access : undefined;
}

/** Map each workload to its identity: an `authenticatedBy` target, or an implicit per-workload identity. */
export function identityOfWorkloads(model: CanonicalModel): Map<string, string> {
  const identity = new Map<string, string>();
  for (const [id, resource] of Object.entries(model.resources)) {
    if (WORKLOAD_KINDS.has(resource.kind)) identity.set(id, id); // implicit anonymous identity
  }
  for (const edge of model.edges) {
    if (
      edge.type === 'authenticatedBy' &&
      WORKLOAD_KINDS.has(model.resources[edge.source]?.kind ?? '')
    ) {
      identity.set(edge.source, edge.target);
    }
  }
  return identity;
}

/**
 * Derive the least-privilege grant table (§15.3): one grant per workload edge
 * that declares `access`. No edge → no grant. Sorted by (principal, target).
 */
export function deriveGrants(model: CanonicalModel): Grant[] {
  const identity = identityOfWorkloads(model);
  const grants: Grant[] = [];
  for (const edge of model.edges) {
    const source = model.resources[edge.source];
    if (source === undefined || !WORKLOAD_KINDS.has(source.kind)) continue;
    const access = edgeAccess(edge);
    if (access === undefined) continue; // connectivity only, no data-plane grant
    const target = model.resources[edge.target];
    if (target === undefined) continue;
    grants.push({
      principal: identity.get(edge.source) ?? edge.source,
      workload: edge.source,
      target: edge.target,
      targetKind: target.kind,
      access,
      via: edge.type,
    });
  }
  grants.sort((a, b) =>
    a.principal === b.principal
      ? a.target === b.target
        ? a.via.localeCompare(b.via)
        : a.target.localeCompare(b.target)
      : a.principal.localeCompare(b.principal),
  );
  return grants;
}

/** Derive the reachability graph (§15.4). Sorted by target. */
export function deriveReachability(model: CanonicalModel): Reachability[] {
  const inbound = new Map<string, { source: string; port?: number; protocol?: string }[]>();
  for (const edge of model.edges) {
    if (edge.type !== 'connectsTo' && edge.type !== 'routesTo') continue;
    const list = inbound.get(edge.target) ?? [];
    const entry: { source: string; port?: number; protocol?: string } = { source: edge.source };
    if (typeof edge.attributes.port === 'number') entry.port = edge.attributes.port;
    if (typeof edge.attributes.protocol === 'string') entry.protocol = edge.attributes.protocol;
    list.push(entry);
    inbound.set(edge.target, list);
  }
  return Object.keys(model.resources)
    .sort()
    .map((id) => {
      const resource = model.resources[id] as CanonicalResource;
      const exposure =
        typeof resource.spec.exposure === 'string' ? resource.spec.exposure : 'private';
      const accepts = (inbound.get(id) ?? []).sort((a, b) => a.source.localeCompare(b.source));
      return {
        target: id,
        kind: resource.kind,
        exposure,
        acceptsFrom: accepts,
        externallyReachable: exposure !== 'private',
      };
    });
}

/** Derive per-resource encryption posture (§15.6) for data-bearing/serving kinds. */
export function deriveEncryption(model: CanonicalModel): EncryptionPosture[] {
  const postures: EncryptionPosture[] = [];
  for (const id of Object.keys(model.resources).sort()) {
    const resource = model.resources[id] as CanonicalResource;
    const enc = resource.spec.encryption;
    if (typeof enc !== 'object' || enc === null) continue;
    const e = enc as { atRest?: unknown; inTransit?: unknown };
    const atRest = typeof e.atRest === 'string' ? e.atRest : 'required';
    const inTransit = typeof e.inTransit === 'string' ? e.inTransit : 'required';
    postures.push({
      resource: id,
      kind: resource.kind,
      atRest,
      inTransit,
      downgraded: atRest === 'preferred' || inTransit === 'preferred',
    });
  }
  return postures;
}
