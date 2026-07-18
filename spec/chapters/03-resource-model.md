# 3. Resource Model

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.3.0 (IEP-0017) · Status: Released**

This chapter defines the complete catalog of resource kinds in IaP v1. A *kind* is a named unit of infrastructure intent: it declares WHAT must exist — a request-serving workload, a relational database, a message queue — never HOW any provider realizes it. Thirteen kinds are fully specified since 1.0.0 (§3.4–§3.16); five further kinds — `Certificate`, `DnsZone`, `Registry`, `Dashboard`, `Alert` — graduated from the reserved registry in 1.1.0 ([IEP-0015](../ieps/IEP-0015-reserved-kind-graduation.md); §3.17–§3.21), and the remaining four — `Network`, `Stream`, `Workflow`, `SearchIndex` — graduated in 1.2.0 ([IEP-0016](../ieps/IEP-0016-reserved-registry-graduation.md); §3.22–§3.25), emptying the reserved registry (§3.26). Specification 1.3.0 introduces two further kinds *directly* — `Cdn` and `EventBus` ([IEP-0017](../ieps/IEP-0017-new-kinds-cdn-eventbus.md); §3.27–§3.28) — the first kinds added other than by graduation, plus three additive enum widenings (`Identity.type` gains `user-directory`, `Service.runtime` gains `kubernetes`, and a new optional `Gateway.protocol` field offers `graphql`). Every field documented here mirrors the machine-readable schema at [`schema/iap-v1.schema.json`](../schema/iap-v1.schema.json), which is the normative source of truth; where prose and schema disagree, the schema governs. RFC 2119 keywords (MUST, SHOULD, MAY) are used as defined in [Chapter 2](02-document-layout.md).

## 3.1 Resource Entry Anatomy

Every resource lives in the top-level `resources:` map. The map key is the resource identifier and MUST match the DNS-label grammar `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`; identifiers MUST be unique within a document and are the only way to reference a resource (see [Chapter 2](02-document-layout.md)).

A resource entry has exactly these properties (plus `x-` passthrough):

| Property | Type | Required | Description |
|---|---|---|---|
| `kind` | enum (PascalCase kind name) | Yes | Discriminator selecting the kind-specific `spec` schema. MUST be one of the 22 registered kind names (§3.4–§3.22). |
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
| Certificate *(1.1.0)* | ✓ | — | — |
| DnsZone *(1.1.0)* | ✓ | ✓ | — |
| Registry *(1.1.0)* | ✓ | ✓ | ✓ |
| Dashboard *(1.1.0)* | ✓ | ✓ | — |
| Alert *(1.1.0)* | ✓ | — | — |
| Network *(1.2.0)* | ✓ | — | — |
| Stream *(1.2.0)* | ✓ | ✓ | — |
| Workflow *(1.2.0)* | ✓ | — | — |
| SearchIndex *(1.2.0)* | ✓ | ✓ | ✓ |
| Cdn *(1.3.0)* | ✓ | ✓ | — |
| EventBus *(1.3.0)* | ✓ | ✓ | — |

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
| `runtime` | enum | No | `container` | Execution substrate hint: `container`, `vm`, `managed`, `kubernetes` *(since 1.3.0)*. Largely a mapping concern. |
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
| `protocol` | enum | No | — *(no default)* | *Since 1.3.0.* Application protocol the gateway terminates and routes: `http` or `graphql`. Provider-neutral protocol/query-language names, never provider products. Carries **no default** so existing Gateway documents canonicalize byte-identically. |
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
| `class` | enum | Yes | — | Data model: `relational`, `document`, `key-value`, `graph`, `timeseries`, `vector`, `wide-column` *(since 1.1.0)*, `warehouse` *(since 1.1.0)*. |
| `engine` | enum | No | — | Wire-protocol/dialect intent: `postgresql`, `mysql`, `mariadb`, `mongodb-compatible`, `cassandra-compatible`. Provider products never appear here. No engine value pairs with `class: warehouse` in 1.1.0 — omit `engine` (IEP-0015). |
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
- `engine` MUST be consistent with `class` (**IAP104**): `postgresql`, `mysql`, `mariadb` are valid only with `class: relational`; `mongodb-compatible` only with `class: document`; `cassandra-compatible` only with `class: key-value`, `class: document`, or `class: wide-column` *(the `wide-column` pairing is since 1.1.0)*. No engine value is consistent with `class: warehouse` in 1.1.0: a warehouse Database MUST omit `engine`, and any declared engine is an IAP104 error under the per-engine rules above.
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
| wide-column *(1.1.0)* | Keyspaces | Cosmos DB (Cassandra API) | Bigtable | Operator-managed Cassandra-compatible |
| warehouse *(1.1.0)* | Redshift | Synapse Analytics | BigQuery | Operator-managed columnar warehouse |

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

