# 1. Architecture

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter defines the architectural foundations of the Infrastructure as Prompt (IaP): the philosophy that motivates it, the five design principles every other chapter derives from, the layer boundary that separates intent from execution, and the canonical form that makes IaP documents deterministic inputs to tooling. It also positions IaP against existing infrastructure tools. Except for [§1.7](#17-comparison-with-existing-tools-non-normative), which is explicitly comparative and non-normative, this chapter is normative.

## 1.1 Purpose

IaP is an open, cloud-agnostic contract for describing **what infrastructure should exist** — never how any provider implements it. An IaP document is a declaration of intent: "a relational database with high availability, encrypted, reachable only by the services that declare a connection to it." It is not a recipe of provider resources, not a program, and not a state file.

The relationship of IaP to infrastructure is intended to mirror the relationship of OpenAPI to HTTP APIs:

- **OpenAPI** describes an API's contract; any server framework may implement it and any client generator may consume it.
- **IaP** describes infrastructure's contract; any execution engine — targeting any cloud, a Kubernetes cluster, or an on-premises platform — MAY consume it and MUST produce an equivalent outcome, as defined by the conformance classes in [Chapter 24](24-conformance.md).

IaP exists because the current landscape forces a choice between three unsatisfactory positions:

1. **Provider-coupled declarations** (infrastructure-as-code with provider resource types) lock the description of a system to one vendor's nouns. Moving clouds means rewriting, not remapping.
2. **General-purpose programs** that generate infrastructure are expressive but non-inert: understanding what will exist requires executing code, and two runs are not guaranteed to describe the same system.
3. **Platform-internal APIs** describe desired state only for their own substrate and cannot express intent about anything outside it.

None of these yields an artifact that is simultaneously portable, deterministic, machine-verifiable, and safe for both humans and AI systems to author. IaP is designed to be exactly that artifact.

## 1.2 Design Principles

Every normative rule in this specification traces to one of five principles. When chapters conflict in interpretation, these principles govern.

### 1.2.1 Intent over implementation

An IaP document declares outcomes, not mechanisms. Fields express measurable or semantic intent — `availability: high` is defined as an SLO floor (≥ 99.95%), not as a topology instruction ([Chapter 3](03-resource-model.md)). Provider nouns MUST NOT appear in core document content; they are confined to namespaced `extensions:` blocks and to provider-mapping artifacts ([Chapter 11](11-extension-framework.md), [Chapter 12](12-provider-mapping.md)). A lintable list of banned provider terms is published in [Chapter 24](24-conformance.md); a conformant validator MUST reject documents that place such terms in core fields.

### 1.2.2 Determinism

Every transformation to the right of the intent document is a pure function. Given the same canonical document ([§1.5](#15-canonical-form)), the same active profile, and the same mapping artifacts, a conformant implementation MUST produce byte-identical normalized graphs and provider plans. There is no ambient lookup, no wall-clock dependence, no network call, and no model inference anywhere in the validation, planning, or mapping pipeline. Policies are structural condition trees with a closed operator set — no embedded expression language exists in v1 ([Chapter 7](07-policy-language.md)) — precisely so that policy evaluation is deterministic by construction.

### 1.2.3 Human readability

IaP documents are YAML (or JSON) data that a reviewer can read top-to-bottom without executing anything. Vocabulary is small and portable: t-shirt sizes where relative capacity is the intent, exact Kubernetes-style quantities where the number *is* the intent (`capacity.storage: 100Gi`, `recoveryPointObjective: 1h`). Defaults are safe: omission never weakens security posture — `encryption.atRest` and `encryption.inTransit` default to `required`, and `exposure` defaults to `private`.

### 1.2.4 Cloud agnosticism

The core vocabulary describes capabilities every substrate can supply ([Chapter 5](05-capability-model.md)). Where the industry has converged on open dialects, IaP names the dialect (`postgresql`, `redis-compatible`), never a provider product. A document that validates against the core schema carries no information that binds it to any provider; binding happens exclusively in mapping artifacts that are versioned and distributed separately ([Chapter 12](12-provider-mapping.md)).

### 1.2.5 Extensibility

Providers, platforms, and organizations extend IaP through namespaced `extensions:` blocks and independently versioned extension packages. The **Extension Non-Interference Rule** is normative: deleting every `extensions` block from a valid document MUST yield a valid document with identical core semantics. Unknown extension namespaces produce warnings, never failures ([Chapter 11](11-extension-framework.md)). The specification itself evolves additively: documents pin the major version only (`apiVersion: iap.dev/v1`), and minor revisions are strictly additive ([Chapter 10](10-versioning.md)).

## 1.3 The Four Layers

IaP defines four artifacts, each derived from the previous by a pure function:

```
┌───────────────────┐    ┌────────────────────┐    ┌─────────────────┐    ┌───────────────┐
│  Intent document  │───▶│  Normalized graph  │───▶│  Provider plan  │───▶│   Execution   │
│   (*.iap.yaml)    │    │  (canonical form,  │    │  (via mapping   │    │  (engine acts │
│                   │    │   edges resolved)  │    │    artifacts)   │    │  on the plan) │
└───────────────────┘    └────────────────────┘    └─────────────────┘    └───────────────┘
        ▲
        │  authoring boundary — humans and AI systems operate here, and only here
```

1. **Intent document** — the YAML/JSON source authored by humans or generated by AI tooling. The only mutable, creative artifact.
2. **Normalized graph** — the canonical form of the document with the active profile merged and all relationships flattened to canonical edges ([Chapter 4](04-relationship-model.md), [Chapter 9](09-dependency-model.md)).
3. **Provider plan** — the output of applying one or more mapping artifacts to the normalized graph ([Chapter 12](12-provider-mapping.md)).
4. **Execution** — an engine acting on the provider plan against a real substrate ([Chapter 14](14-planning-model.md)).

## 1.4 The Layer Boundary Invariant

The following invariant is normative and is cited throughout this specification:

> **Layer Boundary Invariant.** AI systems MAY generate, validate, suggest, explain, and document intent documents. Everything to the right of the intent document — normalization, validation, policy evaluation, planning, mapping, and execution — MUST be performed exclusively by deterministic tooling. No AI inference may participate in, influence, or substitute for any transformation in layers 2 through 4.

Consequences:

- A conformant implementation MUST be able to reproduce any normalized graph, plan, or diagram from the intent document alone, with no record of how the document was authored.
- Review and approval workflows attach to the intent document, because it is the single artifact whose content determines all downstream behavior.
- An AI assistant that proposes a change produces a *document diff*; it never produces a plan, and it never executes. The full division of responsibilities is specified in [Chapter 19](19-ai-guidelines.md).

## 1.5 Canonical Form

Many operations — content hashing, diffing, plan caching, and the mapping determinism checks in [Chapter 24](24-conformance.md) — require a single unambiguous byte representation of a document. This section defines it.

The **canonical form** of an IaP document, relative to exactly one active profile, is produced by applying the following steps in order:

1. **C1 — Parse.** Parse the source (YAML 1.2 or JSON) into a data tree. Comments and formatting are discarded; `x-` prefixed keys are data and are retained.
2. **C2 — Profile merge.** Apply the active profile as an RFC 7386 JSON Merge Patch, in order: base document, then each profile in the `extends` chain from root to leaf, then the selected profile ([Chapter 6](06-profiles.md)). Remove the `profiles` key from the result. The merged result MUST itself be a valid IaP document.
3. **C3 — Relationship flattening.** Convert every inline relationship and every selector-based rule edge into the canonical edge model `(source, type, target, attributes)` ([Chapter 4](04-relationship-model.md)). Rule-edge selectors are resolved against the merged resource set; the resulting edge list replaces both inline `relationships` arrays and the top-level `relationships` key. Duplicate edges (identical source, type, target, and attributes) collapse to one.
4. **C4 — Value normalization.** Materialize specification defaults (§1.5.1), then rewrite every quantity and duration to its canonical spelling (§1.5.2).
5. **C5 — Key ordering.** Sort all object keys lexicographically by Unicode code point. Canonical edges are sorted by `(source, type, target)`, then by serialized attributes.
6. **C6 — Serialization.** Serialize as UTF-8 JSON without a byte-order mark, with no insignificant whitespace, using the shortest round-trip representation for numbers.

Two documents are **semantically identical** if and only if their canonical forms are byte-identical. Implementations MUST use the canonical form — never the authored source — as the input to hashing, diffing, planning, and provider mapping.

### 1.5.1 Default materialization

Because an omitted optional field is semantically identical to writing its default explicitly ([Chapter 2](02-document-layout.md) §2.7), the canonical form materializes defaults so that the two spellings converge. Materialization is applied after C2 (so profile-supplied values win over defaults) and follows exactly these rules:

1. **Scalar defaults.** Every absent optional field whose schema declares a `default`, and whose parent object is present, is written with its default value. A resource's absent `spec` counts as a present empty object for this purpose (a `Queue` with no `spec` canonicalizes to all Queue defaults).
2. **Object materialization.** An absent optional object that has at least one member with a schema default — and is not presence-semantic (rule 4) — is materialized as an object containing exactly its defaulted members, recursively. Members without defaults remain absent. Example: an absent `encryption` block materializes as `{"atRest": "required", "inTransit": "required"}`.
3. **Arrays are never materialized.** An absent array (`ports`, `domains`, `lifecycle`, `relationships`, `policies`) stays absent; an empty array is distinct from an absent one and is preserved.
4. **Presence-semantic constructs are never materialized.** For some constructs, presence itself carries intent: writing them requests a behavior that omission does not. These MUST NOT be synthesized by canonicalization. In v1 the presence-semantic constructs are `Service.spec.healthCheck` and `Queue.spec.deadLetter` (marked `x-iap-presence-semantic` in the schema). When such a construct IS present, rule 1 still materializes its member defaults.
5. **Conditional defaults.** A default declared as conditional on a sibling value materializes only while the condition holds. In v1: `deadLetter.maxReceives` (default `5`) applies only when `deadLetter.enabled` is `true` — an authored `maxReceives` alongside `enabled: false` remains an IAP104 error ([Chapter 8](08-validation.md)); materialization never produces that combination.
6. **Per-kind defaults.** Where the specification assigns kind-specific defaults to a shared vocabulary block (e.g. `resilience.backup`: `required` for `Database` and `Volume`, `preferred` for `ObjectStore` — [Chapter 3](03-resource-model.md) §3.2), the kind's value is the default that materializes.
7. **Extensions and `x-` keys** carry no specification defaults and are never altered by materialization.

### 1.5.2 Quantity and duration normalization

Quantities (grammar `^[0-9]+(\.[0-9]+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$`) denote exact rational values: the mantissa multiplied by the suffix multiplier, where `m` = 10⁻³, no suffix = 1, `k` = 10³, `M` = 10⁶, `G` = 10⁹, `T` = 10¹², `Ki` = 2¹⁰, `Mi` = 2²⁰, `Gi` = 2³⁰, `Ti` = 2⁴⁰. Two quantities are **equal** if and only if their exact values are equal. The canonical spelling is a pure function of the value:

1. Compute the exact rational value `v` (implementations MUST NOT use binary floating point).
2. If `v` is not an integer multiple of 10⁻³, the quantity is invalid (**IAP103**): precision finer than `m` is not representable.
3. If `v` is zero, emit `0`.
4. If `v` is a positive integer: emit `v/S` followed by suffix `S`, where `S` is the first of `Ti`, `Gi`, `Mi`, `Ki`, `T`, `G`, `M`, `k` that divides `v` exactly; if none divides, emit the bare integer.
5. Otherwise (fractional multiple of 10⁻³): emit `v × 1000` followed by `m`.

Examples: `1024Mi` → `1Gi` · `0.5Gi` → `512Mi` · `1000000` → `1M` · `0.5` → `500m` · `2000m` → `2` · `1536Mi` → `1536Mi` · `1.5m` → invalid (IAP103).

Durations (grammar `^[0-9]+(ms|s|m|h|d)$`) canonicalize to the largest unit that represents the value as an integer: `60s` → `1m`, `1440m` → `1d`, `90m` → `90m`, `1000ms` → `1s`. Duration equality is equality of the underlying value.

## 1.6 A Motivating Example

The following two fragments describe "a production-grade relational database." The first is a valid IaP resource; the second is the anti-pattern IaP exists to eliminate.

**Conformant — intent:**

```yaml
apiVersion: iap.dev/v1
metadata:
  name: orders
resources:
  orders-db:
    kind: Database
    spec:
      class: relational
      engine: postgresql
      engineVersion: "16"
      availability: high          # SLO floor >= 99.95%
      exposure: private           # reachable only via declared connectsTo edges
      capacity:
        storage: 100Gi
      resilience:
        backup: required
        recoveryPointObjective: 1h
    extensions:
      aws:                        # non-normative refinement; deleting this block
        instanceClass: db.r6g.large   # changes nothing about core semantics
```

**Non-conformant — provider implementation masquerading as intent:**

```yaml
resources:
  orders-db:
    kind: Database
    spec:
      class: relational
      engine: aurora-postgresql   # provider product name — schema violation (IAP1xx)
      instanceType: db.r6g.large  # provider sizing noun in core — rejected
      multiAz: true               # topology mechanism, not an availability outcome
      subnetIds: [subnet-0a1b2c]  # provider identifier — rejected
```

The first document can be mapped to any substrate that supplies a PostgreSQL-compatible database meeting the declared SLO, encryption, and recovery intent. The second document is not portable, not verifiable against intent, and encodes decisions (`multiAz`) that belong to a mapping, not to the author.

## 1.7 Comparison with Existing Tools (non-normative)

This section is informative. It names specific products and provider technologies solely to contrast them with IaP; such names remain prohibited in normative content.

### 1.7.1 Differences from Terraform

Terraform declarations are written at the **resource level of a specific provider**: an author writes `aws_db_instance` or `google_sql_database_instance`, choosing the vendor at authoring time. The provider schema is the vocabulary, so portability requires rewriting. Terraform's execution model also couples description to state: `plan` output depends on a mutable state file and live provider APIs, making the plan a function of ambient conditions rather than of the document alone.

IaP operates one level higher. The document names capabilities (`Database`, `Queue`), the mapping artifact — a separate, versioned file — chooses provider resources, and planning is a pure function of the canonical document and the mapping. Where Terraform answers "which provider resources do I manage?", IaP answers "what must exist?" — and delegates the former question entirely to [Chapter 12](12-provider-mapping.md) mappings. State and drift are handled by a separate infrastructure model ([Chapter 13](13-infrastructure-model.md)) that never leaks into the intent document.

### 1.7.2 Differences from Kubernetes YAML

Kubernetes manifests describe the desired state of **Kubernetes objects only** — Deployments, Services, ConfigMaps — for a cluster that already exists. They cannot express intent about a managed database, a DNS zone, or anything outside the cluster API, and their vocabulary (pod specs, label selectors on workloads, container probes) is inherently substrate-specific.

IaP deliberately borrows what Kubernetes got right — `apiVersion`/`kind` conventions, flat named resources, label selectors, declarative reconciliation semantics — but targets **any substrate**. A Kubernetes cluster is one possible mapping target among many: the same `Service` resource that maps to a Deployment on Kubernetes maps to a managed container service elsewhere. Kubernetes YAML is a fine *output* of an IaP mapping; it is not a peer input format.

### 1.7.3 Differences from Pulumi

Pulumi programs are **general-purpose-language code** (TypeScript, Python, Go) whose execution produces resource declarations. This buys abstraction power at the cost of inertness: the artifact under review is a program, its meaning depends on control flow, package versions, and runtime environment, and static analysis cannot in general determine what infrastructure it describes.

IaP documents are **inert data**. There are no conditionals, no loops, no imports, and no runtime — the profile merge (RFC 7386) is the only composition mechanism, and it is a total, deterministic function. What a reviewer reads is exactly what a validator checks and exactly what a planner consumes. Anything a Pulumi program can *compute*, an IaP toolchain must either express as declared data or push into a deterministic mapping.

### 1.7.4 Differences from Crossplane

Crossplane is architecturally the closest system: it also separates an abstract claim from provider composition. But Crossplane **runs inside a Kubernetes control plane** — claims, composite resource definitions, and compositions are all cluster objects, so adopting the abstraction means adopting the substrate. In practice its XRDs and Compositions also live in the same API machinery and are frequently coupled in authorship and lifecycle.

IaP adopts the claim/composition separation (intent documents vs. mapping artifacts, [D7](12-provider-mapping.md)) while removing the control-plane requirement. An IaP document is a file; validation, planning, and mapping are offline pure functions; **no control plane is required** to author, verify, diff, or plan. An execution engine MAY be a control plane — including Crossplane itself, consuming plans produced from IaP documents — but the specification is engine-neutral.

### 1.7.5 Summary

| | Terraform | Kubernetes YAML | Pulumi | Crossplane | IaP |
|---|---|---|---|---|---|
| Abstraction level | Provider resources | Cluster objects | Provider resources (via code) | Abstract claims | Capability intent |
| Artifact | Declarative + state file | Declarative | Program | Cluster objects | Inert data document |
| Provider coupling | At authoring time | Kubernetes only | At authoring time | In compositions, in-cluster | In separate mapping artifacts |
| Deterministic from artifact alone | No (state + live APIs) | Within cluster scope | No (program execution) | No (control-plane state) | Yes (canonical form, pure functions) |
| Control plane required | No | Yes | No | Yes | No |

## 1.8 Reading Guide

Document structure and RFC 2119 conventions are defined in [Chapter 2](02-document-layout.md). The resource vocabulary is specified in [Chapter 3](03-resource-model.md), relationships in [Chapter 4](04-relationship-model.md), and the capability taxonomy in [Chapter 5](05-capability-model.md). Validation phases and the IAP1xx–IAP8xx error-code taxonomy are defined in [Chapter 8](08-validation.md). Conformance requirements, including the determinism tests and the banned provider-term list, are defined in [Chapter 24](24-conformance.md).
