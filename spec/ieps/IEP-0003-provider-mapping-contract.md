# IEP-0003: Provider Mapping Contract

| Field | Value |
|---|---|
| **Title** | Provider mapping contract: separate, pure, fail-closed mapping artifacts |
| **Number** | IEP-0003 |
| **Status** | Implemented (retroactive) |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | 1.0.0 |

## Summary

Retroactively formalizes the v1 provider mapping contract: mappings are separate artifacts (`*.iap-map.yaml`, `apiVersion: mapping.iap.dev/v1`), applied as a **pure function** `(canonical document, active profile, mapping) → provider plan` with no ambient lookups; coverage is **fail-closed** via a `supports` matrix; realization is first-match-wins over structural-equality `when` clauses with total `derive` maps; and every abstract output attribute a kind declares must be bound. This is the mechanism behind success criteria S2 (swap the mapping, keep the document) and S6 (new provider = new artifact, zero core changes).

## Motivation

The mapping contract is where "provider-free intent" meets real platforms without leaking. Three commitments drove the design: **separation** (no mapping content ever embedded in a document, so intent stays portable and reviewable at intent level); **purity** (identical inputs → byte-identical canonical plans, keeping plans reviewable, cacheable, reproducible in CI, and keeping AI out of the execution path — nothing between canonical document and plan involves judgment); and **fail-closed coverage** (silently dropping a field is the single worst mapping failure mode, because the document would claim an intent the deployed infrastructure does not honor).

## Problem statement

The shipped design — [Chapter 12](../chapters/12-provider-mapping.md) and [`iap-mapping-v1.schema.json`](../schema/iap-mapping-v1.schema.json) — carried no recorded rationale for artifact separation, the no-ambient-lookup rule, or the deliberately expression-free `realize`/`derive` grammar.

## Goals

- Record the separate-artifact decision and the mapping's version surface (`version` + `specCompat` range).
- Record purity: no account state, no "latest" resolution, no clock, no network at mapping time; genuine runtime values enter as explicit, hashed mapping inputs.
- Record fail-closed `supports` (fields, values, relationships) and its version dimension (newer-minor constructs reject, never warn).
- Record deterministic realization: ordered rules, structural-equality `when`, three `derive` forms (`constant`, `from`, `from`+`map`), total maps, supports/realize tiling.
- Record output binding and the equivalence definition (§12.8): equivalent outcomes over capability assertions, not identical resources.

## Non-goals

- Plan artifact format and execution semantics ([IEP-0011](IEP-0011-deterministic-planning-contract.md), [Chapter 14](../chapters/14-planning-model.md)).
- Mapping certification program mechanics beyond Chapter 24 CM ([IEP-0012](IEP-0012-provider-conformance.md)).
- Cost models shipped with mappings ([IEP-0005](IEP-0005-cost-model.md)).

## Terminology

- **Supports matrix** — per-kind declaration of exactly what a mapping can realize (fields, values, relationship verbs).
- **Realize rule** — ordered `when`/`targets`/`derive` entry; first match wins.
- **Explicit mapping input** — a named parameter supplied to the invocation, recorded in the plan, and included in the determinism hash.
- **Equivalence** — two mappings realize the same document equivalently when every capability assertion, intent floor, relationship assertion, and abstract output holds under both ([Chapter 12](../chapters/12-provider-mapping.md) §12.8).

## Detailed design

Normative text: [Chapter 12](../chapters/12-provider-mapping.md); machine-readable contract: [`iap-mapping-v1.schema.json`](../schema/iap-mapping-v1.schema.json). Recap of the load-bearing choices:

- **Separation.** Mappings live in their own files and are never embedded (the composite/composition split familiar from platform-engineering practice). The only provider-facing content a document may carry is `extensions.<ns>` refinement, which mappings MAY read under the Non-Interference Rule ([Chapter 11](../chapters/11-extension-framework.md)). A tool MUST refuse a mapping whose `specCompat` excludes the specification version in force.
- **Purity.** Reconciliation against live state belongs to the planner, strictly after the plan exists. Anything a realization genuinely needs from the world (zone lists, resolved image digests) enters as explicit inputs so the determinism check ([Chapter 24](../chapters/24-conformance.md) §24.4) still holds.
- **Deterministic realization without expressions.** `when` is structural equality against the canonical document — no expressions, regexes, or lookups — so rule selection is trivially auditable; rule order is part of the mapping's identity and conformance hash. Every `derive` `map` MUST cover every supported source value; a gap is a mapping defect caught by conformance, never a runtime fallback. `supports` and `realize` must tile exactly.
- **Output binding.** Every abstract attribute the core declares per kind (`identifier`, `endpoint`, `connectionSecret`) MUST be bound to a plan attribute of a resource the rule actually produces — even if no document currently exports it — keeping document `outputs` and cross-resource wiring portable.

