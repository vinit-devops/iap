# Phase 0 Completion Report — Foundation and Repository Baseline

**Date:** 2026-07-10 · **Milestones:** M0.1–M0.6 (all completed with reviewable docs under `docs/milestones/`)

## Exit criteria verification

| Exit criterion                                                  | Status                 | Evidence                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A clean checkout can install, build, lint, and test             | **Pass** (with caveat) | `pnpm install && pnpm run verify` green end-to-end (build, eslint, 33 unit tests, 18 spec checks). Caveat: without git there is no literal "clean checkout"; verified from the working tree with `node_modules` resolvable from the lockfile. Re-verify on first clone once git is enabled. |
| Existing schemas and examples are validated automatically       | **Pass**               | `pnpm run test:spec` (tests/conformance/run.mjs): both schemas compile (ajv 2020-12, strict, x-iap vocabulary), 4 examples + reference mapping validate. Also exercised via `@iap/parser` unit tests.                                                                                       |
| The conformance suite runs in CI                                | **Pass** (staged)      | Single command `pnpm run test:spec`; wired as a step in `.github/workflows/ci.yml`. CI itself is inert until the repo is pushed to a git host (user directive: no git).                                                                                                                     |
| Protected main-branch workflow is documented                    | **Pass** (staged)      | CONTRIBUTING.md documents branch-per-change + PR + review; explicitly notes the current no-git mode where `docs/milestones/` documents substitute for PRs.                                                                                                                                  |
| No implementation package contains provider-specific core types | **Pass**               | `@iap/model` and `@iap/parser` contain no provider concepts; grep for provider nouns over `packages/` returns nothing. Model constants are drift-tested against the provider-free normative schema.                                                                                         |

## Deliverables checklist (roadmap Phase 0)

Buildable monorepo ✓ · Passing baseline verification ✓ (CI staged) · Governance files ✓ · Security policy ✓ · Contribution guide ✓ · Release guide → deferred (release automation is meaningless pre-git; tracked as a Phase 0 known limitation, revisit when git is enabled) · Initial ADR directory ✓ (ADR-0001/0002 accepted) · Initial roadmap tracker ✓ (ROADMAP.yaml) · Spec gap report ✓ (docs/reports/v1-gap-analysis.md)

## Decision

Phase 0 is **complete**. Two staged items (live CI, release automation) are intentionally inert pending the user's decision to enable git; they do not gate Phase 1 or Phase 2 work. ROADMAP.yaml updated to `status: completed`.
