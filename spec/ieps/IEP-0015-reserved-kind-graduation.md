# IEP-0015: Specification 1.1.0 — Reserved-Kind Graduation and Database Class Extension

| Field              | Value                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| **Number**         | IEP-0015                                                                                   |
| **Status**         | Accepted (M23.1 — released 2026-07-18 under the standing autonomous-completion directive; open questions resolved to the drafted defaults, revisitable) |
| **Authors**        | IaP maintainer (drafted in milestone M23.1)                                                |
| **Created date**   | 2026-07-17                                                                                 |
| **Target version** | 1.1.0                                                                                      |

> **ACCEPTED — RELEASED 1.1.0 (2026-07-18).** Approved under the user's standing
> autonomous-roadmap-completion directive (the M23.1 human release gate was
> pre-authorized). The five open questions were resolved to the drafted
> defaults (see Decision) and are explicitly revisitable by the maintainer.

## Summary

Specification minor **1.1.0** graduates five reserved kinds — `Certificate`,
`DnsZone`, `Registry`, `Dashboard`, `Alert` — from the Chapter 5 capability
registry to fully specified kinds with complete `spec` contracts, per the
promotion process of Chapter 5 §5.6. It also extends `Database.spec.class`
with two new values, `wide-column` and `warehouse`. All changes are strictly
additive per Chapter 10 §10.2.1: every valid 1.0.0 document remains valid with
unchanged semantics. From 1.1.0 onward the reserved-kind warning **IAP801**
no longer applies to the five graduated kinds and continues to apply to the
four kinds that remain reserved (`Network`, `Stream`, `Workflow`,
`SearchIndex`).

## Motivation

The 1.0.0 registry reserved nine kind names so the `kind` enum could be closed
for the v1 major while deferring their field contracts (Chapter 5 §5.3).
Five of them are now exercised in practice and blocked on a frozen contract:

- `Certificate` is already referenced structurally by
  `Gateway.spec.tls.certificate` and enforced referentially (IAP204), yet has
  no field contract of its own.
- `Dashboard` and `Alert` are the only legal `monitoredBy` targets
  (Chapter 4 §4.3.1), so every document that wires observability consumption
  today does it against a loosely validated spec.
- `Registry` and `DnsZone` are prerequisites for the provider work planned in
  the next milestone (M23.2 adds provider handlers for exactly these five
  kinds); handlers cannot be written against an open object.

`Database.class` gained field reality the same way: wide-column and analytic
warehouse data models are common intent that 1.0.0 could only mis-declare as
`key-value` or `relational`.

## Problem statement

1.0.0 cannot express, for the five kinds above, any field-level intent: their
`spec` is an open object (`$defs/kinds/ReservedKind`), validation is loose,
policies over their fields are unreliable (Chapter 5 §5.3 rule 3), mappings
cannot bind abstract outputs to a defined surface, and every use warns IAP801.
`Database.spec.class` (Chapter 3 §3.9) enumerates `relational`, `document`,
`key-value`, `graph`, `timeseries`, `vector` and cannot state wide-column or
warehouse intent.

## Goals

- Graduate `Certificate`, `DnsZone`, `Registry`, `Dashboard`, `Alert` with
  complete, minimal, provider-neutral `spec` contracts satisfying all five
  promotion requirements of Chapter 5 §5.6.
- Extend `Database.spec.class` with `wide-column` and `warehouse`, including
  honest engine-consistency (IAP104) semantics.
- Keep the change set strictly additive: every known-valid 1.0.0 document
  (official examples, conformance corpus, embedded fixtures) validates
  unchanged with identical canonicalization.
- Retire IAP801 for the graduated kinds; keep it for the remaining four.

## Non-goals

- **No graduation** of `Network`, `Stream`, `Workflow`, `SearchIndex` — they
  remain reserved with unchanged IAP801 behavior.
- **No new relationship verbs** (closed for the v1 major) and no changes to
  the verb/target-kind tables of Chapter 4 §4.3.1 — the graduated kinds
  already appear there where relevant (`monitoredBy` → `Dashboard`/`Alert`)
  and otherwise participate through the open verbs (`dependsOn`,
  `connectsTo`, `protectedBy`, `monitoredBy`).
