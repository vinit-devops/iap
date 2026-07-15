# Phase 5 Completion Report — Reference CLI

**Date:** 2026-07-10 (M5.1/M5.2/M5.4); updated 2026-07-11 (M5.3) · **Milestones:** M5.1, M5.2, M5.4 (`docs/milestones/M5-cli.md`) and M5.3 (`docs/milestones/M5.3-iap-create.md`) all completed · **Phase status: COMPLETE**

## Exit criteria verification

| Exit criterion                                   | Status   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI analysis requires no UI                      | **Pass** | Every implemented command (`validate`, `graph`, `diagram`, `policy`, `normalize`, `fmt`, `explain`, `diff`, `doctor`, `init`) is non-interactive: file/flag input, stdout/stderr output, deterministic exit codes; no prompts, no TTY assumptions, `--quiet` for exit-code-only automation. The whole suite (`packages/cli/test/cli.test.ts`, 39 tests) drives the CLI through the same `run(argv, io)` entry the binary uses — headless by construction.                                                                                                    |
| All SDK diagnostics reproducible through the CLI | **Pass** | `iap validate` executes every diagnostic pipeline the SDK exposes today — validator phases 1–4 (`validate()`, IAP1xx–4xx) plus policy phase 5 (`policies()`, IAP5xx) — and reports them per phase in human, JSON, and SARIF forms; `iap policy` additionally reaches the pack registry and autofix surface. Verified against the official corpus (exit 0) and the conformance corpus (`invalid/01-unknown-kind` → IAP102, exit 1). Phases 6–8 gain rows when their engines land (Phase 11+).                                                                 |
| Output formats versioned                         | **Pass** | Every JSON payload of every command carries `formatVersion: 1` (test-pinned across validate/graph/diagram/policy/normalize/explain/diff/doctor/version). SARIF output is self-versioned (`"version": "2.1.0"`). The `iap normalize` default output is the canonical byte projection, versioned by its embedded `apiVersion: iap.dev/v1`.                                                                                                                                                                                                                     |
| Natural-language creation produces validated IaP | **Pass** | `iap create` (M5.3) wraps the Phase 3 authoring engine (`runAuthoringSession`): a natural-language requirement runs through the compiler, clarifications and a semantic preview surface, and a committed request writes `infrastructure.iap.yaml`. `packages/cli/test/create.test.ts` asserts the written document re-loads and re-validates green end to end (phases 1–5 + extensions, zero errors); the compiler boundary (OP-1) guarantees no unvalidated YAML is ever written. `iap edit` remains a phase-3 stub (incremental authoring, next CLI step). |
| CLI never deploys before explicit approval       | **Pass** | `iap deploy` (with `destroy`, `rollback`, `drift`, `state`, `plan`) is disabled: it prints the Phase 14 gating message and exits 2, executing nothing (`packages/cli/src/commands/stubs.ts`; test-pinned). When Phase 14 lands, §22.2.8's reviewed-plan hash gate is the implementation contract — no author, human or AI, bypasses it.                                                                                                                                                                                                                      |

## Verification state

`pnpm exec vitest run packages/cli` → 39/39 · `pnpm exec eslint packages/cli` → clean · `pnpm --filter @iap/cli run build` → clean · spec harness → 59/59 · e2e smoke `node packages/cli/dist/cli.js validate --file spec/examples/basic-webapp.iap.yaml` → five-phase table, exit 0. Full-workspace `pnpm run verify` is red only inside `packages/language-server` (parallel Phase 4 stream, untouched by this phase).

## Decision

Phase 5 is **COMPLETE**. All five exit criteria pass. M5.1, M5.2 (policy + diagram over
shipped engines; cost/security/compliance stubs flip on with Phases 10/11), and M5.4 were
delivered together; M5.3 (`iap create`) landed once Phase 3 shipped the authoring engine
and now produces validated IaP documents end to end. Remaining phase-gated commands
(`edit`, `cost`, `security`, `compliance`, and the Phase 14 deployment family) stay stubs
that exit 2 naming the roadmap phase that unlocks them — the CLI's surface is stable and it
structurally cannot deploy.

**M5.3 update (2026-07-11):** natural-language creation verified via
`packages/cli/test/create.test.ts` (13 tests) and full-workspace `pnpm run verify` green
(the Phase 4 language-server stream that was red at the original date has since landed).
