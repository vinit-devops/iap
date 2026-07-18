# IaP Enhancement Proposals (IEPs)

The IEP process is the only path through which the normative IaP specification evolves. **No normative change — anything under `spec/chapters/`, `spec/schema/`, or `spec/conformance/` — can merge without an accepted IEP** (Phase 0.5 exit criterion). Editorial fixes (typos, links, formatting) are exempt.

New proposals start from [IEP-TEMPLATE.md](IEP-TEMPLATE.md) and are filed as `IEP-NNNN-short-slug.md` in this directory. Ideas can be floated first with the _IEP proposal_ issue template.

## Lifecycle

```text
Idea → Draft → Review → Provisional → Accepted → Implementing → Implemented → Released
                                                                     ↓ (any post-Accepted state)
                                                        Superseded or Deprecated
```

| Status                      | Meaning                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| **Idea**                    | Problem raised (issue or discussion); no document yet.                              |
| **Draft**                   | Written against the template; author still iterating.                               |
| **Review**                  | Formally submitted; open for review comments.                                       |
| **Provisional**             | Direction approved; blocked on named open questions before full acceptance.         |
| **Accepted**                | Normatively binding; spec/schema/conformance changes may now merge citing this IEP. |
| **Implementing**            | Reference implementation work in progress.                                          |
| **Implemented**             | Spec text, schema, conformance cases, and reference implementation all landed.      |
| **Released**                | Shipped in a tagged specification release.                                          |
| **Superseded / Deprecated** | Replaced by a later IEP (link it), or withdrawn.                                    |

## Review rules

- A proposal enters **Review** only when every template section is filled in (use "None" explicitly rather than omitting a section).
- Schema impact, compatibility, migration, and conformance requirements receive mandatory scrutiny; an IEP with an unresolved breaking change and no migration transform cannot be accepted.
- Every existing unresolved specification question must be linked to an IEP or explicitly deferred (Phase 0.5 exit criterion).
- IEP status is enforced through review policy today and through repository checks once git hosting is enabled.

## Decision authority

Per [GOVERNANCE.md](../../GOVERNANCE.md): the maintainer accepts or rejects IEPs during the bootstrap phase, recording the rationale in the IEP's **Decision** section. This transfers to the technical steering committee at Phase 18.

## Compatibility policy

Per [Chapter 10 — Versioning](../chapters/10-versioning.md):

- **Minor releases are strictly additive.** An IEP targeting a 1.x minor may add — never change or remove — structure and semantics; every existing valid document must remain valid with identical meaning.
- **Breaking changes are major-only** and must ship with a deterministic migration transform (`iap migrate`) that rewrites any valid older-major document with no human judgment required. An IEP that cannot express its migration deterministically cannot land its removal.
- The relationship verb set is closed for the entire major version; new verbs are major-only by definition.

## Index

IEP-0001 through IEP-0007 are **retroactive**: they document design decisions already embodied in the v1 draft specification, and are to be formalized so the existing design has the same review trail as future changes. IEP-0008 through IEP-0013 are forward-looking drafts authored in milestone M0.5.

| IEP      | Title                           | Status                                                       |
| -------- | ------------------------------- | ------------------------------------------------------------ |
| [IEP-0001](IEP-0001-resource-model.md) | Resource model                  | Implemented (retroactive) |
| [IEP-0002](IEP-0002-relationship-semantics.md) | Relationship semantics          | Implemented (retroactive) |
| [IEP-0003](IEP-0003-provider-mapping-contract.md) | Provider mapping contract       | Implemented (retroactive) |
| [IEP-0004](IEP-0004-policy-language.md) | Policy language                 | Implemented (retroactive) |
| [IEP-0005](IEP-0005-cost-model.md) | Cost model                      | Implemented (retroactive) |
| [IEP-0006](IEP-0006-security-model.md) | Security model                  | Implemented (retroactive) |
| [IEP-0007](IEP-0007-extension-framework.md) | Extension framework             | Implemented (retroactive) |
| IEP-0008 | Canonical Infrastructure Model  | Draft (authored in M0.5)                                     |
| IEP-0009 | Intent compiler operations      | Draft (authored in M0.5)                                     |
| IEP-0010 | State and reconciliation model  | Draft (authored in M0.5)                                     |
| IEP-0011 | Deterministic planning contract | Draft (authored in M0.5)                                     |
| IEP-0012 | Provider conformance            | Draft (authored in M0.5)                                     |
| IEP-0013 | AI and MCP trust boundaries     | Draft (authored in M0.5)                                     |
| [IEP-0014](IEP-0014-iap-naming-migration.md) | IaP naming migration (IIS → IaP) | Review (authored in M19.0.2) |
| [IEP-0015](IEP-0015-reserved-kind-graduation.md) | Spec 1.1.0 — reserved-kind graduation, Database class extension | Released (1.1.0, M23.1) |
| [IEP-0016](IEP-0016-reserved-registry-graduation.md) | Spec 1.2.0 — reserved-registry graduation (Network, Stream, Workflow, SearchIndex) | Released (1.2.0, M23.3) |
| [IEP-0017](IEP-0017-new-kinds-cdn-eventbus.md) | Spec 1.3.0 — new kinds (Cdn, EventBus) and enum widenings | Released (1.3.0, M24.1) |
