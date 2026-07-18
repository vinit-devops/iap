# IEP-0017: Specification 1.3.0 — New Kinds (Cdn, EventBus) and Enum Widenings

| Field              | Value                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| **Number**         | IEP-0017                                                                                   |
| **Status**         | Accepted (M24.1 — released 2026-07-18 under the standing autonomous-completion directive; open questions resolved to the drafted defaults, revisitable) |
| **Authors**        | IaP maintainer (drafted in milestone M24.1)                                                |
| **Created date**   | 2026-07-18                                                                                 |
| **Target version** | 1.3.0                                                                                      |

> **ACCEPTED — RELEASED 1.3.0 (2026-07-18).** Approved under the user's standing
> autonomous-roadmap-completion directive (the M24.1 human release gate was
> pre-authorized). The open questions were resolved to the drafted defaults
> (see Decision) and are explicitly revisitable by the maintainer.

## Summary

Specification minor **1.3.0** grows the kind vocabulary for the first time by a
path other than graduation: it introduces two brand-new fully specified kinds
**directly** — `Cdn` (content delivery / edge distribution, realized later by
CloudFront) and `EventBus` (event routing, realized later by EventBridge) — via
the new Chapter 5 §5.7 direct-introduction process. It also widens three
existing enums additively: `Identity.type` gains **user-directory** (later
Cognito user pools), `Service.runtime` gains **kubernetes** (later EKS), and a
new optional `Gateway.protocol` field offers **graphql** (later AppSync). An
`Email` kind (e.g. SES) was evaluated and **rejected** (see Decision). All
changes are strictly additive per Chapter 10 §10.2.1: every valid 1.0.0, 1.1.0,
and 1.2.0 document remains valid with unchanged semantics.

## Motivation

The reserved registry emptied in 1.2.0 ([IEP-0016](IEP-0016-reserved-registry-graduation.md)),
so any further vocabulary growth cannot come from graduation. Edge distribution
(`Cdn`) and event routing (`EventBus`) are common infrastructure intents with no
existing kind that models them honestly:

- A CDN in front of a `Service`/`Gateway`/`ObjectStore` is not any existing kind:
  `Gateway` terminates and routes origin traffic, but does not model edge caching
  or a distribution's origin set.
- An event router that fans events from heterogeneous sources to targets by
  pattern-matched rules is neither `Topic` (subscriber fan-out) nor `Stream`
  (ordered replayable offsets) nor `Queue` (point-to-point).

Both contracts are well understood at authoring time, so the one-minor
reservation notice that §5.6 buys is worthless here — hence direct introduction.

The three enum widenings track field reality the same way `Database.class` did in
1.1.0: user-directory identities, Kubernetes/EKS runtimes, and GraphQL gateway
protocols are common intent that 1.2.0 could only mis-declare or not declare.

## Problem statement

1.0.0–1.2.0 cannot express edge distribution or event-routing intent at all
(there is no kind), cannot state a user-directory identity (`Identity.type`
admits only `workload`), cannot state a Kubernetes runtime (`Service.runtime`
admits only `container`/`vm`/`managed`), and cannot state a gateway's application
protocol (there is no `Gateway.protocol` field).

## Goals

- Introduce `Cdn` and `EventBus` as complete, minimal, provider-neutral fully
  specified kinds satisfying the five deliverables of Chapter 5 §5.7 (which mirror
  the §5.6 promotion requirements), and establish §5.7 as the direct-introduction
  process.
- Widen `Identity.type`, `Service.runtime`, and `Gateway.protocol` additively,
  each new value/field carrying `x-iap-since: 1.3.0`.
- Keep the change set strictly additive: every known-valid 1.0.0/1.1.0/1.2.0
  document (official examples, conformance corpus, provider corpora, embedded
  fixtures) validates unchanged with identical canonicalization.
- Record the `Email`-kind decision so it is not relitigated ad hoc.

## Non-goals

