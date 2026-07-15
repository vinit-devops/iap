/**
 * @iap/language-server — the pure provider core (spec ch. 23).
 *
 * Every capability is a pure async function over `(text, position)` with NO
 * LSP types in its signature — the thin protocol binding lives in
 * `./server.js`, so everything here is unit-testable without a connection.
 *
 * Per ch. 23 §23.1 the server obeys one rule: **every feature derives from
 * schema annotations plus SDK engines — no bespoke logic**. Concretely:
 *
 * - diagnostics = `@iap/sdk` `validate()` (ch. 8 phases 1–4) plus the
 *   document's own policies (`policies()`, phase 5), positioned through the
 *   parser's per-node source map (nearest-ancestor fallback; whole-document
 *   range when a path resolves nowhere);
 * - completion and hover = the normative JSON Schema, walked to the cursor's
 *   JSON Pointer through `$ref` chains and the per-kind `if/then` dispatch
 *   (`resolveSchemaAt`), reading `enum`, `description`, `default`, and the
 *   `x-iap-*` annotation vocabulary;
 * - navigation, references, and rename = resource-identifier scopes derived
 *   from the document (never regex over raw text: every site is a source-map
 *   pointer whose value token is located inside the mapped range);
 * - code actions = deterministic SDK artifacts only — `require`-policy
 *   autofix merge patches and schema-derived missing-required-field inserts;
 * - the architecture preview = `canonical()` → `deriveView` → `toMermaid`.
 *
 * Caching model (ch. 23 §23.4): a single-entry analysis cache keyed on the
 * exact document text memoizes the SDK workspace (whose own methods are
 * memoized), so the debounced diagnostics pass and every subsequent
 * completion/hover/navigation request against the same document version
 * share one parse + validation + canonicalization.
 *
 * Known v1 limitation (documented, accepted): policy-autofix code actions
 * re-serialize the whole document via the SDK round-trip serializer, which
 * preserves authored key order but LOSES COMMENTS. Formatting-preserving
 * edits are deferred alongside multi-document workspace support.
 */

import { KINDS, RESOURCE_ID_PATTERN, isReservedKind, iisDocumentSchema } from '@iap/model';
import type { Finding, IaPDocument, JsonSchema, ResourceEntry } from '@iap/model';
import { buildSourceMap, escapePointerSegment } from '@iap/parser';
import type { SourceMap, SourcePosition, SourceRange } from '@iap/parser';
import { deriveView, toMermaid } from '@iap/architecture';
import type { ViewName } from '@iap/architecture';
import type { PolicyAutofix } from '@iap/policy';
import { load } from '@iap/sdk';
import type { IaPWorkspaceResult } from '@iap/sdk';

/* ------------------------------------------------------------------ */
/* Protocol-neutral result types (0-based, like LSP, but local)        */
/* ------------------------------------------------------------------ */

/** A 0-based text position (LSP-compatible shape, defined locally). */
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  range: Range;
  severity: 'error' | 'warning';
  code: string;
  message: string;
  source: 'iap';
}

export type CompletionItemKind = 'value' | 'property' | 'reference';

export interface CompletionItem {
  label: string;
  kind: CompletionItemKind;
  /** Type/default summary (property items) or a short badge (value items). */
  detail?: string;
  /** Markdown documentation from the schema `description`. */
  documentation?: string;
  /** Required-first ordering hint (ch. 23 §23.2.1). */
  sortText?: string;
}

export interface Hover {
  /** Markdown. */
  contents: string;
  range?: Range;
}

export interface DocumentLocation {
  range: Range;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export type RenameResult = { edits: TextEdit[] } | { error: string };

export type SymbolKind = 'group' | 'resource' | 'profile' | 'policy' | 'output';

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface CodeAction {
  title: string;
  kind: 'quickfix';
  edits: TextEdit[];
}

export interface PreviewResult {
  mermaid: string;
}

/* ------------------------------------------------------------------ */
/* Analysis cache (memoized SDK result per document version)           */
/* ------------------------------------------------------------------ */

interface Analysis {
  text: string;
  lineStarts: number[];
  workspace: IaPWorkspaceResult;
  document: IaPDocument | undefined;
  sourceMap: SourceMap;
}

let cached: Analysis | undefined;

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * Parse + validate once per distinct text (the server calls providers many
 * times against one document version; they all share this analysis). The SDK
 * workspace memoizes `validate`/`canonical`/`policies` internally, so phases
 * never re-run within a version.
 */
async function analyze(text: string): Promise<Analysis> {
  if (cached?.text === text) return cached;
  const workspace = await load(text, { sourceMap: true });
  // Mid-edit documents that fail parsing still get a best-effort source map
  // over whatever was parseable (partial results, ch. 21 §21.1.3).
  const sourceMap = workspace.sourceMap ?? buildSourceMap(text).map;
  cached = {
    text,
    lineStarts: computeLineStarts(text),
    workspace,
    document: workspace.document,
    sourceMap,
  };
  return cached;
}

/* ------------------------------------------------------------------ */
/* Position / pointer arithmetic                                       */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function offsetAt(a: Analysis, position: Position): number {
  const lineStart = a.lineStarts[Math.min(position.line, a.lineStarts.length - 1)] ?? 0;
  const nextStart = a.lineStarts[position.line + 1] ?? a.text.length + 1;
  return Math.min(lineStart + Math.max(position.character, 0), nextStart - 1, a.text.length);
}

function positionAtOffset(a: Analysis, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, a.text.length));
  let low = 0;
  let high = a.lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((a.lineStarts[mid] as number) <= clamped) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: clamped - (a.lineStarts[low] as number) };
}

