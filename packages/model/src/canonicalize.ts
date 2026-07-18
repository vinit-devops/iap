/**
 * Canonicalization engine for IaP v1 documents (ch. 1 §1.5, C1–C6):
 *
 * - C2 profile merge — RFC 7386 JSON Merge Patch, `extends` chain root-first,
 *   `profiles` key removed post-merge (ch. 6).
 * - C3 relationship flattening — the six-step deterministic normalization of
 *   ch. 4 §4.7 producing canonical `(source, type, target, attributes)` edges.
 * - C4 value normalization — schema-driven default materialization
 *   (ch. 1 §1.5.1, seven rules) then exact-rational quantity/duration
 *   canonical spelling (ch. 1 §1.5.2).
 * - C5 key ordering — lexicographic by Unicode code point, edges sorted by
 *   (source, verb enum order, target, serialized attributes).
 * - C6 serialization — compact UTF-8 JSON, SHA-256 content hash.
 *
 * C1 (YAML parsing with source spans) belongs to `@iap/parser`; this module
 * accepts an already-parsed document or JSON text. Reference-shape validation
 * (IAP201/IAP301/IAP302, §4.7 step 4) is the validator's concern (M2.4):
 * canonicalization operates on valid documents and carries edges through.
 */

import { createHash } from 'node:crypto';
import { API_VERSION, RELATIONSHIP_TYPES, iisDocumentSchema, isSpecifiedKind } from './index.js';
import type { Finding, IaPDocument, Kind, Profile, RelationshipType } from './index.js';
import { canonicalDuration, canonicalQuantity } from './quantity.js';
import type { CanonicalUnitResult } from './quantity.js';
import type { CanonicalEdge, CanonicalModel, CanonicalResource, ProvenanceMap } from './cim.js';

type JsonObject = Record<string, unknown>;

const QUANTITY_REF = '#/$defs/common/quantity';
const DURATION_REF = '#/$defs/common/duration';

/** Edge attributes carried by inline edges (ch. 4 §4.4). */
const INLINE_EDGE_ATTRIBUTES = ['port', 'protocol', 'access', 'path', 'host'] as const;
/** Rule edges carry port/protocol/access but never path/host (ch. 4 §4.5.2). */
const RULE_EDGE_ATTRIBUTES = ['port', 'protocol', 'access'] as const;
/** Verbs whose `access` attribute defaults to read-write (ch. 4 §4.4). */
const ACCESS_DEFAULT_VERBS: ReadonlySet<string> = new Set(['connectsTo', 'storesDataIn']);

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Escape one RFC 6901 reference token. */
function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Compare strings by Unicode code point (canonical key order, C5). */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

/** Recursively sort all object keys lexicographically by Unicode code point (C5). */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort(compareCodePoints)) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/** Compact, key-sorted JSON serialization (C5 + C6, no insignificant whitespace). */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** SHA-256 hex digest of a UTF-8 string (no BOM). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeFinding(code: string, path: string, message: string): Finding {
  return { code, severity: 'error', path, message };
}

/* ------------------------------------------------------------------ */
/* C2 — profile merge (ch. 6)                                          */
/* ------------------------------------------------------------------ */

/**
 * RFC 7386 JSON Merge Patch: objects deep-merge, arrays replace wholesale,
 * `null` deletes. Pure; neither argument is mutated.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  return mergePatchTracked(target, patch, '', null);
}

type SetHook = (pointer: string, value: unknown) => void;

function mergePatchTracked(
  target: unknown,
  patch: unknown,
  pointer: string,
  onSet: SetHook | null,
): unknown {
  if (!isPlainObject(patch)) {
    const replacement = structuredClone(patch);
    if (onSet) recordSubtree(replacement, pointer, onSet);
    return replacement;
  }
  const result: JsonObject = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    const childPointer = `${pointer}/${escapePointer(key)}`;
    if (value === null) {
      delete result[key];
    } else {
      result[key] = mergePatchTracked(result[key], value, childPointer, onSet);
    }
  }
  return result;
}

/** Record a replaced value and every node beneath it (provenance tracking). */
function recordSubtree(value: unknown, pointer: string, onSet: SetHook): void {
  onSet(pointer, value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => recordSubtree(item, `${pointer}/${index}`, onSet));
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      recordSubtree(item, `${pointer}/${escapePointer(key)}`, onSet);
    }
  }
}

