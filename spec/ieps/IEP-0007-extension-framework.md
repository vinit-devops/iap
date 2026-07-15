# IEP-0007: Extension Framework

| Field | Value |
|---|---|
| **Title** | Extension framework: namespaced refinement under the Non-Interference Rule |
| **Number** | IEP-0007 |
| **Status** | Implemented (retroactive) |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | 1.0.0 |

## Summary

Retroactively formalizes the v1 extension framework: provider- and platform-specific refinement lives exclusively in flat, namespaced `extensions` blocks — registered with a pinned package version at document level, refined per resource — governed by the normative **Extension Non-Interference Rule**: deleting every `extensions` block from a valid document MUST yield a valid document with identical core semantics. Extensions refine *how* intent is realized; they can never change *what* the document asserts.

## Motivation

A provider-free core needs a sanctioned escape hatch, or provider needs will leak into core fields and destroy portability (success criterion S1). The framework resolves the tension by giving providers an unbounded refinement surface while giving consumers a guarantee that reading only the core document tells them everything the infrastructure *means*. The rule cuts both ways deliberately — and it is mechanically checkable: the deletion test (validate, strip all `extensions`, validate again, compare outcomes and canonical core semantics) is a required conformance case.

## Problem statement

The shipped design ([Chapter 11](../chapters/11-extension-framework.md), with versioning rules in [Chapter 10](../chapters/10-versioning.md) §10.4) carried no recorded rationale for rejecting inline provider fields, for the flat namespace grammar, or for the sharp `x-*`-versus-extensions split.

## Goals

- Record the namespace grammar (`^[a-z][a-z0-9-]*$`, flat, with well-known reserved namespaces) and the two-level model: document-level **registration** (pins `extensions.<ns>.version`, full semver) and resource-level **refinement** (never re-declares a version).
- Record the Non-Interference Rule and its five concrete prohibitions (satisfy no core requirement; alter no validation outcome; add/remove/retarget no relationships or verbs; change/shadow/reinterpret no intent field; affect no canonical form, normalized graph, dependency order, or diagram) — violation is IAP803.
- Record tolerance for unknown namespaces: IAP802 warning, never an error; content preserved verbatim through parse, canonicalization, merge, and re-serialization.
- Record what packages contribute (sub-schemas, additive validation rules, mappings, icons, cost models, security rules, docs) and packaging conventions (immutable versioned artifact with manifest, schemas, docs; independent semver per [Chapter 10](../chapters/10-versioning.md) §10.4).
- Record the `x-*` vs. `extensions` contract split: scratch space for one tool vs. versioned, reviewed, portable ecosystem contract.

## Non-goals

- Extension package registry, distribution, and signing mechanics (see Open questions; signing intersects [IEP-0012](IEP-0012-provider-conformance.md)).
- Any mechanism for extensions to add kinds, fields, enum values, or relationship verbs to the core (closed sets; minor/major evolution only, [Chapter 10](../chapters/10-versioning.md)).

## Terminology

- **Namespace** — flat lowercase identifier owning an extension surface; well-known names are reserved for the ecosystems they name.
- **Registration / refinement** — document-level version pin vs. resource-level realization refinement.
- **Deletion test** — the mechanical check that stripping all `extensions` blocks preserves validity and core semantics.
- **Non-Interference Rule** — the normative guarantee above; the foundation of IaP portability.

## Detailed design

Normative text: [Chapter 11](../chapters/11-extension-framework.md). Recorded decisions:

- **Two levels, two roles.** Registration pins exactly one package version per namespace for the whole document; tools resolving packages MUST NOT substitute versions silently. Refinement blocks carry only content the package's sub-schemas define.
- **Non-interference as the portability theorem.** Because extensions cannot alter core semantics, a tool that ignores an unknown namespace entirely still processes the document correctly (it merely cannot apply that ecosystem's refinements); failing a document for carrying an unknown namespace is itself a conformance failure.
- **Contribution surface bounded by the rule.** Package validation rules may only add findings about the package's own content; security rules may never suppress core findings; icons and styling never change graph shape; mappings ship as separate artifacts that *read* refinement blocks as input ([Chapter 12](../chapters/12-provider-mapping.md) §12.1).
- **`x-*` is not a lightweight extension.** Opposite contracts: `x-*` is free-form, unversioned, non-portable, ignored by all conformance requirements; `extensions` is schema-validated, versioned, reviewed against the behavioral clauses, and load-bearing for IAP802/IAP803 and the deletion test. Rule of thumb: if a second tool should ever understand it, it belongs in an extension package.

## Schema impact

None new. Documents the shipped `extensions` structures in [`iap-v1.schema.json`](../schema/iap-v1.schema.json) (document-level registration map with `version`, resource-level namespace map, namespace pattern).

## Runtime-model impact

Extensions pass through the CIM byte-preserving and are never interpreted by core engines ([IEP-0008](IEP-0008-canonical-infrastructure-model.md) invariant I3: extension deletion yields identical core semantics).

## Validation impact

None new; codifies IAP802 (unknown namespace, warning) and IAP803 (non-interference violation, error) in Phase 8 ([Chapter 8](../chapters/08-validation.md), [Chapter 10](../chapters/10-versioning.md) §10.7).

## Provider impact

Extensions are the only in-document channel providers get. The worked example in [Chapter 11](../chapters/11-extension-framework.md) §11.2 — an `extensions.aws` block selecting a memory-optimized instance family for a `Database` — shows refinement that a mapping may read, while deleting the block leaves the same PostgreSQL-intent document. Well-known namespaces (`aws`, `azure`, `gcp`, `kubernetes`, `cloudflare`, `onprem`) prevent spelling divergence.

## Security impact

Non-interference is a security boundary: extension content can only *narrow* derived posture, never widen reachability, weaken encryption, or alter derived privileges ([Chapter 15](../chapters/15-security-model.md) §15.1, §15.7; permission-like extension content that changes grants is IAP803).

## Cost impact

Extension packages may ship cost models; advisory only, never validity-affecting ([Chapter 16](../chapters/16-cost-model.md)).

## Compatibility

Documents existing v1 behavior. Extension packages version independently; breaking package-schema changes bump the *package* major, never the specification ([Chapter 10](../chapters/10-versioning.md) §10.4).

## Migration

None required.

## Alternatives considered

1. **Inline provider fields on core resources** (e.g. an instance-type field on `Database`) — rejected: the exact structure the Non-Interference Rule exists to forbid; breaks S1/S2 and makes intent review provider review.
2. **A single untyped `provider:` bag per resource** — rejected: no versioning, no schema, no multi-ecosystem coexistence, and nothing to enforce non-interference against.
3. **Dotted hierarchical namespaces** (`aws.rds`) — rejected: flat namespaces keep registration one-to-one with packages; internal structure is the package's own concern.

## Rejected alternatives

- **Extension-contributed relationship verbs or kinds** — the verb set and kind vocabulary are closed; extensions may contribute edge *attributes* under `x-*` keys only.
- **Treating `x-*` keys as portable mini-extensions** — `x-*` carries no contract by definition; portable semantics require a versioned package.

## Implementation plan

Already implemented in the v1.0.0 draft (Chapter 11, schema, IAP802/IAP803 codes). Deletion-test automation lands with the reference validator.

## Conformance requirements

Covered by [Chapter 24](../chapters/24-conformance.md): CD-8 (deletion test yields a conforming document with identical core semantics), CV-4 (IAP802 emitted, never silent), CM-6 (mappings never alter semantics when consuming refinements). Suite gap: an IAP803 expected-failure case ([gap analysis](../../docs/reports/v1-gap-analysis.md) §4).

## Open questions

1. Missing IAP803 conformance case (extension block that changes core semantics) — Phase 1 addition per gap analysis §4.
2. Package registry, resolution, and signing mechanics — future phase; signed-manifest treatment aligns with [IEP-0012](IEP-0012-provider-conformance.md).
3. Behavioral review process for the non-mechanical non-interference clauses (who reviews a package's rules before registration) — governance follow-up, [GOVERNANCE.md](../../GOVERNANCE.md).

## Decision

Adopted in IaP v1.0.0 draft; formalized retroactively per Phase 0.5.

## References

- [Chapter 11 — Extension Framework](../chapters/11-extension-framework.md); [Chapter 10 — Versioning](../chapters/10-versioning.md)
- [Chapter 12 — Provider Mapping](../chapters/12-provider-mapping.md); [Chapter 15 — Security Model](../chapters/15-security-model.md); [Chapter 24 — Conformance](../chapters/24-conformance.md)
- [IEP-0008](IEP-0008-canonical-infrastructure-model.md); [IEP-0012](IEP-0012-provider-conformance.md); [v1 gap analysis](../../docs/reports/v1-gap-analysis.md)