**Purpose.** `Identity` declares identity intent (capability family: *identity*). For a workload identity it carries almost no fields deliberately: concrete permissions are never written by hand — they are **derived** from the `access` attributes of the relationships declared by the workloads that are `authenticatedBy` this Identity (least privilege by construction; see [Chapter 15](15-security-model.md)).

**Fields.** `spec` is **optional** (all fields have defaults).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | enum | No | `workload` | Identity category. `workload`: a machine identity whose permissions derive from edge `access` levels. `user-directory` *(since 1.3.0)*: a directory of human/end-user identities (e.g. an authentication user pool), distinct from workload identity. The enum stays closed; a future minor may add further values. |

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

## 3.17 Certificate

*Since 1.1.0 ([IEP-0015](../ieps/IEP-0015-reserved-kind-graduation.md)) — graduated from the reserved registry ([Chapter 5](05-capability-model.md) §5.6).*

**Purpose.** `Certificate` declares TLS certificate material and issuance intent (capability family: *security*). It is the resource referenced by `Gateway.spec.tls.certificate` (§3.8; dangling references are **IAP204**). Values are algorithm and lifecycle intent, never provider products.

**Fields.** `spec` is **required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `domains` | array of hostname (§3.2 grammar) | Yes (min 1, unique) | — | DNS names the certificate covers; wildcard prefix (`*.`) permitted. |
| `issuance` | enum | No | `managed` | `managed`: the platform obtains and renews the certificate. `imported`: material is supplied out-of-band (e.g. via a `Secret`); the platform never generates keys. |
| `keyAlgorithm` | enum | No | `ecdsa-p256` | `rsa-2048`, `rsa-4096`, `ecdsa-p256`, `ecdsa-p384`. |

**Validation.**
- `domains` entries follow the §3.2 hostname grammar; an empty array is schema-invalid.
- A `Gateway` whose `tls.certificate` names a resource of any other kind is rejected (IAP2xx range; §3.8).

**Lifecycle.** Certificate material is immutable: `domains`, `issuance`, and `keyAlgorithm` changes are **replacement-eligible**. The kind is stateless, so replacement requires no migration declaration.

**Relationships.** Usually the **target**: referenced by `Gateway.spec.tls.certificate` and by `protectedBy` edges from `Gateway`, `Service`, or `Database`. MAY be the **source** of `dependsOn` → `DnsZone` (DNS-validated issuance) and `monitoredBy` (expiry monitoring).

**Outputs.** `identifier`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| ACM | Key Vault certificates | Certificate Manager | cert-manager Certificate |

**Example**

```yaml
resources:
  shop-cert:
    kind: Certificate
    spec:
      domains: [shop.example.com, "*.shop.example.com"]
      issuance: managed
    relationships:
      - { type: dependsOn, target: shop-zone }
```

## 3.18 DnsZone

*Since 1.1.0 ([IEP-0015](../ieps/IEP-0015-reserved-kind-graduation.md)) — graduated from the reserved registry ([Chapter 5](05-capability-model.md) §5.6).*

**Purpose.** `DnsZone` declares authoritative DNS zone intent (capability family: *network*). Record-level intent is deliberately not specified in 1.1.0; a record grammar can be added additively in a later minor.

**Fields.** `spec` is **required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `zoneName` | string | Yes | — | Fully qualified apex name of the zone (no wildcard, no trailing dot); pattern `^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$`. |
| `visibility` | enum | No | `public` | `public`: resolvable from the internet. `internal`: resolvable only inside the organization network (split-horizon). Named `visibility`, not `exposure`: it scopes name resolution, not workload reachability. |
| `dnssec` | enum | No | `none` | `required`: the mapping MUST sign the zone or fail closed; `preferred`: sign where the substrate supports it; `none`: unsigned. |

**Validation.**
- `zoneName` violating the apex-name pattern is schema-invalid.

**Lifecycle.** `visibility` and `dnssec` changes are in-place. Changing `zoneName` is **replacement-eligible** and delegation-affecting; planners SHOULD surface it as a high-impact change.

