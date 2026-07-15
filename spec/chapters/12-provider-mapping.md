# 12. Provider Mapping

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

A provider mapping is the artifact that turns provider-free intent into a provider plan. This chapter defines the mapping artifact, its purity and coverage obligations, its realization and output-binding rules, and what it means for two providers to realize the same document "equivalently." This chapter is the **only** place in the core specification where provider nouns may appear, and they appear exclusively inside mapping examples and tables. The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in [Chapter 2](02-document-layout.md).

## 12.1 Mappings Are Separate Artifacts

Mappings live in their own files — `*.iap-map.yaml`, with `apiVersion: mapping.iap.dev/v1` — validated by [`iap-mapping-v1.schema.json`](../schema/iap-mapping-v1.schema.json). A mapping is **never embedded** in an IaP document: no mapping content, provider resource type, or realization hint may appear in a document's core fields (the separation mirrors the composite/composition split pioneered by Crossplane). The only provider-facing content a document may carry is `extensions.<ns>` refinement, which mappings MAY read as input under the non-interference constraints of [Chapter 11](11-extension-framework.md).

This separation is what makes the same document deployable to different providers: swap the mapping, keep the intent. Each mapping declares its own `version` (semver) and a `specCompat` range naming the specification versions it supports; a tool MUST refuse a mapping whose `specCompat` excludes the specification version in force ([Chapter 10](10-versioning.md)).

## 12.2 A Mapping Is a Pure Function

Applying a mapping is a pure function:

```
(canonical IaP document, active profile, mapping artifact) → provider plan
```

For identical inputs, a conforming mapping engine MUST produce **byte-identical canonical output**. The canonical document ([Chapter 1](01-architecture.md)) already has the active profile merged ([Chapter 6](06-profiles.md)), keys sorted, and quantities normalized, so the input side is deterministic by construction; the mapping engine must preserve that determinism through to the plan.

**No ambient lookups at mapping time.** The mapping engine MUST NOT consult provider account state, query what already exists, resolve "latest" anything (images, engine minor versions, zone lists), read the clock, or fetch remote data while producing the plan. Values of that sort, when a realization genuinely needs them, enter as **explicit mapping inputs**: named parameters supplied to the invocation, recorded in the plan, and included in the hashed input set for the determinism check. Reconciling the plan against live state is the planner's job ([Chapter 14](14-planning-model.md)), strictly after the plan exists.

Purity is what makes plans reviewable, diffable, cacheable, and reproducible in CI — and it is what keeps AI out of the execution path: nothing between canonical document and provider plan involves judgment.

## 12.3 Fail-Closed Coverage

Every kind entry in a mapping carries a `supports` matrix declaring **exactly** what the mapping can realize:

- `fields` — every supported field path on the kind;
- `values` — per-field allowed values, where the mapping supports only a subset of the specification's enum;
- `relationships` — the relationship verbs the mapping can realize for edges whose source is this kind.

Anything outside the declared matrix MUST be rejected with an error identifying the unsupported kind, field, value, or verb. **Silently dropping a field is a conformance failure** — the single worst failure mode a mapping can have, because the document would claim an intent the deployed infrastructure does not honor. A document using `availability: maximum` against a mapping whose matrix allows only `standard` and `high` fails loudly at mapping time, not quietly at 3 a.m.

The same fail-closed posture applies across versions: a mapping engine that encounters a construct from a newer specification minor MUST reject it rather than emit the IAP804 warning a validator would ([Chapter 10](10-versioning.md)) — warnings are for humans reading validation output; plans must be complete or absent.

## 12.4 Realization Rules

Each kind maps through an ordered list of `realize` rules. Evaluation is deterministic:

1. Rules are evaluated in document order; the **first rule whose `when` clause matches applies** and evaluation stops. A rule with no `when` always matches and typically terminates the list as the default case.
2. `when` is a map of field path → exact value; all entries must hold. There are no expressions, regexes, or lookups — matching is structural equality against the canonical document, keeping rule selection trivially deterministic.
3. `targets` names the provider resource types the rule produces, as provider-namespaced identifiers (`aws:rds:DBInstance`).
4. `derive` deterministically computes provider attributes from IaP fields. Each entry uses exactly one of three forms: `constant` (fixed value), `from` alone (the canonical field value carries over verbatim), or `from` + `map` (exact value lookup). **A `map` MUST cover every supported value of its source field** — every value the `supports` matrix admits (or, if unconstrained there, every value the specification defines). A gap between the supports matrix and a derive map is a mapping defect that conformance testing rejects; it can never surface as a runtime fallback.

