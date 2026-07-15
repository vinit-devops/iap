# IEP-0004: Policy Language

| Field | Value |
|---|---|
| **Title** | Policy language: structural condition trees, no embedded expression language |
| **Number** | IEP-0004 |
| **Status** | Implemented (retroactive) |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | 1.0.0 |

## Summary

Retroactively formalizes the v1 policy language: governance rules live in the document's top-level `policies` array as finite trees of structural matchers (leaves `{field, operator, value?}` under `allOf`/`anyOf`/`not`), with nine operators, three effects (`deny`, `require`, `warn`), and evaluation defined as a total, terminating, side-effect-free function of the canonical document. The defining decision — **no embedded expression language in v1** — is recorded here: no Rego, no CEL, no templating, no arithmetic, no cross-resource quantification.

## Motivation

Policies are the governance layer ("encryption is mandatory", "nothing public", "stay under budget") and must be as deterministic and auditable as the documents they govern. A policy file audited today must evaluate identically forever against the same document. General-purpose expression languages reintroduce non-obvious evaluation order, environment-dependent behavior, and an unbounded audit surface; structural matchers keep every rule mechanically enumerable, byte-for-byte reproducible, and — for `require` conjunctions of `equals` — even deterministically autofixable.

## Problem statement

The shipped design ([Chapter 7](../chapters/07-policy-language.md)) declares the Rego/CEL exclusion as "deliberate, not a gap" but carried no IEP recording the trade-off, the operator-set rationale, or the boundary with dedicated validation phases.

## Goals

- Record the rule anatomy (`id`, `target` kinds+selector, `rule`, `effect`, inert `params`).
- Record operator semantics: `equals`, `not-equals`, `in`, `not-in`, `exists`, `absent`, `greater-than`/`less-than` over exactly three domains (numbers, quantities, durations — mismatches evaluate false with IAP504 diagnostic), and `matches` restricted to RE2 (linear time, no backtracking).
- Record unresolved-path semantics (`absent` true, `exists` false, everything else false).
- Record effect polarity (`deny` matches the forbidden state, `require` the mandatory state, `warn` non-failing) and the deterministic evaluation order (policies by `id`, resources by ID, canonical post-merge document as input).

## Non-goals

- Cross-resource invariants ("every Service must connect to a Database") — those belong to relationship/security/compliance validation phases ([Chapter 8](../chapters/08-validation.md)), not the policy phase.
- Compliance framework bundle content ([Chapter 17](../chapters/17-compliance-model.md)) — bundles reuse this machinery.
- New operators (minor-eligible, strictly additive).

## Terminology

- **Condition tree** — nested `allOf`/`anyOf`/`not` combinators over leaves; the only rule form.
- **Targeted resource** — a resource matching both `target.kinds` and `target.selector` (each optional; `target: {}` is all resources).
- **Deterministic autofix** — for a `require` rule whose condition is an `equals` conjunction, setting each `field` to its `value`; proposed as a document edit, never applied silently.

## Detailed design

Normative text: [Chapter 7](../chapters/07-policy-language.md). The recorded decisions:

- **Declarative, per-resource, canonical input.** A condition sees exactly one resource of the profile-merged, defaults-applied document — so a resource omitting `encryption` still evaluates with `spec.encryption.atRest: required`. Policies never see the pre-merge document. All findings from all policies are reported; there is no precedence or short-circuiting across resources.
- **Dot-path fields, no path language.** `field` is a literal dot path from the resource entry root (`kind`, `labels.team`, `spec.encryption.atRest`, annotation paths like `x-iap-cost.monthly`); no wildcards, indexing, or array quantifiers in v1.
- **Closed operator set with three-domain ordering.** Ordered comparison is defined only where a canonical magnitude exists (numbers; quantity grammar; duration grammar), keeping comparisons total and deterministic.
- **Effects mapped to fixed error codes.** `deny` → IAP501, `require` → IAP502, `warn` → IAP503; policy evaluation is validation Phase 5 (IAP5xx space). Budget policies are ordinary `deny` rules over `x-iap-cost.*` paths, evaluated at plan time when annotations exist (IAP505; [Chapter 16](../chapters/16-cost-model.md) §16.7).
- **`params` are inert** — thresholds, currency, ticket links for display and roll-up only; they never alter evaluation.