- **No new relationship verbs** (closed for the v1 major) and no changes to the
  Chapter 4 §4.3.1 verb/target-kind tables. `Cdn` and `EventBus` participate
  through the open verbs: a `Cdn` is the source of `dependsOn` to its origins and
  MAY declare `protectedBy`/`monitoredBy`; producers reach an `EventBus` via the
  open `connectsTo` verb (`publishesTo` stays scoped to `Topic`/`Queue`), and the
  bus reaches consumers via `routesTo` (whose closed target list — `Service`,
  `Function`, `Gateway` — already admits them).
- **No provider mappings or handlers.** Reference handlers for CloudFront /
  EventBridge, and for the Cognito/EKS/AppSync realizations of the widened enums,
  are milestone M24.2 (provider-sdk / provider territory), not part of this spec
  minor. Nothing forces existing mappings to add coverage.
- **No change to `CORE_KINDS`.** The two new kinds occupy a separate
  `NEW_KINDS` tier, not `CORE_KINDS`: downstream tables keyed on `CORE_KINDS`
  (the provider-sdk abstract-output registry — a test asserts its key set equals
  `CORE_KINDS` exactly — and the planner's kind reconstruction) cover exactly the
  1.0.0 thirteen until provider support lands — the M23.1 lesson, preserved.
- **No `Email` kind** (see Decision — rejected).
- **No new error codes**, no changes to `spec/conformance/error-codes.yaml`.

## Terminology

- **Direct introduction** — the Chapter 5 §5.7 process by which a brand-new kind
  becomes fully specified in a minor without a prior reserved stage. Distinct from
  **graduation** (§5.6), which promotes a previously reserved name.
- **New kinds** — after 1.3.0: `Cdn`, `EventBus` (the `NEW_KINDS` runtime tier).

## Detailed design

Because `Cdn` and `EventBus` are brand-new, no corpus document uses them, so —
unlike the graduated kinds of IEP-0015/0016 — their contracts are free to declare
field defaults (there is no reserved-era canonical form to keep byte-identical).
The `Gateway.protocol` widening is the one place canonicalization stability
matters: it is a **new optional field with no default**, so existing `Gateway`
documents (which omit it) materialize unchanged. The two enum widenings on
`Identity.type` / `Service.runtime` only ever accept strictly more documents; the
existing defaults (`workload`, `container`) are unchanged.

### D1. `Cdn` (capability family: *network*)

Content delivery / edge distribution in front of one or more origins. `spec` is
**required** (a Cdn with no origin distributes nothing).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `exposure` | enum `public` \| `internal` | No | `public` | Edge reachability: internet-facing or organization-network only. |
| `origins` | array of object (unique, min 1) | **Yes** | — | Backend origins the edge distributes. |
| `origins[].target` | resource ID | Yes (per entry) | — | Names an in-document origin (typically `Service`/`Gateway`/`ObjectStore`). Referential integrity is advisory in 1.3.0 (no generic spec-field reference check yet); authors SHOULD also declare a `dependsOn` edge to each origin. |
| `origins[].pathPattern` | string | No | — | Optional path prefix routed to this origin (e.g. `/static`). |
| `tls` | object | No | — | TLS posture at the edge; mirrors `Gateway.spec.tls`. |
| `tls.minimumVersion` | enum `1.2` \| `1.3` | No | `1.2` | Minimum TLS version. |
| `tls.certificate` | resource ID | No | — | Reference to a `Certificate` resource; omit for provider-managed. |
| `caching` | object | No | — | Edge caching behavior. |
| `caching.mode` | enum `standard` \| `aggressive` \| `disabled` | No | `standard` | Caching aggressiveness / pass-through. |
| `caching.defaultTtl` | string (duration) | No | — | Default edge cache lifetime. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

- **Outputs:** `identifier`, `endpoint`.
- **Relationships:** source of `dependsOn` (→ origins); MAY declare
  `protectedBy` (→ `Certificate`) and `monitoredBy` (→ `Dashboard`/`Alert`).
- **Lifecycle:** all fields in-place; never replacement-eligible.

### D2. `EventBus` (capability family: *messaging*)

Event routing from declared source classes to targets by declarative rules.
`spec` is **optional** (all fields optional or defaulted).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `sources` | array of enum `internal` \| `partner` \| `custom` (unique, min 1) | No | — | Accepted event-source classes. Neutral, never provider products. |
| `rules` | array of object | No | — | Declarative routing rules; targets are wired as `routesTo` relationships from the bus. |
| `rules[].name` | resource ID | Yes (per entry) | — | Rule name. |
| `rules[].eventPattern` | object (open) | No | — | Neutral matching object over event attributes; absent matches every event. |
| `rules[].enabled` | boolean | No | `true` | Whether the rule is active. |
| `schemaRegistry` | enum `none` \| `managed` | No | `none` | Whether events are validated against a managed schema registry. |
| `retention` | string (duration) | No | — | Undelivered / replayable event retention. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

- **Outputs:** `identifier`, `endpoint`.
- **Relationships:** target of `connectsTo` from producers (`access: write`;
  `publishesTo` stays scoped to `Topic`/`Queue`); source of `routesTo` (→
  `Service`/`Function`/`Gateway`); MAY declare `monitoredBy`/`protectedBy`.
- **Lifecycle:** all fields in-place; never replacement-eligible.

### D3. Enum widenings

Each new value/field carries `x-iap-since: 1.3.0` and (for enum members) a schema
`description` note, since JSON Schema cannot annotate individual enum values.

| Enum | 1.2.0 members | 1.3.0 adds | Later realization | Compatibility |
|---|---|---|---|---|
| `Identity.type` | `workload` | `user-directory` | Cognito user pools | Enum only ever accepts more; default `workload` unchanged. |
| `Service.runtime` | `container`, `vm`, `managed` | `kubernetes` | EKS | Enum only ever accepts more; default `container` unchanged. |
| `Gateway.protocol` *(new optional field)* | — (no field) | `http`, `graphql` | AppSync (GraphQL) | New optional field, **no default** → existing Gateway documents canonicalize byte-identically. |

**Note on field names.** The roadmap named these "`Identity.class`" and
"`Gateway.protocol`". The schema's actual discriminator on `Identity` is `type`
(not `class`) — Chapter 3 §3.15 already noted "future minors may add values" — so
the widening is applied to `Identity.type`. `Gateway` had **no** protocol field
in 1.0.0–1.2.0, so 1.3.0 introduces one: a new optional `Gateway.protocol` field
(no default) whose enum offers `http`/`graphql`. Both realize the roadmap's intent
faithfully against the real schema surface.

## Schema impact

All in `spec/schema/iap-v1.schema.json` (byte-identical embedded copies refreshed
by `tools/schema-generation/sync-schemas.mjs`, plus the VS Code language-server
copy; `spec/schema/compiler-operations-v1.schema.json` `$defs/kindName` kept in
step with the document `kindName`):

1. Top-level `description`: specification version becomes `1.3.0`.
2. `$defs/kinds` gains two full definitions — `Cdn`, `EventBus` — each carrying
   `"x-iap-since": "1.3.0"` and its family in the description, inserted before
   `ReservedKind`. Both use the standard envelope (`patternProperties ^x-`,
   `additionalProperties: false`).
3. `$defs/resource.allOf` gains two kind-dispatch branches. `Cdn` requires `spec`
   (it has a required field, `origins`); `EventBus` does not.
4. `$defs/kindName` **appends** `Cdn`, `EventBus` after `Alert` (an additive enum
   extension; existing positions are unchanged).
5. Enum widenings: `Service.runtime.enum` appends `kubernetes`;
   `Identity.type.enum` appends `user-directory`; a new optional
   `Gateway.properties.protocol` (enum `http`/`graphql`, `x-iap-since: 1.3.0`, **no
   default**). Descriptions document the since-version for each.
6. `ReservedKind` is unchanged — the registry stays empty; direct introduction
   does not touch it.

## Runtime-model impact

`@iap/model`:

- A new tier `NEW_KINDS` (`Cdn`, `EventBus`) with `isNewKind`/`isSpecifiedKind`
  guards; `KINDS` appends the two names (drift-tested against the `kindName`
  enum). `CORE_KINDS` (thirteen) and `GRADUATED_KINDS` (nine) are **unchanged**.
  The tier-partition drift test now unions `NEW_KINDS` into the closed vocabulary.
- **Why a separate tier and not `CORE_KINDS`** (the M23.1 lesson, verified): the
  provider-sdk `ABSTRACT_OUTPUT_ATTRIBUTES` table is asserted by
  `packages/provider-sdk/test/manifest.test.ts` to have keys **exactly equal** to
  `CORE_KINDS`, and the planner's `deriveStatefulness` iterates `CORE_KINDS` as
  reconstruction candidates. Adding `Cdn`/`EventBus` to `CORE_KINDS` would break
  the former outright and silently change the latter, with no provider output
  bindings existing yet. `abstractOutputsForKind` returns `[]` for non-core kinds,
  so the new kinds are correctly treated as having no bound outputs until M24.2.
  The full workspace suite was run to confirm no provider-sdk/planner breakage.
- Canonicalization resolves every specified kind (core, graduated, or new) to its
  own `$defs/kinds/<Kind>` subschema by reading the schema; no CIM structural
  changes; no code change was needed in canonicalize for the new kinds.

## Validation impact

- **IAP801 unchanged.** The reserved registry stays empty; `Cdn`/`EventBus` were
  never reserved, so IAP801 fires for them never (they are `isSpecifiedKind`,
  `isReservedKind` false). No IAP104/rule changes; no new error codes.
- The language-server kind-completion set grows from 22 to 24; its test was
  updated accordingly.

## Provider impact

Mappings MAY now declare fail-closed coverage for `Cdn`/`EventBus` against a
frozen contract, and would bind their declared abstract outputs (`Cdn`:
identifier, endpoint; `EventBus`: identifier, endpoint) when handlers land in
M24.2. Nothing forces existing mappings to add coverage — the Chapter 12
fail-closed rule is unchanged. `providers/aws/conformance` (digest-pinned) is not
touched.

## Security impact

- `Cdn.exposure` is policy-visible; `tls` follows the `Gateway.tls` idiom.
- `EventBus.schemaRegistry: managed` makes event-schema enforcement a declarative,
  policy-addressable fact.
- `Identity.type: user-directory` distinguishes an end-user directory from a
  workload identity, so the least-privilege derivation (which applies to
  `workload`) is not misapplied to a user pool. No security-view derivation
  changes are required by this IEP.

## Cost impact

None normative. The reference cost model prices `Cdn` under network/edge
heuristics and `EventBus` under messaging heuristics; no cost-schema changes.

## Compatibility

**Strictly additive; minor-eligible.**

- The `kind` enum only appends; existing documents, selectors, and policies see a
  superset vocabulary. No existing document uses `Cdn`/`EventBus`.
- The two `Identity.type` / `Service.runtime` widenings and the new
  `Gateway.protocol` field only ever accept strictly more documents; the new
  Gateway field carries no default, so canonicalization of every existing Gateway
  document is byte-identical.
- Older validator (1.0.x–1.2.x) + newer document: unknown kinds/fields surface as
  IAP804 per §10.6.
- Newer validator + older document: always valid (§10.6).
- Verified: the 9 official examples, the reference mapping, and the full 1.0.0 /
  1.1.0 / 1.2.0 conformance corpora still validate; `test:providers` and
  `test:determinism` (which run over the provider corpora and `spec/examples/`,
  none of which use the new surface) are unaffected.

## Migration

None required (additive). No `iap migrate` transform is needed.

## Alternatives considered

- **Adding `Cdn`/`EventBus` to `CORE_KINDS`.** Rejected — breaks the
  provider-sdk abstract-output test (keys must equal `CORE_KINDS`) and the
  planner reconstruction, with no provider bindings yet (the M23.1 lesson). They
  go in the separate `NEW_KINDS` tier.
- **Reserving `Cdn`/`EventBus` first, graduating later.** Rejected — their
  contracts are well understood now; a reserved cycle would ship an empty body and
  buy nothing. §5.7 direct introduction exists precisely for this.
- **Modeling `Cdn.origins` as relationships only (no field).** Rejected — a CDN's
  origin set is a defining property; a field mirrors `Gateway.tls.certificate`'s
  field-reference precedent. Referential integrity is left advisory (no generic
  field-ref checker exists), and a `dependsOn` edge is recommended for ordering.
- **Letting producers `publishesTo` an `EventBus`.** Rejected — the verb/target
  tables are closed for the v1 major; `publishesTo` stays scoped to `Topic`/`Queue`.
  Producers use the open `connectsTo` verb; the bus reaches consumers via `routesTo`.
- **Naming the Identity discriminator `class`** (as the roadmap did). Rejected —
  the schema field is `type`; inventing a parallel `class` field would duplicate
  the discriminator. The `type` enum is widened instead.
- **Giving `Gateway.protocol` a default of `http`.** Rejected — a default
  materializes during canonicalization, changing the canonical form (and plan
  digests) of every existing `Gateway` document. The field is default-free.

## Rejected alternatives

- **An `Email` kind** (e.g. SES). Rejected — see Decision.
- **Per-kind version markers** — Chapter 10 §10.1 forbids new version indicators.
- **Growing `CORE_KINDS`** — the M23.1 lesson (above).

## Implementation plan

All steps in this repository, milestone M24.1 (spec + reference model/validator);
provider handlers (CloudFront/EventBridge; Cognito/EKS/AppSync) follow in M24.2.

1. Schema: `spec/schema/iap-v1.schema.json` changes above; run
   `tools/schema-generation/sync-schemas.mjs` and copy to the VS Code
   language-server schema; update `compiler-operations-v1.schema.json` `kindName`.
2. Chapters: Chapter 3 (two new kind sections §3.27–§3.28; §3.3 outputs table;
   §3.5 runtime row; §3.8 new Gateway `protocol` row; §3.15 Identity `type` row;
   intro), Chapter 5 (§5.2 gains two rows; §5.3 rule 5 amended; new §5.7 with the
   Email decision in §5.7.1), Chapter 8 (IAP801 note), Chapter 10 (§10.2.1 note;
   §10.3 record). Version headers of the touched chapters + conformance README
   stamped `Version 1.3.0 (IEP-0017) · Status: Released`.
3. Conformance: new cases `valid/06-new-kinds-and-widenings`,
   `invalid/27-cdn-missing-origins`, `invalid/28-eventbus-bad-source`,
   `invalid/29-identity-bad-type` (all three schema-invalid); README case table.
4. Reference implementation: `@iap/model` `NEW_KINDS` tier + `isNewKind` +
   `KINDS`; package tests (new-tier + x-iap-since); language-server completion
   count 22 → 24.
5. Release gate (human, pre-authorized): accept this IEP, stamp headers, tag 1.3.0.

## Conformance requirements

- `valid/06-new-kinds-and-widenings.iap.yaml` — `Cdn` + `EventBus` with full specs
  and their characteristic relationships, plus `Identity.type: user-directory`,
  `Service.runtime: kubernetes`, `Gateway.protocol: graphql`; MUST pass with **no
  IAP801** for any resource.
- `invalid/27-cdn-missing-origins.iap.yaml` — `Cdn` without `origins`;
  schema-invalid (required).
- `invalid/28-eventbus-bad-source.iap.yaml` — `EventBus.sources` with a value
  outside the closed enum; schema-invalid.
- `invalid/29-identity-bad-type.iap.yaml` — `Identity.type` outside the widened
  closed enum; schema-invalid (pins the widening's boundary).
- Every 1.0.0 / 1.1.0 / 1.2.0 corpus document and the 9 examples MUST continue to
  pass.
- CV-4 (Chapter 24): a conforming 1.3.0 validator MUST emit IAP801 for no kind and
  MUST NOT emit it for `Cdn` or `EventBus`.

## Open questions

1. Should `Cdn.origins[].target` gain enforced referential integrity (a generic
   spec-field reference checker), or stay advisory until that checker exists?
   (Current draft: advisory; a `dependsOn` edge is recommended.)
2. Should `EventBus.rules[].eventPattern` gain a neutral structured grammar in a
   later minor, or stay an open object? (Current draft: open object.)
3. Should `Gateway.protocol` gain further members (e.g. `grpc`, `websocket`) as
   evidence emerges? (Current draft: `http`/`graphql` only; additive later.)
4. Should the `Email` capability ever become a kind, or stay a
   messaging-verb/extension concern? (Current draft: rejected as a kind; see
   Decision.)

## Decision

**Accepted 2026-07-18** and released as specification minor 1.3.0, under the
user's standing autonomous-roadmap-completion directive (the M24.1 human release
gate was pre-authorized). The additive schema/chapter/model/validator edits
already merged (workspace suite green; 1.0.0, 1.1.0, and 1.2.0 corpora still
validate; `test:spec`, `test:providers`, `test:determinism` green) are promoted
from proposed to released.

**The `Email`-kind decision → REJECTED (revisitable).** No `Email` kind is added
in 1.3.0. Rationale: email sending is a *messaging-verb / integration* concern,
not an infrastructure resource kind with a stable desired-state surface. A kind
earns its place by declaring a reconciled resource that exists; "send a message to
an address" is an action performed by a workload, better modeled as application
behavior over existing kinds (`Function`/`Service` emitting; `EventBus`/`Topic`/
`Queue` routing) plus provider `extensions` where a concrete sender is named.
Minting an `Email` kind would encode a provider integration as core vocabulary and
blur the WHAT/HOW line. The decision reserves no name and is revisitable: a future
minor may introduce it additively if a genuine desired-state surface emerges. The
decision is recorded normatively in Chapter 5 §5.7.1.

Open questions resolved to the drafted defaults (each **revisitable** by the
maintainer; none blocks the release since all are conservative/additive):

1. **`Cdn.origins[].target` referential integrity** → advisory in 1.3.0; a
   generic spec-field reference checker (and any promotion of this to an error) is
   later work.
2. **`EventBus.rules[].eventPattern`** → open object in 1.3.0; a structured
   neutral grammar is a later additive minor.
3. **`Gateway.protocol` members** → `http`/`graphql` only; further members wait
   for evidence and are additive.
4. **`Email` kind** → REJECTED for 1.3.0 (above); revisitable.
5. **New-kind tier placement** → `NEW_KINDS`, not `CORE_KINDS`, confirmed to avoid
   provider-sdk/planner breakage (M23.1 lesson).
6. **`Gateway.protocol` default** → none, to keep existing Gateway
   canonicalization byte-identical.

These are recorded as revisitable in [[autonomous-roadmap-completion]]; a
maintainer may reopen any of them in a future minor without breaking 1.3.0.

## References

- Chapter 3 §3.27–§3.28 — `Cdn`/`EventBus`; §3.5/§3.8/§3.15 — the widenings;
  Chapter 5 §5.7 — direct introduction, §5.7.1 — the Email decision; Chapter 8 —
  IAP801; Chapter 10 §10.2/§10.3 — additive minors, `x-iap-since`; Chapter 24 CV-4.
- IEP-0015 (1.1.0 graduation), IEP-0016 (1.2.0 graduation — this completes the
  vocabulary-growth story with the direct-introduction path), IEP-0001 (resource
  model), IEP-0012 (provider conformance — M24.2 handler context), ADR-0002 (JSON
  Schema as normative contract).
- ROADMAP-V4 Phase 24, milestone M24.1.
