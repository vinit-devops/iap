/**
 * @iap/architecture — derived architecture views and diagram exporters (M8.1–M8.3).
 *
 * Every diagram is a derived view of the canonical model (ch. 18 §18.1): there
 * is no diagram authoring surface, and no manual layout, grouping, or edge
 * annotation is ever accepted as semantic input. This package implements:
 *
 * - the five standard views of ch. 18 §18.2 (`deriveView`): architecture
 *   (semantic edges, Application groupings as containers), dependency (the
 *   ch. 9 ordering DAG in provisioning direction), network (nested exposure
 *   trust zones public ⊃ internal ⊃ private, connectsTo/routesTo edges only),
 *   security (identities/secrets, authenticatedBy/protectedBy plus
 *   access-carrying edges, textual encryption badges), and application (one
 *   subgraph per Application resource);
 * - textual exporters (`toMermaid`, `toDot`) honoring the rendering contract
 *   of ch. 18 §18.3: byte-identical source for identical canonical input,
 *   nodes in lexicographic identifier order, edges in ch. 4 §4.7 step-6
 *   order, labels from the normative templates;
 * - a before/after diff (`diffViews`): a union graph marking every node and
 *   edge `added` / `removed` / `changed` / `unchanged` in its `style` field,
 *   rendered with `:::added`-style class annotations in Mermaid and color /
 *   dash attributes in DOT (the mechanism the Phase 14 drift overlay reuses).
 *
 * **No layout hints live in the semantic output.** A `ViewGraph` carries no
 * coordinates, sizes, or renderer directives — cosmetic hints would be a
 * separate overlay artifact, and stripping all styling depicts the identical
 * graph (ch. 18 §18.3, Extension Non-Interference corollary). Rasterization
 * (SVG/PNG/PDF) is a renderer concern: the conformance artifact is the
 * textual source, because text is diffable, reviewable, and hashable.
 */

import {
  RELATIONSHIP_TYPES,
  canonicalJsonStringify,
  compareCodePoints,
  sha256Hex,
} from '@iap/model';
import type { CanonicalEdge, CanonicalModel, CanonicalResource } from '@iap/model';
import { buildGraph, deriveOrdering } from '@iap/graph';

/* ------------------------------------------------------------------ */
/* View graph types                                                    */
/* ------------------------------------------------------------------ */

export type ViewName = 'architecture' | 'dependency' | 'network' | 'security' | 'application';

/** The three exposure trust zones, outermost to innermost (ch. 18 §18.2.3). */
export const EXPOSURE_ZONES = ['public', 'internal', 'private'] as const;
export type ExposureZone = (typeof EXPOSURE_ZONES)[number];

/**
 * One node of a derived view. `sourcePointer` is the RFC 6901 pointer into
 * the canonical document (`/resources/<id>`) enabling clickable provenance;
 * `specHash` is a deterministic fingerprint of the resource's canonical
 * content (kind, labels, spec, extensions) used by `diffViews` to detect
 * semantic changes that do not alter the visible label.
 */
export interface ViewNode {
  id: string;
  kind: string;
  label: string;
  /** Effective exposure zone (network view only; materialized value, default private). */
  zone?: ExposureZone;
  /** Owning container id (Application id), when the node is grouped. */
  group?: string;
  /** Textual badges, e.g. `atRest:required` (security view only). */
  badges?: string[];
  /** RFC 6901 pointer into the canonical document. */
  sourcePointer: string;
  /** SHA-256 of the resource's canonical content; drives `diffViews` change detection. */
  specHash: string;
  /** Cosmetic status: `external` (application view) or a diff status from `diffViews`. */
  style?: string;
}

/** One edge of a derived view. Ids are stable: `<source>--<type>--<target>` (+ ordinal on collision). */
export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  /** Relationship verb, or `ordering` for derived dependency arcs. */
  type: string;
  label?: string;
  /** Diff status from `diffViews` (`added` / `removed` / `changed` / `unchanged`). */
  style?: string;
}

/** One container (Application grouping or exposure zone). */
export interface ViewGroup {
  id: string;
  label: string;
  members: string[];
}

/**
 * A derived view: deterministic pure function of the canonical model. Nodes
 * are sorted lexicographically by id; edges by (source, verb enum order,
 * target, label). Contains no layout data whatsoever.
 */
