# 2. Document Layout

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter defines the normative structure of an IaP document: its serialization, its top-level keys, the shape of a resource entry, the identifier grammar, and the conventions used throughout this specification. Every other chapter builds on the definitions given here. The machine-readable expression of this chapter is [`schema/iap-v1.schema.json`](../schema/iap-v1.schema.json); where prose and schema disagree, the schema governs for structural questions and the prose governs for semantic ones.

## 2.1 Conventions and Terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this specification are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals.

Additional terms used throughout the specification:

| Term | Definition |
|---|---|
| **Document** | A single IaP file describing the intended infrastructure for one system. |
| **Resource** | One entry in the `resources` map: a unit of infrastructure intent with a kind, a spec, and relationships. |
| **Kind** | The typed classification of a resource (e.g. `Service`, `Database`). Kinds are PascalCase. |
| **Capability family** | A documentation/taxonomy grouping of kinds (e.g. compute, messaging). Families never appear in document structure ([Chapter 5](05-capability-model.md)). |
| **Edge** | A normalized relationship tuple `(source, type, target, attributes)` ([Chapter 4](04-relationship-model.md)). |
| **Canonical form** | The normative serialization of a document after profile merge and normalization ([Chapter 1](01-architecture.md), §2.7). |
| **Profile** | A named overlay merged into the document at plan time ([Chapter 6](06-profiles.md)). |
| **Mapping** | A separate artifact that deterministically realizes IaP kinds as provider resources ([Chapter 12](12-provider-mapping.md)). |
| **Finding** | A validation result with an `IISnnn` code, severity, and document path ([Chapter 8](08-validation.md)). |

## 2.2 Serialization

An IaP document is a single YAML 1.2 or JSON document. Tools MUST accept both. YAML documents MUST restrict themselves to the JSON data model (no anchors with merge semantics, no language-specific tags, no non-string keys), so that every IaP document has an exact JSON equivalent. The RECOMMENDED file name is `infrastructure.iap.yaml`; the RECOMMENDED extension for any IaP document is `.iap.yaml` (or `.iap.json`).

Documents MUST be UTF-8 encoded. A document is a single YAML stream; multi-document streams (`---` separators) are not valid IaP.

## 2.3 Top-Level Keys

An IaP document is an object with exactly the following keys. Keys marked ✓ are REQUIRED. No other keys are permitted, except keys matching `^x-` (§2.8).

| Key | Req | Type | Purpose | Defined in |
|---|---|---|---|---|
| `apiVersion` | ✓ | string | The IaP group and major version: the literal `iap.dev/v1`. | §2.4 |
| `metadata` | ✓ | object | Document identity: `name` (REQUIRED), `description`, `owner`, `organization`, `labels`, `annotations`. | §2.5 |
| `resources` | ✓ | map | Flat map of resource ID → resource entry. At least one entry. | §2.6, [Ch. 3](03-resource-model.md) |
| `profiles` | | map | Named overlays; environments are profiles. | [Ch. 6](06-profiles.md) |
| `relationships` | | array | Selector-based rule edges only. | [Ch. 4](04-relationship-model.md) |
| `policies` | | array | Declarative governance rules. | [Ch. 7](07-policy-language.md) |
| `compliance` | | object | Framework scope declarations (`frameworks`). | [Ch. 17](17-compliance-model.md) |
| `extensions` | | map | Extension namespace registration and document-level refinements. | [Ch. 11](11-extension-framework.md) |
| `outputs` | | map | Named exports of abstract resource attributes. | §2.9 |

There are deliberately no top-level sections per capability (`compute:`, `database:`, …), no `environment` key (environments are profiles), no `organization` key (part of `metadata`), no `applications` key (`kind: Application` resources), and no `dependencies` key (dependencies are derived from relationships — [Chapter 9](09-dependency-model.md)).

## 2.4 `apiVersion`

The `apiVersion` value is the literal string `iap.dev/v1`. It pins the document to a major version of this specification. Minor and patch revisions of the specification are strictly additive and are never encoded in documents; the versioning rules are defined in [Chapter 10](10-versioning.md).

A document whose `apiVersion` is unrecognized MUST be rejected (IAP101). A validator built for `iap.dev/v1` MUST accept every syntactically valid `iap.dev/v1` document produced under any 1.x minor, emitting IAP804 warnings for fields introduced in minors newer than the validator.

## 2.5 `metadata`

```yaml
metadata:
  name: order-platform          # REQUIRED, identifier grammar (§2.6.1)
  description: Order processing platform
  owner: team-payments
  organization: example-corp
  labels:                        # selectable key/value strings
    costCenter: "cc-142"
  annotations:                   # free-form strings; NEVER semantic
    reviewedBy: "alice"
```

