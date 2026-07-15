# Phase 0.5 Completion Report — IaP Enhancement Proposal Process

**Date:** 2026-07-10 · **Milestones:** M05.1 (template/index/lifecycle — delivered with M0.2), M05.2 (IEPs 0008–0013 — delivered with M0.5), M05.3 (retroactive IEPs 0001–0007)

## Exit criteria verification

| Exit criterion                                                                              | Status            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No normative specification change can be merged without the required IEP                    | **Pass** (policy) | GOVERNANCE.md + spec/ieps/README.md review rules; PR template requires a linked roadmap item/IEP. Mechanical enforcement (repo checks) activates with git; until then the milestone-doc review flow carries the requirement, and every normative change this cycle (M1.1, M1.2) cites its owning IEP or gap-report item.                                                                                                                               |
| IEP status is enforced through repository checks or review policy                           | **Pass** (policy) | Lifecycle + decision authority documented; index tracks status for all 13 IEPs.                                                                                                                                                                                                                                                                                                                                                                        |
| Every existing unresolved specification question is linked to an IEP or explicitly deferred | **Pass**          | Gap report §5/§8 disposition: quantity normalization + default materialization → resolved (IEP-0008/M1.1); replicatesTo failover → explicit v1 non-goal (ch. 4, M1.2); require-autofix scope → clarified (ch. 7, M1.2); `internal` realization declaration → explicitly deferred (gap report §5.2); reserved-kind portability → documented ch. 5/ch. 24. Each retroactive IEP's Open questions section links forward to its successor IEP or gap item. |

## IEP inventory

0001–0007 **Implemented (retroactive)** — formalize the shipped v1 design with recovered rationale and alternatives. 0008–0013 **Draft** — forward-looking contracts (CIM, compiler operations, state/reconciliation, planning, provider conformance, AI/MCP trust boundaries); each carries open questions needing maintainer decisions before Review.

## Decision

Phase 0.5 is **complete**. ROADMAP.yaml updated (`M05.3: completed`, phase `completed`).
