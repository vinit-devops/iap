# 23. Language Server Protocol Integration

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter designs the IaP language server — the single component behind every IDE integration. Editors differ; the language server does not: any LSP-capable editor gains the full authoring experience with zero editor-specific logic. This chapter is normative for the capability contract and the derivation rule of §23.1; sample interactions are informative.

## 23.1 Server Model

The language server wraps the reference SDK ([Chapter 21](21-reference-sdk.md)) and obeys one rule: **every feature derives from schema annotations plus SDK engines — no bespoke logic**. Completion lists come from the schema's enum and `if/then` structures; hover text comes from schema `description` fields; diagnostics come from the validation pipeline; navigation comes from the Reference/Relationship Engine's resolved edges. The server contains formatting and protocol plumbing only. Consequently, a schema revision or SDK upgrade changes editor behavior with no server code change, and the editor can never disagree with `iap validate` — they share one engine.

The server operates on the Parser's positioned AST, so every response maps to exact source ranges even while the document is mid-edit and partially invalid.

## 23.2 Capabilities

### 23.2.1 Completion (`textDocument/completion`)

Completion is driven entirely by the schema's per-kind `if/then` branches and the `description`/`default` annotations, plus document-derived identifier scopes:

- **Kinds** — the `kindName` enum, offered at `kind:`; each item's documentation is the kind's schema `description`, with reserved kinds labeled as such.
- **Fields** — properties valid at the cursor's path for the resource's declared `kind` (resolved through the matching `if/then` branch), sorted required-first; detail text shows type and `default`.
- **Enum values** — allowed values at the cursor (e.g. `availability:` → `standard|high|maximum`), each documented from the enum's parent `description`.
- **Relationship targets** — resource identifiers in scope: the keys of the document's `resources` map, filtered by the verb's normative target-kind constraints ([Chapter 4 §4.3.1](04-relationship-model.md)) so `storesDataIn` offers only storage-capable kinds.
- **Verbs** — the closed `relationshipType` set at `relationships[].type:`, with the ordering implication of each verb in its documentation.

### 23.2.2 Hover (`textDocument/hover`)

Hover renders the schema `description` for the field or value under the cursor, badged with `x-iap-since` ("since 1.2") and `x-iap-deprecated` where present. Semantic vocabulary gets its normative expansion: hovering `availability: high` shows the SLO floor definition ("≥ 99.95%, multi-zone") from [Chapter 3](03-resource-model.md); hovering a relationship verb shows its semantic assertion and implied ordering.

### 23.2.3 Diagnostics (`textDocument/publishDiagnostics`)

On every change (debounced, §23.4) the server runs the full validation pipeline — phases 1–8 of [Chapter 8](08-validation.md) — against the in-memory document. Each SDK finding becomes one LSP diagnostic: the IaP code in `code` (linked to its chapter anchor via `codeDescription`), the finding's source position as the range, and severity mapped `error → Error`, `warning → Warning`, `info → Information`. Findings that arise only under a profile merge are published when the user has selected an active profile in the editor (a server configuration setting); the default is the base document, matching `iap validate`.

### 23.2.4 Code Actions (`textDocument/codeAction`)

Every code action is the surfaced form of a deterministic SDK artifact — never a heuristic:

- **Require-effect policy autofixes** — a `require` policy finding whose `fix` merge-patch is present ([Chapter 21 §21.4](21-reference-sdk.md), [Chapter 7](07-policy-language.md)) becomes a quick fix applying exactly that patch.
- **Add missing required field** — for IAP1xx missing-property findings, insert the field with its schema `default` (or a placeholder when no default exists).
- **Extract to profile** — refactor the selected field values into an `overrides` entry of a chosen profile, expressed as the equivalent RFC 7386 patch ([Chapter 6](06-profiles.md)); the merged result is re-validated before the edit is offered.

### 23.2.5 Document Symbols (`textDocument/documentSymbol`)

The outline lists resources grouped by capability family ([Chapter 5](05-capability-model.md)), derived from each kind's `x-iap-capability` annotation — e.g. *compute*: `api`, `worker`; *database*: `db` — followed by profiles, policies, and outputs.

### 23.2.6 Definition and References (`textDocument/definition`, `textDocument/references`)

Identifier navigation follows the Reference/Relationship Engine's resolved references: a relationship `target` jumps to the resource key it names, and references on a resource key list every edge, `outputs.resource`, and `Application.components` entry that points at it. Profile `extends` chains navigate profile-to-profile, and rule-edge selectors list the resources they currently match.

### 23.2.7 Semantic Tokens (`textDocument/semanticTokens`)

Kinds, relationship verbs, and enum values receive distinct token types so themes can distinguish structure (`kind: Database`), semantics (`connectsTo`), and vocabulary (`required`) from ordinary strings. Token classification comes from the schema position of each node, not from lexical pattern matching.

### 23.2.8 Inlay Hints (`textDocument/inlayHint`)

- **Resolved defaults** — omitted fields with schema defaults render ghosted (e.g. `exposure: private`, `encryption.atRest: required`), making the omission-never-weakens-posture rule visible at the point of omission.
- **Estimated cost** — when a price snapshot is loaded into the server (configuration setting naming the snapshot artifact), each resource shows its Cost Engine estimate (`≈ $164/mo`).
- **Derived access** — relationship edges show the Security Engine's derived grant (`→ grant: read-write`).

### 23.2.9 Architecture Preview (custom extension `iap/preview`)

A custom protocol request — namespaced `iap/preview`, ignored by clients that do not know it — takes `{ uri, view, profile? }` where `view` is one of the five derived views of [Chapter 18](18-architecture-model.md) (`architecture|dependency|network|security|application`) and returns the Diagram Generator's Mermaid text for the current document state. Clients render it in a side panel that re-requests on the diagnostics debounce cycle, giving a live architecture diagram that is, by construction, always in sync with the text.

## 23.3 Workspace Scope

v1 is **single-document**: each open `*.iap.yaml` file is an independent universe, matching the specification's document-scoped reference rules ([Chapter 2](02-document-layout.md)). Multi-document workspaces (cross-document outputs, shared profile libraries) are deferred to a future minor alongside any specification-level multi-document semantics; the server reserves the `iap/` request namespace for those capabilities.

## 23.4 Performance Contract

- **Incremental re-validation.** The server re-parses incrementally from LSP content changes and re-runs only the pipeline stages whose inputs changed — an edit inside one resource's `spec` re-validates that branch against its kind sub-schema and re-runs graph-dependent stages only when identifiers, relationships, profiles, or policies were touched.
- **Latency target.** For documents under 100 resources, full diagnostics (all eight phases) SHOULD complete within **200 ms** of the debounce firing; the debounce interval SHOULD be 200–300 ms of keystroke quiet. Completion and hover, which read precomputed schema indexes, SHOULD respond within 50 ms.
- **Cancellation.** In-flight validation MUST be cancellable when a newer edit supersedes it, per standard LSP `$/cancelRequest` semantics; the server never publishes diagnostics computed from a stale document version.

Because every capability is a pure function over document + schema + versioned inputs, the server is trivially testable against the conformance suite ([Chapter 24](24-conformance.md)): each invalid conformance case MUST surface its expected IaP code as a diagnostic at the documented position.
