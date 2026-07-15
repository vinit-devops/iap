# IaP Developer Preview v0.1 — Release Readiness (Phase 19, M19.8)

**Status:** PREPARED — awaiting approver sign-off to publish. **No publication performed.**
**Date:** 2026-07-12.

> Publication (git tag, npm/registry publish, GitHub release) is a **human-approval gate**
> (roadmap-v2 §14) and additionally requires git/registry access this repo does not have. This
> document is the release artifact + gate check; actual publishing happens only on your word.

## What IaP Developer Preview v0.1 is

A **deterministic Infrastructure-as-Prompt planning and analysis** toolchain. From a natural-
language requirement it produces a validated `infrastructure.iap.yaml`, derives architecture /
cost / security / compliance, maps to AWS resource intents, and emits a deterministic, signed
**AWS plan preview**. Scope was frozen in M19.2 (`docs/reports/developer-preview-scope.md`).

## What ships

- **IaP specification** + JSON Schemas + conformance suite (`spec/`).
- **`iap` CLI** — installable, zero-dependency bundle (`build:cli-pkg`): `create` (NL authoring,
  rules-based), `validate`, `cost`, `security`, `compliance`, `graph`, `diagram`, `policy`,
  `normalize`, `fmt`, `explain`, `diff`, `doctor`, `init`, `plan` (deterministic signed preview).
  Also `deploy`/`destroy`/`drift`/`state` — real, `--confirm`-gated (a v0.2 execution capability;
  see below).
- **MCP server** — read-only authoring/analysis tools over a real stdio JSON-RPC transport
  (`iap-mcp-server`).
- **Language server** (full LSP) + a packaged **VS Code `.vsix`**.
- **Local Visual Designer** shell + a **plan-only Playground** (both local, no credentials).
- **Examples, demo repo, migration/security/audit docs.**

## Known limitations (MUST be published with the release)

- **Not a deployment tool in v0.1.** v0.1 is plan-and-analyze. Real AWS deployment, durable
  state, and live drift are a **v0.2 Private Deployment Preview** capability. The execution
  layer was built and live-validated in M19.3 (S3/SQS/IAM golden path in a sandbox, then torn
  down — `docs/reports/m19.3-live-run-evidence.md`), but v0.1 does not present deployment as a
  supported product surface.
- **AWS coverage is limited** — 8 core kinds mapped (ECS/ALB, RDS, ElastiCache, SQS, S3, IAM,
  ACM, ResourceGroups); executor covers S3/SQS/IAM. See `docs/reports/aws-support-matrix.md`.
- **Costs are estimates** from illustrative pricing, not vendor quotes.
- **Compliance reports are not certifications**; representative controls only.
- **Natural-language authoring is rules-based** in-tree; model-driven authoring requires a
  bring-your-own `ModelAdapter` (no LLM is bundled).
- **Generated plans require review**; destructive actions require explicit `--confirm`.
- Rollback is not universally guaranteed; not intended for unattended production deployment.

## Mandatory release-gate checklist (roadmap-v2 §15)

| Gate                                 | Status    | Evidence                                                                                   |
| ------------------------------------ | --------- | ------------------------------------------------------------------------------------------ |
| IaP rename migration passes          | ✅        | M19.0; `pnpm check:names`                                                                  |
| No unclassified old project naming   | ✅        | `tools/check-legacy-names.mjs` in `verify`                                                 |
| Clean installation                   | ✅        | `smoke:cli` (clean mktemp install)                                                         |
| Build passes                         | ✅        | `pnpm build`                                                                               |
| Type checking passes                 | ✅        | `pnpm typecheck`                                                                           |
| Tests pass                           | ✅        | `pnpm test` (1267+)                                                                        |
| Conformance passes                   | ✅        | `test:spec` (65)                                                                           |
| Determinism passes                   | ✅        | `test:determinism` (29)                                                                    |
| No critical security finding         | ✅        | M19.6; `pnpm audit` 0 vulns; threat model                                                  |
| No plaintext-secret leakage          | ✅        | `scan:secrets` in `verify`                                                                 |
| CLI installs externally              | ✅        | `smoke:cli` / `smoke:demo`                                                                 |
| Natural language → valid IaP         | ✅        | `smoke:demo` (NL → validated doc)                                                          |
| AWS plan is deterministic            | ✅        | `smoke:demo` (stable planId)                                                               |
| Real AWS create succeeds             | ✅ (v0.2) | M19.3 live run                                                                             |
| Real AWS no-op succeeds              | ✅ (v0.2) | M19.3 live run                                                                             |
| Real AWS update succeeds             | ✅ (v0.2) | M19.3 live run                                                                             |
| State locking works                  | ✅        | `@iap/state` `FileStateBackend` tests                                                      |
| Drift is detected                    | ✅ (v0.2) | M19.3 live run                                                                             |
| Failure recovery tested              | ✅ (v0.2) | M19.3 live run (partial-failure → converge)                                                |
| Destroy requires confirmation        | ✅        | `--confirm` gate; M19.3 destroy                                                            |
| Cleanup is verified                  | ✅ (v0.2) | M19.3 orphan sweep `[]`                                                                    |
| Known limitations public             | ✅        | this document                                                                              |
| Playground is safe (no creds/deploy) | ✅        | M19.5; `smoke:playground` 23/23 (creds→400, plan-only)                                     |
| Product evidence gathered            | ✅        | M19.7; `test:benchmarks` (26 cases, 16/16 categories) — `docs/reports/product-evidence.md` |

Deployment-related gates are satisfied by the M19.3 build+live evidence; they describe a v0.2
capability that is present but not marketed in v0.1.

## Proposed version + publication steps (NOT executed)

- Version: `0.1.0` (Developer Preview). Tag: `v0.1.0-developer-preview`.
- On approval + git/registry access: `CHANGELOG.md` entry → tag → publish the `iap` CLI package
  - `.vsix` + MCP server → GitHub release with the known-limitations above.

**Nothing here is published. Awaiting your go-ahead.**