function toPosition(p: SourcePosition): Position {
  return { line: p.line - 1, character: p.col - 1 };
}

function toRange(r: SourceRange): Range {
  return { start: toPosition(r.start), end: toPosition(r.end) };
}

function fullDocumentRange(a: Analysis): Range {
  return { start: { line: 0, character: 0 }, end: positionAtOffset(a, a.text.length) };
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function pointerTokens(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  return pointer.replace(/^\//, '').split('/').map(unescapePointerToken);
}

function parentPointer(pointer: string): string {
  const index = pointer.lastIndexOf('/');
  return index <= 0 ? '' : pointer.slice(0, index);
}

/** Normalize a finding path: validator paths are JSON Pointers; policy paths are dot paths. */
function findingPointer(path: string): string {
  if (path === '' || path === '/') return '';
  if (path.startsWith('/')) return path;
  return '/' + path.split('.').map(escapePointerSegment).join('/');
}

/** Exact pointer, else nearest recorded ancestor, else the whole document (ch. 23 §23.2.3). */
function rangeForPath(a: Analysis, path: string): Range {
  let pointer = findingPointer(path);
  for (;;) {
    const range = a.sourceMap.get(pointer);
    if (range !== undefined) return toRange(range);
    if (pointer === '') return fullDocumentRange(a);
    pointer = parentPointer(pointer);
  }
}

/** The tightest recorded node containing `offset` (root pointer as final fallback). */
function pointerAt(a: Analysis, offset: number): string {
  let best = '';
  let bestSize = Number.POSITIVE_INFINITY;
  for (const [pointer, range] of a.sourceMap) {
    if (range.start.offset <= offset && offset <= range.end.offset) {
      const size = range.end.offset - range.start.offset;
      if (size < bestSize || (size === bestSize && pointer.length > best.length)) {
        best = pointer;
        bestSize = size;
      }
    }
  }
  return best;
}

/** The map-entry pointer whose key token starts exactly at `keyOffset` and names `key`. */
function entryPointerAt(a: Analysis, keyOffset: number, key: string): string | undefined {
  const suffix = '/' + escapePointerSegment(key);
  let best: string | undefined;
  for (const [pointer, range] of a.sourceMap) {
    if (range.start.offset !== keyOffset || !pointer.endsWith(suffix)) continue;
    if (best === undefined || pointer.length > best.length) best = pointer;
  }
  return best;
}

function valueAtPointer(document: unknown, pointer: string): unknown {
  let value: unknown = document;
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(value)) value = value[Number(token)];
    else if (isRecord(value)) value = value[token];
    else return undefined;
  }
  return value;
}

/** RFC 7386 JSON Merge Patch (objects deep-merge, `null` deletes, everything else replaces). */
function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return structuredClone(patch);
  const result: Record<string, unknown> = isRecord(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = applyMergePatch(result[key], value);
  }
  return result;
}

const OVERRIDES_POINTER = /^\/profiles\/[^/]+\/overrides(\/.*)?$/;

/**
 * Profile `overrides` are document-shaped RFC 7386 merge patches (ch. 6), so
 * schema-driven completion and hover inside an overrides block resolve the
 * pointer suffix against the document root, with the patch merged over the
 * base document so the per-kind `if/then` dispatch still sees each
 * resource's `kind` even when the patch itself omits it.
 */
function schemaResolutionTarget(
  a: Analysis,
  pointer: string,
): { pointer: string; document: unknown } {
  const match = OVERRIDES_POINTER.exec(pointer);
  if (match !== null) {
    const overridesPointer = pointer.slice(0, pointer.indexOf('/overrides') + '/overrides'.length);
    const patch = valueAtPointer(a.document, overridesPointer);
    return { pointer: match[1] ?? '', document: applyMergePatch(a.document ?? {}, patch) };
  }
  return { pointer, document: a.document ?? {} };
}

/* ------------------------------------------------------------------ */
/* Schema resolution: JSON Pointer → subschema (ch. 23 §23.1)          */
/* ------------------------------------------------------------------ */

export interface ResolvedSchema {
  /** The subschema at the pointer, `$ref`-resolved and kind-dispatched. */
  schema: JsonSchema;
  /** The last `$ref` this node resolved through (e.g. `#/$defs/common/resourceId`). */
  ref?: string;
}

let rootSchemaCache: JsonSchema | undefined;

function rootSchema(): JsonSchema {
  rootSchemaCache ??= iisDocumentSchema();
  return rootSchemaCache;
}

function lookupRef(ref: string): JsonSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = rootSchema();
  for (const token of ref.slice(2).split('/').map(unescapePointerToken)) {
    if (!isRecord(node)) return undefined;
    node = node[token];
  }
  return isRecord(node) ? (node as JsonSchema) : undefined;
}

/** Follow the `$ref` chain, remembering the last reference on the way. */
function dereference(node: unknown): { schema: JsonSchema; ref?: string } | undefined {
  let current = node;
  let ref: string | undefined;
  for (let depth = 0; depth < 16; depth += 1) {
    if (!isRecord(current)) return undefined;
    const next = current['$ref'];
    if (typeof next !== 'string') {
      return ref !== undefined
        ? { schema: current as JsonSchema, ref }
        : { schema: current as JsonSchema };
    }
    ref = next;
    current = lookupRef(next);
  }
  return undefined;
}

/**
 * Apply the per-kind `if/then` dispatch: when `schema` carries `allOf`
 * branches testing `properties.kind` and the instance declares a matching
 * `kind`, merge the branch's `properties`/`required` over the base — this is
 * how the resource entry's `spec` acquires its kind subschema (ch. 23 §23.2.1).
 */
