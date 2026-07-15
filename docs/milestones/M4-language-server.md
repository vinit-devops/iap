# Milestone M4 — Infrastructure Language Server (`@iap/language-server`)

**Phase:** 4 — Infrastructure Language Server
**Milestones:** M4.1 (diagnostics/completion/hover) + M4.2 (navigation/rename/code actions) + M4.3 (custom protocol extensions) + M4.4 (performance + caching), delivered together as `@iap/language-server` 0.1.0
**Status:** Completed
**Date:** 2026-07-10

## Implemented

One package, two layers — a **pure provider core** (`src/providers.ts`: every capability is an async function over `(text, position)` with no LSP types in its signature) and a **thin LSP binding** (`src/server.ts`: connection, capability announcement, shape mapping — nothing else). The core is what the tests exercise; the binding is protocol plumbing only, satisfying the ch. 23 §23.1 rule that every feature derives from schema annotations plus SDK engines, with no bespoke logic. Bin entry: `iap-language-server` (stdio).

The one schema-facing piece of machinery is `resolveSchemaAt(pointer, document)`: it walks the normative JSON Schema to any JSON Pointer, following `$ref` chains and dispatching the per-kind `if/then` branches by reading the instance's `kind` alongside — completion, hover, and placeholder derivation all sit on it. Cursor positions map to pointers through the parser's per-node source map (tightest containing range), never through lexical pattern matching.

### Capability map (spec ch. 23 §23.2 / roadmap Phase 4 feature list)

| Ch. 23 capability                 | Status   | Derivation                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §23.2.1 Completion                | ✓        | kinds from the `kindName` enum with per-kind `description` (reserved kinds labeled); fields from the kind-dispatched subschema, required-first, type/default in detail; enum values with the enum's parent `description`; relationship targets = the document's resource ids (kind in detail); verbs = the closed `relationshipType` enum. Works inside profile `overrides` too (document-shaped merge patch, pointer remapped to the root; `extends` completes profile names) |
| §23.2.2 Hover                     | ✓        | schema `description` + `default` + `enum` + `x-iap-since`/`x-iap-deprecated` badges; `availability` renders its SLO-floor definition; a `kind:` value renders that kind's description                                                                                                                                                                                                                                                                                          |
| §23.2.3 Diagnostics               | ✓        | `@iap/sdk` `validate()` (executable phases 1–4) + the document's own policies (`policies()`, phase 5) — identical engines to `iap validate`, so editor and CLI cannot disagree; `Finding.path` → range via the source map with nearest-ancestor fallback, whole-document range when unresolvable                                                                                                                                                                               |
| §23.2.4 Code actions              | ✓        | `require`-policy autofix merge patches (RFC 7386, from `@iap/policy`) and add-missing-required-field inserts for IAP101 with the schema `default` (or first enum value / typed placeholder); extract-to-profile deferred                                                                                                                                                                                                                                                       |
| §23.2.5 Document symbols          | ✓        | resources (kind in detail), profiles, policies (effect in detail), outputs (target resource in detail); capability-family grouping deferred until `x-iap-capability` moves from description text to a machine annotation                                                                                                                                                                                                                                                       |
| §23.2.6 Definition and references | ✓        | resource-id navigation over document-derived sites: `/resources` keys, inline + rule-edge `target`s, Application `spec.components`, `outputs.*.resource`, Gateway `spec.tls.certificate`, and profile `overrides.resources` keys                                                                                                                                                                                                                                               |
| Rename (roadmap)                  | ✓        | all reference sites + the resource key; new name validated against the resource-id grammar; collisions rejected; renamed documents re-validate clean (tested)                                                                                                                                                                                                                                                                                                                  |
| §23.2.7 Semantic tokens           | deferred | Phase 13 (IDE integrations) — token classification will reuse `resolveSchemaAt`                                                                                                                                                                                                                                                                                                                                                                                                |
| §23.2.8 Inlay hints               | deferred | resolved-defaults and derived-access hints need no new inputs (Phase 13); estimated-cost hints need the Phase 10 Cost Engine                                                                                                                                                                                                                                                                                                                                                   |
| §23.2.9 `iap/preview`             | ✓        | `{uri, view, application?}` → `canonical()` → `deriveView` → `toMermaid` for all five ch. 18 views; plus `iap/canonical` `{uri}` → canonical JSON + hash (`iap normalize` parity). **Plan preview deferred to Phase 7** (no plan format exists yet, IEP-0011)                                                                                                                                                                                                                  |

Roadmap-list items not in ch. 23's numbered set: syntax/schema/semantic/policy diagnostics ✓ (the pipeline above); relationship navigation ✓ (references from either edge end); profile inspection ✓ partial (symbols, override-aware completion/hover; an active-profile diagnostics setting is deferred with the settings surface); extension validation deferred to the Phase 11 unified pipeline (LSP diagnostics stay identical to `iap validate`, which does not run phase 8 yet); document formatting deferred (`iap fmt` covers it; a formatting provider joins the formatting-preserving-edit work); cost/security/compliance findings deferred to Phases 10/11; natural-language compiler endpoint deferred to Phase 3.

### Protocol extension specification

