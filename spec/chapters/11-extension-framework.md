# 11. Extension Framework

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

The core specification is deliberately provider-free: no provider noun appears in any kind, field, or enum value ([Chapter 1](01-architecture.md)). Extensions are the sanctioned channel for provider-specific and platform-specific refinement. This chapter defines the namespace grammar, the registration and refinement model, the normative Extension Non-Interference Rule, what extension packages may contribute, and how extensions differ from `x-*` tool annotations. The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in [Chapter 2](02-document-layout.md).

## 11.1 Namespaces

Every extension lives under a namespace matching the grammar:

```
^[a-z][a-z0-9-]*$
```

Namespaces are flat: there is no dotted hierarchy, and structure inside a namespace is the extension package's own concern. The following namespaces are **well-known** — reserved by this specification for the ecosystems they name, so that documents and tooling converge on one spelling:

| Namespace | Ecosystem |
|---|---|
| `aws` | Amazon Web Services |
| `azure` | Microsoft Azure |
| `gcp` | Google Cloud Platform |
| `kubernetes` | Kubernetes and its distributions |
| `cloudflare` | Cloudflare |
| `onprem` | On-premises / self-managed infrastructure |

Publishers of other extensions SHOULD choose a namespace matching their product or organization name and MUST NOT squat on a well-known namespace.

## 11.2 Registration and Refinement

Extensions appear at exactly two levels of an IaP document, with distinct roles:

- **Document level — registration.** The top-level `extensions` map registers each namespace used anywhere in the document and pins its package version: `extensions.<ns>.version` is a full semver ([Chapter 10](10-versioning.md)). Document-level entries MAY also carry namespace-wide settings defined by the package.
- **Resource level — refinement.** A resource's `extensions.<ns>` block refines how *that resource* is realized by that ecosystem. Resource-level blocks MUST NOT declare `version`; the document-level registration governs.

A document that uses `extensions.<ns>` on any resource SHOULD register `<ns>` at document level. Tools that resolve extension packages (to obtain sub-schemas, mappings, or validation rules) MUST resolve the registered version and MUST NOT substitute a different version silently.

### Example

The following document is valid against [`iap-v1.schema.json`](../schema/iap-v1.schema.json). The `orders-db` resource carries an `extensions.aws` refinement; note that deleting both `extensions` blocks leaves a document that is equally valid and means exactly the same thing — a relational PostgreSQL database with high availability, reachable read-write from `orders-api`:

```yaml
apiVersion: iap.dev/v1
metadata:
  name: orders-platform
  owner: commerce-platform

extensions:
  aws:
    version: 1.4.0

resources:
  orders-db:
    kind: Database
    spec:
      class: relational
      engine: postgresql
      engineVersion: "16"
      availability: high
    extensions:
      aws:
        database:
          instanceFamily: memory-optimized
          performanceInsights: enabled

  orders-api:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/orders/api:1.8.2
      exposure: internal
    relationships:
      - type: connectsTo
        target: orders-db
        port: 5432
        protocol: tcp
        access: read-write
```

The `aws` block narrows *how* the intent is realized on one provider (a memory-optimized instance family, enhanced performance telemetry). It does not — and under §11.3 cannot — create the database, satisfy a policy, or alter what the core document asserts.

## 11.3 The Extension Non-Interference Rule

This rule is normative and is the foundation of IaP portability:

> **Deleting every `extensions` block from a valid IaP document MUST yield a valid IaP document with identical core semantics.**

Equivalently: extensions may only **refine provider realization**. Concretely, an extension (its content in a document, its sub-schema, or its validation rules) MUST NOT:

- satisfy a core requirement — a required field, a policy, a compliance control, or a validation phase of [Chapter 8](08-validation.md) can never pass *because of* extension content;
- alter core validation outcomes — a document invalid without its extensions is invalid with them, and vice versa;
- add, remove, or retarget relationships, or introduce relationship verbs (the verb set is closed per [Chapter 10](10-versioning.md));
- change, shadow, or reinterpret any intent field — no extension may override `spec.availability`, weaken `encryption`, widen `exposure`, or supply a different default for a core field;
- affect the canonical form, the normalized graph, the dependency order, or the diagram derivation of the core document.

