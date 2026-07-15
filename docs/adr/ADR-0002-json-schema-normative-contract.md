# ADR-0002: JSON Schema as the normative machine-readable contract

**Status:** Accepted
**Date:** 2026-07-10

## Context

The IaP specification exists as both prose (24 chapters) and machine-readable schemas. Two artifacts can disagree, and implementations need a single arbiter for structural questions: which fields exist, their types, allowed values, and defaults. Chapter 2 (§2.1) already states the rule for documents; this ADR makes it binding for the toolchain and closes the classic failure mode of hand-maintained parallel type systems drifting from the schema — a failure mode roadmap §8 explicitly forbids ("Do not create a second type system that can drift from the normative JSON Schema").

## Decision

1. **`spec/schema/iap-v1.schema.json` (JSON Schema draft 2020-12) is the normative machine-readable contract** for IaP documents; `spec/schema/iap-mapping-v1.schema.json` plays the same role for provider mapping artifacts. Where prose and schema disagree, **the schema governs structural questions and the prose governs semantic ones** (Chapter 2, §2.1).
2. **Implementation packages MUST NOT hand-maintain a second type system that can drift from the schema.** Runtime types in `packages/` are either **generated from** the schema or **verified against** it by automated tests that fail on divergence. A hand-written interface without a schema-conformance test is a defect.
3. **Validators must be annotation-tolerant.** The schemas use the `x-iap-*` annotation vocabulary (`x-iap-since`, `x-iap-deprecated`, `x-iap-capability`, `x-iap-reserved`). Per conformance requirement CV-6 (Chapter 24), these are non-validating annotation keywords: generic JSON Schema libraries must be configured accordingly (for Ajv, `strict: false` or explicit keyword registration — the strict default rejects the schema itself), and `x-iap-deprecated` must surface as IAP805 warnings.
4. **Schema changes are specification changes.** Any modification to the schemas is a normative change and requires an accepted IEP (see [GOVERNANCE.md](../../GOVERNANCE.md)); compatibility follows Chapter 10 (minors strictly additive; removals only at a major, with a deterministic migration transform).

## Consequences

- One source of structural truth: prose/schema mismatch on structure is by definition a prose bug (or an IEP-worthy schema bug), never an implementation judgment call.
- Phase 2 packages need a type-generation or schema-verification step in the build; this is deliberate, non-optional tooling cost.
- The choice of draft 2020-12 constrains validator library selection to those with full 2020-12 support.
- Custom `x-iap-*` keywords mean off-the-shelf strict validation fails; every consumer (docs, CI, SDK) must carry the annotation-tolerance configuration, which the conformance suite exercises.
- Anything the schema cannot express (cross-resource rules, relationship semantics, derivation) remains prose-normative and is covered by the semantic validation phases of Chapter 8 — the schema's authority is structural, not total.

## Alternatives considered

- **Hand-written TypeScript types as the source of truth** — rejected: unavailable to non-TypeScript implementations, and exactly the drift-prone second type system the roadmap forbids.
- **Prose as sole arbiter with the schema informative** — rejected: machines cannot consume prose; independent implementations and the conformance suite need an executable contract.
- **A custom IDL or protobuf-style schema** — rejected: JSON Schema 2020-12 is the ecosystem standard for YAML/JSON document validation, has broad multi-language tooling, and matches the OpenAPI-style positioning of IaP.
- **Strip `x-iap-*` annotations to keep validators strict** — rejected: the annotations carry versioning and deprecation metadata that Chapter 10/24 behavior (IAP801/IAP805 warnings) depends on.

## References

- Roadmap §8 (no second type system), §2 (current project state)
- Spec [Chapter 2, §2.1](../../spec/chapters/02-document-layout.md) (schema governs structure), [Chapter 10](../../spec/chapters/10-versioning.md) (compatibility), [Chapter 24](../../spec/chapters/24-conformance.md) (CV-6 annotation vocabulary)
- [spec/schema/iap-v1.schema.json](../../spec/schema/iap-v1.schema.json), [spec/schema/iap-mapping-v1.schema.json](../../spec/schema/iap-mapping-v1.schema.json)
