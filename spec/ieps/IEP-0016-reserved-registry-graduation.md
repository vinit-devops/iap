# IEP-0016: Specification 1.2.0 — Reserved-Registry Graduation (Network, Stream, Workflow, SearchIndex)

| Field              | Value                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| **Number**         | IEP-0016                                                                                   |
| **Status**         | Accepted (M23.3 — released 2026-07-18 under the standing autonomous-completion directive; open questions resolved to the drafted defaults, revisitable) |
| **Authors**        | IaP maintainer (drafted in milestone M23.3)                                                |
| **Created date**   | 2026-07-18                                                                                 |
| **Target version** | 1.2.0                                                                                      |

> **ACCEPTED — RELEASED 1.2.0 (2026-07-18).** Approved under the user's standing
> autonomous-roadmap-completion directive (the M23.3 human release gate was
> pre-authorized). The open questions were resolved to the drafted defaults
> (see Decision) and are explicitly revisitable by the maintainer.

## Summary

Specification minor **1.2.0** graduates the four remaining reserved kinds —
`Network`, `Stream`, `Workflow`, `SearchIndex` — from the Chapter 5 capability
registry to fully specified kinds with complete `spec` contracts, per the
promotion process of Chapter 5 §5.6. After 1.2.0 **all nine kinds reserved in
1.0.0 are graduated** (five in 1.1.0 via [IEP-0015](IEP-0015-reserved-kind-graduation.md),
four here) and **the reserved registry is empty**. All changes are strictly
additive per Chapter 10 §10.2.1: every valid 1.0.0 document *and* every valid
1.1.0 document remains valid with unchanged semantics. From 1.2.0 onward the
reserved-kind warning **IAP801** applies to no kind — a conforming validator
emits it for nothing — but the mechanism (the `ReservedKind` subschema, the
`RESERVED_KINDS` set, the validator's IAP801 emission) is retained so a future
minor MAY reserve new kind names.

## Motivation

The 1.0.0 registry reserved nine kind names so the `kind` enum could be closed
for the v1 major while deferring their field contracts (Chapter 5 §5.3).
IEP-0015 graduated five of them. The remaining four are now blocked on a frozen
contract for the same reasons:

- `Stream` is already a legal `consumesFrom` target in the Chapter 4 §4.3.1
  verb/target-kind table, and the official `data-processing` example declares a
  `Stream` today — validated loosely, warning IAP801 — so every clickstream
  intent in the corpus rides on an unspecified body.
- `Network`, `Workflow`, `SearchIndex` are prerequisites for provider handler
  work: handlers cannot be written against an open object. Forward context for
  the eventual reference handlers is VPC/subnets (`Network`), Step Functions
  (`Workflow`), Kinesis/Firehose (`Stream`), and OpenSearch (`SearchIndex`) —
  but the contracts here are provider-neutral (no provider products in enum
  values).

Graduating the last four also lets the specification make a clean statement:
the reserved registry is empty, every `kind` value is fully specified, and the
promotion process has run to completion for the v1 major.

## Problem statement

1.0.0/1.1.0 cannot express, for the four kinds above, any field-level intent:
their `spec` is an open object (`$defs/kinds/ReservedKind`), validation is loose,
policies over their fields are unreliable (Chapter 5 §5.3 rule 3), mappings
cannot bind abstract outputs to a defined surface, and every use warns IAP801.

## Goals

- Graduate `Network`, `Stream`, `Workflow`, `SearchIndex` with complete,
  minimal, provider-neutral `spec` contracts satisfying all five promotion
  requirements of Chapter 5 §5.6.
- Keep the change set strictly additive: every known-valid 1.0.0 and 1.1.0
  document (official examples, conformance corpus, provider corpora, embedded
  fixtures) validates unchanged with identical canonicalization.
- Retire IAP801 for the four kinds — and, the registry now being empty, for all
  kinds — while retaining the reserved-kind mechanism for future use.

## Non-goals

- **No new relationship verbs** (closed for the v1 major) and no changes to the
  verb/target-kind tables of Chapter 4 §4.3.1. `Stream` is already a
  `consumesFrom` target; the other three participate through the open verbs
  (`dependsOn`, `connectsTo`, `protectedBy`, `monitoredBy`). In particular
  `publishesTo` stays scoped to `Topic`/`Queue` — producers write to a `Stream`
  via `connectsTo` with `access: write` — and `storesDataIn` stays scoped to
  `ObjectStore`/`Volume`/`Database` — a `SearchIndex` is reached via
  `connectsTo`.
- **No provider mappings or handlers** — reference handlers for these kinds are
  a later milestone (provider-sdk / provider territory), not part of the spec
  minor. The reference mock mapping continues to leave `Workflow` uncovered
  (fail-closed), keeping its uncovered-kind rejection surface honest.
- **No change to `CORE_KINDS`.** The graduated kinds join `GRADUATED_KINDS`, not
  `CORE_KINDS`: downstream tables keyed on `CORE_KINDS` (the provider-sdk
  abstract-output registry, the planner's kind reconstruction) cover exactly the
  1.0.0 thirteen until provider support lands — the M23.1 lesson, preserved.
- **No new error codes**, no changes to `spec/conformance/error-codes.yaml`;
  IAP801's registry entry (code, phase 8, warning) is unchanged, only the set of
  kinds it applies to (now empty) changes.

## Terminology

- **Graduation / promotion** — the Chapter 5 §5.6 process by which a reserved
  kind becomes fully specified in a minor release.
- **Empty reserved registry** — after 1.2.0, `RESERVED_KINDS` is empty; no
  `kind` value is reserved.

## Detailed design

No contract declares a **field-level default**. Two of the kinds —
`Stream` and `Workflow` — have reserved-era documents already in the corpus
(`data-processing`'s `Stream`, the mock provider corpus's `Workflow`), so their
canonicalization MUST be byte-identical after graduation. Two canonicalization
behaviours matter here (ch. 1 §1.5.1):

- **Common blocks with defaulted members materialize unconditionally.** A
  property that `$ref`s `common/encryption` or `common/observability` is
  materialized with its nested defaults **even when absent** (rule 2). Adding
  such a block to `Stream`/`Workflow` would therefore change the canonical form
  of the reserved-era corpus documents. So `Stream` and `Workflow` reference
  **no** `encryption`/`observability` block (an additive later minor MAY add
  one). `Network` and `SearchIndex` have no corpus users, so they reference the
  common blocks freely.
- **Unit re-spelling is `$ref`-driven.** Duration/quantity re-spelling fires
  only for fields whose resolved subschema `$ref`s `common/duration` or
  `common/quantity`. `Stream.retention` and `Workflow.timeout` are therefore
  typed **inline** with the duration grammar (not via the common `$ref`), so a
  reserved-era `retention: 24h` is preserved verbatim rather than re-spelled to
  `1d`.

This generalizes the `Dashboard`/`Alert` rationale of IEP-0015 (which referenced
no common blocks either) to the kinds that carry corpus history.

### D1. `Network` (capability family: *network*)

Explicit network segmentation and topology intent beyond what `exposure` and
the `connectsTo` graph derive. `spec` is **optional**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `scope` | enum `regional` \| `multi-region` | No | — | Geographic span of the address space. |
| `tiers` | array of enum `public` \| `private` \| `isolated` (unique, min 1) | No | — | Reachability tiers: `public` (internet-facing), `private` (internally routable with egress), `isolated` (no egress). |
| `addressSpace` | string, IPv4 CIDR grammar | No | — | Optional exact CIDR block intent (e.g. `10.0.0.0/16`); a neutral IP concept, never a provider product. Omitted: platform allocates a non-overlapping range. |
| `observability` | object (§3.2.5) | No | — | Flow-log / metrics intent. |

- **Outputs:** `identifier`.
- **Relationships:** target of `dependsOn` (from workloads placed within it); MAY declare `monitoredBy`.
- **Lifecycle:** `scope`/`addressSpace` replacement-eligible (topology-affecting); `tiers`/`observability` in-place.

### D2. `Stream` (capability family: *messaging*)

Ordered, replayable event stream with consumer-managed offsets, distinct from
`Topic` fan-out delivery. `spec` is **optional**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `retention` | string, duration grammar (inline, not the common `$ref`) | No | — | How long records remain available for replay; authored spelling preserved verbatim. |
| `ordering` | enum `none` \| `partition` | No | — | `none`: no cross-record ordering; `partition`: order preserved within a partition key. |
| `capacity` | object `{ throughput?: ^[0-9]+(rps\|mbps)$ }` | No | — | Sustained ingest capacity intent. |

- **Outputs:** `identifier`, `endpoint`.
- **Relationships:** target of `consumesFrom` (already in the §4.3.1 closed list) and of `connectsTo` (producers, `access: write`); MAY declare `monitoredBy`/`protectedBy`.
- **Lifecycle:** all fields in-place; never replacement-eligible.

### D3. `Workflow` (capability family: *compute*)

Multi-step orchestration of `Job` and `Function` executions with state
transitions. `spec` is **optional**. A declarative step grammar is deferred to a
later minor (additive).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `steps` | integer (min 1) | No | — | Declared number of orchestrated steps (advisory until a step grammar exists). |
| `execution` | enum `standard` \| `express` | No | — | `standard`: durable, long-running, full history; `express`: high-volume, short-lived, best-effort history. |
| `timeout` | string, duration grammar (inline, not the common `$ref`) | No | — | Maximum wall-clock time for a single execution; authored spelling preserved verbatim. |

- **Outputs:** `identifier`.
- **Relationships:** source of `dependsOn` → `Job`/`Function` (orchestrated executions); MAY be a `dependsOn` target and MAY declare `monitoredBy`.
- **Lifecycle:** all fields in-place; never replacement-eligible.

### D4. `SearchIndex` (capability family: *database*)

Full-text or vector search index over application data. `spec` is **required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `indexType` | enum `text` \| `vector` | Yes | — | `text`: full-text/relevance search; `vector`: similarity search over embeddings. |
| `exposure` | enum `private` \| `internal` | No | — | Reachability; a SearchIndex is never `public`. |
| `encryption` | object (§3.2.4) | No | — | At-rest / in-transit posture. |
| `capacity` | object `{ storage?: quantity }` | No | — | Index storage intent. |
| `observability` | object (§3.2.5) | No | — | Logs / metrics / traces intent. |

- **Outputs:** `identifier`, `endpoint`, `connectionSecret`.
- **Relationships:** target of `connectsTo` (queriers `access: read`, indexers `write`/`read-write`); MAY declare `protectedBy`/`monitoredBy`. Reached via `connectsTo`, not the closed `storesDataIn` list.
- **Lifecycle:** `indexType` replacement-eligible (immutable index model; data-loss-eligible, planners SHOULD surface); other fields in-place.

## Schema impact

All in `spec/schema/iap-v1.schema.json` (and its byte-identical embedded copies,
refreshed by `tools/schema-generation/sync-schemas.mjs`, plus the VS Code
language-server copy):

1. Top-level `description`: specification version becomes `1.2.0`.
2. `$defs/kinds` gains four full definitions — `Network`, `Stream`, `Workflow`,
   `SearchIndex` — each carrying `"x-iap-since": "1.2.0"` and its family in the
   description (`x-iap-capability: …`), inserted between `Alert` and
   `ReservedKind`. All four use the standard envelope (`patternProperties ^x-`,
   `additionalProperties: false`).
3. `$defs/resource.allOf` gains four kind-dispatch branches. `SearchIndex`
   requires `spec` (it has a required field); the other three do not.
4. The **reserved-kind fallback dispatch branch is removed** from
   `$defs/resource.allOf`. Every `kindName` value now has its own dispatch
   branch, so the fallback is unreachable. (It cannot be reduced to an empty
   `enum`: JSON Schema forbids an empty `enum` array, and the conformance
   harness compiles the schema in Ajv strict mode.) `$defs/kinds/ReservedKind`
   is retained as the reusable loose-spec template; a future reservation
   re-adds a dispatch branch referencing it.
5. `$defs/kinds/ReservedKind.description` records that the registry is empty as
   of 1.2.0 and why the definition is retained.
6. `$defs/kindName` is **unchanged** — the kind name set and order are identical;
   graduation moves kinds between specification tiers, not enums.

## Runtime-model impact

`@iap/model`:

- `GRADUATED_KINDS` gains `Network`, `Stream`, `Workflow`, `SearchIndex`
  (nine total). `RESERVED_KINDS` becomes empty (`type ReservedKind` is now
  `never`). `isSpecifiedKind` is true for all nine graduated kinds;
  `isReservedKind` is false for every kind. `KINDS` and its order are unchanged;
  `CORE_KINDS` stays the 1.0.0 thirteen.
- Canonicalization resolves every *specified* kind (core or graduated) to its
  own `$defs/kinds/<Kind>` subschema. Because the four 1.2.0 contracts declare
  no field defaults, canonicalization of every existing document using them is
  byte-identical to its reserved-era form (verified against the `Stream` in
  `data-processing` and the `Workflow` in the mock provider corpus).
- No CIM structural changes.

## Validation impact

- **IAP801 scope change** (Chapter 8, Chapter 10 §10.3): the warning now fires
  for **no kind**. The reference validator's emission is driven by
  `RESERVED_KINDS` (now empty), so it is retained but never fires. Per Chapter 5
  §5.6 requirement 5, validators pinned to an earlier minor continue to warn for
  the kinds still reserved there; a 1.2.0 validator MUST NOT.
- No IAP104 rule changes; no new error codes.

## Provider impact

Mappings MAY now declare fail-closed coverage for the graduated kinds against a
frozen contract, and MUST bind the declared abstract outputs (`Network`:
identifier; `Stream`: identifier, endpoint; `Workflow`: identifier;
`SearchIndex`: identifier, endpoint, connectionSecret). Nothing forces existing
mappings to add coverage — the Chapter 12 fail-closed rule is unchanged. The
reference mock mapping deliberately keeps `Workflow` uncovered.

## Security impact

- `SearchIndex.exposure` excludes `public`; `encryption` follows the
  "omission never weakens posture" rule (§3.2.4) when present.
- `Network.tiers` makes segmentation intent (including `isolated`, no-egress)
  declarative and policy-addressable.
- No security-view derivation changes are required by this IEP.

## Cost impact

None normative. The reference cost model already treats `Network` as a
no-direct-charge logical kind and prices `Stream` under messaging heuristics; no
cost-schema changes.

## Compatibility

**Strictly additive; minor-eligible.**

- The `kind` enum is unchanged; documents, selectors, and policies see the same
  vocabulary.
- Every pre-1.2.0 document that used these kinds while reserved and appears in
  the corpus validates unchanged under the promoted contracts, with
  byte-identical canonicalization:
  - `spec/examples/data-processing.iap.yaml` — `Stream` with `retention: 24h`
    (the `Stream` contract admits `retention` and declares no defaults);
  - `providers/mock/conformance/corpus/workflow-orchestrator.iap.yaml` —
    `Workflow` with `steps: 3` (the `Workflow` contract admits `steps` and
    declares no defaults).
- Chapter 5 §5.6 acknowledges that *arbitrary* pre-promotion loose specs are
  only guaranteed valid post-promotion if they conform to the promoted contract;
  that is inherent to promotion. The promoted contracts were shaped so the
  entire known corpus conforms.
- Older validator (1.0.x/1.1.x) + newer document: unknown constructs surface as
  IAP804 per §10.6; reserved-kind uses keep warning IAP801 *there*.
- Newer validator + older document: always valid (§10.6).

## Migration

None required (additive). No `iap migrate` transform is needed: no known corpus
document requires rewriting.

## Alternatives considered

- **Reducing the reserved-fallback dispatch to an empty `enum`.** Rejected —
  JSON Schema forbids an empty `enum` (Ajv strict raises "enum must have
  non-empty array"). The branch is removed instead; every `kindName` has its own
  branch, and `$defs/kinds/ReservedKind` is retained for future re-use.
- **Giving `Network`/`SearchIndex` field defaults** (they have no corpus users,
  so defaults would be safe there). Rejected for uniformity and an airtight
  compatibility story: making the whole 1.2.0 batch default-free means *no*
  pre-1.2.0 document's canonical form can shift, and it matches the
  `Dashboard`/`Alert` precedent.
- **Adding `Stream` to `publishesTo` / `SearchIndex` to `storesDataIn`.**
  Rejected: the verb/target-kind tables are closed for the v1 major (Chapter 4
  §4.3.1, Chapter 10 §10.2.1). Producers/queriers use the open `connectsTo`
  verb; `Stream` is already a `consumesFrom` target.
- **A declarative step grammar on `Workflow`.** Deferred; additive later. The
  advisory `steps` integer keeps the reserved-era mock corpus document valid.
- **Deleting the reserved-kind mechanism** now that the registry is empty.
  Rejected — a future minor may reserve new kinds; the mechanism (schema
  template, `RESERVED_KINDS`, IAP801 emission) is cheap to keep and expensive to
  reconstruct.

## Rejected alternatives

- **Per-kind version markers** for graduated kinds — Chapter 10 §10.1 forbids new
  version indicators.
- **Growing `CORE_KINDS`** — breaks provider-sdk/planner tables keyed on it (the
  M23.1 lesson). Graduated kinds go in `GRADUATED_KINDS`.
- **Making `Stream`/`Workflow`/`Network` `spec` required** — would invalidate
  existing corpus documents and needlessly tighten the contract. Only
  `SearchIndex` (no corpus users) requires `spec`.

## Implementation plan

All steps in this repository, milestone M23.3 (spec + reference validator);
provider handlers follow later.

1. Schema: `spec/schema/iap-v1.schema.json` changes above; run
   `tools/schema-generation/sync-schemas.mjs` and copy to the VS Code
   language-server schema so all embedded copies stay byte-identical.
2. Chapters: Chapter 3 (four new kind sections §3.22–§3.25; Reserved Kinds
   becomes §3.26 with the empty-registry note; §3.3 outputs table), Chapter 5
   (§5.2 gains four rows; §5.3 registry now empty; §5.6 graduation record),
   Chapter 8 (IAP801 bullet + finding-format example), Chapter 10 (§10.3
   graduation record). Version headers of the touched chapters + conformance
   README stamped `Version 1.2.0 (IEP-0016) · Status: Released`.
3. Conformance: new cases `valid/05-remaining-kinds-graduated`,
   `invalid/25-searchindex-missing-indextype` (schema-invalid),
   `invalid/26-network-bad-tier` (schema-invalid); README case table + layout +
   ajv-results updated.
4. Reference implementation: `@iap/model` kind tiers (`GRADUATED_KINDS` +4,
   `RESERVED_KINDS` empty); `@iap/validator` IAP801 doc note (mechanism retained,
   fires for nothing); package tests both directions; language-server and
   canonicalize reserved-kind fixtures updated.
5. Release gate (human, pre-authorized): accept this IEP, stamp headers, tag
   1.2.0.

## Conformance requirements

- `valid/05-remaining-kinds-graduated.iap.yaml` — all four graduated kinds with
  full specs and their characteristic relationships; MUST pass with **no IAP801**
  for any resource.
- `invalid/25-searchindex-missing-indextype.iap.yaml` — `SearchIndex` without
  `indexType`; schema-invalid (promoted contract enforced).
- `invalid/26-network-bad-tier.iap.yaml` — `Network.spec.tiers` with a value
  outside the closed enum; schema-invalid.
- Existing `valid/04-graduated-kinds.iap.yaml` and every 1.0.0/1.1.0 corpus
  document MUST continue to pass.
- CV-4 (Chapter 24): a conforming 1.2.0 validator MUST emit IAP801 for no kind
  (the registry is empty) and MUST NOT emit it for any graduated kind.

## Open questions

1. Should `Network.addressSpace` gain an IPv6 CIDR grammar, or stay IPv4-only
   until evidence? (Current draft: IPv4 CIDR only; additive later.)
2. Should `Workflow` gain a declarative step grammar (replacing the advisory
   `steps` integer) in a later minor? (Current draft: `steps` integer only.)
3. Should `Stream` participate in `publishesTo` at the v2 major (it cannot in v1
   — the verb set is closed)? (Current draft: producers use `connectsTo`.)
4. Should `SearchIndex` gain a `class`/`engine`-style pair (as `Database` has) in
   a later minor, or is `indexType` sufficient? (Current draft: `indexType`.)

## Decision

**Accepted 2026-07-18** and released as specification minor 1.2.0, under the
user's standing autonomous-roadmap-completion directive (the M23.3 human release
gate was pre-authorized). The additive schema/chapter/validator edits already
merged (workspace suite green; 1.0.0 and 1.1.0 corpora still validate) are
promoted from proposed to released.

Open questions resolved to the drafted defaults (each **revisitable** by the
maintainer; none blocks the release since all are conservative/additive):

1. **`Network.addressSpace`** → IPv4 CIDR grammar only in 1.2.0; IPv6 waits for
   evidence and is additive.
2. **`Workflow` step grammar** → not in 1.2.0; the advisory `steps` integer
   stands. A step grammar is a later additive minor.
3. **`Stream` × `publishesTo`** → NO in v1 (closed verb set). Producers write via
   `connectsTo`; a `publishesTo` widening is a v2-major candidate only.
4. **`SearchIndex` field surface** → `indexType` (required) plus the shared
   exposure/encryption/capacity/observability idioms; no `class`/`engine` pair in
   1.2.0.
5. **1.2.0 contracts declare no field defaults** → confirmed, to keep
   canonicalization byte-identical for the reserved-era `Stream`/`Workflow`
   corpus documents.
6. **Reserved-kind mechanism retained** → confirmed; the registry is empty but
   `ReservedKind`, `RESERVED_KINDS`, and IAP801 emission stay for future use.

These are recorded as revisitable in [[autonomous-roadmap-completion]]; a
maintainer may reopen any of them in a future minor without breaking 1.2.0.

## References

- Chapter 3 §3.22–§3.26 — the four graduated kinds and the (now empty) reserved
  registry; Chapter 5 §5.3/§5.6 — registry and promotion process; Chapter 8 —
  IAP801; Chapter 10 §10.2/§10.3 — additive minors, `x-iap-since`, warning
  retirement; Chapter 24 CV-4.
- IEP-0015 (the 1.1.0 graduation this completes), IEP-0001 (resource model),
  IEP-0012 (provider conformance), ADR-0002 (JSON Schema as normative contract).
- ROADMAP-V4 Phase 23, milestone M23.3.