export interface MergeProfileOptions {
  /** Record `source: 'profile'` provenance for every field a profile sets. */
  trackProvenance?: boolean;
}

export interface MergeProfileResult {
  merged: IaPDocument;
  findings: Finding[];
  /** Populated only when `trackProvenance` is set. */
  provenance: ProvenanceMap;
}

/**
 * Apply the active profile per ch. 6: base document, then the `overrides` of
 * each profile in the `extends` chain root-first, then the selected profile.
 * The `profiles` key is removed from the result (C2). Unknown profiles and
 * `extends` cycles abort the merge with IAP205.
 */
export function mergeProfile(
  doc: IaPDocument,
  profileName: string | null,
  options: MergeProfileOptions = {},
): MergeProfileResult {
  const findings: Finding[] = [];
  const provenance: ProvenanceMap = {};
  const profiles: Record<string, Profile> = isPlainObject(doc.profiles)
    ? (doc.profiles as Record<string, Profile>)
    : {};

  const base = structuredClone(doc) as unknown as JsonObject;
  delete base.profiles;

  if (profileName === null) {
    return { merged: base as unknown as IaPDocument, findings, provenance };
  }

  // Resolve the extends chain, selected profile last (root first after unshift).
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = profileName;
  let referrer: string | null = null;
  while (current !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(profiles, current)) {
      const path = referrer === null ? '/profiles' : `/profiles/${escapePointer(referrer)}/extends`;
      findings.push(
        makeFinding(
          'IAP205',
          path,
          `unknown profile "${current}" — the merge is aborted (ch. 6 §6.5)`,
        ),
      );
      return { merged: base as unknown as IaPDocument, findings, provenance };
    }
    if (seen.has(current)) {
      findings.push(
        makeFinding(
          'IAP205',
          `/profiles/${escapePointer(current)}/extends`,
          `profile extends cycle involving "${current}" — the merge is aborted (ch. 6 §6.5)`,
        ),
      );
      return { merged: base as unknown as IaPDocument, findings, provenance };
    }
    seen.add(current);
    chain.unshift(current);
    referrer = current;
    current = profiles[current]?.extends;
  }

  let merged: unknown = base;
  for (const name of chain) {
    const overrides = isPlainObject(profiles[name]?.overrides)
      ? { ...(profiles[name]?.overrides as JsonObject) }
      : {};
    if ('profiles' in overrides) {
      findings.push(
        makeFinding(
          'IAP205',
          `/profiles/${escapePointer(name)}/overrides/profiles`,
          `profile "${name}" overrides must not contain the "profiles" key (ch. 6 §6.4); it is ignored`,
        ),
      );
      delete overrides.profiles;
    }
    const onSet: SetHook | null = options.trackProvenance
      ? (pointer) => {
          provenance[pointer] = {
            source: 'profile',
            originId: name,
            explanation: `set by profile "${name}" via RFC 7386 merge (ch. 6)`,
          };
        }
      : null;
    merged = mergePatchTracked(merged, overrides, '', onSet);
  }

  const mergedObject = merged as JsonObject;
  delete mergedObject.profiles; // defensive: overrides cannot reintroduce it
  return { merged: mergedObject as unknown as IaPDocument, findings, provenance };
}

/* ------------------------------------------------------------------ */
/* Schema access — $defs walking with $ref resolution                  */
/* ------------------------------------------------------------------ */

let cachedSchemaRoot: JsonObject | undefined;

function schemaRoot(): JsonObject {
  cachedSchemaRoot ??= iisDocumentSchema() as JsonObject;
  return cachedSchemaRoot;
}

