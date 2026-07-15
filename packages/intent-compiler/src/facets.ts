/**
 * Intent facets — the typed, closed representation of the roadmap §3.2
 * extraction targets (M3.2). Facets are the ADAPTER OUTPUT CONTRACT: every
 * extractor — the in-repo deterministic rules extractor, a recorded fixture,
 * or an out-of-tree LLM adapter — expresses what it understood as facets, and
 * the deterministic facet compiler (`compile.ts`) turns facets into an
 * IEP-0009 operation batch for the M3.1 gate. Facets never touch the
 * document; only the gate does.
 *
 * Every facet carries: its extracted value(s), the source span it was
 * extracted from (input id + offsets + quoted text), a per-facet confidence,
 * and the extraction channel that produced it (closed vocabulary with
 * deterministic confidence tiers — exact keyword matches rank above inferred
 * associations, roadmap §3.4 "do not silently treat low-confidence AI output
 * as intent").
 *
 * The machine-readable contract is the embedded `intent-facets/v1` schema
 * below, compiled under strict ajv with the x-iap vocabulary via
 * `@iap/parser`. It is deliberately EMBEDDED-ONLY (design decision, M3.2):
 * facets are an internal adapter contract of the reference toolchain, not a
 * document companion artifact — publishing them under `spec/schema/` would
 * freeze extraction vocabulary as if it were normative. The schema exists for
 * structured-output enforcement against model adapters (M3.4 middleware);
 * `compiler-operations-v1.schema.json` remains the only spec companion.
 */

import type { ValidateFunction } from 'ajv';
import { COMPLIANCE_FRAMEWORKS, KINDS } from '@iap/model';
import type { ComplianceFramework, Kind } from '@iap/model';
import { createValidator } from '@iap/parser';
import type { JsonSchema } from '@iap/model';
import type { SourceSpan } from './operations.js';

/**
 * The closed facet vocabulary: the twenty roadmap §3.2 extraction targets
 * plus `removal`, which carries the §3.5 "Remove the X" edit directive
 * (a directive over existing resources, not an extraction target of its own).
 */
export const FACET_TYPES = [
  'environment',
  'workload',
  'application',
  'data-service',
  'messaging',
  'networking',
  'exposure',
  'identity',
  'secret',
  'availability',
  'scaling',
  'region',
  'backup',
  'recovery-objective',
  'security',
  'compliance',
  'budget',
  'operational',
  'provider-preference',
  'existing-resource',
  'removal',
] as const;

export type FacetType = (typeof FACET_TYPES)[number];

/**
 * How a facet was extracted (closed). `exact-keyword`: the value is a literal
 * vocabulary word in the input; `pattern-match`: a recognized phrasing whose
 * mapping to the value is unambiguous; `inferred-association`: the extractor
 * connected things the input did not connect literally (e.g. an edge between
 * the sole workload and a data service). Confidence tiers are deterministic
 * constants per channel — never computed.
 */
export const EXTRACTION_CHANNELS = [
  'exact-keyword',
  'pattern-match',
  'inferred-association',
] as const;

export type ExtractionChannel = (typeof EXTRACTION_CHANNELS)[number];

/**
 * Deterministic confidence constants per extraction channel (M3.2 design:
 * confidence is DATA — assigned from this closed table, compared by the gate,
 * never produced by arithmetic). `inferred-association` sits below the 0.8
 * default gate threshold by design: inferred structure always requires human
 * confirmation (OP-3).
 */
export const CONFIDENCE_TIERS: Readonly<Record<ExtractionChannel, number>> = {
  'exact-keyword': 0.95,
  'pattern-match': 0.85,
  'inferred-association': 0.7,
};

/**
 * A reference to the resource a facet applies to: an explicit identifier, or
 * a kind the compiler resolves against the document (exactly one resource of
 * that kind resolves; zero or several become unresolved-reference
 * clarifications — never a guess).
 */