function kindDispatch(schema: JsonSchema, instance: unknown): JsonSchema {
  const branches = schema['allOf'];
  if (!Array.isArray(branches) || !isRecord(instance)) return schema;
  const kind = instance['kind'];
  if (typeof kind !== 'string') return schema;
  for (const branch of branches) {
    if (!isRecord(branch) || !isRecord(branch['if']) || !isRecord(branch['then'])) continue;
    const condition = branch['if'] as JsonSchema;
    const conditionProps = condition['properties'];
    if (!isRecord(conditionProps) || !isRecord(conditionProps['kind'])) continue;
    const kindTest = conditionProps['kind'] as JsonSchema;
    const matches =
      kindTest['const'] === kind ||
      (Array.isArray(kindTest['enum']) && (kindTest['enum'] as unknown[]).includes(kind));
    if (!matches) continue;
    const then = branch['then'] as JsonSchema;
    const merged: JsonSchema = { ...schema };
    if (isRecord(then['properties'])) {
      merged['properties'] = {
        ...(isRecord(schema['properties']) ? schema['properties'] : {}),
        ...then['properties'],
      };
    }
    const required = [
      ...(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []),
      ...(Array.isArray(then['required']) ? (then['required'] as string[]) : []),
    ];
    if (required.length > 0) merged['required'] = [...new Set(required)];
    return merged;
  }
  return schema;
}

/** The raw child schema node for one pointer token (properties → patternProperties → additionalProperties → items). */
function childSchema(parent: JsonSchema, token: string): unknown {
  if (/^\d+$/.test(token) && isRecord(parent['items'])) return parent['items'];
  const properties = parent['properties'];
  if (isRecord(properties) && token in properties) return properties[token];
  const patterns = parent['patternProperties'];
  if (isRecord(patterns)) {
    for (const [pattern, sub] of Object.entries(patterns)) {
      if (new RegExp(pattern).test(token)) return sub;
    }
  }
  const additional = parent['additionalProperties'];
  if (additional !== undefined && additional !== false)
    return additional === true ? {} : additional;
  return undefined;
}

/**
 * Resolve the normative subschema governing the node at `pointer`, walking
 * `$ref` chains and dispatching the resource `kind` `if/then` branches by
 * reading the instance document alongside the schema. Returns `undefined`
 * when the pointer leads outside the schema.
 */
export function resolveSchemaAt(pointer: string, document?: unknown): ResolvedSchema | undefined {
  let node: unknown = rootSchema();
  let instance: unknown = document;
  for (const token of pointerTokens(pointer)) {
    const parent = dereference(node);
    if (parent === undefined) return undefined;
    const effective = kindDispatch(parent.schema, instance);
    const child = childSchema(effective, token);
    if (child === undefined) return undefined;
    node = child === true ? {} : child;
    if (Array.isArray(instance)) instance = instance[Number(token)];
    else if (isRecord(instance)) instance = instance[token];
    else instance = undefined;
  }
  const final = dereference(node);
  if (final === undefined) return undefined;
  const schema = kindDispatch(final.schema, instance);
  return final.ref !== undefined ? { schema, ref: final.ref } : { schema };
}

/* ------------------------------------------------------------------ */
/* Diagnostics (ch. 23 §23.2.3)                                        */
/* ------------------------------------------------------------------ */

function compareRanges(a: Range, b: Range): number {
  return (
    a.start.line - b.start.line ||
    a.start.character - b.start.character ||
    a.end.line - b.end.line ||
    a.end.character - b.end.character
  );
}

/**
 * Run the SDK validation pipeline (phases 1–4) plus the document's own
 * policies (phase 5) and map every finding to a positioned diagnostic. The
 * editor can never disagree with `iap validate`: both consume the same
 * `validateDocument` + `evaluatePolicies` engines (ch. 23 §23.1).
 */
