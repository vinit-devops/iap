# IEP-0012: Provider Conformance Program

| Field | Value |
|---|---|
| **Title** | Provider Package Conformance and Certification |
| **Number** | IEP-0012 |
| **Status** | Draft |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | 1.x |

## Summary

This IEP defines the **provider conformance program**: what a provider package must contain (roadmap Phase 6), the plugin manifest and signature-verification model, fail-closed coverage enforcement at load and mapping time, a machine-runnable **capability-assertion test format** evaluated against generated plans, the double-run hash-equality obligation, three **certification levels** (core / execution / drift), and the mock provider as the reference harness. It extends the Conforming Mapping class (CM, [Chapter 24, §24.2.4](../chapters/24-conformance.md#2424-conforming-mapping)) from a per-artifact property to a testable program for whole provider packages.

## Motivation

Chapter 12 defines the mapping artifact and Chapter 24 defines CM-1…CM-6, but a real provider package is more than a mapping file: it ships extension schemas, validation/discovery/cost/security hooks, execution/read/drift/import handlers, documentation, icons, and its own conformance cases. Roadmap S6/S17 ("a new provider = one published package, zero core changes"; "independent providers pass conformance tests") requires a program that certifies the whole package — including its trust posture, since plugins execute inside the toolchain.

## Problem statement

Undefined today: (a) the package layout and manifest; (b) how signatures and allowlists gate plugin loading (roadmap §9.4); (c) how CM-5 capability assertions ("`encryption.atRest: required` produces encrypted storage") are expressed and mechanically evaluated against plans; (d) what "certified" means for packages that implement only mapping vs. full execution vs. drift; (e) the common harness independent providers test against.

## Goals

- Define provider package responsibilities and a signed plugin manifest.
- Enforce fail-closed coverage at load time, not only at mapping time.
- Define a declarative capability-assertion test format and its evaluation semantics.
- Define certification levels **core**, **execution**, **drift**, verified by one shared harness.
- Make the mock provider the executable reference for the harness itself.

## Non-goals

- Registry hosting, badges, and trademark policy (roadmap Phase 18).
- The mapping artifact grammar itself ([Chapter 12](../chapters/12-provider-mapping.md), IEP-0003).
- Engine conformance (CE class) beyond what execution-level certification reuses.

## Terminology

- **Provider package** — a versioned, signed plugin bundling mapping artifacts plus hooks/handlers for one provider namespace.
- **Capability assertion** — a machine-checkable claim that a generated plan satisfies an intent floor.
- **Certification level** — the scope of conformance a package may claim.
- **Attestation function** — package-supplied, pure predicate mapping plan attributes to an abstract capability verdict.

## Detailed design

### Package responsibilities and manifest

A provider package contributes: supported target types and core kinds; mapping rules (`*.iap-map.yaml`); a provider extension JSON schema; parameter metadata (docs, defaults, impact notes); validation, discovery, cost, and security hooks; execution, read, drift, and import handlers (levels above core); documentation references; architecture icons; and its own conformance cases.

```json
{
  "apiVersion": "plugin.iap.dev/v1",
  "name": "iap-provider-example",
  "namespace": "example",
  "version": "1.4.0",
  "specCompat": ">=1.0.0 <2.0.0",
  "sdkCompat": ">=0.4.0 <1.0.0",
  "certificationLevel": "execution",
  "artifacts": {
    "mappings": ["mappings/core.iap-map.yaml"],
    "extensionSchema": "schema/extension.schema.json",
    "conformanceCases": "conformance/",
    "icons": "icons/", "docs": "docs/refs.json"
  },
  "capabilities": {
    "kinds": ["Service", "Database", "Queue"],
    "hooks": ["validate", "discover", "cost", "security"],
    "handlers": ["execute", "read", "import"]
  },
  "attestations": "conformance/attestations.js",
  "integrity": { "digests": { "mappings/core.iap-map.yaml": "sha256:…" } },
  "signature": { "keyId": "…", "alg": "ed25519", "value": "…" }
}
```

**Loading (normative):** the plugin loader verifies the signature against the configured trust store and the publisher allowlist, verifies every artifact digest, checks `specCompat`/`sdkCompat`, and refuses the package on any failure — no degraded load. Packages run with least privilege: hooks are pure/sandboxed; only execution handlers (level ≥ execution, at deploy time only) receive credentials. Packages can never modify the CIM, documents, policies, or core validation results (CM-6 non-interference, extended package-wide).

**Fail-closed coverage:** the loader additionally verifies statically that `supports` and `realize` tile exactly (Chapter 12 §12.4) and that every derive map is total (CM-3), so a defective package fails at install, not at 3 a.m.

### Capability-assertion test format

Assertions are declarative cases evaluated by the shared harness against plans the package generates:

```yaml
apiVersion: conformance.iap.dev/v1
case: database-ha-encrypted
document: corpus/database-ha.iap.yaml     # a Conforming Document from the shared corpus
profile: production
mappingInputs: { discoverySnapshot: disc-fixture-01 }
assertions:
  - id: storage-encrypted
    select: { resource: orders-db, kind: Database }
    capability: encryption.atRest          # abstract capability, Chapter 5 vocabulary
    expect: satisfied                       # satisfied | rejected | unsupported
  - id: multi-zone
    select: { resource: orders-db }
    capability: availability.zonesMinimum
    params: { min: 2 }
    expect: satisfied
  - id: private-exposure
    select: { resource: orders-db }
    capability: exposure.private
    expect: satisfied
  - id: maximum-availability-fails-closed
    document: corpus/database-max.iap.yaml
    capability: availability.maximum
    expect: rejected                        # outside supports matrix → loud rejection
```

Evaluation: the harness runs the package's mapping over the fixed inputs, then evaluates each capability through the package's **attestation functions** — pure predicates over plan attributes registered per `(capability, target type)`. Attestations are themselves audited by the certification review (they are the package's claim of *how* its provider resources realize each floor) and are exercised against tampered-plan fixtures to prove they can fail. `expect: rejected` cases verify fail-closed behavior with the correct diagnostics (CM-2).

### Determinism and certification levels

Every level requires **double-run hash equality** per the §24.4 procedure (environment perturbed, network disabled) over the package's mappings and hooks.

| Level | Requires |
|---|---|
| **core** | Manifest + signature; CM-1…CM-6; assertion corpus pass; determinism; extension schema validates; docs/parameter metadata present |
| **execution** | core + execution/read/import handlers pass the full lifecycle suite (create/update/replace/delete/import/verify) against the harness with halt-wave, idempotent-convergence (CE-5), and secret-hygiene (CE-6) checks |
| **drift** | execution + inverse projection is a pure function of the observation snapshot (§14.8); drift fixtures classify deterministically into the IEP-0010 taxonomy |

A package MUST claim exactly one level and MUST NOT claim conformance while any required suite fails (mirrors §24.2's no-partial-claims rule).

### Mock provider as reference harness

The mock provider (`providers/mock`) implements all three levels against an in-memory substrate with injectable failures. It is normative-by-example: harness changes must keep the mock provider passing, and every assertion-format feature must be exercised by at least one mock case. Independent packages run the identical harness (S17).

## Schema impact

No change to `iap-v1.schema.json` or the mapping schema. Adds companion schemas: `plugin-manifest-v1.schema.json` and `conformance-case-v1.schema.json`.

## Runtime-model impact

Adds the plugin loader/registry to the SDK (`packages/provider-sdk`); mapping engine consumes packages only through it.

## Validation impact

Provider `validate` hooks may add findings in their own namespace but can never suppress or downgrade core findings; extension values are validated against the package's extension schema (IAP802 becomes a resolvable warning when the package is installed).

## Provider impact

This IEP *is* the provider contract. Example across substrates: the same `exposure.private` assertion is attested by security-group non-reachability on an `aws` package, by NetworkPolicy denial on a `kubernetes` package — different attestation functions, one abstract capability verdict.

## Security impact

Signature verification, digest pinning, allowlists, sandboxed hooks, credential isolation to execution handlers, and SBOM publication per package (roadmap §9.4). A package that silently weakens an intent floor fails CM-5/assertion certification — the program's core security purpose.

## Cost impact

Cost hooks must be pure over pricing snapshots; certification includes reproducing cost output from pinned snapshots. Missing hook ⇒ package marked `cost: unavailable`, never estimated by the core.

## Compatibility

Additive. Existing bare mapping artifacts remain valid inputs; they simply cannot claim package certification.

## Migration

Bare mappings migrate by wrapping in a manifest; a scaffold generator ships in `tools/`.

## Alternatives considered

1. Free-form per-provider test scripts — rejected: not comparable across providers, unauditable.
2. Core-implemented attestations per provider — rejected: provider knowledge would leak into the core (roadmap §5.6).
3. Single monolithic certification level — rejected: blocks mapping-only packages from useful, honest claims.

## Rejected alternatives

Unsigned or partially verified plugin loading is categorically rejected (fail closed; roadmap §9.4).

## Implementation plan

1. `packages/provider-sdk`: manifest types, loader, signature/digest verification, sandbox boundary.
2. Harness in `tests/conformance/`: corpus, assertion evaluator, tampered-plan fixtures, double-run procedure.
3. Mock provider through all three levels (Phase 6 milestone 1; Phase 14 for execution/drift depth).
4. First real package (aws reference) certified core, then execution (Phase 14 pilot).

## Conformance requirements

- PC-1: package load fails on signature, digest, compatibility, or coverage-tiling failure.
- PC-2: full assertion corpus passes for every supported kind/field/value combination; every `expect: rejected` case produces the documented diagnostic.
- PC-3: double-run hash equality holds for mapping and hook outputs (network disabled on run B).
- PC-4: attestation functions demonstrably fail on tampered plans (no vacuous attestations).
- PC-5: claimed certification level matches passing suites exactly; partial claims are non-conformant.

## Open questions

1. Attestation function packaging: sandboxed module vs. declarative predicate DSL (a DSL would ease audit but limit expressiveness)?
2. Who signs certifications pre-Phase 18 registry — repository CI keys or maintainer keys?
3. Should conformance case corpora be versioned independently of the spec minor?

## Decision

Pending review.

## References

- [Chapter 12 — Provider Mapping (§12.9)](../chapters/12-provider-mapping.md)
- [Chapter 24 — Conformance (§24.2.4, §24.4)](../chapters/24-conformance.md)
- IEP-0010 (drift taxonomy), IEP-0011 (plan artifact)
- Roadmap Phase 6, §9.4, S6/S17