export interface SubjectRef {
  resourceId?: string;
  kind?: Kind;
}

/** Members shared by every facet. */
export interface FacetBase {
  facet: FacetType;
  /** Where in the source input the facet was extracted from. */
  sourceSpan: SourceSpan;
  /** Extraction confidence in [0, 1]; a constant from `CONFIDENCE_TIERS` for rule extraction. */
  confidence: number;
  /** How the facet was extracted (closed vocabulary). */
  channel: ExtractionChannel;
}

/** Deployment environments; environments are profiles (ch. 6 §6.1, normative). */
export interface EnvironmentFacet extends FacetBase {
  facet: 'environment';
  environments: string[];
}

/** A compute workload request (Service/Job/Function/Gateway per ch. 3). */
export interface WorkloadFacet extends FacetBase {
  facet: 'workload';
  workload: 'Service' | 'Job' | 'Function' | 'Gateway';
  name?: string;
  /** Container image / source reference when the input stated one. */
  artifact?: string;
  /** Cron or @-macro schedule (Job only). */
  schedule?: string;
}

/** Application grouping intent (ch. 3 §3.4). */
export interface ApplicationFacet extends FacetBase {
  facet: 'application';
  name?: string;
}

/** A data service: database, cache, object store, or volume. */
export interface DataServiceFacet extends FacetBase {
  facet: 'data-service';
  service: 'database' | 'cache' | 'object-store' | 'volume';
  databaseClass?: 'relational' | 'document' | 'key-value' | 'graph' | 'timeseries' | 'vector';
  engine?: string;
  engineVersion?: string;
  /** Exact storage quantity when stated (quantity grammar, §3.2.7). */
  storage?: string;
  name?: string;
  /** The workload this service is for ("a cache for the API"). */
  attachTo?: SubjectRef;
}

/** Messaging intent; `unspecified` means queue-vs-topic was not determinable (clarified, never guessed). */
export interface MessagingFacet extends FacetBase {
  facet: 'messaging';
  messaging: 'queue' | 'topic' | 'unspecified';
  name?: string;
}

/** Networking/connectivity intent, including the §3.5 "Remove public access" directive. */
export interface NetworkingFacet extends FacetBase {
  facet: 'networking';
  intent: 'connect' | 'route' | 'publish' | 'consume' | 'store' | 'remove-public-access';
  from?: SubjectRef;
  to?: SubjectRef;
}

/** Exposure intent (§3.2.2), optionally scoped to a subject ("make the database private"). */
export interface ExposureFacet extends FacetBase {
  facet: 'exposure';
  exposure: 'public' | 'internal' | 'private';
  subject?: SubjectRef;
}

/** Workload identity intent (ch. 3 §3.15). */
export interface IdentityFacet extends FacetBase {
  facet: 'identity';
  name?: string;
}

/** Managed secret intent (ch. 3 §3.16). Values never appear anywhere. */
export interface SecretFacet extends FacetBase {
  facet: 'secret';
  name?: string;
  rotation?: boolean;
}

/** Availability SLO floor intent (§3.2.1). */
export interface AvailabilityFacet extends FacetBase {
  facet: 'availability';
  availability: 'standard' | 'high' | 'maximum';
  subject?: SubjectRef;
}

/** Horizontal scaling intent. */
export interface ScalingFacet extends FacetBase {
  facet: 'scaling';
  min?: number;
  max?: number;
  subject?: SubjectRef;
}

/** Region/geography intent. Multi-region maps to the `maximum` SLO floor (§3.2.1); named provider regions are unsupported in v1 core vocabulary. */
export interface RegionFacet extends FacetBase {
  facet: 'region';
  multiRegion?: boolean;
  regions?: string[];
}

/** Backup intent (§3.2.6), including the §3.5 "Add disaster recovery" directive. */
export interface BackupFacet extends FacetBase {
  facet: 'backup';
  backup?: 'required' | 'preferred' | 'none';
  disasterRecovery?: boolean;
  subject?: SubjectRef;
}

