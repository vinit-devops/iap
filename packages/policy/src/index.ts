/**
 * @iap/policy — deterministic policy evaluation engine (spec ch. 7; validation
 * phase 5, IAP5xx; M9.1–M9.3).
 *
 * Evaluates the `policies` array of a canonical document against its resources
 * per the ch. 7 semantics:
 *
 * - **Input.** The canonical, defaults-applied document (ch. 7 §7.6): callers
 *   pass a `CanonicalModel` from `@iap/model`'s `canonicalize` (or any
 *   `{resources, policies}` pair already in that shape). Policies never see
 *   the pre-merge document.
 * - **Targeting.** A resource is targeted when it matches both `target.kinds`
 *   (if present) and `target.selector` (if present); `target: {}` — or an
 *   absent target — targets every resource (ch. 7 §7.2).
 * - **Condition trees.** `allOf`/`anyOf`/`not` combinators over
 *   `{field, operator, value}` leaves; `field` is a dot path from the resource
 *   entry root (ch. 7 §7.3). Unresolved paths: `absent` → true, `exists` →
 *   false, every other operator → false.
 * - **Ordered comparisons** (ch. 7 §7.4) are defined over exactly three
 *   domains — numbers, quantities, durations — using `@iap/model`'s
 *   exact-rational BigInt parsing (never floating point). Operands in
 *   different domains are a type mismatch: the leaf evaluates **false** and a
 *   diagnostic **IAP504** warning is reported.
 * - **`matches`** evaluates the pattern with the JavaScript `RegExp` engine as
 *   a documented RE2-subset approximation: patterns using backreferences
 *   (`\1`–`\9`) or lookbehind (`(?<=`, `(?<!`) — constructs RE2 rejects by
 *   design — are refused with an IAP504-style warning and the leaf evaluates
 *   false. Other RegExp constructs outside RE2 (e.g. lookahead) are currently
 *   accepted; a linear-time RE2 engine may replace this without changing the
 *   contract for RE2-valid patterns.
 * - **Effects** (ch. 7 §7.5): `deny` → IAP501 error where the condition holds
 *   (the condition describes the forbidden state); `warn` → IAP503 warning
 *   where it holds; `require` → IAP502 error where it does NOT hold. `require`
 *   rules that are an `equals` leaf or an `allOf` conjunction of `equals`
 *   leaves are autofix-eligible: an RFC 7386 merge patch setting each field to
 *   its value is emitted alongside the finding (never applied silently).
 * - **Determinism** (ch. 7 §7.6): policies evaluate in lexicographic order of
 *   `id`, resources in lexicographic order of resource ID; findings,
 *   evaluations, and autofixes follow that order byte for byte. No
 *   `Date.now()` anywhere: when exceptions are supplied the caller MUST inject
 *   the evaluation instant via `options.now` (ISO 8601) — a `TypeError` is
 *   thrown otherwise, so time never enters the library implicitly.
 * - **Exceptions** (roadmap phase 9): a `PolicyException` carries scope
 *   (policyId + optional kind/label selector), reason, approver, expiry, and
 *   optional ticket. An error finding matched by an unexpired exception is
 *   downgraded to a warning with the exception audit trail appended to its
 *   message; expired exceptions are ignored and surfaced as IAP503 "expired
 *   exception" warnings so they remain visible until removed.
 */

import { compareCodePoints, parseDuration, parseQuantity } from '@iap/model';
import type { CanonicalModel, Finding, Policy, PolicyCondition } from '@iap/model';

export { POLICY_PACKS } from './packs.js';

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>;

/**
 * Minimal resource shape the evaluator reads — a `CanonicalResource` (or a
 * raw `ResourceEntry`) satisfies it. Dot paths resolve against the whole
 * entry, so `kind`, `labels.*`, `spec.*`, and `x-*` annotation paths all work.
 */
export interface PolicyResource {
  kind: string;
  labels?: Record<string, string>;
  spec?: Record<string, unknown>;
}

/** Anything evaluatable: a full `CanonicalModel` or a bare `{resources, policies}` pair. */
export interface PolicyEvaluationInput {
  resources: Record<string, PolicyResource>;
  policies: Policy[];
}

/**
 * A policy exception (roadmap phase 9 exception workflow): scope, reason,
 * approver, expiry, and ticket/evidence. Exceptions are supplied by the
 * caller (they are organizational state, not document content) and are
 * resolved per (policyId, resource).
 */
