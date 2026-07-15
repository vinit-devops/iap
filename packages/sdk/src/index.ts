/**
 * @iap/sdk — the reference SDK facade (spec ch. 21; M2.6).
 *
 * Composes the component engines behind the single entry point `load()`:
 * parsing (`@iap/parser`), four-phase validation (`@iap/validator`),
 * canonicalization + hashing (`@iap/model`), the dependency graph with
 * execution waves (`@iap/graph`), and policy evaluation (`@iap/policy`,
 * validation phase 5). Per ch. 21 §21.4, the facade adds no behavior a caller
 * could not reproduce by invoking the components directly — every method is a
 * memoized delegation.
 *
 * Contract highlights:
 *
 * - **Findings, not exceptions (§21.1.3).** Document problems are findings on
 *   the returned result. `IaPError` is thrown only for SDK misuse: an unknown
 *   serialization format, requesting canonicalization when no document parsed,
 *   or registering a duplicate extension namespace.
 * - **Validation and canonicalization are independent** (phase-2 design
 *   decision 3): `canonical()` works on any parsed document, valid or not; it
 *   normalizes what is there. Only parsing failure (no document at all) makes
 *   it unavailable.
 * - **Round-trip serializer.** `serialize('yaml')` re-emits the original
 *   (profile-unmerged) parsed document with key order as authored, so
 *   `load(ws.serialize('yaml'))` produces the same canonical hash.
 *   `serialize('canonical-json')` is the canonical byte projection (C5+C6).
 * - **Extension loading (§21.5).** `registerExtension` registers a namespace
 *   exactly once (duplicates are rejected); `validateExtensions` warns IAP802
 *   for unregistered namespaces and checks registered namespaces'
 *   resource-level `extensions.<ns>` content against the package sub-schema.
 */

import { readFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { canonicalize, compareCodePoints } from '@iap/model';
import type { CanonicalizeResult, Finding, IaPDocument, JsonSchema } from '@iap/model';
import { createValidator, loadDocument } from '@iap/parser';
import type { ParseOptions, SourceMap } from '@iap/parser';
import { buildGraph, executionWaves } from '@iap/graph';
import type { IaPGraph } from '@iap/graph';
import { evaluatePolicies } from '@iap/policy';
import type { EvaluatePoliciesOptions, PolicyResult } from '@iap/policy';
import { validateDocument } from '@iap/validator';
import type { ValidateDocumentResult } from '@iap/validator';

// Policy engine passthrough (ch. 7; validation phase 5): the evaluator and the
// built-in pack registry are part of the facade surface so hosts need not
// depend on @iap/policy directly.
export { POLICY_PACKS, evaluatePolicies } from '@iap/policy';
export type {
  EvaluatePoliciesOptions,
  PolicyAutofix,
  PolicyEvaluation,
  PolicyEvaluationInput,
  PolicyException,
  PolicyResource,
  PolicyResult,
} from '@iap/policy';

/* ------------------------------------------------------------------ */
/* SDK-misuse error (§21.1.3: exceptions never signal document problems) */
/* ------------------------------------------------------------------ */

/** Thrown for SDK misuse only — never for problems in the document itself. */
export class IaPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IaPError';
  }
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Escape one RFC 6901 reference token. */
function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/* ------------------------------------------------------------------ */
/* The facade: load() → IaPWorkspaceResult                             */
/* ------------------------------------------------------------------ */

export type SerializeFormat = 'canonical-json' | 'yaml';

export interface LoadOptions {
  /** Active profile everything downstream is relative to (`null`/omitted = base document). */
  profile?: string | null;
  /** When true, populate `IaPWorkspaceResult.sourceMap` (JSON Pointer → source range). */
  sourceMap?: boolean;
}

/**
 * The workspace handle `load()` returns. `document`, `findings`, `ok`, and
 * `sourceMap` reflect parsing + Phase 1 schema validation; the methods are
 * memoized delegations to the component engines (identical inputs → the same
 * object back, per §21.1.1 determinism).
 */
export interface IaPWorkspaceResult {
  /** The parsed, profile-UNmerged document as authored; absent when parsing failed. */
  document?: IaPDocument;
  /** Parse and Phase 1 schema findings gathered by `load` itself. */
  findings: Finding[];
  /** True when `findings` contains no error-severity entries. */
  ok: boolean;
  /** Per-node source map; present when requested via `LoadOptions.sourceMap`. */
  sourceMap?: SourceMap;
  /** Full four-phase validation (ch. 8 phases 1–4) relative to the selected profile. Memoized. */
  validate(): ValidateDocumentResult;
  /**
   * Canonicalization (ch. 1 §1.5): CIM, canonical JSON, SHA-256 hash, findings.
   * Independent of validity — an invalid document still canonicalizes; problems
   * stay findings. Throws `IaPError` only when no document parsed at all. Memoized.
   */
  canonical(): CanonicalizeResult;
  /** Typed graph over the canonical model's resources and normalized edges. Memoized. */
  graph(): IaPGraph;
  /** Execution waves (ch. 9 §9.4) over the canonical graph. Memoized. */
  waves(): string[][];
  /**
   * Policy evaluation (ch. 7; validation phase 5, IAP5xx): the document's own
   * `policies` array evaluated against the canonical model — always pre-mapping
   * and pre-planning by construction, since only the canonical model is
   * consumed. The no-options call is memoized; calls with options (exceptions
   * require `now` — the engine never reads the clock) evaluate fresh.
   */
  policies(options?: EvaluatePoliciesOptions): PolicyResult;
  /**
   * `'canonical-json'` (default): the canonical byte projection (C5+C6).
   * `'yaml'`: the original profile-unmerged document re-emitted with key order
   * as authored — `load(serialize('yaml'))` round-trips to the same canonical hash.
   */
  serialize(format?: SerializeFormat): string;
}