/** RPO/RTO intent (duration grammar, §3.2.7). */
export interface RecoveryObjectiveFacet extends FacetBase {
  facet: 'recovery-objective';
  rpo?: string;
  rto?: string;
  subject?: SubjectRef;
}

/** Security requirements expressible in core vocabulary. */
export interface SecurityFacet extends FacetBase {
  facet: 'security';
  requirement: 'encryption' | 'encryption-at-rest' | 'encryption-in-transit' | 'tls-minimum-1.3';
  subject?: SubjectRef;
}

/** Compliance framework intent (closed ch. 17 vocabulary). */
export interface ComplianceFacet extends FacetBase {
  facet: 'compliance';
  framework: ComplianceFramework;
}

/** Budget intent. Amounts are INTEGERS (whole currency units) — no floating point feeds any deterministic path. */
export interface BudgetFacet extends FacetBase {
  facet: 'budget';
  amountUsd?: number;
  period: 'monthly';
  /** The §3.5 "Reduce expected cost" directive (no target amount stated). */
  reduce?: boolean;
}

/** Operational/observability requirements (§3.2.5). */
export interface OperationalFacet extends FacetBase {
  facet: 'operational';
  requirement: 'logs' | 'metrics' | 'traces';
  level?: 'required' | 'preferred';
}

/** Provider preference. Recorded as a non-semantic annotation only (ch. 19 §19.5) — documents stay provider-neutral. */
export interface ProviderPreferenceFacet extends FacetBase {
  facet: 'provider-preference';
  provider: string;
}

/** A reference to a resource the user asserts already exists. */
export interface ExistingResourceFacet extends FacetBase {
  facet: 'existing-resource';
  reference: string;
}

/** The §3.5 "Remove the X" directive. */
export interface RemovalFacet extends FacetBase {
  facet: 'removal';
  subject: SubjectRef;
}

export type IntentFacet =
  | EnvironmentFacet
  | WorkloadFacet
  | ApplicationFacet
  | DataServiceFacet
  | MessagingFacet
  | NetworkingFacet
  | ExposureFacet
  | IdentityFacet
  | SecretFacet
  | AvailabilityFacet
  | ScalingFacet
  | RegionFacet
  | BackupFacet
  | RecoveryObjectiveFacet
  | SecurityFacet
  | ComplianceFacet
  | BudgetFacet
  | OperationalFacet
  | ProviderPreferenceFacet
  | ExistingResourceFacet
  | RemovalFacet;

/** A stretch of input no pattern parsed. Reported explicitly — unparsed input never silently drops. */
export interface UnparsedSpan {
  sourceSpan: SourceSpan;
  reason: string;
}

/**
 * A requested capability outside the v1 core kind/field vocabulary
 * (provider-specific products, reserved kinds, out-of-scope services).
 * Surfaced explicitly — never guessed into extensions (ch. 19 §19.7).
 */
export interface UnsupportedFinding {
  capability: string;
  sourceSpan: SourceSpan;
  reason: string;
  /** Provider-neutral vocabulary that could express the intent, when one exists. */
  suggestion?: string;
}

/** Token/cost counts SUPPLIED by an adapter (integers); limits are enforced by the M3.4 middleware. */
export interface AdapterUsage {
  inputTokens: number;
  outputTokens: number;
  costMicrocents?: number;
}

/**
 * What an adapter returns for one authoring request: facets plus the explicit
 * reports for what was NOT understood. Advanced adapters MAY additionally
 * return a direct proposal batch (`proposal`), which the middleware validates
 * via `validateBatchStructure` — facets are validated against the facet
 * schema either way. `explain` marks the §3.5 "Explain what changes this
 * request will make" directive: render `explainBatch` instead of committing.
 */
export interface ExtractionResult {
  facets: IntentFacet[];
  unparsed: UnparsedSpan[];
  unsupported: UnsupportedFinding[];
  explain?: boolean;
  proposal?: unknown;
  usage?: AdapterUsage;
}

