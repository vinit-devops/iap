# Phase 8 Completion Report — Architecture and Visualization Engine (engine scope, M8.1–M8.3)

**Date:** 2026-07-10 · **Milestones:** M8.1–M8.3 completed (`docs/milestones/M8.1-architecture-engine.md`); **M8.4 (CLI + LSP integration) pending — wave B**, so the phase itself stays **in-progress**.

## Exit criteria verification

| Exit criterion                                     | Status   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every official example produces valid diagrams     | **Pass** | All 9 examples (`spec/examples/*.iap.yaml`) × all applicable views (architecture, dependency, network, security, plus one application view per `Application` resource — 45+ view instances) produce a non-empty, well-formed `ViewGraph`, Mermaid source starting `flowchart TD`, and DOT source starting `digraph` (`packages/architecture/test/architecture.test.ts`, per-example loop, 9 tests + corpus-count test).                                                        |
| Diagram semantics match planner dependencies       | **Pass** | The dependency view **is** the planner's ordering DAG: it renders `deriveOrdering(buildGraph(model))` from `@iap/graph` — the same derivation `executionWaves` layers for the planner — arc-for-arc in provisioning direction (before → after). Verified: `orders-db --ordering--> web` for basic-webapp; every dependency-view node participates in an ordering arc; no labels or containers (`dependency view semantics` block, 3 tests).                                    |
| A plan can be visualized as an architecture change | **Pass** | `diffViews(before, after)` marks every node/edge `added`/`removed`/`changed`/`unchanged`: base vs `production`-profile canonical models flag exactly the profile-overridden resources as `changed` (spec-level detection via `specHash`, invisible to labels); a synthetic resource addition renders `:::added` + `classDef added` in Mermaid and the reverse diff renders `removed` (`diffViews` block, 3 tests). The Phase 14 drift overlay reuses this mechanism unchanged. |
| Layout changes do not affect plan hashes           | **Pass** | By construction there is **no layout data in the semantic output to change**: every `ViewGraph` for every example × view is scanned recursively and contains no `x`/`y`/`position`/`layout`/`coordinates`/`width`/`height` key (per-example loop assertion). Diagram derivation is read-only over `CanonicalModel` and never feeds back into canonicalization, so plan hashes are untouched; styling (diff classes, dashes) is a cosmetic channel outside node/edge identity.  |

## Determinism (ch. 18 §18.3 / ch. 24)

A recursively key-shuffled basic-webapp canonicalizes to the identical hash and yields **byte-identical** Mermaid and DOT for every view; golden snapshots pin the complete Mermaid (architecture + nested-zone network) and DOT source for a 2-resource document byte-for-byte.

## Scope notes

- **Outputs delivered:** JSON graph (`ViewGraph` with stable node/edge ids, `/resources/<id>` provenance pointers), Mermaid, Graphviz DOT. **SVG/PNG are renderer concerns** (ch. 18 §18.3): the conformance artifact is textual source; any Mermaid/Graphviz renderer rasterizes it.
- **Deferred:** M8.4 CLI + LSP integration (wave B). Provider-realized, data-flow, and HA/DR views require Phase 6/7 artifacts as inputs; drift overlay is Phase 14 (diff mechanism ready). Interactive graph component belongs to the designer (Phase 15).

## Verification state

`pnpm --filter @iap/model --filter @iap/graph --filter @iap/architecture run build` green; `pnpm exec vitest run packages/architecture` → **35/35 passed**; `pnpm exec eslint packages/architecture` clean; Prettier applied.

## Decision

Phase 8 engine scope (M8.1–M8.3) is **complete**; phase status remains **in-progress** pending M8.4 (wave B).