`metadata.name` identifies the document and MUST be unique within the owning organization's document set. `labels` participate in selectors and policies; `annotations` are opaque to all IaP semantics — a conforming tool MUST NOT change any behavior based on an annotation.

## 2.6 The `resources` Map

`resources` is a flat map. There is exactly one uniform resource shape regardless of kind:

```yaml
resources:
  orders-db:                     # the map key IS the resource ID
    kind: Database               # REQUIRED — PascalCase kind discriminator
    description: Primary order store
    labels: { tier: data }
    spec:                        # kind-specific intent fields (Chapter 3)
      class: relational
      engine: postgresql
      availability: high
    relationships:               # inline edges; this resource is the source
      - type: protectedBy
        target: backup-vault
    extensions:                  # namespaced, non-normative refinements
      aws:
        instanceHint: memory-optimized
```

### 2.6.1 Resource identifiers

Resource IDs are the keys of the `resources` map and the only mechanism for referencing a resource. The grammar is the DNS label:

```
^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$
```

IDs are unique per document by construction (map keys). All references — relationship `target`, `Application.spec.components`, `outputs.*.resource`, `Gateway.spec.tls.certificate`, profile override paths — use the plain ID string. A reference to a non-existent ID is a reference error (IAP2xx). Document scope is the document itself; cross-document references are reserved for a future minor (`imports`).

### 2.6.2 Resource entry fields

| Field | Req | Type | Purpose |
|---|---|---|---|
| `kind` | ✓ | string | One of the kinds registered in this specification ([Chapter 3](03-resource-model.md), [Chapter 5](05-capability-model.md)). Unknown kinds are schema errors (IAP102). |
| `description` | | string | Human documentation. |
| `labels` | | map | Selectable key/value strings (selectors, policies, rule edges). |
| `spec` | | object | Kind-specific intent. REQUIRED for kinds with required fields. Validated against the kind's schema; unknown fields are schema errors. |
| `relationships` | | array | Inline edges. The declaring resource is always the source ([Chapter 4](04-relationship-model.md)). |
| `extensions` | | map | Namespaced provider refinements, subject to the Non-Interference Rule ([Chapter 11](11-extension-framework.md)). |

## 2.7 Determinism Requirements

Every field in an IaP document has exactly one meaning, defined by the Field Definition Contract ([Chapter 3](03-resource-model.md), §3.1): definition, type, allowed values, default, since-version, and deprecation status. Defaults are normative: an omitted optional field is semantically identical to writing its default explicitly. Consequently two documents that differ only in the presence of default values are the **same document** in canonical form.

The canonical form (defined normatively in [Chapter 1](01-architecture.md) §1.5) is: UTF-8 JSON, object keys sorted lexicographically, quantities normalized, defaults materialized, the active profile merged, and all relationships flattened to canonical edges. Default materialization follows the precise rules of Chapter 1 §1.5.1 — in particular, presence-semantic constructs (`healthCheck`, `deadLetter`) and arrays are never synthesized, so omitting them is NOT equivalent to writing them. Hashing, diffing, planning, and mapping-determinism checks operate on canonical form only.

## 2.8 `x-` Passthrough

At the document level and the resource-entry level (and within most nested objects), keys matching `^x-` are permitted and carry tool-specific, non-portable annotations. Conforming tools MUST tolerate and preserve unknown `x-` keys and MUST NOT assign them portable semantics. Anything intended to be portable belongs in core fields or in a versioned extension namespace — not in `x-` keys.

## 2.9 `outputs`

Outputs export **abstract attributes** — never provider identifiers:

```yaml
outputs:
  orders-endpoint:
    resource: orders-db
    attribute: endpoint
    description: Connection endpoint for the orders database
```

`attribute` MUST be one of the abstract attributes the referenced resource's kind declares (`identifier` on every provisionable kind; `endpoint` on addressable kinds; `connectionSecret` on authenticated kinds; kind-specific extras per [Chapter 3](03-resource-model.md)). Binding abstract attributes to concrete values is exclusively a mapping concern ([Chapter 12](12-provider-mapping.md)).

## 2.10 Complete Minimal Example

```yaml
apiVersion: iap.dev/v1
metadata:
  name: hello-web
  owner: team-web
resources:
  web:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/hello:1.4.2
      exposure: internal
  edge:
    kind: Gateway
    spec:
      domains: [hello.example.com]
    relationships:
      - type: routesTo
        target: web
        protocol: https
outputs:
  url:
    resource: edge
    attribute: endpoint
```

This document is fully deterministic: every omitted field has a normative default (`web` resolves to `size: m`, `availability: standard`, encryption `required`/`required`; `edge` resolves to `exposure: public`, TLS minimum `1.2`), and a conforming planner derives the single ordering edge `edge → web` (`routesTo` implies target-before-source) without any execution order being written down.