/* ------------------------------------------------------------------ */
/* Embedded intent-facets/v1 schema (structured-output enforcement)    */
/* ------------------------------------------------------------------ */

type SchemaObject = Record<string, unknown>;

const RESOURCE_ID = { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' };
const DURATION = { type: 'string', pattern: '^[0-9]+(ms|s|m|h|d)$' };
const QUANTITY = { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$' };

function facetBranch(
  type: FacetType,
  properties: SchemaObject,
  required: string[] = [],
): SchemaObject {
  return {
    type: 'object',
    required: ['facet', 'sourceSpan', 'confidence', 'channel', ...required],
    properties: {
      facet: { const: type },
      sourceSpan: { $ref: '#/$defs/sourceSpan' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      channel: { enum: [...EXTRACTION_CHANNELS] },
      ...properties,
    },
    additionalProperties: false,
  };
}

function buildIntentFacetsSchema(): JsonSchema {
  const subjectRef = { $ref: '#/$defs/subjectRef' };
  const branches: SchemaObject[] = [
    facetBranch(
      'environment',
      { environments: { type: 'array', minItems: 1, items: RESOURCE_ID } },
      ['environments'],
    ),
    facetBranch(
      'workload',
      {
        workload: { enum: ['Service', 'Job', 'Function', 'Gateway'] },
        name: RESOURCE_ID,
        artifact: { type: 'string', minLength: 1 },
        schedule: { type: 'string', minLength: 1 },
      },
      ['workload'],
    ),
    facetBranch('application', { name: RESOURCE_ID }),
    facetBranch(
      'data-service',
      {
        service: { enum: ['database', 'cache', 'object-store', 'volume'] },
        databaseClass: {
          enum: ['relational', 'document', 'key-value', 'graph', 'timeseries', 'vector'],
        },
        engine: { type: 'string', minLength: 1 },
        engineVersion: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)*$' },
        storage: QUANTITY,
        name: RESOURCE_ID,
        attachTo: subjectRef,
      },
      ['service'],
    ),
    facetBranch(
      'messaging',
      { messaging: { enum: ['queue', 'topic', 'unspecified'] }, name: RESOURCE_ID },
      ['messaging'],
    ),
    facetBranch(
      'networking',
      {
        intent: {
          enum: ['connect', 'route', 'publish', 'consume', 'store', 'remove-public-access'],
        },
        from: subjectRef,
        to: subjectRef,
      },
      ['intent'],
    ),
    facetBranch(
      'exposure',
      { exposure: { enum: ['public', 'internal', 'private'] }, subject: subjectRef },
      ['exposure'],
    ),
    facetBranch('identity', { name: RESOURCE_ID }),
    facetBranch('secret', { name: RESOURCE_ID, rotation: { type: 'boolean' } }),
    facetBranch(
      'availability',
      { availability: { enum: ['standard', 'high', 'maximum'] }, subject: subjectRef },
      ['availability'],
    ),
    facetBranch('scaling', {
      min: { type: 'integer', minimum: 0 },
      max: { type: 'integer', minimum: 1 },
      subject: subjectRef,
    }),
    facetBranch('region', {
      multiRegion: { type: 'boolean' },
      regions: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    }),
    facetBranch('backup', {
      backup: { enum: ['required', 'preferred', 'none'] },
      disasterRecovery: { type: 'boolean' },
      subject: subjectRef,
    }),
    facetBranch('recovery-objective', { rpo: DURATION, rto: DURATION, subject: subjectRef }),
    facetBranch(
      'security',
      {
        requirement: {
          enum: ['encryption', 'encryption-at-rest', 'encryption-in-transit', 'tls-minimum-1.3'],
        },
        subject: subjectRef,
      },
      ['requirement'],
    ),
    facetBranch('compliance', { framework: { enum: [...COMPLIANCE_FRAMEWORKS] } }, ['framework']),
    facetBranch(
      'budget',
      {
        amountUsd: { type: 'integer', minimum: 0 },
        period: { const: 'monthly' },
        reduce: { type: 'boolean' },
      },
      ['period'],
    ),
    facetBranch(
      'operational',
      {
        requirement: { enum: ['logs', 'metrics', 'traces'] },
        level: { enum: ['required', 'preferred'] },
      },
      ['requirement'],
    ),
    facetBranch('provider-preference', { provider: { type: 'string', minLength: 1 } }, [
      'provider',
    ]),
    facetBranch('existing-resource', { reference: RESOURCE_ID }, ['reference']),
    facetBranch('removal', { subject: subjectRef }, ['subject']),
  ];

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://iap.dev/schema/intent-facets-v1.schema.json',
    title: 'IaP Intent Facets v1',
    type: 'object',
    required: ['facets', 'unparsed', 'unsupported'],
    properties: {
      facets: { type: 'array', items: { oneOf: branches } },
      unparsed: {
        type: 'array',
        items: {
          type: 'object',
          required: ['sourceSpan', 'reason'],
          properties: {
            sourceSpan: { $ref: '#/$defs/sourceSpan' },
            reason: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      unsupported: {
        type: 'array',
        items: {
          type: 'object',
          required: ['capability', 'sourceSpan', 'reason'],
          properties: {
            capability: { type: 'string', minLength: 1 },
            sourceSpan: { $ref: '#/$defs/sourceSpan' },
            reason: { type: 'string', minLength: 1 },
            suggestion: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      explain: { type: 'boolean' },
      proposal: true,
      usage: {
        type: 'object',
        required: ['inputTokens', 'outputTokens'],
        properties: {
          inputTokens: { type: 'integer', minimum: 0 },
          outputTokens: { type: 'integer', minimum: 0 },
          costMicrocents: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
    $defs: {
      sourceSpan: {
        type: 'object',
        required: ['input', 'start', 'end'],
        properties: {
          input: { type: 'string' },
          start: { type: 'integer', minimum: 0 },
          end: { type: 'integer', minimum: 0 },
          text: { type: 'string' },
        },
        additionalProperties: false,
      },
      subjectRef: {
        type: 'object',
        minProperties: 1,
        properties: {
          resourceId: RESOURCE_ID,
          kind: { enum: [...KINDS] },
        },
        additionalProperties: false,
      },
    },
  } as JsonSchema;
}

let cachedSchema: JsonSchema | undefined;

/** The embedded intent-facets/v1 schema (adapter structured-output contract; embedded-only by design). */
export function intentFacetsSchema(): JsonSchema {
  cachedSchema ??= buildIntentFacetsSchema();
  return cachedSchema;
}

/** One structural problem in an extraction result. */
export interface ExtractionStructureIssue {
  path: string;
  message: string;
}

export type ExtractionStructureResult =
  { ok: true; result: ExtractionResult } | { ok: false; issues: ExtractionStructureIssue[] };

let cachedValidator: ValidateFunction | undefined;

/**
 * Validate a value against the intent-facets/v1 schema (strict ajv with the
 * x-iap vocabulary, all errors collected). This is the facet half of the M3.4
 * structured-output enforcement; direct proposal batches are validated
 * separately via `validateBatchStructure`.
 */
export function validateExtractionStructure(value: unknown): ExtractionStructureResult {
  const validator = (cachedValidator ??= createValidator(intentFacetsSchema()));
  if (validator(value)) {
    return { ok: true, result: value as ExtractionResult };
  }
  const issues = (validator.errors ?? []).map((error) => ({
    path: error.instancePath || '/',
    message: error.message ?? 'violates the intent-facets schema',
  }));
  return {
    ok: false,
    issues: issues.length > 0 ? issues : [{ path: '/', message: 'invalid extraction result' }],
  };
}