- **No provider mappings or handlers** — mapping coverage for the graduated
  kinds is M23.2 (provider-sdk / provider territory), not part of the spec
  minor.
- **No new engine enum values** for `Database.spec.engine`; see the honest
  engine analysis below.
- **No intent-compiler changes** — the extraction deferral rules that treat
  DNS/etc. as reserved-kind territory are implementation follow-up, not spec.
- **No changes to the error-code registry** — IAP801's entry (code, phase 8,
  warning) is unchanged; only the set of kinds it applies to shrinks.

## Terminology

- **Graduation / promotion** — the Chapter 5 §5.6 process by which a reserved
  kind becomes fully specified in a minor release.
- **Remaining reserved kinds** — after 1.1.0: `Network`, `Stream`,
  `Workflow`, `SearchIndex`.

## Detailed design

### D1. `Certificate` (capability family: *security*)

TLS certificate material and issuance intent. Referenced by
`Gateway.spec.tls.certificate` (already enforced by IAP204). `spec` is
**required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `domains` | array of hostname (§3.2 grammar; `*.` wildcard prefix permitted) | Yes (min 1, unique) | — | DNS names the certificate covers. |
| `issuance` | enum `managed` \| `imported` | No | `managed` | `managed`: the platform obtains and renews the certificate. `imported`: material is supplied out-of-band (e.g. via a `Secret`); the platform never generates keys. |
| `keyAlgorithm` | enum `rsa-2048` \| `rsa-4096` \| `ecdsa-p256` \| `ecdsa-p384` | No | `ecdsa-p256` | Key algorithm intent; values are algorithm names, never provider products. |

- **Outputs:** `identifier`.
- **Relationships:** target of `protectedBy` (from `Gateway`, `Service`,
  `Database`, …) and referenced by `Gateway.spec.tls.certificate`; MAY be the
  source of `dependsOn` → `DnsZone` (DNS-validated issuance) and
  `monitoredBy` (expiry monitoring).
- **Lifecycle:** `domains` changes are replacement-eligible (a certificate is
  immutable material); `issuance`/`keyAlgorithm` changes are
  replacement-eligible; replacement is non-destructive (stateless kind).

### D2. `DnsZone` (capability family: *network*)

Authoritative DNS zone intent. `spec` is **required**. Record-level intent is
deliberately out of scope for 1.1.0 (records derive from provider bindings of
`endpoint` outputs; a record grammar can be added additively in a later
minor).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `zoneName` | string, pattern `^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$` | Yes | — | Fully qualified apex name of the zone (no wildcard, no trailing dot). |
| `visibility` | enum `public` \| `internal` | No | `public` | `public`: resolvable from the internet. `internal`: resolvable only inside the organization's network (split-horizon). Named `visibility`, not `exposure`, because it scopes name resolution, not network reachability of a workload. |
| `dnssec` | enum `required` \| `preferred` \| `none` | No | `none` | DNSSEC signing intent. `required`: the mapping MUST sign the zone or fail closed; `preferred`: sign where the substrate supports it; `none`: unsigned. |

- **Outputs:** `identifier`, `endpoint` (the authoritative name-server set,
  provider-neutrally).
- **Relationships:** target of `dependsOn` (from `Certificate` for
  DNS-validated issuance, from `Gateway` for hosted-domain intent); MAY
  declare `monitoredBy`.
- **Lifecycle:** `zoneName` change is replacement-eligible and MUST be
  treated as delegation-affecting; `visibility` and `dnssec` are in-place.

### D3. `Registry` (capability family: *storage*)

Artifact and container-image registry intent. `spec` is **optional** (all
fields defaulted or optional).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `format` | enum `container-image` \| `archive` | No | `container-image` | Artifact format stored; values align with the §3.2.9 `artifact.type` grammar (minus `source`, which is a code-hosting concern). |
| `immutability` | enum `enabled` \| `disabled` | No | `disabled` | `enabled`: a stored artifact version/tag can never be overwritten. |
| `exposure` | enum `private` \| `internal` | No | `private` | Registries are never `public` in 1.1.0 (a public value can be added additively later). |
| `encryption` | object (§3.2.4) | No | both `required` | At-rest / in-transit posture. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