export interface PolicyException {
  /** The policy `id` this exception exempts. */
  policyId: string;
  /** Optional scope narrowing: only resources matching kinds AND labels are exempted. */
  selector?: { kinds?: string[]; labels?: Record<string, string> };
  reason: string;
  approver: string;
  /** ISO 8601 instant or date; the exception is active strictly before this instant. */
  expiry: string;
  ticket?: string;
}

export interface EvaluatePoliciesOptions {
  exceptions?: PolicyException[];
  /**
   * The evaluation instant (ISO 8601) used to decide exception expiry.
   * REQUIRED when `exceptions` is non-empty — the library never reads the
   * clock itself (`Date.now()` would break determinism); a `TypeError` is
   * thrown when exceptions are supplied without `now`.
   */
  now?: string;
}

/** One (policy, resource) evaluation trace entry. */
export interface PolicyEvaluation {
  policyId: string;
  resourceId: string;
  /** True when the resource is targeted by the policy (kinds AND selector). */
  matched: boolean;
  verdict: 'not-targeted' | 'pass' | 'violation' | 'exempted';
}

/** A deterministic autofix proposal: an RFC 7386 merge patch for the resource entry. */
export interface PolicyAutofix {
  policyId: string;
  resourceId: string;
  /** RFC 7386 merge patch against the resource entry (ch. 7 §7.5). */
  patch: JsonObject;
}

export interface PolicyResult {
  findings: Finding[];
  evaluations: PolicyEvaluation[];
  autofixes: PolicyAutofix[];
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep JSON equality after canonicalization (key order irrelevant; ch. 7 §7.4 `equals`). */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEquals(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every(
        (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEquals(a[key], b[key]),
      )
    );
  }
  return false;
}

const UNRESOLVED: unique symbol = Symbol('unresolved');

/**
 * Resolve a dot path from the resource entry root (ch. 7 §7.3). Segments are
 * literal keys — no wildcards, indexing, or quantifiers; resolution descends
 * plain objects only, so a path into an array or scalar does not resolve.
 */
function resolvePath(resource: PolicyResource, field: string): unknown {
  let current: unknown = resource;
  for (const segment of field.split('.')) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return UNRESOLVED;
    }
    current = current[segment];
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* Target matching (ch. 7 §7.2)                                        */
/* ------------------------------------------------------------------ */

function selectorMatches(
  resource: PolicyResource,
  selector: { kinds?: string[]; labels?: Record<string, string> },
): boolean {
  if (Array.isArray(selector.kinds) && !selector.kinds.includes(resource.kind)) return false;
  const wanted = isPlainObject(selector.labels) ? selector.labels : {};
  const actual = isPlainObject(resource.labels) ? resource.labels : {};
  for (const [key, value] of Object.entries(wanted)) {
    if (actual[key] !== value) return false;
  }
  return true;
}