export async function computeDiagnostics(text: string): Promise<Diagnostic[]> {
  const a = await analyze(text);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const push = (finding: Finding): void => {
    const key = `${finding.code}|${finding.path}|${finding.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  for (const finding of a.workspace.findings) push(finding);
  for (const finding of a.workspace.validate().findings) push(finding);
  if (a.document !== undefined) {
    try {
      for (const finding of a.workspace.policies().findings) push(finding);
    } catch {
      // canonicalization unavailable for this document state — phases 1–4 findings stand alone
    }
  }
  return findings
    .map((finding): Diagnostic => ({
      range: rangeForPath(a, finding.path),
      severity: finding.severity,
      code: finding.code,
      message: finding.message,
      source: 'iap',
    }))
    .sort((x, y) => compareRanges(x.range, y.range) || x.code.localeCompare(y.code));
}

/* ------------------------------------------------------------------ */
/* Completion (ch. 23 §23.2.1)                                         */
/* ------------------------------------------------------------------ */

interface LineContext {
  /** Key named on the line, when the line is a `key: …` map entry. */
  key?: string;
  /** True when the cursor sits after the key's colon (value position). */
  inValue: boolean;
  /** Absolute offset of the key token's first character. */
  keyOffset?: number;
}

function lineContextAt(a: Analysis, position: Position): LineContext {
  const lineStart = a.lineStarts[position.line];
  if (lineStart === undefined) return { inValue: false };
  const lineEnd = (a.lineStarts[position.line + 1] ?? a.text.length + 1) - 1;
  const line = a.text.slice(lineStart, lineEnd);
  const match = /^(\s*(?:-\s+)?)([^\s:#'"{}[\],]+):(?=\s|$)/.exec(line);
  if (match === null) return { inValue: false };
  const prefix = match[1] as string;
  const key = match[2] as string;
  const keyEnd = prefix.length + key.length;
  return {
    key,
    inValue: position.character > keyEnd,
    keyOffset: lineStart + prefix.length,
  };
}

function yamlScalarText(value: unknown): string {
  if (typeof value === 'string') {
    const plain =
      /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) &&
      !['true', 'false', 'null', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase());
    return plain ? value : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function kindsRegistry(): Record<string, unknown> {
  const defs = rootSchema()['$defs'];
  const kinds = isRecord(defs) ? defs['kinds'] : undefined;
  return isRecord(kinds) ? kinds : {};
}

function kindDocumentation(kind: string): string | undefined {
  const registry = kindsRegistry();
  const entry = registry[isReservedKind(kind) ? 'ReservedKind' : kind];
  const description = isRecord(entry) ? entry['description'] : undefined;
  return typeof description === 'string' ? description : undefined;
}

function kindCompletions(): CompletionItem[] {
  return KINDS.map((kind): CompletionItem => {
    const item: CompletionItem = { label: kind, kind: 'value' };
    if (isReservedKind(kind)) item.detail = 'reserved kind';
    const documentation = kindDocumentation(kind);
    if (documentation !== undefined) item.documentation = documentation;
    return item;
  });
}

function profileNameCompletions(a: Analysis): CompletionItem[] {
  const profiles = isRecord(a.document?.profiles) ? a.document.profiles : {};
  return Object.keys(profiles).map((name): CompletionItem => ({ label: name, kind: 'reference' }));
}

function resourceIdCompletions(a: Analysis): CompletionItem[] {
  const resources = isRecord(a.document?.resources) ? a.document.resources : {};
  return Object.entries(resources).map(([id, entry]): CompletionItem => {
    const item: CompletionItem = { label: id, kind: 'reference' };
    const kind = isRecord(entry) ? entry['kind'] : undefined;
    if (typeof kind === 'string') item.detail = kind;
    return item;
  });
}

function enumCompletions(resolved: ResolvedSchema): CompletionItem[] {
  const values = resolved.schema['enum'];
  if (!Array.isArray(values)) return [];
  const description = resolved.schema['description'];
  const defaultValue = resolved.schema['default'];
  return values.map((value): CompletionItem => {
    const item: CompletionItem = { label: yamlScalarText(value), kind: 'value' };
    if (value === defaultValue) item.detail = 'default';
    if (typeof description === 'string') item.documentation = description;
    return item;
  });
}

function valueCompletions(a: Analysis, context: LineContext): CompletionItem[] {
  const key = context.key as string;
  const keyOffset = context.keyOffset as number;
  let pointer = entryPointerAt(a, keyOffset, key);
  if (pointer === undefined) {
    const containing = pointerAt(a, keyOffset);
    const suffix = '/' + escapePointerSegment(key);
    pointer = containing.endsWith(suffix) ? containing : containing + suffix;
  }
  const target = schemaResolutionTarget(a, pointer);
  if (/^\/resources\/[^/]+\/kind$/.test(target.pointer)) return kindCompletions();
  const resolved = resolveSchemaAt(target.pointer, target.document);
  if (resolved === undefined) return [];
  if (/^\/profiles\/[^/]+\/extends$/.test(target.pointer)) {
    return profileNameCompletions(a);
  }
  if (resolved.ref === '#/$defs/common/resourceId' && !target.pointer.startsWith('/metadata/')) {
    return resourceIdCompletions(a);
  }
  return enumCompletions(resolved);
}

function typeSummary(schema: JsonSchema): string {
  if (Array.isArray(schema['enum'])) {
    return (schema['enum'] as unknown[]).map(yamlScalarText).join(' | ');
  }
  const type = schema['type'];
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.join(' | ');
  return 'object';
}

function propertyCompletions(a: Analysis, context: LineContext, offset: number): CompletionItem[] {
  let objectPointer: string;
  if (context.key !== undefined && context.keyOffset !== undefined) {
    const entry = entryPointerAt(a, context.keyOffset, context.key);
    objectPointer = entry !== undefined ? parentPointer(entry) : pointerAt(a, offset);
  } else {
    objectPointer = pointerAt(a, offset);
  }
  let instance = valueAtPointer(a.document, objectPointer);
  if (!isRecord(instance)) {
    objectPointer = parentPointer(objectPointer);
    instance = valueAtPointer(a.document, objectPointer);
  }
  const target = schemaResolutionTarget(a, objectPointer);
  const resolved = resolveSchemaAt(target.pointer, target.document);
  if (resolved === undefined) return [];
  const properties = resolved.schema['properties'];
  if (!isRecord(properties)) return [];
  const required = new Set(
    Array.isArray(resolved.schema['required']) ? (resolved.schema['required'] as string[]) : [],
  );
  const present = isRecord(instance) ? new Set(Object.keys(instance)) : new Set<string>();
  const items: CompletionItem[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    if (present.has(name) && name !== context.key) continue;
    const child = dereference(raw);
    const schema = child?.schema ?? {};
    const item: CompletionItem = {
      label: name,
      kind: 'property',
      sortText: `${required.has(name) ? '0' : '1'}${name}`,
    };
    const detailParts = [typeSummary(schema)];
    if (schema['default'] !== undefined) {
      detailParts.push(`default: ${yamlScalarText(schema['default'])}`);
    }
    if (required.has(name)) detailParts.push('required');
    item.detail = detailParts.join(' · ');
    const description = schema['description'];
    if (typeof description === 'string') item.documentation = description;
    items.push(item);
  }
  return items.sort((x, y) => (x.sortText ?? x.label).localeCompare(y.sortText ?? y.label));
}

/**
 * Context-aware completion: kinds at `kind:`, the closed verb set at
 * relationship `type:`, in-scope resource identifiers wherever the schema
 * expects a resource reference, enum values from the resolved subschema, and
 * property names (required-first, description + default in detail) in key
 * position. Everything derives from the schema plus the document itself.
 */
export async function computeCompletions(
  text: string,
  position: Position,
): Promise<CompletionItem[]> {
  const a = await analyze(text);
  const offset = offsetAt(a, position);
  const context = lineContextAt(a, position);
  if (context.inValue && context.key !== undefined && context.keyOffset !== undefined) {
    return valueCompletions(a, context);
  }
  return propertyCompletions(a, context, offset);
}

/* ------------------------------------------------------------------ */
/* Hover (ch. 23 §23.2.2)                                              */
/* ------------------------------------------------------------------ */

function hoverMarkdown(title: string, schema: JsonSchema): string | undefined {
  const lines: string[] = [`**\`${title}\`**`];
  const description = schema['description'];
  if (typeof description === 'string') lines.push('', description);
  const facts: string[] = [];
  if (schema['default'] !== undefined) {
    facts.push(`- Default: \`${yamlScalarText(schema['default'])}\``);
  }
  if (Array.isArray(schema['enum'])) {
    facts.push(
      `- Allowed values: ${(schema['enum'] as unknown[])
        .map((value) => `\`${yamlScalarText(value)}\``)
        .join(', ')}`,
    );
  }
  if (facts.length > 0) lines.push('', ...facts);
  const badges: string[] = [];
  const since = schema['x-iap-since'];
  if (since !== undefined) badges.push(`_Since ${String(since)}_`);
  const deprecated = schema['x-iap-deprecated'];
  if (deprecated !== undefined) {
    badges.push(
      typeof deprecated === 'string' ? `**Deprecated** — ${deprecated}` : '**Deprecated**',
    );
  }
  if (badges.length > 0) lines.push('', badges.join(' · '));
  if (typeof description !== 'string' && facts.length === 0 && badges.length === 0) {
    return undefined;
  }
  return lines.join('\n');
}

/**
 * Schema-derived hover: the `description` of the field (or value) under the
 * cursor, with `default`, `enum`, and `x-iap-since`/`x-iap-deprecated`
 * badges. Hovering a `kind:` value renders that kind's own description.
 */
export async function computeHover(text: string, position: Position): Promise<Hover | undefined> {
  const a = await analyze(text);
  const offset = offsetAt(a, position);
  const pointer = pointerAt(a, offset);
  if (pointer === '') return undefined;
  const range = a.sourceMap.get(pointer);
  const tokens = pointerTokens(pointer);
  const title = tokens[tokens.length - 1] ?? '';
  const value = valueAtPointer(a.document, pointer);

  // Semantic vocabulary: hovering `kind: Database` explains the kind itself.
  if (
    title === 'kind' &&
    typeof value === 'string' &&
    (KINDS as readonly string[]).includes(value)
  ) {
    const documentation = kindDocumentation(value);
    if (documentation !== undefined) {
      const hover: Hover = {
        contents: `**\`${value}\`**${isReservedKind(value) ? ' _(reserved kind)_' : ''}\n\n${documentation}`,
      };
      if (range !== undefined) hover.range = toRange(range);
      return hover;
    }
  }

  const target = schemaResolutionTarget(a, pointer);
  const resolved = resolveSchemaAt(target.pointer, target.document);
  if (resolved === undefined) return undefined;
  const contents = hoverMarkdown(title, resolved.schema);
  if (contents === undefined) return undefined;
  const hover: Hover = { contents };
  if (range !== undefined) hover.range = toRange(range);
  return hover;
}