- **Outputs:** `identifier`, `endpoint`, `connectionSecret` (pull/push
  credentials — never literal values).
- **Relationships:** target of `connectsTo` from workloads (with `access:
  read` for pull, `write`/`read-write` for push — least privilege derives
  from the edge, exactly as for `Database`); MAY declare `protectedBy` and
  `monitoredBy`.
- **Lifecycle:** all fields in-place except `format` (replacement-eligible).

### D4. `Dashboard` (capability family: *observability*)

Curated observability dashboard over the telemetry delivered by
`monitoredBy` edges. `spec` is **optional**. **No field carries a `default`**
— deliberate: 1.0.0 documents already use this kind (it was reserved), and a
zero-default contract keeps their canonicalization byte-identical
(see Compatibility).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `audience` | string (max 256) | No | — | Intended audience, free-form (e.g. `platform-operations`). |
| `signals` | array of enum `logs` \| `metrics` \| `traces` (unique) | No | — | Signal classes visualized. Omitted: every signal delivered by incident `monitoredBy` edges. |

- **Outputs:** `identifier`, `endpoint` (where the dashboard is served).
- **Relationships:** target of `monitoredBy` (unchanged Chapter 4 rule); MAY
  declare `dependsOn`.
- **Lifecycle:** all fields in-place; never replacement-eligible.

### D5. `Alert` (capability family: *observability*)

Notification rule and routing intent evaluated over the telemetry delivered
by `monitoredBy` edges. `spec` is **optional**; **no field carries a
`default`** (same canonicalization-stability rationale as `Dashboard`).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `severity` | enum `info` \| `low` \| `medium` \| `high` \| `critical` | No | — | Severity classification of the notifications this alert emits. |
| `severityFloor` | enum `info` \| `low` \| `medium` \| `high` \| `critical` | No | — | Minimum severity of evaluated conditions that triggers notification. Omitted: notify at every severity. |
| `signals` | array of enum `logs` \| `metrics` \| `traces` (unique) | No | — | Signal classes evaluated. Omitted: every signal delivered by incident `monitoredBy` edges. |
| `channels` | array of enum `email` \| `chat` \| `webhook` \| `pager` \| `sms` (unique) | No | — | Provider-neutral notification channel classes; concrete destinations are mapping/extension territory. |

- **Outputs:** `identifier`.
- **Relationships:** target of `monitoredBy` (unchanged Chapter 4 rule); MAY
  declare `dependsOn`.
- **Lifecycle:** all fields in-place; never replacement-eligible.

Both `severity` and `severityFloor` exist because both shapes are in real
1.0.0 use (the conformance corpus uses `severity`; the official
`enterprise-pci` example uses `severityFloor`) and they answer different
questions (classification of what is emitted vs. threshold of what is
evaluated). See Open questions.

### D6. `Database.class` extension

`Database.spec.class` gains two values (both `x-iap-since: 1.1.0`):

- **`wide-column`** — wide-column / column-family data model.
- **`warehouse`** — analytic data warehouse model (columnar, scan-oriented).

**Engine consistency (IAP104), stated honestly:**

| Engine | Consistent classes after 1.1.0 | Change |
|---|---|---|
| `postgresql` | `relational` | unchanged |
| `mysql` | `relational` | unchanged |
| `mariadb` | `relational` | unchanged |
| `mongodb-compatible` | `document` | unchanged |
| `cassandra-compatible` | `key-value`, `document`, **`wide-column`** | relaxed (additive: accepts more) |

- `cassandra-compatible` is the canonical wide-column dialect; pairing it
  with `wide-column` is the honest primary pairing. Its pre-existing
  `key-value`/`document` pairings are retained verbatim (a minor may not
  invalidate `class: key-value` + `engine: cassandra-compatible` documents).
