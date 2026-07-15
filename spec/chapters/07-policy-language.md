# 7. Policy Language

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

## 7.1 Design Goals

The IaP policy language expresses organizational governance — "encryption is mandatory", "nothing public", "stay under budget" — directly inside the document, in the same declarative YAML as the resources it governs.

Three properties are non-negotiable:

1. **Declarative.** A policy states a condition over resource fields and an effect. It never states *how* to check.
2. **Deterministic by construction.** Every rule is a finite tree of structural matchers. Evaluation is a total, terminating, side-effect-free function of the canonical document; identical inputs yield identical findings, byte for byte.
3. **No embedded expression language in v1.** There is no Rego, no CEL, no templating, no arithmetic, no function calls. This is a deliberate exclusion, not a gap: general-purpose expression languages reintroduce non-obvious evaluation order, environment-dependent behavior, and an unbounded audit surface. Anything the structural matchers cannot express belongs in a dedicated validation phase ([Chapter 8](08-validation.md)) or a future minor.

Policies live in the top-level `policies` array ([Chapter 2](02-document-layout.md)). Compliance frameworks activate pre-packaged policy bundles through the same machinery ([Chapter 17](17-compliance-model.md)).

## 7.2 Rule Anatomy

| Field | Type | Required | Semantics |
|---|---|---|---|
| `id` | identifier | yes | Unique among policies in the document; used in findings and evaluation ordering. |
| `description` | string | no | Human-readable intent of the rule. |
| `target` | object | yes | Which resources the rule evaluates against. |
| `target.kinds` | array of kind names | no | Restrict to these kinds. Omitted: all kinds. |
| `target.selector` | selector | no | Label selector ([Chapter 4](04-relationship-model.md)); every listed label must match exactly (logical AND). Omitted: all resources. |
| `rule` | condition tree | yes | The condition (Section 7.3). |
| `effect` | `deny` \| `warn` \| `require` | yes | What a match means (Section 7.5). |
| `params` | map of scalars | no | Inert metadata for tooling and reporting (units, ticket links, thresholds for display). Parameters never alter evaluation. |

A resource is **targeted** when it matches both `kinds` (if present) and `selector` (if present). `target: {}` targets every resource in the document.

## 7.3 Condition Trees

A condition is either a **leaf** or a **combinator**:

- Leaf: `{field, operator, value?}`.
- Combinators: `{allOf: [...]}` (logical AND, at least one child), `{anyOf: [...]}` (logical OR, at least one child), `{not: <condition>}`. Combinators nest to any depth.

`field` is a dot path resolved from the **resource entry root** — so `kind`, `labels.team`, `spec.encryption.atRest`, and annotation paths such as `x-iap-cost.monthly` are all valid. Path segments are literal keys; there are no wildcards, indexing, or quantifiers over arrays in v1.

**Unresolved paths.** If a path does not resolve to a value: `absent` evaluates **true**, `exists` evaluates **false**, and every other operator evaluates **false**. Authors who mean "missing or wrong" combine explicitly: `anyOf: [{field: f, operator: absent}, {field: f, operator: not-equals, value: v}]`.

## 7.4 Operator Semantics

| Operator | `value` | Semantics |
|---|---|---|
| `equals` | required, scalar | Deep equality after canonicalization. |
| `not-equals` | required, scalar | Negation of `equals` on a resolved path (unresolved → false, per 7.3). |
| `in` | required, array | Resolved value is `equals` to some element. |
| `not-in` | required, array | Resolved value is `equals` to no element. |
| `exists` | forbidden | Path resolves to any value (including `false`, `0`, `""`). |
| `absent` | forbidden | Path does not resolve. |
| `greater-than` | required | Ordered comparison; resolved value strictly greater (see below). |
| `less-than` | required | Ordered comparison; resolved value strictly less. |
| `matches` | required, string | Resolved value is a string and matches the pattern as an **RE2** regular expression (unanchored; anchor with `^`/`$`). RE2 guarantees linear-time matching — no backtracking constructs. |

**Ordered comparisons.** `greater-than` and `less-than` are defined over exactly three domains:

- **Numbers** compare numerically.
- **Quantities** — strings conforming to the canonical quantity grammar of [Chapter 2](02-document-layout.md) (`100Gi`, `500m`, `2`) — compare by canonical magnitude, so `value: 50Gi` against a field holding `100Gi` behaves as expected.
- **Durations** — strings conforming to the duration grammar (`30s`, `1h`, `7d`) — compare by canonical magnitude in milliseconds.

Both operands must fall in the same domain. Any other pairing (string vs number, quantity vs duration, booleans, objects) is a **type mismatch**: the leaf evaluates **false** and validators SHOULD report the diagnostic warning IAP504 so silent misconfigurations surface.

## 7.5 Effect Semantics

The condition's polarity depends on the effect:

