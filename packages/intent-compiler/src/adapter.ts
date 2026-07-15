/**
 * The model-provider abstraction (M3.4, roadmap §3.6; phase-3 design
 * decision 9): a vendor-neutral `ModelAdapter` interface plus the middleware
 * pipeline every adapter is driven through. No vendor SDK exists in-tree and
 * the interface makes NO network assumption — an adapter is any object with
 * an async `extract`; local models, remote endpoints, and the two in-repo
 * deterministic adapters (fixture replay and the NL rules extractor) all
 * plug in identically.
 *
 * Out-of-tree vendor adapters implement `ModelAdapter`, reference their
 * prompt artifacts by exact id@version from the prompt registry
 * (`prompts.ts`), declare their data residency, and return facets (validated
 * against the intent-facets schema) and optionally a direct proposal batch
 * (validated via `validateBatchStructure`). The middleware enforces:
 *
 * - structured-output with BOUNDED retry/repair: invalid output is returned
 *   to the adapter with the validation issues for repair, at most
 *   `maxAttempts` times; repair means RE-VALIDATION — invalid output is never
 *   auto-accepted, and exhaustion refuses (fail closed);
 * - token/cost limits: counts are supplied by the adapter, limits enforced
 *   here (integer arithmetic only); configured limits with missing counts
 *   fail closed;
 * - redaction hooks: caller-registered functions scrub the request BEFORE it
 *   reaches any adapter (IEP-0013 security posture);
 * - data residency: adapters declare where they process data; a session
 *   config allowlist refuses non-conforming adapters before invocation.
 */

import type { IaPDocument } from '@iap/model';
import { extractRules } from './extract-rules.js';
import { validateExtractionStructure } from './facets.js';
import type { ExtractionResult, ExtractionStructureIssue } from './facets.js';
import { validateBatchStructure } from './schema.js';

/* ------------------------------------------------------------------ */
/* The adapter interface                                               */
/* ------------------------------------------------------------------ */

/** One authoring request presented to an adapter (after redaction). */
export interface AuthoringRequest {
  /** Caller-supplied request identity; spans and recordings key off it. */
  requestId: string;
  /** The natural-language request text. */
  input: string;
  /** The current document, for incremental edits and reference resolution. */
  document?: IaPDocument;
  /** Profile context, when the request is profile-relative. */
  profile?: string | null;
}

/** A prompt artifact reference — always exact id@version, never floating. */
export interface PromptReference {
  id: string;
  version: string;
}

/** Middleware-supplied invocation context. */
export interface AdapterContext {
  /** 1-based attempt number within the bounded retry/repair loop. */
  attempt: number;
  /** The session's attempt bound. */
  maxAttempts: number;
  /** Validation issues from the previous attempt, for repair. */
  repair?: ExtractionStructureIssue[];
}

/**
 * A vendor-neutral model adapter. `extract` maps one authoring request to an
 * `ExtractionResult` (facets + explicit unparsed/unsupported reports,
 * optionally a direct proposal batch and usage counts). The interface makes
 * no network assumption; determinism obligations live with the caller's
 * flow — everything an adapter returns is validated and gated regardless.
 */
export interface ModelAdapter {
  id: string;
  version: string;
  /** Declared data residency/locality (e.g. `local`, `eu`, `us`). Enforced against the session config. */
  residency: string;
  /** Prompt artifacts this adapter uses (audit data; exact versions only). */
  prompts?: readonly PromptReference[];
  extract(request: AuthoringRequest, context: AdapterContext): Promise<ExtractionResult>;
}

/* ------------------------------------------------------------------ */
/* Middleware pipeline                                                 */
/* ------------------------------------------------------------------ */

/** Closed middleware refusal taxonomy. */
export const ADAPTER_ERROR_CODES = [
  'residency-refused',
  'structured-output-invalid',
  'attempts-exhausted',
  'token-limit-exceeded',
  'cost-limit-exceeded',
  'adapter-failure',
] as const;

export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

export interface AdapterRefusal {
  code: AdapterErrorCode;
  message: string;
  path?: string;
}

export type AdapterOutcome =
  | { ok: true; result: ExtractionResult; attempts: number }
  | { ok: false; refusals: AdapterRefusal[] };

/** Integer token/cost limits enforced by the middleware. */
export interface AdapterLimits {
  maxInputTokensPerRequest?: number;
  maxOutputTokensPerRequest?: number;
  maxTotalTokensPerRequest?: number;
  /** Cumulative session cost ceiling, in microcents (integer). */
  maxSessionCostMicrocents?: number;
}

