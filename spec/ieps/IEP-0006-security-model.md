# IEP-0006: Security Model

| Field | Value |
|---|---|
| **Title** | Security model: derived posture, least privilege by construction, zero trust |
| **Number** | IEP-0006 |
| **Status** | Implemented (retroactive) |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | 1.0.0 |

## Summary

Retroactively formalizes the v1 security model: security posture is **derived** from exactly three sources — intent fields with safe defaults, the relationship graph, and policies/compliance bundles — and never annotated onto the document. Permissions derive solely from edge `access` attributes (least privilege by construction), reachability is zero-trust default-deny, secret values never appear in documents, and encryption defaults to `required` on both dimensions. The architecture *is* the security description; approving a document diff *is* the security review.

## Motivation

Conventional infrastructure descriptions keep security as a parallel artifact — permission policies, firewall rules, encryption settings maintained alongside, and drifting from, the resources they protect. IaP forbids that structure: if every control is a pure derivation from the intent document, there is nothing to synchronize, no wildcard to sneak in, and the entire posture is reviewable (and auditable) at intent level. Deriving rather than declaring also makes safe-by-default real: omission never weakens posture, because the defaults (private exposure, required encryption, required backups on data kinds) are part of canonical form.

## Problem statement

The shipped design ([Chapter 15](../chapters/15-security-model.md)) carried no recorded rationale for the three-source rule, the no-hand-written-permissions decision (`Identity` deliberately has almost no fields), or the exclusion of human principals from v1.

## Goals

- Record the three-source derivation rule and the "no fourth source" prohibition (no out-of-band configuration may widen declared posture; extensions may only narrow it).
- Record identity semantics: `authenticatedBy` binds workloads to `Identity` (at most one per workload); shared identities union grants with a broadening warning; unbound workloads get implicit per-workload anonymous identities.
- Record least privilege: `access` on edges is the sole permission source; no relationship → no access; no wildcard or default-allow grant may ever be emitted; unexpressible narrow grants fail closed.
- Record zero-trust reachability from `exposure` + `connectsTo`/`routesTo` edges only, with IAP604 when a boundary is unenforceable.
- Record secret hygiene (IAP602, handle-not-value outputs) and encryption posture (explicit-downgrade-only, IAP603 under `pci-dss-4.0`/`soc2`).

## Non-goals

- Human/interactive identity, directory federation, break-glass access — out of scope for v1; a future minor may reserve an identity type.
- Customer-managed key selection — an extension/mapping refinement under non-interference ([Chapter 15](../chapters/15-security-model.md) §15.7).
- Runtime drift detection of enforced posture ([IEP-0010](IEP-0010-state-and-reconciliation.md)).

## Terminology

- **Derived grant** — the minimal data-plane permission computed from an edge's verb and `access` attribute for the source's identity on the target.
- **Reachability graph** — the complete allowed-traffic graph computed from `exposure` values and `connectsTo`/`routesTo` edges.
- **Enforcement points** — validation time, plan time, apply time; each later point trusts nothing from earlier ones (§15.8).

## Detailed design

Normative text: [Chapter 15](../chapters/15-security-model.md), with inputs from [Chapter 3](../chapters/03-resource-model.md) (`encryption`, `exposure`, `Secret`, `Identity`) and [Chapter 4](../chapters/04-relationship-model.md) (edges, `access`). Recorded decisions:

- **Derivation over declaration.** A conforming implementation MUST compute grants, reachability, and encryption posture from the canonical document alone, and MUST NOT require or accept security metadata beyond it. Rule edges derive grants identically after selector expansion, so the grant set is always computable from the canonical edge list.
- **Least privilege by construction.** `access: read` derives read-only and nothing more; edges without `access` derive connectivity but no data-plane permission; a platform that cannot express a grant as narrowly as declared fails closed rather than approximating upward ([Chapter 12](../chapters/12-provider-mapping.md)).
- **Zero trust.** Anything not declared is denied: a `private` resource accepts traffic only from declared edge sources on the declared port/protocol; no lateral path exists without an edge; `public`/`internal` widen ingress scope only, never resource-to-resource connectivity.
- **Secrets.** Documents declare a secret's existence, `source`, and `rotation` — never its value (IAP602, with entropy/token heuristics); `connectionSecret` outputs are references to platform-held material; generated credentials exist in no artifact of the four layers.
- **Review surface.** The worked example in §15.9 shows plan output rendering the full least-privilege table and reachability graph from a five-resource document with no additional input — the reviewable artifact this design exists to produce.

