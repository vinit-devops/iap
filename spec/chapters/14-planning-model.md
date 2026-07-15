# 14. Planning Model

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter defines how a conformant planner turns a change of intent into a deterministic, reviewable, executable **plan**: the pipeline, the diff taxonomy, the execution graph and its parallelism rules, plan determinism, rollback, failure recovery, drift, and reconciliation. Everything in this chapter operates to the right of the authoring boundary and is therefore governed by the Layer Boundary Invariant ([Chapter 1, §1.4](01-architecture.md#14-the-layer-boundary-invariant)): every step is a pure, deterministic function, and no AI inference participates in any of it.

## 14.1 The Planning Pipeline

A plan is produced in four stages, each a pure function of the previous stage's output:

```
canonical document ──▶ normalized graph ──▶ diff vs. infrastructure model ──▶ execution graph
     (§1.5)              (Ch. 4, Ch. 9)              (§14.2)                      (§14.3)
```

1. **Canonicalization.** The source document and active profile are reduced to canonical form ([Chapter 1, §1.5](01-architecture.md#15-canonical-form)). All validation phases ([Chapter 8](08-validation.md)) MUST pass before planning proceeds; a planner MUST refuse a document with any `deny`-level finding.
2. **Normalization.** Relationships are flattened to canonical edges and the derived dependency graph is computed ([Chapter 4](04-relationship-model.md), [Chapter 9](09-dependency-model.md)). Ordering cycles have already failed validation (IAP4xx).
3. **Diff.** Each resource in the canonical document is compared against its object in the infrastructure model ([Chapter 13](13-infrastructure-model.md)) by identity `(document name, resource id)`, classifying every resource into the taxonomy of [§14.2](#142-diff-taxonomy).
4. **Execution graph.** The dependency DAG is restricted to the changed set plus impacted dependents ([§14.3](#143-the-execution-graph)) and scheduled into waves ([§14.4](#144-parallelism-and-waves)).

## 14.2 Diff Taxonomy

Every resource receives exactly one classification:

| Class | Condition | Action |
|---|---|---|
| `create` | Resource id present in the canonical document, absent from the model. | Provision. |
| `update-in-place` | `intentHash` differs and every changed field is mutable per the kind's lifecycle rules. | Modify without recreating. |
| `replace` | `intentHash` differs and at least one changed field is immutable-after-create per the kind's lifecycle rules. | Create successor, rebind, delete predecessor. |
| `delete` | Object present in the model (`ready`, `failed`, or `orphaned`), resource id absent from the canonical document. | Deprovision (or transition to `orphaned` under a retention policy). |
| `no-op` | `intentHash` equal, edge set unchanged, object status `ready`. | Excluded from the execution graph. |

Additional normative rules:

- Field mutability is not defined here: **replacement rules defer to the per-kind lifecycle rules in [Chapter 3](03-resource-model.md)** (e.g. `Database.spec.engine` is immutable-after-create; `scaling.max` is mutable). Mappings MAY further restrict mutability via their fail-closed coverage matrix ([Chapter 12](12-provider-mapping.md)) but MUST NOT widen it.
- **Stateful kinds MUST NOT be auto-replaced.** For kinds designated stateful in [Chapter 3](03-resource-model.md) — `Database`, `Volume`, `ObjectStore`, `Queue`, `Topic`, and `Secret` — a diff that classifies as `replace` MUST fail the plan with an error rather than schedule replacement. The plan proceeds only with an explicit, per-resource replacement authorization supplied to the planner, and even then MUST include the data-handling steps of [§14.6](#146-rollback).
- An object in `failed` or `pending` status with an equal `intentHash` is classified `update-in-place` (a retry of the same intent), never `no-op`.
- Edge changes are diffed with the same machinery: an added, removed, or modified canonical edge marks its **source** resource changed.

## 14.3 The Execution Graph

The execution graph is the derived dependency DAG ([Chapter 9](09-dependency-model.md)) **restricted to changed nodes plus impacted dependents**:

- **Changed nodes** — every resource classified `create`, `update-in-place`, `replace`, or `delete`.
- **Impacted dependents** — every resource, transitively, with an ordering edge into a changed node. Dependents of a `replace` or `create` join as change nodes if any bound output they consume may change; otherwise (and for all dependents of `update-in-place` nodes) they join as **verify nodes**, whose only step is re-confirming readiness and binding validity after their dependency settles.
- Ordering edges between included nodes are preserved; where an excluded (`no-op`) node lies on a path between two included nodes, the planner MUST insert the transitive ordering edge so that ordering guarantees survive restriction.
- `delete` nodes are ordered in **reverse**: a deleted resource is removed only after every deleted resource that depends on it.

## 14.4 Parallelism and Waves

- Two nodes with **no directed path between them MAY execute concurrently**. Engines are free to exploit any degree of parallelism the substrate tolerates.
- Engines **MUST respect every ordering edge**: no step for a node may begin until every node it depends on has reached `ready` (or completed deletion, for reverse-ordered deletes).
- The plan presents its schedule as **waves**: wave *n* contains every node whose longest dependency path within the execution graph has length *n*. Waves are the deterministic, human-reviewable presentation of the schedule; within a wave, nodes are listed in lexicographic resource-id order. An engine MAY execute more aggressively than the wave presentation (any topological schedule is conformant) but MUST NOT execute an ordering edge backwards.

## 14.5 Plan Determinism

Planning is a pure function:

> Given the same canonical document, the same infrastructure model snapshot, and the same mapping artifacts, a conformant planner MUST produce an **identical plan** — byte-identical in canonical serialization.

The plan's canonical serialization follows the same rules as document canonical form (sorted keys, canonical quantities, UTF-8 JSON), and its SHA-256 hash is the **`planId`** recorded in the infrastructure model and deployment history ([Chapter 13, §13.4](13-infrastructure-model.md#134-state-document-metadata-and-deployment-history)). The machine-readable expression of the plan artifact (`plan.iap.dev/v1`) is [`schema/plan-v1.schema.json`](../schema/plan-v1.schema.json), defined by IEP-0011. Consequences: plans are cacheable, review approvals can bind to a `planId` knowing the executed plan cannot silently differ, and two independent implementations can be conformance-tested for identical output ([Chapter 24](24-conformance.md)). No wall-clock, network, or random input may influence plan content; timestamps appear only in history records, never inside a plan.

## 14.6 Rollback

A **rollback is a plan like any other**: the operator selects a prior `succeeded` revision from deployment history, the engine retrieves the canonical document identified by that revision's `documentHash`, and the planner diffs it against the current infrastructure model. Rollback introduces no second code path — determinism, waves, and failure semantics all apply unchanged.

Stateful resources receive additional protection:

- If rolling back would `replace` or `delete` a stateful resource, or revert a change that affected stored data, the plan MUST include **data-restore steps derived from the resource's resilience intent** — e.g. restore to the recovery point closest to the target revision's timestamp, within the declared `recoveryPointObjective` ([Chapter 3](03-resource-model.md)).
- If the resource declares `resilience.backup: none`, no restore source exists; the planner MUST fail the rollback for that resource rather than proceed. **Silent destruction of data is never a permitted rollback step.** An explicit per-resource override (accepting data loss) is required to proceed, and is recorded in the history entry's actor context.

## 14.7 Failure Recovery

Execution failures follow **halt-wave semantics**:

1. When a node's apply step fails, steps already in flight in the same wave **run to completion** (mid-flight cancellation of provisioning operations is more dangerous than finishing them).
2. All not-yet-started nodes that transitively depend on the failed node are **cancelled** and remain `pending`. Independent branches of the graph MAY continue at the engine's discretion; engines MUST support a strict mode that cancels everything not in flight.
3. The failed node's object is set to `failed`; the history entry for the plan records outcome `partial`.

A partial apply therefore leaves the infrastructure model exactly describing reality: some objects `ready` at the new intent, the failed object `failed`, cancelled objects `pending`. Recovery is **re-planning**: running the planner again against the same document diffs the model as it now stands and produces a plan containing only the unfinished work ([§14.2](#142-diff-taxonomy) classifies retries as `update-in-place`). There is no separate "resume" mechanism to keep consistent — resume *is* re-plan.

## 14.8 Drift

**Detection.** Drift is detected by comparing observed substrate state against the model and the canonical document. The observation is obtained through the **mapping's inverse projection**: the mapping ([Chapter 12](12-provider-mapping.md)) reads provider state and projects it back into abstract attribute space, so core tooling compares abstract values against `boundOutputs` and declared intent — provider attributes never cross into core tooling. Inverse projection MUST be a pure function of the observed snapshot.

**Classification.** Every detected divergence is classified:

| Class | Meaning | Response |
|---|---|---|
| `reconcilable` | The substrate diverges from intent in a way re-applying the existing plan projection corrects (e.g. a capacity setting was changed out-of-band). | Eligible for automatic re-apply under a reconciliation mode. |
| `conflicting` | Reality and intent disagree in a way re-apply would destroy information or contradict an apparent deliberate change (e.g. an immutable field differs, or data-bearing state changed). | MUST be surfaced for manual resolution; engines MUST NOT auto-overwrite. |
| `out-of-scope` | The divergence concerns attributes owned by an extension namespace, not by core intent. | Delegated to the owning extension's tooling ([Chapter 11](11-extension-framework.md)); core reconciliation ignores it. |

## 14.9 Reconciliation Modes

Engines offer three reconciliation modes; all reuse the standard pipeline and differ only in trigger:

- **`manual`** — drift detection and re-apply run only when an operator invokes them.
- **`scheduled`** — detection runs on a fixed interval; `reconcilable` drift produces a plan that is applied automatically or queued for approval, per configuration.
- **`continuous`** — detection runs on substrate change signals as delivered through the mapping; otherwise identical to `scheduled`.

In every mode, the corrective action is a plan produced by the deterministic pipeline of [§14.1](#141-the-planning-pipeline) — same inputs, same plan, same `planId`. **AI systems are never in the reconciliation loop**: they neither detect, classify, decide, nor apply ([Chapter 19](19-ai-guidelines.md)). Monitors update `health` and drift findings; only engines execute plans.

## 14.10 Worked Example

Consider a deployed document with four resources: `edge` (Gateway) `routesTo` `web` (Service); `web` `connectsTo` `orders-db` (Database) and `session-cache` (Cache); plus `assets` (ObjectStore), unconnected. All objects are `ready`. The author changes one field:

```yaml
# before                                   # after
session-cache:                             session-cache:
  kind: Cache                                kind: Cache
  spec:                                      spec:
    engine: redis-compatible                   engine: redis-compatible
    capacity:                                  capacity:
      memory: 1Gi                                memory: 2Gi
```

Diff: `session-cache` → `update-in-place` (`capacity.memory` is mutable per [Chapter 3](03-resource-model.md)); `orders-db`, `assets` → `no-op`. Impacted dependents: `web` (consumes `session-cache`; joins as a verify node since an in-place resize leaves `boundOutputs` unchanged) and, transitively, `edge` (verify node behind `web`). The plan, in wave presentation:

```yaml
planId: "sha256:3d97a1…"
waves:
  - - { resource: session-cache, action: update-in-place, fields: [spec.capacity.memory] }
  - - { resource: web,   action: verify }
  - - { resource: edge,  action: verify }
```

Had the author also flipped `assets` to `versioning: enabled`, that node — sharing no path with `session-cache` — would join wave 1 and MAY execute concurrently. Had the author instead changed `session-cache.spec.engine` to `memcached-compatible`, the diff would classify as `replace`; and because `Cache` carries session state considerations but is not a designated stateful kind, replacement proceeds — whereas the same edit on `orders-db.spec.engine` would fail the plan outright under the stateful-kind rule of [§14.2](#142-diff-taxonomy). If the wave-1 update failed mid-flight, `session-cache` would be marked `failed`, `web` and `edge` would remain `pending`, and re-running the planner would emit exactly the remaining work.
