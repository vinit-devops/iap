# 4. Relationship Model

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

## 4.1 Relationships Are First-Class Citizens

An IaP document does not describe a list of resources; it describes a system. The system is a **directed graph**: resources declared in [Chapter 3](03-resource-model.md) are the nodes, and relationships are the edges. Almost everything a conforming engine derives — execution order ([Chapter 9](09-dependency-model.md)), network reachability and least privilege ([Chapter 15](15-security-model.md)), architecture diagrams ([Chapter 18](18-architecture-model.md)), event triggers, and routing configuration — is derived from this graph, never declared imperatively.

Every relationship is directional: it has exactly one **source** resource and one **target** resource, and it is always read *source verb target* ("`api` **connectsTo** `orders-db`"). A relationship makes a **semantic assertion** about the running system, and (for every verb except `dependsOn` and `replicatesTo`) additionally implies an **ordering dependency**: the target must exist before the source.

## 4.2 The Canonical Edge Model

Every relationship, however it is written, normalizes to one canonical edge:

```
(source, type, target, attributes)
```

- `source` — resource identifier of the declaring/matched resource.
- `type` — one verb from the closed set in §4.3.
- `target` — resource identifier; MUST refer to a resource that exists in the profile-merged document, otherwise validation fails with **IAP201** (dangling target; [Chapter 8](08-validation.md)).
- `attributes` — the verb-scoped key/value assertions of §4.4.

The `description` field and `x-*` passthrough keys are non-semantic: they carry documentation only and are excluded from edge identity. Conforming tools MUST operate exclusively on the normalized edge set (§4.7). There are no dual semantics: an edge means exactly the same thing regardless of the declaration form that produced it.

## 4.3 The v1 Verb Set

The v1 verb set is **closed**. The ten verbs below are the only legal values of `type`. Extensions MAY contribute additional edge *attributes* (namespaced `x-*` keys, per [Chapter 11](11-extension-framework.md)); they MUST NOT add, alias, or redefine verbs. A document using an unknown verb fails schema validation ([Chapter 8](08-validation.md)).

| Verb | Meaning | Semantic assertion | Implies ordering? | Typical source → target kinds |
|---|---|---|---|---|
| `dependsOn` | Pure ordering | None. Target is provisioned and ready before source. Carries no network, data, or security meaning. | Yes | any → any |
| `connectsTo` | Network reachability | Source can open connections to target at the declared port/protocol with the declared access level. **The sole source of reachability and least-privilege derivation.** | Yes | Service, Job, Function → Database, Cache, Service, Queue |
| `routesTo` | Traffic routing | Source forwards matching inbound traffic (by `host`/`path`) to target. | Yes | Gateway → Service, Function |
| `publishesTo` | Message production | Source produces messages/events to target. Implies write-level access to the channel. | Yes | Service, Job, Function → Topic, Queue |
| `consumesFrom` | Message consumption | Source receives messages/events from target. Implies read-level access; for a `Function`, defines its trigger. | Yes | Service, Function, Job → Queue, Topic, Stream |
| `replicatesTo` | Data replication | Data written to source is replicated to target (same kind). Symmetric-capable: two resources MAY each declare `replicatesTo` the other. | **No** | Database → Database, ObjectStore → ObjectStore |
| `storesDataIn` | Data persistence | Source persists data in target with the declared access level. | Yes | Service, Job, Function → ObjectStore, Volume, Database |
| `protectedBy` | Protection dependency | Source's protection mechanism (key material, certificate, guarding control) is target. | Yes | Service, Gateway, Database → Secret, Certificate |
| `monitoredBy` | Observability wiring | Source's telemetry (per its `observability` block) is delivered to target. | Yes | any → Dashboard, Alert |
| `authenticatedBy` | Identity binding | Source runs as, and authenticates using, the workload identity target. | Yes | Service, Job, Function, Gateway → Identity |

### 4.3.1 Verb/target-kind constraints

The "typical kinds" column is informative. The following constraints are **normative**; violating any of them fails validation with **IAP301** (invalid verb/target-kind combination):

