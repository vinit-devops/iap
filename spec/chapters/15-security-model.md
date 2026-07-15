# 15. Security Model

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter defines how security posture is obtained from an IaP document. Its central rule is that security is **derived** from the model — from resource kinds, intent fields, and the relationship graph — never annotated onto it. There is no separate security description to keep synchronized with the architecture: the architecture *is* the security description. This chapter is normative except where marked otherwise.

## 15.1 Security Is Derived, Not Annotated

Conventional infrastructure descriptions treat security as a parallel artifact: permission policies, firewall rules, and encryption settings maintained alongside — and drifting from — the resources they protect. IaP forbids this structure. A conformant implementation MUST derive every security control from exactly three sources in the canonical document ([Chapter 1, §1.5](01-architecture.md)):

1. **Intent fields** with safe defaults — `encryption`, `exposure`, and the `Secret` kind's `rotation` block ([Chapter 3](03-resource-model.md)).
2. **The relationship graph** — canonical edges and their `access`, `port`, and `protocol` attributes ([Chapter 4](04-relationship-model.md)).
3. **Policies and compliance bundles** evaluated against the canonical document ([Chapter 7](07-policy-language.md), [Chapter 17](17-compliance-model.md)).

There is no fourth source. Implementations MUST NOT accept out-of-band security configuration that widens what the document declares, and MUST NOT require security metadata beyond the document to compute grants, reachability, or encryption posture. Provider-specific security refinements MAY appear in `extensions:` blocks, but under the Extension Non-Interference Rule ([Chapter 11](11-extension-framework.md)) they can only *narrow* derived posture, never widen it.

## 15.2 Identity

Workload identity is modeled with the `Identity` kind (`spec.type: workload`, the only identity type in v1). An `authenticatedBy` edge binds a workload resource (`Service`, `Job`, `Function`) to an `Identity` resource: the workload runs *as* that identity, and every grant derived from the workload's outbound edges (§15.3) is attached to that identity as the principal.

- A workload MUST have at most one `authenticatedBy` edge.
- Multiple workloads MAY share one `Identity`; the identity's derived grants are then the union of all bound workloads' edges. Tools SHOULD warn when sharing broadens any workload's effective access beyond its own edges.
- A workload with no `authenticatedBy` edge receives an implicit, anonymous per-workload identity with exactly its own derived grants. Declaring the `Identity` explicitly is RECOMMENDED whenever the identity is referenced elsewhere (for example by `outputs`).

**Human access is out of scope for IaP v1.** Interactive user accounts, directory federation, and console or break-glass access are operational concerns of the execution platform, not intent. Documents MUST NOT model human principals; a future minor revision may reserve an identity type for them.

## 15.3 Least Privilege by Construction

The **sole source of permissions** in IaP is the `access` attribute on relationship edges. This rule is absolute:

- An edge `connectsTo` with `access: read` MUST cause the engine to derive a **read-only** grant for the source's identity on the target — and nothing more.
- `access: write`, `read-write`, and `admin` derive correspondingly scoped grants, as defined per kind in [Chapter 3](03-resource-model.md).
- Edges that carry no `access` attribute derive connectivity (§15.4) but **no data-plane permission**.
- **No relationship → no access.** A resource pair with no edge between them MUST receive no grant of any kind.

Consequently, a conformant execution engine MUST NOT emit wildcard grants, default-allow permission sets, or any permission broader than the minimum required to satisfy the declared `access` level. A mapping or engine that produces such grants is non-conformant ([Chapter 24](24-conformance.md)), even if the underlying platform would otherwise default to them. Where a target platform cannot express a grant as narrowly as the edge declares, the mapping MUST fail closed ([Chapter 12](12-provider-mapping.md)) rather than approximate upward.

Rule edges in the top-level `relationships:` array derive grants identically after selector expansion; expansion happens during normalization, so the grant set is always computable from the canonical edge list alone.

## 15.4 Network Isolation and Zero Trust

The complete reachability graph of a document is defined by exactly two constructs:

1. Each resource's `exposure` field (`public` | `internal` | `private`, default `private`), which defines who may *initiate* traffic to it from outside the document's graph.
2. `connectsTo` (and `routesTo`) edges, which define which declared resources may reach which, on which `port` and `protocol`.

IaP is zero-trust by construction: **anything not declared is denied.** A conformant engine MUST configure the substrate so that:

- A `private` resource accepts traffic only from sources holding a declared edge to it, restricted to the declared port and protocol.
- No lateral path exists between resources that share a substrate but share no edge.
- `public` and `internal` exposure widen only *ingress* scope; they never create resource-to-resource permission or connectivity.

When an engine or mapping cannot enforce a declared isolation boundary — for example, the substrate cannot restrict traffic between two co-located resources — it MUST reject the plan with error **IAP604** (`isolation-unenforceable`) rather than deploy a weaker boundary silently.

## 15.5 Secrets

Secret material is modeled exclusively with the `Secret` kind. Two rules are normative:

1. **Secret values never appear in IaP documents.** A document contains a `Secret` resource's *intent* — its `source` (`generated` | `provided` | `external`) and `rotation` policy — never its value. Validators MUST reject documents containing secret material in any field with error **IAP602** (`secret-value-in-document`); validators SHOULD apply entropy and well-known-token heuristics to `configuration` maps and `x-*` fields to detect violations.
2. **Outputs are handles, not values.** The `connectionSecret` abstract attribute that data kinds declare ([Chapter 3](03-resource-model.md)) resolves to a *reference* to platform-held secret material. Generated credentials (`source: generated`) are created, stored, rotated, and injected entirely platform-side; they exist in no artifact of the four layers ([Chapter 1, §1.3](01-architecture.md)). Access to a secret's value is itself a grant, derived only from edges targeting the `Secret` (e.g. `connectsTo` with `access: read`).

## 15.6 Encryption

Both encryption dimensions default to `required`; omission never weakens posture ([Chapter 3](03-resource-model.md)). Downgrading either `encryption.atRest` or `encryption.inTransit` to `preferred` is permitted only as an **explicit, reviewable** declaration in the document — it is therefore always visible to policy evaluation and to diffing.

- `required`: the engine MUST provision encryption or fail the plan.
- `preferred`: the engine MUST provision encryption where the substrate supports it and MAY proceed without it otherwise, recording the outcome in the infrastructure model ([Chapter 13](13-infrastructure-model.md)).

When any `pci-dss-4.0` or `soc2` framework is active in `compliance.frameworks`, an explicit downgrade to `preferred` on a targeted resource MUST be reported with error **IAP603** (`encryption-downgrade-under-framework`) at validation time, in addition to any compliance finding the framework bundle itself raises (**IAP701**, [Chapter 17](17-compliance-model.md)).

## 15.7 Key Management

Encryption keys are **provider-managed by default**: the core vocabulary asserts *that* data is encrypted, not *with whose key*. Extension packages MAY refine key management — for example selecting customer-managed or externally held keys via an `extensions:` block — without changing core semantics: under the Extension Non-Interference Rule, deleting the refinement MUST leave a document whose derived posture (encrypted at rest and in transit) is unchanged. Key rotation, escrow, and residency are extension and mapping concerns in v1.

## 15.8 Policy Enforcement Points

Derived security is checked at three points; each later point trusts nothing from the earlier ones:

| Enforcement point | Where defined | What is enforced |
|---|---|---|
| **Validation time** | [Chapter 7](07-policy-language.md), [Chapter 8](08-validation.md) | Structural rules, policy conditions, IAP6xx security errors (IAP601–IAP603), compliance bundles (IAP7xx) |
| **Plan time** | [Chapter 14](14-planning-model.md) | Derived grants and the reachability graph MUST appear in plan output for review; fail-closed mapping coverage |
| **Apply time** | [Chapter 12](12-provider-mapping.md), [Chapter 14](14-planning-model.md) | The engine enforces exactly the planned grants and boundaries; drift from them is reportable drift ([Chapter 14](14-planning-model.md)) |

## 15.9 The Security Review Surface

Because every control derives from the document, the entire security posture is reviewable at intent level: approving a document diff *is* the security review. The following complete, schema-valid document illustrates the derivation.

```yaml
apiVersion: iap.dev/v1
metadata:
  name: orders
  owner: platform-team
resources:
  orders-api:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/orders-api:1.4.2
      exposure: private
    relationships:
      - type: authenticatedBy
        target: orders-identity
      - type: connectsTo
        target: orders-db
        port: 5432
        protocol: tcp
        access: read-write
      - type: connectsTo
        target: orders-cache
        port: 6379
        protocol: tcp
        access: read-write
  orders-db:
    kind: Database
    spec:
      class: relational
      engine: postgresql
  orders-cache:
    kind: Cache
    spec:
      engine: redis-compatible
  orders-identity:
    kind: Identity
    spec:
      type: workload
```

A conformant implementation derives the following least-privilege table — shown verbatim in plan output (§15.8) — with no additional input:

| Principal | Target | Derived grant | Justifying edge |
|---|---|---|---|
| `orders-identity` (bound to `orders-api`) | `orders-db` | data-plane read-write; read access to `orders-db`'s `connectionSecret` handle | `connectsTo` `access: read-write` |
| `orders-identity` | `orders-cache` | data-plane read-write | `connectsTo` `access: read-write` |
| *(any other pair)* | — | **no grant** | no edge |

And the complete reachability graph:

| Target | Accepts traffic from | Port/protocol | Everything else |
|---|---|---|---|
| `orders-db` | `orders-api` only | 5432/tcp | denied |
| `orders-cache` | `orders-api` only | 6379/tcp | denied |
| `orders-api` | nothing (no inbound edges, `exposure: private`) | — | denied |

Encryption at rest and in transit is `required` on all three data-bearing and serving resources by default; no secret value appears anywhere; the generated database credential flows platform-side and is readable only by `orders-identity`. A reviewer — or a compliance auditor ([Chapter 17](17-compliance-model.md)) — needs nothing beyond this document to evaluate the system's security posture.
