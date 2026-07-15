# IEP-0001: Resource Model

| Field | Value |
|---|---|
| **Title** | Resource model: flat `resources` map with `kind` discriminator |
| **Number** | IEP-0001 |
| **Status** | Implemented (retroactive) |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | 1.0.0 |

## Summary

Retroactively formalizes the v1 resource model: every unit of infrastructure intent is one entry in a single flat `resources` map, keyed by a DNS-label identifier and discriminated by a PascalCase `kind`. Thirteen kinds are fully specified, nine are reserved, and all share one uniform entry shape (`kind`, `description`, `labels`, `spec`, `relationships`, `extensions`) and one shared intent vocabulary. This IEP records the rationale for decisions already shipped in the v1.0.0 draft, giving the existing design the same review trail as future changes (Phase 0.5 exit criterion).

## Motivation

The resource model is the substrate every other chapter builds on. Three forces shaped it:

1. **Uniform graph node.** The relationship model ([Chapter 4](../chapters/04-relationship-model.md)) treats the document as a directed graph. A single flat map gives every resource identical addressability — one reference grammar (`target: orders-db`) regardless of kind — so edges, selectors, outputs, and profiles never need per-kind reference forms.
2. **Zero top-level schema churn.** Adding a kind in a future minor grows the `kind` enum and adds one `$defs` entry; the top-level key set never changes. Capability-keyed sections would make every new capability family a top-level (major-only) structural change.
3. **No forced buckets.** Capability families (compute, database, messaging) are taxonomy, not structure ([Chapter 5](../chapters/05-capability-model.md)). Section-per-capability layouts force each kind into exactly one bucket even where classification is arbitrary (is a search index storage or database?); the flat map makes the question moot.

## Problem statement

The shipped design existed only as chapter text — [Chapter 2](../chapters/02-document-layout.md) §2.3/§2.6 and [Chapter 3](../chapters/03-resource-model.md) — with no recorded decision rationale or alternatives trail, violating the Phase 0.5 rule that no normative surface exists without an IEP.

## Goals

- Record the flat-map/kind-discriminator decision and its rationale.
- Record the Field Definition Contract (definition, type, allowed values, normative default, since-version, deprecation) and the "omission equals default" determinism rule.
- Record the shared intent vocabulary and the 13-full + 9-reserved kind split.

## Non-goals

- Changing any kind, field, default, or grammar (this IEP is documentation of shipped design).
- Specifying reserved kinds (future minors) or cross-document references (`imports`, reserved).

## Terminology

- **Kind** — PascalCase discriminator selecting the kind-specific `spec` schema; closed 22-name set in v1.
- **Field Definition Contract** — the six-part definition every field carries ([Chapter 3](../chapters/03-resource-model.md) §3.1.1).
- **Abstract output attribute** — provider-neutral output name (`identifier`, `endpoint`, `connectionSecret`) bound by mappings ([Chapter 3](../chapters/03-resource-model.md) §3.3).

## Detailed design

The design is normative in [Chapter 2](../chapters/02-document-layout.md) (§2.3 top-level keys, §2.6 the `resources` map and identifier grammar) and [Chapter 3](../chapters/03-resource-model.md) (kind catalog), with [`iap-v1.schema.json`](../schema/iap-v1.schema.json) as the machine-readable source of truth. Recap of the load-bearing decisions:

- **One map, one shape.** `resources` is a flat map; the key is the identifier (DNS-label grammar, unique by construction) and the entry has exactly six properties plus `x-` passthrough. There are deliberately no top-level capability sections, no `environment` key (profiles), no `applications` key (`kind: Application` with `spec.components`), and no `dependencies` key (derived — [Chapter 9](../chapters/09-dependency-model.md)).
- **Closed vocabularies.** `additionalProperties: false` everywhere; unknown kinds and fields are schema errors (IAP102/IAP101). The only escape valves are `x-` keys (non-semantic, preserved verbatim) and namespaced `extensions` ([Chapter 11](../chapters/11-extension-framework.md)).
- **Normative defaults.** Every optional field has a default, and omitting a field is semantically identical to writing it — the basis of canonical-form determinism ([Chapter 2](../chapters/02-document-layout.md) §2.7). Defaults are safe-by-default: `exposure: private`, encryption `required`/`required`, `backup: required` on `Database`/`Volume`.
- **Shared vocabulary over per-kind invention.** `availability` (SLO floors, never topology words), `exposure`, `size`, `encryption`, `observability`, `resilience`, quantity/duration grammars, and `artifact` are `$defs/common/*` definitions reused — at most restricted, never redefined — across kinds.
- **Abstract outputs.** Kinds declare provider-neutral output attributes; documents export only these, and mappings must bind all of them ([Chapter 12](../chapters/12-provider-mapping.md) §12.5).
- **Reserved kinds.** Nine names are enum-registered with an intentionally loose schema and IAP801 warning, so graduation in a minor is additive ([Chapter 10](../chapters/10-versioning.md) §10.3).