## Schema impact

None new. Documents shipped structures: `encryption`/`exposure` defaults, `Secret` and `Identity` kind schemas (the latter deliberately field-free beyond `type: workload`).

## Runtime-model impact

Derived grants and reachability are projections of the CIM's normalized edge set; the CIM itself stores no secret material ([IEP-0008](IEP-0008-canonical-infrastructure-model.md), CD-6 alignment).

## Validation impact

None new; codifies IAP601–IAP604 (Phase 6) and the enforcement-point split: structural checks at validation, derived grants/reachability shown at plan time, exact enforcement at apply time.

## Provider impact

Engines and mappings realize the same canonical derivations per platform — e.g. a `connectsTo` edge becomes security-group/firewall rules on hyperscalers and a NetworkPolicy on Kubernetes; identity binding realizes as workload-assumed roles, managed identities, or service accounts ([Chapter 3](../chapters/03-resource-model.md) §3.15). CE-2/CE-3 forbid provider default-allow from surviving realization.

## Security impact

This IEP *is* the security contract; it consolidates the shipped posture rules without change.

## Cost impact

None.

## Compatibility

Documents existing v1 behavior. New identity types or access levels are minor-eligible additions; the three-source rule is invariant for the major.

## Migration

None required.

## Alternatives considered

1. **A standalone security section** (IAM-style permission lists, firewall rule blocks) — rejected: reintroduces the parallel artifact that drifts from the architecture; hand-written permissions defeat least-privilege-by-construction.
2. **Default-allow within a document's "trust zone"** — rejected: implicit same-document trust invites lateral movement and makes reachability underivable from explicit assertions.
3. **Secret values with encryption-at-rest in documents** (sealed-secrets style) — rejected: keeps ciphertext in the review/diff path and couples documents to key custody; IaP documents carry intent only.

## Rejected alternatives

- **Permission enumeration on `Identity.spec`** — schema-rejected by design; permission-like extension content that alters derived privileges is an IAP803 violation.
- **Human principals in v1** — operational concern of the execution platform, not intent; explicitly deferred.

## Implementation plan

Already implemented in the v1.0.0 draft (Chapter 15, kind schemas, error codes). Derivation engines land with the validator/planner phases of the roadmap.

## Conformance requirements

Covered by [Chapter 24](../chapters/24-conformance.md): CD-6 (structural security, no secret values), CE-2 (zero-trust enforcement), CE-3 (least-privilege derivation), CE-6 (secret hygiene), CM-5 (capability floors incl. `encryption`/`exposure`). Suite gaps: IAP601/IAP602 expected-failure cases ([gap analysis](../../docs/reports/v1-gap-analysis.md) §4).

## Open questions

1. Missing IAP601/IAP602 conformance cases (public data-kind exposure; credential-patterned `configuration` key) — Phase 1 additions per gap analysis §4.
2. Enforcement drift (deployed posture diverging from planned grants) and its taxonomy — owned by [IEP-0010](IEP-0010-state-and-reconciliation.md).
3. Precision of the shared-`Identity` broadening warning (SHOULD-level today) — candidate 1.0.x clarification.

## Decision

Adopted in IaP v1.0.0 draft; formalized retroactively per Phase 0.5.

## References

- [Chapter 15 — Security Model](../chapters/15-security-model.md); [Chapter 3 — Resource Model](../chapters/03-resource-model.md); [Chapter 4 — Relationship Model](../chapters/04-relationship-model.md)
- [Chapter 12 — Provider Mapping](../chapters/12-provider-mapping.md); [Chapter 17 — Compliance Model](../chapters/17-compliance-model.md); [Chapter 24 — Conformance](../chapters/24-conformance.md)
- [IEP-0002](IEP-0002-relationship-semantics.md); [IEP-0010](IEP-0010-state-and-reconciliation.md); [v1 gap analysis](../../docs/reports/v1-gap-analysis.md)
