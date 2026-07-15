/**
 * The v1 framework bundles (spec ch. 17 §17.1–§17.3). Six versioned bundles,
 * one per registry framework, each a set of controls mapping a representative
 * control catalog to deterministic rules over the canonical document (§17.2 —
 * representative, not exhaustive). Bundles are versioned artifacts: evaluating
 * the same document against the same bundle version yields identical findings,
 * so control additions are explicit, reviewable version changes (§17.3).
 */
import type { ControlRule } from './rules.js';

export interface ComplianceControl {
  /** The framework's control id (e.g. `3.5.1`, `CC6.7`). */
  id: string;
  /** Human title of the control. */
  title: string;
  /** Kinds the control targets; omitted = every resource. */
  targetKinds?: string[];
  /** When true, only resources carrying the bundle's scope label are in scope (§17.7). */
  scoped?: boolean;
  /** The condition that MUST hold for a targeted resource to be compliant. */
  rule: ControlRule;
  /** How to remediate a violation. */
  remediation: string;
  /** Evidence IaP generates automatically for this control. */
  technicalEvidence: string;
  /** External evidence an auditor still needs (never derivable from a document). */
  externalEvidence?: string;
}

export interface FrameworkBundle {
  framework: string;
  version: string;
  specCompat: string;
  /** Label a resource sets to opt into scoped controls (§17.7). */
  scopeLabel?: string;
  controls: ComplianceControl[];
}

const LOGS_REQUIRED: ControlRule = {
  kind: 'field',
  field: 'spec.observability.logs',
  operator: 'equals',
  value: 'required',
};
const DATA = ['Database', 'Cache', 'ObjectStore', 'Volume'];
const DATA_AND_WORKLOADS = [...DATA, 'Service', 'Job', 'Function'];

const SOC2: FrameworkBundle = {
  framework: 'soc2',
  version: '1.0.0',
  specCompat: '^1.0.0',
  controls: [
    {
      id: 'CC6.1',
      title: 'Logical access controls',
      rule: { kind: 'derived', check: 'every-data-edge-has-access' },
      remediation: 'Declare an access level on every workload→data relationship.',
      technicalEvidence: 'Least-privilege grant table derived from edges (ch. 15 §15.3).',
    },
    {
      id: 'CC6.6',
      title: 'Boundary protection',
      targetKinds: DATA,
      rule: { kind: 'field', field: 'spec.exposure', operator: 'not-in', value: ['public'] },
      remediation: 'Set exposure to internal or private on data kinds.',
      technicalEvidence: 'Reachability graph (ch. 15 §15.4).',
    },
    {
      id: 'CC6.7',
      title: 'Transmission protection',
      targetKinds: DATA_AND_WORKLOADS,
      rule: {
        kind: 'field',
        field: 'spec.encryption.inTransit',
        operator: 'equals',
        value: 'required',
      },
      remediation: 'Keep spec.encryption.inTransit at required (the default).',
      technicalEvidence: 'Encryption posture (ch. 15 §15.6).',
    },
    {
      id: 'CC7.2',
      title: 'Monitoring',
      targetKinds: DATA_AND_WORKLOADS,
      rule: LOGS_REQUIRED,
      remediation: 'Set spec.observability.logs to required.',
      technicalEvidence: 'Observability intent fields.',
      externalEvidence: 'Evidence that logs are shipped to and retained by a monitored store.',
    },
  ],
};

const PCI: FrameworkBundle = {
  framework: 'pci-dss-4.0',
  version: '1.0.0',
  specCompat: '^1.0.0',
  scopeLabel: 'pci-scope',
  controls: [
    {
      id: '3.5.1',
      title: 'Req 3 — protect stored account data',
      targetKinds: DATA,
      scoped: true,
      rule: {
        kind: 'field',
        field: 'spec.encryption.atRest',
        operator: 'equals',
        value: 'required',
      },
      remediation: 'Keep spec.encryption.atRest at required on in-scope data kinds.',
      technicalEvidence: 'Encryption posture on pci-scope resources.',
    },
    {
      id: '4.2.1',
      title: 'Req 4 — protect data in transmission',
      scoped: true,
      targetKinds: ['Gateway'],
      rule: {
        kind: 'field',
        field: 'spec.tls.minimumVersion',
        operator: 'gte-version',
        value: '1.2',
      },
      remediation: 'Set Gateway spec.tls.minimumVersion to 1.2 or higher.',
      technicalEvidence: 'Gateway TLS intent.',
    },
    {
      id: '7.2.1',
      title: 'Req 7 — need-to-know access',
      rule: { kind: 'derived', check: 'no-admin-to-data' },
      remediation: 'Replace admin data access with the least privilege the workload needs.',
      technicalEvidence: 'Derived grant table.',
    },
    {
      id: '10.2.1',
      title: 'Req 10 — log and monitor access',
      scoped: true,
      rule: LOGS_REQUIRED,
      remediation: 'Set spec.observability.logs to required on in-scope resources.',
      technicalEvidence: 'Observability intent.',
      externalEvidence: 'Central log retention configuration.',
    },
  ],
};