export interface ViewGraph {
  view: ViewName;
  nodes: ViewNode[];
  edges: ViewEdge[];
  groups?: ViewGroup[];
}

export interface ViewFilter {
  /** Keep only nodes whose resource kind is in this list. */
  kinds?: string[];
  /** Keep only nodes whose resource labels include every entry. */
  labels?: Record<string, string>;
}

export interface DeriveViewOptions {
  /** Application resource id — required for (and only used by) the application view. */
  application?: string;
  /** Node filter; edges survive only when both endpoints survive. */
  filter?: ViewFilter;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const NETWORK_EXCLUDED_KINDS: ReadonlySet<string> = new Set(['Application', 'Identity', 'Secret']);
const SECURITY_ALWAYS_KINDS: ReadonlySet<string> = new Set(['Identity', 'Secret', 'Certificate']);
const SECURITY_VERBS: ReadonlySet<string> = new Set(['authenticatedBy', 'protectedBy']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedResourceIds(model: CanonicalModel): string[] {
  return Object.keys(model.resources).sort(compareCodePoints);
}

function makeNode(id: string, resource: CanonicalResource): ViewNode {
  return {
    id,
    kind: resource.kind,
    label: `${id} (${resource.kind})`,
    sourcePointer: `/resources/${id}`,
    specHash: sha256Hex(
      canonicalJsonStringify({
        extensions: resource.extensions,
        kind: resource.kind,
        labels: resource.labels,
        spec: resource.spec,
      }),
    ),
  };
}

/** Effective exposure zone: materialized `spec.exposure`, defaulting to `private` (ch. 3). */
function effectiveZone(resource: CanonicalResource): ExposureZone {
  const exposure = resource.spec['exposure'];
  return exposure === 'public' || exposure === 'internal' || exposure === 'private'
    ? exposure
    : 'private';
}

/** Textual encryption badges from the materialized spec (ch. 18 §18.2.4). */
function encryptionBadges(resource: CanonicalResource): string[] {
  const encryption = resource.spec['encryption'];
  const badges: string[] = [];
  if (isRecord(encryption)) {
    if (typeof encryption['atRest'] === 'string') badges.push(`atRest:${encryption['atRest']}`);
    if (typeof encryption['inTransit'] === 'string') {
      badges.push(`inTransit:${encryption['inTransit']}`);
    }
  }
  return badges;
}

function protocolPort(attributes: CanonicalEdge['attributes']): string | undefined {
  const parts: string[] = [];
  if (attributes['protocol'] !== undefined) parts.push(String(attributes['protocol']));
  if (attributes['port'] !== undefined) parts.push(String(attributes['port']));
  return parts.length > 0 ? parts.join('/') : undefined;
}

/** §18.3 template: `<verb>` + `<protocol>/<port>` + `<path>` + `(<access>)`, present elements only. */
function semanticEdgeLabel(edge: CanonicalEdge): string {
  const parts: string[] = [edge.type];
  const pp = protocolPort(edge.attributes);
  if (pp !== undefined) parts.push(pp);
  if (edge.attributes['path'] !== undefined) parts.push(String(edge.attributes['path']));
  if (edge.attributes['access'] !== undefined) parts.push(`(${String(edge.attributes['access'])})`);
  return parts.join(' ');
}

/** Network label: verb omitted; `protocol/port` plus, for routes, `path` and `host` (§18.2.3). */
function networkEdgeLabel(edge: CanonicalEdge): string | undefined {
  const parts: string[] = [];
  const pp = protocolPort(edge.attributes);
  if (pp !== undefined) parts.push(pp);
  if (edge.attributes['path'] !== undefined) parts.push(String(edge.attributes['path']));
  if (edge.attributes['host'] !== undefined) parts.push(String(edge.attributes['host']));
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Security label: verb plus the derived access level when the edge carries one (§18.2.4). */
function securityEdgeLabel(edge: CanonicalEdge): string {
  const access = edge.attributes['access'];
  return access !== undefined ? `${edge.type} (${String(access)})` : edge.type;
}

function verbRank(type: string): number {
  const index = (RELATIONSHIP_TYPES as readonly string[]).indexOf(type);
  return index === -1 ? RELATIONSHIP_TYPES.length : index;
}

type EdgeDraft = Omit<ViewEdge, 'id'>;

/** Deterministic edge order: (source, verb enum order, target, label) per §18.3. */
function compareEdgeDrafts(a: EdgeDraft, b: EdgeDraft): number {
  return (
    compareCodePoints(a.source, b.source) ||
    verbRank(a.type) - verbRank(b.type) ||
    compareCodePoints(a.target, b.target) ||
    compareCodePoints(a.label ?? '', b.label ?? '')
  );
}

/** Sort drafts and assign stable ids (`source--type--target`, ordinal suffix on collision). */
function finalizeEdges(drafts: EdgeDraft[]): ViewEdge[] {
  const sorted = [...drafts].sort(compareEdgeDrafts);
  const seen = new Map<string, number>();
  return sorted.map((draft) => {
    const base = `${draft.source}--${draft.type}--${draft.target}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { id: count === 1 ? base : `${base}--${count}`, ...draft };
  });
}

/** Application ownership: component id → lexicographically first owning Application (§18.2.1). */
function applicationOwnership(model: CanonicalModel): Map<string, string> {
  const owner = new Map<string, string>();
  for (const appId of sortedResourceIds(model)) {
    const app = model.resources[appId];
    if (!app || app.kind !== 'Application') continue;
    for (const component of componentIds(model, app)) {
      if (!owner.has(component)) owner.set(component, appId);
    }
  }
  return owner;
}

/** The Application's `spec.components` that exist in the model, lexicographically sorted. */
function componentIds(model: CanonicalModel, app: CanonicalResource): string[] {
  const components = app.spec['components'];
  if (!Array.isArray(components)) return [];
  return components
    .filter((c): c is string => typeof c === 'string' && model.resources[c] !== undefined)
    .sort(compareCodePoints);
}

/* ------------------------------------------------------------------ */
/* View derivation (ch. 18 §18.2)                                      */
/* ------------------------------------------------------------------ */

/**
 * Derive one of the five standard views from a canonical model — a pure,
 * deterministic function: identical canonical input yields an identical
 * `ViewGraph` and therefore byte-identical Mermaid/DOT source (§18.1, §18.3).
 */
export function deriveView(
  model: CanonicalModel,
  view: ViewName,
  options: DeriveViewOptions = {},
): ViewGraph {
  let graph: ViewGraph;
  switch (view) {
    case 'architecture':
      graph = architectureView(model);
      break;
    case 'dependency':
      graph = dependencyView(model);
      break;
    case 'network':
      graph = networkView(model);
      break;
    case 'security':
      graph = securityView(model);
      break;
    case 'application':
      graph = applicationView(model, options.application);
      break;
    default:
      throw new Error(`unknown view "${String(view)}" (ch. 18 §18.2 defines five views)`);
  }
  return options.filter ? filterView(model, graph, options.filter) : graph;
}

/** §18.2.1 — every resource except Applications; Applications become containers; no dependsOn. */
function architectureView(model: CanonicalModel): ViewGraph {
  const owner = applicationOwnership(model);
  const nodes: ViewNode[] = [];
  for (const id of sortedResourceIds(model)) {
    const resource = model.resources[id];
    if (!resource || resource.kind === 'Application') continue;
    const node = makeNode(id, resource);
    const group = owner.get(id);
    if (group !== undefined) node.group = group;
    nodes.push(node);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const drafts: EdgeDraft[] = model.edges
    .filter((e) => e.type !== 'dependsOn' && nodeIds.has(e.source) && nodeIds.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      label: semanticEdgeLabel(e),
    }));
  const groups: ViewGroup[] = [];
  for (const appId of sortedResourceIds(model)) {
    const app = model.resources[appId];
    if (!app || app.kind !== 'Application') continue;
    groups.push({
      id: appId,
      label: `${appId} (Application)`,
      members: componentIds(model, app).filter((c) => owner.get(c) === appId),
    });
  }
  const graph: ViewGraph = { view: 'architecture', nodes, edges: finalizeEdges(drafts) };
  if (groups.length > 0) graph.groups = groups;
  return graph;
}

/** §18.2.2 — the derived ordering DAG of ch. 9, drawn in provisioning direction (before → after). */
function dependencyView(model: CanonicalModel): ViewGraph {
  const ordering = deriveOrdering(buildGraph(model.resources, model.edges));
  const arcs = ordering.edges.filter(
    (arc) => model.resources[arc.before] !== undefined && model.resources[arc.after] !== undefined,
  );
  const participants = new Set<string>();
  for (const arc of arcs) {
    participants.add(arc.before);
    participants.add(arc.after);
  }
  const nodes = [...participants]
    .sort(compareCodePoints)
    .map((id) => makeNode(id, model.resources[id] as CanonicalResource));
  const drafts: EdgeDraft[] = arcs.map((arc) => ({
    source: arc.before,
    target: arc.after,
    type: 'ordering',
  }));
  return { view: 'dependency', nodes, edges: finalizeEdges(drafts) };
}

/** §18.2.3 — nested trust zones public ⊃ internal ⊃ private; connectsTo/routesTo edges only. */
function networkView(model: CanonicalModel): ViewGraph {
  const nodes: ViewNode[] = [];
  const zoneMembers: Record<ExposureZone, string[]> = { public: [], internal: [], private: [] };
  for (const id of sortedResourceIds(model)) {
    const resource = model.resources[id];
    if (!resource || NETWORK_EXCLUDED_KINDS.has(resource.kind)) continue;
    const node = makeNode(id, resource);
    node.zone = effectiveZone(resource);
    zoneMembers[node.zone].push(id);
    nodes.push(node);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const drafts: EdgeDraft[] = [];
  for (const e of model.edges) {
    if (e.type !== 'connectsTo' && e.type !== 'routesTo') continue;
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const draft: EdgeDraft = { source: e.source, target: e.target, type: e.type };
    const label = networkEdgeLabel(e);
    if (label !== undefined) draft.label = label;
    drafts.push(draft);
  }
  // All three zone containers are always emitted, outermost to innermost (§18.2.3).
  const groups: ViewGroup[] = EXPOSURE_ZONES.map((zone) => ({
    id: `zone-${zone}`,
    label: `zone: ${zone}`,
    members: zoneMembers[zone],
  }));
  return { view: 'network', nodes, edges: finalizeEdges(drafts), groups };
}

/** §18.2.4 — identities/secrets/certificates, protection edges, access labels, encryption badges. */
function securityView(model: CanonicalModel): ViewGraph {
  const securityEdges = model.edges.filter(
    (e) => SECURITY_VERBS.has(e.type) || e.attributes['access'] !== undefined,
  );
  const include = new Set<string>();
  for (const id of sortedResourceIds(model)) {
    const resource = model.resources[id];
    if (resource && SECURITY_ALWAYS_KINDS.has(resource.kind)) include.add(id);
  }
  for (const e of securityEdges) {
    if (model.resources[e.source] !== undefined) include.add(e.source);
    if (model.resources[e.target] !== undefined) include.add(e.target);
  }
  const nodes = [...include].sort(compareCodePoints).map((id) => {
    const resource = model.resources[id] as CanonicalResource;
    const node = makeNode(id, resource);
    const badges = encryptionBadges(resource);
    if (badges.length > 0) node.badges = badges;
    return node;
  });
  const drafts: EdgeDraft[] = securityEdges
    .filter((e) => include.has(e.source) && include.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      label: securityEdgeLabel(e),
    }));
  return { view: 'security', nodes, edges: finalizeEdges(drafts) };
}

/** §18.2.5 — one Application's components plus dashed external endpoints of crossing edges. */
function applicationView(model: CanonicalModel, applicationId: string | undefined): ViewGraph {
  if (applicationId === undefined) {
    throw new Error(
      'the application view requires options.application (the Application resource id, ch. 18 §18.2.5)',
    );
  }
  const app = model.resources[applicationId];
  if (!app || app.kind !== 'Application') {
    throw new Error(`"${applicationId}" is not an Application resource in this model`);
  }
  const components = componentIds(model, app);
  const componentSet = new Set(components);
  const externals = new Set<string>();
  const kept: CanonicalEdge[] = [];
  for (const e of model.edges) {
    if (e.type === 'dependsOn') continue; // semantic edges only (§18.2.1 definition)
    const sourceIn = componentSet.has(e.source);
    const targetIn = componentSet.has(e.target);
    if (!sourceIn && !targetIn) continue;
    const external = sourceIn ? e.target : e.source;
    if (!sourceIn || !targetIn) {
      const resource = model.resources[external];
      if (!resource || resource.kind === 'Application') continue;
      externals.add(external);
    }
    kept.push(e);
  }
  const nodes = [...componentSet, ...externals].sort(compareCodePoints).map((id) => {
    const node = makeNode(id, model.resources[id] as CanonicalResource);
    if (componentSet.has(id)) {
      node.group = applicationId;
    } else {
      node.style = 'external'; // dashed, never expanded further (§18.2.5)
    }
    return node;
  });
  const drafts: EdgeDraft[] = kept.map((e) => ({
    source: e.source,
    target: e.target,
    type: e.type,
    label: semanticEdgeLabel(e),
  }));
  return {
    view: 'application',
    nodes,
    edges: finalizeEdges(drafts),
    groups: [{ id: applicationId, label: `${applicationId} (Application)`, members: components }],
  };
}

/** Apply the node filter; edges survive only when both endpoints survive. Zone containers persist. */
function filterView(model: CanonicalModel, graph: ViewGraph, filter: ViewFilter): ViewGraph {
  const keep = new Set<string>();
  for (const node of graph.nodes) {
    if (filter.kinds && !filter.kinds.includes(node.kind)) continue;
    if (filter.labels) {
      const labels = model.resources[node.id]?.labels ?? {};
      let matches = true;
      for (const [key, value] of Object.entries(filter.labels)) {
        if (labels[key] !== value) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
    }
    keep.add(node.id);
  }
  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const edges = graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  const filtered: ViewGraph = { view: graph.view, nodes, edges };
  if (graph.groups) {
    const groups = graph.groups
      .map((g) => ({ ...g, members: g.members.filter((m) => keep.has(m)) }))
      // Exposure zones are always emitted (§18.2.3); other empty containers drop.
      .filter((g) => graph.view === 'network' || g.members.length > 0);
    if (groups.length > 0) filtered.groups = groups;
  }
  return filtered;
}

/* ------------------------------------------------------------------ */
/* Diff (before/after change visualization; Phase 14 drift reuses this) */
/* ------------------------------------------------------------------ */

export type DiffStatus = 'added' | 'removed' | 'changed' | 'unchanged';

function nodeChanged(a: ViewNode, b: ViewNode): boolean {
  return (
    a.kind !== b.kind ||
    a.label !== b.label ||
    a.zone !== b.zone ||
    a.group !== b.group ||
    (a.badges ?? []).join(' ') !== (b.badges ?? []).join(' ') ||
    a.specHash !== b.specHash
  );
}

function edgeChanged(a: ViewEdge, b: ViewEdge): boolean {
  return a.source !== b.source || a.target !== b.target || a.type !== b.type || a.label !== b.label;
}

/**
 * Union diff of two derived views of the same kind: every node and edge is
 * marked `added` (only in `after`), `removed` (only in `before`), `changed`
 * (present in both but semantically different — including invisible spec
 * changes, via `specHash`), or `unchanged` in its `style` field. The result
 * is itself a `ViewGraph`: render it with `toMermaid`/`toDot` to visualize a
 * plan as an architecture change.
 */
export function diffViews(before: ViewGraph, after: ViewGraph): ViewGraph {
  if (before.view !== after.view) {
    throw new Error(`cannot diff a "${before.view}" view against a "${after.view}" view`);
  }
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const nodeIds = [...new Set([...beforeNodes.keys(), ...afterNodes.keys()])].sort(
    compareCodePoints,
  );
  const nodes: ViewNode[] = nodeIds.map((id) => {
    const b = beforeNodes.get(id);
    const a = afterNodes.get(id);
    if (a && b) return { ...a, style: nodeChanged(a, b) ? 'changed' : 'unchanged' };
    if (a) return { ...a, style: 'added' };
    return { ...(b as ViewNode), style: 'removed' };
  });

  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));
  const edgeIds = [...new Set([...beforeEdges.keys(), ...afterEdges.keys()])];
  const edges: ViewEdge[] = edgeIds
    .map((id) => {
      const b = beforeEdges.get(id);
      const a = afterEdges.get(id);
      if (a && b) return { ...a, style: edgeChanged(a, b) ? 'changed' : 'unchanged' };
      if (a) return { ...a, style: 'added' };
      return { ...(b as ViewEdge), style: 'removed' };
    })
    .sort((a, b) => compareEdgeDrafts(a, b) || compareCodePoints(a.id, b.id));

  const groups = unionGroups(before.groups, after.groups);
  const result: ViewGraph = { view: after.view, nodes, edges };
  if (groups.length > 0) result.groups = groups;
  return result;
}

function unionGroups(before: ViewGroup[] | undefined, after: ViewGroup[] | undefined): ViewGroup[] {
  const merged = new Map<string, ViewGroup>();
  for (const group of after ?? []) {
    merged.set(group.id, { ...group, members: [...group.members] });
  }
  for (const group of before ?? []) {
    const existing = merged.get(group.id);
    if (existing) {
      existing.members = [...new Set([...existing.members, ...group.members])].sort(
        compareCodePoints,
      );
    } else {
      merged.set(group.id, { ...group, members: [...group.members] });
    }
  }
  return [...merged.values()];
}

/* ------------------------------------------------------------------ */
/* Mermaid exporter (ch. 18 §18.3)                                     */
/* ------------------------------------------------------------------ */

/** Cosmetic class definitions — stripping them depicts the identical graph (§18.3). */
const MERMAID_CLASS_DEFS: Readonly<Record<string, string>> = {
  added: 'stroke:#1a7f37,stroke-width:2px',
  removed: 'stroke:#cf222e,stroke-dasharray: 4 4',
  changed: 'stroke:#9a6700,stroke-width:2px',
  external: 'stroke-dasharray: 5 5',
};

/** `end` is the one dns-label that collides with Mermaid flowchart syntax. */
function mermaidId(id: string): string {
  return id === 'end' ? 'end_' : id;
}

function mermaidEscape(text: string): string {
  return text.replace(/"/g, '#quot;');
}

function mermaidNodeLine(node: ViewNode): string {
  const badges = (node.badges ?? []).map((b) => ` «${b}»`).join('');
  const cls = node.style && node.style !== 'unchanged' ? `:::${node.style}` : '';
  return `${mermaidId(node.id)}["${mermaidEscape(node.label + badges)}"]${cls}`;
}

function mermaidEdgeLine(edge: ViewEdge): string {
  const marker =
    edge.style && edge.style !== 'unchanged' && edge.style !== 'external'
      ? `[${edge.style}]`
      : undefined;
  const text = [edge.label, marker].filter((p) => p !== undefined).join(' ');
  const source = mermaidId(edge.source);
  const target = mermaidId(edge.target);
  if (edge.style === 'removed') {
    return text === ''
      ? `${source} -.-> ${target}`
      : `${source} -. "${mermaidEscape(text)}" .-> ${target}`;
  }
  return text === ''
    ? `${source} --> ${target}`
    : `${source} -- "${mermaidEscape(text)}" --> ${target}`;
}

/**
 * Render a derived view as Mermaid `flowchart TD` source. Deterministic:
 * byte-identical output for an identical `ViewGraph` (§18.3). Groups become
 * `subgraph` blocks; the network view's zones nest public ⊃ internal ⊃
 * private; diff statuses render as `:::added`-style classes with cosmetic
 * `classDef` lines.
 */
export function toMermaid(graph: ViewGraph): string {
  const lines: string[] = ['flowchart TD'];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const grouped = new Set<string>();
  const groups = graph.groups ?? [];

  if (graph.view === 'network') {
    // Fixed nesting, all three zones always present (§18.2.3).
    EXPOSURE_ZONES.forEach((zone, depth) => {
      const group = groups.find((g) => g.id === `zone-${zone}`);
      const indent = '  '.repeat(depth + 1);
      lines.push(`${indent}subgraph zone-${zone}["zone: ${zone}"]`);
      for (const member of group?.members ?? []) {
        const node = byId.get(member);
        if (node) {
          lines.push(`${indent}  ${mermaidNodeLine(node)}`);
          grouped.add(member);
        }
      }
    });
    for (let depth = EXPOSURE_ZONES.length - 1; depth >= 0; depth -= 1) {
      lines.push(`${'  '.repeat(depth + 1)}end`);
    }
  } else {
    for (const group of groups) {
      lines.push(`  subgraph ${mermaidId(group.id)}["${mermaidEscape(group.label)}"]`);
      for (const member of group.members) {
        const node = byId.get(member);
        if (node) {
          lines.push(`    ${mermaidNodeLine(node)}`);
          grouped.add(member);
        }
      }
      lines.push('  end');
    }
  }
  for (const node of graph.nodes) {
    if (!grouped.has(node.id)) lines.push(`  ${mermaidNodeLine(node)}`);
  }
  for (const edge of graph.edges) {
    lines.push(`  ${mermaidEdgeLine(edge)}`);
  }
  const usedStyles = new Set<string>();
  for (const node of graph.nodes) {
    if (node.style && node.style !== 'unchanged') usedStyles.add(node.style);
  }
  for (const style of Object.keys(MERMAID_CLASS_DEFS)) {
    if (usedStyles.has(style)) {
      lines.push(`  classDef ${style} ${MERMAID_CLASS_DEFS[style]}`);
    }
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* DOT exporter (ch. 18 §18.3)                                         */
/* ------------------------------------------------------------------ */

const DOT_NODE_STYLES: Readonly<Record<string, string>> = {
  added: ', color="#1a7f37", penwidth=2',
  removed: ', color="#cf222e", style=dashed',
  changed: ', color="#9a6700", penwidth=2',
  external: ', style=dashed',
};

function dotQuote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function dotClusterId(id: string): string {
  return `cluster_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function dotNodeLine(node: ViewNode): string {
  const badges = (node.badges ?? []).map((b) => ` «${b}»`).join('');
  const style = node.style && node.style !== 'unchanged' ? (DOT_NODE_STYLES[node.style] ?? '') : '';
  return `${dotQuote(node.id)} [label=${dotQuote(node.label + badges)}${style}];`;
}

function dotEdgeLine(edge: ViewEdge): string {
  const attrs: string[] = [];
  if (edge.label !== undefined) attrs.push(`label=${dotQuote(edge.label)}`);
  if (edge.style === 'added') attrs.push('color="#1a7f37"', 'penwidth=2');
  if (edge.style === 'removed') attrs.push('color="#cf222e"', 'style=dashed');
  if (edge.style === 'changed') attrs.push('color="#9a6700"', 'penwidth=2');
  const suffix = attrs.length > 0 ? ` [${attrs.join(', ')}]` : '';
  return `${dotQuote(edge.source)} -> ${dotQuote(edge.target)}${suffix};`;
}

/**
 * Render a derived view as Graphviz DOT source. Same determinism and
 * containment as `toMermaid`: groups become clusters; the network view's
 * zones nest public ⊃ internal ⊃ private; diff statuses render as cosmetic
 * color/dash attributes.
 */
export function toDot(graph: ViewGraph): string {
  const lines: string[] = [
    `digraph ${dotQuote(graph.view)} {`,
    '  rankdir=TB;',
    '  node [shape=box];',
  ];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const grouped = new Set<string>();
  const groups = graph.groups ?? [];

  if (graph.view === 'network') {
    EXPOSURE_ZONES.forEach((zone, depth) => {
      const group = groups.find((g) => g.id === `zone-${zone}`);
      const indent = '  '.repeat(depth + 1);
      lines.push(`${indent}subgraph ${dotClusterId(`zone-${zone}`)} {`);
      lines.push(`${indent}  label="zone: ${zone}";`);
      for (const member of group?.members ?? []) {
        const node = byId.get(member);
        if (node) {
          lines.push(`${indent}  ${dotNodeLine(node)}`);
          grouped.add(member);
        }
      }
    });
    for (let depth = EXPOSURE_ZONES.length - 1; depth >= 0; depth -= 1) {
      lines.push(`${'  '.repeat(depth + 1)}}`);
    }
  } else {
    for (const group of groups) {
      lines.push(`  subgraph ${dotClusterId(group.id)} {`);
      lines.push(`    label=${dotQuote(group.label)};`);
      for (const member of group.members) {
        const node = byId.get(member);
        if (node) {
          lines.push(`    ${dotNodeLine(node)}`);
          grouped.add(member);
        }
      }
      lines.push('  }');
    }
  }
  for (const node of graph.nodes) {
    if (!grouped.has(node.id)) lines.push(`  ${dotNodeLine(node)}`);
  }
  for (const edge of graph.edges) {
    lines.push(`  ${dotEdgeLine(edge)}`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}
