# IaP Implementation Audit (Phase 19, M19.1)

**Date:** 2026-07-12 · **Type:** independent, read-only, evidence-based · **Method:** five
parallel capability auditors read the actual source + tests (not roadmap labels), plus a
full `pnpm verify`. Machine-readable classification: [`RELEASE_READINESS.yaml`](../../RELEASE_READINESS.yaml).
Gap-to-production and the path to real AWS: [`production-gap-analysis.md`](production-gap-analysis.md).

> This is an internal engineering audit by coordinated Claude Code agents. It is **not** an
> external security audit or third-party attestation.

## Verification baseline (clean run)

`pnpm verify` → **PASS**: build, lint, **1213 unit tests / 5 skipped**, 65 spec/conformance
checks, 45 provider-conformance checks, 29 determinism checks, all evaluation cases. `pnpm
typecheck` and `pnpm format:check` also pass. Only 27 marker comments (TODO/deferred/stub)
in `src/`, nearly all honest "deferred to phase X" annotations. The codebase is real,
consistently tested, and disciplined about determinism and fail-closed behavior.

## Headline

IaP today is a **production-grade deterministic planning / analysis / mapping system** with
two deliberate, clearly-bounded absences and several integration disconnects. It reliably
turns an IaP document into a canonical model, validates it, derives architecture/cost/
security/compliance, maps it to concrete AWS or Kubernetes resource intents, and produces a
signed, byte-deterministic plan. It does **not** deploy to any real cloud, and it does
**not** itself contain an LLM.

## Class distribution (see RELEASE_READINESS.yaml for the full table)

| Class | Meaning                                   | Count |
| ----- | ----------------------------------------- | ----- |
| A     | Implemented + independently verified      | 24    |
| B     | Implemented but mock/in-memory/local only | 6     |
| C     | Partially implemented                     | 8     |
| F     | Deferred in code                          | 7     |
| G     | Missing (referenced but absent)           | 6     |

No capability is pure scaffold (D) or docs-only (E) — everything has real code behind it.

## What is genuinely real (Class A, verified)

- **Authoring core:** parse → canonical model (canonicalization C2–C6, exact-rational
  quantities, SHA-256 hashing) → validation phases 1–4 → policy engine (ch.7, autofix,
  deterministic) → the transactional operation **gate** (structural → resolve → copy-on-write
  dry-run → full pipeline → confirmation/destructive gate → commit + provenance). 537 tests.
- **Analysis engines:** architecture (5 views + Mermaid/DOT), dependency graph (Tarjan
  cycles, Kahn waves, impact), cost estimation (real per-resource math + budget IAP505),
  security posture (IAP601–603), compliance (6 framework bundles). 107 value-asserting tests.
- **Planner:** deterministic `planId` content hash proven byte-stable under a golden-byte +
  perturbed-environment + key-shuffle harness (29/29); real diff/lifecycle/scheduler/risk;
  ed25519 plan-envelope signing. 176 tests.
- **Provider SDK + mappings:** ed25519 signing and sha256 digest integrity, both proven
  fail-closed three ways; a 7-stage fail-closed package loader; a deterministic mapping
  engine with a closed unsupported-reason taxonomy; a non-vacuous conformance runner. The
  **AWS mapping is real and complete for 8 kinds** across ~13 concrete AWS target types
  (ECS/ALB, RDS, ElastiCache, SQS, S3, IAM, ACM, ResourceGroups); Kubernetes matches it.
- **Interfaces:** the `iap` CLI's 17 analysis/authoring commands (builds and runs as a real
  binary), the full language server (diagnostics/completion/hover/definition/references/
  rename/symbols/code-actions/custom preview), and the SDK facade.

## The two intentional boundaries (honest, but must be stated in any release)

1. **No real cloud execution.** No `@aws-sdk`/`aws-sdk` (or any cloud SDK) in any
   `package.json`; no network or credential code anywhere. `providers/aws` and
   `providers/kubernetes` are **mapping-only** (their own headers defer execution to an
   unbuilt "Phase 14"). The only substrate that "applies" objects is `@iap/provider-mock`,
   which implements the full ch.14 lifecycle (Create/Update/Replace/Delete/Import/Verify,
   waves, partial-failure recovery, idempotence) **entirely in memory**. So
   deploy/state/drift/reconcile/rollback are exercised only against an in-memory world.

