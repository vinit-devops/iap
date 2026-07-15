# IEP-0005: Cost Model

| Field | Value |
|---|---|
| **Title** | Cost model: annotation layer, versioned price snapshots, budgets as policies |
| **Number** | IEP-0005 |
| **Status** | Implemented (retroactive) |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | 1.0.0 |

## Summary

Retroactively formalizes the v1 cost model: cost is an **annotation layer computed by tooling**, never document content. A cost report is a pure function of three versioned inputs — the canonical profile-merged document, a mapping cost model, and a content-addressed price snapshot — and attaches to *derived* artifacts as `x-iap-cost` annotations. Budgets are ordinary `deny` policies over annotation paths (IAP505); optimization suggestions come only from deterministic rules; a parallel `x-iap-carbon` channel reuses the identical structure.

## Motivation

Cost depends on provider, region, term, and time — all binding decisions that occur to the right of the intent document ([Chapter 1](../chapters/01-architecture.md) §1.3). Embedding prices would couple a portable document to one provider's commercial terms and break determinism across time. Keeping cost as a projection preserves the core promise (a document means the same thing on every provider) while still giving authors budget enforcement, roll-ups, and savings suggestions — all attributable: a report changes only because the document, the cost model version, or the snapshot changed.

## Problem statement

The shipped design ([Chapter 16](../chapters/16-cost-model.md)) carried no recorded rationale for the annotation-only rule, the snapshot discipline (no live pricing lookups), or the reuse of the policy language for budgets instead of a dedicated budget mechanism.

## Goals

- Record the three-input report function and its determinism requirement (byte-identical report for identical inputs, §16.9).
- Record the per-resource report vocabulary: `estimatedMonthly`, `estimatedHourly`, `currency`, `confidence` (`exact`/`estimate`/`unknown`), `assumptions`; `unknown` reports no numbers and taints roll-ups as lower bounds.
- Record roll-up dimensions (per `Application` components, per label, per profile; weakest member confidence wins).
- Record budget-as-policy semantics (plan-time evaluation, IAP505, "not yet evaluated" at validation time) and the advisory-only status of suggestions and commitment savings.

## Non-goals

- Price snapshot file format and distribution (implementation; see Open questions).
- The plan artifact that carries annotations at evaluation time ([IEP-0011](IEP-0011-deterministic-planning-contract.md)).
- Observed-utilization ingestion mechanics (versioned inputs; future phase).

## Terminology

- **Mapping cost model** — cost functions distributed with a provider mapping artifact, pricing each supported kind/field combination.
- **Price snapshot** — a versioned, content-addressed capture of provider list prices; produced/refreshed via MCP pricing sources ([Chapter 20](../chapters/20-mcp-integration.md)), never queried per-run.
- **`x-iap-cost`** — the annotation object tooling attaches to resources in derived artifacts; semantically ignored by validators.

## Detailed design

Normative text: [Chapter 16](../chapters/16-cost-model.md). Recorded decisions:

- **Annotation, never content.** The core document MUST NOT contain prices, rates, or currency amounts. Tools MAY surface reports inline in derived artifacts (annotated plans, LSP hovers, diffs); writing annotations back into source is NOT RECOMMENDED and validators MUST ignore them for all semantic purposes.
- **Determinism via snapshot discipline.** Same canonical document + same cost model version + same snapshot id → byte-identical report. Live lookups at computation time are forbidden; MCP sources exist to *produce* snapshots, not to answer per-run queries. This mirrors the mapping purity rule ([IEP-0003](IEP-0003-provider-mapping-contract.md)).
- **Honest uncertainty.** `confidence: unknown` entries carry no numbers; roll-ups including them are flagged as lower bounds; budget evaluation reports them as unevaluable (warning), never silently passed.
- **Budgets are policies.** No separate budget mechanism: a `deny` rule with `greater-than` over `x-iap-cost.estimatedMonthly`, threshold mirrored in inert `params` for display. Because annotations exist only after cost computation, budget policies evaluate at plan time; at validation time the path is absent and tools SHOULD report "not yet evaluated" rather than passed. Document-level budgets target `Application` roll-ups.
- **Suggestions are deterministic rules** (oversizing, excess availability, orphaned resources) with rule id, resource path, and projected delta — never model inference ([Chapter 19](../chapters/19-ai-guidelines.md)); commitments (reserved/committed-use) surface as suggestions and are never auto-applied.
- **Carbon parity.** `x-iap-carbon` reuses the structure verbatim (gCO2e/month, same confidence and assumptions discipline, intensity snapshots as inputs).

