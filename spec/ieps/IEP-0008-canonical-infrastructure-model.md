# IEP-0008: Canonical Infrastructure Model

| Field | Value |
|---|---|
| **Title** | Canonical Infrastructure Model (CIM) |
| **Number** | IEP-0008 |
| **Status** | Draft |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | Implementation (non-normative) |

## Summary

This IEP defines the **Canonical Infrastructure Model (CIM)**: the normalized, strongly typed, in-memory representation of an IaP document that every engine — validator, relationship engine, dependency engine, policy, security, cost, compliance, architecture, planner, and intent compiler — consumes instead of raw YAML. The CIM is an implementation contract, not a document format: the portable source of truth remains `infrastructure.iap.yaml` ([Chapter 1](../chapters/01-architecture.md)), and the CIM must round-trip to that document's canonical form without loss.

## Motivation

The specification already defines the canonical form C1–C6 ([Chapter 1, §1.5](../chapters/01-architecture.md#15-canonical-form)) as a byte representation, but says nothing about the runtime object model implementations share. Without a defined CIM, each engine would re-parse, re-normalize, and re-derive independently, producing drift between validator, planner, and diagram output — exactly the nondeterminism the specification forbids. The roadmap (§4.2) requires a single normalized representation carrying resolved defaults, effective profiles, derived dependencies, provenance, and diagnostics; this IEP fixes its logical schema and invariants.

## Problem statement

There is no shared contract for: (a) what a "normalized resource" contains after profile merge and default materialization; (b) how per-field provenance (explicit / default / profile / policy — roadmap §5.8) is represented; (c) how the stable hash of the model relates to the canonical form; (d) how extensions are preserved untouched; and (e) how the CIM relates to the [Chapter 13](../chapters/13-infrastructure-model.md) infrastructure model. Ambiguity here blocks Phase 2 (SDK) and every dependent phase.

## Goals

- Define the CIM's logical schema (resources, edges, policies, outputs, extensions, provenance, diagnostics).
- Guarantee a loss-free round trip: CIM → canonical serialization → parse → identical CIM.
- Tie the CIM's stable hash to canonical form steps C1–C6.
- Make provenance total: every effective field value has exactly one provenance record.
- Position the CIM as *desired intent*, distinct from the Chapter 13 *deployed state* model.

## Non-goals

- Defining a new document format or altering `iap-v1.schema.json`.
- Defining mutation operations (IEP-0009) or planning inputs (IEP-0011).
- Prescribing a programming language; TypeScript sketches are illustrative of the reference SDK only.

## Terminology

- **CIM** — Canonical Infrastructure Model, the in-memory normalized representation.
- **Materialized default** — a value absent from the authored document but present in the CIM because the specification, a profile, or a policy supplies it.
- **Provenance record** — metadata explaining why a field has its effective value.
- **Infrastructure model** — the engine-side record of deployed state per [Chapter 13](../chapters/13-infrastructure-model.md); *not* the CIM.

## Detailed design

The CIM is produced by a pure function `(source document, active profile) → CIM` that applies C1 (parse), C2 (profile merge), C3 (relationship flattening), and C4 (value normalization: default materialization per Chapter 1 §1.5.1, quantity/duration normalization per §1.5.2), recording provenance at each step.

**Resolved canonicalization decisions (2026-07-10, milestone M1.1).** The two determinism gaps identified in `docs/reports/v1-gap-analysis.md` §2 are now resolved normatively in [Chapter 1 §1.5.1–§1.5.2](../chapters/01-architecture.md): (a) quantities are exact rationals with a total canonical-spelling function (binary suffixes preferred largest-first, then decimal, then bare; sub-integer values in `m`; finer-than-milli precision is IAP103); (b) defaults materialize recursively with three carve-outs — arrays never, presence-semantic constructs (`healthCheck`, `deadLetter`, annotated `x-iap-presence-semantic`) never, and conditional defaults only while their condition holds. Kind-specific `resilience.backup` defaults become machine-readable in the schema (milestone M1.2). C5/C6 (key ordering, serialization) define the CIM's byte projection, used for hashing and diffing.

```typescript
interface CanonicalModel {
  readonly specVersion: string;                 // IaP spec semver in force
  readonly apiVersion: "iap.dev/v1";
  readonly metadata: DocumentMetadata;
  readonly activeProfile: string | null;        // profiles key removed post-merge (C2)
  readonly resources: ReadonlyMap<ResourceId, CanonicalResource>;
  readonly edges: readonly CanonicalEdge[];     // C3 output, sorted (source, type, target, attrs)
  readonly policies: readonly CanonicalPolicy[];
  readonly outputs: readonly CanonicalOutput[];
  readonly extensions: ExtensionBag;            // namespaced, preserved verbatim, never interpreted
  readonly derived: {
    readonly dependencyGraph: OrderingDag;      // Chapter 9 derivation
    readonly relationshipIndex: EdgeIndex;      // incoming/outgoing per resource
  };
  readonly provenance: ProvenanceIndex;         // canonical field path -> ProvenanceRecord
  readonly diagnostics: readonly Diagnostic[];  // non-semantic; never affects hash
  canonicalBytes(): Uint8Array;                 // C5+C6 projection
  hash(): string;                               // SHA-256 of canonicalBytes()
}

interface CanonicalResource {
  readonly id: ResourceId;
  readonly kind: KindName;                      // closed v1 kind set
  readonly labels: ReadonlyMap<string, string>;
  readonly spec: CanonicalSpec;                 // defaults materialized, quantities normalized
  readonly extensions: ExtensionBag;
  intentHash(): string;                         // per-resource hash, Chapter 13 §13.2 compatible
}

interface ProvenanceRecord {
  readonly source: "explicit" | "default" | "profile" | "policy";
  readonly originId: string;    // default identifier, profile name, or policy id
  readonly originVersion?: string;
  readonly sourceSpan?: SourceSpan;  // location in authored document, when source = explicit
  readonly explanation: string;      // roadmap §5.8: every default is explained
}
```

**Invariants (normative for the reference implementation):**

1. **I1 — Loss-free round trip.** `parse(canonicalBytes(m))` yields a CIM with byte-identical `canonicalBytes()`. Provenance and diagnostics are carried out-of-band (sidecar), never injected into the document.
2. **I2 — Hash identity.** `m.hash()` equals SHA-256 of the canonical form per §1.5; two CIMs are semantically identical iff hashes match.
3. **I3 — Extension preservation.** Extension blocks pass through byte-preserving (post C4 value normalization and C5 key ordering only); deleting all extensions yields a valid CIM with identical core semantics ([Chapter 11](../chapters/11-extension-framework.md)).
4. **I4 — Provenance totality.** Every effective field has exactly one provenance record; no hidden defaults (roadmap §5.8).
5. **I5 — Intent only.** The CIM contains no provider identifiers, no observed state, no secrets, and no history; those belong to the Chapter 13 model.
6. **I6 — Immutability.** A CIM instance is immutable; changes are expressed as compiler operations (IEP-0009) producing a new CIM.
7. **I7 — Input-order independence.** CIMs built from documents differing only in key order or relationship spelling (inline vs. rule edge) are identical.

**Relationship to Chapter 13.** The CIM answers *what should exist*; the infrastructure model answers *what the engine believes exists*. The planner ([Chapter 14](../chapters/14-planning-model.md)) diffs `CanonicalResource.intentHash()` against the model's `intentHash` field; the two representations meet only inside the planner and never merge.

## Schema impact

None to `iap-v1.schema.json`. A non-normative companion schema for a serialized CIM snapshot (debugging/interchange) MAY be published under `spec/schema/` as `cim-v1.schema.json`.

## Runtime-model impact

This IEP *defines* the runtime model. All Phase 2+ packages (`packages/model`, `parser`, `serializer`, `validator`, `relationships`, `dependency-engine`) build on it.

## Validation impact

Validators operate on the CIM; findings become `Diagnostic` entries satisfying CV-3 ([Chapter 24](../chapters/24-conformance.md)). Diagnostics never influence `canonicalBytes()` or hashing.

## Provider impact

Mappings consume the CIM's canonical projection, never authored YAML. Provider packages receive read-only access; they cannot mutate the CIM (mirrors CM-6 non-interference). Example: an `aws` mapping reads `spec.availability` through the CIM accessor and its provenance shows `profile:production@2.1.0`, making `multiAZ: true` traceable end-to-end.

## Security impact

The CIM stores no secret material (CD-6). Provenance may reference internal profile/policy names; CIM snapshots exported for debugging SHOULD be treated with the same sensitivity as the document plus organization policy metadata.

## Cost impact

None at runtime beyond memory for provenance indexes. The cost engine gains reproducibility: estimates key off `hash()`.

## Compatibility

Purely additive; no document changes. The CIM tracks the spec's minor versions; unknown-but-valid newer-minor constructs are preserved and flagged IAP804.

## Migration

None — no persisted artifacts change. Implementations replace ad-hoc parse trees with the CIM package.

## Alternatives considered

1. Operate all engines directly on canonical JSON bytes — rejected: re-derivation per engine, no provenance carrier.
2. Make the CIM a persisted second document format — rejected: creates a second source of truth (prohibited, roadmap §14).
3. Store provenance inline as `x-` keys in the document — considered; kept out-of-band to avoid polluting diffs and hashes.

## Rejected alternatives

Alternative 2 above is categorically rejected: the IaP document is the only portable desired-state artifact.

## Implementation plan

1. `packages/model`: types, provenance index, hash projection (Phase 2 milestone 1).
2. `packages/parser` + `serializer`: C1–C6 pipeline with source spans.
3. Round-trip, hash-stability, and key-order-independence test suites in `tests/determinism/`.
4. Retrofit validator and relationship/dependency engines to the CIM API.

## Conformance requirements

- CIM-1: round-trip byte identity for every document in `conformance/cases/valid/`.
- CIM-2: identical hashes for input-order permutations of the same document.
- CIM-3: extension-deletion yields identical core `canonicalBytes()` modulo extension keys.
- CIM-4: provenance totality check — zero fields without a record after materialization.

## Open questions

1. Sidecar serialization format for provenance (JSON Lines vs. embedded snapshot)?
2. Should `policy`-sourced provenance pin a policy bundle hash in addition to the policy id?
3. Multi-document workspaces: one CIM per document, or a workspace-level composite index?

## Decision

Pending review.

## References

- [Chapter 1 — Architecture (§1.3–§1.5)](../chapters/01-architecture.md)
- [Chapter 11 — Extension Framework](../chapters/11-extension-framework.md)
- [Chapter 13 — Infrastructure Model](../chapters/13-infrastructure-model.md)
- [Chapter 24 — Conformance](../chapters/24-conformance.md)
- Roadmap §4.2, §5.8, Phase 2
