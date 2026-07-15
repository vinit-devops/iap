# 13. Infrastructure Model

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter defines the **infrastructure model**: the internal record an execution engine maintains of what it believes exists, per deployed document. The model is the engine-side counterpart of the intent document — it is what planning ([Chapter 14](14-planning-model.md)) diffs against, what drift detection compares to, and what deployment history is anchored in. It occupies the role a state file occupies in older tooling, but with a deliberately narrower contract: it is **derived data**, it contains **no provider attributes in its core fields**, it contains **no secret values**, and it is **reconstructible**.

## 13.1 Nature and Derivation

The infrastructure model is derived exclusively from two inputs:

1. the **canonical form** of the intent document ([Chapter 1, §1.5](01-architecture.md#15-canonical-form)) for the active profile, and
2. the **outcomes of deployments** executed by a conformant engine against that canonical form.

The following rules are normative:

- Exactly one infrastructure model instance exists per `(document name, active profile)` pair. Profiles are distinct deployment targets ([Chapter 6](06-profiles.md)); their models never merge.
- The model MUST NOT be hand-edited. A conformant engine MUST reject a model whose integrity metadata does not verify, and MUST treat any externally introduced change as corruption, not as input.
- The model is **not** a source of intent. No planning, mapping, or policy decision may read intent from the model; intent comes only from the canonical document. The model answers one question: *what happened last time, and what is the engine's current belief about the substrate?*
- The model MUST be reconstructible. Given the canonical document, the deployment history, and read access to the substrate through the mapping's inverse projection ([Chapter 14, §14.8](14-planning-model.md#148-drift)), an engine MUST be able to rebuild an equivalent model. Loss of the model is an inconvenience, never a catastrophe.

## 13.2 Objects

The model contains exactly one **object** per resource in the canonical document (plus objects in `orphaned` status; see below). An object records the engine's belief about one deployed resource.

**Identity.** An object is identified by the tuple `(document name, resource id)` — the `metadata.name` of the owning document and the key of the resource in the `resources:` map ([Chapter 2](02-document-layout.md)). There is no separate object identifier; renaming a resource id is indistinguishable from deleting one resource and creating another, and planners MUST treat it as such.

**Fields.** Every object carries the following fields and no others in its core representation:

| Field | Type | Meaning |
|---|---|---|
| `kind` | kind name | The resource's `kind` at the time of the last successful apply. |
| `intentHash` | string | SHA-256 over the canonical serialization of this resource's entry — its `kind`, `labels`, `spec`, and its canonical edges where it is the source — after canonicalization steps C1–C6. Equal hashes mean semantically identical intent ([Chapter 1, §1.5](01-architecture.md#15-canonical-form)). |
| `status` | enum | Lifecycle position; see [§13.5](#135-status-semantics). |
| `health` | enum | Observed runtime condition; see [§13.6](#136-health-semantics). |
| `boundOutputs` | map | Abstract output attributes → opaque handles; see below. |
| `providerState` | object | Opaque, mapping-owned cache; see below. |
| `lastAppliedRevision` | integer | The history revision ([§13.4](#134-deployment-history)) that last changed this object. |

**`boundOutputs`.** Each kind declares a set of abstract output attributes (`endpoint`, `connectionSecret`, `identifier`, …) in [Chapter 3](03-resource-model.md); the mapping binds each attribute to a provider plan attribute ([Chapter 12](12-provider-mapping.md)). After a successful apply, the engine records each binding's resolved value as an **opaque handle** — a string the core tooling stores, compares for equality, and passes to consumers, but never parses. Handles for `connectionSecret` attributes are **references into a secret system**, never secret material: the model stores where a credential can be resolved, not what it is.

**`providerState`.** A mapping MAY deposit an opaque object of provider-side bookkeeping (resolved identifiers, observed generation counters) to accelerate future diffs and drift checks. The following rules are normative:

- `providerState` is owned by the mapping namespace that wrote it. Core tooling MUST NOT read, interpret, validate, or transform its contents, and MUST NOT let any planning or policy decision depend on them.
- `providerState` is a **cache, not a source of truth**. A conformant engine MUST produce correct plans with `providerState` absent — deleting every `providerState` block from a model yields a valid model with identical planning semantics. (This mirrors the Extension Non-Interference Rule of [Chapter 11](11-extension-framework.md) on the state side.)

## 13.3 Edges

The model records the **normalized relationship set as deployed**: the canonical edge list `(source, type, target, attributes)` produced by canonicalization step C3 at the time of the last successful apply. Selector-based rule edges are stored only in resolved form — the model never contains selectors.

Recording edges allows the planner to detect relationship changes (a new `connectsTo`, a changed `access` level) with the same diff machinery used for resource fields, and allows security tooling ([Chapter 15](15-security-model.md)) to audit what connectivity and privilege was actually granted, not merely what is currently declared.

## 13.4 State Document Metadata and Deployment History

The model is serialized as a **state document** with the following top-level metadata, all of which is REQUIRED:

| Field | Meaning |
|---|---|
| `specVersion` | Exact IaP specification version (semver) the canonical form was produced under. |
| `mappingVersions` | Map of mapping namespace → mapping artifact version used at the last apply. |
| `profile` | The active profile this model belongs to. |
| `planId` | Identifier of the most recently applied plan ([Chapter 14, §14.5](14-planning-model.md#145-plan-determinism)). |
| `revision` | Monotonically increasing counter, incremented once per applied plan (including rollbacks). |

**Deployment history** is an append-only sequence of revision records. Entries MUST NOT be modified or deleted; engines MAY archive old entries elsewhere but MUST preserve the chain. Each record carries:

- `revision` — the counter value this apply produced;
- `planId` — the plan that was executed;
- `timestamp` — RFC 3339 UTC time the apply concluded;
- `documentHash` — SHA-256 of the full canonical document that was the plan's input;
- `outcome` — `succeeded` | `partial` | `failed` | `rolled-back`;
- `actor` — the authenticated principal (human or automation identity) that authorized the apply. Never an AI system: the Layer Boundary Invariant ([Chapter 1, §1.4](01-architecture.md#14-the-layer-boundary-invariant)) places AI outside the execution path, so no history entry can name one as actor.

The history serves two purposes: **audit** (who deployed what, when, with which mappings) and **rollback targets** — every `succeeded` revision's `documentHash` identifies a complete prior intent that [Chapter 14, §14.6](14-planning-model.md#146-rollback) can plan a return to.

## 13.5 Status Semantics

`status` describes where an object stands in its lifecycle. The closed enum:

| Status | Meaning |
|---|---|
| `pending` | Declared in the canonical document; no apply has yet acted on it (or its scheduled step was cancelled by halt-wave semantics). |
| `provisioning` | An apply step for this object is in flight. |
| `ready` | The last apply step succeeded and all bound outputs resolved. |
| `degraded` | Ready, but a monitor has observed a condition that reduces the delivered capability below declared intent (e.g. availability intent not currently met). |
| `failed` | The last apply step for this object failed; bound outputs may be stale or absent. |
| `deprovisioning` | A delete step is in flight. |
| `orphaned` | The object remains in the model but its resource id no longer appears in the canonical document — either awaiting a planned delete or deliberately retained by a retention policy. |

**Who writes status:** execution engines, and only execution engines, transition `status`, and only as a direct consequence of plan execution — `pending → provisioning → ready|failed`, `ready → deprovisioning → (removed)`, document removal → `orphaned`. The single exception: a monitor MAY transition `ready ↔ degraded` during reconciliation. No tool other than a conformant engine or monitor may write status.

## 13.6 Health Semantics

`health` is observational and orthogonal to status: `healthy` | `degraded` | `unhealthy` | `unknown`. It reflects the most recent probe of the running resource (health checks, SLO measurements, substrate signals surfaced through the mapping's inverse projection).

- **Monitors** write health during reconciliation ([Chapter 14, §14.9](14-planning-model.md#149-reconciliation-modes)). An object that has never been probed, or whose probes are stale beyond a configured horizon, MUST be marked `unknown` — engines MUST NOT let health default to `healthy`.
- Health never gates planning: a plan diff is computed from intent and `intentHash`, not from health. Health informs humans, dashboards ([Chapter 18](18-architecture-model.md)), and drift classification only.

## 13.7 Differences from Terraform State (non-normative)

This section is informative and names a specific product solely for contrast, following the convention of [Chapter 1, §1.7](01-architecture.md#17-comparison-with-existing-tools-non-normative).

Terraform state stores the full provider-attribute expansion of every resource — including, in many providers, secret material — and that state file is load-bearing: losing or corrupting it decouples the tool from reality, and "state surgery" is an accepted operational practice. The IaP infrastructure model differs on each point:

1. **No provider attributes in core state.** Core object fields hold only abstract data: kind, intent hash, status, health, and opaque output handles. Everything provider-shaped lives in `providerState`, which is namespaced, opaque, and disposable.
2. **No secrets in state.** `connectionSecret` outputs are stored as references into secret systems ([Chapter 15](15-security-model.md)). The state document is safe to store, replicate, and grant read access to without a secret-handling posture.
3. **Reconstructible, never load-bearing.** Because intent lives in the document and `providerState` is a cache, the model can be rebuilt from the document, the history, and the mapping's inverse projection. There is no state surgery: the remedy for a damaged model is regeneration, not hand-editing.
4. **History is first-class.** Terraform state records only the present; the IaP model's append-only history makes every prior successful revision an addressable rollback target.

## 13.8 State Document Sketch

The following JSON sketch is illustrative, not a normative schema; a machine-readable state schema is planned as a companion artifact.

```json
{
  "apiVersion": "state.iap.dev/v1",
  "document": "orders",
  "metadata": {
    "specVersion": "1.0.0",
    "profile": "production",
    "mappingVersions": { "aws": "2.3.1" },
    "planId": "sha256:6b1f0d2a9c…",
    "revision": 14
  },
  "objects": {
    "orders-db": {
      "kind": "Database",
      "intentHash": "sha256:9e41cc07b3…",
      "status": "ready",
      "health": "healthy",
      "lastAppliedRevision": 12,
      "boundOutputs": {
        "endpoint": "opaque:aws:ep-7c19f2…",
        "identifier": "opaque:aws:id-40aa81…",
        "connectionSecret": "secretref://org-vault/orders/orders-db-credentials"
      },
      "providerState": { "x-opaque": "owned by mapping namespace aws; never interpreted" }
    },
    "web": {
      "kind": "Service",
      "intentHash": "sha256:2f80b6e1aa…",
      "status": "ready",
      "health": "degraded",
      "lastAppliedRevision": 14,
      "boundOutputs": { "endpoint": "opaque:aws:ep-b02e55…" },
      "providerState": {}
    }
  },
  "edges": [
    { "source": "web", "type": "connectsTo", "target": "orders-db",
      "attributes": { "port": 5432, "protocol": "tcp", "access": "read-write" } }
  ],
  "history": [
    { "revision": 13, "planId": "sha256:d4c2…", "timestamp": "2026-07-01T09:12:44Z",
      "documentHash": "sha256:77aa…", "outcome": "succeeded", "actor": "vinit.kumar@example.org" },
    { "revision": 14, "planId": "sha256:6b1f…", "timestamp": "2026-07-08T15:03:10Z",
      "documentHash": "sha256:8c3e…", "outcome": "succeeded", "actor": "deploy-automation" }
  ]
}
```

How this model is diffed, planned against, and reconciled is the subject of [Chapter 14](14-planning-model.md).