- **`warehouse` pairs with no engine value in 1.1.0.** There is no
  non-proprietary warehouse wire dialect in the 1.0.0 engine enum, and this
  IEP adds none. A `Database` with `class: warehouse` therefore omits
  `engine`; any declared engine remains an IAP104 error under the unchanged
  per-engine rules. (Whether `postgresql` should pair with `warehouse` —
  PostgreSQL-dialect warehouses exist — is left as an open question rather
  than silently widened.)

## Schema impact

All in `spec/schema/iap-v1.schema.json` (and its byte-identical embedded
copies, refreshed by `tools/schema-generation/sync-schemas.mjs`):

1. Top-level `description`: specification version becomes `1.1.0`.
2. `$defs/kinds` gains five full definitions — `Certificate`, `DnsZone`,
   `Registry`, `Dashboard`, `Alert` — each carrying `"x-iap-since": "1.1.0"`
   and the family in its description (`x-iap-capability: …`), inserted
   between `Secret` and `ReservedKind`. All five use the standard envelope
   (`patternProperties ^x-`, `additionalProperties: false`).
3. `$defs/resource.allOf` gains five kind-dispatch branches. `Certificate`
   and `DnsZone` require `spec` (they have required fields); `Registry`,
   `Dashboard`, `Alert` do not.
4. `$defs/kinds/Database.properties.class.enum` appends `wide-column` and
   `warehouse`; a `description` documents that these two values are since
   1.1.0 (JSON Schema cannot annotate individual enum values).
5. `$defs/kinds/ReservedKind.description` now names the four remaining
   reserved kinds, and the reserved-kind fallback dispatch branch in
   `$defs/resource.allOf` narrows its `kind` enum from nine to the four
   remaining reserved names (the five graduated names now dispatch to their
   own branches).
6. `$defs/kindName` is **unchanged** — the kind name set and its order are
   identical; graduation moves kinds between specification tiers, not enums.

## Runtime-model impact

`@iap/model`:

- A new tier `GRADUATED_KINDS` (`Certificate`, `DnsZone`, `Registry`,
  `Dashboard`, `Alert`) with `isGraduatedKind`/`isSpecifiedKind` guards;
  `RESERVED_KINDS` shrinks to the remaining four; `KINDS` keeps the exact
  normative `kindName` enum order (now pinned literally, since specified and
  reserved names interleave in that order). `CORE_KINDS` deliberately stays
  the 1.0.0 thirteen: downstream registries keyed on it (the provider-sdk
  abstract-output table, the planner's kind reconstruction) cover exactly
  those kinds until provider support for the graduated kinds lands in M23.2,
  at which point extending those tables is the M23.2 change.
- Canonicalization resolves every *specified* kind (core or graduated) to its
  own `$defs/kinds/<Kind>` subschema; only reserved kinds fall back to
  `ReservedKind`. Because `Dashboard` and `Alert` declare no defaults,
  canonicalization of existing documents using them is byte-identical to
  1.0.0. `Certificate`, `DnsZone`, `Registry` declare defaults, but no 1.0.0
  corpus document uses those kinds.
- No CIM structural changes.

## Validation impact

- **IAP801 scope change** (Chapter 8, Chapter 10 §10.3): the warning now
  fires only for `Network`, `Stream`, `Workflow`, `SearchIndex`. Per
  Chapter 5 §5.6 requirement 5, validators pinned to 1.0.x continue to warn
  for the graduated kinds; a 1.1.0 validator MUST NOT.
- **Reference implementation:** `@iap/validator` now actually emits IAP801
  (previously specified but unimplemented — Chapter 24 CV-4 makes silent
  acceptance a conformance failure). It is emitted with the phase-1 semantic
  checks (warnings never gate; the full phase-8 engine remains future work).
- **IAP104**: the Database engine/class table relaxes exactly one row
  (`cassandra-compatible` additionally accepts `wide-column`).
- No new error codes; no changes to `spec/conformance/error-codes.yaml`.

## Provider impact

Mappings MAY now declare fail-closed coverage for the graduated kinds against
a frozen contract, and MUST bind the declared abstract outputs
(`Certificate`: identifier; `DnsZone`: identifier, endpoint; `Registry`:
identifier, endpoint, connectionSecret; `Dashboard`: identifier, endpoint;
`Alert`: identifier). Nothing forces existing mappings to add coverage — the
Chapter 12 fail-closed rule is unchanged. Reference-provider handlers for
these kinds are milestone M23.2, out of scope here.

## Security impact

- `Certificate` makes TLS material intent declarative and policy-addressable
  (`issuance: imported` is now a policy-visible fact).
- `Registry.encryption` defaults to `required`/`required`, consistent with
  the "omission never weakens posture" rule (§3.2.4).
- `DnsZone.dnssec` defaults to `none` — honest status quo rather than a
  posture claim; hardening is an explicit, policy-visible act (see Open
  questions).
- Security-view derivation (Chapter 18) already includes `Certificate` nodes.

## Cost impact

None normative. The reference cost model already treats `Certificate` and
`DnsZone` as no-direct-charge logical kinds; `Registry` costing follows
storage-family heuristics. No cost-schema changes.

## Compatibility

**Strictly additive; minor-eligible.**

- The `kind` enum is unchanged; documents, selectors, and policies see the
  same vocabulary.
- Every 1.0.0 document that used the five kinds while reserved and that
  appears in the normative/informative corpus (conformance `valid/02`
  — `Alert.severity: high`; `enterprise-pci` — `Alert.severityFloor: high`;
  `kubernetes-platform` — `Dashboard.audience`; embedded package fixtures)
  validates unchanged under the promoted contracts, with byte-identical
  canonicalization (`Dashboard`/`Alert` deliberately declare no defaults).
- Chapter 5 §5.6 acknowledges that *arbitrary* pre-promotion loose specs are
  only guaranteed valid post-promotion if they conform to the promoted
  contract; that is inherent to promotion, not specific to this IEP. The
  promoted contracts were shaped so the entire known corpus conforms.
- Older validator (1.0.x) + newer document: unknown constructs surface as
  IAP804 warnings per §10.6; reserved-kind uses keep warning IAP801 there.
- Newer validator + older document: always valid (§10.6).
- Enum extension (`Database.class`) and IAP104 relaxation only ever accept
  strictly more documents.

## Migration

None required (additive). No `iap migrate` transform is needed: no known
corpus document requires rewriting.

## Alternatives considered

- **Graduating all nine reserved kinds.** Rejected for scope: `Network`
  (segmentation topology), `Stream` (offset semantics), `Workflow` (step
  grammar), `SearchIndex` (index/query contract) each need design work with
  no consuming milestone yet; shipping them thin would freeze bad contracts.
- **A `records` grammar on `DnsZone`.** Deferred; additive later, and
  record-level intent overlaps with output binding design.
- **Reusing `exposure` on `DnsZone`.** Rejected: `exposure` normatively means
  network reachability of the resource; zone visibility scopes name
  resolution. Overloading it would change the meaning of an existing field
  (forbidden in a minor).
- **Defaults on `Alert`/`Dashboard` fields** (e.g. `severityFloor: low`).
  Rejected: canonicalization materializes defaults, which would change the
  canonical form (and plan digests) of existing 1.0.0 documents — a semantic
  change a minor may not make.
- **Adding a warehouse engine value** (e.g. a `postgresql`-warehouse
  pairing). Deferred to the release gate as an open question instead of
  silently widening IAP104.

## Rejected alternatives

- **Per-kind version markers** for graduated kinds — Chapter 10 §10.1 forbids
  new version indicators.
- **Keeping IAP801 as a permanent "young kind" advisory** for graduated
  kinds — contradicts Chapter 5 §5.6 requirement 5 (warning retirement).
- **Making `Alert.spec`/`Dashboard.spec` required** — would invalidate
  existing corpus documents (e.g. an `Alert` with no `spec`).
- **A single merged severity field** — would invalidate one of the two
  existing severity spellings in the corpus.

## Implementation plan

All steps in this repository, milestone M23.1 (spec + reference validator);
provider handlers follow in M23.2.

1. Schema: `spec/schema/iap-v1.schema.json` changes above; run
   `tools/schema-generation/sync-schemas.mjs` so embedded copies stay
   byte-identical.
2. Chapters: Chapter 3 (five new kind sections §3.17–§3.21; Reserved Kinds
   becomes §3.22 with four entries; §3.3 outputs table; §3.9 class/engine
   rows), Chapter 5 (§5.2 gains five rows; §5.3 registry shrinks to four;
   §5.4 reserved-observability note updated), Chapter 8 (IAP801 kind list and
   §8.10 example), Chapter 10 (§10.3 reserved list and graduation record).
3. Conformance: new cases `valid/04-graduated-kinds`,
   `invalid/23-certificate-missing-domains` (schema-invalid),
   `invalid/24-warehouse-engine-mismatch` (IAP104); README case table
   updated; `valid/02` header note updated (Alert no longer warns).
4. Reference implementation: `@iap/model` kind tiers; `@iap/validator`
   IAP801 emission + IAP104 table row; package tests both directions.
5. Release gate (human): accept this IEP, stamp chapter headers/CHANGELOG,
   tag 1.1.0.

## Conformance requirements

- `valid/04-graduated-kinds.iap.yaml` — all five graduated kinds with full
  specs and their characteristic relationships; MUST pass with **no IAP801**
  finding for any graduated kind.
- `invalid/23-certificate-missing-domains.iap.yaml` — `Certificate` without
  `domains`; schema-invalid (promoted contract enforced).
- `invalid/24-warehouse-engine-mismatch.iap.yaml` — `class: warehouse` with
  `engine: postgresql`; IAP104.
- Existing `valid/02-relationships.iap.yaml` MUST continue to pass; the
  IAP801 expectation for its `Alert` resource is retired.
- CV-4 (Chapter 24): a conforming validator MUST emit IAP801 for the four
  remaining reserved kinds and MUST NOT emit it for graduated kinds.

## Open questions

1. Should `postgresql` become IAP104-consistent with `class: warehouse`
   (PostgreSQL-dialect warehouses are common), or should a dedicated neutral
   dialect value wait for evidence? (Current draft: no pairing.)
2. `DnsZone.dnssec` default: `none` (status quo, this draft) vs `preferred`
   (posture-forward). Release gate to confirm.
3. Is `Alert.channels`' channel-class enum (`email`, `chat`, `webhook`,
   `pager`, `sms`) the right neutral granularity, or should routing stay
   entirely in extensions until operational evidence exists?
