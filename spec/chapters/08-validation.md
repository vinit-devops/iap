# 8. Validation

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.3.0 (IEP-0017) · Status: Released**

## 8.1 Overview

Validation is the gate between an authored document and everything downstream — planning, mapping, execution. This chapter defines the **normative validation pipeline**: eight ordered phases, each with its own error-code range, each producing machine-readable findings (Section 8.6). A conformant validator ([Chapter 24](24-conformance.md)) implements all eight phases with the semantics below.

| Phase | Name | Codes | Detects |
|---|---|---|---|
| 1 | Schema | IAP1xx | Structural violations of the document schema |
| 2 | Reference | IAP2xx | Dangling identifiers |
| 3 | Relationship | IAP3xx | Verb/kind and attribute/verb incompatibility |
| 4 | Dependency | IAP4xx | Ordering cycles, unresolvable selectors |
| 5 | Policy | IAP5xx | Policy rule violations |
| 6 | Security | IAP6xx | Built-in security invariant violations |
| 7 | Compliance | IAP7xx | Framework bundle violations |
| 8 | Version/Extension | IAP8xx | Version skew, reserved kinds, extension interference |

Error codes match `^IAP[1-8][0-9]{2}$`. Each phase owns its hundred-block; codes are stable across specification minors and MUST NOT be renumbered.

## 8.2 Severity Model and Failure Semantics

Every finding carries a **severity**: `error` or `warning`.

- An **error** makes the document invalid: tools MUST refuse to produce a plan or a provider mapping input from it, and CLIs exit non-zero ([Chapter 22](22-cli.md)).
- A **warning** is reported but never invalidates the document.

Each code has a fixed default severity defined by this specification (Phase 5 severities derive from policy `effect`: `deny`/`require` → error, `warn` → warning). Tools MAY offer escalation of warnings to errors (a strict mode); tools MUST NOT downgrade errors to warnings.

**Collect-all within a phase; gate between phases.** Validators MUST NOT stop at the first finding: within a phase, all findings MUST be collected and reported. Between phases, later phases MAY be skipped **only if an earlier phase produced at least one error** — each phase assumes the invariants established by its predecessors (policy paths presume a schema-valid document; cycle detection presumes resolved references). If earlier phases produced only warnings, validators MUST continue through all eight phases.

## 8.3 Profile Interaction

Validation is defined relative to profile merging ([Chapter 6](06-profiles.md)):

- **Phase 1 runs twice: pre-merge and post-merge.** Pre-merge, the document *as written* — including all profile definitions and the structural shape of every `overrides` block — MUST be schema-valid. Post-merge, the canonical document produced for the selected profile MUST be schema-valid again: a merge patch can delete required fields or introduce invalid values, and only post-merge validation catches it.
- **Phases 2–8 run post-merge only**, against the canonical document. Semantic validity is therefore always *relative to a profile*: a document may be valid under `staging` and invalid under `production`.
- Profile resolution errors — an `extends` naming an undefined profile, an `extends` cycle, or selection of an undefined profile — abort the merge and are reported as reference errors (**IAP205**).

When no profile is selected (lint-only invocation), phases 2–8 run against the base document.

## 8.4 The Phases

### Phase 1 — Schema (IAP1xx)

The document is validated against [`iap-v1.schema.json`](../schema/iap-v1.schema.json) under **JSON Schema draft 2020-12**. Conformant validators MUST register the `x-iap-*` annotation vocabulary (`x-iap-since`, `x-iap-deprecated`, `x-iap-capability`, `x-iap-reserved`, `x-iap-presence-semantic`, `x-iap-default-when`; [Chapter 10](10-versioning.md), [Chapter 1](01-architecture.md) §1.5.1) so annotated schemas compile without unknown-keyword failures; the annotations themselves impose no assertions.

Representative codes:

- **IAP101** — schema constraint violation (missing required field, wrong type, extra property under `additionalProperties: false`).
- **IAP102** — unknown kind (value outside the kind enum).
- **IAP103** — invalid value (enum, pattern, or range violation; e.g. a malformed quantity).
- **IAP104** — conflicting or inert field combination: a cross-field constraint the schema cannot express. Example: `spec.deadLetter.maxReceives` set while `spec.deadLetter.enabled` is not `true` — the field would silently do nothing, which IaP treats as an authoring error. Cross-field semantic constraints such as `scaling.min` ≤ `scaling.max` and `Database` engine/class consistency are IAP104.
- **IAP105** — banned provider term in a free-string core position (error): the closed schema rejects provider concepts structurally, and IAP105 catches banned terms ([Chapter 24](24-conformance.md) §24.3) smuggled through free-string core fields such as label values.

