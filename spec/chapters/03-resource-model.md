# 3. Resource Model

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter defines the complete catalog of resource kinds in IaP v1. A *kind* is a named unit of infrastructure intent: it declares WHAT must exist — a request-serving workload, a relational database, a message queue — never HOW any provider realizes it. Thirteen kinds are fully specified in v1 (§3.4–§3.16); nine further kinds are reserved with intentionally loose validation (§3.17). Every field documented here mirrors the machine-readable schema at [`schema/iap-v1.schema.json`](../schema/iap-v1.schema.json), which is the normative source of truth; where prose and schema disagree, the schema governs. RFC 2119 keywords (MUST, SHOULD, MAY) are used as defined in [Chapter 2](02-document-layout.md).

## 3.1 Resource Entry Anatomy

Every resource lives in the top-level `resources:` map. The map key is the resource identifier and MUST match the DNS-label grammar `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`; identifiers MUST be unique within a document and are the only way to reference a resource (see [Chapter 2](02-document-layout.md)).

A resource entry has exactly these properties (plus `x-` passthrough):

| Property | Type | Required | Description |
|---|---|---|---|
| `kind` | enum (PascalCase kind name) | Yes | Discriminator selecting the kind-specific `spec` schema. MUST be one of the 22 registered kind names (§3.4–§3.17). |
| `description` | string | No | Human-readable intent statement. Non-semantic. |
| `labels` | map\<string, string\> | No | Free-form key/value labels consumed by selectors, policies, and rule edges. Values are always strings, max 256 characters. |
| `spec` | object | Per kind | Kind-specific intent fields, defined in §3.4–§3.16. Required for `Application`, `Service`, `Job`, `Function`, `Database`, `Cache`, and `Volume`; optional (all fields defaulted) for the remaining kinds. |
| `relationships` | array of edge | No | Inline directional edges; the declaring resource is always the source. Edge grammar is defined in [Chapter 4](04-relationship-model.md). |
| `extensions` | map\<namespace, object\> | No | Namespaced, non-normative provider refinements governed by the Extension Non-Interference Rule ([Chapter 11](11-extension-framework.md)). |

Unknown properties are rejected (`additionalProperties: false`), with one escape valve: any property whose name begins with `x-` is passed through unvalidated at every object level in the specification. Tools MUST preserve `x-` properties byte-for-byte and MUST NOT derive core semantics from them.

```yaml
resources:
  orders-api:
    kind: Service
    description: Order management API
    labels:
      tier: backend
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/orders-api:1.4.2
    relationships:
      - type: connectsTo
        target: orders-db
        access: read-write
    extensions:
      aws:
        computeHint: graviton
```

### 3.1.1 Field Definition Contract

Every field in this chapter — and every property in the schema — carries a complete definition consisting of:

1. **Definition** — one-sentence statement of the intent the field expresses.
2. **Type** — JSON type plus grammar where applicable (quantity, duration, hostname, resource ID).
3. **Allowed values** — a closed enum, a pattern, or a documented open range.
4. **Default** — the value assumed when the field is omitted. Defaults are normative: omitting a field and writing its default MUST be semantically identical.
5. **Since-version** — carried in the schema as `x-iap-since`. Fields without an `x-iap-since` annotation date from specification version **1.0.0**.
6. **Deprecation status** — carried as `x-iap-deprecated` when applicable. No field is deprecated in 1.0.0. Deprecated fields remain valid for the entire major version ([Chapter 10](10-versioning.md)).

A machine-readable field registry is generated from these annotations; tools such as language servers MUST source completion and hover documentation from the schema, not from this prose.

## 3.2 Shared Intent Vocabulary

The following common definitions (`$defs/common/*` in the schema) are reused across kinds. A kind never redefines these semantics; at most it restricts the allowed values (e.g. `Gateway` forbids `exposure: private`).

### 3.2.1 `availability`

Availability is a measurable SLO floor, never a topology word. Providers choose the topology that satisfies the floor.

| Value | SLO floor | Topology latitude |
|---|---|---|
| `standard` (default) | ≥ 99.9% | Single-zone placement is acceptable. |
| `high` | ≥ 99.95% | MUST be resilient to the loss of a single zone (multi-zone). |
| `maximum` | ≥ 99.99% | MUST be realizable across regions (multi-region-capable). |

### 3.2.2 `exposure`

Network reachability intent.

| Value | Meaning |
|---|---|
| `public` | Internet-reachable. |
| `internal` | Reachable only from the organization's network. |
| `private` (default) | Reachable only via declared `connectsTo` relationships. |

The default is always the most restrictive value the kind permits. Network isolation is derived from `exposure` plus the relationship graph ([Chapter 15](15-security-model.md)).

### 3.2.3 `size`

Portable t-shirt sizing for compute capacity: `xs`, `s`, `m`, `l`, `xl`. Default `m` unless a kind states otherwise. Providers map sizes to concrete instance classes ([Chapter 12](12-provider-mapping.md)); when the number IS the intent, authors override with exact quantities via `resources` (§3.2.8).