/* ------------------------------------------------------------------ */
/* Resource-identifier navigation (ch. 23 §23.2.6)                     */
/* ------------------------------------------------------------------ */

interface IdSite {
  /** Source-map pointer of the entry/item carrying the identifier. */
  pointer: string;
  /** True when the identifier IS the map key (resources map, profile overrides). */
  isKey: boolean;
}

interface OffsetRange {
  start: number;
  end: number;
}

/**
 * Every place a resource identifier appears, derived from the document
 * structure (never regex over raw text): the `/resources` key itself,
 * relationship `target`s (inline and rule edges), Application
 * `spec.components` items, `outputs.*.resource`, Gateway
 * `spec.tls.certificate`, and profile `overrides.resources` keys (renames
 * must follow overrides or the merged document breaks).
 */
function resourceIdSites(document: IaPDocument): Map<string, IdSite[]> {
  const sites = new Map<string, IdSite[]>();
  const resources = isRecord(document.resources) ? document.resources : {};
  const ids = new Set(Object.keys(resources));
  const add = (id: string, pointer: string, isKey = false): void => {
    if (!ids.has(id)) return;
    const list = sites.get(id);
    const site: IdSite = { pointer, isKey };
    if (list === undefined) sites.set(id, [site]);
    else list.push(site);
  };

  for (const [id, raw] of Object.entries(resources)) {
    const base = `/resources/${escapePointerSegment(id)}`;
    add(id, base, true);
    if (!isRecord(raw)) continue;
    const entry = raw as ResourceEntry;
    if (Array.isArray(entry.relationships)) {
      entry.relationships.forEach((edge, index) => {
        if (isRecord(edge) && typeof edge['target'] === 'string') {
          add(edge['target'], `${base}/relationships/${index}/target`);
        }
      });
    }
    const spec = isRecord(entry.spec) ? entry.spec : {};
    if (Array.isArray(spec['components'])) {
      (spec['components'] as unknown[]).forEach((component, index) => {
        if (typeof component === 'string') add(component, `${base}/spec/components/${index}`);
      });
    }
    const tls = spec['tls'];
    if (isRecord(tls) && typeof tls['certificate'] === 'string') {
      add(tls['certificate'], `${base}/spec/tls/certificate`);
    }
  }

  if (Array.isArray(document.relationships)) {
    document.relationships.forEach((edge, index) => {
      if (isRecord(edge) && typeof edge['target'] === 'string') {
        add(edge['target'], `/relationships/${index}/target`);
      }
    });
  }

  if (isRecord(document.outputs)) {
    for (const [name, output] of Object.entries(document.outputs)) {
      if (isRecord(output) && typeof output['resource'] === 'string') {
        add(output['resource'], `/outputs/${escapePointerSegment(name)}/resource`);
      }
    }
  }

  if (isRecord(document.profiles)) {
    for (const [profileName, profile] of Object.entries(document.profiles)) {
      if (!isRecord(profile)) continue;
      const overrides = profile['overrides'];
      const overridden = isRecord(overrides) ? overrides['resources'] : undefined;
      if (!isRecord(overridden)) continue;
      for (const id of Object.keys(overridden)) {
        add(
          id,
          `/profiles/${escapePointerSegment(profileName)}/overrides/resources/${escapePointerSegment(id)}`,
          true,
        );
      }
    }
  }

  return sites;
}

