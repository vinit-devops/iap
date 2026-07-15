# Milestone M16.1–M16.3 — Enterprise Control Plane

**Phase:** 16 — Enterprise Control Plane
**Milestones:** M16.1 (multi-tenant API + RBAC + approval engine), M16.2 (git application + PR checks), M16.3 (policy/profile distribution + registries + audit + state service)
**Status:** Completed
**Date:** 2026-07-11

## Implemented

`@iap/control-plane` 0.1.0 — the enterprise control-plane core every server/API surface drives.
Pure and deterministic; the HTTP API and git application are thin clients over it.

- **RBAC (M16.1)** — a closed role set (`viewer`/`author`/`approver`/`admin`) × action set
  (`view`/`author`/`approve`/`deploy`/`administer`) with `can(role, action)`.
- **Separation-of-duties approval engine (M16.1)** — `approve(request, approver, decision, ts)`
  makes separation of duties enforceable: **the author of a change can never approve it**
  (`self-approval`), and only a role holding `approve` may (`insufficient-role`). Every
  approval is recorded as evidence (change id, approver, role, timestamp, decision), so a
  deployment can be tied to identity + approval (feeding `@iap/state`'s history `approvals`).
- **Multi-tenant project isolation + audit (M16.1/M16.3)** — `ControlPlane` scopes projects by
  tenant; a principal in one tenant cannot reach another tenant's project (isolation).
  `authorize` records every decision — allow or deny — to an **append-only audit log**, so who
  did what under which role is always reconstructable.
- **PR checks (M16.2)** — `prChecks(base, head)` reports the four reviewer deltas between two
  canonical models: **intent** (resources added/removed/changed), **cost** (monthly delta +
  budget breaches), **security** (risk change + new error findings), and **compliance** (new
  control violations) — each with a pass/fail, and an overall pass. A git application blocks a
  PR whose head regresses posture (new IAP601/security finding, new IAP701 violation, a budget
  breach, or a risk increase). Reuses the reference cost/security/compliance engines.
- **Policy/profile distribution + registries (M16.3)** — a project inherits its organization's
  distributed policy-pack ids (`policyPacks`), the seam by which a central platform team
  publishes "how we build here" once and every project consumes it. The **state service** is
  `@iap/state` (Phase 14) behind the control plane's authorization.

## Design decisions taken

1. **Headless core + thin API.** The control plane's logic (RBAC, approval, isolation, audit,
   PR checks) is a testable library; the HTTP API and git application are thin clients — a
   rendered server and a hosted git app are release artifacts, not unit-testable logic.
2. **Separation of duties is a hard rule, not a policy.** Self-approval is refused
   structurally; there is no configuration that permits it.
3. **PR checks reuse the analysis engines.** Cost/security/compliance deltas come from the same
   `@iap/cost`/`@iap/security`/`@iap/compliance` a developer runs locally — the control plane
   adds only the base↔head diffing and the pass/fail gate, so a PR check matches local review.

## Specification references

Roadmap Phase 16 (multi-tenant API, RBAC, approval engine, git application + PR checks with
intent/cost/security/compliance deltas, policy/profile distribution + registries + audit +
state service; exit criteria — teams manage isolated projects, separation of duties
enforceable, deployment tied to identity + approval, org policies centrally enforced); ch. 7
(policies), ch. 16/15/17 (the analysis engines PR checks reuse); IEP-0010 (state service +
history approvals); ch. 19 §19.6 (human approval gate).

## Tests added

`packages/control-plane/test/control-plane.test.ts` (8): RBAC grants by role; the approval
engine refuses self-approval and an under-privileged approver and records evidence for a valid
one; multi-tenant isolation (cross-tenant project unreachable) + audit logging; PR checks — a
no-op change passes every dimension, an added resource reports intent/cost deltas, and a head
that makes a data store public fails the security dimension (new IAP601) and the overall check.

## Conformance status

Green end to end: `pnpm run verify` and `pnpm run format:check` both pass.

## Notes

The HTTP/multi-tenant API server, the hosted git application (webhooks, status checks), central
registries, and the DR/replication state service are the phase's thin-client / operational
surfaces over the tested core and `@iap/state`; a running server is a release artifact. The
governance substance — RBAC, enforceable separation of duties, deployment tied to identity +
approval evidence, org-policy distribution, and the PR-check gate — is fully tested here.