## Schema impact

None. Cost artifacts are tool output; the document schema is untouched (annotations ride the existing `x-` passthrough in derived artifacts).

## Runtime-model impact

None to the CIM — cost annotations never enter `canonicalBytes()` or the hash; estimates key off the CIM hash for reproducibility ([IEP-0008](IEP-0008-canonical-infrastructure-model.md)).

## Validation impact

IAP505 (`budget-exceeded`) at plan time, naming policy id, resource path, annotated amount, and `params` threshold; IAP504 diagnostics apply to malformed comparisons as with any policy ([IEP-0004](IEP-0004-policy-language.md)).

## Provider impact

Mappings SHOULD ship cost models covering their supports matrix; pricing granularity follows the mapping's realization choices (e.g. an instance-based realization prices instances; a request-based realization prices requests — the document is unchanged either way).

## Security impact

None. Reports may reveal sizing/scale metadata; they inherit the document's sensitivity, nothing more.

## Cost impact

This IEP *is* the cost interface; it imposes no runtime cost on core validation.

## Compatibility

Documents existing v1 behavior. Report vocabulary changes are minor-eligible; the annotation-only rule is invariant for the major.

## Migration

None required.

## Alternatives considered

1. **Prices as document fields** — rejected: couples intent to commercial terms, breaks cross-provider portability and cross-time determinism.
2. **Live pricing API calls during planning** — rejected: nondeterministic, network-dependent, unauditable; snapshots make every report attributable.
3. **A dedicated budget construct** (separate `budgets:` section) — rejected: the policy language already expresses thresholds; one governance mechanism keeps evaluation order and reporting uniform.

## Rejected alternatives

- **Mandatory cost estimation for document conformance** — cost coverage varies by mapping; conformance cannot depend on a tool-side projection.
- **Auto-applied optimization or commitment purchases** — financial decisions require humans; suggestions are advisory by rule.

## Implementation plan

Already specified in the v1.0.0 draft (Chapter 16). Tooling (report generator, snapshot producer) is roadmap Phase 9+ work; the annotation interface and budget semantics are frozen here.

## Conformance requirements

Covered by [Chapter 24](../chapters/24-conformance.md): S7 (cost derived automatically) and the §24.4 determinism procedure applied to the cost deriver ("substitute derived artifact for plan"); budget behavior rides CD-5/Phase 5 machinery at plan time. No dedicated cost cases exist in the current suite (see Open questions).

## Open questions

1. Price snapshot format, content-addressing, and distribution channel — implementation decision, aligned with the versioned-input treatment in [IEP-0011](IEP-0011-deterministic-planning-contract.md).
2. Where budget findings live in the plan artifact — owned by [IEP-0011](IEP-0011-deterministic-planning-contract.md).
3. Determinism fixtures for cost reports (golden report hashes) — blocked on the canonicalization gaps owned by [IEP-0008](IEP-0008-canonical-infrastructure-model.md) ([gap analysis](../../docs/reports/v1-gap-analysis.md) §4, §6).

## Decision

Adopted in IaP v1.0.0 draft; formalized retroactively per Phase 0.5.

## References

- [Chapter 16 — Cost Model](../chapters/16-cost-model.md); [Chapter 7 — Policy Language](../chapters/07-policy-language.md)
- [Chapter 12 — Provider Mapping](../chapters/12-provider-mapping.md); [Chapter 20 — MCP Integration](../chapters/20-mcp-integration.md)
- [IEP-0004](IEP-0004-policy-language.md); [IEP-0008](IEP-0008-canonical-infrastructure-model.md); [IEP-0011](IEP-0011-deterministic-planning-contract.md); [v1 gap analysis](../../docs/reports/v1-gap-analysis.md)