- `routesTo` target MUST be a `Service`, `Function`, or `Gateway`.
- `publishesTo` target MUST be a `Topic` or `Queue`.
- `consumesFrom` target MUST be a `Queue`, `Topic`, or `Stream`.
- `replicatesTo` target MUST have the same `kind` as the source.
- `storesDataIn` target MUST be an `ObjectStore`, `Volume`, or `Database`.
- `authenticatedBy` target MUST be an `Identity`.
- `monitoredBy` target MUST be a `Dashboard` or `Alert`.
- `connectsTo` target MUST be network-addressable: it MUST NOT be an `Application`, `Identity`, or `Secret`.
- Neither endpoint of any edge may be an `Application` except as the source or target of `dependsOn` (an `Application` is a grouping, not a runtime node).

`dependsOn` and `protectedBy` accept any target kind not excluded above.

## 4.4 Edge Attributes

v1 defines five edge attributes. Each attribute is valid only on the verbs listed below; an attribute present on any other verb fails validation with **IAP302** (invalid edge attribute for verb).

| Attribute | Type / values | Valid on | Meaning |
|---|---|---|---|
| `port` | integer 1–65535 | `connectsTo`, `routesTo` | Target port the source addresses. |
| `protocol` | `tcp` \| `udp` \| `http` \| `https` \| `grpc` \| `amqp` \| `mqtt` | `connectsTo`, `routesTo` | Wire protocol of the connection or route. |
| `access` | `read` \| `write` \| `read-write` \| `admin` | `connectsTo`, `storesDataIn` | Access level the source is granted on the target. Least privilege is derived from these values ([Chapter 15](15-security-model.md)). Default: `read-write`. |
| `path` | string (path prefix) | `routesTo` | Route path-prefix match. |
| `host` | hostname | `routesTo` | Route host match. |

`dependsOn` accepts **no** attributes — any attribute on a `dependsOn` edge is an IAP302 error, because a pure ordering edge asserts nothing that an attribute could refine. `publishesTo` and `consumesFrom` accept no attributes in v1: their access direction is fixed by the verb itself (write and read respectively).

Two edges with the same `(source, type, target)` but different attributes are **distinct edges** (e.g. `connectsTo` the same `Service` on ports 8080 and 9090).

## 4.5 Declaration Forms

There are exactly two ways to declare a relationship. Both produce canonical edges; neither has private semantics.

### 4.5.1 Inline edges (the normal form)