**Relationships.** Usually the **target** of `dependsOn` (from `Certificate` for DNS-validated issuance, from `Gateway` for served-domain intent). MAY declare `monitoredBy`.

**Outputs.** `identifier`, `endpoint` (the authoritative name-server set, provider-neutrally).

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| Route 53 hosted zone | Azure DNS zone | Cloud DNS zone | ExternalDNS-managed zone |

**Example**

```yaml
resources:
  shop-zone:
    kind: DnsZone
    spec:
      zoneName: shop.example.com
      visibility: public
      dnssec: preferred
```

## 3.19 Registry

*Since 1.1.0 ([IEP-0015](../ieps/IEP-0015-reserved-kind-graduation.md)) — graduated from the reserved registry ([Chapter 5](05-capability-model.md) §5.6).*

**Purpose.** `Registry` declares artifact and container-image registry intent (capability family: *storage*). Push/pull permissions derive from `connectsTo` edge `access` levels, exactly as data-store least privilege does (§3.9, [Chapter 4](04-relationship-model.md)).

**Fields.** `spec` is **optional** (all fields have defaults or are optional).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `format` | enum | No | `container-image` | `container-image` or `archive`; aligns with the §3.2.9 `artifact.type` grammar (minus `source`). |
| `immutability` | enum | No | `disabled` | `enabled`: a stored artifact version or tag can never be overwritten. |
| `exposure` | enum | No | `private` | `private` or `internal`. Registries are never `public` in 1.1.0. |
| `encryption` | object (§3.2.4) | No | both `required` | At-rest / in-transit posture. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- A Registry SHOULD be the target of at least one `connectsTo` edge; `access: read` expresses pull, `write`/`read-write` push.

**Lifecycle.** All fields are in-place updatable except `format`, which is **replacement-eligible**.

**Relationships.** Usually the **target** of `connectsTo` from `Service`, `Job`, or `Function`. MAY declare `protectedBy` and `monitoredBy`.

**Outputs.** `identifier`, `endpoint`, `connectionSecret` (pull/push credential reference — never a literal value).

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| ECR | Container Registry | Artifact Registry | In-cluster OCI registry (e.g. operator-managed) |

**Example**

```yaml
resources:
  images:
    kind: Registry
    spec:
      format: container-image
      immutability: enabled
```

## 3.20 Dashboard

*Since 1.1.0 ([IEP-0015](../ieps/IEP-0015-reserved-kind-graduation.md)) — graduated from the reserved registry ([Chapter 5](05-capability-model.md) §5.6).*

**Purpose.** `Dashboard` declares a curated observability dashboard (capability family: *observability*) over the telemetry that `monitoredBy` edges deliver ([Chapter 5](05-capability-model.md) §5.4). What is visualized follows from the sources' `observability` blocks; the dashboard declares the consumption side.

**Fields.** `spec` is **optional**. No field carries a default — deliberate ([IEP-0015](../ieps/IEP-0015-reserved-kind-graduation.md)): documents that used this kind while it was reserved keep byte-identical canonicalization.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `audience` | string (max 256) | No | — | Intended audience, free-form (e.g. `platform-operations`). |
| `signals` | array of enum (unique) | No | — | `logs`, `metrics`, `traces`. Omitted: every signal delivered by incident `monitoredBy` edges. |

**Validation.**
- A Dashboard SHOULD be the target of at least one `monitoredBy` edge; an unreferenced Dashboard is advisory-eligible (IAP3xx range).

**Lifecycle.** All fields are in-place updatable; a Dashboard is never replacement-eligible.

**Relationships.** Exclusively the **target** of `monitoredBy` ([Chapter 4](04-relationship-model.md) §4.3.1). MAY declare `dependsOn`.

**Outputs.** `identifier`, `endpoint` (where the dashboard is served).

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| CloudWatch dashboard | Azure Monitor workbook | Cloud Monitoring dashboard | Grafana dashboard (operator-managed) |

**Example**

```yaml
resources:
  ops-dashboard:
    kind: Dashboard
    spec:
      audience: platform-operations
      signals: [logs, metrics]
```

## 3.21 Alert

*Since 1.1.0 ([IEP-0015](../ieps/IEP-0015-reserved-kind-graduation.md)) — graduated from the reserved registry ([Chapter 5](05-capability-model.md) §5.6).*

