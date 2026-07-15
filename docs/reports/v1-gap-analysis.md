# IaP v1 Gap Analysis

**Date:** 2026-07-10 · **Scope:** audit of the IaP v1.0.0 draft repository prior to reference implementation (roadmap §2, §17.2) · **Verdict:** implementation-ready for Phase 2 minimum (parser + model); two precision gaps must close before Phase 2 _canonicalization_ exit criteria can be met.

## 1. Complete artifacts

| Artifact                                     | State                                                                   | Evidence                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 24 specification chapters (`spec/chapters/`) | Complete, consistent header/RFC 2119 conventions                        | Link check clean; error codes reconciled against ch. 8                    |
| `spec/schema/iap-v1.schema.json`             | Complete; compiles under ajv draft 2020-12 (annotation-tolerant mode)   | 13 full kinds + 9 reserved, common `$defs`, if/then kind dispatch         |
| `spec/schema/iap-mapping-v1.schema.json`     | Complete; compiles                                                      | supports/realize/outputs contract                                         |
| Examples (4 documents + 1 mapping)           | All validate against the schemas                                        | `spec/examples/`, `spec/mappings/`                                        |
| Conformance cases (3 valid + 6 invalid)      | All produce their declared outcome under schema validation              | `spec/conformance/cases/`                                                 |
| Error-code taxonomy IAP1xx–IAP8xx            | Reconciled; ch. 8 is the single authority; ch. 24 summary table matches | IAP101–105, 201–205, 301–303, 401–403, 501–505, 601–604, 701–702, 801–805 |

## 2. Incomplete artifacts

| Gap                                                                                                                                                                                                                                                                                                             | Impact                                                                                                                                          | Owner phase        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Quantity normalization table missing.** Ch. 1 canonical form step C4 says "normalized quantities" but never defines the normalization (is `1024Mi` ≡ `1Gi`? is `0.5` ≡ `500m`?).                                                                                                                              | Blocks deterministic hashing (Phase 2 canonicalization exit criteria); two conforming implementations could hash the same document differently. | Phase 1 / IEP-0008 |
| **Default-materialization rule for absent nested objects.** Ch. 2 §2.7 makes omitted fields identical to their defaults, but does not state whether a _wholly absent_ optional object (e.g. no `encryption:` block) materializes in canonical form (`{atRest: required, inTransit: required}`) or stays absent. | Same class of determinism break as above. Recommendation: materialize recursively — matches the "omission never weakens posture" principle.     | Phase 1 / IEP-0008 |
| **State document schema.** Ch. 13 gives a JSON sketch, not a schema artifact.                                                                                                                                                                                                                                   | Needed by Phase 7/14, not by Phase 2.                                                                                                           | IEP-0010           |
| **Plan artifact schema.** Ch. 14/22 describe plan content; no machine-readable schema.                                                                                                                                                                                                                          | Needed by Phase 7.                                                                                                                              | IEP-0011           |
| **Missing examples** required by roadmap Phase 1: serverless application, private internal service, data-processing workload, hybrid environment, existing-resource import intent. (Event-driven ≈ covered by `kubernetes-platform`; container platform ≈ covered.)                                             | Phase 1 deliverable, not a Phase 0 blocker.                                                                                                     | Phase 1            |

## 3. Schema/prose mismatches

All are **non-breaking annotation additions** to the schema (prose already normative):

1. **Per-kind backup defaults.** Ch. 3 §3.2 sets normative backup defaults (Database/Volume `required`, ObjectStore `preferred`) but `$defs/common/resilience.backup` carries no `default` annotation (deliberate at authoring — one shared def). Fix: per-kind `description` notes or split defs with per-kind defaults in a 1.0.x patch.
2. **Edge `access` default.** Ch. 4 §4.4 documents `access` default `read-write` on `connectsTo`/`storesDataIn`; the schema's `relationshipEdge.access` has no `default` annotation. Fix: add annotation.
3. **`x-iap-since` coverage.** Convention says absence = 1.0.0, so schema omits them everywhere; harmless now, but the field registry generator (ch. 3 §3.1, ch. 23) will want explicit annotations from 1.1 onward. No action for 1.0.