function resolveSchemaPointer(ref: string): JsonObject | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = schemaRoot();
  for (const raw of ref.slice(2).split('/')) {
    if (!isPlainObject(node)) return undefined;
    node = node[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return isPlainObject(node) ? node : undefined;
}

interface ResolvedSchema {
  /** The schema with `$ref` chains resolved; `$ref` siblings win over referenced keys. */
  node: JsonObject;
  /** Every `$ref` string followed (used to detect quantity/duration typing). */
  refs: string[];
}

function derefSchema(schema: JsonObject): ResolvedSchema {
  let node = schema;
  const refs: string[] = [];
  for (let depth = 0; depth < 16 && typeof node.$ref === 'string'; depth += 1) {
    const ref = node.$ref;
    refs.push(ref);
    const target = resolveSchemaPointer(ref);
    if (!target) break;
    const siblings = { ...node };
    delete siblings.$ref;
    node = { ...target, ...siblings };
  }
  return { node, refs };
}

/* ------------------------------------------------------------------ */
/* C4 — default materialization (§1.5.1) and unit normalization (§1.5.2) */
/* ------------------------------------------------------------------ */

interface WalkContext {
  materialize: boolean;
  normalize: boolean;
  provenance: ProvenanceMap;
  findings: Finding[];
}

/**
 * Walk a present object against its schema. In materialize mode, applies the
 * seven §1.5.1 rules; in normalize mode, rewrites quantity/duration spellings
 * for fields whose resolved subschema $refs `common/quantity`/`common/duration`
 * (never by blind pattern-matching of values). `x-*` keys and `extensions`
 * are never declared `properties`, so they pass through untouched (rule 7).
 */
function walkWithSchema(
  value: JsonObject,
  schema: JsonObject,
  pointer: string,
  ctx: WalkContext,
): void {
  const { node } = derefSchema(schema);
  const props = isPlainObject(node.properties) ? node.properties : undefined;
  if (!props) return;
  for (const [key, rawProp] of Object.entries(props)) {
    if (!isPlainObject(rawProp)) continue;
    const childPointer = `${pointer}/${escapePointer(key)}`;
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      visitPresent(value, key, rawProp, childPointer, ctx);
    } else if (ctx.materialize) {
      visitAbsent(value, key, rawProp, props, childPointer, ctx);
    }
  }
}

function visitPresent(
  parent: JsonObject,
  key: string,
  rawProp: JsonObject,
  pointer: string,
  ctx: WalkContext,
): void {
  const { node: prop, refs } = derefSchema(rawProp);
  const value = parent[key];

  if (typeof value === 'string' && ctx.normalize) {
    if (refs.includes(QUANTITY_REF)) {
      applyUnitSpelling(parent, key, pointer, ctx, canonicalQuantity);
      return;
    }
    if (refs.includes(DURATION_REF)) {
      applyUnitSpelling(parent, key, pointer, ctx, canonicalDuration);
      return;
    }
  }

  if (isPlainObject(value)) {
    walkWithSchema(value, rawProp, pointer, ctx);
    return;
  }

  if (Array.isArray(value) && isPlainObject(prop.items)) {
    // Rule 3: arrays are never created; present items are walked so their
    // members gain defaults (rule 1) and unit spellings. No v1 array carries
    // quantity/duration items directly.
    const itemSchema = prop.items;
    value.forEach((item, index) => {
      if (isPlainObject(item)) {
        walkWithSchema(item, itemSchema, `${pointer}/${index}`, ctx);
      }
    });
  }
}