/** The identifier token at `startOffset` (optionally quoted), as an offset range. */
function tokenAt(a: Analysis, startOffset: number, id: string): OffsetRange | undefined {
  let start = startOffset;
  const first = a.text[start];
  if (first === '"' || first === "'") start += 1;
  if (!a.text.startsWith(id, start)) return undefined;
  return { start, end: start + id.length };
}

/** Locate the identifier's exact value token inside a mapped entry range. */
function siteTokenOffsets(a: Analysis, site: IdSite, id: string): OffsetRange | undefined {
  const range = a.sourceMap.get(site.pointer);
  if (range === undefined) return undefined;
  const tokens = pointerTokens(site.pointer);
  const last = tokens[tokens.length - 1] ?? '';
  if (site.isKey || /^\d+$/.test(last)) {
    // Map keys and sequence items start exactly at the identifier token.
    return tokenAt(a, range.start.offset, id);
  }
  // Map entry (`target: web`): find the value token after the colon, at
  // identifier boundaries (so `web` never matches inside `web-identity`).
  const slice = a.text.slice(range.start.offset, range.end.offset);
  const colon = slice.indexOf(':');
  let from = colon >= 0 ? colon + 1 : 0;
  for (;;) {
    const index = slice.indexOf(id, from);
    if (index === -1) return undefined;
    const before = slice[index - 1] ?? '';
    const after = slice[index + id.length] ?? '';
    const boundary = /[a-z0-9-]/;
    if (!boundary.test(before) && !boundary.test(after)) {
      const start = range.start.offset + index;
      return { start, end: start + id.length };
    }
    from = index + 1;
  }
}

interface ResolvedId {
  id: string;
  sites: Array<{ site: IdSite; offsets: OffsetRange }>;
}

/** The resource identifier whose token contains `offset`, with every located site. */
function resolveIdAt(a: Analysis, offset: number): ResolvedId | undefined {
  if (a.document === undefined) return undefined;
  const all = resourceIdSites(a.document);
  for (const [id, siteList] of all) {
    const located: Array<{ site: IdSite; offsets: OffsetRange }> = [];
    let hit = false;
    for (const site of siteList) {
      const offsets = siteTokenOffsets(a, site, id);
      if (offsets === undefined) continue;
      located.push({ site, offsets });
      if (offsets.start <= offset && offset <= offsets.end) hit = true;
    }
    if (hit) return { id, sites: located };
  }
  return undefined;
}

function offsetsToRange(a: Analysis, offsets: OffsetRange): Range {
  return { start: positionAtOffset(a, offsets.start), end: positionAtOffset(a, offsets.end) };
}

/** Go to definition: any identifier usage jumps to its key under `/resources`. */
export async function computeDefinition(
  text: string,
  position: Position,
): Promise<DocumentLocation | undefined> {
  const a = await analyze(text);
  const resolved = resolveIdAt(a, offsetAt(a, position));
  if (resolved === undefined) return undefined;
  const definition = resolved.sites.find(
    ({ site }) => site.isKey && site.pointer === `/resources/${escapePointerSegment(resolved.id)}`,
  );
  if (definition === undefined) return undefined;
  return { range: offsetsToRange(a, definition.offsets) };
}

/** Find references: every usage site plus the defining key, in document order. */
export async function computeReferences(
  text: string,
  position: Position,
): Promise<DocumentLocation[]> {
  const a = await analyze(text);
  const resolved = resolveIdAt(a, offsetAt(a, position));
  if (resolved === undefined) return [];
  return resolved.sites
    .map(({ offsets }) => ({ range: offsetsToRange(a, offsets) }))
    .sort((x, y) => compareRanges(x.range, y.range));
}

/**
 * Rename a resource: rewrites the `/resources` key and every reference site
 * (edges, components, outputs, tls.certificate, profile overrides). The new
 * name must satisfy the resource-identifier grammar and must not collide
 * with an existing identifier.
 */