**Purpose.** `Alert` declares a notification rule and its routing intent (capability family: *observability*), evaluated over the telemetry that `monitoredBy` edges deliver. Concrete rule expressions and destinations are mapping/extension territory; the kind declares classification, threshold, and channel-class intent.

**Fields.** `spec` is **optional**. No field carries a default — deliberate ([IEP-0015](../ieps/IEP-0015-reserved-kind-graduation.md)): documents that used this kind while it was reserved keep byte-identical canonicalization.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `severity` | enum | No | — | `info`, `low`, `medium`, `high`, `critical`: severity classification of the notifications this alert emits. |
| `severityFloor` | enum | No | — | Same values: minimum severity of evaluated conditions that triggers notification. Omitted: notify at every severity. |
| `signals` | array of enum (unique) | No | — | `logs`, `metrics`, `traces`. Omitted: every signal delivered by incident `monitoredBy` edges. |
| `channels` | array of enum (unique) | No | — | `email`, `chat`, `webhook`, `pager`, `sms`: provider-neutral channel classes; concrete destinations are mapping/extension territory. |

**Validation.**
- An Alert SHOULD be the target of at least one `monitoredBy` edge; an unreferenced Alert is advisory-eligible (IAP3xx range).

**Lifecycle.** All fields are in-place updatable; an Alert is never replacement-eligible.

**Relationships.** Exclusively the **target** of `monitoredBy` ([Chapter 4](04-relationship-model.md) §4.3.1). MAY declare `dependsOn`.

**Outputs.** `identifier`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| CloudWatch alarm | Azure Monitor alert rule | Cloud Monitoring alerting policy | Prometheus/Alertmanager rule (operator-managed) |

**Example**

```yaml
resources:
  data-alerts:
    kind: Alert
    spec:
      severity: high
      channels: [pager, chat]
```

## 3.22 Network

*Since 1.2.0 ([IEP-0016](../ieps/IEP-0016-reserved-registry-graduation.md)) — graduated from the reserved registry ([Chapter 5](05-capability-model.md) §5.6).*

**Purpose.** `Network` declares explicit network segmentation and topology intent (capability family: *network*) beyond what per-resource `exposure` and the `connectsTo` graph already derive ([Chapter 15](15-security-model.md)). Values are neutral topology intent, never provider products.

**Fields.** `spec` is **optional** (all fields are optional and carry no default).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `scope` | enum | No | — | `regional` (a single region) or `multi-region` (spans regions; globally routable intent). |
| `tiers` | array of enum (unique, min 1) | No | — | Reachability tiers the network provides: `public` (internet-facing segments), `private` (internally routable with egress), `isolated` (no egress). |
| `addressSpace` | string (IPv4 CIDR) | No | — | Optional exact CIDR block intent (e.g. `10.0.0.0/16`); omitted means the platform allocates a non-overlapping range. A neutral IP concept, never a provider product. |
| `observability` | object (§3.2.5) | No | — | Flow-log / metrics intent. |

**Validation.**
- `tiers` entries outside the closed enum are schema-invalid; `addressSpace` violating the CIDR grammar is schema-invalid.

**Lifecycle.** `scope` and `addressSpace` are **replacement-eligible** (address-space changes are topology-affecting); `tiers` and `observability` are in-place.

**Relationships.** Usually the **target** of `dependsOn` (from workloads that must be placed within it). MAY declare `monitoredBy`. `Network` carries no closed-list verb of its own; workloads associate with it through the open `dependsOn` verb.

**Outputs.** `identifier`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| VPC + subnets | Virtual Network + subnets | VPC network + subnetworks | NetworkPolicy / CNI network |

**Example**

```yaml
resources:
  app-net:
    kind: Network
    spec:
      scope: regional
      tiers: [public, private]
      addressSpace: 10.0.0.0/16
```

## 3.23 Stream

*Since 1.2.0 ([IEP-0016](../ieps/IEP-0016-reserved-registry-graduation.md)) — graduated from the reserved registry ([Chapter 5](05-capability-model.md) §5.6).*

**Purpose.** `Stream` declares an ordered, replayable event stream with consumer-managed offsets (capability family: *messaging*), distinct from `Topic` fan-out delivery: consumers replay from a retained log rather than receiving a delivered copy.

