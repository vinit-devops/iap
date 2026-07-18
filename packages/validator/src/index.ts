/**
 * @iap/validator — validation pipeline phases 1–4 (spec ch. 8; M2.4).
 *
 * `validateDocument` implements the first four phases of the normative
 * eight-phase pipeline with registry-coded findings:
 *
 * - **Phase 1 — schema (IAP1xx).** Pre-merge parse + schema validation
 *   (delegated to `@iap/parser`), the apiVersion gate, a post-merge re-run of
 *   schema validation on the profile-merged document (ch. 8 §8.3: a merge
 *   patch can delete required fields), the IAP104 cross-field checks the
 *   schema cannot express (ch. 8 §8.5), the IAP105 banned provider-term
 *   scan over free-string core positions (ch. 24 §24.3), and the eagerly
 *   emitted IAP801 reserved-kind warning (ch. 5 §5.3; phase-8 code, ch. 24
 *   CV-4 — never gates).
 * - **Phase 2 — reference (IAP2xx).** Dangling edge targets (IAP201),
 *   Application components (IAP202), output resources (IAP203), Gateway
 *   certificates (IAP204), and profile reference errors (IAP205).
 * - **Phase 3 — relationship (IAP3xx).** The normalized edge set (via
 *   `@iap/model`'s `flattenEdges`) checked against `@iap/graph`'s verb/kind
 *   (IAP301) and attribute/verb (IAP302) constraint tables, plus the
 *   route-less-Gateway advisory (IAP303, warning).
 * - **Phase 4 — dependency (IAP4xx).** Ordering cycles with full cycle paths
 *   (IAP401), zero-match rule-edge selectors (IAP402, surfaced by
 *   `flattenEdges`), and self-referential ordering edges (IAP403).
 *
 * Failure semantics follow ch. 8 §8.2: findings are collected exhaustively
 * within a phase; a later phase runs only when no earlier phase produced an
 * error (warnings never gate). Phases 2–4 evaluate the profile-merged
 * document (base document when no profile is selected). Finding order is
 * deterministic: phase order, then `path`, then `code` (ch. 8 §8.6).
 *
 * Phases 5–8 (policy, security, compliance, version/extension) arrive with
 * later milestones; their conformance cases stay deferred in the harness.
 */

import {
  API_VERSION,
  compareCodePoints,
  flattenEdges,
  isReservedKind,
  mergeProfile,
} from '@iap/model';
import type { Finding, IaPDocument } from '@iap/model';
import { createValidator, loadDocument, validateSchema } from '@iap/parser';
import {
  attributeViolations,
  buildGraph,
  deriveOrdering,
  detectCycles,
  verbKindViolation,
} from '@iap/graph';
import type { IaPGraph } from '@iap/graph';

export type PhaseName = 'schema' | 'reference' | 'relationship' | 'dependency';

export interface PhaseReport {
  findings: Finding[];
  /** True when the phase did not run because an earlier phase produced errors. */
  skipped: boolean;
}

export interface ValidateDocumentOptions {
  /** Active profile the document is validated relative to (`null`/omitted = base document). */
  profile?: string | null;
}

export interface ValidateDocumentResult {
  /** All findings, ordered by phase, then path, then code (ch. 8 §8.6). */
  findings: Finding[];
  phases: Record<PhaseName, PhaseReport>;
  /** True when no executed phase produced an error-severity finding (ch. 8 §8.6). */
  ok: boolean;
}

/** Default severities of the codes this package emits (spec/conformance/error-codes.yaml). */
const SEVERITY: Readonly<Record<string, Finding['severity']>> = {
  IAP101: 'error',
  IAP104: 'error',
  IAP201: 'error',
  IAP202: 'error',
  IAP203: 'error',
  IAP204: 'error',
  IAP205: 'error',
  IAP301: 'error',
  IAP302: 'error',
  IAP303: 'warning',
  IAP401: 'error',
  IAP402: 'error',
  IAP403: 'error',
  IAP801: 'warning',
};