/**
 * Load an IaP document from text or a file and return the workspace handle.
 * `source` is YAML/JSON text, or `{path}` to read a file (the filename then
 * decorates findings). Parsing and Phase 1 schema validation run eagerly;
 * everything else is lazy and memoized.
 */
export async function load(
  source: string | { path: string },
  options: LoadOptions = {},
): Promise<IaPWorkspaceResult> {
  const profile = options.profile ?? null;

  let text: string;
  const parseOptions: ParseOptions = {};
  if (typeof source === 'string') {
    text = source;
  } else {
    text = await readFile(source.path, 'utf8');
    parseOptions.filename = source.path;
  }
  if (options.sourceMap) parseOptions.sourceMap = true;

  const parsed = loadDocument(text, parseOptions);
  const document = parsed.document;

  let validation: ValidateDocumentResult | undefined;
  let canon: CanonicalizeResult | undefined;
  let graphResult: IaPGraph | undefined;
  let wavesResult: string[][] | undefined;
  let policiesResult: PolicyResult | undefined;

  const validate = (): ValidateDocumentResult => {
    // A parsed document skips the redundant re-parse; otherwise the validator
    // re-derives the parse findings from the text (same phase 1 outcome).
    validation ??= validateDocument(document ?? text, { profile });
    return validation;
  };

  const canonical = (): CanonicalizeResult => {
    if (document === undefined) {
      throw new IaPError(
        'canonical() requires a parsed document — parsing failed; see IaPWorkspaceResult.findings (ch. 21 §21.1.3)',
      );
    }
    canon ??= canonicalize(document, { profile });
    return canon;
  };

  const graph = (): IaPGraph => {
    if (graphResult === undefined) {
      const model = canonical().model;
      graphResult = buildGraph(model.resources, model.edges);
    }
    return graphResult;
  };

  const waves = (): string[][] => {
    wavesResult ??= executionWaves(graph());
    return wavesResult;
  };

  const policies = (options?: EvaluatePoliciesOptions): PolicyResult => {
    // Options (exceptions/now) parameterize the result, so only the default
    // invocation is memoized; the engine itself is pure and deterministic.
    if (options !== undefined) return evaluatePolicies(canonical().model, options);
    policiesResult ??= evaluatePolicies(canonical().model);
    return policiesResult;
  };

  const serialize = (format: SerializeFormat = 'canonical-json'): string => {
    if (format === 'canonical-json') return canonical().canonicalJson;
    if (format === 'yaml') {
      if (document === undefined) {
        throw new IaPError(
          'serialize("yaml") requires a parsed document — parsing failed; see IaPWorkspaceResult.findings (ch. 21 §21.1.3)',
        );
      }
      // Re-emit the parsed object: insertion order preserves authored key
      // order (C1 lossless lift); aliases stay expanded, which is
      // hash-neutral. The profile-unmerged document round-trips.
      return stringify(document, { aliasDuplicateObjects: false });
    }
    throw new IaPError(
      `unknown serialization format ${JSON.stringify(format)} — expected "canonical-json" or "yaml"`,
    );
  };

  const result: IaPWorkspaceResult = {
    findings: parsed.findings,
    ok: parsed.ok,
    validate,
    canonical,
    graph,
    waves,
    policies,
    serialize,
  };
  if (document !== undefined) result.document = document;
  if (parsed.sourceMap !== undefined) result.sourceMap = parsed.sourceMap;
  return result;
}

/* ------------------------------------------------------------------ */
/* Extension loading (ch. 21 §21.5, ch. 11)                            */
/* ------------------------------------------------------------------ */

/**
 * A versioned extension package registered with the SDK before processing
 * (ch. 21 §21.5). v1 packages may contribute a sub-schema validating the
 * CONTENT of resource-level `extensions.<namespace>` blocks; mapping
 * artifacts, cost models, and rule bundles arrive with later phases.
 */
export interface ExtensionPackage {
  /** The `extensions.<ns>` namespace this package owns (ch. 11 §11.1). */
  namespace: string;
  /** Full semver of the package (ch. 11 §11.2). */
  version: string;
  /** JSON Schema for the content of resource-level `extensions.<namespace>` blocks. */
  schema?: JsonSchema;
}

interface RegisteredExtension {
  pkg: ExtensionPackage;
  /** Compiled lazily on first `validateExtensions` use. */
  compiled?: ReturnType<typeof createValidator>;
}