## Schema impact

None new. Documents the shipped [`iap-mapping-v1.schema.json`](../schema/iap-mapping-v1.schema.json) (supports/realize/outputs contract, semver + range fields, closed kind and verb enums).

## Runtime-model impact

Mappings consume the CIM's canonical projection read-only ([IEP-0008](IEP-0008-canonical-infrastructure-model.md), invariant I5/CM-6 alignment); they never mutate intent.

## Validation impact

None on document validation. Mapping-time rejection diagnostics (unsupported kind/field/value/verb) are the mapping engine's obligation; validators are unaffected.

## Provider impact

This IEP *is* the provider contract. The worked reference is the AWS example in [Chapter 12](../chapters/12-provider-mapping.md) §12.6 (relational `Database` → `aws:rds:DBInstance` + subnet group + secret; `Queue` → `aws:sqs:Queue` with a fifo/default rule pair); §12.7 shows the same kinds decomposing differently on Azure, GCP, and Kubernetes without any document change.

## Security impact

Fail-closed coverage is a security property: `encryption.atRest: required` or `exposure: private` outside a mapping's honored floor rejects rather than realizing something weaker (CM-5). Mappings may exceed a `preferred` posture, never weaken a `required` one.

## Cost impact

Mapping artifacts are the distribution vehicle for cost models ([Chapter 16](../chapters/16-cost-model.md) §16.1); nothing in this contract prices anything.

## Compatibility

Documents existing v1 behavior. Mapping artifacts version independently of the specification; breaking mapping changes bump the mapping's own major ([Chapter 10](../chapters/10-versioning.md) §10.4).

## Migration

None required.

## Alternatives considered

1. **Mapping sections embedded in IaP documents** — rejected: couples intent to one provider, breaks S2/S6, and turns intent review into provider review.
2. **Expression language in `derive`/`when`** (templating, general predicates) — rejected: reintroduces the audit and determinism surface the policy language also excludes; structural equality plus total maps covers v1 needs.
3. **Best-effort realization with warnings for unsupported fields** — rejected: silent or soft dropping means deployed infrastructure diverges from declared intent; fail-closed is non-negotiable.

## Rejected alternatives

- **Ambient "latest" resolution at mapping time** — destroys reproducibility; replaced by explicit, hashed mapping inputs.
- **Per-document pinning of mapping internals** — the document pins nothing about mappings; `specCompat` and the invocation select the artifact.

## Implementation plan

Already implemented in the v1.0.0 draft (Chapter 12, mapping schema, reference mapping example under `spec/mappings/`). Conformance harness automation lands with [IEP-0012](IEP-0012-provider-conformance.md).

## Conformance requirements

Covered by [Chapter 24](../chapters/24-conformance.md) §24.2.4 CM-1…CM-6 (schema, fail-closed coverage, total derive maps, output binding, capability assertions, purity/non-interference) and §24.4 (double-run hash equality with network disabled; the network-off run doubles as the purity check). Planner-side enforcement: CP-4.

## Open questions

1. **How `exposure: internal` is realized** should eventually be declarable mapping metadata ([gap analysis](../../docs/reports/v1-gap-analysis.md) §5.2) — IEP-worthy, minor.
2. Mapping certification levels, signed manifests, and attestation packaging — owned by [IEP-0012](IEP-0012-provider-conformance.md).
3. Plan artifact schema the mapping output feeds — owned by [IEP-0011](IEP-0011-deterministic-planning-contract.md).

## Decision

Adopted in IaP v1.0.0 draft; formalized retroactively per Phase 0.5.

## References

- [Chapter 12 — Provider Mapping](../chapters/12-provider-mapping.md); [`iap-mapping-v1.schema.json`](../schema/iap-mapping-v1.schema.json)
- [Chapter 11 — Extension Framework](../chapters/11-extension-framework.md); [Chapter 24 — Conformance](../chapters/24-conformance.md)
- [IEP-0011](IEP-0011-deterministic-planning-contract.md); [IEP-0012](IEP-0012-provider-conformance.md); [v1 gap analysis](../../docs/reports/v1-gap-analysis.md)