function visitAbsent(
  parent: JsonObject,
  key: string,
  rawProp: JsonObject,
  parentProps: JsonObject,
  pointer: string,
  ctx: WalkContext,
): void {
  const { node: prop } = derefSchema(rawProp);

  if ('default' in prop) {
    // Rule 1 (scalar defaults) and rule 5 (conditional defaults).
    const conditional = isPlainObject(prop['x-iap-default-when']);
    if (!defaultConditionHolds(prop, parent, parentProps)) return;
    parent[key] = structuredClone(prop.default);
    ctx.provenance[pointer] = {
      source: 'default',
      originId: `default:${pointer}`,
      explanation: conditional
        ? 'conditional specification default; its x-iap-default-when condition holds (ch. 1 §1.5.1 rule 5)'
        : 'specification default materialized (ch. 1 §1.5.1 rule 1)',
    };
    return;
  }

  // Rule 4: presence-semantic constructs are never synthesized.
  if (prop['x-iap-presence-semantic'] === true) return;
  // Rule 3: arrays are never materialized.
  if (prop.type === 'array') return;

  const isObjectSchema = prop.type === 'object' || isPlainObject(prop.properties);
  if (!isObjectSchema) return;

  // Rule 2: an absent optional object with at least one defaulted member
  // materializes as exactly its defaulted members, recursively.
  const candidate: JsonObject = {};
  walkWithSchema(candidate, rawProp, pointer, ctx);
  if (Object.keys(candidate).length > 0) {
    parent[key] = candidate;
    ctx.provenance[pointer] = {
      source: 'default',
      originId: `default:${pointer}`,
      explanation: 'object materialized with its defaulted members (ch. 1 §1.5.1 rule 2)',
    };
  }
}