2. **No in-tree LLM.** The "intent compiler" NL→IaP path and "AI review" are **deterministic
   rule engines**. The LLM is a vendor-neutral **adapter contract** (interface + hash-pinned
   prompt artifacts + enforcement middleware for residency/redaction/limits/repair) whose
   real implementations live out-of-tree; in-tree there is only a `fixtureAdapter` (replay)
   and a `rulesAdapter` (the deterministic extractor). Model-driven authoring works only
   end-to-end with an adapter the operator supplies.

## Integration disconnects (real code that isn't wired together)

- **Planner ⇏ cost/compliance.** The plan artifact's `deltas.cost` and `deltas.compliance`
  are hardcoded `deferred` constants (`planner/src/plan.ts:343-354,440`); the planner has no
  dependency on `@iap/cost` or `@iap/compliance`. Both engines are real and complete and
  _are_ consumed through the CLI/MCP/control-plane surfaces — only the plan artifact is stale.
- **`@iap/deploy` is orphaned.** It is imported by no other package, does not depend on
  `@iap/provider-mock`, and its own thin `fixtureExecutor` lacks update/replace/import/no-op.
  The rich lifecycle lives in the mock provider, unwired. The CLI deploy-family commands are
  disabled stubs. Three plan shapes (planner `PlanContent`/waves, deploy `DeploymentPlan`,
  provider `ProviderPlan`) do not connect.
- **MCP server has no wire transport.** Real read-only tools over the engines, but no
  `@modelcontextprotocol/sdk`, no JSON-RPC/stdio, no `bin` (a `bin.ts` is referenced in a
  docstring but does not exist). It cannot be connected by an IDE today.
- **`@iap/migrate` real but unwired** (`iap import` is a stub); Kubernetes-only.

## Roadmap-label-vs-code discrepancies

`ROADMAP.yaml` declares "WHOLE ROADMAP COMPLETE" with every phase `completed`. Against the
code, that overstates in specific, enumerable ways:

- Phases 10 (cost) & 11 (compliance) are complete as engines, but the **plan artifact** still
  emits `pricing-deferred-phase-10` / `deferred:phase-11` placeholders.
- The validator explicitly defers phases 5–8 conformance ("stay deferred in the harness",
  5 skipped tests) — the engines exist elsewhere and are gate-wired, so it is a harness/
  packaging gap, not platform-missing.
- Phase 3 (intent compiler) & Phase 17 (AI review) are complete as **adapter/gate designs**
  but ship no model — a reader taking "complete" at face value would expect model-driven
  features that require an out-of-tree adapter.
- Phase 14 (execution) is entirely unbuilt, yet CLI stubs reference it.

None of these are defects in what exists — the built parts are strong. They are honesty gaps
between the completion labels and the shipped end-to-end capability, which is exactly what
this audit was asked to surface, and what the Developer Preview scope freeze (M19.2) must
account for.

## Notable per-capability gaps (Class C/F, real but incomplete)

- Validator IAP203 checks resource existence but not per-kind abstract-attribute correctness.
- Policy `matches` is a JS-RegExp approximation of RE2 (no linear-time guarantee).
- Cost bundled pricing is explicitly illustrative ("not real vendor pricing"); the
  oversizing/utilization suggestion is deferred; security IAP604 (isolation) is deferred.
- State backend is in-memory only; its `encryptionAtRest: true` capability flag is misleading
  (data is plaintext in a `Map`).
- Designer is a headless model library with **no UI**; control-plane is an in-memory core with
  **no hosted service/persistence**.

## Conclusion

The deterministic core is genuinely ready to underpin a **planning-and-analysis** Developer
Preview. The honest, scoped framing for the next milestone (M19.2) is: _author → validate →
architecture/cost/security/compliance → AWS mapping → deterministic, signed plan preview_ is
real; _deploy → state → drift → update → destroy against real AWS_ is not yet built and is the
substance of M19.3. See [`production-gap-analysis.md`](production-gap-analysis.md).