export async function computeRename(
  text: string,
  position: Position,
  newName: string,
): Promise<RenameResult> {
  const a = await analyze(text);
  const resolved = resolveIdAt(a, offsetAt(a, position));
  if (resolved === undefined) return { error: 'no resource identifier at this position' };
  if (!RESOURCE_ID_PATTERN.test(newName)) {
    return {
      error: `"${newName}" is not a valid resource identifier (DNS-label grammar: lowercase alphanumeric and hyphens, 1-63 chars)`,
    };
  }
  const resources = isRecord(a.document?.resources) ? a.document.resources : {};
  if (newName !== resolved.id && newName in resources) {
    return { error: `a resource named "${newName}" already exists in this document` };
  }
  const edits = resolved.sites
    .map(({ offsets }): TextEdit => ({ range: offsetsToRange(a, offsets), newText: newName }))
    .sort((x, y) => compareRanges(x.range, y.range));
  return { edits };
}

/* ------------------------------------------------------------------ */
/* Document symbols (ch. 23 §23.2.5)                                   */
/* ------------------------------------------------------------------ */

function symbolFor(
  a: Analysis,
  name: string,
  kind: SymbolKind,
  pointer: string,
  detail?: string,
): DocumentSymbol | undefined {
  const range = a.sourceMap.get(pointer);
  if (range === undefined) return undefined;
  const token = tokenAt(a, range.start.offset, name);
  const symbol: DocumentSymbol = {
    name,
    kind,
    range: toRange(range),
    selectionRange: token !== undefined ? offsetsToRange(a, token) : toRange(range),
  };
  if (detail !== undefined) symbol.detail = detail;
  return symbol;
}

/** Outline: resources (kind in detail), then profiles, policies, and outputs. */
export async function computeSymbols(text: string): Promise<DocumentSymbol[]> {
  const a = await analyze(text);
  if (a.document === undefined) return [];
  const groups: DocumentSymbol[] = [];

  const resources = isRecord(a.document.resources) ? a.document.resources : {};
  const resourceChildren: DocumentSymbol[] = [];
  for (const [id, entry] of Object.entries(resources)) {
    const kind = isRecord(entry) && typeof entry['kind'] === 'string' ? entry['kind'] : undefined;
    const symbol = symbolFor(a, id, 'resource', `/resources/${escapePointerSegment(id)}`, kind);
    if (symbol !== undefined) resourceChildren.push(symbol);
  }
  const resourcesGroup = symbolFor(a, 'resources', 'group', '/resources');
  if (resourcesGroup !== undefined && resourceChildren.length > 0) {
    resourcesGroup.children = resourceChildren;
    groups.push(resourcesGroup);
  }

  if (isRecord(a.document.profiles)) {
    const children: DocumentSymbol[] = [];
    for (const name of Object.keys(a.document.profiles)) {
      const symbol = symbolFor(a, name, 'profile', `/profiles/${escapePointerSegment(name)}`);
      if (symbol !== undefined) children.push(symbol);
    }
    const group = symbolFor(a, 'profiles', 'group', '/profiles');
    if (group !== undefined && children.length > 0) {
      group.children = children;
      groups.push(group);
    }
  }

  if (Array.isArray(a.document.policies)) {
    const children: DocumentSymbol[] = [];
    a.document.policies.forEach((policy, index) => {
      if (!isRecord(policy) || typeof policy['id'] !== 'string') return;
      const range = a.sourceMap.get(`/policies/${index}`);
      if (range === undefined) return;
      children.push({
        name: policy['id'],
        kind: 'policy',
        detail: typeof policy['effect'] === 'string' ? policy['effect'] : '',
        range: toRange(range),
        selectionRange: toRange(range),
      });
    });
    const group = symbolFor(a, 'policies', 'group', '/policies');
    if (group !== undefined && children.length > 0) {
      group.children = children;
      groups.push(group);
    }
  }

  if (isRecord(a.document.outputs)) {
    const children: DocumentSymbol[] = [];
    for (const [name, output] of Object.entries(a.document.outputs)) {
      const detail =
        isRecord(output) && typeof output['resource'] === 'string'
          ? `→ ${output['resource']}`
          : undefined;
      const symbol = symbolFor(a, name, 'output', `/outputs/${escapePointerSegment(name)}`, detail);
      if (symbol !== undefined) children.push(symbol);
    }
    const group = symbolFor(a, 'outputs', 'group', '/outputs');
    if (group !== undefined && children.length > 0) {
      group.children = children;
      groups.push(group);
    }
  }

  return groups;
}

/* ------------------------------------------------------------------ */
/* Code actions (ch. 23 §23.2.4)                                       */
/* ------------------------------------------------------------------ */

function rangesIntersect(a: OffsetRange, b: OffsetRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function offsetsOfRange(a: Analysis, range: Range): OffsetRange {
  return { start: offsetAt(a, range.start), end: offsetAt(a, range.end) };
}

const MISSING_PROPERTY = /must have required property '([^']+)'/;