/** Evaluate an `x-iap-default-when` condition against effective sibling values. */
function defaultConditionHolds(
  prop: JsonObject,
  parent: JsonObject,
  parentProps: JsonObject,
): boolean {
  const condition = prop['x-iap-default-when'];
  if (!isPlainObject(condition)) return true;
  for (const [siblingKey, expected] of Object.entries(condition)) {
    let actual: unknown = parent[siblingKey];
    if (actual === undefined) {
      const siblingSchema = parentProps[siblingKey];
      if (isPlainObject(siblingSchema)) actual = derefSchema(siblingSchema).node.default;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function applyUnitSpelling(
  parent: JsonObject,
  key: string,
  pointer: string,
  ctx: WalkContext,
  toCanonical: (input: string) => CanonicalUnitResult,
): void {
  const result = toCanonical(parent[key] as string);
  if (result.ok) {
    parent[key] = result.value;
  } else {
    ctx.findings.push(makeFinding('IAP103', pointer, result.reason));
  }
}

/** Walk every resource's spec against its `$defs/kinds/<Kind>` subschema. */
function walkResourceSpecs(doc: JsonObject, ctx: WalkContext): void {
  const resources = doc.resources;
  if (!isPlainObject(resources)) return;
  for (const id of Object.keys(resources)) {
    const entry = resources[id];
    if (!isPlainObject(entry)) continue;
    const kind = typeof entry.kind === 'string' ? entry.kind : '';
    // Reserved kinds resolve to the intentionally minimal ReservedKind
    // subschema, which declares no defaults. Fully specified kinds — core
    // (1.0.0) and graduated (1.1.0, IEP-0015) — resolve to their own
    // $defs/kinds definitions.
    const kindDef = isSpecifiedKind(kind) ? kind : 'ReservedKind';
    const specSchema: JsonObject = { $ref: `#/$defs/kinds/${kindDef}` };
    const specPointer = `/resources/${escapePointer(id)}/spec`;
    if (ctx.materialize && !isPlainObject(entry.spec)) {
      // Rule 1: an absent spec counts as a present empty object (a Queue with
      // no spec canonicalizes to all Queue defaults).
      entry.spec = {};
      ctx.provenance[specPointer] = {
        source: 'default',
        originId: `default:${specPointer}`,
        explanation: 'absent spec counts as a present empty object (ch. 1 §1.5.1 rule 1)',
      };
    }
    if (isPlainObject(entry.spec)) {
      walkWithSchema(entry.spec, specSchema, specPointer, ctx);
    }
  }
}

export interface MaterializeDefaultsResult {
  materialized: IaPDocument;
  /** `source: 'default'` records for every materialized pointer. */
  provenance: ProvenanceMap;
}

/**
 * Materialize specification defaults per ch. 1 §1.5.1 by walking the embedded
 * normative schema (`$defs/kinds/<Kind>` per resource, `$ref`s resolved into
 * the common `$defs`). Pure; the input document is not mutated.
 */
export function materializeDefaults(doc: IaPDocument): MaterializeDefaultsResult {
  const materialized = structuredClone(doc) as unknown as JsonObject;
  const ctx: WalkContext = { materialize: true, normalize: false, provenance: {}, findings: [] };
  walkResourceSpecs(materialized, ctx);
  return { materialized: materialized as unknown as IaPDocument, provenance: ctx.provenance };
}

export interface NormalizeUnitsResult {
  normalized: IaPDocument;
  /** IAP103 findings for values that violate the quantity/duration grammar. */
  findings: Finding[];
}

/**
 * Rewrite every quantity and duration to its canonical spelling (ch. 1
 * §1.5.2). Only fields whose resolved subschema `$ref`s `common/quantity` or
 * `common/duration` are touched — never look-alike strings such as image
 * references or configuration values. Pure; the input is not mutated.
 */
export function normalizeUnits(doc: IaPDocument): NormalizeUnitsResult {
  const normalized = structuredClone(doc) as unknown as JsonObject;
  const ctx: WalkContext = { materialize: false, normalize: true, provenance: {}, findings: [] };
  walkResourceSpecs(normalized, ctx);
  return { normalized: normalized as unknown as IaPDocument, findings: ctx.findings };
}

/* ------------------------------------------------------------------ */
/* C3 — relationship flattening (ch. 4 §4.7)                           */
/* ------------------------------------------------------------------ */

function verbOrder(type: string): number {
  const index = (RELATIONSHIP_TYPES as readonly string[]).indexOf(type);
  return index === -1 ? RELATIONSHIP_TYPES.length : index;
}

function selectorMatches(entry: JsonObject, selector: JsonObject): boolean {
  const kinds = selector.kinds;
  if (Array.isArray(kinds) && !kinds.includes(entry.kind)) return false;
  const wanted = isPlainObject(selector.labels) ? selector.labels : {};
  const actual = isPlainObject(entry.labels) ? entry.labels : {};
  for (const [key, value] of Object.entries(wanted)) {
    if (actual[key] !== value) return false;
  }
  return true;
}

interface EdgeCandidate {
  edge: CanonicalEdge;
  /** Inline declarations donate non-semantic fields on dedupe (§4.7 step 5). */
  inline: boolean;
  defaultedAttributes: string[];
}

function edgeFromDeclaration(
  source: string,
  declaration: JsonObject,
  allowedAttributes: readonly string[],
  inline: boolean,
): EdgeCandidate {
  const attributes: Record<string, string | number> = {};
  for (const attribute of allowedAttributes) {
    const value = declaration[attribute];
    if (typeof value === 'string' || typeof value === 'number') {
      attributes[attribute] = value;
    }
  }
  const edge: CanonicalEdge = {
    source,
    type: declaration.type as RelationshipType,
    target: String(declaration.target),
    attributes,
  };
  if (typeof declaration.description === 'string') edge.description = declaration.description;
  for (const [key, value] of Object.entries(declaration)) {
    if (key.startsWith('x-')) (edge as unknown as JsonObject)[key] = structuredClone(value);
  }
  return { edge, inline, defaultedAttributes: [] };
}

export interface FlattenEdgesResult {
  /** The normalized graph: §4.7 step 6 output. */
  edges: CanonicalEdge[];
  /** IAP402 findings (rule-edge selector matched zero resources). */
  findings: Finding[];
  /** Edge attributes materialized from schema defaults, for provenance. */
  defaultedAttributes: Array<{ edgeIndex: number; attribute: string }>;
}

/**
 * Six-step deterministic edge normalization (ch. 4 §4.7) over the
 * profile-merged document: expand rule edges in document order (matches
 * sorted lexicographically), collect inline edges in lexicographic resource
 * order, materialize the `access` default on connectsTo/storesDataIn edges,
 * dedupe on `(source, type, target, attributes)` ignoring `description` and
 * `x-*`, and stable-sort by (source, verb enum order, target, serialized
 * attributes). Reference validation (step 4) is deferred to the validator;
 * dangling targets are carried through. A pre-flattened `edges` array (a
 * canonical document fed back in) is accepted and re-normalized, which makes
 * canonicalization idempotent.
 */
export function flattenEdges(doc: IaPDocument): FlattenEdgesResult {
  const docObject = doc as unknown as JsonObject;
  const resources = isPlainObject(docObject.resources) ? docObject.resources : {};
  const findings: Finding[] = [];
  const candidates: EdgeCandidate[] = [];

  // Step 2 — expand rule edges in document order, matches sorted lexicographically.
  const rules = Array.isArray(docObject.relationships) ? docObject.relationships : [];
  rules.forEach((rule, index) => {
    if (!isPlainObject(rule)) return;
    const ruleSource = isPlainObject(rule.source) ? rule.source : {};
    const selector = isPlainObject(ruleSource.selector) ? ruleSource.selector : {};
    const matches = Object.keys(resources)
      .filter((id) => isPlainObject(resources[id]) && selectorMatches(resources[id], selector))
      .sort(compareCodePoints);
    if (matches.length === 0) {
      findings.push(
        makeFinding(
          'IAP402',
          `/relationships/${index}`,
          'rule-edge selector matches zero resources (ch. 4 §4.7 step 2)',
        ),
      );
      return;
    }
    for (const id of matches) {
      candidates.push(edgeFromDeclaration(id, rule, RULE_EDGE_ATTRIBUTES, false));
    }
  });

  // Step 3 — collect inline edges in lexicographic resource-identifier order.
  for (const id of Object.keys(resources).sort(compareCodePoints)) {
    const entry = resources[id];
    if (!isPlainObject(entry) || !Array.isArray(entry.relationships)) continue;
    for (const declaration of entry.relationships) {
      if (!isPlainObject(declaration)) continue;
      candidates.push(edgeFromDeclaration(id, declaration, INLINE_EDGE_ATTRIBUTES, true));
    }
  }

  // Pre-flattened canonical edges pass through (idempotence).
  if (Array.isArray(docObject.edges)) {
    for (const edge of docObject.edges) {
      if (!isPlainObject(edge)) continue;
      const passthrough = structuredClone(edge) as unknown as CanonicalEdge;
      if (!isPlainObject(passthrough.attributes)) passthrough.attributes = {};
      candidates.push({ edge: passthrough, inline: true, defaultedAttributes: [] });
    }
  }

  // `access` defaults to read-write on the verbs it is valid for (ch. 4 §4.4;
  // schema default on relationshipEdge/ruleEdge), so the explicit and omitted
  // spellings converge (ch. 1 §1.5.1 rule 1).
  for (const candidate of candidates) {
    if (
      ACCESS_DEFAULT_VERBS.has(candidate.edge.type) &&
      candidate.edge.attributes.access === undefined
    ) {
      candidate.edge.attributes.access = 'read-write';
      candidate.defaultedAttributes.push('access');
    }
  }

  // Step 5 — dedupe on (source, type, target, key-sorted attributes),
  // ignoring description and x-*. Inline declarations donate non-semantic
  // fields; otherwise the earliest rule edge in document order does.
  const byIdentity = new Map<string, EdgeCandidate>();
  for (const candidate of candidates) {
    const identity = [
      candidate.edge.source,
      candidate.edge.type,
      candidate.edge.target,
      canonicalJsonStringify(candidate.edge.attributes),
    ].join(' ');
    const existing = byIdentity.get(identity);
    if (!existing || (candidate.inline && !existing.inline)) {
      byIdentity.set(identity, candidate);
    }
  }

  // Step 6 — stable sort by source, verb enum order, target, serialized attributes.
  const retained = [...byIdentity.values()].sort(
    (a, b) =>
      compareCodePoints(a.edge.source, b.edge.source) ||
      verbOrder(a.edge.type) - verbOrder(b.edge.type) ||
      compareCodePoints(a.edge.target, b.edge.target) ||
      compareCodePoints(
        canonicalJsonStringify(a.edge.attributes),
        canonicalJsonStringify(b.edge.attributes),
      ),
  );

  const defaultedAttributes: Array<{ edgeIndex: number; attribute: string }> = [];
  retained.forEach((candidate, edgeIndex) => {
    for (const attribute of candidate.defaultedAttributes) {
      defaultedAttributes.push({ edgeIndex, attribute });
    }
  });

  return { edges: retained.map((candidate) => candidate.edge), findings, defaultedAttributes };
}

/* ------------------------------------------------------------------ */
/* C1–C6 — full canonicalization                                       */
/* ------------------------------------------------------------------ */

export interface CanonicalizeOptions {
  /** The active profile the canonical form is relative to (`null` = base document). */
  profile?: string | null;
}

export interface CanonicalizeResult {
  model: CanonicalModel;
  /** The canonical byte projection (C5+C6): compact, key-sorted UTF-8 JSON. */
  canonicalJson: string;
  /** SHA-256 hex of `canonicalJson`. */
  hash: string;
  findings: Finding[];
}

/**
 * Produce the canonical form and CIM of a document relative to one active
 * profile (ch. 1 §1.5, IEP-0008). Accepts a parsed document or JSON text
 * (YAML parsing is `@iap/parser`'s concern). The canonical JSON replaces all
 * relationship spellings with the top-level `edges` array (C3) and never
 * contains the `profiles` key (C2); `x-*` keys are data and are retained
 * (C1). Findings never affect the hash.
 */
export function canonicalize(
  input: string | IaPDocument,
  options: CanonicalizeOptions = {},
): CanonicalizeResult {
  const profile = options.profile ?? null;
  const findings: Finding[] = [];
  const parsed = typeof input === 'string' ? (JSON.parse(input) as IaPDocument) : input;

  // C2 — profile merge.
  const merge = mergeProfile(parsed, profile, { trackProvenance: true });
  findings.push(...merge.findings);

  // C3 — relationship flattening against the merged document.
  const flatten = flattenEdges(merge.merged);
  findings.push(...flatten.findings);
  const working = merge.merged as unknown as JsonObject;
  delete working.relationships;
  delete working.edges;
  if (isPlainObject(working.resources)) {
    for (const entry of Object.values(working.resources)) {
      if (isPlainObject(entry)) delete entry.relationships;
    }
  }

  // C4 — default materialization, then quantity/duration normalization.
  const materialized = materializeDefaults(working as unknown as IaPDocument);
  const normalized = normalizeUnits(materialized.materialized);
  findings.push(...normalized.findings);

  const canonicalDoc = normalized.normalized as unknown as JsonObject;
  canonicalDoc.edges = flatten.edges;

  // C5 + C6 — key ordering, compact serialization, content hash.
  const canonicalJson = canonicalJsonStringify(canonicalDoc);
  const hash = sha256Hex(canonicalJson);

  const provenance = assembleProvenance(
    canonicalDoc,
    materialized.provenance,
    merge.provenance,
    flatten.defaultedAttributes,
  );
  const model = buildModel(canonicalDoc, flatten.edges, profile, hash, provenance, findings);
  return { model, canonicalJson, hash, findings };
}

/** Collect every leaf pointer (scalars, empty objects, empty arrays) of the canonical doc. */
function collectLeafPointers(value: unknown, pointer: string, out: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) out.push(pointer);
    value.forEach((item, index) => collectLeafPointers(item, `${pointer}/${index}`, out));
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) out.push(pointer);
    for (const key of keys) {
      collectLeafPointers(value[key], `${pointer}/${escapePointer(key)}`, out);
    }
  } else {
    out.push(pointer);
  }
}

