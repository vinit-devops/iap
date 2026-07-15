# IEP-0011: Deterministic Planning Contract

| Field | Value |
|---|---|
| **Title** | Deterministic Planning Contract and Plan Artifact |
| **Number** | IEP-0011 |
| **Status** | Draft |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | 1.x |

## Summary

This IEP turns the planning guarantees of [Chapter 14](../chapters/14-planning-model.md) and conformance class CP ([Chapter 24, §24.2.3](../chapters/24-conformance.md#2423-conforming-planner)) into a complete contract: the **enumerated determinism input vector**, a **versioned, content-hashed, signed, expiring machine-readable plan artifact**, deterministic **risk scoring**, explicit **destructive-action marking**, **plan invalidation** when any input changes, and a **golden-plan test requirement**. Identical inputs must yield byte-identical canonical plans.

## Motivation

Chapter 14 §14.5 defines plan determinism over three inputs (canonical document, infrastructure model snapshot, mapping artifacts). The roadmap (§5.4, Phase 7) demands a wider, fully enumerated vector — profiles, policies, extensions, discovery and pricing snapshots, planner version, explicit target — plus signing, expiry, risk scoring, and golden-plan tests, none of which the spec yet pins down. Approval workflows bind to `planId`; that binding is only safe if everything that can change a plan is inside the hashed input set and everything that can invalidate one is checked before execution.

## Problem statement

Unspecified today: (a) the exact input vector and how each element is identified/hashed; (b) the plan artifact's schema and canonical serialization beyond CP-2's ordering rules; (c) how a signed plan expires without violating "no timestamps inside a plan" (§14.5); (d) a deterministic risk-scoring function; (e) the invalidation rule an engine must enforce; (f) the golden-plan corpus obligations.

## Goals

- Enumerate the closed determinism input set; anything else influencing a plan is a conformance failure.
- Define `plan.iap.dev/v1`: machine-readable, versioned, content-hashed, signed, expiring.
- Mark every destructive action and rollback limitation explicitly.
- Define fail-closed plan invalidation and golden-plan testing.

## Non-goals

- Execution semantics (halt-wave, idempotency — Chapter 14 §14.7, CE class, unchanged).
- Approval workflow/UI (Phase 16); this IEP only defines where approvals attach.
- Risk-score *policy* thresholds (Chapter 7 policies consume the score).

## Terminology

- **Determinism inputs** — the closed set of artifacts fully determining a plan's bytes.
- **`inputsHash`** — SHA-256 over the canonical serialization of all determinism-input identities.
- **Plan envelope** — signature, expiry, and audit metadata *around* the hashed plan content.
- **Golden plan** — a reviewed, committed expected plan for a fixed input vector.

## Detailed design

### Determinism inputs (closed set)

1. Canonical IaP document (C1–C6 hash) with **explicit deployment target** and active profile;
2. Profile versions/hashes (per merged profile);
3. Policy bundle versions/hashes;
4. Extension package versions;
5. Provider mapping artifact versions (per namespace);
6. **Provider discovery snapshot** id — pre-fetched, versioned observations supplied as explicit mapping inputs (Chapter 12 §12.2 forbids ambient lookups);
7. **Pricing snapshot** id, where cost deltas are computed ([Chapter 20, §20.2.2](../chapters/20-mcp-integration.md));
8. Infrastructure model snapshot: state document `revision` + integrity hash (IEP-0010);
9. Planner version (semver of the planning implementation).

No wall-clock, network, environment, locale, randomness, or model inference may influence plan content (CP-1 restated). All nine identities are serialized canonically and hashed into `inputsHash`.

### Plan artifact sketch

```yaml
apiVersion: plan.iap.dev/v1
planId: "sha256:3d97a1…"            # hash of canonical plan content (everything below `content:`)
envelope:                            # NOT hashed into planId; integrity via signature
  createdAt: "2026-07-10T11:20:04Z"
  expiresAt: "2026-07-11T11:20:04Z"  # derived from snapshot validity horizons
  signature: { keyId: "planner-release-key-3", alg: "ed25519", value: "…" }
content:
  inputs:
    documentHash: "sha256:…"
    target: { provider: "mock", profile: "production" }
    profileHashes: { production: "sha256:…" }
    policyBundles: { org-baseline: "1.4.0" }
    extensionVersions: {}
    mappingVersions: { mock: "0.9.2" }
    discoverySnapshot: "disc-2026-07-09-01"
    pricingSnapshot: "price-2026-07-01"
    stateRevision: 14
    stateIntegrity: "sha256:…"
    plannerVersion: "0.4.0"
    inputsHash: "sha256:…"
  waves:
    - - resource: session-cache
        action: update-in-place
        fields: [spec.capacity.memory]
        provenance: { changedBy: "documentHash", fieldSources: { "spec.capacity.memory": "explicit" } }
        destructive: false
        reversibility: fully-reversible
  destructiveActions: []             # every replace/delete listed here, always present
  unknownValues: []                  # attributes resolvable only at apply time
  risk: { score: 12, class: low,
          factors: [ { id: capacity-change, weight: 12, resources: [session-cache] } ] }
  deltas: { cost: { monthly: "+12.40 USD" }, security: [], compliance: [] }
  rollback: { strategy: re-plan-to-revision, limitations: [] }
  verification: [ { resource: session-cache, check: capacity-applied } ]
  approvalsRequired: []
```

`planId` = SHA-256 of the canonical serialization of `content` (UTF-8 JSON, sorted keys, wave/entry ordering per CP-2). Timestamps and signatures live only in the envelope, preserving §14.5. Both human-readable and machine-readable renderings derive from this artifact.

### Risk scoring and destructive marking

Risk is a **pure function of the plan content**: a versioned rule table assigns ordinal weights per action class (delete of stateful kind ≫ replace ≫ create ≫ in-place), per reversibility class (Chapter 14 §14.6; roadmap rollback classes `fully-reversible` … `irreversible`), and per affected security boundary (edges with `exposure`/access changes). The rule-table version is part of the planner version. Every `replace`/`delete` appears in `destructiveActions` with its reversibility class and required approval gate ([Chapter 19, §19.6](../chapters/19-ai-guidelines.md)); stateful-kind replacement without recorded authorization fails the plan (§14.2).

### Invalidation and expiry

Before execution an engine MUST recompute the identities of all nine inputs and refuse the plan if: any identity differs from `content.inputs` (`inputsHash` mismatch); the state revision has advanced; the envelope is expired; or the signature does not verify against a trusted planner key. Expiry defaults to the earliest validity horizon of the discovery/pricing snapshots, capped by configuration. Re-planning is always the remedy; there is no plan "patching."

### Golden-plan tests

The repository maintains `tests/determinism/golden-plans/`: for each official example × mock-provider mapping × fixed snapshots, a committed canonical plan. CI fails on any byte difference; intentional changes require regenerating goldens in the same reviewed change that alters planner behavior, with the planner version bumped.

## Schema impact

No change to `iap-v1.schema.json`. Adds normative `plan-v1.schema.json` (`plan.iap.dev/v1`) as a companion artifact; Chapter 14 gains a reference to it.

## Runtime-model impact

The planner consumes the CIM (IEP-0008) plus the state snapshot (IEP-0010); the plan artifact becomes the sole interface to engines and approval tooling.

## Validation impact

Planning still requires a Conforming Document with zero deny-level findings (CP-4). Plan artifacts themselves are schema-validated; a plan failing its own schema is unexecutable.

## Provider impact

Mappings contribute per-action reversibility metadata and discovery-snapshot schemas. Discovery snapshots are produced by provider read handlers *out-of-band* (e.g. an `aws` package snapshotting available engine versions and zone counts) and are versioned inputs — never live lookups at plan time.

## Security impact

Signing binds approvals to exact bytes; key management follows roadmap §9.4 (signed releases). Plans contain no secret values (CE-6); `unknownValues` marks late-bound attributes instead of leaking them. Expiry limits the window in which an approved-but-stale plan can act on a changed world.

## Cost impact

Cost deltas inside plans are reproducible from the pinned pricing snapshot (Chapter 20 §20.2.2); a missing snapshot yields an explicit `cost: unavailable`, never a silent zero.

## Compatibility

Additive; formalizes and extends CP without weakening any existing requirement. Chapter 14 §14.5's three-input statement is subsumed: items 2–7 and 9 were implicit in "canonical document + mappings" and are now explicit and individually hashed.

## Migration

None for documents. Planners must emit `plan.iap.dev/v1`; pre-IEP ad-hoc plan output is not conformant once accepted.

## Alternatives considered

1. Timestamped plan content with tolerance bands — rejected: violates §14.5 and destroys hash-based approval binding.
2. Unsigned plans relying on storage ACLs — rejected: approval must bind to content, not location.
3. TTL-free plans — rejected: stale discovery/pricing makes "approved" misleading (roadmap Phase 7 requires expiration).

## Rejected alternatives

Any planner input outside the enumerated set (environment variables, ambient provider queries, model inference) is categorically rejected (CP-1; roadmap §5.4).

## Implementation plan

1. `packages/planner`: input-vector assembly, `inputsHash`, canonical plan serialization.
2. `plan-v1.schema.json` + signing/verification (`tools/release` key infrastructure).
3. Risk rule table v1 + destructive marking; reversibility metadata in the provider SDK.
4. Golden-plan suite over mock provider; double-run determinism harness per §24.4 (including the network-disabled perturbation run).

## Conformance requirements

- PL-1 (extends CP-3): double-run byte equality over the full nine-input vector, environment perturbed per §24.4.
- PL-2: engine refuses execution on any `inputsHash` mismatch, expired envelope, or failed signature.
- PL-3: every `replace`/`delete` appears in `destructiveActions` with a reversibility class; absence is a conformance failure.
- PL-4: golden-plan corpus passes byte-exact in CI for all official examples against the mock provider.
- PL-5: plan content contains no timestamps, no secret values, and no unhashed inputs.

## Open questions

1. Signature scheme and trust distribution (per-org keys vs. sigstore-style transparency log)?
2. Should `inputsHash` include the risk rule-table version separately from `plannerVersion`?
3. Default expiry horizon when no snapshot declares one (24 h proposed).

## Decision

Pending review.

## References

- [Chapter 12 — Provider Mapping (§12.2)](../chapters/12-provider-mapping.md)
- [Chapter 14 — Planning Model (§14.5)](../chapters/14-planning-model.md)
- [Chapter 20 — MCP Integration (§20.2.2)](../chapters/20-mcp-integration.md)
- [Chapter 24 — Conformance (§24.2.3, §24.4)](../chapters/24-conformance.md)
- IEP-0008, IEP-0010; Roadmap §5.4, Phase 7