- **`deny`** — the condition describes the **forbidden state**. For every targeted resource where the condition evaluates true, validation **fails** with error **IAP501**.
- **`require`** — the condition describes the **mandatory state**: it MUST hold for every targeted resource. Where it evaluates false, validation fails with error **IAP502**. Because a `require` rule whose condition is a conjunction of `equals` leaves fully determines the compliant field values, tools MAY offer a **deterministic autofix** — set each `field` to its `value` — presented as a proposed document edit, never applied silently. Autofix eligibility is **limited to `equals` leaves and `allOf` conjunctions of them**; conditions using any other operator (`in`, `matches`, ordered comparisons, `anyOf`, `not`) do not determine a unique compliant value and are report-only.
- **`warn`** — like `deny` (condition true = finding), but the finding is a **warning**, code **IAP503**, and never fails validation.

## 7.6 Evaluation Model

1. **Input.** Policies evaluate against the **canonical document**: the base document with the active profile merged ([Chapter 6](06-profiles.md)) and all schema defaults applied. A resource that omits `encryption` still evaluates with `spec.encryption.atRest: required`, because that is the applied default. Policies never see the pre-merge document.
2. **Coverage.** Every policy evaluates against every resource it targets. There is no short-circuiting across resources and no rule precedence: policies are independent; all findings from all policies are reported.
3. **Order.** Evaluation and finding order are deterministic: policies in lexicographic order of `id`, and within each policy, resources in lexicographic order of resource ID. Two conformant validators produce identically ordered findings ([Chapter 24](24-conformance.md) tests this).
4. **Scope.** A condition sees exactly one resource at a time. Cross-resource invariants ("every Service must connect to a Database") are out of scope for the policy phase and belong to relationship, security, or compliance validation ([Chapter 8](08-validation.md)).

Policy evaluation is Phase 5 of the validation pipeline; its error space is **IAP5xx** ([Chapter 8](08-validation.md)).

## 7.7 Worked Examples: the Canonical Governance Set

### Encryption required

Defaults already make encryption `required` ([Chapter 3](03-resource-model.md)); this rule catches documents that explicitly weakened it to `preferred`, and is autofix-eligible.

```yaml
policies:
  - id: encryption-at-rest-required
    description: Data at rest is always encrypted; preferred is not acceptable.
    target:
      kinds: [Database, Cache, ObjectStore, Volume, Queue, Topic]
    rule:
      field: spec.encryption.atRest
      operator: equals
      value: required
    effect: require
```

### Maximum cost

Resources carry no prices; cost estimates are attached to the canonical document by tooling as `x-iap-cost` annotations before Phase 5 runs, using the interface of [Chapter 16](16-cost-model.md). The `exists` guard makes un-estimated resources pass this rule (pair with a `require exists` rule to force estimation).

```yaml
  - id: max-monthly-cost
    description: No single resource may be estimated above 500 per month.
    target: {}
    rule:
      allOf:
        - field: x-iap-cost.monthly
          operator: exists
        - field: x-iap-cost.monthly
          operator: greater-than
          value: 500
    effect: deny
    params:
      currency: USD
```

### Allowed regions

IaP documents are placement-neutral: **region is a deployment-target parameter, not a resource field** — model it as a label. Two rules cooperate: one requires the label, one constrains it.

```yaml
  - id: region-label-required
    description: Every resource declares its placement region as a label.
    target: {}
    rule:
      field: labels.region
      operator: exists
    effect: require

  - id: allowed-regions
    description: Only approved regions.
    target: {}
    rule:
      field: labels.region
      operator: not-in
      value: [eu-central, eu-west]
    effect: deny
```

### Required tags/labels

```yaml
  - id: required-labels
    description: Ownership and billing labels are mandatory.
    target: {}
    rule:
      allOf:
        - field: labels.team
          operator: exists
        - field: labels.cost-center
          operator: exists
    effect: require
```

### Private networking only

`Gateway` is excluded: gateways exist to expose traffic and cannot be `private` by schema; constrain them separately with `require` `internal` if even the entry point must stay off the internet.

```yaml
  - id: no-public-exposure
    description: Nothing but gateways may face the internet.
    target:
      kinds: [Service, ObjectStore]
    rule:
      field: spec.exposure
      operator: equals
      value: public
    effect: deny
```

### Backup required

Demonstrates selector targeting: only resources labeled critical.

```yaml
  - id: backup-required-critical
    description: Critical data stores must be backed up.
    target:
      kinds: [Database, ObjectStore, Volume]
      selector:
        labels:
          tier: critical
    rule:
      field: spec.resilience.backup
      operator: equals
      value: required
    effect: require
```

### Logging required

Targets exactly the kinds that carry the `observability` block ([Chapter 3](03-resource-model.md)).

```yaml
  - id: logs-required
    description: Log emission is mandatory wherever the platform can collect it.
    target:
      kinds: [Service, Job, Function, Gateway, Database, Cache, ObjectStore, Queue, Topic]
    rule:
      field: spec.observability.logs
      operator: equals
      value: required
    effect: require
```

## 7.8 What Is Deliberately Absent

No arithmetic, no string interpolation, no lookups into other resources, no time- or environment-dependent conditions, no user-defined functions. A policy file audited today evaluates identically forever against the same document — that guarantee is the point. Future minors MAY add operators (strictly additive, per [Chapter 10](10-versioning.md)); they will not add an expression language to v1.
