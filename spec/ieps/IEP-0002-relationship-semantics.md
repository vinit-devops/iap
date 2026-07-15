# IEP-0002: Relationship Semantics

| Field | Value |
|---|---|
| **Title** | Relationship semantics: canonical edges, closed verb set, derived ordering |
| **Number** | IEP-0002 |
| **Status** | Implemented (retroactive) |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | 1.0.0 |

## Summary

Retroactively formalizes the v1 relationship model: every relationship normalizes to one canonical edge `(source, type, target, attributes)`; the verb set is closed at ten; edges are declared inline on the source (normal form) or as selector-based rule edges at the top level; and execution order is never written — it is derived from the normalized graph, with every verb except `dependsOn` (pure ordering) and `replicatesTo` (no ordering) implying *target before source*. This IEP records why relationships — not resource fields, and not a declared order — carry the system's semantics.

## Motivation

An IaP document describes a system, not a list. Making relationships first-class, typed, and closed lets everything downstream be **derived**: execution waves ([Chapter 9](../chapters/09-dependency-model.md)), zero-trust reachability and least privilege ([Chapter 15](../chapters/15-security-model.md)), routing, triggers, and diagrams. A closed verb set is load-bearing: dependency derivation, security derivation, and mapping coverage all dispatch on the verb, and a validator that met an unknown verb could not degrade safely — hence verbs are frozen for the entire major ([Chapter 10](../chapters/10-versioning.md) §10.2.1).

## Problem statement

The shipped design — [Chapter 4](../chapters/04-relationship-model.md) (edge model, verbs, attributes, declaration forms, normalization) and [Chapter 9](../chapters/09-dependency-model.md) (derivation, DAG requirement, planner obligations) — carried no recorded rationale for the two-form declaration surface, the closed verb set, or the `replicatesTo` ordering exception.

## Goals

- Record the canonical edge tuple and the single-normalized-model rule (no dual semantics).
- Record the closed ten-verb set, verb/target-kind constraints, and the five verb-scoped attributes.
- Record the inline-plus-rule-edge design and the six-step deterministic normalization algorithm.
- Record "order is derived, never declared" and the ordering exceptions.

## Non-goals

- Adding verbs or attributes (major-only by definition).
- Failover semantics for symmetric `replicatesTo` (explicitly out of scope for v1; see Open questions).
- Planner execution mechanics ([Chapter 14](../chapters/14-planning-model.md), [IEP-0011](IEP-0011-deterministic-planning-contract.md)).

## Terminology

- **Canonical edge** — the normalized tuple `(source, type, target, attributes)`; `description`/`x-*` are excluded from edge identity.
- **Rule edge** — a top-level relationship whose source is a label selector; expands during normalization.
- **Ordering arc** — the *target-before-source* constraint an edge contributes to the dependency graph.

## Detailed design

Normative text: [Chapter 4](../chapters/04-relationship-model.md) §4.2–§4.7 and [Chapter 9](../chapters/09-dependency-model.md). The decisions being recorded:

- **One canonical model, two declaration forms.** Point-to-point edges MUST be inline on the source resource — this buys locality (a resource's behavior reads in one place) and diffability (changing what `api` talks to diffs on `api`). The top-level `relationships` array is reserved exclusively for selector-based rule edges ("every `tier: backend` Service is `monitoredBy` platform-alerts"), which would otherwise require N repeated inline declarations. Both forms normalize to indistinguishable canonical edges; a rule-edge selector matching zero resources is an error (IAP402) because a rule that governs nothing is presumed a mistake.
- **Closed, semantic verbs.** Ten verbs, each a semantic assertion (`connectsTo` is the *sole* source of reachability and least-privilege derivation; `routesTo` the sole source of routing; `consumesFrom` defines Function triggers). Normative verb/target-kind constraints (IAP301) and per-verb attribute validity (IAP302) keep every edge machine-interpretable. `dependsOn` accepts no attributes — pure ordering asserts nothing an attribute could refine.
- **Derived ordering.** Every semantic verb implies *target before source*; `dependsOn` is that implication alone; `replicatesTo` implies **no** ordering, which is precisely what makes symmetric replication declarable without an ordering contradiction. The dependency graph must be a DAG (IAP401, full cycle path reported); planners topologically sort, parallelize by waves, and tear down in reverse ([Chapter 9](../chapters/09-dependency-model.md) §9.4).
- **Deterministic normalization.** The fixed pipeline — profile merge, rule-edge expansion (lexicographic match order), inline collection, reference/shape validation, deduplication, stable sort — yields a byte-identical normalized edge set for identical inputs; it is an input to canonical form ([Chapter 1](../chapters/01-architecture.md)).

## Schema impact

None new. Documents the shipped `relationshipEdge` and top-level `relationships` structures in [`iap-v1.schema.json`](../schema/iap-v1.schema.json).

## Runtime-model impact

The normalized edge set is `CanonicalModel.edges` and feeds `derived.dependencyGraph` ([IEP-0008](IEP-0008-canonical-infrastructure-model.md)); invariant I7 (inline vs. rule spelling yields identical CIMs) depends on this IEP's normalization.

## Validation impact

None new; codifies IAP201, IAP301, IAP302, IAP401, IAP402 ([Chapter 4](../chapters/04-relationship-model.md) §4.8, [Chapter 8](../chapters/08-validation.md)).

## Provider impact

Mappings declare per-kind realizable verbs in `supports.relationships` and realize canonical edges only — e.g. one `connectsTo` edge becomes security-group/firewall rules on hyperscalers and a NetworkPolicy on Kubernetes ([Chapter 12](../chapters/12-provider-mapping.md) §12.7).

## Security impact

None new; the edge graph plus `access` attributes is the entire least-privilege input ([IEP-0006](IEP-0006-security-model.md)).

## Cost impact

None directly; orphan-edge heuristics feed cost suggestions ([Chapter 16](../chapters/16-cost-model.md) §16.4).

## Compatibility

Documents existing v1 behavior. New attributes are minor-eligible; new verbs are major-only (closed set).

## Migration

None required.

## Alternatives considered

1. **Edges as a separate top-level section only** — rejected: destroys locality and diffability; the common point-to-point case would live far from the resource it describes.
2. **Inline-only** — rejected: organization-wide wiring (monitoring, protection) degenerates into N copies that drift; selectors express the rule once.
3. **Both forms with normalization** — chosen: normal-form rule (inline for point-to-point, top level for rules only) prevents the two surfaces from becoming interchangeable dialects.

## Rejected alternatives

- **Open/extensible verb set** — validators and mappings cannot degrade safely on unknown verbs.
- **Bidirectional edges as one declaration** — direction is semantic (source verb target); symmetry is expressed as two `replicatesTo` edges, made consistent by the no-ordering rule.
- **Declared execution order** (`order`, `phase`, `waitFor`) — reintroduces the imperative drift IaP exists to eliminate ([Chapter 9](../chapters/09-dependency-model.md) §9.1).

## Implementation plan

Already implemented in the v1.0.0 draft (chapters 4 and 9, schema, conformance cases). No further steps.

## Conformance requirements

Covered by [Chapter 24](../chapters/24-conformance.md): CD-3 (verb/attribute rules), CD-4 (acyclic ordering, selector resolution), CP-5 (no hidden ordering); suite cases `valid/02-relationships`, `invalid/04-dangling-target` (IAP201), `invalid/05-ordering-cycle` (IAP401).

## Open questions

1. **`replicatesTo` failover semantics** — symmetric replication is declarable, but who is writable after failover is undefined in v1; the [gap analysis](../../docs/reports/v1-gap-analysis.md) §5.3 recommends an explicit non-goal note in a 1.0.x patch and a dedicated future IEP for the real design.
2. Missing conformance cases for IAP301/IAP302/IAP402 (gap analysis §4) — pure additions, Phase 1.
3. Wave construction and tie-breaking beyond lexicographic order — owned by [IEP-0011](IEP-0011-deterministic-planning-contract.md).

## Decision

Adopted in IaP v1.0.0 draft; formalized retroactively per Phase 0.5.

## References

- [Chapter 4 — Relationship Model](../chapters/04-relationship-model.md); [Chapter 9 — Dependency Model](../chapters/09-dependency-model.md)
- [Chapter 15 — Security Model](../chapters/15-security-model.md); [Chapter 14 — Planning Model](../chapters/14-planning-model.md)
- [IEP-0008](IEP-0008-canonical-infrastructure-model.md); [IEP-0011](IEP-0011-deterministic-planning-contract.md); [v1 gap analysis](../../docs/reports/v1-gap-analysis.md)