/** Registration order is preserved (ch. 21 §21.5: explicit and ordered). */
const registry = new Map<string, RegisteredExtension>();

/**
 * Register an extension package. Throws `IaPError` (SDK misuse) when the
 * namespace is empty or already claimed — the SDK MUST reject two packages
 * claiming the same namespace (ch. 21 §21.5).
 */
export function registerExtension(pkg: ExtensionPackage): void {
  if (typeof pkg.namespace !== 'string' || pkg.namespace.length === 0) {
    throw new IaPError('registerExtension requires a non-empty namespace (ch. 21 §21.5)');
  }
  if (registry.has(pkg.namespace)) {
    throw new IaPError(
      `extension namespace "${pkg.namespace}" is already registered — two packages must not claim the same namespace (ch. 21 §21.5)`,
    );
  }
  registry.set(pkg.namespace, { pkg: { ...pkg } });
}

/** Remove a registered namespace. Returns whether it was registered. */
export function unregisterExtension(namespace: string): boolean {
  return registry.delete(namespace);
}

/** The registered packages, in registration order. */
export function registeredExtensions(): ExtensionPackage[] {
  return [...registry.values()].map((entry) => ({ ...entry.pkg }));
}

interface ExtensionOccurrence {
  pointer: string;
  value: unknown;
  /** Resource-level refinement blocks are schema-checked; document-level registrations are not. */
  resourceLevel: boolean;
}

/** Every `extensions.<ns>` occurrence, keyed by namespace, in deterministic pointer order. */
function extensionOccurrences(document: IaPDocument): Map<string, ExtensionOccurrence[]> {
  const occurrences = new Map<string, ExtensionOccurrence[]>();
  const add = (ns: string, occurrence: ExtensionOccurrence): void => {
    const list = occurrences.get(ns);
    if (list) {
      list.push(occurrence);
    } else {
      occurrences.set(ns, [occurrence]);
    }
  };

  const docLevel = isPlainObject(document.extensions) ? document.extensions : {};
  for (const ns of Object.keys(docLevel).sort(compareCodePoints)) {
    add(ns, {
      pointer: `/extensions/${escapePointer(ns)}`,
      value: docLevel[ns],
      resourceLevel: false,
    });
  }

  const resources = isPlainObject(document.resources) ? document.resources : {};
  for (const id of Object.keys(resources).sort(compareCodePoints)) {
    const entry = resources[id];
    if (!isPlainObject(entry) || !isPlainObject(entry.extensions)) continue;
    for (const ns of Object.keys(entry.extensions).sort(compareCodePoints)) {
      add(ns, {
        pointer: `/resources/${escapePointer(id)}/extensions/${escapePointer(ns)}`,
        value: entry.extensions[ns],
        resourceLevel: true,
      });
    }
  }
  return occurrences;
}

/**
 * Validate a document's `extensions` usage against the registry (validation
 * phase 8 subset; ch. 11 §11.5):
 *
 * - Namespaces present in the document but not registered produce **IAP802
 *   warnings** — unknown namespaces warn, never fail. One finding per
 *   namespace, anchored at its first occurrence (document-level registration
 *   when present).
 * - Registered namespaces with a `schema` have every **resource-level**
 *   `extensions.<ns>` block's content validated against it. Violations are
 *   **error-severity IAP802** findings — the registry has no dedicated code
 *   for registered-but-invalid extension content yet (candidate IAP806; see
 *   the M2.6 milestone report).
 *
 * Per the Extension Non-Interference Rule (ch. 11 §11.3), these findings are
 * scoped inside `extensions.<ns>` blocks and never alter core validation.
 */
export function validateExtensions(document: IaPDocument): Finding[] {
  const findings: Finding[] = [];

  for (const [ns, occurrences] of extensionOccurrences(document)) {
    const registered = registry.get(ns);
    if (registered === undefined) {
      const anchor = occurrences[0] as ExtensionOccurrence;
      findings.push({
        code: 'IAP802',
        severity: 'warning',
        path: anchor.pointer,
        message: `extension namespace "${ns}" is not registered with the SDK — unknown namespaces warn, never fail (ch. 11 §11.5; IAP802)`,
      });
      continue;
    }

    const schema = registered.pkg.schema;
    if (schema === undefined) continue;
    registered.compiled ??= createValidator(schema);
    const compiled = registered.compiled;

    for (const occurrence of occurrences) {
      if (!occurrence.resourceLevel) continue; // document-level blocks carry version + namespace-wide settings
      if (compiled(occurrence.value)) continue;
      for (const error of compiled.errors ?? []) {
        findings.push({
          code: 'IAP802',
          severity: 'error',
          path: `${occurrence.pointer}${error.instancePath}`,
          message: `extension content for registered namespace "${ns}"@${registered.pkg.version} violates its package schema: ${error.instancePath || '/'} ${error.message ?? 'schema violation'} (reported as IAP802/error pending a dedicated registry code — candidate IAP806)`,
        });
      }
    }
  }

  findings.sort((a, b) => compareCodePoints(a.path, b.path) || compareCodePoints(a.code, b.code));
  return findings;
}