Custom requests are namespaced `iap/` (reserved by ch. 23 §23.3); clients that do not know them never send them:

- `iap/preview` — params `{uri: string, view: 'architecture'|'dependency'|'network'|'security'|'application', application?: string}`, result `{mermaid: string}`. Errors: unknown document / unknown view → `InvalidParams`; unparseable document or missing `application` for the application view → `InvalidRequest` with the engine's message.
- `iap/canonical` — params `{uri: string}`, result `{canonicalJson: string, hash: string}` (the C5+C6 byte projection and its SHA-256).

### Performance and caching (M4.4)

- **Caching model:** a single-entry analysis cache keyed on exact document text memoizes the SDK workspace per document version; the workspace itself memoizes `validate`/`canonical`/`policies`, so one debounce cycle plus all follow-up completion/hover/navigation requests share one parse + validation + canonicalization.
- **Debounce:** 150 ms per document; a pass is dropped when a newer version supersedes it before or during computation (stale diagnostics are never published).
- **Measured** (vitest, 5 cold runs each, Node 22, Apple Silicon): full diagnostics on the largest official example (`enterprise-pci`, 221 lines, policies included) **avg 16.6 ms**; on a synthetic 110-resource document **avg 31.0 ms** — both far inside the ch. 23 §23.4 target of 200 ms for documents under 100 resources. The suite soft-asserts < 1000 ms to avoid CI flake and logs the measured values.

## Files changed

Created: `packages/language-server/{package.json,tsconfig.json,src/{providers.ts,server.ts,main.ts,index.ts},test/providers.test.ts}`, this document, `docs/reports/phase-4-completion.md`. Modified: `ROADMAP.yaml`, `CHANGELOG.md`, `docs/architecture/compatibility-matrix.md`, `pnpm-lock.yaml`.

## Tests added

31 provider-core tests (no connection): IAP102 position on conformance case 01; clean basic-webapp; whole-document fallback for unparseable text; policy findings with dot-path→range resolution; completion for kinds/verbs/targets/enums/properties (+ inside profile overrides); `resolveSchemaAt` kind dispatch and `$ref` tracking; hover (SLO text, kind values); definition/references (6 sites for `orders-db`, including both profile overrides); rename round-trip re-validating clean, invalid-grammar and collision rejection; symbols for all four groups; both code actions materializing **and** clearing their findings when applied; all preview paths; two performance benchmarks. Plus an out-of-suite generic-LSP-client smoke test (raw JSON-RPC over stdio: initialize → didOpen → publishDiagnostics → `iap/preview`/`iap/canonical` → shutdown) run during verification.

## Conformance status

Green: full `pnpm run verify` — build ×9 packages, ESLint clean, 407 passed + 5 skipped unit tests, 59/59 conformance harness checks.

## Architecture decisions

1. **Pure core + thin binding.** Providers take `(text, position)` and return protocol-neutral shapes (0-based positions, structurally LSP-compatible). Everything is testable without a connection, and a future browser or MCP host can reuse the core unchanged.
2. **The SDK is the only engine.** Diagnostics call `validate()` + `policies()`; previews call `canonical()`; autofix edits re-serialize through `serialize('yaml')`. The server adds positioning and protocol — nothing the CLI could disagree with.
3. **Profile overrides are document-shaped.** `/profiles/*/overrides/...` pointers remap to the document root for schema resolution, with the patch merged over the base so kind dispatch still sees each resource's `kind` — completion and hover work inside overrides without any override-specific schema.
4. **Version-memoized whole-document analysis instead of branch-level incremental re-validation.** Ch. 23 §23.4 sketches stage-level incrementality; measured cold-pass cost (≈31 ms at 110 resources) is ~6× inside the budget, so v1 re-runs the memoized pipeline per version. Branch-level incrementality is deferred until profiling shows a document class that needs it.

## Specification gaps

None found in ch. 23 itself. Two observations recorded for future IEP/annotation work: `x-iap-capability` lives in kind `description` strings rather than as a machine annotation (blocks §23.2.5 capability-family grouping); the schema's `overrides: {type: object}` is opaque, so override-aware tooling must know the merge-patch rule out-of-band (this package encodes it once, in `schemaResolutionTarget`).

## Security findings

None. The server performs no network I/O and requires no credentials of any kind (roadmap exit criterion): its only inputs are document text over stdio and the embedded schema.

## Known limitations

- **Autofix code actions lose comments** — the edit re-serializes the whole document through the SDK round-trip serializer (key order preserved, comments dropped). Documented in the provider; formatting-preserving edits are deferred alongside the formatting provider.
- **Single-document scope** (ch. 23 §23.3 v1): each document is an independent universe; no cross-document references or shared profile libraries.
- **Missing-required-field inserts** handle block-style YAML only; flow-style objects (`spec: {}`) get no offer rather than a wrong edit.
- Diagnostics cover the executable pipeline (phases 1–5); phases 6–8 join when their engines land (Phase 11), automatically — the server has no phase list of its own.

## Next milestone

M8.4 (architecture CLI/LSP integration) is now satisfied from the LSP side via `iap/preview`; Phase 13 (M13.1 VS Code extension) consumes this server; Phase 7 adds the plan-preview request.