const HIPAA: FrameworkBundle = {
  framework: 'hipaa',
  version: '1.0.0',
  specCompat: '^1.0.0',
  controls: [
    {
      id: '164.312(a)(1)',
      title: 'Access control',
      rule: { kind: 'derived', check: 'workloads-authenticated' },
      remediation: 'Bind each workload that reaches data to an Identity via authenticatedBy.',
      technicalEvidence: 'Workload-identity bindings.',
    },
    {
      id: '164.312(a)(2)(ii)',
      title: 'Data availability',
      targetKinds: DATA,
      rule: {
        kind: 'field',
        field: 'spec.resilience.backup',
        operator: 'equals',
        value: 'required',
      },
      remediation: 'Set spec.resilience.backup to required on data kinds.',
      technicalEvidence: 'Resilience intent.',
    },
    {
      id: '164.312(b)',
      title: 'Audit controls',
      targetKinds: DATA_AND_WORKLOADS,
      rule: LOGS_REQUIRED,
      remediation: 'Set spec.observability.logs to required.',
      technicalEvidence: 'Observability intent.',
      externalEvidence: 'Retention and access-audit procedures for PHI logs.',
    },
    {
      id: '164.312(e)(1)',
      title: 'Transmission security',
      targetKinds: DATA_AND_WORKLOADS,
      rule: {
        kind: 'field',
        field: 'spec.encryption.inTransit',
        operator: 'equals',
        value: 'required',
      },
      remediation: 'Keep spec.encryption.inTransit at required.',
      technicalEvidence: 'Encryption posture.',
    },
  ],
};

const ISO: FrameworkBundle = {
  framework: 'iso27001-2022',
  version: '1.0.0',
  specCompat: '^1.0.0',
  controls: [
    {
      id: 'A.5.15',
      title: 'Access control',
      rule: { kind: 'derived', check: 'every-data-edge-has-access' },
      remediation: 'Declare access on every workload→data edge; no grant without an edge.',
      technicalEvidence: 'Derived grants.',
    },
    {
      id: 'A.8.12',
      title: 'Data leakage prevention',
      targetKinds: DATA,
      rule: { kind: 'field', field: 'spec.exposure', operator: 'equals', value: 'private' },
      remediation: 'Set exposure to private on data kinds.',
      technicalEvidence: 'Reachability graph.',
    },
    {
      id: 'A.8.13',
      title: 'Information backup',
      targetKinds: DATA,
      rule: {
        kind: 'field',
        field: 'spec.resilience.backup',
        operator: 'equals',
        value: 'required',
      },
      remediation: 'Set spec.resilience.backup to required and declare a recovery objective.',
      technicalEvidence: 'Resilience intent.',
    },
    {
      id: 'A.8.24',
      title: 'Use of cryptography',
      targetKinds: DATA,
      rule: {
        kind: 'field',
        field: 'spec.encryption.atRest',
        operator: 'equals',
        value: 'required',
      },
      remediation: 'Keep spec.encryption.atRest at required.',
      technicalEvidence: 'Encryption posture.',
    },
  ],
};

const NIST: FrameworkBundle = {
  framework: 'nist-800-53-r5',
  version: '1.0.0',
  specCompat: '^1.0.0',
  controls: [
    {
      id: 'AC-6',
      title: 'Least privilege',
      rule: { kind: 'derived', check: 'no-admin-to-data' },
      remediation: 'Deny admin data access to workload principals.',
      technicalEvidence: 'Derived grants.',
    },
    {
      id: 'SC-7',
      title: 'Boundary protection',
      targetKinds: DATA,
      rule: { kind: 'field', field: 'spec.exposure', operator: 'equals', value: 'private' },
      remediation: 'Keep data kinds private; expose only through a Gateway.',
      technicalEvidence: 'Reachability graph.',
    },
    {
      id: 'SC-28',
      title: 'Protection at rest',
      targetKinds: DATA,
      rule: {
        kind: 'field',
        field: 'spec.encryption.atRest',
        operator: 'equals',
        value: 'required',
      },
      remediation: 'Keep spec.encryption.atRest at required.',
      technicalEvidence: 'Encryption posture.',
    },
    {
      id: 'AU-2',
      title: 'Event logging',
      targetKinds: DATA_AND_WORKLOADS,
      rule: LOGS_REQUIRED,
      remediation: 'Set spec.observability.logs to required.',
      technicalEvidence: 'Observability intent.',
      externalEvidence: 'SIEM ingestion evidence.',
    },
  ],
};

const CIS: FrameworkBundle = {
  framework: 'cis-8.0',
  version: '1.0.0',
  specCompat: '^1.0.0',
  controls: [
    {
      id: '3',
      title: 'Data protection',
      targetKinds: DATA,
      rule: {
        kind: 'field',
        field: 'spec.encryption.atRest',
        operator: 'equals',
        value: 'required',
      },
      remediation: 'Keep spec.encryption.atRest at required.',
      technicalEvidence: 'Encryption posture.',
    },
    {
      id: '4',
      title: 'Secure configuration',
      targetKinds: ['Gateway'],
      rule: {
        kind: 'field',
        field: 'spec.tls.minimumVersion',
        operator: 'gte-version',
        value: '1.2',
      },
      remediation: 'Set Gateway spec.tls.minimumVersion to 1.2 or higher.',
      technicalEvidence: 'Gateway TLS intent.',
    },
    {
      id: '8',
      title: 'Audit log management',
      targetKinds: DATA_AND_WORKLOADS,
      rule: LOGS_REQUIRED,
      remediation: 'Set spec.observability.logs to required.',
      technicalEvidence: 'Observability intent.',
      externalEvidence: 'Log retention policy.',
    },
    {
      id: '12',
      title: 'Network infrastructure management',
      rule: { kind: 'derived', check: 'no-undeclared-reachability' },
      remediation: 'Reachability is zero-trust by construction; no action needed.',
      technicalEvidence: 'Reachability graph (satisfied by construction, ch. 15 §15.4).',
    },
  ],
};

/** The v1 registry: framework id → bundle. Exactly the six schema-enum frameworks. */
export const FRAMEWORK_BUNDLES: Readonly<Record<string, FrameworkBundle>> = {
  soc2: SOC2,
  'pci-dss-4.0': PCI,
  hipaa: HIPAA,
  'iso27001-2022': ISO,
  'nist-800-53-r5': NIST,
  'cis-8.0': CIS,
};