### 3.2.4 `encryption`

| Field | Type | Allowed values | Default |
|---|---|---|---|
| `atRest` | enum | `required`, `preferred` | `required` |
| `inTransit` | enum | `required`, `preferred` | `required` |

Omission never weakens posture: an absent `encryption` block is identical to both dimensions being `required`. There is no `none`. `required` MUST fail the plan if the mapping cannot encrypt; `preferred` MUST encrypt when the target platform supports it and MAY proceed unencrypted otherwise, emitting a warning.

### 3.2.5 `observability`

Cross-cutting observability intent available on every resource.

| Field | Allowed values | Default |
|---|---|---|
| `logs` | `required`, `preferred`, `none` | `required` |
| `metrics` | `required`, `preferred`, `none` | `preferred` |
| `traces` | `required`, `preferred`, `none` | `none` |

`required` MUST be satisfied by the mapping or the plan fails; `preferred` is best-effort with a warning on omission; `none` asserts the signal is intentionally not collected.

### 3.2.6 `resilience`

Data protection and recovery intent.

| Field | Type | Allowed values / grammar | Default |
|---|---|---|---|
| `backup` | enum | `required`, `preferred`, `none` | Per-kind (below) |
| `recoveryPointObjective` | string (duration) | duration grammar (§3.2.7) | — |
| `recoveryTimeObjective` | string (duration) | duration grammar (§3.2.7) | — |

The `backup` default is normative per kind: **`Database` → `required`**, **`Volume` → `required`**, **`ObjectStore` → `preferred`**, and **`preferred` for every other kind** that carries a `resilience` block. When `recoveryPointObjective` or `recoveryTimeObjective` is set, the mapping MUST produce a plan capable of meeting it or fail closed.

### 3.2.7 Quantity and duration grammars

- **Quantity** — Kubernetes-style quantity for exact capacity intent: pattern `^[0-9]+(\.[0-9]+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$`. Examples: `100Gi`, `2`, `500m`. Canonical form normalizes quantities ([Chapter 1](01-architecture.md)).
- **Duration** — integer followed by one unit: pattern `^[0-9]+(ms|s|m|h|d)$`. Examples: `30s`, `1h`, `90d`. Compound durations (`1h30m`) are invalid in v1.

### 3.2.8 `computeResources`

Optional exact-quantity override of t-shirt sizing.

| Field | Type | Description |
|---|---|---|
| `cpu` | string (quantity) | Exact CPU intent (e.g. `500m`, `2`). |
| `memory` | string (quantity) | Exact memory intent (e.g. `1Gi`). |

When present, `resources` takes precedence over `size` for the dimensions it specifies.

### 3.2.9 `artifact`

What to run, expressed provider-neutrally.

| Field | Type | Required | Allowed values | Description |
|---|---|---|---|---|
| `type` | enum | Yes | `container-image`, `source`, `archive` | Artifact form. |
| `reference` | string | Yes | — | Image reference, source repository URL, or archive location. |

## 3.3 Standard Abstract Output Attributes

Kinds expose *abstract output attributes* — provider-neutral names that documents export via the top-level `outputs:` map and that relationships consume implicitly. Three attributes are standard:

| Attribute | Exposed by | Meaning |
|---|---|---|
| `identifier` | Every provisionable kind | Opaque, stable, provider-neutral handle for the realized resource. |
| `endpoint` | Every addressable kind | Abstract network locator (host and port, or URL) at which the resource is reached. |
| `connectionSecret` | Every authenticated kind | Reference to managed credential material needed to connect. Never a literal value. |