/**
 * Total provenance (IEP-0008 I4): every leaf of the canonical document gets
 * exactly one record — `default` and `profile` where tracked, `explicit`
 * otherwise. Pointers into flattened-away `relationships` arrays do not
 * survive C3; the corresponding canonical `edges` fields read as explicit.
 */
function assembleProvenance(
  canonicalDoc: JsonObject,
  defaults: ProvenanceMap,
  profileProvenance: ProvenanceMap,
  defaultedEdgeAttributes: Array<{ edgeIndex: number; attribute: string }>,
): ProvenanceMap {
  const leaves: string[] = [];
  collectLeafPointers(canonicalDoc, '', leaves);
  const assembled: ProvenanceMap = {};
  for (const pointer of leaves) {
    assembled[pointer] = profileProvenance[pointer] ?? {
      source: 'explicit',
      originId: 'document',
      explanation: 'authored in the document',
    };
  }
  for (const [pointer, record] of Object.entries(defaults)) {
    assembled[pointer] = record;
  }
  for (const { edgeIndex, attribute } of defaultedEdgeAttributes) {
    assembled[`/edges/${edgeIndex}/attributes/${escapePointer(attribute)}`] = {
      source: 'default',
      originId: `default:/edges/${edgeIndex}/attributes/${attribute}`,
      explanation: 'access defaults to read-write on connectsTo/storesDataIn edges (ch. 4 §4.4)',
    };
  }
  const sorted: ProvenanceMap = {};
  for (const pointer of Object.keys(assembled).sort(compareCodePoints)) {
    sorted[pointer] = assembled[pointer] as ProvenanceMap[string];
  }
  return sorted;
}

