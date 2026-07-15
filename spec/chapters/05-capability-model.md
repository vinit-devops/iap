# 5. Capability Model

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter defines the capability taxonomy of IaP: the families that organize the resource vocabulary, the registry of reserved kinds, the treatment of observability as a cross-cutting capability, and the resolution chain by which an execution engine turns a declared capability into provider resources. Capability families are a classification aid; they never appear in document structure.

## 5.1 Capabilities and Families

A **capability** is a class of infrastructure outcome that a substrate can supply: running a workload, persisting relational data, delivering messages, storing objects. Each IaP kind ([Chapter 3](03-resource-model.md)) declares exactly which capability it represents; kinds are the *units of intent*, capabilities are the *units of classification*.

Capabilities are grouped into ten **capability families**:

`application`, `compute`, `network`, `database`, `cache`, `storage`, `messaging`, `identity`, `security`, `observability`

Normative constraints:

- Family names are camelCase identifiers; they are fixed for the v1 major and MUST NOT be extended by documents or extensions.
- Families are **taxonomy only**. Per the document-shape rules in [Chapter 2](02-document-layout.md), IaP documents declare all resources in the single flat `resources:` map keyed by resource identifier, discriminated by `kind`. There are no family-keyed sections, and a conformant validator MUST reject any top-level key that attempts to introduce one (IAP1xx).
- Every kind belongs to exactly one family, recorded in the schema as the `x-iap-capability` annotation on the kind definition. Tools (LSPs, registries, diagram generators, cost engines) MAY group, filter, and color by family; they MUST NOT alter validation or planning behavior based on it.

## 5.2 Family-to-Kind Assignment

The 13 fully specified v1 kinds are assigned to families as follows. Full field contracts, defaults, and lifecycle rules for each kind are given in [Chapter 3](03-resource-model.md).

| Family | Kind | Capability summary | Abstract output attributes |
|---|---|---|---|
| application | `Application` | Logical grouping of resources that ship together | `identifier` |
| compute | `Service` | Long-running request-serving workload | `identifier`, `endpoint` |
| compute | `Job` | Run-to-completion workload, optionally scheduled | `identifier` |
| compute | `Function` | Event-invoked workload | `identifier`, `endpoint` |
| network | `Gateway` | Traffic entry point; routes are `routesTo` edges | `identifier`, `endpoint` |
| database | `Database` | Managed database of a declared class and open dialect | `identifier`, `endpoint`, `connectionSecret` |
| cache | `Cache` | In-memory cache (`redis-compatible`, `memcached-compatible`) | `identifier`, `endpoint`, `connectionSecret` |
| storage | `ObjectStore` | Durable blob/object storage | `identifier`, `endpoint` |
| storage | `Volume` | Block/file volume attached to compute | `identifier` |
| messaging | `Queue` | Point-to-point message queue | `identifier`, `endpoint` |
| messaging | `Topic` | Publish/subscribe channel | `identifier`, `endpoint` |
| identity | `Identity` | Workload identity; permissions derive from edge `access` levels | `identifier` |
| security | `Secret` | Managed secret material; values never appear in documents | `identifier`, `connectionSecret` |

Abstract output attributes follow the standard contract: every provisionable kind exposes `identifier`; addressable kinds additionally expose `endpoint`; authenticated kinds additionally expose `connectionSecret`. Mappings MUST bind every abstract attribute a kind declares ([Chapter 12](12-provider-mapping.md)); documents export them via the top-level `outputs:` key.

## 5.3 The Capability Registry: Reserved Kinds

Nine kinds are **reserved** in v1: their names are registered, their capability family is assigned, and their `kind` values are accepted by the schema — but their `spec` contract is intentionally minimal (an open object) and will be fully specified in a future minor revision.

| Family | Reserved kind | Purpose (one line) |
|---|---|---|
| network | `Network` | Explicit network segmentation and topology intent beyond what `exposure` and `connectsTo` edges derive |
| security | `Certificate` | Managed TLS certificate lifecycle, referenced by `Gateway.spec.tls.certificate` |
| network | `DnsZone` | Authoritative DNS zone and record intent |
| messaging | `Stream` | Ordered, replayable event stream with consumer-managed offsets (distinct from `Topic` fan-out delivery) |
| compute | `Workflow` | Multi-step orchestration of `Job` and `Function` executions with state transitions |
| database | `SearchIndex` | Full-text or vector search index over application data |
| storage | `Registry` | Artifact and container-image registry |
| observability | `Dashboard` | Curated visualization over emitted metrics and logs |
| observability | `Alert` | Notification rule evaluated over observability signals |

Normative rules for reserved kinds:

1. Validators MUST accept a resource whose `kind` is reserved, validating its `spec` loosely (any object is schema-valid).
2. Validators SHOULD emit warning **IAP801** (reserved-kind warning) for every use of a reserved kind, identifying the kind and noting that its field contract is not yet specified.
3. Because reserved specs carry no field contract, policies targeting reserved-kind fields ([Chapter 7](07-policy-language.md)) evaluate against whatever structure the author supplied; authors SHOULD NOT rely on reserved-kind fields for governance until the kind is promoted.
4. Mappings MAY support reserved kinds; the fail-closed coverage rule of [Chapter 12](12-provider-mapping.md) applies unchanged — a mapping that does not declare coverage for a reserved kind MUST reject documents that use it.
5. Extensions and documents MUST NOT define new kinds. The `kind` enumeration — fully specified plus reserved — is closed for the v1 major; growth happens only through the promotion process in [§5.6](#56-promoting-a-reserved-kind).

Example (fragment) — a reserved kind in use:

```yaml
resources:
  checkout-alerts:
    kind: Alert            # reserved in v1: accepted, warned as IAP801
    spec:
      severity: critical   # spec is loosely validated until promotion
```

## 5.4 Observability as a Cross-Cutting Capability

Observability is a capability family with **no mandatory kind**. IaP treats telemetry as a property of every resource rather than a resource an author must remember to declare:

1. **The `observability` block.** Every fully specified kind that emits runtime signals carries an optional `observability:` block with three intent dimensions — `logs`, `metrics`, `traces` — each valued `required | preferred | none`. Defaults are `logs: required`, `metrics: preferred`, `traces: none`. A mapping MUST refuse to plan a resource whose `required` signal it cannot deliver, and SHOULD satisfy `preferred` signals when the substrate supports them.
2. **The `monitoredBy` verb.** Where telemetry is consumed by a specific destination declared in the same document, the source resource declares a `monitoredBy` relationship ([Chapter 4](04-relationship-model.md)). Like all verbs other than `dependsOn`, `monitoredBy` implies ordering (target before source) plus its semantic assertion.
3. **Reserved observability kinds.** `Dashboard` and `Alert` exist in the registry ([§5.3](#53-the-capability-registry-reserved-kinds)) for authors who need to declare consumption-side observability today, subject to IAP801.

```yaml
resources:
  checkout:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/checkout:1.4.2
      observability:
        logs: required
        metrics: required
        traces: preferred
    relationships:
      - type: monitoredBy
        target: checkout-alerts
```

This design keeps the common case zero-cost — omit the block and safe defaults apply — while making stricter telemetry posture declarable and policy-enforceable (e.g., a `require` policy that `spec.observability.traces` equals `required` for all `Service` resources labeled `tier: critical`).

## 5.5 Capability Resolution

An execution engine never interprets a capability directly. Resolution follows a fixed four-step chain, each step deterministic:

```
capability family ──▶ kind ──▶ mapping entry ──▶ provider resources
   (taxonomy)      (document)   (*.iap-map.yaml)     (provider plan)
```

1. **Capability → kind.** The author selects a kind; the family is implied by the schema annotation. Nothing is resolved at plan time from the family itself.
2. **Kind → mapping entry.** The selected mapping artifact ([Chapter 12](12-provider-mapping.md)) declares, per kind, exactly which fields and values it covers. Coverage is fail-closed: a document using an uncovered kind, field, or value MUST be rejected at plan time rather than partially mapped.
3. **Mapping entry → provider resources.** The mapping emits provider resources as a pure function of the canonical resource, its incident canonical edges, and the mapping itself ([Chapter 1, §1.5](01-architecture.md)).
4. **Attribute binding.** The mapping binds each abstract output attribute the kind declares (`identifier`, `endpoint`, `connectionSecret`) to a concrete provider attribute, so `outputs:` remain provider-neutral.

The table below illustrates step 3 for the **compute** family (kind `Service`). *This table is the only place in this chapter where provider names may appear; they illustrate mapping targets and are not part of the core vocabulary.*

| Mapping artifact (illustrative) | `Service` maps to |
|---|---|
| `aws-reference.iap-map.yaml` | ECS Fargate service, load-balancer target group, task role |
| `azure-reference.iap-map.yaml` | Container Apps application, managed identity |
| `gcp-reference.iap-map.yaml` | Cloud Run service, service account |
| `kubernetes-reference.iap-map.yaml` | Deployment, Service, HorizontalPodAutoscaler, ServiceAccount |

Worked resolution chain, Kubernetes compute (illustrative):

```
compute (family)
  └─ Service "checkout"                      # document: kind + spec + edges
       └─ kubernetes-reference.iap-map.yaml  # coverage: kind=Service; runtime=container;
            │                                #   scaling.*, exposure=private|internal
            ├─ Deployment                    # artifact, size/resources, healthCheck
            ├─ Service                       # ports, exposure
            ├─ HorizontalPodAutoscaler       # scaling.min/max/targetUtilization
            └─ ServiceAccount                # identity for authenticatedBy edges
       outputs bound:
         identifier       → namespace/name of the Deployment
         endpoint         → cluster-internal DNS name of the Service
```

Two engines given the same canonical document and the same mapping version MUST produce byte-identical provider plans; this is a conformance requirement ([Chapter 24](24-conformance.md)), not a quality goal.

## 5.6 Promoting a Reserved Kind

A reserved kind becomes fully specified only through a specification **minor revision** (e.g., 1.1.0). Promotion requires all of the following, and a promotion that satisfies them is strictly additive — documents valid before the minor remain valid after it:

1. **Full field contract.** A complete `spec` definition in the JSON Schema — every field with type, allowed values, default, and `x-iap-since` annotation set to the promoting minor — plus a full kind section in [Chapter 3](03-resource-model.md) following the standard template (purpose, fields, validation, lifecycle, relationships, provider-mapping table, example).
2. **Abstract output declaration.** The kind's `identifier` / `endpoint` / `connectionSecret` surface is declared so mappings can bind it.
3. **Relationship semantics.** Which verbs the kind participates in as source and target, specified in terms of the closed v1 verb set (promotion MUST NOT add verbs).
4. **Conformance cases.** At least one valid and one invalid conformance document exercising the new contract, added under `conformance/cases/` ([Chapter 24](24-conformance.md)).
5. **Warning retirement.** IAP801 ceases to apply to the kind from the promoting minor onward; validators pinned to earlier minors continue to warn.

Documents authored against a reserved kind before promotion remain schema-valid afterwards only if they conform to the promoted contract; because reserved specs were loosely validated, tooling SHOULD offer the deterministic `iap migrate` transform ([Chapter 10](10-versioning.md)) where a mechanical rewrite exists. New kind *names* — beyond the nine reserved entries — require a new entry in the registry via a minor revision before any promotion can occur; the reserved stage is mandatory and gives implementers at least one minor cycle of notice.
