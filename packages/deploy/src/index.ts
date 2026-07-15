/**
 * `@iap/deploy` — the deployment orchestration engine (spec ch. 14, IEP-0010;
 * roadmap Phase 14, M14.2/M14.3). Drives an approved plan through a provider
 * executor with fail-closed state locking, approval verification, an atomic CAS
 * state commit with partial-state recovery, post-deployment verification, a
 * drift engine, and a rollback framework. Execution contains no AI and no MCP;
 * timestamps are injected.
 */
export { DEPLOY_REFUSALS, deploy, detectDrift, rollback } from './deploy.js';
export type {
  DeployOptions,
  DeployRefusal,
  DeployResult,
  DriftDisposition,
  DriftReport,
  DriftSeverity,
  RollbackOptions,
} from './deploy.js';

export { fixtureExecutor } from './executor.js';
export type {
  DeploymentExecutor,
  DeploymentPlan,
  ExecutionOutcome,
  VerifyOutcome,
} from './executor.js';