Point-to-point relationships MUST be declared **inline on the source resource**, in its `relationships` array. The declaring resource is always the source. This is the normal form because it gives **locality** (a resource's behavior is readable in one place) and **diffability** (a change to what `api` talks to is a diff on `api`).

```yaml
apiVersion: iap.dev/v1
metadata:
  name: order-platform
resources:
  api:
    kind: Service
    labels:
      tier: backend
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/order-api:1.4.2
    relationships:
      - type: connectsTo
        target: orders-db
        port: 5432
        protocol: tcp
        access: read-write
      - type: authenticatedBy
        target: api-identity
  worker:
    kind: Service
    labels:
      tier: backend
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/order-worker:1.4.2
  orders-db:
    kind: Database
    labels:
      tier: data
    spec:
      class: relational
      engine: postgresql
  api-identity:
    kind: Identity
  platform-alerts:
    kind: Alert
```

### 4.5.2 Rule edges (top-level `relationships`)

The top-level `relationships` section is reserved **exclusively** for selector-based **rule edges**: edges whose source is a label selector rather than a single resource. A rule edge declares "every resource matching this selector has this relationship to this target". Point-to-point edges MUST NOT appear at the top level.

```yaml
relationships:
  - type: monitoredBy
    description: All backend workloads report to the platform alert channel.
    source:
      selector:
        kinds: [Service]
        labels:
          tier: backend
    target: platform-alerts
```

Selectors match resources in the **profile-merged** document (§4.7): a resource matches when its `labels` contain every key/value pair in `selector.labels` and, if `selector.kinds` is present, its `kind` is listed. A rule edge whose selector matches **zero** resources fails validation with **IAP402** (unresolvable selector) — a rule that governs nothing is presumed to be a mistake.

Rule edges carry `port`, `protocol`, and `access` but not `path`/`host`: routes are inherently point-to-point and MUST be declared inline on the routing source.

### 4.5.3 One canonical model

Applying the rule edge above to the document of §4.5.1 normalizes to this edge set (canonical order, §4.7):

```
(api,    authenticatedBy, api-identity,    {})
(api,    connectsTo,      orders-db,       {port: 5432, protocol: tcp, access: read-write})
(api,    monitoredBy,     platform-alerts, {})
(worker, monitoredBy,     platform-alerts, {})
```

An edge produced by a rule is indistinguishable from the same edge written inline. Tooling — validators, planners, security derivation, diagram generation — MUST consume only this normalized set.

## 4.6 Dependency Implication and Derived Semantics

**Ordering.** Every verb except `dependsOn` couples its semantic assertion with an implied ordering dependency: *target before source*. `dependsOn` is the ordering dependency with no other assertion. `replicatesTo` is the single exception — it implies **no** ordering, which is what makes symmetric (bidirectional) replication declarable without contradiction. **Non-goal (v1):** `replicatesTo` asserts replication only; failover semantics — which side is writable after a failure, promotion, and failback — are out of scope for v1 and reserved for a future IEP. Documents needing failover behavior today model it in provider extensions. A cycle among ordering edges fails validation with **IAP401** (ordering cycle); the full derivation rules and planner obligations are specified in [Chapter 9](09-dependency-model.md) and [Chapter 14](14-planning-model.md).

**Network reachability (zero trust).** `connectsTo` edges are the **sole** source of network reachability and least-privilege derivation. A conforming engine MUST deny any connection not asserted by a `connectsTo` edge in the normalized graph, subject only to each resource's `exposure` intent ([Chapter 3](03-resource-model.md)). There is no default-allow scope, no implicit "same document" trust zone, and no way for an extension to widen reachability (Extension Non-Interference Rule, [Chapter 11](11-extension-framework.md)). The derivation of identities, grants, and network isolation from `access` levels and `connectsTo` edges is specified in [Chapter 15](15-security-model.md).

**Other derivations.** `routesTo` edges are the only source of routing configuration; `publishesTo`/`consumesFrom` are the only source of messaging permissions and `Function` triggers; `monitoredBy` wires the telemetry demanded by each resource's `observability` block.

## 4.7 Normalization Algorithm

Normalization MUST be deterministic: for a given document and active profile, every conforming implementation produces the byte-identical normalized edge set (this is an input to the canonical form defined in [Chapter 1](01-architecture.md)).

1. **Profile merge.** Apply the active profile per [Chapter 6](06-profiles.md). All subsequent steps operate on the merged document only. (Profiles may add or remove resources, labels, and edges; normalizing before merging is non-conforming.)
2. **Expand rule edges.** For each entry of top-level `relationships`, in document order: evaluate its selector against the merged `resources` map; sort matched resource identifiers lexicographically (byte-wise on UTF-8); emit one canonical edge per match, copying `type`, `target`, and attributes. Zero matches → **IAP402**.
3. **Collect inline edges.** For each resource, in lexicographic identifier order, emit one canonical edge per entry of its `relationships` array, in array order, with the resource as source.
4. **Validate references and shape.** Every `target` must exist in the merged document (**IAP201**, a Phase 2 reference error per [Chapter 8](08-validation.md)); every edge must satisfy §4.3.1 (**IAP301**) and §4.4 (**IAP302**).
5. **Deduplicate.** Two edges are identical when their `(source, type, target, attributes)` tuples are equal, comparing attributes as a key-sorted map and ignoring `description` and `x-*` keys. Identical edges collapse to one; if any duplicate was declared inline, the retained edge keeps the inline declaration's non-semantic fields, otherwise those of the earliest rule edge in document order.
6. **Stable sort.** Order the final set by `source`, then `type` (in the enumeration order of §4.3's table), then `target`, then the canonical serialization of `attributes`.

The output of step 6 is the **normalized graph** — the only relationship artifact that validation phases 3–6 ([Chapter 8](08-validation.md)), dependency derivation ([Chapter 9](09-dependency-model.md)), planning, security, and diagramming are permitted to read.

## 4.8 Error Codes

| Code | Condition |
|---|---|
| **IAP201** | Edge `target` does not exist in the profile-merged document (Phase 2 reference error, [Chapter 8](08-validation.md)). |
| **IAP301** | Invalid verb/target-kind combination (§4.3.1). |
| **IAP302** | Edge attribute not valid for the edge's verb (§4.4). |
| **IAP401** | Cycle among ordering edges ([Chapter 9](09-dependency-model.md)). |
| **IAP402** | Rule-edge selector matches zero resources. |