function missingFieldAction(a: Analysis, path: string, field: string): CodeAction | undefined {
  const pointer = findingPointer(path);
  const childPointer = `${pointer}/${escapePointerSegment(field)}`;
  const resolved = resolveSchemaAt(childPointer, a.document ?? {});
  const schema = resolved?.schema ?? {};
  let placeholder: string;
  if (schema['default'] !== undefined) placeholder = yamlScalarText(schema['default']);
  else if (Array.isArray(schema['enum']) && (schema['enum'] as unknown[]).length > 0) {
    placeholder = yamlScalarText((schema['enum'] as unknown[])[0]);
  } else {
    const type = schema['type'];
    placeholder =
      type === 'integer' || type === 'number'
        ? '0'
        : type === 'boolean'
          ? 'false'
          : type === 'array'
            ? '[]'
            : type === 'object'
              ? '{}'
              : '""';
  }

  let insertAt: Position;
  let indent: string;
  if (pointer === '') {
    insertAt = positionAtOffset(a, a.text.length);
    indent = '';
  } else {
    const range = a.sourceMap.get(pointer);
    if (range === undefined) return undefined;
    const keyLine = range.start.line - 1;
    const lineStart = a.lineStarts[keyLine];
    const lineEnd = (a.lineStarts[keyLine + 1] ?? a.text.length + 1) - 1;
    if (lineStart === undefined) return undefined;
    const line = a.text.slice(lineStart, lineEnd);
    const colon = line.indexOf(':');
    const rest = colon >= 0 ? line.slice(colon + 1).trim() : '';
    // Only block-style objects with nothing after the key's colon get a safe
    // next-line insertion; flow style (`spec: {}`) is skipped in v1.
    if (rest !== '' && !rest.startsWith('#')) return undefined;
    indent = (/^\s*/.exec(line)?.[0] ?? '') + '  ';
    insertAt = { line: keyLine + 1, character: 0 };
  }
  const needsLeadingNewline =
    insertAt.line >= a.lineStarts.length && !a.text.endsWith('\n') && a.text.length > 0;
  const newText = `${needsLeadingNewline ? '\n' : ''}${indent}${field}: ${placeholder}\n`;
  return {
    title: `Add missing required field "${field}"`,
    kind: 'quickfix',
    edits: [{ range: { start: insertAt, end: insertAt }, newText }],
  };
}

/**
 * Quick fixes, each the surfaced form of a deterministic artifact:
 *
 * - **Policy autofixes** — a `require` policy violation whose RFC 7386 merge
 *   patch is present becomes an edit applying exactly that patch. v1 applies
 *   it by re-serializing the patched document through the SDK round-trip
 *   serializer (key order preserved; **comments are lost** — documented
 *   limitation, formatting-preserving edits deferred).
 * - **Add missing required field** — IAP101 missing-property findings offer
 *   an insertion of the field with its schema `default` (or a typed
 *   placeholder when no default exists).
 */
export async function computeCodeActions(text: string, range: Range): Promise<CodeAction[]> {
  const a = await analyze(text);
  if (a.document === undefined) return [];
  const requested = offsetsOfRange(a, range);
  const actions: CodeAction[] = [];

  let autofixes: PolicyAutofix[];
  try {
    autofixes = a.workspace.policies().autofixes;
  } catch {
    autofixes = [];
  }
  for (const autofix of autofixes) {
    const pointer = `/resources/${escapePointerSegment(autofix.resourceId)}`;
    const resourceRange = a.sourceMap.get(pointer);
    if (resourceRange === undefined) continue;
    const target = { start: resourceRange.start.offset, end: resourceRange.end.offset };
    if (!rangesIntersect(requested, target)) continue;
    const patched = structuredClone(a.document) as unknown as Record<string, unknown>;
    const resources = patched['resources'] as Record<string, unknown>;
    resources[autofix.resourceId] = applyMergePatch(resources[autofix.resourceId], autofix.patch);
    // JSON is a YAML subset: round-trip the patched document through the SDK
    // serializer so the edit is produced by the same engine as `iap format`.
    const workspace = await load(JSON.stringify(patched));
    const newText = workspace.serialize('yaml');
    actions.push({
      title: `Apply autofix for policy "${autofix.policyId}" on "${autofix.resourceId}"`,
      kind: 'quickfix',
      edits: [{ range: fullDocumentRange(a), newText }],
    });
  }

  for (const finding of a.workspace.validate().findings) {
    if (finding.code !== 'IAP101') continue;
    const match = MISSING_PROPERTY.exec(finding.message);
    if (match === null) continue;
    const findingRange = rangeForPath(a, finding.path);
    if (!rangesIntersect(requested, offsetsOfRange(a, findingRange))) continue;
    const action = missingFieldAction(a, finding.path, match[1] as string);
    if (action !== undefined) actions.push(action);
  }

  return actions;
}

/* ------------------------------------------------------------------ */
/* Architecture preview (ch. 23 §23.2.9, custom request iap/preview)   */
/* ------------------------------------------------------------------ */

export const PREVIEW_VIEWS: readonly ViewName[] = [
  'architecture',
  'dependency',
  'network',
  'security',
  'application',
];

/**
 * The `iap/preview` payload: canonicalize the current document state and
 * render one of the five ch. 18 derived views as Mermaid text — by
 * construction always in sync with the text. The **plan preview** of the
 * ch. 23 capability list is deferred to Phase 7 (no plan format exists yet,
 * IEP-0011).
 */
export async function computePreview(
  text: string,
  view: ViewName,
  application?: string,
): Promise<PreviewResult> {
  const a = await analyze(text);
  if (a.document === undefined) {
    throw new Error('iap/preview requires a parseable document — fix parse errors first');
  }
  const model = a.workspace.canonical().model;
  const graph = deriveView(model, view, application !== undefined ? { application } : {});
  return { mermaid: toMermaid(graph) };
}

export interface CanonicalPreviewResult {
  /** The canonical byte projection (C5+C6). */
  canonicalJson: string;
  /** SHA-256 (hex) of the canonical serialization. */
  hash: string;
}

/**
 * The `iap/canonical` payload: the canonical JSON projection and hash of the
 * current document state (ch. 1 §1.5) — the same bytes `iap normalize`
 * produces, so a side-panel canonical preview can never drift from the CLI.
 */
export async function computeCanonicalPreview(text: string): Promise<CanonicalPreviewResult> {
  const a = await analyze(text);
  if (a.document === undefined) {
    throw new Error('iap/canonical requires a parseable document — fix parse errors first');
  }
  const canonical = a.workspace.canonical();
  return { canonicalJson: canonical.canonicalJson, hash: canonical.model.hash };
}
