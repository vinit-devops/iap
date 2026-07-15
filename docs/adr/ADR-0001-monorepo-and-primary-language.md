# ADR-0001: Monorepo-first development and TypeScript as primary language

**Status:** Accepted
**Date:** 2026-07-10

## Context

The IaP ecosystem spans a specification, a reference SDK (parser, canonical model, validators, relationship/dependency engines), provider mappings, a CLI, a language server, IDE integrations, and web applications (roadmap §7). During early development these components share fast-moving internal contracts — above all the canonical model — and splitting them across repositories now would multiply release coordination cost while APIs are still unstable. Roadmap §8 explicitly recommends an umbrella monorepo with components isolated as versioned packages, one primary implementation language initially, and extraction to separate repositories only after APIs and release cycles stabilize.

M0.1 established the workspace; this ADR records the decisions it embodied.

## Decision

1. **Monorepo-first.** All specification artifacts, packages, providers, extensions, apps, tests, and tools live in one repository laid out per roadmap §8, managed as a **pnpm workspace** (`pnpm-workspace.yaml` covering `packages/*`, `providers/*`, `extensions/*`, `apps/*`; pnpm pinned via `packageManager`, currently 11.5.0; Node ≥ 22). Components move to separate repositories only after their public APIs and release cycles stabilize.
2. **TypeScript is the primary implementation language**, with **strict mode** and **NodeNext** module resolution enforced through the shared `tsconfig.base.json`. TypeScript covers the ecosystem's dominant workloads: JSON Schema tooling, LSP, CLI, IDE integrations, web UI, and shared type definitions (roadmap §8).
3. **Plain `tsc` builds, no turbo yet.** The roadmap layout lists `turbo.json`, but with the current package count a build orchestrator adds configuration surface without benefit. Turborepo (or equivalent task caching) is introduced when the package count makes cross-package build caching worthwhile — expected around the Phase 2 package fan-out.
4. **Vitest is the unit-test runner** — TypeScript-native, fast, single root config (`vitest.config.ts`).

## Consequences

- Cross-cutting changes (e.g. a canonical-model field rename) land atomically across every consumer in one reviewable change.
- One toolchain (pnpm + tsc + eslint + prettier + vitest) serves every package; contributors learn it once.
- A lower-level language (Go/Rust) may still be introduced later for performance-sensitive deployment or state components, but only after profiling demonstrates need (roadmap §8) — that introduction requires a new ADR.
- Repository size and CI time grow with the ecosystem; turbo adoption is the planned mitigation, deferred deliberately rather than omitted.
- Without turbo, `pnpm run build` rebuilds all packages; acceptable at current scale, revisit when it is not.
- Node ≥ 22 excludes older runtimes; this is acceptable for a greenfield toolchain and matches "current supported runtime LTS at implementation time".

## Alternatives considered

- **Multi-repo from the start** — rejected: forces versioned releases of unstable internal contracts, slows every cross-cutting change, and contradicts roadmap §8. Extraction later is cheap; premature separation is not.
- **Go or Rust as primary language** — rejected for now: the near-term deliverables (schema tooling, LSP, CLI, IDE and web integrations) are squarely in the TypeScript ecosystem, and a second type system hand-written in another language would drift from the normative JSON Schema (see ADR-0002). Reserved as a later, profiling-justified addition for hot paths only.
- **Adopt Turborepo immediately** — rejected: with two initial packages there is nothing to cache or orchestrate; deferring keeps the toolchain minimal. Revisit at Phase 2.
- **Jest or node:test instead of vitest** — rejected: Jest needs transform configuration for strict TS/NodeNext; node:test lacks the watch/reporting ergonomics; vitest is TS-native with one root config.

## References

- Roadmap §8 (Initial Engineering Strategy), §9.1 (Development workflow)
- [docs/milestones/M0.1-monorepo-foundation.md](../milestones/M0.1-monorepo-foundation.md)
- ADR-0002 (JSON Schema as the normative machine-readable contract)
