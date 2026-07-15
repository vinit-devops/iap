/**
 * @iap/parser — parse and schema-validate IaP documents (spec ch. 8, phases 1–2 subset).
 *
 * Scope of this minimum package (roadmap §17.8): YAML/JSON parsing with
 * duplicate-key rejection, single-document enforcement, source positions on
 * parse errors, and Phase 1 schema validation (IAP1xx) against the normative
 * JSON Schema with the `x-iap-*` annotation vocabulary pre-registered.
 * Later validation phases (reference, relationship, dependency, …) arrive
 * with the Phase 2 engines.
 *
 * Phase 2 M2.1 additions (spec ch. 21 §21.3 Parser contract): per-node source
 * maps (`./source-map.js`), alias/anchor expansion limits, file and stream
 * input helpers, and position-decorated findings via `attachPositions`.
 */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { LineCounter, parseAllDocuments } from 'yaml';
import type { Finding, IaPDocument, JsonSchema } from '@iap/model';
import {
  API_VERSION,
  LEGACY_API_VERSIONS,
  X_IIS_ANNOTATION_KEYWORDS,
  iisDocumentSchema,
} from '@iap/model';
import { sourceMapFromDocument } from './source-map.js';
import type { SourceMap, SourceRange } from './source-map.js';

export { buildSourceMap, escapePointerSegment, sourceMapFromDocument } from './source-map.js';
export type { SourceMap, SourcePosition, SourceRange } from './source-map.js';

/**
 * Ceiling on total alias resolutions per document (yaml `maxAliasCount`).
 * Guards against exponential alias expansion ("billion laughs"); a document
 * that would exceed it is rejected with an IAP101 "alias expansion limit"
 * finding, never an exception.
 */
export const MAX_ALIAS_COUNT = 100;

export interface ParseResult {
  /** Present when parsing succeeded (even if schema validation later fails). */
  document?: IaPDocument;
  findings: Finding[];
  /** True when `findings` contains no `error`-severity entries. */
  ok: boolean;
  /** Per-node source map; present when requested via `ParseOptions.sourceMap`. */
  sourceMap?: SourceMap;
}

export interface ParseOptions {
  /** Used in messages only. */
  filename?: string;
  /** When true, populate `ParseResult.sourceMap` (JSON Pointer → source range). */
  sourceMap?: boolean;
}

/**
 * Create an Ajv instance with the normative configuration: JSON Schema
 * draft 2020-12, collect-all errors, and the `x-iap-*` annotation vocabulary
 * registered as non-validating keywords (spec ch. 24 CV-6) so strict mode
 * stays ON.
 */
export function createValidator(schema?: JsonSchema): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  for (const keyword of X_IIS_ANNOTATION_KEYWORDS) {
    ajv.addKeyword({ keyword, valid: true });
  }
  return ajv.compile(schema ?? iisDocumentSchema());
}

function position(lineCounter: LineCounter, offset: number | undefined): string {
  if (offset === undefined) return '';
  const { line, col } = lineCounter.linePos(offset);
  return `:${line}:${col}`;
}

/**
 * Parse an IaP document from YAML or JSON text (JSON is a YAML subset).
 * Enforces: single document, unique keys, JSON data model (untagged nodes).
 */
