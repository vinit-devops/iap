/**
 * @iap/planner — the deterministic planner for IaP v1 (spec ch. 14,
 * IEP-0011, phase-7 design decisions 1–9):
 *
 * - **inputs** — the closed nine-element determinism input vector,
 *   `computeInputsHash`, and the minimal IEP-0010 state-snapshot subset
 *   (`emptySnapshot`, `computeStateIntegrity`).
 * - **diff** — semantic per-attribute diff of the desired provider-resource
 *   model against the actual snapshot, on canonical values.
 * - **lifecycle** — the closed action rule order (create / import / replace /
 *   update-in-place / delete), statefulness derivation, and reversibility
 *   classification per ch. 14 §14.6.
 * - **scheduler** — longest-path forward waves over `dependsOn` with
 *   transitive ordering through no-op nodes; delete waves after forward
 *   waves in reverse dependency order (ch. 14 §14.3–§14.4).
 * - **risk** — the versioned pure rule table (`riskRuleTableV1`, folded into
 *   PLANNER_VERSION): ordinal integer weights per action × reversibility
 *   class plus security-boundary factors, classified by explicit thresholds.
 * - **plan** — `buildPlan`/`plan` assembling canonical `plan.iap.dev/v1`
 *   content hashed to `planId`: waves, destructive marking, rollback
 *   limitations, approval gates, honest deltas, and the injectable
 *   risk-annotator seam.
 * - **envelope** — `signPlan` (ed25519 over the canonical
 *   {createdAt, expiresAt, planId} form, injected timestamps only) and the
 *   PL-2 `verifyPlan`/`refuseIfInvalid` fail-closed invalidation rule with
 *   its closed refusal taxonomy.
 * - **validate** — `validatePlanArtifact` against the embedded companion
 *   schema (strict ajv, drift-tested against `spec/schema`).
 */

export {
  PLAN_API_VERSION,
  PLANNER_VERSION,
  computeInputsHash,
  computeStateIntegrity,
  emptySnapshot,
  sha256Digest,
} from './inputs.js';
export type {
  DeploymentTarget,
  DeterminismInputs,
  PlanInputs,
  StateObject,
  StateSnapshot,
} from './inputs.js';

export { diffAttributes, diffResources, isEmptyDiff } from './diff.js';
export type { AttributeDiff, ResourceDiff } from './diff.js';

export {
  IDENTITY_ELEMENTS,
  PLAN_ACTIONS,
  REVERSIBILITY_CLASSES,
  STATEFUL_KINDS,
  classifyReversibility,
  deriveStatefulness,
  determineActions,
  resourceIdOf,
} from './lifecycle.js';
export type {
  ActionProvenance,
  IdentityElement,
  PlanAction,
  PlanActionEntry,
  ReversibilityClass,
  Statefulness,
} from './lifecycle.js';

export { scheduleWaves } from './scheduler.js';

export {
  ACTION_WEIGHTS,
  RISK_CLASS_THRESHOLDS,
  RISK_RULE_TABLE_VERSION,
  SECURITY_BOUNDARY_FACTOR_ID,
  SECURITY_BOUNDARY_WEIGHT,
  classifyRiskScore,
  riskFactorIdOf,
  riskRuleTableV1,
} from './risk.js';

export {
  APPROVAL_GATES,
  VERIFICATION_CHECKS,
  approvalGateOf,
  buildPlan,
  canonicalPlanSerialization,
  computePlanId,
  deriveDeterminismInputs,
  plan,
} from './plan.js';
export type {
  ApprovalGate,
  ApprovalRequirement,
  BuildPlanOptions,
  ComplianceDelta,
  ComplianceFinding,
  CostDelta,
  DestructiveActionRef,
  InputIdentities,
  PlanArtifact,
  PlanContent,
  PlanDeltas,
  PlanEnvelope,
  PlanOptions,
  PlanRollback,
  RiskAnnotation,
  RiskAnnotator,
  RiskFactor,
  RiskInput,
  RollbackLimitation,
  SecurityDelta,
  UnknownValue,
  VerificationEntry,
} from './plan.js';

export {
  PLAN_REFUSAL_CODES,
  RFC3339_PATTERN,
  planSigningBytes,
  refuseIfInvalid,
  signPlan,
  verifyPlan,
} from './envelope.js';
export type {
  PlanRefusal,
  PlanRefusalCode,
  SignPlanOptions,
  VerifyPlanOptions,
  VerifyPlanResult,
} from './envelope.js';

export { planSchema, validatePlanArtifact } from './validate.js';
export type { PlanArtifactValidation } from './validate.js';
