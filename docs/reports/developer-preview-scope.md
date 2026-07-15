# IaP Developer Preview v0.1 — Scope Freeze (Phase 19, M19.2)

**Date:** 2026-07-12 · **Status:** proposed freeze, pending approver sign-off ·
**Grounded in:** [`implementation-audit.md`](implementation-audit.md),
[`production-gap-analysis.md`](production-gap-analysis.md),
[`RELEASE_READINESS.yaml`](../../RELEASE_READINESS.yaml) ·
**AWS surface:** [`aws-support-matrix.md`](aws-support-matrix.md)

## Release name

> **IaP Developer Preview v0.1**

## Framing (why this differs from the roadmap's literal workflow list)

roadmap-v2 §8 lists a supported workflow that runs all the way through _non-production AWS
deployment → state → verification → drift → update → destroy_. The M19.1 audit established
that **none of the real-cloud steps exist** (no cloud SDK, no execution layer, in-memory mock
only). Freezing a scope that promised deployment would be dishonest. Therefore v0.1 is frozen
as the **planning-and-analysis product that is actually real and verified**, and the
deployment lifecycle is explicitly deferred to milestone **M19.3** (which the audit shows is a
_build_, not a validation). A deployment-capable Preview would be **v0.2**, after M19.3.

## v0.1 supported workflow (IN SCOPE — real, verified today)

Every step below is Class A in the audit (real logic + passing tests) unless noted:

1. **Natural-language requirement** → **clarification** — deterministic rules-based extraction;
   or bring-your-own-model via the `ModelAdapter` contract (no LLM is shipped in-tree — see
   Limitations). Uncovered phrasing is reported explicitly, never guessed.
2. **Valid IaP generation** → a `infrastructure.iap.yaml` produced through the operation gate
   (structural → resolve → copy-on-write dry-run → full pipeline → confirmation → commit +
   provenance).
3. **Canonical model** — deterministic canonicalization (C2–C6), exact-rational quantities,
   SHA-256 content hash.
4. **Validation** — phases 1–4 (schema/IAP1xx, reference/IAP2xx, relationship/IAP3xx,
   dependency/IAP4xx) + policy (IAP5xx).
5. **Architecture diagram** — 5 derived views + Mermaid/DOT export.
6. **Cost report** — real per-resource estimation + budget checks _(pricing data is
   illustrative, not real vendor pricing — see Limitations)_.
7. **Security report** — posture + findings IAP601–603.
8. **Compliance report** — 6 framework bundles (SOC2/PCI/HIPAA/ISO/NIST/CIS), representative
   controls.
9. **AWS provider mapping** — 8 core kinds → concrete AWS target types (see the support
   matrix), signed + digest-verified + conformance-tested.
10. **Deterministic plan** — byte-stable `planId`, ed25519-signed plan envelope. **This is a
    PLAN PREVIEW, not an apply.**

Delivered through: the `iap` **CLI** (17 real analysis/authoring commands), the **language
server** (full LSP), and the **SDK**. All build and run.

## Explicitly DEFERRED from v0.1

### Deferred to M19.3 (must be BUILT — not present today)

- Explicit-approval → **non-production AWS deployment**
- **State persistence** (durable/encrypted/cross-process — current backend is in-memory only)
- **Verification** against live resources
- **Drift detection** against real cloud state
- **Controlled update / replacement update**
- **Controlled destroy**
- The `iap deploy/destroy/rollback/drift/state` commands (currently disabled stubs)

### Deferred capabilities surfaced by the audit (not in v0.1)

- **In-tree LLM** — authoring/review ship as deterministic rules + an out-of-tree LLM adapter
  contract; a bundled model implementation is not included.
- **MCP server transport** — real read-only tools exist but there is no MCP wire protocol/bin
  to attach an IDE.
- **Visual Designer UI** — only a headless session library exists.
- **Hosted control plane** — only an in-memory core exists (no service/persistence).
- **Migration importers beyond Kubernetes** (Terraform/CloudFormation/Pulumi/Crossplane).
- **Truthful plan cost/compliance deltas** — the plan artifact currently emits placeholders
  (a cheap, separate fix; the engines themselves are real and shipped via the CLI/MCP).

### Deferred per roadmap-v2 §8 (product scope)

Azure execution · GCP execution · multi-cloud orchestration · enterprise multi-tenancy ·
marketplace · universal migration support · unattended production deployment · autonomous
destructive remediation.

## Frozen AWS resource support

8 IaP core kinds → AWS targets (ECS/ALB, RDS, ElastiCache, SQS, S3, IAM, ACM,
ResourceGroups). Full matrix + the 5 unmapped core kinds + 9 reserved kinds:
[`aws-support-matrix.md`](aws-support-matrix.md). **Mapping/plan coverage only.**

## Mandatory limitations statement (must ship with v0.1)

- **Not for deployment.** v0.1 plans and analyzes; it does **not** deploy to real AWS,
  maintain durable state, or detect live drift. Those arrive in a later Preview after M19.3.
- **Costs are estimates** from illustrative pricing, not real vendor quotes.
- **Compliance reports are not certifications** and cover representative controls only.
- **Generated plans require human review**; destructive actions (once M19.3 ships them) will
  require explicit approval.
- **Natural-language authoring** is rules-based in-tree; model-driven authoring requires an
  adapter the operator supplies.
- Plans are deterministic and signed; the mapping asserts security floors on _plan attributes_,
  not on deployed resources.

## Exit criteria for M19.2

- [x] Release named (**IaP Developer Preview v0.1**).
- [x] Supported workflow defined honestly against audited reality (plan-preview).
- [x] Deferred items enumerated (M19.3 lifecycle + audit-surfaced + roadmap §8 product scope).
- [x] AWS resource support frozen + support matrix published.
- [ ] **Approver sign-off on this freeze** (the one open item).