/** A resource is targeted when it matches both `kinds` and `selector`; both optional. */
function isTargeted(resource: PolicyResource, policy: Policy): boolean {
  const target = isPlainObject(policy.target) ? policy.target : {};
  const kinds = target.kinds;
  if (Array.isArray(kinds) && !(kinds as string[]).includes(resource.kind)) return false;
  const selector = target.selector;
  if (isPlainObject(selector) && !selectorMatches(resource, selector)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Ordered comparisons (ch. 7 §7.4) — exact three-domain semantics     */
/* ------------------------------------------------------------------ */

type OrderedOutcome =
  { kind: 'ordered'; comparison: -1 | 0 | 1 } | { kind: 'mismatch'; detail: string };

/**
 * Compare two operands in one of the three ordered domains: numbers,
 * quantities (exact BigInt milli-units), durations (exact BigInt
 * milliseconds). A string that parses in both grammars (only possible with
 * the shared `m` suffix, where both interpretations are strictly monotonic in
 * the mantissa) is compared as a quantity — the order is identical either
 * way. Any other pairing is a type mismatch (IAP504; leaf false).
 */
function orderedCompare(resolved: unknown, value: unknown): OrderedOutcome {
  if (typeof resolved === 'number' && typeof value === 'number') {
    return { kind: 'ordered', comparison: resolved < value ? -1 : resolved > value ? 1 : 0 };
  }
  if (typeof resolved === 'string' && typeof value === 'string') {
    const qa = parseQuantity(resolved);
    const qb = parseQuantity(value);
    if (qa !== null && qb !== null) {
      return {
        kind: 'ordered',
        comparison: qa.milli < qb.milli ? -1 : qa.milli > qb.milli ? 1 : 0,
      };
    }
    const da = parseDuration(resolved);
    const db = parseDuration(value);
    if (da !== null && db !== null) {
      return { kind: 'ordered', comparison: da.ms < db.ms ? -1 : da.ms > db.ms ? 1 : 0 };
    }
    return {
      kind: 'mismatch',
      detail: `operands ${JSON.stringify(resolved)} and ${JSON.stringify(value)} do not parse in the same domain (number, quantity, or duration)`,
    };
  }
  return {
    kind: 'mismatch',
    detail: `operands of type ${typeName(resolved)} and ${typeName(value)} are not orderable — ordered comparisons are defined over numbers, quantities, and durations only`,
  };
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/* ------------------------------------------------------------------ */
/* `matches` — RE2-subset regular expressions (ch. 7 §7.4)             */
/* ------------------------------------------------------------------ */

/**
 * Detect the RegExp constructs this engine refuses because RE2 rejects them
 * by design (they require backtracking): backreferences `\1`–`\9` and
 * lookbehind `(?<=` / `(?<!`. Escape-aware scan: `\\1` is an escaped
 * backslash followed by a literal `1`, not a backreference.
 */
function unsupportedRe2Construct(pattern: string): string | null {
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next !== undefined && next >= '1' && next <= '9') {
        return `backreference \\${next}`;
      }
      i += 1; // skip the escaped character
    } else if (ch === '(' && pattern.startsWith('(?<', i)) {
      const qualifier = pattern[i + 3];
      if (qualifier === '=' || qualifier === '!') {
        return `lookbehind (?<${qualifier}`;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Condition evaluation (ch. 7 §7.3–§7.4)                              */
/* ------------------------------------------------------------------ */

interface LeafDiagnostic {
  field: string;
  message: string;
}

interface EvalContext {
  resource: PolicyResource;
  /** IAP504 diagnostics collected during evaluation (deterministic order). */
  diagnostics: LeafDiagnostic[];
}

function evaluateCondition(condition: PolicyCondition, ctx: EvalContext): boolean {
  if ('allOf' in condition && Array.isArray(condition.allOf)) {
    // No short-circuit: every child evaluates so IAP504 diagnostics are
    // complete and deterministic regardless of sibling outcomes.
    return condition.allOf.map((child) => evaluateCondition(child, ctx)).every(Boolean);
  }
  if ('anyOf' in condition && Array.isArray(condition.anyOf)) {
    return condition.anyOf.map((child) => evaluateCondition(child, ctx)).some(Boolean);
  }
  if ('not' in condition && condition.not !== undefined) {
    return !evaluateCondition(condition.not as PolicyCondition, ctx);
  }
  return evaluateLeaf(condition as { field: string; operator: string; value?: unknown }, ctx);
}

function evaluateLeaf(
  leaf: { field: string; operator: string; value?: unknown },
  ctx: EvalContext,
): boolean {
  const resolved = resolvePath(ctx.resource, leaf.field);

  // Unresolved paths (ch. 7 §7.3): absent → true, exists → false, others → false.
  if (resolved === UNRESOLVED) return leaf.operator === 'absent';

  switch (leaf.operator) {
    case 'absent':
      return false;
    case 'exists':
      return true;
    case 'equals':
      return deepEquals(resolved, leaf.value);
    case 'not-equals':
      return !deepEquals(resolved, leaf.value);
    case 'in':
      return Array.isArray(leaf.value) && leaf.value.some((item) => deepEquals(resolved, item));
    case 'not-in':
      return Array.isArray(leaf.value) && !leaf.value.some((item) => deepEquals(resolved, item));
    case 'greater-than':
    case 'less-than': {
      const outcome = orderedCompare(resolved, leaf.value);
      if (outcome.kind === 'mismatch') {
        ctx.diagnostics.push({
          field: leaf.field,
          message: `operand type mismatch in ${leaf.operator} on ${leaf.field}: ${outcome.detail}; the leaf evaluates false (ch. 7 §7.4)`,
        });
        return false;
      }
      return leaf.operator === 'greater-than' ? outcome.comparison > 0 : outcome.comparison < 0;
    }
    case 'matches': {
      if (typeof resolved !== 'string' || typeof leaf.value !== 'string') return false;
      const unsupported = unsupportedRe2Construct(leaf.value);
      if (unsupported !== null) {
        ctx.diagnostics.push({
          field: leaf.field,
          message: `pattern ${JSON.stringify(leaf.value)} uses ${unsupported}, which RE2 rejects by design and this engine does not support; the leaf evaluates false (ch. 7 §7.4)`,
        });
        return false;
      }
      try {
        return new RegExp(leaf.value, 'u').test(resolved);
      } catch (error) {
        ctx.diagnostics.push({
          field: leaf.field,
          message: `pattern ${JSON.stringify(leaf.value)} is not a valid regular expression (${error instanceof Error ? error.message : String(error)}); the leaf evaluates false (ch. 7 §7.4)`,
        });
        return false;
      }
    }
    default:
      // Unknown operator (schema-invalid input): never fires a rule.
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* Autofix eligibility (ch. 7 §7.5)                                    */
/* ------------------------------------------------------------------ */

/**
 * Collect the `equals` leaves of a rule when — and only when — the rule is an
 * `equals` leaf or an `allOf` conjunction of them (nested `allOf` permitted:
 * it is still a pure conjunction). Any other operator or combinator makes the
 * rule report-only (`in`, `matches`, ordered comparisons, `anyOf`, `not` do
 * not determine a unique compliant value).
 */
function collectAutofixLeaves(
  condition: PolicyCondition,
): Array<{ field: string; value: unknown }> | null {
  if ('allOf' in condition && Array.isArray(condition.allOf)) {
    const leaves: Array<{ field: string; value: unknown }> = [];
    for (const child of condition.allOf) {
      const childLeaves = collectAutofixLeaves(child);
      if (childLeaves === null) return null;
      leaves.push(...childLeaves);
    }
    return leaves;
  }
  if ('field' in condition && condition.operator === 'equals') {
    return [{ field: condition.field, value: condition.value }];
  }
  return null;
}

/** Build the RFC 7386 merge patch that sets each `field` to its `value`. */
function autofixPatch(leaves: Array<{ field: string; value: unknown }>): JsonObject {
  const patch: JsonObject = {};
  for (const { field, value } of leaves) {
    const segments = field.split('.');
    let cursor: JsonObject = patch;
    for (const segment of segments.slice(0, -1)) {
      if (!isPlainObject(cursor[segment])) cursor[segment] = {};
      cursor = cursor[segment] as JsonObject;
    }
    cursor[segments[segments.length - 1] as string] = structuredClone(value);
  }
  return patch;
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

/** Finding path: the leaf field for single-leaf rules, the resource entry otherwise. */
function findingPath(resourceId: string, rule: PolicyCondition): string {
  if ('field' in rule && typeof rule.field === 'string') {
    return `resources.${resourceId}.${rule.field}`;
  }
  return `resources.${resourceId}`;
}

function describeViolation(policy: Policy, resource: PolicyResource, resourceId: string): string {
  const rule = policy.rule;
  if (policy.effect === 'require') {
    if ('field' in rule && rule.operator === 'equals') {
      const found = resolvePath(resource, rule.field);
      const foundText =
        found === UNRESOLVED ? 'the field is absent' : `found ${JSON.stringify(found)}`;
      return `Policy ${policy.id}: ${rule.field} must equal ${JSON.stringify(rule.value)} (${foundText}).`;
    }
    return `Policy ${policy.id}: required condition does not hold for resource "${resourceId}".`;
  }
  const label = policy.effect === 'deny' ? 'forbidden state' : 'warned state';
  if ('field' in rule && typeof rule.field === 'string') {
    const found = resolvePath(resource, rule.field);
    const foundText = found === UNRESOLVED ? '' : ` (${rule.field} is ${JSON.stringify(found)})`;
    return `Policy ${policy.id}: ${label} matched for resource "${resourceId}"${foundText}.`;
  }
  return `Policy ${policy.id}: ${label} matched for resource "${resourceId}".`;
}

/* ------------------------------------------------------------------ */
/* Exceptions (roadmap phase 9 — exception workflow model)             */
/* ------------------------------------------------------------------ */

interface PreparedExceptions {
  /** Unexpired exceptions, in caller order. */
  active: PolicyException[];
  /** IAP503 findings for expired exceptions (deterministic order). */
  expiredFindings: Finding[];
}

function prepareExceptions(options: EvaluatePoliciesOptions): PreparedExceptions {
  const exceptions = options.exceptions ?? [];
  if (exceptions.length === 0) return { active: [], expiredFindings: [] };

  if (typeof options.now !== 'string') {
    throw new TypeError(
      'evaluatePolicies: options.now (ISO 8601 instant) is required when exceptions are provided — the engine never reads the clock itself (determinism; ch. 7 §7.1)',
    );
  }
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) {
    throw new TypeError(
      `evaluatePolicies: options.now ${JSON.stringify(options.now)} is not a parseable ISO 8601 instant`,
    );
  }

  const active: PolicyException[] = [];
  const expired: PolicyException[] = [];
  for (const exception of exceptions) {
    const expiryMs = Date.parse(exception.expiry);
    // An unparseable expiry can never be shown to be active: treat as expired.
    if (Number.isNaN(expiryMs) || expiryMs <= nowMs) {
      expired.push(exception);
    } else {
      active.push(exception);
    }
  }

  const expiredFindings = expired
    .map((exception): Finding => ({
      code: 'IAP503',
      severity: 'warning',
      path: 'policies',
      message: `expired exception: the exception for policy "${exception.policyId}" (reason: ${exception.reason}; approved by ${exception.approver}) expired ${exception.expiry} and was ignored`,
      policyId: exception.policyId,
    }))
    .sort(
      (a, b) =>
        compareCodePoints(a.policyId ?? '', b.policyId ?? '') ||
        compareCodePoints(a.message, b.message),
    );
  return { active, expiredFindings };
}

function activeExceptionFor(
  active: PolicyException[],
  policyId: string,
  resource: PolicyResource,
): PolicyException | undefined {
  return active.find(
    (exception) =>
      exception.policyId === policyId &&
      (exception.selector === undefined || selectorMatches(resource, exception.selector)),
  );
}

/* ------------------------------------------------------------------ */
/* The evaluator                                                       */
/* ------------------------------------------------------------------ */

/**
 * Evaluate every policy against every resource it targets (ch. 7 §7.6):
 * deterministic order (policy `id`, then resource ID, both lexicographic by
 * Unicode code point), collect-all (no short-circuiting across resources, no
 * rule precedence), one resource visible per condition. Pure: identical
 * inputs yield identical results byte for byte; the model is not mutated.
 */
export function evaluatePolicies(
  model: CanonicalModel | PolicyEvaluationInput,
  options: EvaluatePoliciesOptions = {},
): PolicyResult {
  const resources = isPlainObject(model.resources)
    ? (model.resources as Record<string, PolicyResource>)
    : {};
  const policies = Array.isArray(model.policies) ? (model.policies as Policy[]) : [];
  const { active, expiredFindings } = prepareExceptions(options);

  const findings: Finding[] = [];
  const evaluations: PolicyEvaluation[] = [];
  const autofixes: PolicyAutofix[] = [];

  const sortedPolicies = [...policies].sort((a, b) => compareCodePoints(a.id, b.id));
  const sortedResourceIds = Object.keys(resources).sort(compareCodePoints);

  for (const policy of sortedPolicies) {
    for (const resourceId of sortedResourceIds) {
      const resource = resources[resourceId] as PolicyResource;
      if (!isPlainObject(resource)) continue;

      if (!isTargeted(resource, policy)) {
        evaluations.push({
          policyId: policy.id,
          resourceId,
          matched: false,
          verdict: 'not-targeted',
        });
        continue;
      }

      const ctx: EvalContext = { resource, diagnostics: [] };
      const conditionHolds = evaluateCondition(policy.rule, ctx);

      // IAP504 diagnostics surface regardless of the rule outcome (ch. 7 §7.4).
      for (const diagnostic of ctx.diagnostics) {
        findings.push({
          code: 'IAP504',
          severity: 'warning',
          path: `resources.${resourceId}.${diagnostic.field}`,
          message: `Policy ${policy.id}: ${diagnostic.message}`,
          policyId: policy.id,
        });
      }

      const violated =
        policy.effect === 'require' ? !conditionHolds : conditionHolds; /* deny | warn */

      if (!violated) {
        evaluations.push({ policyId: policy.id, resourceId, matched: true, verdict: 'pass' });
        continue;
      }

      const code =
        policy.effect === 'deny' ? 'IAP501' : policy.effect === 'require' ? 'IAP502' : 'IAP503';
      const severity: Finding['severity'] = policy.effect === 'warn' ? 'warning' : 'error';
      const finding: Finding = {
        code,
        severity,
        path: findingPath(resourceId, policy.rule),
        message: describeViolation(policy, resource, resourceId),
        policyId: policy.id,
      };

      let verdict: PolicyEvaluation['verdict'] = 'violation';
      if (severity === 'error') {
        const exception = activeExceptionFor(active, policy.id, resource);
        if (exception !== undefined) {
          finding.severity = 'warning';
          finding.message = `${finding.message} [exception: ${exception.reason} approved by ${exception.approver} until ${exception.expiry}]`;
          verdict = 'exempted';
        }
      }
      findings.push(finding);
      evaluations.push({ policyId: policy.id, resourceId, matched: true, verdict });

      if (policy.effect === 'require') {
        const leaves = collectAutofixLeaves(policy.rule);
        if (leaves !== null) {
          autofixes.push({ policyId: policy.id, resourceId, patch: autofixPatch(leaves) });
        }
      }
    }
  }

  findings.push(...expiredFindings);
  return { findings, evaluations, autofixes };
}
