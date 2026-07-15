# 24. Conformance

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter defines what it means to conform to the Infrastructure as Prompt. It states the success criteria against which the specification itself is judged, defines five conformance classes with normative requirement lists, publishes the banned provider-term list, specifies the determinism test procedure, and describes the machine-runnable conformance test suite shipped in the [`conformance/`](../conformance/README.md) directory. The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in [Chapter 2](02-document-layout.md). This entire chapter is normative except where marked otherwise.

## 24.1 Success Criteria

The specification exists to make the following outcomes true. Each criterion is testable, and the conformance class or procedure that verifies it is listed alongside. An ecosystem in which any criterion fails is an ecosystem in which IaP has failed, regardless of how many tools nominally conform.

| # | Criterion | Verified by |
|---|---|---|
| S1 | An engineer can read an IaP document and understand the infrastructure it describes **without knowledge of any cloud provider**. | Conforming Document ([§24.2.1](#2421-conforming-document)) + banned-term lint ([§24.3](#243-banned-provider-terms)) |
| S2 | The **same document** can target any provider — AWS, Azure, GCP, Kubernetes, on-premises — by substituting the mapping artifact, never by editing the document. | Conforming Mapping ([§24.2.4](#2424-conforming-mapping)); Extension Non-Interference Rule ([Chapter 11](11-extension-framework.md)) |
| S3 | Infrastructure change review happens at the **intent level**: a reviewer reads a diff of intent, not a diff of provider resources. | Canonical form ([Chapter 1 §1.5](01-architecture.md#15-canonical-form)); Conforming Validator ([§24.2.2](#2422-conforming-validator)) |
| S4 | Identical inputs produce **identical plans** — byte-identical, hash-verifiable. | Conforming Planner ([§24.2.3](#2423-conforming-planner)); determinism procedure ([§24.4](#244-determinism-test-procedure)) |
| S5 | **AI is never in the execution path.** Models may generate, validate, explain, and suggest intent documents; nothing downstream of the intent document may invoke model inference. | Layer boundary ([Chapter 1 §1.4](01-architecture.md), [Chapter 19](19-ai-guidelines.md)); Conforming Engine ([§24.2.5](#2425-conforming-engine)) |
| S6 | A **new provider** can be supported by publishing a mapping artifact, with **zero changes** to the core specification, schema, or existing documents. | Mapping contract ([Chapter 12](12-provider-mapping.md)); Conforming Mapping ([§24.2.4](#2424-conforming-mapping)) |
| S7 | Diagrams, cost estimates, security posture, and compliance evidence are **derived automatically** from the normalized graph — never drawn, spreadsheeted, or asserted by hand. | [Chapters 15](15-security-model.md)–[18](18-architecture-model.md); determinism of derivation ([§24.4](#244-determinism-test-procedure)) |
| S8 | The specification is a **stable, versioned contract** on which an ecosystem of independent validators, planners, mappings, engines, editors, and registries can be built. | Versioning guarantees ([Chapter 10](10-versioning.md)); all five conformance classes |

## 24.2 Conformance Classes

Conformance is claimed per class. An artifact or implementation MUST NOT claim IaP conformance without naming the class (or classes) it conforms to and the specification version it targets, e.g. *"Conforming Validator, IaP 1.0"*. Partial implementations MUST NOT claim conformance.

The five classes are:

1. **Conforming Document** — an `*.iap.yaml` artifact.
2. **Conforming Validator** — a tool that accepts or rejects documents.
3. **Conforming Planner** — a tool that turns a canonical document plus mappings into a provider plan.
4. **Conforming Mapping** — an `*.iap-map.yaml` artifact.
5. **Conforming Engine** — a system that executes provider plans against real infrastructure.

### 24.2.1 Conforming Document

A **Conforming Document** is an IaP document that passes all eight validation phases ([Chapter 8](08-validation.md)) with **no errors**. Warnings (including IAP801 reserved-kind and IAP802 unknown-namespace warnings) do not prevent conformance.

A Conforming Document MUST satisfy all of the following:

1. **CD-1 (Schema).** The document MUST validate against `schema/iap-v1.schema.json` (JSON Schema draft 2020-12), including the `apiVersion: iap.dev/v1` constant, the resource-identifier grammar `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` on all identifier positions, closed kind and enum vocabularies, and `additionalProperties: false` on all core objects.
2. **CD-2 (References).** Every resource identifier referenced anywhere in the document — edge targets, `outputs[].resource`, `Application` `spec.components`, `Gateway` `spec.tls.certificate`, profile `extends` — MUST resolve within the profile-merged document (no IAP2xx errors).
3. **CD-3 (Relationships).** Every canonical edge MUST satisfy the verb/target-kind constraints and per-verb attribute rules of [Chapter 4](04-relationship-model.md) (no IAP3xx errors).
4. **CD-4 (Ordering).** The derived ordering graph ([Chapter 9](09-dependency-model.md)) MUST be acyclic, and every rule-edge selector MUST match at least one resource (no IAP4xx errors).
5. **CD-5 (Policy).** No policy with effect `deny` or `require` may be violated in the profile-merged document (no IAP5xx errors).
6. **CD-6 (Security).** The document MUST satisfy the structural security requirements of [Chapter 15](15-security-model.md) (no IAP6xx errors) — for example, secret values never appear in the document.
7. **CD-7 (Compliance).** If `compliance.frameworks` is declared, every activated framework policy bundle MUST hold ([Chapter 17](17-compliance-model.md)) (no IAP7xx errors).
8. **CD-8 (Versioning and extensions).** The document MUST NOT violate the Extension Non-Interference Rule (IAP803): deleting every `extensions` block MUST yield a document that is itself conforming with identical core semantics ([Chapter 11](11-extension-framework.md)).
9. **CD-9 (Profiles).** For **every** profile declared in the document, the profile-merged result MUST itself satisfy CD-1 through CD-8. A document with a profile that merges into an invalid document is not conforming, even if the unmerged base is valid.
10. **CD-10 (Banned terms).** No banned provider term ([§24.3](#243-banned-provider-terms)) may appear in a core field position.

### 24.2.2 Conforming Validator

A **Conforming Validator** decides document conformance and reports findings.

1. **CV-1 (All eight phases).** The validator MUST implement all eight validation phases of [Chapter 8](08-validation.md) in order: schema → reference → relationship → dependency/cycle → policy → security → compliance → versioning/extension. Implementing schema validation alone is not conformance.
2. **CV-2 (Collect-all).** The validator MUST NOT stop at the first finding. Within a phase it MUST report every finding; across phases it MUST continue as far as results remain meaningful. If phase 1 (schema) produces errors, later phases MAY be skipped, since their inputs are not well-formed; if phase 1 passes, all remaining phases MUST run.
3. **CV-3 (Finding shape).** Every finding MUST carry: an error code from the taxonomy ([§24.2.6](#2426-error-code-taxonomy-summary)), a severity (`error` or `warning`), a document path to the offending element, and a human-readable message. Cycle findings (IAP401) MUST include the full cycle path; dangling references (IAP201–IAP204) MUST name the unresolved identifier.
4. **CV-4 (Errors vs. warnings).** Errors fail validation; warnings never do. The validator MUST emit the normative warnings of [Chapter 10](10-versioning.md): IAP801 (reserved kind), IAP802 (unknown extension namespace), IAP804 (newer-minor construct), IAP805 (deprecated element). Silent acceptance of any of these conditions is a conformance failure.
5. **CV-5 (Profile awareness).** Semantic phases (2–8) MUST evaluate the **profile-merged** document, and the validator MUST be able to validate every declared profile (CD-9).
6. **CV-6 (Annotation vocabulary).** The validator MUST register the `x-iap-*` annotation vocabulary used throughout the schema — `x-iap-since`, `x-iap-deprecated`, `x-iap-capability`, `x-iap-reserved`, `x-iap-presence-semantic`, `x-iap-default-when` — as known, non-validating annotation keywords, and MUST surface `x-iap-deprecated` as IAP805 warnings. **Note:** these are custom annotations, not standard JSON Schema keywords; a validator built on a generic JSON Schema library MUST configure that library to be annotation-tolerant rather than strict (for Ajv, `strict: false` or explicit `keywords` registration — the strict default rejects the schema itself).
7. **CV-7 (Determinism).** Validation is a pure function of the document: the same document MUST produce the identical finding set (same codes, paths, and severities) on every run, on every machine. Finding order in output MUST be deterministic (document order, then code).
8. **CV-8 (Suite).** The validator MUST pass the conformance test suite ([§24.5](#245-the-conformance-test-suite)): accept every `cases/valid/*` document, and for every `cases/invalid/*` document either reject it (schema-invalid cases) or report the expected semantic error code.

### 24.2.3 Conforming Planner

A **Conforming Planner** computes a provider plan from intent.

1. **CP-1 (Pure function).** The plan MUST be a pure function of exactly three inputs: the canonical document ([Chapter 1 §1.5](01-architecture.md#15-canonical-form)) with its active profile merged, the infrastructure model state ([Chapter 13](13-infrastructure-model.md)), and the mapping artifacts. No other input may influence the plan: no wall-clock time, no random values, no environment variables, no network calls, no locale, no filesystem layout, and **no model inference**.
2. **CP-2 (Canonical plan).** The emitted plan MUST have a canonical serialization: UTF-8, keys sorted lexicographically by Unicode code point, deterministic collection ordering (waves ordered by dependency rank, entries within a wave sorted by resource identifier).
3. **CP-3 (Byte-identical replay).** Given byte-identical inputs, two plan runs MUST produce byte-identical canonical plans. Conformance is verified by **double-run hash equality**: the procedure of [§24.4](#244-determinism-test-procedure).
4. **CP-4 (Fail-closed inputs).** The planner MUST refuse to plan a document that is not a Conforming Document, and MUST reject (never silently drop) any kind, field, value, or relationship outside the coverage matrix declared by the mapping ([Chapter 12](12-provider-mapping.md)).
5. **CP-5 (No hidden ordering decisions).** Execution ordering MUST derive solely from the ordering graph of [Chapter 9](09-dependency-model.md). Documents contain no execution order; planners MUST NOT accept ordering hints from any other source.

### 24.2.4 Conforming Mapping

A **Conforming Mapping** is an `*.iap-map.yaml` artifact realizing IaP intent for one provider namespace.

1. **CM-1 (Schema).** The artifact MUST validate against `schema/iap-mapping-v1.schema.json`, declare `apiVersion: mapping.iap.dev/v1`, its own semver `version`, and a `specCompat` range naming the IaP versions it supports.
2. **CM-2 (Fail-closed coverage).** The `supports` matrix MUST enumerate every kind, field path, and (where constrained) field value the mapping can realize. A document using anything outside the matrix MUST be rejected by the mapping step — silent dropping or best-effort approximation is a conformance failure.
3. **CM-3 (Total derive maps).** Every `derive` entry with a value `map` MUST cover **all** supported values of its source field, so no input within the declared coverage can reach an undefined lookup.
4. **CM-4 (Output binding).** The mapping MUST bind **every** abstract output attribute the core specification declares for each supported kind (`endpoint`, `connectionSecret`, `identifier`, …) to a provider plan attribute. An unbound abstract attribute is a conformance failure, because it breaks the `outputs` contract of consuming documents.
5. **CM-5 (Capability assertions).** The mapping MUST honor the semantic floor of every intent value it claims to support: `availability: high` MUST realize a topology meeting the ≥ 99.95% SLO floor, `encryption.atRest: required` MUST produce encrypted storage, `exposure: private` MUST NOT produce an internet-reachable endpoint. A mapping that accepts a value but realizes something weaker is non-conforming even though its output is well-formed.
6. **CM-6 (Purity and non-interference).** Realization MUST be deterministic (constants and value maps only — no lookups performed at mapping time) and MUST NOT alter core semantics; mappings refine *how*, never *what*.

### 24.2.5 Conforming Engine

A **Conforming Engine** executes provider plans. It sits entirely to the right of the layer boundary ([Chapter 1 §1.4](01-architecture.md)).

1. **CE-1 (Plan-only execution).** The engine MUST execute exactly the approved canonical plan — no additions, substitutions, or reordering. The engine MUST NOT invoke model inference for any purpose (S5).
2. **CE-2 (Zero-trust enforcement).** The engine MUST realize default-deny network posture: only connectivity implied by declared edges (`connectsTo`, `routesTo`, `publishesTo`, `consumesFrom`, `replicatesTo`) and declared `exposure` values may be reachable. Undeclared reachability is a conformance failure even when the provider's own default would permit it.
3. **CE-3 (Least-privilege derivation).** Grants MUST derive solely from relationship `access` attributes and verb semantics ([Chapter 15](15-security-model.md)). The engine MUST NOT provision any credential or permission broader than the derived set — in particular, no wildcard or administrative grant may result from an edge whose `access` is `read`, `write`, or `read-write`.
4. **CE-4 (Halt-wave failure semantics).** Plans execute in dependency-ordered waves ([Chapter 14](14-planning-model.md)). When any operation in a wave fails: operations already in flight in the **same** wave run to completion; **no subsequent wave starts**; the engine records the exact partial state in the infrastructure model ([Chapter 13](13-infrastructure-model.md)) and reports which operations succeeded, failed, and were never started. The engine MUST NOT continue past a failed wave and MUST NOT perform automatic destructive rollback unless the plan itself contains an approved rollback program.
5. **CE-5 (Idempotent convergence).** Re-executing a plan whose operations already hold MUST be a no-op, enabling safe resume after a halted wave.
6. **CE-6 (Secret hygiene).** Secret values MUST flow only between the engine and the provider's secret facility; they MUST never be written into plans, logs, the infrastructure model, or IaP documents.

### 24.2.6 Error Code Taxonomy Summary

Error codes are assigned by validation phase; the full registry is maintained in [Chapter 8](08-validation.md). The range-to-phase mapping below is normative, as are the individually listed codes fixed elsewhere in this specification.

| Range | Phase | Fixed codes |
|---|---|---|
| IAP1xx | 1 — Schema | IAP101 schema constraint violation; IAP102 unknown kind; IAP103 invalid value; IAP104 conflicting or inert field combination; IAP105 provider term in a core field ([§24.3](#243-banned-provider-terms)) |
| IAP2xx | 2 — Reference resolution | IAP201 dangling edge target; IAP202 dangling component; IAP203 dangling output; IAP204 dangling certificate; IAP205 profile reference error |
| IAP3xx | 3 — Relationship | IAP301 invalid verb/target-kind; IAP302 invalid edge attribute for verb; IAP303 advisory relationship finding (warning) ([Chapter 4](04-relationship-model.md)) |
| IAP4xx | 4 — Dependency and cycle | IAP401 ordering cycle; IAP402 unresolvable rule-edge selector ([Chapter 9](09-dependency-model.md), [Chapter 4](04-relationship-model.md)) |
| IAP5xx | 5 — Policy | — |
| IAP6xx | 6 — Security | — |
| IAP7xx | 7 — Compliance | — |
| IAP8xx | 8 — Versioning and extension | IAP801 reserved kind (warning); IAP802 unknown extension namespace (warning); IAP803 non-interference violation (error); IAP804 newer-minor construct (warning); IAP805 deprecated element (warning) ([Chapter 10](10-versioning.md)) |

A dangling edge target is a phase 2 reference error (IAP201): the identifier does not resolve in the profile-merged document. Phase 3 evaluates verb and attribute rules only for edges whose targets resolved, so each defect is reported exactly once.

## 24.3 Banned Provider Terms

Provider vocabulary in core fields defeats criterion S1 and silently couples documents to one provider. The following list is **normative and lintable**: these terms MUST NOT appear in core field positions of an IaP document, and MUST NOT appear in the normative text of Chapters 1–11 and 13–24 of this specification outside this section.

**Scope.** The prohibition applies to core document positions: resource identifiers, `kind` values, field names, label keys and values, enum and string field values, relationship attributes, policy fields, and output attributes. The following positions are **exempt**, because they legitimately carry foreign or free text: everything under any `extensions.<namespace>` block, all `x-*` annotation keys and values, `description` fields, `metadata.annotations`, and `artifact.reference` (an image or repository location is an address, not intent). Chapter 12 mapping tables and mapping artifacts are exempt by nature — naming provider resources is their job.

**Matching rule.** Matching is case-insensitive on whole tokens, where tokens are delimited by any non-alphanumeric character or string boundary (`vpc` matches `vpc` and `my-vpc-id`, not `vpcx`).

| Provider family | Banned terms |
|---|---|
| Networking | `vpc`, `vnet`, `subnet`, `security-group`, `nsg`, `route-table`, `internet-gateway`, `nat-gateway`, `elb`, `alb`, `nlb`, `cloudfront`, `route53` |
| Compute | `ec2`, `ecs`, `eks`, `fargate`, `aks`, `gke`, `gce`, `app-service`, `cloud-run`, `app-engine` |
| Data | `rds`, `aurora`, `dynamodb`, `redshift`, `elasticache`, `cosmosdb`, `cloud-sql`, `bigquery`, `spanner`, `firestore`, `memorystore` |
| Storage | `s3`, `ebs`, `efs`, `blob-storage`, `gcs` |
| Messaging | `sqs`, `sns`, `kinesis`, `eventbridge`, `event-hub`, `service-bus`, `pubsub` |
| Security and identity | `iam`, `kms`, `key-vault`, `secrets-manager`, `cloud-kms` |
| Observability | `cloudwatch`, `stackdriver`, `app-insights` |

A validator MUST report a banned term in a core position as **IAP105** (error). The closed schema already rejects most such attempts structurally (unknown kinds fail the kind enum; unknown fields fail `additionalProperties: false`); IAP105 additionally catches banned terms smuggled through free-string core positions such as label values. This list is versioned with the specification; additions arrive in minor releases and are, per [Chapter 10](10-versioning.md), strictly additive.

The correct home for provider vocabulary is a namespaced `extensions` block or a mapping artifact — never a core field.

## 24.4 Determinism Test Procedure

This procedure verifies CP-3 and, by extension, criterion S4. It applies to planners and to every deterministic deriver (diagram, cost, security, and compliance generators, per S7 — substitute "derived artifact" for "plan").

1. **Fix inputs.** Select a Conforming Document, an active profile, an infrastructure model state snapshot, and a set of Conforming Mappings. Compute the canonical form of the document ([Chapter 1 §1.5](01-architecture.md#15-canonical-form), steps C1–C5) and record `SHA-256(canonical document)`.
2. **Run A.** Execute the planner on the fixed inputs. Record `hashA = SHA-256(canonical plan A)`.
3. **Perturb the environment, not the inputs.** Before the second run, change everything a pure function must ignore: a different working directory, different wall-clock time, different `TZ` and locale, different environment variables, a different machine or OS where available, and network access **disabled**.
4. **Run B.** Execute the planner again on byte-identical inputs. Record `hashB`.
5. **Assert.** The test passes if and only if `hashA == hashB`. Any divergence — including ordering, whitespace, or timestamp divergence — is a conformance failure; there is no tolerance band, because the plan hash is the review and audit primitive (S3).
6. **Idempotence check (planners).** Apply plan A to the model state, re-plan against the updated state, and assert the resulting plan is empty. A non-empty plan indicates the planner and engine disagree about convergence (CE-5).

The network-disabled run in step 3 doubles as the mapping-purity check (CM-6): a planner or mapping that fails only when the network is unavailable was performing ambient lookups.

## 24.5 The Conformance Test Suite

The repository ships a machine-runnable suite under [`conformance/`](../conformance/README.md):

```
conformance/
├── README.md            # how to run the suite
└── cases/
    ├── valid/           # documents that MUST pass all validation a tool implements
    └── invalid/         # documents that MUST fail, each annotated with its expectation
```

- Every document in `cases/valid/` MUST pass schema validation, and MUST pass all eight phases in a full validator. The example documents in [`examples/`](../examples/) are additionally part of the valid corpus by reference.
- Every document in `cases/invalid/` carries a machine-readable comment header: `# expected: schema-invalid` cases MUST be rejected by schema validation alone; `# expected: IaP<code>` cases are **schema-valid by design** and MUST be rejected by a full validator with the named code — a tool that only performs schema validation MUST find these documents valid, which is precisely why schema validation alone does not constitute a Conforming Validator (CV-1).

Run instructions, including the exact `ajv` invocation and the YAML-to-JSON conversion step, are maintained in [`conformance/README.md`](../conformance/README.md). A Conforming Validator MUST pass the entire suite (CV-8); implementers SHOULD wire the suite into continuous integration so that schema and case files can never drift apart.