function finding(code: string, path: string, message: string): Finding {
  return { code, severity: SEVERITY[code] ?? 'error', path, message };
}

function hasErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Escape one RFC 6901 reference token. */
function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/* Compiling the normative schema is expensive; share one ajv instance. */
type SchemaValidator = ReturnType<typeof createValidator>;
let cachedValidator: SchemaValidator | undefined;
function schemaValidator(): SchemaValidator {
  cachedValidator ??= createValidator();
  return cachedValidator;
}

/* ------------------------------------------------------------------ */
/* Phase 1 — IAP104 cross-field checks (ch. 8 §8.5)                    */
/* ------------------------------------------------------------------ */

/** Engine → classes it is consistent with (ch. 3 §Database, normative IAP104 rule). */
const ENGINE_CLASSES: Readonly<Record<string, readonly string[]>> = {
  postgresql: ['relational'],
  mysql: ['relational'],
  mariadb: ['relational'],
  'mongodb-compatible': ['document'],
  // wide-column added in spec 1.1.0 (IEP-0015): cassandra-compatible is the
  // canonical wide-column dialect; the 1.0.0 pairings are retained verbatim.
  // No engine value pairs with class "warehouse" in 1.1.0.
  'cassandra-compatible': ['key-value', 'document', 'wide-column'],
};

/**
 * The IAP104 rule list: cross-field constraints JSON Schema cannot express,
 * run on the (schema-valid) profile-merged document. v1 rules: inert
 * `deadLetter.maxReceives`, `scaling.min` ≤ `scaling.max`, and Database
 * engine/class consistency.
 */