Some conflicts are excluded by the schema itself and surface as plain IAP103 — for example `Gateway` with `exposure: private` is simply outside the Gateway exposure enum, because a private gateway is a contradiction in terms ([Chapter 3](03-resource-model.md)).

### Phase 2 — Reference (IAP2xx)

Every identifier that names another part of the document must resolve. Duplicate resource IDs are **impossible by construction** — resources are a map keyed by ID, so no duplicate-ID code exists.

- **IAP201** — dangling relationship target: an inline edge or rule edge `target` naming no resource in the `resources` map.
- **IAP202** — dangling component: an `Application` `spec.components` entry naming no resource.
- **IAP203** — dangling output: `outputs.*.resource` naming no resource, or `attribute` not among the abstract attributes declared for that kind ([Chapter 3](03-resource-model.md)).
- **IAP204** — dangling certificate: `Gateway` `spec.tls.certificate` naming no `Certificate` resource.
- **IAP205** — profile reference error: unknown `extends` target, `extends` cycle, or unknown selected profile (Section 8.3).

### Phase 3 — Relationship (IAP3xx)

Edges are checked against the compatibility matrices of [Chapter 4](04-relationship-model.md):

- **IAP301** — verb/kind incompatibility: the verb's source-kind/target-kind constraints are violated (e.g. `routesTo` targeting a `Volume`, `storesDataIn` targeting a `Service`).
- **IAP302** — attribute/verb incompatibility: an edge attribute outside the verb's allowed set (e.g. `path` or `host` on any verb other than `routesTo`, `access` on `dependsOn`).
- **IAP303** — advisory relationship finding (warning): a structurally valid but suspicious relationship shape, e.g. a `Gateway` declaring no `routesTo` edge.

### Phase 4 — Dependency (IAP4xx)

Edges are normalized into the canonical graph and the derived ordering relation is checked ([Chapter 9](09-dependency-model.md)):

- **IAP401** — ordering cycle: the implied "target before source" ordering contains a cycle (recall `replicatesTo` implies no ordering and cannot participate).
- **IAP402** — unresolvable selector: a rule edge whose `source.selector` matches zero resources in the canonical document.
- **IAP403** — self-referential edge: a resource with an ordering edge to itself (the degenerate one-node cycle, reported distinctly for clarity).

### Phase 5 — Policy (IAP5xx)

Policies — document-level and any activated bundle members — are evaluated per [Chapter 7](07-policy-language.md), against the canonical, defaults-applied document, in deterministic order:

- **IAP501** — `deny` violation (error).
- **IAP502** — `require` violation (error; tools MAY offer the deterministic autofix of [Chapter 7](07-policy-language.md) §7.5).
- **IAP503** — `warn` finding (warning).
- **IAP504** — operand type mismatch in an ordered comparison (warning; the leaf evaluated false).
- **IAP505** — budget exceeded (error): a budget policy over cost annotations is violated; evaluated at plan time when cost annotations exist ([Chapter 16](16-cost-model.md)).

### Phase 6 — Security (IAP6xx)

Built-in, always-on invariants from the security model ([Chapter 15](15-security-model.md)); representative codes:

- **IAP601** — public exposure on a data kind: an `ObjectStore` with `spec.exposure: public`. Severity is error when the store is the target of any `storesDataIn` edge (it demonstrably holds application data), warning otherwise (public static-asset buckets are legitimate).
- **IAP602** — plaintext secret material: a `configuration` key matching the published credential-key pattern `(?i)(password|passwd|secret|token|api[-_]?key|private[-_]?key)` (error). Secret values MUST be modeled as `Secret` resources and wired via relationships; they never appear inline.
- **IAP603** — encryption downgrade under an active framework (error): `encryption.atRest` or `encryption.inTransit` set to `preferred` on a resource in scope of an active compliance framework that demands `required` ([Chapter 15](15-security-model.md), [Chapter 17](17-compliance-model.md)).
- **IAP604** — isolation unenforceable (error, plan-time): the selected mapping cannot enforce the declared network isolation for a resource ([Chapter 15](15-security-model.md)).

### Phase 7 — Compliance (IAP7xx)

Frameworks listed in `compliance.frameworks` activate their registered policy bundles ([Chapter 17](17-compliance-model.md)); bundle violations report in this phase so governance findings are attributable to a framework:

- **IAP701** — framework policy violation. The finding's `policyId` names the bundle policy; the message identifies the framework and control.
- **IAP702** — framework structural requirement unmet: the framework demands a field or resource that is absent (e.g. `pci-dss-4.0` requiring `Secret` rotation where no rotation is declared).