**Fields.** `spec` is **optional**. No field defaults, and no common block with defaulted members (no `encryption`/`observability`), so canonicalization of a reserved-era `Stream` is byte-identical to its authored form — deliberate ([IEP-0016](../ieps/IEP-0016-reserved-registry-graduation.md)); the official `data-processing` example declares a `Stream` today. (An `encryption`/`observability` surface can be added additively in a later minor.)

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `retention` | string, duration grammar `^[0-9]+(ms\|s\|m\|h\|d)$` | No | — | How long records remain available for replay. Typed inline (not the common duration `$ref`) so the authored spelling is preserved verbatim in canonicalization. |
| `ordering` | enum | No | — | `none` (no cross-record ordering guarantee) or `partition` (order preserved within a partition key). |
| `capacity` | object | No | — | `throughput`: sustained ingest capacity intent, grammar `^[0-9]+(rps\|mbps)$`. |

**Validation.**
- A Stream SHOULD be the target of at least one `consumesFrom` edge.

**Lifecycle.** All fields are in-place updatable; a Stream is never replacement-eligible.

**Relationships.** The **target** of `consumesFrom` (already admitted by the closed verb/target-kind table of [Chapter 4](04-relationship-model.md) §4.3.1). Producers write to a Stream through `connectsTo` with `access: write`/`read-write` (a Stream is network-addressable; `publishesTo` stays scoped to `Topic`/`Queue` for the v1 major). MAY declare `monitoredBy` and `protectedBy`.

**Outputs.** `identifier`, `endpoint`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| Kinesis / Firehose stream | Event Hubs | Pub/Sub Lite / Dataflow | Operator-managed Kafka topic |

**Example**

```yaml
resources:
  clicks:
    kind: Stream
    spec:
      retention: 24h
      ordering: partition
      capacity:
        throughput: 1000rps
```

## 3.24 Workflow

*Since 1.2.0 ([IEP-0016](../ieps/IEP-0016-reserved-registry-graduation.md)) — graduated from the reserved registry ([Chapter 5](05-capability-model.md) §5.6).*

**Purpose.** `Workflow` declares multi-step orchestration of `Job` and `Function` executions with state transitions (capability family: *compute*). The concrete step graph is defined out-of-band; a declarative step grammar can be added additively in a later minor.

**Fields.** `spec` is **optional**. No field defaults, and no common block with defaulted members, so canonicalization of a reserved-era `Workflow` is byte-identical to its authored form — deliberate ([IEP-0016](../ieps/IEP-0016-reserved-registry-graduation.md)). (An `observability` surface can be added additively in a later minor.)

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `steps` | integer (min 1) | No | — | Declared number of orchestrated steps (advisory until a step grammar exists). |
| `execution` | enum | No | — | `standard` (durable, long-running, full execution history) or `express` (high-volume, short-lived, best-effort history). |
| `timeout` | string, duration grammar `^[0-9]+(ms\|s\|m\|h\|d)$` | No | — | Maximum wall-clock time for a single workflow execution. Typed inline (not the common duration `$ref`) so the authored spelling is preserved verbatim in canonicalization. |

**Validation.**
- `steps` less than 1 is schema-invalid.

**Lifecycle.** All fields are in-place updatable; a Workflow is never replacement-eligible.

**Relationships.** Usually the **source** of `dependsOn` → `Job` / `Function` (the executions it orchestrates must exist). MAY be the **target** of `dependsOn` and MAY declare `monitoredBy`. `Workflow` participates only through the open `dependsOn` verb (v1 adds no orchestration verb).

**Outputs.** `identifier`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| Step Functions state machine | Logic Apps / Durable Functions | Workflows | Argo Workflows (operator-managed) |

**Example**

```yaml
resources:
  order-flow:
    kind: Workflow
    spec:
      steps: 3
      execution: standard
      timeout: 1h
    relationships:
      - { type: dependsOn, target: settle-job }
```

## 3.25 SearchIndex

*Since 1.2.0 ([IEP-0016](../ieps/IEP-0016-reserved-registry-graduation.md)) — graduated from the reserved registry ([Chapter 5](05-capability-model.md) §5.6).*

**Purpose.** `SearchIndex` declares a full-text or vector search index over application data (capability family: *database*). Query and access permissions derive from `connectsTo` edge `access` levels, as data-store least privilege does (§3.9, [Chapter 4](04-relationship-model.md)).

