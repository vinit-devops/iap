/**
 * Built-in policy packs (roadmap phase 9, M9.2).
 *
 * Each pack is an ordinary array of schema-valid `Policy` objects — the pack
 * format IS the document policy format (ch. 7 §7.2): a pack activates by
 * concatenation into the evaluated policy set, so packs need no engine of
 * their own and stay auditable as plain data. Every policy id is prefixed
 * with its pack name, keeping findings attributable to the pack.
 *
 * `POLICY_PACKS` is the in-process pack registry. Organization-level pack
 * distribution (central registries, signing, tenancy) is Phase 16 control
 * plane territory; compliance-framework bundles (`soc2`, `pci-dss-4.0`, …)
 * activate through `compliance.frameworks` and report as IAP7xx in Phase 11 —
 * deliberately not duplicated here.
 *
 * All field paths resolve from the resource entry root against the canonical,
 * defaults-applied document (ch. 7 §7.3, §7.6): `labels.costCenter` is a
 * resource-level path, everything else lives under `spec`. Kind targeting
 * uses only kinds that actually carry the referenced field in the normative
 * schema, so a pack never produces vacuous unresolved-path findings.
 */

import type { Policy } from '@iap/model';

/** Kinds whose spec carries the common `encryption` block (data at rest/in transit). */
const ENCRYPTED_DATA_KINDS = [
  'Cache',
  'Database',
  'ObjectStore',
  'Queue',
  'Topic',
  'Volume',
] as const;

/**
 * The built-in pack registry: pack name → schema-valid policies, ids prefixed
 * with the pack name. Consumers evaluate a pack with
 * `evaluatePolicies({resources: model.resources, policies: POLICY_PACKS[name]})`
 * or concatenate packs with the document's own policies.
 */
export const POLICY_PACKS: Record<string, Policy[]> = {
  /**
   * Production baseline: stateful cores run highly available and backed up.
   * Both rules are `equals` leaves — autofix-eligible under `require`.
   */
  'production-baseline': [
    {
      id: 'production-baseline-availability',
      description:
        'Production databases declare a high-availability SLO floor (>= 99.95%, multi-zone).',
      target: { kinds: ['Database'] },
      rule: { field: 'spec.availability', operator: 'equals', value: 'high' },
      effect: 'require',
    },
    {
      id: 'production-baseline-backup',
      description: 'Production databases are always backed up; preferred is not acceptable.',
      target: { kinds: ['Database'] },
      rule: { field: 'spec.resilience.backup', operator: 'equals', value: 'required' },
      effect: 'require',
    },
  ],

  /**
   * Encryption baseline: data kinds encrypt at rest and in transit. The
   * defaults already say `required`; this catches documents that explicitly
   * weakened either dimension to `preferred` (autofix-eligible allOf of equals).
   */
  'encryption-baseline': [
    {
      id: 'encryption-baseline-data-kinds',
      description: 'Data at rest and in transit is always encrypted; preferred is not acceptable.',
      target: { kinds: [...ENCRYPTED_DATA_KINDS] },
      rule: {
        allOf: [
          { field: 'spec.encryption.atRest', operator: 'equals', value: 'required' },
          { field: 'spec.encryption.inTransit', operator: 'equals', value: 'required' },
        ],
      },
      effect: 'require',
    },
  ],

  /**
   * Private-only infrastructure: nothing faces the internet — including
   * gateways (whose exposure defaults to public). Resources without an
   * exposure field (Function, Job, …) pass by unresolved-path semantics.
   */
  'private-only': [
    {
      id: 'private-only-no-public-exposure',
      description: 'No resource of any kind may be internet-reachable.',
      target: {},
      rule: { field: 'spec.exposure', operator: 'equals', value: 'public' },
      effect: 'deny',
    },
  ],

  /** Backup baseline: every kind that can be backed up is backed up. */
  'backup-baseline': [
    {
      id: 'backup-baseline-stateful-kinds',
      description: 'Stateful data stores must be backed up; preferred or none is not acceptable.',
      target: { kinds: ['Database', 'ObjectStore', 'Volume'] },
      rule: { field: 'spec.resilience.backup', operator: 'equals', value: 'required' },
      effect: 'require',
    },
  ],

  /**
   * Tagging baseline: ownership/billing labels are mandatory on every
   * resource. Label paths are resource-level (`labels.*`, not `spec.*`).
   */
  'tagging-baseline': [
    {
      id: 'tagging-baseline-cost-center',
      description: 'Every resource declares its billing attribution as a costCenter label.',
      target: {},
      rule: { field: 'labels.costCenter', operator: 'exists' },
      effect: 'require',
    },
  ],

  /** Logging baseline: log emission is mandatory wherever the platform can collect it. */
  'logging-baseline': [
    {
      id: 'logging-baseline-logs-required',
      description: 'Runtime and data kinds must require log emission.',
      target: { kinds: ['Service', 'Database', 'Gateway', 'Function', 'Job'] },
      rule: { field: 'spec.observability.logs', operator: 'equals', value: 'required' },
      effect: 'require',
    },
  ],
};