function crossFieldChecks(doc: IaPDocument): Finding[] {
  const findings: Finding[] = [];
  const resources = isPlainObject(doc.resources) ? doc.resources : {};
  for (const id of Object.keys(resources).sort(compareCodePoints)) {
    const entry = resources[id];
    if (!isPlainObject(entry)) continue;
    const spec = isPlainObject(entry.spec) ? entry.spec : {};
    const base = `/resources/${escapePointer(id)}/spec`;

    if (entry.kind === 'Queue') {
      const deadLetter = spec.deadLetter;
      if (
        isPlainObject(deadLetter) &&
        deadLetter.maxReceives !== undefined &&
        deadLetter.enabled !== true
      ) {
        findings.push(
          finding(
            'IAP104',
            `${base}/deadLetter/maxReceives`,
            'spec.deadLetter.maxReceives is set while spec.deadLetter.enabled is not true — the field is inert (ch. 8 §8.5)',
          ),
        );
      }
    }

    if (entry.kind === 'Service') {
      const scaling = spec.scaling;
      if (
        isPlainObject(scaling) &&
        typeof scaling.min === 'number' &&
        typeof scaling.max === 'number' &&
        scaling.min > scaling.max
      ) {
        findings.push(
          finding(
            'IAP104',
            `${base}/scaling`,
            `spec.scaling.min (${scaling.min}) exceeds spec.scaling.max (${scaling.max}) — min must not exceed max (ch. 3, ch. 8 §8.5)`,
          ),
        );
      }
    }

    if (entry.kind === 'Database') {
      const cls = spec.class;
      const engine = spec.engine;
      if (typeof cls === 'string' && typeof engine === 'string') {
        const allowed = ENGINE_CLASSES[engine];
        if (allowed && !allowed.includes(cls)) {
          findings.push(
            finding(
              'IAP104',
              `${base}/engine`,
              `Database engine "${engine}" is consistent only with class ${allowed.map((c) => `"${c}"`).join(' or ')} (found "${cls}"; ch. 3, ch. 8 §8.5)`,
            ),
          );
        }
      }
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* IAP801 — reserved kind in use (ch. 5 §5.3, ch. 10 §10.3)            */
/* ------------------------------------------------------------------ */

/**
 * IAP801 (warning, never gating): the document uses a kind that is reserved
 * in the current specification minor. As of spec 1.2.0 (IEP-0016) the
 * reserved registry is EMPTY — all nine originally reserved kinds have
 * graduated (five in 1.1.0 via IEP-0015, four in 1.2.0 via IEP-0016) — so
 * `RESERVED_KINDS` is empty and this check emits IAP801 for nothing. The
 * mechanism is retained deliberately (ch. 5 §5.3 note): if a future minor
 * reserves a new kind name, adding it to `RESERVED_KINDS` re-enables the
 * warning here with no other change.
 *
 * The code belongs to the phase-8 range (version/extension); the full phase-8
 * engine is a later milestone, but ch. 24 CV-4 makes silent acceptance of a
 * reserved kind a conformance failure, so the warning is emitted eagerly with
 * the phase-1 semantic checks. Warnings never gate later phases (ch. 8 §8.2).
 */
function reservedKindChecks(doc: IaPDocument): Finding[] {
  const findings: Finding[] = [];
  const resources = isPlainObject(doc.resources) ? doc.resources : {};
  for (const id of Object.keys(resources).sort(compareCodePoints)) {
    const entry = resources[id];
    if (!isPlainObject(entry) || typeof entry.kind !== 'string') continue;
    if (isReservedKind(entry.kind)) {
      findings.push(
        finding(
          'IAP801',
          `/resources/${escapePointer(id)}/kind`,
          `kind "${entry.kind}" is reserved in v1; its full field specification arrives in a future minor (ch. 5 §5.3; IAP801)`,
        ),
      );
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Phase 1 — IAP105 banned provider terms (ch. 24 §24.3)               */
/* ------------------------------------------------------------------ */

/** The normative banned provider-term list (ch. 24 §24.3; versioned with the spec). */
export const BANNED_PROVIDER_TERMS: readonly string[] = [
  // Networking
  'vpc',
  'vnet',
  'subnet',
  'security-group',
  'nsg',
  'route-table',
  'internet-gateway',
  'nat-gateway',
  'elb',
  'alb',
  'nlb',
  'cloudfront',
  'route53',
  // Compute
  'ec2',
  'ecs',
  'eks',
  'fargate',
  'aks',
  'gke',
  'gce',
  'app-service',
  'cloud-run',
  'app-engine',
  // Data
  'rds',
  'aurora',
  'dynamodb',
  'redshift',
  'elasticache',
  'cosmosdb',
  'cloud-sql',
  'bigquery',
  'spanner',
  'firestore',
  'memorystore',
  // Storage
  's3',
  'ebs',
  'efs',
  'blob-storage',
  'gcs',
  // Messaging
  'sqs',
  'sns',
  'kinesis',
  'eventbridge',
  'event-hub',
  'service-bus',
  'pubsub',
  // Security and identity
  'iam',
  'kms',
  'key-vault',
  'secrets-manager',
  'cloud-kms',
  // Observability
  'cloudwatch',
  'stackdriver',
  'app-insights',
];

/**
 * Whole-token normalization for the §24.3 matching rule: case-insensitive,
 * tokens delimited by any non-alphanumeric character or string boundary
 * (`vpc` matches `my-vpc-id`, not `vpcx`).
 */
function tokenized(text: string): string {
  return `-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-`;
}

const BANNED_NEEDLES = BANNED_PROVIDER_TERMS.map((term) => ({ term, needle: tokenized(term) }));

function bannedTermsIn(text: string): string[] {
  const haystack = tokenized(text);
  return BANNED_NEEDLES.filter(({ needle }) => haystack.includes(needle)).map(({ term }) => term);
}

/**
 * IAP105 — banned provider terms in core positions (ch. 24 §24.3): the scan
 * covers every object key and string value of the merged document except the
 * exempt positions (any `extensions` block, `x-*` keys and values,
 * `description` fields, `metadata.annotations`, and `artifact.reference`).
 */
function bannedTermChecks(doc: IaPDocument): Finding[] {
  const findings: Finding[] = [];
  scanForBannedTerms(doc as unknown, '', findings);
  return findings;
}

function scanForBannedTerms(value: unknown, pointer: string, findings: Finding[]): void {
  if (typeof value === 'string') {
    const terms = bannedTermsIn(value);
    if (terms.length > 0) {
      findings.push(
        finding(
          'IAP105',
          pointer || '/',
          `banned provider term${terms.length > 1 ? 's' : ''} ${terms.map((t) => `"${t}"`).join(', ')} in a core field position (ch. 24 §24.3)`,
        ),
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForBannedTerms(item, `${pointer}/${index}`, findings));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    // Exempt positions (§24.3): extension bags, x-* passthrough, free text.
    if (key.startsWith('x-') || key === 'extensions' || key === 'description') continue;
    const childPointer = `${pointer}/${escapePointer(key)}`;
    if (key === 'annotations' && pointer.endsWith('/metadata')) continue;
    if (key === 'reference' && pointer.endsWith('/artifact')) continue;
    const keyTerms = bannedTermsIn(key);
    if (keyTerms.length > 0) {
      findings.push(
        finding(
          'IAP105',
          childPointer,
          `banned provider term${keyTerms.length > 1 ? 's' : ''} ${keyTerms.map((t) => `"${t}"`).join(', ')} in a core key (ch. 24 §24.3)`,
        ),
      );
    }
    scanForBannedTerms(value[key], childPointer, findings);
  }
}

/* ------------------------------------------------------------------ */
/* Phase 2 — reference resolution (IAP2xx)                             */
/* ------------------------------------------------------------------ */

/**
 * Profile reference errors (IAP205, ch. 8 §8.3): unknown selected profile,
 * unknown `extends` target, and `extends` cycles. Evaluated over *every*
 * declared profile (not just the selected one) so a lint-only run still
 * rejects a document whose profile graph can never merge. Each cycle is
 * reported once, anchored at its lexicographically smallest member.
 */
function profileReferenceChecks(doc: IaPDocument, selected: string | null): Finding[] {
  const findings: Finding[] = [];
  const profiles = isPlainObject(doc.profiles) ? doc.profiles : {};

  if (selected !== null && !Object.prototype.hasOwnProperty.call(profiles, selected)) {
    findings.push(
      finding(
        'IAP205',
        '/profiles',
        `unknown profile "${selected}" — the merge is aborted (ch. 6 §6.5, ch. 8 §8.3)`,
      ),
    );
  }

  const names = Object.keys(profiles).sort(compareCodePoints);
  const extendsOf = (name: string): string | undefined => {
    const profile = profiles[name];
    const target = isPlainObject(profile) ? profile.extends : undefined;
    return typeof target === 'string' ? target : undefined;
  };

  // Unknown extends targets — exactly one finding per offending `extends`.
  for (const name of names) {
    const target = extendsOf(name);
    if (target !== undefined && !Object.prototype.hasOwnProperty.call(profiles, target)) {
      findings.push(
        finding(
          'IAP205',
          `/profiles/${escapePointer(name)}/extends`,
          `profile "${name}" extends unknown profile "${target}" (ch. 6 §6.5, ch. 8 §8.3)`,
        ),
      );
    }
  }

  // Extends cycles — each profile has at most one outgoing `extends` arc, so
  // a colored walk finds every cycle exactly once.
  const color = new Map<string, 'visiting' | 'done'>();
  for (const name of names) {
    if (color.has(name)) continue;
    const trail: string[] = [];
    let cursor: string | undefined = name;
    while (
      cursor !== undefined &&
      Object.prototype.hasOwnProperty.call(profiles, cursor) &&
      !color.has(cursor)
    ) {
      color.set(cursor, 'visiting');
      trail.push(cursor);
      cursor = extendsOf(cursor);
    }
    if (cursor !== undefined && color.get(cursor) === 'visiting') {
      const cycle = trail.slice(trail.indexOf(cursor));
      const anchor = [...cycle].sort(compareCodePoints)[0] as string;
      const rotated = [
        ...cycle.slice(cycle.indexOf(anchor)),
        ...cycle.slice(0, cycle.indexOf(anchor)),
      ];
      findings.push(
        finding(
          'IAP205',
          `/profiles/${escapePointer(anchor)}/extends`,
          `profile extends cycle: ${[...rotated, anchor].join(' → ')} — the merge is aborted (ch. 6 §6.5, ch. 8 §8.3)`,
        ),
      );
    }
    for (const visited of trail) color.set(visited, 'done');
  }

  return findings;
}

/** Dangling-identifier checks over the profile-merged document (ch. 8 phase 2). */
function referenceChecks(doc: IaPDocument): Finding[] {
  const findings: Finding[] = [];
  const resources = isPlainObject(doc.resources) ? doc.resources : {};
  const ids = new Set(Object.keys(resources));

  // IAP201 — inline edge targets.
  for (const id of Object.keys(resources).sort(compareCodePoints)) {
    const entry = resources[id];
    if (!isPlainObject(entry) || !Array.isArray(entry.relationships)) continue;
    entry.relationships.forEach((edge, index) => {
      if (!isPlainObject(edge)) return;
      const target = String(edge.target);
      if (!ids.has(target)) {
        findings.push(
          finding(
            'IAP201',
            `/resources/${escapePointer(id)}/relationships/${index}/target`,
            `relationship target "${target}" names no resource in the profile-merged document (IAP201)`,
          ),
        );
      }
    });
  }

  // IAP201 — rule edge targets.
  const rules = Array.isArray(doc.relationships) ? doc.relationships : [];
  rules.forEach((rule, index) => {
    if (!isPlainObject(rule)) return;
    const target = String(rule.target);
    if (!ids.has(target)) {
      findings.push(
        finding(
          'IAP201',
          `/relationships/${index}/target`,
          `rule-edge target "${target}" names no resource in the profile-merged document (IAP201)`,
        ),
      );
    }
  });

  // IAP202 — Application components (dangling or self-referential).
  for (const id of Object.keys(resources).sort(compareCodePoints)) {
    const entry = resources[id];
    if (!isPlainObject(entry) || entry.kind !== 'Application') continue;
    const spec = isPlainObject(entry.spec) ? entry.spec : {};
    const components = Array.isArray(spec.components) ? spec.components : [];
    components.forEach((component, index) => {
      const name = String(component);
      const path = `/resources/${escapePointer(id)}/spec/components/${index}`;
      if (name === id) {
        findings.push(
          finding('IAP202', path, `Application "${id}" lists itself as a component (IAP202)`),
        );
      } else if (!ids.has(name)) {
        findings.push(
          finding('IAP202', path, `Application component "${name}" names no resource (IAP202)`),
        );
      }
    });
  }

  // IAP203 — output resource references. Note: only resource existence is
  // checked; per-kind abstract-attribute tables (ch. 3) are not yet
  // machine-readable, so `attribute` validity is a known limitation of M2.4.
  const outputs = isPlainObject(doc.outputs) ? doc.outputs : {};
  for (const name of Object.keys(outputs).sort(compareCodePoints)) {
    const output = outputs[name];
    if (!isPlainObject(output)) continue;
    const resource = String(output.resource);
    if (!ids.has(resource)) {
      findings.push(
        finding(
          'IAP203',
          `/outputs/${escapePointer(name)}/resource`,
          `output "${name}" references resource "${resource}", which does not exist (IAP203)`,
        ),
      );
    }
  }

  // IAP204 — Gateway tls.certificate must name an existing Certificate resource.
  for (const id of Object.keys(resources).sort(compareCodePoints)) {
    const entry = resources[id];
    if (!isPlainObject(entry) || entry.kind !== 'Gateway') continue;
    const spec = isPlainObject(entry.spec) ? entry.spec : {};
    const tls = isPlainObject(spec.tls) ? spec.tls : {};
    if (typeof tls.certificate !== 'string') continue;
    const path = `/resources/${escapePointer(id)}/spec/tls/certificate`;
    const referenced = resources[tls.certificate];
    if (!isPlainObject(referenced)) {
      findings.push(
        finding(
          'IAP204',
          path,
          `Gateway "${id}" references certificate "${tls.certificate}", which names no resource (IAP204)`,
        ),
      );
    } else if (referenced.kind !== 'Certificate') {
      findings.push(
        finding(
          'IAP204',
          path,
          `Gateway "${id}" tls.certificate must name a Certificate resource — "${tls.certificate}" is a ${String(referenced.kind)} (IAP204)`,
        ),
      );
    }
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* Phase 3 — relationship analysis (IAP3xx)                            */
/* ------------------------------------------------------------------ */

function relationshipChecks(graph: IaPGraph): Finding[] {
  const findings: Finding[] = [];

  graph.edges.forEach((edge, index) => {
    const violation = verbKindViolation(
      edge.type,
      graph.nodes.get(edge.source),
      graph.nodes.get(edge.target),
    );
    if (violation !== null) {
      findings.push(
        finding(
          'IAP301',
          `/edges/${index}`,
          `edge (${edge.source} ${edge.type} ${edge.target}): ${violation} (IAP301)`,
        ),
      );
    }
    for (const attribute of attributeViolations(edge)) {
      findings.push(
        finding(
          'IAP302',
          `/edges/${index}/attributes/${escapePointer(attribute)}`,
          `edge (${edge.source} ${edge.type} ${edge.target}): attribute "${attribute}" is not valid on ${edge.type} (ch. 4 §4.4; IAP302)`,
        ),
      );
    }
  });

  // IAP303 (advisory, warning) — a Gateway declaring no routesTo edge routes
  // nothing; structurally valid but almost certainly a mistake.
  for (const [id, kind] of [...graph.nodes.entries()].sort((a, b) =>
    compareCodePoints(a[0], b[0]),
  )) {
    if (kind !== 'Gateway') continue;
    const routes = (graph.outgoing.get(id) ?? []).some((edge) => edge.type === 'routesTo');
    if (!routes) {
      findings.push(
        finding(
          'IAP303',
          `/resources/${escapePointer(id)}`,
          `Gateway "${id}" declares no routesTo edge — it routes no traffic (advisory; IAP303)`,
        ),
      );
    }
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* Phase 4 — dependency analysis (IAP4xx)                              */
/* ------------------------------------------------------------------ */

function dependencyChecks(graph: IaPGraph, selectorFindings: Finding[]): Finding[] {
  // IAP402 — zero-match rule-edge selectors, surfaced by flattenEdges (§4.7 step 2).
  const findings: Finding[] = [...selectorFindings];

  const ordering = deriveOrdering(graph);

  // IAP403 — self-referential ordering edges (the degenerate one-node cycle,
  // reported distinctly per ch. 8 phase 4).
  for (const arc of ordering.edges) {
    if (arc.before !== arc.after) continue;
    const index = graph.edges.indexOf(arc.via);
    findings.push(
      finding(
        'IAP403',
        `/edges/${index}`,
        `resource "${arc.before}" declares an ordering edge to itself (${arc.via.type}; IAP403)`,
      ),
    );
  }

  // IAP401 — ordering cycles, with the full cycle path in the message (ch. 9 §9.3).
  for (const cycle of detectCycles(ordering)) {
    if (cycle.length < 2) continue; // self-loops are IAP403 above
    findings.push(
      finding(
        'IAP401',
        `/resources/${escapePointer(cycle[0] as string)}`,
        `ordering cycle: ${[...cycle, cycle[0] as string].join(' → ')} (IAP401)`,
      ),
    );
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* The pipeline                                                        */
/* ------------------------------------------------------------------ */

function newPhases(): Record<PhaseName, PhaseReport> {
  return {
    schema: { findings: [], skipped: false },
    reference: { findings: [], skipped: true },
    relationship: { findings: [], skipped: true },
    dependency: { findings: [], skipped: true },
  };
}

function finalize(phases: Record<PhaseName, PhaseReport>): ValidateDocumentResult {
  const order: PhaseName[] = ['schema', 'reference', 'relationship', 'dependency'];
  for (const name of order) {
    phases[name].findings.sort(
      (a, b) => compareCodePoints(a.path, b.path) || compareCodePoints(a.code, b.code),
    );
  }
  const findings = order.flatMap((name) => phases[name].findings);
  return { findings, phases, ok: !hasErrors(findings) };
}

/**
 * Validate an IaP document through phases 1–4 of ch. 8, relative to the
 * selected profile. Accepts YAML/JSON text (parsed via `@iap/parser`) or an
 * already-parsed document. Collect-all within each phase; later phases run
 * only when every earlier phase is error-free (warnings never gate).
 */
export function validateDocument(
  input: string | IaPDocument,
  options: ValidateDocumentOptions = {},
): ValidateDocumentResult {
  const profile = options.profile ?? null;
  const phases = newPhases();

  // Phase 1 (pre-merge): parse, apiVersion gate, schema validation.
  let document: IaPDocument | undefined;
  if (typeof input === 'string') {
    const parsed = loadDocument(input);
    phases.schema.findings.push(...parsed.findings);
    document = parsed.document;
  } else {
    document = input;
    if (document.apiVersion !== API_VERSION) {
      phases.schema.findings.push(
        finding(
          'IAP101',
          '/apiVersion',
          `unrecognized apiVersion ${JSON.stringify(document.apiVersion)} — expected "${API_VERSION}"`,
        ),
      );
    } else {
      phases.schema.findings.push(...validateSchema(document, schemaValidator()));
    }
  }
  if (document === undefined || hasErrors(phases.schema.findings)) {
    return finalize(phases);
  }

  // Profile resolution (IAP205 → phase 2 reference errors, ch. 8 §8.3).
  // Errors abort the merge: no canonical document exists, so the remaining
  // reference checks (and phases 3–4) are skipped.
  const profileFindings = profileReferenceChecks(document, profile);
  if (hasErrors(profileFindings)) {
    phases.reference.skipped = false;
    phases.reference.findings.push(...profileFindings);
    return finalize(phases);
  }

  const merge = mergeProfile(document, profile);
  const merged = merge.merged;

  // Phase 1 (post-merge): the canonical document produced for the selected
  // profile must be schema-valid again — a merge patch can delete required
  // fields (ch. 8 §8.3; conformance case 22).
  if (profile !== null) {
    const postMerge = validateSchema(merged, schemaValidator()).map((f) => ({
      ...f,
      path: `post-merge:${f.path}`,
      message: `post-merge (profile "${profile}"): ${f.message}`,
    }));
    phases.schema.findings.push(...postMerge);
    if (hasErrors(postMerge)) return finalize(phases);
  }

  // Phase 1 semantic rules the schema cannot express, on the (schema-valid)
  // merged document: IAP104 cross-field constraints and IAP105 banned terms,
  // plus the eagerly emitted IAP801 reserved-kind warning (never an error).
  const phase1Semantic = [
    ...crossFieldChecks(merged),
    ...bannedTermChecks(merged),
    ...reservedKindChecks(merged),
  ];
  phases.schema.findings.push(...phase1Semantic);
  if (hasErrors(phase1Semantic)) return finalize(phases);

  // Phase 2 — reference resolution over the profile-merged document.
  phases.reference.skipped = false;
  phases.reference.findings.push(...merge.findings, ...referenceChecks(merged));
  if (hasErrors(phases.reference.findings)) return finalize(phases);

  // Phase 3 — relationship analysis over the normalized edge set (§4.7).
  // flattenEdges also surfaces IAP402 (zero-match selectors), which belongs
  // to phase 4 and is routed there.
  const flattened = flattenEdges(merged);
  const resources = (isPlainObject(merged.resources) ? merged.resources : {}) as Record<
    string,
    { kind: string }
  >;
  const graph = buildGraph(resources, flattened.edges);
  phases.relationship.skipped = false;
  phases.relationship.findings.push(...relationshipChecks(graph));
  if (hasErrors(phases.relationship.findings)) return finalize(phases);

  // Phase 4 — dependency analysis over the derived ordering relation.
  phases.dependency.skipped = false;
  phases.dependency.findings.push(...dependencyChecks(graph, flattened.findings));
  return finalize(phases);
}