function buildModel(
  canonicalDoc: JsonObject,
  edges: CanonicalEdge[],
  profile: string | null,
  hash: string,
  provenance: ProvenanceMap,
  findings: Finding[],
): CanonicalModel {
  const resources: Record<string, CanonicalResource> = {};
  if (isPlainObject(canonicalDoc.resources)) {
    for (const [id, entry] of Object.entries(canonicalDoc.resources)) {
      if (!isPlainObject(entry)) continue;
      const resource: CanonicalResource = {
        kind: entry.kind as Kind,
        labels: isPlainObject(entry.labels) ? (entry.labels as Record<string, string>) : {},
        spec: isPlainObject(entry.spec) ? entry.spec : {},
        extensions: isPlainObject(entry.extensions)
          ? (entry.extensions as CanonicalResource['extensions'])
          : {},
      };
      if (typeof entry.description === 'string') resource.description = entry.description;
      for (const [key, value] of Object.entries(entry)) {
        if (key.startsWith('x-')) (resource as unknown as JsonObject)[key] = value;
      }
      resources[id] = resource;
    }
  }

  const model: CanonicalModel = {
    apiVersion: API_VERSION,
    metadata: canonicalDoc.metadata as CanonicalModel['metadata'],
    resources,
    edges,
    policies: Array.isArray(canonicalDoc.policies)
      ? (canonicalDoc.policies as CanonicalModel['policies'])
      : [],
    profile,
    hash,
    provenance,
    diagnostics: findings,
  };
  if (isPlainObject(canonicalDoc.compliance)) {
    model.compliance = canonicalDoc.compliance as NonNullable<CanonicalModel['compliance']>;
  }
  if (isPlainObject(canonicalDoc.extensions)) {
    model.extensions = canonicalDoc.extensions as NonNullable<CanonicalModel['extensions']>;
  }
  if (isPlainObject(canonicalDoc.outputs)) {
    model.outputs = canonicalDoc.outputs as NonNullable<CanonicalModel['outputs']>;
  }
  return model;
}