## Schema impact

None new. Documents the shipped structures in [`iap-v1.schema.json`](../schema/iap-v1.schema.json): if/then kind dispatch, `$defs/common/*`, `$defs/kinds/ReservedKind`, identifier patterns.

## Runtime-model impact

The resource entry is the node type of the Canonical Infrastructure Model ([IEP-0008](IEP-0008-canonical-infrastructure-model.md) `CanonicalResource`).

## Validation impact

None new; codifies the existing IAP1xx/IAP2xx behavior ([Chapter 8](../chapters/08-validation.md)).

## Provider impact

None new. The kind/field surface is exactly what mapping `supports` matrices enumerate; informative realization tables live in each kind's section (e.g. `Database` → RDS/Cloud SQL/Cosmos DB-class managed services).

## Security impact

None new; safe defaults and the `Secret`/`Identity` kinds are inputs to derived posture ([IEP-0006](IEP-0006-security-model.md)).

## Cost impact

None; kinds carry no prices ([IEP-0005](IEP-0005-cost-model.md)).

## Compatibility

Documents existing v1 behavior; kind/field additions are minor-eligible, removals major-only ([Chapter 10](../chapters/10-versioning.md)).

## Migration

None required.

## Alternatives considered

1. **Capability-keyed top-level sections** (`compute:`, `database:`, …) — rejected: top-level churn per new family, forced buckets, and two reference grammars (section + name).
2. **Application-rooted nesting** (resources declared under applications) — rejected: grouping is itself intent, so it became `kind: Application` with `components`; nesting would privilege one grouping dimension and complicate references.
3. **Per-kind API versions** (`Database/v2`) — rejected: kinds version with the specification, keeping compatibility one-dimensional ([Chapter 10](../chapters/10-versioning.md) §10.3).

## Rejected alternatives

- **Open kind vocabulary** (author-defined kinds with free schemas) — destroys portability and fail-closed mapping coverage.
- **Arrays of resources with a `name` field** — duplicates-by-construction and weaker reference semantics than map keys.

## Implementation plan

Already implemented in the v1.0.0 draft (chapters 2–3, schema, examples, conformance cases). No further steps.

## Conformance requirements

Covered by existing [Chapter 24](../chapters/24-conformance.md) obligations: CD-1 (schema, identifier grammar, closed vocabularies), CD-2 (references), CD-10/IAP105 (banned terms); suite cases `valid/01-minimal`, `invalid/01-unknown-kind`, `invalid/02-bad-enum`, `invalid/06-bad-resource-id`.

## Open questions

1. Default materialization of wholly absent nested objects and the quantity normalization table — owned by [IEP-0008](IEP-0008-canonical-infrastructure-model.md) ([gap analysis](../../docs/reports/v1-gap-analysis.md) §2).
2. Reserved-kind portability posture (loose `ReservedKind` schema) — acceptable for v1; conformance docs should discourage reserved kinds in portable documents (gap analysis §5.4).
3. Per-kind backup-default schema annotations — 1.0.x annotation fix (gap analysis §3.1).

## Decision

Adopted in IaP v1.0.0 draft; formalized retroactively per Phase 0.5.

## References

- [Chapter 2 — Document Layout](../chapters/02-document-layout.md); [Chapter 3 — Resource Model](../chapters/03-resource-model.md); [Chapter 5 — Capability Model](../chapters/05-capability-model.md)
- [`iap-v1.schema.json`](../schema/iap-v1.schema.json)
- [IEP-0008](IEP-0008-canonical-infrastructure-model.md); [v1 gap analysis](../../docs/reports/v1-gap-analysis.md)
