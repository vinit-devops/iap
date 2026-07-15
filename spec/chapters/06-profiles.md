# 6. Profiles

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

## 6.1 Overview

A **profile** is a named overlay that transforms a base IaP document into a variant of itself. Profiles express every axis of controlled variation — deployment environments, compliance postures, cost postures — without duplicating the document.

**Environments are profiles.** This is normative: IaP has no `environment` top-level key, no per-resource environment field, and no environment-conditional syntax. A document that behaves differently in staging and production MUST express that difference as two profiles. Anything a tool would call an "environment" is, in IaP terms, exactly a profile name.

Profiles are declared in the top-level `profiles` map defined in [Chapter 2](02-document-layout.md). Each key is a profile name conforming to the identifier grammar (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`); each value is a profile object.

## 6.2 The Profile Object

| Field | Type | Required | Semantics |
|---|---|---|---|
| `description` | string | no | Human-readable purpose of the profile. |
| `extends` | identifier | no | Name of exactly one other profile in the same document whose overrides are applied first. |
| `overrides` | object | no | An RFC 7386 JSON Merge Patch applied to the document. |

A profile with no `overrides` is valid and merges as the empty patch (identity).

## 6.3 Activation

**Exactly one profile is active per plan.** Tools MUST require a single selected profile when producing a canonical document, plan, or provider mapping input. Selecting zero profiles or more than one profile for a single plan is an error. A document MAY be validated with no profile selected (see [Chapter 8](08-validation.md), which defines pre-merge and post-merge validation), but every plan is relative to one profile.

Profiles do not compose at activation time. If two postures must combine (for example, production **and** a regulated-data posture), the composition MUST be expressed statically with `extends` (Section 6.5).

## 6.4 Merge Semantics

Profile application is **RFC 7386 JSON Merge Patch**, applied to the whole document in this order:

1. the base document;
2. the `overrides` of each profile in the `extends` chain, **root first**;
3. the `overrides` of the selected profile last.

The RFC 7386 rules apply without modification:

- **Objects deep-merge**: keys present in the patch replace or recurse into keys in the target; keys absent from the patch are untouched.
- **Arrays replace wholesale**: a patched array replaces the entire base array. There is no element-level array merge. Authors overriding one element of `relationships`, `policies`, or `ports` MUST restate the full array.
- **`null` deletes**: a patch value of `null` removes the key from the target.

Consequences, all normative:

- Profiles **MAY add resources**: a key under `overrides.resources` that does not exist in the base document creates that resource in the merged result.
- Profiles MAY delete resources or fields by patching them to `null`.
- `overrides` MUST NOT contain the `profiles` key. A profile that rewrites the profile set would make merge order self-referential; validators MUST reject this.
- The merged result **MUST itself be a valid IaP document** and is re-validated post-merge through the full pipeline of [Chapter 8](08-validation.md). A patch that deletes a required field, sets an invalid enum value, or strands a relationship target produces ordinary validation errors against the merged document.
- The merged document is the **canonical document** ([Chapter 1](01-architecture.md)): it is the sole input to policy evaluation ([Chapter 7](07-policy-language.md)), planning ([Chapter 14](14-planning-model.md)), and provider mapping ([Chapter 12](12-provider-mapping.md)). The retained `profiles` block is inert after merge.

Because JSON Merge Patch is a pure function and the application order is fixed, profile merging is deterministic: identical base, chain, and selection yield a byte-identical canonical document.

## 6.5 `extends`

A profile MAY name **one** parent via `extends`. Chains of any length are allowed (`production` → `staging` → `base-hardening`); the chain is applied root first, so nearer profiles win on conflicting keys. A profile MUST NOT appear twice in its own chain: `extends` cycles and references to undefined profiles are reference errors (IAP2xx, [Chapter 8](08-validation.md)) and MUST abort the merge.

`extends` is single-inheritance by design. Diamond composition of overlays makes merge outcomes order-dependent and is excluded from v1.

## 6.6 Worked Example

Base document (abbreviated to the relevant parts):

```yaml
apiVersion: iap.dev/v1
metadata:
  name: order-platform
  owner: platform-team
profiles:
  staging:
    description: Pre-production verification.
    overrides:
      resources:
        api:
          spec:
            size: m
            scaling:
              max: 4
            configuration:
              LOG_LEVEL: info
        orders-db:
          spec:
            resilience:
              backup: required
  production:
    description: Production. Inherits staging hardening.
    extends: staging
    overrides:
      resources:
        api:
          spec:
            availability: high
            scaling:
              min: 2
              max: 10
            configuration:
              FEATURE_PREVIEW: null
        orders-db:
          spec:
            availability: high
            capacity:
              storage: 100Gi
        orders-cache:
          kind: Cache
          spec:
            engine: redis-compatible
            availability: high
resources:
  api:
    kind: Service
    labels:
      tier: backend
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/orders/api:1.8.2
      size: s
      exposure: internal
      availability: standard
      scaling:
        min: 1
        max: 2
      configuration:
        LOG_LEVEL: debug
        FEATURE_PREVIEW: "true"
    relationships:
      - type: connectsTo
        target: orders-db
        port: 5432
        protocol: tcp
        access: read-write
  orders-db:
    kind: Database
    spec:
      class: relational
      engine: postgresql
      capacity:
        storage: 20Gi
      resilience:
        backup: preferred
```

Planning with `production` selected applies `staging.overrides` first (root of the chain), then `production.overrides`. The merged `api` and the added `orders-cache`:

```yaml
resources:
  api:
    kind: Service
    labels:
      tier: backend
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/orders/api:1.8.2
      size: m                    # staging
      exposure: internal         # base, untouched
      availability: high         # production
      scaling:
        min: 2                   # production (staging left base value 1)
        max: 10                  # production (over staging's 4)
      configuration:
        LOG_LEVEL: info          # staging
                                 # FEATURE_PREVIEW deleted by production's null
    relationships:               # base array retained: no patch touched it
      - type: connectsTo
        target: orders-db
        port: 5432
        protocol: tcp
        access: read-write
  orders-db:
    kind: Database
    spec:
      class: relational
      engine: postgresql
      availability: high         # production
      capacity:
        storage: 100Gi           # production (deep-merged into capacity)
      resilience:
        backup: required         # staging
  orders-cache:                  # added by the production profile
    kind: Cache
    spec:
      engine: redis-compatible
      availability: high
```

Note the two merge behaviors on display: `scaling` deep-merged key by key across the chain, while `relationships` — an array — would have been replaced wholesale had any profile patched it.

## 6.7 Built-in Profile Library (Informative)

This section is **informative**. The specification reserves no profile names; a document defining a profile named `production` owes nothing to this section. Tools SHOULD, however, offer these profiles as scaffolding, and the field values below are the recommended meaning of each name. Field paths refer to the common vocabulary of [Chapter 3](03-resource-model.md); each override applies only to kinds that carry the field.

Environment postures and regulatory postures compose with `extends` — a common pattern is `production` extending `soc2` or `pci`.

### `production`

| Field | Override |
|---|---|
| `spec.availability` | `high` |
| `spec.resilience.backup` | `required` |
| `spec.scaling.min` | `2` or greater (no single-instance serving path) |
| `spec.observability.logs` / `metrics` | `required` / `required` |

### `development`

| Field | Override |
|---|---|
| `spec.size` | `xs` or `s` |
| `spec.availability` | `standard` |
| `spec.resilience.backup` | `none` |
| `spec.scaling` | `min: 1, max: 1` |
| `spec.observability` | `logs: preferred`, `metrics: none`, `traces: none` |

### `pci`

Pairs with `compliance.frameworks: [pci-dss-4.0]` ([Chapter 17](17-compliance-model.md)); the profile sets the posture, the framework bundle enforces it.

| Field | Override |
|---|---|
| `spec.encryption.atRest` / `inTransit` | `required` (re-asserted explicitly; never `preferred`) |
| `spec.exposure` | `private` (workloads and data stores); gateways `internal` unless explicitly public-facing |
| `spec.versioning` (ObjectStore) | `enabled` |
| `spec.rotation.policy` (Secret) | `required` |
| `spec.observability.logs` | `required` on every resource that carries it |

### `soc2`

Pairs with `compliance.frameworks: [soc2]`.

| Field | Override |
|---|---|
| `spec.observability.logs` / `metrics` | `required` / `required` |
| `spec.resilience.backup` | `required` on data kinds |
| `spec.rotation.policy` (Secret) | `required` |
| `spec.encryption.atRest` / `inTransit` | `required` |

### `startup`

Cost-lean defaults for teams optimizing spend over redundancy.

| Field | Override |
|---|---|
| `spec.size` | `s` |
| `spec.availability` | `standard` |
| `spec.scaling` | `min: 1`, modest `max` |
| `spec.resilience.backup` | `preferred` |
| `spec.observability` | `logs: required`, `metrics: preferred`, `traces: none` |
| `spec.messageRetention` (Queue, Topic) | shortened, e.g. `3d` |

### `enterprise`

| Field | Override |
|---|---|
| `spec.availability` | `high` (`maximum` for tier-critical data stores) |
| `spec.resilience.backup` | `required`, with explicit `recoveryPointObjective` / `recoveryTimeObjective` |
| `spec.rotation.policy` (Secret) | `required` |
| `spec.observability` | `logs: required`, `metrics: required`, `traces: required` |
| `spec.exposure` | `internal` or `private`; public exposure only on gateways |

Typically paired with `compliance.frameworks: [soc2, iso27001-2022]`.

## 6.8 Interaction with Other Mechanisms

- **Policies** ([Chapter 7](07-policy-language.md)) evaluate against the merged document only. A profile can therefore *cause* or *cure* a policy violation; there is no per-profile policy scoping in v1 — but because profiles may patch the `policies` array (wholesale, per Section 6.4), a profile MAY carry additional policies.
- **Extensions** in `overrides` obey the Extension Non-Interference Rule of [Chapter 11](11-extension-framework.md) exactly as in the base document.
- **Provider mappings** ([Chapter 12](12-provider-mapping.md)) never see profile names: they consume the canonical merged document. A mapping keyed on "which environment is this" is non-conformant.
