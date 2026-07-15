# Phase 2 Design — Canonical Model and Reference SDK

**Date:** 2026-07-10 · **Status:** Executing · **Governing IEP:** IEP-0008 (CIM) · **Spec inputs:** ch. 1 §1.5 (canonical form, resolved in M1.1), ch. 4 §4.7 (edge normalization), ch. 6 (profile merge), ch. 8 (validation phases), ch. 9 (dependency derivation), ch. 21 (SDK component contracts)

## Package topology

Phase 2 extends the two M0.6 packages and adds three:

| Package                | Milestone   | Contents                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@iap/parser` (extend) | M2.1        | Per-node source maps (JSON Pointer → range), alias-expansion limits, file/stream input, position-attached findings                                                                                                                                                                                                   |
| `@iap/model` (extend)  | M2.2 + M2.3 | CIM types (IEP-0008), exact-rational quantity/duration engine (BigInt millis — no floating point), profile merger (RFC 7386 + extends chain), schema-driven default materializer (the seven §1.5.1 rules), edge flattener (§4.7), canonical serializer + SHA-256 hashing, determinism test suite with golden vectors |
| `@iap/graph` (new)     | M2.5        | Typed graph over canonical edges: incoming/outgoing indexes, target resolution, verb/kind constraint tables, ordering-DAG derivation, cycle detection with path reporting, execution waves, path/impact queries                                                                                                      |
| `@iap/validator` (new) | M2.4        | Validation phases 1–4 producing registry-coded findings: schema (delegating to parser's ajv integration), reference (IAP201–205), relationship (IAP301–303), dependency (IAP401–403) — evaluated on the profile-merged document per ch. 8                                                                            |
| `@iap/sdk` (new)       | M2.6        | Facade (`load` → parse/validate/canonicalize/graph), round-trip serializer, plugin registration interface (extension packages: sub-schemas, future mappings), API compatibility tests                                                                                                                                |

## Execution order

Wave 1 (parallel): M2.1 (parser) ∥ M2.2+M2.3 (model — combined milestone: CIM types and canonicalization are one coherent unit).
Wave 2 (parallel after wave 1): M2.4+M2.5 (validator + graph — combined: reference/relationship/dependency validation IS the graph engine's constraint surface).
Wave 3: M2.6 (SDK facade over everything) + harness upgrade: semantic conformance cases (expected: IISnnn) become **executable** — the harness runs `@iap/validator` and asserts the expected code is actually produced, upgrading Phase 1's "declared outcome" checks to real semantic verification.

## Key design decisions

1. **No floating point anywhere in canonicalization** — quantities are BigInt milli-units; hashes must be bit-stable across platforms.
2. **The schema drives the materializer** — defaults, `x-iap-presence-semantic`, and `x-iap-default-when` are read from the embedded schema at runtime; no hand-coded default tables (ADR-0002's no-second-source rule).
3. **Validation and canonicalization are independent** — canonicalize does not require validity (it normalizes what is there); the SDK facade runs validation first and only hashes valid documents, but the engines stay pure and separately testable.
4. **Golden vectors** — pinned canonical hashes for fixed fixtures become the cross-implementation determinism test (ch. 24 CP class groundwork).

## Exit criteria mapping

Every official example parses and validates → SDK test over all 9 examples. Round-trip equivalence → M2.6 serializer test. Identical hashes → M2.3 golden vectors + key-order-shuffle tests. Graph independence from key order → M2.5 test. No provider SDK needed → dependency audit (packages depend only on ajv/yaml). API compatibility tests → M2.6 public-surface snapshot test.