### Phase 8 — Version/Extension (IAP8xx)

- **IAP801** — reserved kind (warning): the document uses a registry kind that is still reserved in the validator's specification minor, whose full specification arrives in a future minor ([Chapter 5](05-capability-model.md)). Validators MUST accept it. **The reserved registry has been empty since 1.2.0 — all nine originally reserved kinds have graduated (five in 1.1.0 via [IEP-0015](../ieps/IEP-0015-reserved-kind-graduation.md), four in 1.2.0 via [IEP-0016](../ieps/IEP-0016-reserved-registry-graduation.md)) — so a 1.2.0-or-later validator emits IAP801 for no kind.** The `Cdn` and `EventBus` kinds introduced in 1.3.0 ([IEP-0017](../ieps/IEP-0017-new-kinds-cdn-eventbus.md)) were specified *directly* (ch. 5 §5.7), never reserved, so IAP801 MUST NOT be emitted for them either. The code and its emission are retained so that if a future minor reserves a new kind name, the warning applies to it from that point until its own graduation (ch. 5 §5.6 rule 5). The warning MUST NOT be emitted for any fully specified kind.
- **IAP802** — unknown extension namespace (warning): an `extensions` namespace not registered with the validator. Unknown namespaces warn, **never fail** ([Chapter 11](11-extension-framework.md)).
- **IAP803** — extension non-interference violation (error): the check is mechanical — strip every `extensions` block from the canonical document and re-run phases 1–7; the stripped document MUST be valid and semantically identical (same normalized graph, same findings). Any divergence is IAP803.
- **IAP804** — unknown field from a newer minor (warning): a field unknown to this validator but defined by a later published minor of the specification that the validator ships knowledge of. Reported as IAP804 instead of a Phase 1 error, preserving forward compatibility within the major ([Chapter 10](10-versioning.md)).
- **IAP805** — deprecated element in use (warning): a field, enum value, or kind carrying an `x-iap-deprecated` annotation. Deprecated elements remain valid for the entire major; the warning names the replacement and the removal major ([Chapter 10](10-versioning.md)).

## 8.5 Conflicting-Field Rules

Cross-field constraints are enforced at the earliest phase that can express them:

1. **In the schema where possible** — the conflict becomes unrepresentable. Example: `Gateway` `exposure` admits only `public | internal`; `exposure: private` fails Phase 1 as IAP103.
2. **As IAP104 structural checks** where JSON Schema is insufficient or the diagnostic would be unreadable. Example: `deadLetter.maxReceives` without `enabled: true` → IAP104 with a message naming both fields.
3. **Never as policies.** Built-in coherence rules are not expressible as user-removable policy entries; they are part of the specification.

The complete IAP104 rule list is normative and published with the schema; [Chapter 3](03-resource-model.md) marks each participating field.

## 8.6 The Finding Format

Validators MUST be able to emit findings in the following machine-readable form (the `json` output format of [Chapter 22](22-cli.md)):

| Field | Type | Required | Meaning |
|---|---|---|---|
| `code` | string | yes | `^IAP[1-8][0-9]{2}$`. |
| `severity` | `error` \| `warning` | yes | Per Section 8.2. |
| `path` | string | yes | Dot path from the document root to the offending value (`resources.orders-db.spec.resilience.backup`); array elements by zero-based index. |
| `message` | string | yes | Human-readable; not intended for programmatic matching. |
| `policyId` | string | no | Present on Phase 5 and Phase 7 findings only: the violated policy's `id`. |

Additional tool-specific fields MUST be prefixed `x-`. Finding order is deterministic: by phase, then by the phase's evaluation order (Phase 5: policy `id`, then resource ID), otherwise by `path` then `code`, all lexicographic.

```json
{
  "valid": false,
  "profile": "production",
  "findings": [
    {
      "code": "IAP502",
      "severity": "error",
      "path": "resources.orders-db.spec.resilience.backup",
      "message": "Policy backup-required-critical: spec.resilience.backup must equal \"required\" (found \"preferred\").",
      "policyId": "backup-required-critical"
    },
    {
      "code": "IAP804",
      "severity": "warning",
      "path": "resources.orders-db.spec.tieredStorage",
      "message": "Field \"tieredStorage\" is defined by a newer specification minor than this validator implements; processed but not fully validated."
    }
  ]
}
```

A document is **valid** when validation produced zero findings of severity `error` across all executed phases; downstream stages ([Chapter 9](09-dependency-model.md) onward) MUST consume only valid canonical documents.