4. Should `severity`/`severityFloor` be collapsed at the v2 major (they must
   coexist through v1 for compatibility)?

## Decision

**Accepted 2026-07-18** and released as specification minor 1.1.0, under the
user's standing autonomous-roadmap-completion directive (the M23.1 human
release gate was pre-authorized). The additive schema/chapter/validator edits
already merged (workspace suite green, 1.0.0 corpus still validates) are
promoted from proposed to released.

Open questions resolved to the drafted defaults (each **revisitable** by the
maintainer; none blocks the release since all are conservative/additive):

1. **`postgresql` × `class: warehouse`** → NO pairing in 1.1.0 (stays IAP104).
   A dedicated neutral warehouse dialect waits for real evidence.
2. **`DnsZone.dnssec` default** → `none` (honest status quo, not posture-forward).
3. **`Alert.channels` enum** → keep the neutral channel-class enum
   (`email`|`chat`|`webhook`|`pager`|`sms`) as drafted.
4. **`severity`/`severityFloor`** → both retained through v1 for corpus
   compatibility; a collapse is a v2-major candidate only.
5. **Chapter version stamping** → chapters 3/5/8/10 + conformance README carry
   "Version 1.1.0" (draft-pending markers removed at this acceptance).

These are recorded as revisitable in [[autonomous-roadmap-completion]]; a
maintainer may reopen any of them in a future minor without breaking 1.1.0.

## References

- Chapter 3 §3.17 (1.0.0) — reserved kinds; Chapter 5 §5.3/§5.6 — registry
  and promotion process; Chapter 8 — IAP801; Chapter 10 §10.2/§10.3 —
  additive minors, `x-iap-since`, warning retirement; Chapter 24 CV-4.
- IEP-0001 (resource model), IEP-0012 (provider conformance — M23.2 handler
  context), ADR-0002 (JSON Schema as normative contract).
- ROADMAP-V4 Phase 23, milestone M23.1.
