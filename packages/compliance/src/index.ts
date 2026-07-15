/**
 * `@iap/compliance` — the compliance engine (spec ch. 17; roadmap Phase 11,
 * M11.2). Compliance is EMBEDDED, not bolted on: because security posture,
 * data protection, and reachability are all derived from the canonical document
 * (ch. 15), framework controls are evaluated — and evidenced — at the intent
 * level. Six versioned bundles (soc2, pci-dss-4.0, hipaa, iso27001-2022,
 * nist-800-53-r5, cis-8.0) evaluate to IAP701 control findings and an evidence
 * report (satisfied/violated/not-applicable per control). Never a claim of
 * certification. Pure and deterministic.
 */
export { FRAMEWORK_BUNDLES } from './bundles.js';
export type { ComplianceControl, FrameworkBundle } from './bundles.js';

export { DATA_KINDS, WORKLOAD_KINDS, derivedViolations, fieldRuleHolds } from './rules.js';
export type { ControlRule, DerivedCheck, DerivedRule, FieldRule } from './rules.js';

export { evaluateCompliance } from './evaluate.js';
export type { ComplianceReport, ControlEvidence, Disposition } from './evaluate.js';