export function parseText(text: string, options: ParseOptions = {}): ParseResult {
  const findings: Finding[] = [];
  const name = options.filename ?? '<input>';
  const lineCounter = new LineCounter();

  const docs = parseAllDocuments(text, {
    lineCounter,
    uniqueKeys: true,
    version: '1.2',
  });

  if (docs.length === 0) {
    findings.push({
      code: 'IAP101',
      severity: 'error',
      path: '',
      message: `${name}: empty input — an IaP document must be a single YAML/JSON object`,
    });
    return { findings, ok: false };
  }
  if (docs.length > 1) {
    findings.push({
      code: 'IAP101',
      severity: 'error',
      path: '',
      message: `${name}: multi-document streams are not valid IaP (spec ch. 2 §2.2); found ${docs.length} documents`,
    });
    return { findings, ok: false };
  }

  const doc = docs[0]!;
  for (const err of doc.errors) {
    findings.push({
      code: 'IAP101',
      severity: 'error',
      path: '',
      message: `${name}${position(lineCounter, err.pos?.[0])}: ${err.message}`,
    });
  }
  for (const warn of doc.warnings) {
    findings.push({
      code: 'IAP101',
      severity: 'warning',
      path: '',
      message: `${name}${position(lineCounter, warn.pos?.[0])}: ${warn.message}`,
    });
  }
  if (doc.errors.length > 0) {
    return { findings, ok: false };
  }

  let value: unknown;
  try {
    value = doc.toJS({ mapAsMap: false, maxAliasCount: MAX_ALIAS_COUNT });
  } catch (error) {
    findings.push({
      code: 'IAP101',
      severity: 'error',
      path: '',
      message: `${name}: alias expansion limit exceeded (maxAliasCount=${MAX_ALIAS_COUNT}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return { findings, ok: false };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push({
      code: 'IAP101',
      severity: 'error',
      path: '',
      message: `${name}: an IaP document must be an object`,
    });
    return { findings, ok: false };
  }

  const result: ParseResult = { document: value as IaPDocument, findings, ok: true };
  if (options.sourceMap) {
    // Reuse the already-parsed AST; the walk never dereferences aliases.
    result.sourceMap = sourceMapFromDocument(doc, lineCounter).map;
  }
  return result;
}

function codeFor(error: ErrorObject): string {
  // Unknown kind gets its dedicated code (spec ch. 8 Phase 1).
  if (error.instancePath.endsWith('/kind') && error.keyword === 'enum') return 'IAP102';
  // Value-shape violations: enum, pattern, range.
  if (['enum', 'pattern', 'minimum', 'maximum', 'const'].includes(error.keyword)) return 'IAP103';
  return 'IAP101';
}

/** Run Phase 1 schema validation (IAP1xx) against the normative schema. */
export function validateSchema(
  document: unknown,
  validator: ValidateFunction = createValidator(),
): Finding[] {
  if (validator(document)) return [];
  return (validator.errors ?? []).map((error) => ({
    code: codeFor(error),
    severity: 'error' as const,
    path: error.instancePath || '/',
    message: `${error.instancePath || '/'} ${error.message ?? 'schema violation'}`,
  }));
}

/** Parse then schema-validate in one call. */
export function loadDocument(text: string, options: ParseOptions = {}): ParseResult {
  const parsed = parseText(text, options);
  if (!parsed.ok || parsed.document === undefined) return parsed;

  const declaredApiVersion = parsed.document.apiVersion as unknown as string;
  if (declaredApiVersion !== API_VERSION) {
    // Hard rename (ADR-0003): the pre-release `iis.dev/*` apiVersions are NOT
    // supported — no compatibility, no normalization. Any non-canonical value
    // is rejected; a known legacy value gets a clearer, still-fatal message.
    const isLegacy = (LEGACY_API_VERSIONS as readonly string[]).includes(declaredApiVersion);
    parsed.findings.push({
      code: 'IAP101',
      severity: 'error',
      path: '/apiVersion',
      message: isLegacy
        ? `unsupported apiVersion ${JSON.stringify(declaredApiVersion)} — this is the pre-release IIS name, which is no longer accepted; use "${API_VERSION}"`
        : `unrecognized apiVersion ${JSON.stringify(declaredApiVersion)} — expected "${API_VERSION}"`,
    });
    return { ...parsed, ok: false };
  }

  const schemaFindings = validateSchema(parsed.document);
  const findings = [...parsed.findings, ...schemaFindings];
  return {
    ...parsed,
    findings,
    ok: findings.every((f) => f.severity !== 'error'),
  };
}

/**
 * Parse and schema-validate an IaP document from a file.
 * `options.filename` defaults to `path` so findings carry the file name.
 * Rejects only on I/O failure (an unreadable file is not a document finding);
 * document problems are findings per spec ch. 21 §21.1.3.
 */
export async function loadFile(path: string, options: ParseOptions = {}): Promise<ParseResult> {
  const text = await readFile(path, 'utf8');
  return loadDocument(text, { ...options, filename: options.filename ?? path });
}

/**
 * Parse and schema-validate an IaP document from a stream of chunks.
 * The stream is fully accumulated before parsing: IaP documents are single,
 * bounded YAML/JSON files (spec ch. 2 §2.2), not unbounded streams, so memory
 * use is proportional to document size. Buffer chunks are concatenated before
 * decoding, so multi-byte UTF-8 sequences split across chunk boundaries
 * decode correctly.
 */
export async function loadStream(
  stream: AsyncIterable<string | Buffer>,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return loadDocument(Buffer.concat(chunks).toString('utf8'), options);
}

/** Resolve a finding path to a mapped range: exact pointer, else nearest recorded ancestor. */
function resolveRange(map: SourceMap, path: string): SourceRange | undefined {
  let pointer = path === '/' ? '' : path;
  for (;;) {
    const range = map.get(pointer);
    if (range !== undefined) return range;
    if (pointer === '') return undefined;
    pointer = pointer.slice(0, pointer.lastIndexOf('/'));
  }
}

/**
 * Return a copy of `findings` with source positions attached: when a finding's
 * `path` (JSON Pointer, as emitted by `validateSchema`) resolves in `map` —
 * exactly or via its nearest recorded ancestor — its message is prefixed with
 * `file:line:col`. Findings that resolve nowhere pass through unchanged.
 */
export function attachPositions(
  findings: Finding[],
  map: SourceMap,
  filename = '<input>',
): Finding[] {
  return findings.map((finding) => {
    const range = resolveRange(map, finding.path);
    if (range === undefined) return finding;
    return {
      ...finding,
      message: `${filename}:${range.start.line}:${range.start.col}: ${finding.message}`,
    };
  });
}