Summary of outputs by kind (details in each kind's **Outputs** subsection):

| Kind | `identifier` | `endpoint` | `connectionSecret` |
|---|---|---|---|
| Application | ✓ | — | — |
| Service | ✓ | ✓ | — |
| Job | ✓ | — | — |
| Function | ✓ | ✓ | — |
| Gateway | ✓ | ✓ | — |
| Database | ✓ | ✓ | ✓ |
| Cache | ✓ | ✓ | ✓ |
| ObjectStore | ✓ | ✓ | — |
| Volume | ✓ | — | — |
| Queue | ✓ | ✓ | — |
| Topic | ✓ | ✓ | — |
| Identity | ✓ | — | — |
| Secret | ✓ | — | — |

Provider mappings MUST bind every abstract attribute a kind declares to a concrete provider value, and MUST fail closed if they cannot (see [Chapter 12](12-provider-mapping.md)). Documents MUST NOT export provider identifiers directly.

---

## 3.4 Application

**Purpose.** `Application` is the grouping kind (capability family: *application*). It declares that a set of resources ships, versions, and is reasoned about together. An Application provisions nothing itself; it scopes diagrams, deployments, and ownership. It replaces any notion of a top-level `applications:` section.

**Fields.** `spec` is **required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `components` | array of resource ID | Yes | — | Identifiers of member resources. MUST contain at least 1 entry; entries MUST be unique. |
| `version` | string | No | — | Application-level version label. Non-semantic to the core; consumed by tooling and history. |

**Validation.**
- Every entry in `components` MUST reference a resource ID that exists in the document (**IAP202**).
- `components` MUST NOT include the Application's own resource ID (**IAP202**).
- An Application SHOULD NOT be a component of another Application; validators SHOULD warn on nesting (IAP2xx range).

**Lifecycle.** All fields are updatable in place. Changing `components` re-scopes the group without touching member resources. An Application is never replacement-eligible.

**Relationships.** Applications rarely declare edges. Membership is expressed by `components`, not by relationships. An Application MAY be the source of `monitoredBy` or `protectedBy` edges that apply group-wide.

**Outputs.** `identifier` only.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| Resource group / tag set | Resource group | App Hub application / label set | Namespace + common labels |

**Example**

```yaml
resources:
  storefront:
    kind: Application
    description: Customer-facing storefront
    spec:
      components: [web, orders-api, orders-db]
      version: "2024.07"
```

## 3.5 Service

**Purpose.** `Service` is a long-running, request-serving workload (capability family: *compute*). It is the workhorse kind for APIs, web frontends, and daemons that stay resident and scale horizontally.

**Fields.** `spec` is **required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `artifact` | object (§3.2.9) | Yes | — | What to run: `type` + `reference`. |
| `runtime` | enum | No | `container` | Execution substrate hint: `container`, `vm`, `managed`. Largely a mapping concern. |
| `size` | enum (§3.2.3) | No | `m` | T-shirt compute sizing. |
| `resources` | object (§3.2.8) | No | — | Exact `cpu` / `memory` quantity override. |
| `scaling` | object | No | — | Horizontal scaling intent (below). |
| `scaling.min` | integer ≥ 0 | No | `1` | Minimum instance count. `0` permits scale-to-zero. |
| `scaling.max` | integer ≥ 1 | No | `1` | Maximum instance count. |
| `scaling.targetUtilization` | integer 1–100 | No | `70` | Utilization percentage the scaler targets. |
| `exposure` | enum (§3.2.2) | No | `private` | `public`, `internal`, `private`. |
| `availability` | enum (§3.2.1) | No | `standard` | SLO floor. |
| `ports` | array of object | No | — | Listening ports (below). |
| `ports[].name` | resource ID | No | — | Port name. |
| `ports[].port` | integer 1–65535 | Yes (per entry) | — | Port number. |
| `ports[].protocol` | enum | No | `tcp` | `tcp`, `udp`, `http`, `https`, `grpc`. |
| `configuration` | map\<string, string\> | No | — | Non-secret configuration. Secrets MUST be modeled as `Secret` resources referenced via relationships. |
| `healthCheck` | object | No | — | Liveness/readiness intent (below). |
| `healthCheck.path` | string | No | — | Probe path. |
| `healthCheck.port` | integer 1–65535 | No | — | Probe port. |
| `healthCheck.interval` | string (duration) | No | `30s` | Probe interval. |
| `encryption` | object (§3.2.4) | No | both `required` | At-rest / in-transit posture. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- `scaling.min` MUST be ≤ `scaling.max` (**IAP104**).
- Secret-looking literals in `configuration` MUST be rejected (**IAP602**); credentials travel only as `Secret` resources.
- `healthCheck.port`, when set, SHOULD match a declared `ports[].port` (IAP1xx warning).
- `availability: high` or `maximum` with `scaling.max: 1` SHOULD warn: a single instance cannot satisfy a multi-zone SLO floor (IAP1xx).

**Lifecycle.** `Service` is stateless at the intent level: all fields — including `artifact` — are in-place updatable via rolling replacement of instances. No field change makes the Service itself replacement-eligible; durable state lives in attached `Database`, `Volume`, or `ObjectStore` resources.

**Relationships.** Commonly the **source** of `connectsTo` (→ Database, Cache, Service), `storesDataIn` (→ ObjectStore, Volume), `publishesTo` (→ Queue, Topic), `consumesFrom` (→ Queue, Topic), `authenticatedBy` (→ Identity), and `dependsOn`. Commonly the **target** of `routesTo` from a Gateway and `connectsTo` from other workloads.

**Outputs.** `identifier`, `endpoint`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| ECS/Fargate service, App Runner | Container Apps, App Service | Cloud Run service, GKE workload | Deployment + Service + HPA |

**Example**

```yaml
resources:
  orders-api:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/orders-api:1.4.2
      size: m
      scaling: { min: 2, max: 10, targetUtilization: 70 }
      exposure: internal
      availability: high
      ports:
        - { name: http, port: 8080, protocol: http }
      healthCheck: { path: /healthz, port: 8080, interval: 30s }
    relationships:
      - { type: connectsTo, target: orders-db, port: 5432, protocol: tcp, access: read-write }
```

## 3.6 Job

**Purpose.** `Job` is a run-to-completion workload (capability family: *compute*), optionally scheduled. It models batch processing, migrations, reports, and periodic maintenance — anything with a defined end.

**Fields.** `spec` is **required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `artifact` | object (§3.2.9) | Yes | — | What to run. |
| `schedule` | string | No | — | 5-field cron expression or `@hourly`/`@daily`/`@weekly`/`@monthly` (pattern `^(@(hourly|daily|weekly|monthly)|(\S+\s+){4}\S+)$`). Omit for on-demand jobs. |
| `size` | enum (§3.2.3) | No | `m` | T-shirt compute sizing. |
| `resources` | object (§3.2.8) | No | — | Exact `cpu` / `memory` override. |
| `timeout` | string (duration) | No | `1h` | Maximum run duration before the run is failed. |
| `retries` | integer 0–100 | No | `0` | Retry attempts after a failed run. |
| `concurrency` | enum | No | `forbid` | Behavior when a new run starts while a previous run is active: `allow`, `forbid`, `replace`. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- `schedule` MUST satisfy the cron/@-macro grammar (schema-enforced, IAP1xx).
- Timezone-dependent cron semantics are evaluated in UTC; validators SHOULD warn on `x-` timezone annotations they cannot honor (IAP8xx).

**Lifecycle.** All fields are in-place updatable; changes apply to the next run and never interrupt an active run except as `concurrency: replace` dictates. A Job is never replacement-eligible.

**Relationships.** Commonly the **source** of `connectsTo` (→ Database), `storesDataIn` (→ ObjectStore), `consumesFrom` (→ Queue), `authenticatedBy` (→ Identity), and `dependsOn` (e.g. a migration Job that a Service `dependsOn`).

**Outputs.** `identifier`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| ECS scheduled task, Batch job | Container Apps Job, Azure Batch | Cloud Run job + Cloud Scheduler | Job / CronJob |

**Example**

```yaml
resources:
  nightly-report:
    kind: Job
    spec:
      artifact: { type: container-image, reference: registry.example.com/report:3.1.0 }
      schedule: "0 2 * * *"
      timeout: 2h
      retries: 2
      concurrency: forbid
    relationships:
      - { type: connectsTo, target: orders-db, access: read }
      - { type: storesDataIn, target: report-archive, access: write }
```

## 3.7 Function

**Purpose.** `Function` is an event-invoked workload (capability family: *compute*): short-lived, demand-scaled compute whose triggers are not fields but relationships — a Function is invoked by what it `consumesFrom` and by `routesTo` edges targeting it.

**Fields.** `spec` is **required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `artifact` | object (§3.2.9) | Yes | — | What to run. |
| `size` | enum (§3.2.3) | No | `s` | T-shirt compute sizing (note the smaller default). |
| `resources` | object (§3.2.8) | No | — | Exact `cpu` / `memory` override. |
| `timeout` | string (duration) | No | `30s` | Maximum invocation duration. |
| `concurrency` | object | No | — | Invocation concurrency intent. |
| `concurrency.max` | integer ≥ 1 | No | — | Maximum concurrent invocations; omit for platform-unbounded. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- A Function SHOULD have at least one trigger: a `consumesFrom` edge it declares, or a `routesTo` edge targeting it. Validators SHOULD warn on trigger-less Functions (IAP3xx range).
- Triggers MUST NOT be declared through extension fields (**IAP803** non-interference violation); they are relationships.

**Lifecycle.** All fields are in-place updatable. Artifact changes roll forward at the next invocation. A Function is never replacement-eligible.

**Relationships.** Commonly the **source** of `consumesFrom` (→ Queue, Topic — its triggers), `connectsTo` (→ Database, Cache), `publishesTo` (→ Queue, Topic), `storesDataIn` (→ ObjectStore), and `authenticatedBy` (→ Identity). Commonly the **target** of `routesTo` from a Gateway.

**Outputs.** `identifier`, `endpoint`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| Lambda | Azure Functions | Cloud Run functions | Knative Service / OpenFaaS function |

**Example**

```yaml
resources:
  image-resizer:
    kind: Function
    spec:
      artifact: { type: container-image, reference: registry.example.com/resizer:2.0.1 }
      timeout: 60s
      concurrency: { max: 50 }
    relationships:
      - { type: consumesFrom, target: upload-events, access: read }
      - { type: storesDataIn, target: media-store, access: write }
```

## 3.8 Gateway

**Purpose.** `Gateway` is a traffic entry point (capability family: *network*). It terminates external or internal traffic and forwards it to workloads. Routes are not fields: each route is a `routesTo` relationship carrying `path` and `host` edge attributes ([Chapter 4](04-relationship-model.md)).

**Fields.** `spec` is **optional** (all fields have defaults).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `exposure` | enum | No | `public` | `public` or `internal`. Gateways exist to expose traffic; `private` is not a valid gateway exposure. |
| `domains` | array of hostname | No | — | Served domains; wildcard prefix (`*.`) permitted; entries MUST be unique. |
| `tls` | object | No | — | TLS termination intent (below). |
| `tls.minimumVersion` | enum | No | `1.2` | `1.2` or `1.3`. |
| `tls.certificate` | resource ID | No | — | Reference to a `Certificate` resource; omit for provider-managed certificates. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- A Gateway SHOULD declare at least one `routesTo` edge; validators SHOULD warn on a route-less Gateway (**IAP303**, advisory).
- `routesTo` targets MUST be addressable workload kinds (`Service`, `Function`); other targets are rejected (IAP3xx range).
- `tls.certificate`, when set, MUST reference an existing resource of kind `Certificate` (**IAP204** if dangling; IAP2xx range if wrong kind).
- Overlapping `path`/`host` pairs across a Gateway's `routesTo` edges MUST be rejected as ambiguous routing (IAP3xx range).

**Lifecycle.** All fields are in-place updatable. Changing `exposure` between `public` and `internal` is in-place at the intent level but SHOULD be flagged as a security-posture change by validators. A Gateway is never replacement-eligible.

**Relationships.** Exclusively the **source** of `routesTo` (→ Service, Function). MAY declare `protectedBy` and `monitoredBy`.

**Outputs.** `identifier`, `endpoint`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| Application Load Balancer, API Gateway | Application Gateway, API Management | Cloud Load Balancing, API Gateway | Ingress / Gateway API Gateway |

**Example**

```yaml
resources:
  edge:
    kind: Gateway
    spec:
      exposure: public
      domains: [shop.example.com]
      tls: { minimumVersion: "1.3" }
    relationships:
      - { type: routesTo, target: web, path: /, protocol: https }
      - { type: routesTo, target: orders-api, path: /api/orders, protocol: https }
```

## 3.9 Database

**Purpose.** `Database` declares managed database intent (capability family: *database*). The `class` states the data model the application depends on; the optional `engine` narrows to a non-proprietary wire protocol or dialect. Provider products never appear in a spec.

**Fields.** `spec` is **required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `class` | enum | Yes | — | Data model: `relational`, `document`, `key-value`, `graph`, `timeseries`, `vector`. |
| `engine` | enum | No | — | Wire-protocol/dialect intent: `postgresql`, `mysql`, `mariadb`, `mongodb-compatible`, `cassandra-compatible`. Provider products never appear here. |
| `engineVersion` | string | No | — | Dotted numeric version of the dialect (pattern `^[0-9]+(\.[0-9]+)*$`), e.g. `16`, `8.0`. |
| `availability` | enum (§3.2.1) | No | `standard` | SLO floor. |
| `encryption` | object (§3.2.4) | No | both `required` | At-rest / in-transit posture. |
| `exposure` | enum | No | `private` | `private` or `internal`. Databases are never `public`. |
| `capacity` | object | No | — | Exact capacity intent (below). |
| `capacity.storage` | string (quantity) | No | `10Gi` | Storage capacity. |
| `capacity.throughput` | string | No | — | Throughput intent, pattern `^[0-9]+(rps|iops)$` (e.g. `1000rps`, `3000iops`). |
| `size` | enum (§3.2.3) | No | `m` | T-shirt compute sizing of the database tier. |
| `resilience` | object (§3.2.6) | No | `backup: required` | Backup/RPO/RTO. **Normative default: `backup: required`.** |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- `engine` MUST be consistent with `class` (**IAP104**): `postgresql`, `mysql`, `mariadb` are valid only with `class: relational`; `mongodb-compatible` only with `class: document`; `cassandra-compatible` only with `class: key-value` or `class: document`.
- `engineVersion` without `engine` is meaningless and MUST be rejected (IAP1xx range).
- `resilience.backup: none` on a Database violates the normative default and MUST be an explicit, policy-visible act; compliance bundles typically deny it (IAP5xx/IAP7xx at policy time).

**Lifecycle.** `capacity`, `size`, `availability`, `resilience`, `observability`, and `encryption` upgrades are in-place. Changing `class` or `engine` is **replacement-eligible** — but Database is a stateful kind and MUST NOT be replaced without an explicit migration declared by the plan ([Chapter 14](14-planning-model.md)); planners MUST reject implicit replacement (IAP4xx range). `engineVersion` increases are in-place; decreases are replacement-eligible.

**Relationships.** Almost always the **target**: workloads (`Service`, `Job`, `Function`) declare `connectsTo` with an `access` level from which least privilege is derived. MAY be the **source** of `replicatesTo` (→ another Database, for cross-region intent), `protectedBy`, and `monitoredBy`.

**Outputs.** `identifier`, `endpoint`, `connectionSecret`.

**Provider Mapping** *(informative)*

| Class | AWS | Azure | GCP | Kubernetes |
|---|---|---|---|---|
| relational | RDS / Aurora | Azure Database for PostgreSQL/MySQL | Cloud SQL / AlloyDB | Operator-managed PostgreSQL (e.g. CloudNativePG) |
| document | DocumentDB | Cosmos DB (Mongo API) | Firestore / MongoDB Atlas via marketplace | Operator-managed MongoDB-compatible |
| key-value | DynamoDB / Keyspaces | Cosmos DB (Cassandra API) | Bigtable | Operator-managed Cassandra-compatible |
| graph / timeseries / vector | Neptune / Timestream / OpenSearch vector | Cosmos DB Gremlin / Data Explorer / AI Search | Spanner Graph / Bigtable / Vertex Vector Search | Operator-managed engines |

**Example**

```yaml
resources:
  orders-db:
    kind: Database
    spec:
      class: relational
      engine: postgresql
      engineVersion: "16"
      availability: high
      capacity: { storage: 100Gi }
      resilience:
        backup: required
        recoveryPointObjective: 1h
        recoveryTimeObjective: 4h
```

## 3.10 Cache

**Purpose.** `Cache` declares in-memory cache intent (capability family: *cache*) for low-latency, loss-tolerant data. Contents are reconstructible by definition; durable data belongs in `Database` or `ObjectStore`.

**Fields.** `spec` is **required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `engine` | enum | Yes | — | Protocol compatibility intent: `redis-compatible`, `memcached-compatible`. |
| `capacity` | object | No | — | Memory capacity intent. |
| `capacity.memory` | string (quantity) | No | `1Gi` | Cache memory. |
| `availability` | enum (§3.2.1) | No | `standard` | SLO floor. |
| `encryption` | object (§3.2.4) | No | both `required` | At-rest / in-transit posture. |
| `exposure` | enum | No | `private` | `private` or `internal`. Caches are never `public`. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- A Cache SHOULD be the target of at least one `connectsTo` edge; an unreferenced Cache is a warning (IAP3xx range).

**Lifecycle.** `capacity`, `availability`, `encryption`, and `observability` changes are in-place. Changing `engine` is replacement-eligible; because cache contents are loss-tolerant by definition, replacement does not require a migration declaration (contrast §3.9).

**Relationships.** Almost always the **target** of `connectsTo` from `Service`, `Job`, or `Function`. MAY declare `monitoredBy`.

**Outputs.** `identifier`, `endpoint`, `connectionSecret`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| ElastiCache | Azure Cache for Redis | Memorystore | Operator-managed Redis-compatible (e.g. Valkey) |

**Example**

```yaml
resources:
  session-cache:
    kind: Cache
    spec:
      engine: redis-compatible
      capacity: { memory: 2Gi }
      availability: high
```

## 3.11 ObjectStore

**Purpose.** `ObjectStore` declares durable blob/object storage intent (capability family: *storage*): unstructured objects addressed by key, with lifecycle management and optional versioning.

**Fields.** `spec` is **optional** (all fields have defaults).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `versioning` | enum | No | `disabled` | `enabled` or `disabled`: retain prior object versions. |
| `exposure` | enum | No | `private` | `private` or `public` (e.g. static asset hosting). `internal` is not defined for object stores. |
| `encryption` | object (§3.2.4) | No | both `required` | At-rest / in-transit posture. |
| `lifecycle` | array of object | No | — | Age-based transitions (below). |
| `lifecycle[].after` | string (duration) | Yes (per entry) | — | Object age at which the action applies. |
| `lifecycle[].action` | enum | Yes (per entry) | — | `archive` (colder tier) or `delete`. |
| `resilience` | object (§3.2.6) | No | `backup: preferred` | Backup/RPO/RTO. **Normative default: `backup: preferred`.** |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- At most one `lifecycle` rule with `action: delete` SHOULD exist; every `archive` rule's `after` SHOULD be strictly less than the `delete` rule's `after` (IAP1xx warning).
- `exposure: public` on an ObjectStore SHOULD be warned as a security-posture declaration and is commonly denied by policy (IAP5xx/IAP6xx at policy time).

**Lifecycle.** All fields are in-place updatable. Disabling `versioning` does not destroy existing versions at the intent level. ObjectStore is a stateful kind and MUST NOT be replaced without explicit migration.

**Relationships.** Almost always the **target** of `storesDataIn` from workloads. MAY be the **source** of `replicatesTo` (→ another ObjectStore) and `monitoredBy`.

**Outputs.** `identifier`, `endpoint`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| S3 | Blob Storage | Cloud Storage | MinIO / object-store operator |

**Example**

```yaml
resources:
  media-store:
    kind: ObjectStore
    spec:
      versioning: enabled
      lifecycle:
        - { after: 30d, action: archive }
        - { after: 365d, action: delete }
```

## 3.12 Volume

**Purpose.** `Volume` declares a block or file volume attached to compute (capability family: *storage*): filesystem-semantics storage whose lifetime is independent of the workload using it.

**Fields.** `spec` is **required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `capacity` | object | Yes | — | Capacity intent. |
| `capacity.storage` | string (quantity) | Yes | — | Volume size (e.g. `100Gi`). |
| `accessMode` | enum | No | `single-writer` | `single-writer`, `multi-reader`, `multi-writer`. |
| `performance` | enum | No | `standard` | Relative performance tier: `standard`, `high`, `maximum`. |
| `encryption` | object (§3.2.4) | No | both `required` | At-rest / in-transit posture. |
| `resilience` | object (§3.2.6) | No | `backup: required` | Backup/RPO/RTO. **Normative default: `backup: required`.** |

**Validation.**
- A Volume SHOULD be the target of exactly one `storesDataIn` edge when `accessMode: single-writer`; multiple writers against a single-writer volume MUST be rejected (IAP3xx range).
- `capacity.storage` decreases are rejected at plan time as data-destructive (IAP4xx range).

**Lifecycle.** `capacity.storage` increases, `performance`, and `resilience` changes are in-place. `accessMode` changes and capacity decreases are replacement-eligible — but Volume is a stateful kind and MUST NOT be replaced without explicit migration.

**Relationships.** The **target** of `storesDataIn` from `Service` or `Job`. MAY declare `protectedBy` and be the source of `replicatesTo`.

**Outputs.** `identifier`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| EBS / EFS | Managed Disks / Azure Files | Persistent Disk / Filestore | PersistentVolumeClaim |

**Example**

```yaml
resources:
  search-data:
    kind: Volume
    spec:
      capacity: { storage: 200Gi }
      accessMode: single-writer
      performance: high
```

## 3.13 Queue

**Purpose.** `Queue` declares a point-to-point message queue (capability family: *messaging*): each message is delivered to one consumer. Producers declare `publishesTo`; consumers declare `consumesFrom`.

**Fields.** `spec` is **optional** (all fields have defaults).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `delivery` | enum | No | `at-least-once` | `at-least-once` or `exactly-once`. |
| `ordering` | enum | No | `none` | `none` or `fifo`. |
| `messageRetention` | string (duration) | No | `7d` | How long unconsumed messages are retained. |
| `deadLetter` | object | No | — | Dead-letter intent (below). |
| `deadLetter.enabled` | boolean | No | `false` | Route poisoned messages to a dead-letter destination. |
| `deadLetter.maxReceives` | integer ≥ 1 | No | `5` | Delivery attempts before dead-lettering. |
| `encryption` | object (§3.2.4) | No | both `required` | At-rest / in-transit posture. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- `deadLetter.maxReceives` is meaningful only when `deadLetter.enabled: true`; setting it while disabled SHOULD warn (IAP1xx range).
- A Queue SHOULD have at least one `publishesTo` edge targeting it and one `consumesFrom` edge; orphan queues warn (IAP3xx range).

**Lifecycle.** `messageRetention`, `deadLetter`, `encryption`, and `observability` changes are in-place. `delivery` and `ordering` changes are replacement-eligible; because in-flight messages are durable state, replacement MUST NOT occur without explicit migration (drain-then-replace).

**Relationships.** Always the **target** of `publishesTo` (from producers) and `consumesFrom` (from consumers — commonly `Function`, `Service`, `Job`).

**Outputs.** `identifier`, `endpoint`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| SQS | Service Bus queue / Storage Queues | Pub/Sub (pull subscription) / Cloud Tasks | Operator-managed RabbitMQ / NATS queue group |

**Example**

```yaml
resources:
  order-events:
    kind: Queue
    spec:
      delivery: at-least-once
      ordering: fifo
      messageRetention: 4d
      deadLetter: { enabled: true, maxReceives: 3 }
```

## 3.14 Topic

**Purpose.** `Topic` declares a publish/subscribe channel (capability family: *messaging*): every subscriber receives every message. Subscriptions are not fields — each subscriber declares a `consumesFrom` edge, from which per-subscriber delivery is derived.

**Fields.** `spec` is **optional** (all fields have defaults).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `delivery` | enum | No | `at-least-once` | `at-least-once` or `exactly-once`. |
| `ordering` | enum | No | `none` | `none` or `ordered`. |
| `messageRetention` | string (duration) | No | `7d` | Retention window for delivered/undelivered messages. |
| `encryption` | object (§3.2.4) | No | both `required` | At-rest / in-transit posture. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- A Topic SHOULD have at least one `consumesFrom` edge targeting it; a subscriber-less Topic warns (IAP3xx range).

**Lifecycle.** `messageRetention`, `encryption`, and `observability` changes are in-place. `delivery` and `ordering` changes are replacement-eligible with the same drain-then-replace migration requirement as `Queue` (§3.13).

**Relationships.** Always the **target** of `publishesTo` and `consumesFrom` (subscribers — commonly `Function` and `Service`).

**Outputs.** `identifier`, `endpoint`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| SNS | Service Bus topic / Event Grid | Pub/Sub topic | Kafka topic (Strimzi) / NATS subject |

**Example**

```yaml
resources:
  upload-events:
    kind: Topic
    spec:
      delivery: at-least-once
      ordering: none
      messageRetention: 3d
```

## 3.15 Identity

**Purpose.** `Identity` declares workload identity intent (capability family: *identity*). It carries almost no fields deliberately: concrete permissions are never written by hand — they are **derived** from the `access` attributes of the relationships declared by the workloads that are `authenticatedBy` this Identity (least privilege by construction; see [Chapter 15](15-security-model.md)).

**Fields.** `spec` is **optional** (all fields have defaults).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | enum | No | `workload` | Identity category. v1 defines only `workload`; future minors may add values. |

**Validation.**
- An Identity SHOULD be the target of at least one `authenticatedBy` edge; an unreferenced Identity warns (IAP3xx range).
- Any attempt to enumerate permissions in `spec` (e.g. via unknown fields) is rejected by the schema (IAP1xx); permission-like content in `extensions` MUST NOT alter derived privileges (**IAP803** non-interference violation).

**Lifecycle.** All fields are in-place updatable. Derived permissions change automatically as the relationship graph changes; the Identity itself is never replacement-eligible.

**Relationships.** Always the **target** of `authenticatedBy` from `Service`, `Job`, and `Function`. The transitive closure — workload → `authenticatedBy` → Identity, workload → verb+`access` → resource — yields the minimal permission set.

**Outputs.** `identifier`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| IAM role (workload-assumed, e.g. IRSA) | Managed Identity / Entra Workload ID | Service account + Workload Identity | ServiceAccount (+ platform workload identity) |

**Example**

```yaml
resources:
  orders-identity:
    kind: Identity
    spec:
      type: workload
```

## 3.16 Secret

**Purpose.** `Secret` declares managed secret material (capability family: *security*): the existence, provenance, and rotation of a credential. **Secret values never appear in IaP documents** — the document declares that a secret exists and how it is managed, never what it contains.

**Fields.** `spec` is **optional** (all fields have defaults).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `source` | enum | No | `generated` | `generated`: the platform creates the value. `provided`: supplied out-of-band at deploy time. `external`: synchronized from an external secret system. |
| `rotation` | object | No | — | Rotation intent (below). |
| `rotation.policy` | enum | No | `preferred` | `required`, `preferred`, `none`. |
| `rotation.interval` | string (duration) | No | `90d` | Maximum credential age when rotation applies. |

**Validation.**
- Secret values MUST NOT appear anywhere in a document — not in `spec`, `configuration`, `labels`, annotations, or `x-` properties. Validators MUST reject high-entropy or credential-patterned literals (**IAP602**).
- `rotation.interval` is meaningful only when `rotation.policy` is not `none`; otherwise it SHOULD warn (IAP1xx range).
- `source: provided` secrets MUST be satisfied out-of-band before a plan executes; planners MUST fail closed on missing provided secrets (IAP4xx range).

**Lifecycle.** `rotation` changes are in-place. Changing `source` is replacement-eligible; because dependent workloads hold live credentials, replacement MUST NOT occur without explicit migration (issue-new-then-cut-over).

**Relationships.** Always the **target** of `protectedBy`-style consumption: workloads reference secrets via `connectsTo`/`dependsOn` edges or receive them transitively through a target's `connectionSecret` output. A Secret MAY declare `monitoredBy` (audit intent).

**Outputs.** `identifier`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| Secrets Manager | Key Vault | Secret Manager | Secret (+ External Secrets Operator for `source: external`) |

**Example**

```yaml
resources:
  api-signing-key:
    kind: Secret
    spec:
      source: generated
      rotation: { policy: required, interval: 30d }
```

## 3.17 Reserved Kinds

Nine kind names are **reserved** in v1. They participate in the `kind` enum and the capability registry ([Chapter 5](05-capability-model.md)) but carry an intentionally minimal spec schema (`$defs/kinds/ReservedKind`): validation is loose, and validators MUST accept a reserved-kind resource and SHOULD emit warning **IAP801** noting that its full specification arrives in a future minor version. Mappings MAY support reserved kinds via their fail-closed coverage matrix; documents using them SHOULD expect reduced portability until full specification.

| Kind | Purpose (one line) |
|---|---|
| `Network` | Explicit network segmentation intent beyond what `exposure` derives. |
| `Certificate` | TLS certificate material and issuance intent, referenced by `Gateway.tls.certificate`. |
| `DnsZone` | Authoritative DNS zone and record intent. |
| `Stream` | Ordered, replayable event stream (log-structured messaging, distinct from `Queue`/`Topic`). |
| `Workflow` | Multi-step orchestration of Jobs/Functions with state transitions. |
| `SearchIndex` | Full-text / relevance search index intent. |
| `Registry` | Artifact and image registry intent. |
| `Dashboard` | Curated observability dashboard derived from `monitoredBy` signals. |
| `Alert` | Alerting rule and notification-routing intent. |

Names in this table MUST NOT be reused for any other purpose by documents or extensions; a future minor version specifies each with the full §3.4-style template.