/** A caller-registered redaction hook: scrubs the request before ANY adapter sees it. */
export type RedactionHook = (request: AuthoringRequest) => AuthoringRequest;

export interface AdapterSessionConfig {
  /** Bounded retry/repair attempts (default 2, minimum 1). */
  maxAttempts?: number;
  limits?: AdapterLimits;
  redactors?: RedactionHook[];
  /** Data-residency allowlist; adapters declaring anything else are refused before invocation. */
  residency?: { allowed: string[] };
}

export interface AdapterSessionUsage {
  inputTokens: number;
  outputTokens: number;
  costMicrocents: number;
  requests: number;
}

export interface AdapterSession {
  adapterId: string;
  adapterVersion: string;
  extract(request: AuthoringRequest): Promise<AdapterOutcome>;
  /** Cumulative session usage (integers). */
  usage(): AdapterSessionUsage;
}

/**
 * Wrap an adapter in the enforcement middleware. The returned session is the
 * ONLY sanctioned way to drive an adapter: redaction, structured-output
 * enforcement with bounded repair, token/cost limits, and residency checks
 * all live here, not in adapters.
 */
export function createAdapterSession(
  adapter: ModelAdapter,
  config: AdapterSessionConfig = {},
): AdapterSession {
  const maxAttempts = config.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(`maxAttempts must be an integer >= 1; received ${String(maxAttempts)}`);
  }
  const totals: AdapterSessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    costMicrocents: 0,
    requests: 0,
  };

  const checkLimits = (result: ExtractionResult): AdapterRefusal[] => {
    const limits = config.limits;
    if (limits === undefined) return [];
    const refusals: AdapterRefusal[] = [];
    const usage = result.usage;
    const tokenLimitSet =
      limits.maxInputTokensPerRequest !== undefined ||
      limits.maxOutputTokensPerRequest !== undefined ||
      limits.maxTotalTokensPerRequest !== undefined;
    if (tokenLimitSet && usage === undefined) {
      refusals.push({
        code: 'token-limit-exceeded',
        message:
          'token limits are configured but the adapter supplied no usage counts — failing closed',
      });
      return refusals;
    }
    if (usage !== undefined) {
      if (
        limits.maxInputTokensPerRequest !== undefined &&
        usage.inputTokens > limits.maxInputTokensPerRequest
      ) {
        refusals.push({
          code: 'token-limit-exceeded',
          message: `input tokens ${usage.inputTokens} exceed the per-request limit ${limits.maxInputTokensPerRequest}`,
        });
      }
      if (
        limits.maxOutputTokensPerRequest !== undefined &&
        usage.outputTokens > limits.maxOutputTokensPerRequest
      ) {
        refusals.push({
          code: 'token-limit-exceeded',
          message: `output tokens ${usage.outputTokens} exceed the per-request limit ${limits.maxOutputTokensPerRequest}`,
        });
      }
      if (
        limits.maxTotalTokensPerRequest !== undefined &&
        usage.inputTokens + usage.outputTokens > limits.maxTotalTokensPerRequest
      ) {
        refusals.push({
          code: 'token-limit-exceeded',
          message: `total tokens ${usage.inputTokens + usage.outputTokens} exceed the per-request limit ${limits.maxTotalTokensPerRequest}`,
        });
      }
    }
    if (limits.maxSessionCostMicrocents !== undefined) {
      if (usage?.costMicrocents === undefined) {
        refusals.push({
          code: 'cost-limit-exceeded',
          message:
            'a session cost limit is configured but the adapter supplied no cost — failing closed',
        });
      } else if (totals.costMicrocents > limits.maxSessionCostMicrocents) {
        refusals.push({
          code: 'cost-limit-exceeded',
          message: `cumulative session cost ${totals.costMicrocents} microcents exceeds the limit ${limits.maxSessionCostMicrocents}`,
        });
      }
    }
    return refusals;
  };

  const account = (result: unknown): void => {
    const usage = (result as ExtractionResult | undefined)?.usage;
    if (usage === undefined || typeof usage !== 'object') return;
    if (Number.isInteger(usage.inputTokens) && usage.inputTokens >= 0) {
      totals.inputTokens += usage.inputTokens;
    }
    if (Number.isInteger(usage.outputTokens) && usage.outputTokens >= 0) {
      totals.outputTokens += usage.outputTokens;
    }
    if (
      usage.costMicrocents !== undefined &&
      Number.isInteger(usage.costMicrocents) &&
      usage.costMicrocents >= 0
    ) {
      totals.costMicrocents += usage.costMicrocents;
    }
  };

  return {
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    usage: () => ({ ...totals }),
    async extract(request: AuthoringRequest): Promise<AdapterOutcome> {
      // Residency: refused BEFORE the adapter (or any redacted data) is touched.
      if (config.residency !== undefined && !config.residency.allowed.includes(adapter.residency)) {
        return {
          ok: false,
          refusals: [
            {
              code: 'residency-refused',
              message: `adapter "${adapter.id}" declares residency "${adapter.residency}", which the session config does not allow (${config.residency.allowed.join(', ')})`,
            },
          ],
        };
      }

      // Redaction: every registered hook runs, in registration order.
      let redacted = request;
      for (const redactor of config.redactors ?? []) {
        redacted = redactor(redacted);
      }

      let lastIssues: ExtractionStructureIssue[] = [];
      let lastCode: AdapterErrorCode = 'structured-output-invalid';
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        totals.requests += 1;
        let raw: ExtractionResult;
        try {
          const context: AdapterContext = { attempt, maxAttempts };
          if (lastIssues.length > 0) context.repair = lastIssues;
          raw = await adapter.extract(redacted, context);
        } catch (error) {
          lastCode = 'adapter-failure';
          lastIssues = [
            { path: '/', message: error instanceof Error ? error.message : String(error) },
          ];
          continue;
        }
        account(raw);

        // Structured-output enforcement: facets against the facet schema,
        // any direct proposal via the operations companion schema. Repair
        // means re-validation — never auto-acceptance.
        const structural = validateExtractionStructure(raw);
        if (!structural.ok) {
          lastCode = 'structured-output-invalid';
          lastIssues = structural.issues;
          continue;
        }
        if (raw.proposal !== undefined) {
          const proposalCheck = validateBatchStructure(raw.proposal);
          if (!proposalCheck.ok) {
            lastCode = 'structured-output-invalid';
            lastIssues = proposalCheck.refusals.map((refusal) => ({
              path: refusal.path ?? '/proposal',
              message: `proposal: ${refusal.message}`,
            }));
            continue;
          }
        }

        const limitRefusals = checkLimits(structural.result);
        if (limitRefusals.length > 0) return { ok: false, refusals: limitRefusals };
        return { ok: true, result: structural.result, attempts: attempt };
      }

      return {
        ok: false,
        refusals: [
          {
            code: 'attempts-exhausted',
            message: `adapter "${adapter.id}" produced no valid extraction in ${maxAttempts} attempt(s) — refusing (repair never auto-accepts)`,
          },
          ...lastIssues.slice(0, 5).map((issue): AdapterRefusal => ({
            code: lastCode,
            message: issue.message,
            path: issue.path,
          })),
        ],
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* In-repo adapters (phase-3 design decision 9)                        */
/* ------------------------------------------------------------------ */

export interface FixtureAdapterIdentity {
  id?: string;
  version?: string;
  residency?: string;
}

/**
 * The fixture adapter: replays recorded `ExtractionResult`s keyed by request
 * id — the evaluation and OP-2 model-independence workhorse. Recordings are
 * data; a missing recording throws, which the middleware surfaces as
 * `adapter-failure`/`attempts-exhausted` (fail closed, never an empty guess).
 */
export function fixtureAdapter(
  recordings: Record<string, ExtractionResult>,
  identity: FixtureAdapterIdentity = {},
): ModelAdapter {
  return {
    id: identity.id ?? 'iap-fixture',
    version: identity.version ?? '1',
    residency: identity.residency ?? 'local',
    extract: (request: AuthoringRequest): Promise<ExtractionResult> => {
      const recording = recordings[request.requestId];
      if (recording === undefined) {
        return Promise.reject(
          new Error(`no recording for request "${request.requestId}" (fixture adapter)`),
        );
      }
      return Promise.resolve(structuredClone(recording));
    },
  };
}

/**
 * The rules adapter: the deterministic NL rules extractor behind the same
 * interface — the offline authoring path. No model, no network, no prompts;
 * residency is `local` by construction.
 */
export function rulesAdapter(): ModelAdapter {
  return {
    id: 'iap-rules',
    version: '1',
    residency: 'local',
    extract: (request: AuthoringRequest): Promise<ExtractionResult> => {
      const options: { inputId: string; document?: IaPDocument } = { inputId: request.requestId };
      if (request.document !== undefined) options.document = request.document;
      return Promise.resolve(extractRules(request.input, options));
    },
  };
}