**Fields.** `spec` is **required**.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `indexType` | enum | Yes | — | `text` (full-text/relevance search) or `vector` (similarity search over embeddings). |
| `exposure` | enum | No | — | `private` or `internal`. A SearchIndex is never `public`. |
| `encryption` | object (§3.2.4) | No | — | At-rest / in-transit posture. |
| `capacity` | object | No | — | `storage`: index storage intent (quantity grammar, §3.2.7). |
| `observability` | object (§3.2.5) | No | — | Logs / metrics / traces intent. |

**Validation.**
- A SearchIndex without `indexType` (or without `spec`) is schema-invalid — the promoted contract requires it.
- A SearchIndex SHOULD be the target of at least one `connectsTo` edge.

**Lifecycle.** `indexType` is **replacement-eligible** (the index model is immutable material); other fields are in-place. A SearchIndex is stateful; replacement is a data-loss-eligible change planners SHOULD surface.

**Relationships.** Usually the **target** of `connectsTo` from `Service`, `Job`, or `Function` (`access: read` for query, `write`/`read-write` for indexing); a SearchIndex is network-addressable, so it is reached via `connectsTo`, not the closed `storesDataIn` list. MAY declare `protectedBy` and `monitoredBy`.

**Outputs.** `identifier`, `endpoint`, `connectionSecret`.

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| OpenSearch domain | Azure AI Search | Vertex AI Vector Search | Operator-managed OpenSearch/Elasticsearch |

**Example**

```yaml
resources:
  catalog-index:
    kind: SearchIndex
    spec:
      indexType: text
      exposure: internal
      capacity:
        storage: 50Gi
```

## 3.26 Reserved Kinds

The reserved registry is **empty** as of 1.2.0. All nine kind names reserved in 1.0.0 have graduated to fully specified kinds: `Certificate`, `DnsZone`, `Registry`, `Dashboard`, and `Alert` in 1.1.0 ([IEP-0015](../ieps/IEP-0015-reserved-kind-graduation.md)), and `Network`, `Stream`, `Workflow`, and `SearchIndex` in 1.2.0 ([IEP-0016](../ieps/IEP-0016-reserved-registry-graduation.md)).

The reserved-kind mechanism is retained deliberately for future use: the `$defs/kinds/ReservedKind` loose-spec template remains in the schema, and validators retain the warning **IAP801** (reserved kind in use). A future minor MAY reserve a new kind name via the process in [Chapter 5](05-capability-model.md) §5.6; from that point until its own graduation, that kind validates loosely and SHOULD warn IAP801. Because the registry is currently empty, **IAP801 applies to no kind in 1.2.0** — a conforming validator emits it for nothing.

Names in this table MUST NOT be reused for any other purpose by documents or extensions; a future minor version specifies each with the full §3.4-style template via the promotion process of [Chapter 5](05-capability-model.md) §5.6.

---

## 3.27 Cdn

*Since 1.3.0 ([IEP-0017](../ieps/IEP-0017-new-kinds-cdn-eventbus.md)) — introduced directly as a new fully specified kind ([Chapter 5](05-capability-model.md) §5.7), not a graduation.*

**Purpose.** `Cdn` declares content delivery / edge distribution intent (capability family: *network*): caching and serving content from edge locations in front of one or more origins. Values are neutral edge-distribution intent, never provider products.

**Fields.** `spec` is **required** (a Cdn with no origin distributes nothing).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `exposure` | enum | No | `public` | Edge reachability: `public` (internet-facing) or `internal` (organization network only). |
| `origins` | array of object (unique, min 1) | Yes | — | Backend origins the edge distributes. |
| `origins[].target` | resource ID | Yes (per entry) | — | Names an in-document origin resource (typically a `Service`, `Gateway`, or `ObjectStore`). Referential integrity is advisory in 1.3.0 (no generic spec-field reference check yet); authors SHOULD also declare a `dependsOn` edge to each origin for ordering. |
| `origins[].pathPattern` | string | No | — | Optional path prefix routed to this origin (e.g. `/static`); omitted means this origin serves all paths. |
| `tls` | object | No | — | TLS posture at the edge; mirrors `Gateway.spec.tls`. |
| `tls.minimumVersion` | enum | No | `1.2` | `1.2` or `1.3`. |
| `tls.certificate` | resource ID | No | — | Reference to a `Certificate` resource; omit for provider-managed certificates. |
| `caching` | object | No | — | Edge caching behavior intent. |
| `caching.mode` | enum | No | `standard` | `standard` (per origin/response directives), `aggressive` (broad caching), or `disabled` (pass-through). |
| `caching.defaultTtl` | string (duration) | No | — | Default edge cache lifetime. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- `spec` and `origins` (min 1) are required; a missing `origins` is schema-invalid.
- `origins[].target` outside the resource-id grammar is schema-invalid; existence of the referenced resource is advisory in 1.3.0.

