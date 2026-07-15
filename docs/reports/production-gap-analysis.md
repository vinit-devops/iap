# IaP Production-Gap Analysis (Phase 19, M19.1)

**Date:** 2026-07-12 · Companion to [`implementation-audit.md`](implementation-audit.md) and
[`RELEASE_READINESS.yaml`](../../RELEASE_READINESS.yaml).

This document ranks the gaps between what IaP does today and the Phase-19 end goal — _"a user
describes an AWS workload, IaP generates a validated `infrastructure.iap.yaml`, derives
architecture/cost/security/compliance, produces a deterministic AWS plan, deploys into a
sandbox, verifies, maintains state, detects drift, updates, and destroys safely"_ — and gives a
concrete build list for the real-AWS gate (M19.3).

## Gap ranking

### G1 — No real cloud execution layer (BLOCKER for M19.3; the dominant gap)

Everything from plan onward toward the cloud is missing. There is no cloud SDK, no network
code, no credential/OIDC handling, and no apply-to-live engine anywhere in the repo. The
`@iap/deploy` orchestrator drives an in-memory `fixtureExecutor`; the complete lifecycle
(Create/Update/Replace/Delete/Import/Verify) exists only in the in-memory `@iap/provider-mock`
and is not even wired to the deploy engine. `providers/aws` maps but does not execute.

**Consequence:** M19.3 "real AWS golden path" is a **build**, not a validation. None of its
required tests (create / no-op / safe update / replacement update / drift / controlled failure
/ recovery / destroy / cleanup) can run against real AWS today.

### G2 — No in-tree LLM; NL authoring is rules-based (scope-defining for M19.2)

Model-driven natural-language authoring works only with an out-of-tree adapter the operator
supplies. In-tree, authoring is a deterministic keyword/pattern extractor. A Developer Preview
must either (a) ship/document a concrete adapter (e.g. an Anthropic-backed `ModelAdapter`
implementation) and label authoring quality accordingly, or (b) scope the Preview's authoring
claim to "rules-based + bring-your-own-model gate."

### G3 — Plan artifact integration disconnects (medium; partly cheap to fix)

- Planner not wired to the (real, complete) cost & compliance engines → plan `deltas` are
  placeholders. _Cheap fix:_ add `@iap/cost` + `@iap/compliance` deps and replace the two
  constants (`planner/src/plan.ts:343-354,440`) with engine calls. **Note:** doing this is a
  behavior change and must go in its own PR, not the M19.0 rename PR or this read-only audit.
- Planner ⇎ deploy ⇎ provider plan shapes do not connect (three incompatible types).
- `@iap/deploy` unwired to the CLI; `@iap/migrate` unwired to `iap import`.

### G4 — MCP server has no wire protocol (medium; blocks the "AI assistant surface" claim)

Real read-only tools exist, but there is no MCP transport (`@modelcontextprotocol/sdk`,
JSON-RPC/stdio) and no `bin` — it cannot be attached to Claude Code/Cursor/an IDE today.

### G5 — Durable, production state backend (blocker for any real deployment persistence)

`LocalStateBackend` is in-memory only, single-process, and advertises `encryptionAtRest: true`
over plaintext. Real deployment needs a durable, concurrently-lockable, encrypted backend.

### G6 — Interface products are engine-backed libraries, not runnable products (medium)

Designer has no UI; control-plane has no hosted service/persistence. Fine to defer for a
Preview, but they cannot be presented as usable products.

### G7 — Content/coverage gaps (low, honesty items)

Illustrative (not real) cost pricing; validator IAP203 attribute correctness; policy `matches`
RE2 approximation; security IAP604 and cost oversizing deferred; migrate is Kubernetes-only.

## What M19.3 "real AWS golden path" concretely requires (build list)

The audit's planning/execution and provider auditors converge on this concrete list. **All of
it is net-new work** (none exists today):

1. **A real AWS substrate** implementing the `DeploymentExecutor` / provider-runtime contract,
   backed by `@aws-sdk/*` clients per resource type, translating planner waves into idempotent
   SDK calls (ECS, ALB/ELBv2, RDS, ElastiCache, SQS, S3, IAM, ACM, ResourceGroups — matching
   the existing AWS mapping's 8 kinds / ~13 targets).
2. **Real update-vs-replace, import, and no-op detection** in that substrate (the deploy
   `fixtureExecutor` has none; adapt the mock `MockSubstrate` contract or build fresh against
   live describe/diff).
3. **A plan-shape adapter** bridging planner `PlanContent`/waves → deploy `DeploymentPlan` →
   provider `ProviderPlan` (today disconnected).
4. **A durable state backend** implementing `StateBackend` with real at-rest encryption and
   cross-process locking (e.g. S3 + DynamoDB, or equivalent) — replacing the in-memory `Map`.
5. **Credentials/identity plumbing:** short-lived credentials or OIDC role-assumption; the
   dedicated sandbox account; restricted IAM; cost budgets; mandatory tags. Per the standing
   directive, M19.3 uses **AWS profile `REDACTED_AdministratorAccess` only**.
6. **CLI wiring:** connect `@iap/deploy` and enable the `deploy`/`destroy`/`drift`/`state`
   stub commands (`packages/cli/src/commands/stubs.ts:22-26`).
7. **Live drift detection** reading real cloud state (today the mock uses a `driftOn` flag).
8. **The 9 required lifecycle tests** run against the live sandbox with recorded evidence
   (create/no-op/safe-update/replacement/drift/controlled-failure/recovery/destroy/cleanup).

This is a substantial milestone in its own right, and every step is a live-AWS,
human-approval-gated action.

## Recommended sequencing for the rest of Phase 19

- **M19.2 — Developer Preview scope freeze:** scope the Preview to the _real_ capability —
  author → validate → architecture/cost/security/compliance → AWS mapping → deterministic
  signed **plan preview** — and explicitly defer real deployment to a subsequent build.
  Publish the AWS support matrix from the existing 8-kind mapping. Optionally close the cheap
  G3 planner-wiring gap first (separate PR) so plan `deltas` are truthful.
- **M19.3 — Real AWS golden path:** execute the G1/G4/G5 build list above; this is where the
  execution layer, state backend, and credentials come into being. Gated on explicit approval.
- **M19.4–M19.8:** packaging, playground (plan-only — aligns well with the current
  no-execution reality), security hardening, benchmarks, release — sequence per roadmap-v2.

## Honest one-line status for a Developer Preview

> IaP can take natural language (rules-based, or via a supplied model) to a validated
> `infrastructure.iap.yaml`, and derive architecture, cost, security, compliance, and a
> deterministic, signed AWS **plan**. It cannot yet deploy to real AWS, maintain durable
> state, or detect live drift — those require the execution layer built in M19.3.