If no rule matches a resource that is within the supports matrix, the mapping is defective and the engine MUST fail the run — supports and realize must tile each other exactly.

## 12.5 Output Binding

[Chapter 3](03-resource-model.md) declares, per kind, the **abstract output attributes** a realization must provide — for example `identifier`, `endpoint`, and `connectionSecret` for `Database`. The mapping's `outputs` section binds each abstract attribute to a provider plan attribute path.

**Every abstract attribute the core declares for a kind MUST be bound** by any mapping that supports that kind. This is what makes document-level `outputs` and cross-resource wiring portable: a consumer reads `endpoint` and never learns, or cares, which provider attribute supplied it. An unbound abstract attribute is a mapping conformance failure even if no document currently exports it.

## 12.6 Worked Example: AWS Reference Mapping

The following complete artifact validates against [`iap-mapping-v1.schema.json`](../schema/iap-mapping-v1.schema.json). It realizes `Database` (relational only) and `Queue`, and illustrates every rule above: a constrained supports matrix, first-match-wins ordering, total derive maps, and full output binding.

```yaml
apiVersion: mapping.iap.dev/v1
provider: aws
version: 1.2.0
specCompat: ">=1.0.0 <2.0.0"
description: Reference AWS mapping for relational Database and Queue.

mappings:
  Database:
    supports:
      fields:
        - spec.class
        - spec.engine
        - spec.engineVersion
        - spec.availability
        - spec.encryption.atRest
        - spec.encryption.inTransit
        - spec.exposure
        - spec.capacity.storage
        - spec.size
      values:
        spec.class: [relational]
        spec.engine: [postgresql, mysql]
        spec.availability: [standard, high]
        spec.exposure: [private]
      relationships: [dependsOn, connectsTo, storesDataIn, monitoredBy]
    realize:
      - when:
          spec.class: relational
        targets:
          - aws:rds:DBInstance
          - aws:rds:DBSubnetGroup
          - aws:secretsmanager:Secret
        derive:
          engine:
            from: spec.engine
            map:
              postgresql: postgres
              mysql: mysql
          multiAZ:
            from: spec.availability
            map:
              standard: false
              high: true
          storageEncrypted:
            from: spec.encryption.atRest
            map:
              required: true
              preferred: true
          allocatedStorage:
            from: spec.capacity.storage
          publiclyAccessible:
            constant: false
    outputs:
      identifier:
        from: aws:rds:DBInstance.dbInstanceIdentifier
      endpoint:
        from: aws:rds:DBInstance.endpoint
      connectionSecret:
        from: aws:secretsmanager:Secret.arn

  Queue:
    supports:
      fields:
        - spec.ordering
        - spec.delivery
        - spec.messageRetention
        - spec.encryption.atRest
      values:
        spec.ordering: [none, fifo]
        spec.delivery: [at-least-once]
    realize:
      - when:
          spec.ordering: fifo
        targets: [aws:sqs:Queue]
        derive:
          fifoQueue:
            constant: true
          messageRetentionPeriod:
            from: spec.messageRetention
      - targets: [aws:sqs:Queue]
        derive:
          fifoQueue:
            constant: false
          messageRetentionPeriod:
            from: spec.messageRetention
    outputs:
      identifier:
        from: aws:sqs:Queue.queueArn
      endpoint:
        from: aws:sqs:Queue.queueUrl
```

Reading the example against the rules:

- **Fail-closed in action.** `spec.availability` is constrained to `standard | high`: this mapping realizes a single-region instance and cannot attest the ≥99.99% SLO floor that `maximum` asserts, so a document declaring `maximum` is rejected — not silently downgraded. Likewise `spec.delivery: exactly-once` on a Queue is outside the matrix and rejects, because the realized target cannot honor it.
- **Total derive maps.** `multiAZ` covers exactly the two supported `availability` values; `storageEncrypted` covers both specification values of `encryption.atRest` (both map to `true` — a provider MAY exceed a `preferred` posture, never weaken a `required` one).
- **First match wins.** A `fifo` queue matches the first Queue rule; everything else falls through to the default rule. Reordering the rules would change behavior, which is why rule order is part of the mapping's identity and of its conformance hash.
- **Complete output binding.** `Database` binds all three abstract attributes the core declares for the kind; `Queue` binds its two. The `connectionSecret` binding is why `aws:secretsmanager:Secret` appears in `targets`: outputs can only bind to attributes of resources the rule actually produces.

## 12.7 Typical Realizations Across Providers

The table below is **illustrative, not normative** — it shows how independent mappings typically realize three kinds. Real mappings declare their exact choices in their own artifacts.

| Kind | `aws` | `azure` | `gcp` | `kubernetes` |
|---|---|---|---|---|
| `Service` | `aws:ecs:Service` on Fargate + `aws:elasticloadbalancing:TargetGroup` | `azure:containerapps:ContainerApp` | `gcp:cloudrun:Service` | `kubernetes:apps:Deployment` + `kubernetes:core:Service` + HorizontalPodAutoscaler |
| `Gateway` | `aws:elasticloadbalancing:LoadBalancer` (application) + `aws:acm:Certificate` | `azure:network:ApplicationGateway` + managed certificate | `gcp:compute:UrlMap` + `gcp:compute:TargetHttpsProxy` (global HTTPS load balancing) | `kubernetes:gateway:Gateway` + `kubernetes:gateway:HTTPRoute` |
| `Queue` | `aws:sqs:Queue` | `azure:servicebus:Queue` | `gcp:pubsub:Topic` + `gcp:pubsub:Subscription` (pull, single consumer) | `kubernetes:messaging:Queue` via an operator-managed broker (e.g. RabbitMQ) |

Note how differently the providers decompose the same kind — one target, two targets, a workload-plus-operator pair — without the document changing at all. Relationship realization diverges just as much: a `connectsTo` edge becomes security-group/firewall rules on the hyperscalers and a NetworkPolicy on Kubernetes, derived from the same canonical edge ([Chapter 4](04-relationship-model.md), [Chapter 15](15-security-model.md)).

## 12.8 One Document, Many Providers: What "Equivalent" Means

Applying different mappings to the same canonical document yields **equivalent outcomes, not identical resources**. Equivalence is defined over the document's capability assertions, not over provider inventories:

- every declared resource exists with its declared capability (`class`, `engine` compatibility, `capacity`, delivery/ordering semantics);
- every intent floor holds: `availability` SLO floors, `encryption` posture, `exposure` boundaries, `resilience` objectives;
- every relationship's semantic assertion is realized — reachability and access level for `connectsTo`, routing for `routesTo`, ordering for everything that implies it ([Chapter 4](04-relationship-model.md));
- every abstract output attribute resolves to a working value.

Equivalence explicitly does **not** require the same number of provider resources, the same performance beyond declared floors, or the same cost. Two mappings are equivalent for a document exactly when the conformance assertions of [Chapter 24](24-conformance.md) hold for both realizations. This is the specification's central promise: intent is the contract; realization is a substitutable detail.

## 12.9 Mapping Conformance

A mapping (and the engine applying it) conforms when, per [Chapter 24](24-conformance.md):

1. **Assertion tests pass** — for each supported kind/field/value combination, the produced plan satisfies the capability assertions of §12.8, exercised via the conformance corpus;
2. **Double-run hash equality holds** — applying the mapping twice to the same canonical inputs (document, profile, explicit inputs, mapping version) yields plans whose canonical serializations hash identically;
3. **Fail-closed behavior is demonstrated** — corpus documents outside the supports matrix are rejected with the correct diagnostics, and no test can exhibit a silently dropped field;
4. **Non-interference is preserved** — mappings never modify IaP semantics: applying a mapping MUST NOT alter the document, its canonical form, its validation outcome, or its normalized graph. A mapping consumes intent; it never edits it.