The canonical governance set (encryption required, max cost, allowed regions via labels, required labels, no public exposure, backup for critical tiers, logs required) is worked in [Chapter 7](../chapters/07-policy-language.md) §7.7 and demonstrates that v1's structural matchers cover the target governance scenarios without expressions.

## Schema impact

None new. Documents the shipped `policies` array structures in [`iap-v1.schema.json`](../schema/iap-v1.schema.json) (operator enum, effect enum, condition-tree recursion).

## Runtime-model impact

Policies are carried as `CanonicalModel.policies`; policy-sourced defaults record `policy` provenance ([IEP-0008](IEP-0008-canonical-infrastructure-model.md)).

## Validation impact

None new; codifies Phase 5 (IAP501–IAP505) and the deterministic finding order tested under CV-7.

## Provider impact

None. Policies are provider-free by construction; provider-conditional governance is expressed over labels or extension-reviewed rules, never over provider nouns (IAP105 applies to policy field values as core positions).

## Security impact

Policies are one of the three derivation sources of security posture ([Chapter 15](../chapters/15-security-model.md) §15.1); compliance bundles (IAP7xx) activate pre-packaged policy sets through the same machinery.

## Cost impact

Budget validation reuses policies unchanged — no separate budget mechanism exists ([IEP-0005](IEP-0005-cost-model.md), [Chapter 16](../chapters/16-cost-model.md) §16.7).

## Compatibility

Documents existing v1 behavior. New operators are minor-eligible; an expression language will not be added to v1 ([Chapter 7](../chapters/07-policy-language.md) §7.8).

## Migration

None required.

## Alternatives considered

1. **Rego (OPA)** — rejected for v1: powerful but non-obvious evaluation semantics, an external toolchain in the trust path, and an audit surface unbounded by the document.
2. **CEL** — rejected for v1: closer to deterministic, but still an expression language with environment/library variance; the closed operator set covers the governance corpus without one.
3. **JSON Schema as the policy carrier** — rejected: conflates structural validity (Phase 1) with governance (Phase 5) and cannot express effects/severities cleanly.

## Rejected alternatives

- **Arithmetic, string interpolation, lookups into other resources, time- or environment-dependent conditions, user-defined functions** — each categorically excluded to preserve the evaluate-identically-forever guarantee (§7.8).

## Implementation plan

Already implemented in the v1.0.0 draft (Chapter 7, schema, `valid/03-profiles-policies` case). Remaining test additions are Phase 1 conformance work.

## Conformance requirements

Covered by [Chapter 24](../chapters/24-conformance.md): CD-5 (no violated `deny`/`require` post-merge), CV-5 (profile-merged evaluation), CV-7 (deterministic finding order); suite case `valid/03-profiles-policies`. A post-merge IAP5xx expected-failure case is a known suite gap.

## Open questions

1. **`require` autofix scope** — deterministic autofix is defined for `equals` conjunctions; behavior for `in`/`matches` is unspecified. [Gap analysis](../../docs/reports/v1-gap-analysis.md) §5.1 recommends autofixing `equals` leaves only, all else report-only; non-breaking 1.0.x clarification.
2. Missing IAP5xx conformance case (deny + require post-merge) — gap analysis §4, Phase 1 addition.
3. Plan-time budget evaluation depends on the annotated plan artifact — owned by [IEP-0011](IEP-0011-deterministic-planning-contract.md).

## Decision

Adopted in IaP v1.0.0 draft; formalized retroactively per Phase 0.5.

## References

- [Chapter 7 — Policy Language](../chapters/07-policy-language.md); [Chapter 8 — Validation](../chapters/08-validation.md)
- [Chapter 16 — Cost Model](../chapters/16-cost-model.md); [Chapter 17 — Compliance Model](../chapters/17-compliance-model.md)
- [IEP-0005](IEP-0005-cost-model.md); [IEP-0011](IEP-0011-deterministic-planning-contract.md); [v1 gap analysis](../../docs/reports/v1-gap-analysis.md)
