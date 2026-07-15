# Phase 11 Completion Report — Security and Compliance Engines

**Date:** 2026-07-11 · **Milestones:** M11.1, M11.2
(`docs/milestones/M11.1-security-engine.md`, `docs/milestones/M11.2-compliance-engine.md`)

Phase 11 delivers pre-deployment security and compliance analysis, both derived entirely
from the canonical document at the intent level: `@iap/security` (grants, reachability,
posture, IAP6xx) and `@iap/compliance` (six framework bundles, IAP701/702, evidence), each
with a CLI command. No parallel security/compliance artifact exists to drift — the
architecture _is_ the security description, and the same document is the compliance evidence.

## Exit-criteria verification

| Exit criterion                                                                   | Status   | Evidence                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every official example produces a security report                                | **Pass** | `securityReport` derives grants + reachability + encryption posture + findings + risk for any canonical model; the test suite runs it over the official corpus with no error findings on the clean examples (`packages/security/test`).                                                                                  |
| Compliance output distinguishes configuration coverage from formal certification | **Pass** | The evidence report gives every control a `satisfied`/`violated`/`not-applicable` disposition and carries a normative disclaimer that it is configuration coverage at the intent level, **not** certification, naming the external evidence still required per control (§17.6).                                          |
| Findings contain resource references and remediation                             | **Pass** | Security IAP601–603 carry the resource path and message; compliance IAP701 carries framework/control/bundle-version + resource path + remediation, and the evidence entry carries the remediation string (`packages/compliance/test`).                                                                                   |
| Critical findings can block deployment through policy                            | **Pass** | `iap security` and `iap compliance` exit **1** on any error-severity finding (IAP601 store exposure, IAP602 secret material, IAP603 downgrade, IAP701 control violation, IAP702 structural gap); a CI gate on the exit code blocks the pipeline. Plan-time blocking (IAP604 isolation, budget IAP505) rides the planner. |

## Deliverables checklist (roadmap Phase 11)

- **Security rule engine** ✓ — `@iap/security` (`deriveGrants`/`deriveReachability`/`securityFindings`, M11.1).
- **Compliance bundle format** ✓ — `FrameworkBundle`/`ComplianceControl` + six versioned bundles (M11.2).
- **Security report** ✓ — `securityReport` + `iap security`.
- **Compliance report** ✓ — `evaluateCompliance` + `iap compliance`.
- **Evidence model** ✓ — per-control disposition + contributing paths + technical/external evidence (§17.6).
- **Risk scoring** ✓ — deterministic `scoreRisk` (none…critical).

## Verification state

Full `pnpm run verify` green: build (incl. `@iap/security`, `@iap/compliance`), lint, unit
tests (security 14 + compliance 14), spec harness, provider conformance, determinism,
evaluation benchmark. `pnpm run format:check` clean.

## Notes and follow-ons

- Control catalogs are representative (§17.2), not exhaustive; bundle expansion is a versioned,
  reviewable change per §17.3.
- IAP604 (isolation unenforceable) and plan-time enforcement of derived grants/reachability
  land with the planner/execution surface (Phase 14).
- A distributable bundle-file format (beyond in-code bundles) is a follow-on; the control data
  shape is the contract today.
