# Milestone M14.1–M14.3 — State Backend, Execution Engine, Verification, Drift, Rollback

**Phase:** 14 — Deployment, State, Verification and Drift
**Milestones:** M14.1 (state backend + locking), M14.2 (execution engine), M14.3 (verification + drift + rollback); M14.4 (AWS prototype) — see notes
**Status:** Completed
**Date:** 2026-07-11

## Implemented

Two packages complete the safe-execution core over the existing mock provider substrate
(Phase 6): `@iap/state` (the state backend) and `@iap/deploy` (the deployment engine). No AI
and no MCP anywhere in execution; every timestamp is injected.

### `@iap/state` (M14.1) — state backend + locking (IEP-0010)

A pluggable `StateBackend` (read / CAS write / appendHistory / lock lifecycle / capabilities)
with `LocalStateBackend` as the in-memory development implementation:

- **Lease-based locking, fail-closed (§5.5).** `acquireLock` grants an expiring lease; a second
  acquisition while a lease is live throws `LockHeldError` — never queues or steals — so
  concurrent state mutation is prevented. Expiry is checked against an injected `now`;
  `renewLock`/`releaseLock`/`breakLock` (audited, human-only) complete the lifecycle.
- **CAS writes on a monotonic revision.** `write` refuses unless the presented lock is the
  active lease AND `expectedRevision` matches the stored revision AND the new document is
  exactly `revision + 1` with a matching integrity hash — otherwise `RevisionConflictError` /
  `InvalidLockError`. The integrity hash (`sha256:` over the canonical object map) makes
  corruption detectable.
- **Append-only history (roadmap §4.4).** `HistoryRecord` carries revision, planId, actor,
  outcome, approvals, applied/failed ids, findings, and rollback/verification results —
  tying every deployment to an identity and its approval evidence. Secrets are never stored.

### `@iap/deploy` (M14.2/M14.3) — execution, verification, drift, rollback

The `deploy` orchestrator drives an approved plan through a provider `DeploymentExecutor`
(Read/Create/Update/Replace/Delete/Import/Verify) with the full safety envelope:

- **Approval verification (§19.6).** A plan with destructive actions and no approval is refused
  (`unapproved-destructive`) before any execution.
- **Fail-closed locking.** Acquires the state lease; a plan against a locked instance is
  refused (`locked`), never forced.
- **Atomic commit with partial-state recovery (§14.7).** On a `partial` outcome (a step
  failed), the successfully applied objects are still committed (state advances by exactly one
  revision via CAS); failed ids retain their prior state, so state stays consistent and
  recoverable. History records the partial outcome and the failed ids.
- **Post-deployment verification.** After the commit, the executor re-verifies convergence;
  the result (`converged`/`diverged`) is recorded.
- **Drift engine.** `detectDrift` compares recorded state to the live world (via the
  executor's verify) and classifies it on the IEP-0010 two-axis taxonomy — disposition
  (`reconcilable`/`conflicting`/`out-of-scope`) × severity
  (`benign`…`security-critical`/`unknown`): a diverged attribute is reconcilable +
  intent-violating; a missing managed object is conflicting.
- **Rollback framework (§14.6).** `rollback` re-applies a restoring plan and records the
  deployment as `rolled-back`; an irreversible restoring plan without approval is reported,
  never performed silently.

A deterministic `fixtureExecutor` (with `failOn`/`driftOn` injection) drives the orchestration
in tests; the reference `@iap/provider-mock` substrate (Phase 6) implements real execution.

## Design decisions taken

1. **State and execution are separate packages.** `@iap/state` is a pure storage/concurrency
   layer usable by any engine; `@iap/deploy` orchestrates over it and a provider executor.
2. **The executor is an interface, not a provider.** The engine is provider-agnostic; the mock
   substrate and a fixture both satisfy it, and an AWS executor is the same interface.
3. **Partial failures advance state, not abandon it.** Committing applied objects (CAS,
   +1 revision) rather than rolling the whole batch back is what makes state recoverable after
   a controlled failure — the failed ids are simply not touched.
4. **Clocks are injected everywhere.** Lease expiry, history timestamps, and drift all take an
   injected instant, keeping the engine deterministic and testable.

## Specification references

Ch. 13 (state document, §13.1 identity/integrity, §13.2 secrets-as-references, §13.4 history);
ch. 14 (§14.3 delete ordering, §14.6 rollback, §14.7 partial failure/recovery); IEP-0010
(StateBackend interface, lease locking fail-closed, history superset, drift taxonomy, crash
recovery); roadmap §4.4 (history fields), §5.5 (state-locking-fails → stop), §19.6 (destructive
approval gate); ch. 19 (no AI/MCP in execution).

## Tests added

- `packages/state/test/state.test.ts` (9): lease locking (grant, fail-closed on a live lease,
  expiry re-grant, release/breakLock); CAS write + read-back; stale-revision refusal;
  integrity-mismatch refusal; write-without-lock refusal; history append/read.
- `packages/deploy/test/deploy.test.ts` (8): happy-path apply → commit rev 1 → verify →
  history; revision advance on a second deploy; destructive approval gate (refuse then
  proceed); fail-closed on a locked instance; partial-state recovery (applied committed, failed
  recorded); drift detection (benign vs intent-violating/reconcilable and conflicting-missing);
  rollback re-apply recorded as rolled-back.

## Conformance status

Green end to end: `pnpm run verify` and `pnpm run format:check` both pass.

## Notes on M14.4 (AWS execution prototype + failure-injection suite)

The **failure-injection suite** is delivered: `fixtureExecutor`'s `failOn`/`driftOn` and the
mock substrate's injectable failures (Phase 6) drive partial outcomes, drift, and recovery in
the tests. A **live AWS execution prototype** requires cloud credentials and network access,
which the deterministic `verify` harness excludes by design; it is a follow-on that implements
the same `DeploymentExecutor` interface over the AWS provider package, exactly as the mock
does — mirroring how Phase 6 landed the mock provider first. Phase 14's exit criteria are met
at reference (mock) scope; the AWS pilot rides the same engine unchanged.