Any violation is error **IAP803** (non-interference violation). Validators enforce the rule mechanically where possible — the *deletion test* (validate the document, delete all `extensions` blocks, validate again, compare outcomes and canonical core semantics) is a required conformance case in [Chapter 24](24-conformance.md) — and extension packages are reviewed against the behavioral clauses when registered with tooling.

The rule cuts in both directions deliberately: providers get an unbounded refinement surface, and consumers get a guarantee that reading only the core document tells them everything the infrastructure *means*.

## 11.4 Unknown Namespaces

A namespace not known to the processing tool (unregistered, unresolvable, or simply unrecognized) produces warning **IAP802** — never an error. Unknown extension content MUST be preserved verbatim through parsing, canonicalization, profile merging ([Chapter 6](06-profiles.md)), and re-serialization. Because of §11.3, a tool that ignores an extension entirely still processes the document correctly; it merely cannot apply that ecosystem's refinements. Failing a document for carrying an unknown namespace is a conformance failure.

## 11.5 What Extension Packages Contribute

An extension package is the versioned artifact behind a namespace. It MAY contribute any of the following; each contribution is constrained by §11.3:

| Contribution | Constraint |
|---|---|
| **Sub-schemas** for its document- and resource-level blocks | Validated once the namespace is registered; govern only content inside `extensions.<ns>` |
| **Additional validation rules** | May only **add** warnings or errors about the extension's own content (e.g. an invalid refinement combination); may never change the validity of core content |
| **Provider mappings** | Delivered as separate `*.iap-map.yaml` artifacts per [Chapter 12](12-provider-mapping.md); the extension block supplies refinement inputs the mapping reads |
| **Icons and diagram styling** | Presentation only; applied to the deterministic views of [Chapter 18](18-architecture-model.md) without changing graph shape |
| **Cost models** | Feed the cost annotation interface of [Chapter 16](16-cost-model.md); advisory, never validity-affecting |
| **Security rules** | Additional findings for [Chapter 15](15-security-model.md); may add findings about extension content, never suppress core findings |
| **Documentation** | Field-level docs surfaced by the language server ([Chapter 23](23-lsp.md)) |

## 11.6 Packaging Conventions

An extension package is a single versioned, immutable artifact. A published version MUST contain:

- a manifest declaring the namespace, the package `version` (semver, the value documents pin in `extensions.<ns>.version`), and the specification compatibility range;
- the JSON Schemas (draft 2020-12) for its document-level and resource-level blocks;
- human-readable documentation for every field it defines.

It SHOULD ship its provider mapping artifacts, validation/security rule definitions, cost model data, and diagram styling alongside, versioned together. Package versions are immutable: changing published content requires a new version, and breaking changes to the package's own schemas require a major bump of the *package* — never of the specification ([Chapter 10](10-versioning.md)).

## 11.7 `x-*` Annotations versus Extensions

IaP permits `x-*` keys at nearly every object level. They are not a lightweight alternative to extensions; the two mechanisms have opposite contracts:

| | `x-*` annotations | `extensions.<ns>` |
|---|---|---|
| Audience | One specific tool | An ecosystem, via a published package |
| Contract | None — free-form, unversioned | Versioned schema, docs, non-interference review |
| Portability | Non-portable; other tools MUST ignore them | Portable across all tools that resolve the package |
| Conformance | Ignored by **all** conformance requirements ([Chapter 24](24-conformance.md)); no conformance behavior may depend on an `x-*` key | IAP802/IAP803 behavior, deletion test, schema validation are all normative |
| Semantics | MUST NOT carry any — tools other than the intended one treat them as opaque | Refinement semantics defined by the package, bounded by §11.3 |

Rule of thumb: if a second tool should ever understand it, it belongs in an extension package. `x-*` is scratch space; `extensions` is a contract.