No contradictions were found where prose and schema assert _different_ values.

## 4. Missing conformance coverage

Current suite covers schema-shape failures (IAP101/102/103-class) plus two semantic cases (IAP201 dangling target, IAP401 cycle). Not yet exercised:

| Code               | Needed case                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| IAP104             | `deadLetter.maxReceives` without `enabled: true`; `scaling.min > max`; Database `class`/`engine` mismatch |
| IAP202/203/204/205 | dangling Application component / output resource / certificate ref / profile `extends` cycle              |
| IAP301/302         | verb/kind violation (e.g. `routesTo` → `Volume`); attribute on wrong verb (`path` on `connectsTo`)        |
| IAP402             | rule-edge selector matching zero resources                                                                |
| IAP5xx             | post-merge policy violation case (deny + require)                                                         |
| IAP601/602         | public data-kind exposure; credential-patterned `configuration` key                                       |
| IAP803             | extension block that changes core semantics (non-interference violation)                                  |
| post-merge IAP1xx  | profile whose merge deletes a required field (valid pre-merge, invalid post-merge)                        |

Determinism fixtures (golden canonical hashes) do not exist yet — blocked on the two §2 precision gaps.

## 5. Ambiguous normative requirements

1. **`require` autofix scope** (ch. 7): deterministic autofix defined for `equals` conjunctions; unspecified for `in`/`matches`. Suggest: autofix only `equals` leaves; others report-only. Non-breaking clarification.
2. **`exposure: internal` boundary** is "organization network" — inherently deployment-context-dependent; mappings define the realization. Acceptable, but ch. 12 should eventually require mappings to declare _how_ internal is realized (mapping metadata field). IEP-worthy, minor.
3. **Bidirectional `replicatesTo`** (ch. 4): symmetric replication is declarable as two edges, but failover semantics (who is writable after failover) are undefined in v1. Documented as out of scope? Not explicitly. Suggest an explicit non-goal note in 1.0.x; real design in a future IEP.
4. **Reserved-kind spec surface** (`ReservedKind` = free object): documents relying on reserved kinds are portable in shape but not in meaning; ch. 5 warns via IAP801. Acceptable for v1; conformance docs should discourage reserved kinds in portable documents.

## 6. Implementation blockers

- **None for M0.6** (parser + model + schema-validation harness): the schemas are stable and the examples validate.
- **For full Phase 2 canonicalization:** items §2.1 and §2.2 (quantity normalization, default materialization) MUST be resolved first — tracked in IEP-0008, target 1.0.x clarification (non-breaking: it tightens what was underspecified, changes no valid document's meaning).
- **Tooling note:** generic JSON Schema validators require annotation-tolerant configuration for `x-iap-*` keywords (ch. 24 CV-6). The reference validator package should pre-register the vocabulary so consumers never see strict-mode failures.

## 7. Proposed non-breaking corrections (1.0.x patch/annotation set)

1. Publish the quantity normalization table (canonical unit per field family; equality semantics).
2. State the recursive default-materialization rule in ch. 1/ch. 2.
3. Add `default` annotation for edge `access`; add per-kind backup-default notes to schema descriptions.
4. Add the §4 conformance cases (pure additions).
5. Add a non-goal note for replicatesTo failover semantics.
6. Clarify `require`-autofix scope (equals-only).

## 8. Changes requiring an IEP

- Canonical Infrastructure Model contract (IEP-0008 — includes §2.1/§2.2 resolutions since they define canonical equality).
- Intent compiler operation model (IEP-0009).
- State backend + unified drift taxonomy (IEP-0010) — ch. 14's reconcilable/conflicting/out-of-scope vs roadmap Phase 14's five-class taxonomy must be unified.
- Deterministic planning contract + plan artifact schema (IEP-0011).
- Provider conformance program mechanics beyond ch. 24 CM (IEP-0012).
- Any change to the closed verb set, kind enum, policy operators, or top-level keys (per ch. 10 versioning rules).