**Lifecycle.** `exposure` and `origins` are in-place updatable; `tls`/`caching`/`observability` are in-place. A Cdn is never replacement-eligible.

**Relationships.** Usually the **source** of `dependsOn` (→ its origin `Service`/`Gateway`/`ObjectStore`). MAY declare `protectedBy` (→ `Certificate`) and `monitoredBy` (→ `Dashboard`/`Alert`). `Cdn` carries no closed-list verb of its own; it associates with origins through the open `dependsOn` verb.

**Outputs.** `identifier`, `endpoint` (the edge locator at which distributed content is served).

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| CloudFront distribution | Front Door / CDN | Cloud CDN | Ingress + edge cache (platform-specific) |

**Example**

```yaml
resources:
  storefront-cdn:
    kind: Cdn
    spec:
      exposure: public
      origins:
        - { target: assets, pathPattern: /static }
        - { target: storefront-api }
      tls: { minimumVersion: "1.3", certificate: edge-cert }
      caching: { mode: standard, defaultTtl: 1h }
    relationships:
      - { type: dependsOn, target: assets }
      - { type: protectedBy, target: edge-cert }
```

## 3.28 EventBus

*Since 1.3.0 ([IEP-0017](../ieps/IEP-0017-new-kinds-cdn-eventbus.md)) — introduced directly as a new fully specified kind ([Chapter 5](05-capability-model.md) §5.7), not a graduation.*

**Purpose.** `EventBus` declares event-routing intent (capability family: *messaging*): it accepts events from declared source classes and routes them to targets by declarative rules. It is distinct from `Topic` (fan-out delivery to subscribers) and `Stream` (ordered, replayable offsets): an `EventBus` is a router with pattern-matched routing rules. Values are neutral routing intent, never provider products.

**Fields.** `spec` is **optional** (all fields are optional or defaulted).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `sources` | array of enum (unique, min 1) | No | — | Accepted event-source classes: `internal` (in-organization workloads), `partner` (third-party/SaaS integrations), `custom` (application-defined producers). Neutral source classes, never provider products. |
| `rules` | array of object | No | — | Declarative routing rules. Targets are wired as `routesTo` relationships from the bus (the closed verb set is unchanged); each rule matches events and the bus forwards matches to the routed targets. |
| `rules[].name` | resource ID | Yes (per entry) | — | Rule name. |
| `rules[].eventPattern` | object (open) | No | — | Neutral matching object over event attributes; absent means the rule matches every event. |
| `rules[].enabled` | boolean | No | `true` | Whether the rule is active. |
| `schemaRegistry` | enum | No | `none` | `none` (no enforcement) or `managed` (events validated against a managed event-schema registry). |
| `retention` | string (duration) | No | — | How long undelivered/replayable events are retained. |
| `observability` | object (§3.2.5) | No | §3.2.5 defaults | Logs / metrics / traces intent. |

**Validation.**
- `sources` entries outside the closed enum are schema-invalid; each `rules[]` entry MUST carry a `name`.

**Lifecycle.** All fields are in-place updatable. An `EventBus` is never replacement-eligible.

**Relationships.** Target of `connectsTo` from producers (`access: write`; the bus is network-addressable and reached through the open `connectsTo` verb, since `publishesTo` stays scoped to `Topic`/`Queue`). Source of `routesTo` (→ `Service`/`Function`/`Gateway`) to deliver matched events to consumers. MAY declare `monitoredBy`/`protectedBy`.

**Outputs.** `identifier`, `endpoint` (the ingest locator producers connect to).

**Provider Mapping** *(informative)*

| AWS | Azure | GCP | Kubernetes |
|---|---|---|---|
| EventBridge event bus | Event Grid topic | Eventarc | Knative Eventing broker |

**Example**

```yaml
resources:
  events:
    kind: EventBus
    spec:
      sources: [internal, partner]
      rules:
        - name: order-events
          eventPattern: { detailType: [OrderPlaced, OrderShipped] }
      schemaRegistry: managed
      retention: 24h
    relationships:
      - { type: routesTo, target: order-worker }
```
