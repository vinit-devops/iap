/**
 * Intent-compiler evaluation dataset (roadmap §3.7).
 *
 * A curated benchmark spanning the eleven §3.7 requirement categories. Each
 * case is authored as an ORACLE from the request's semantics — what a correct
 * intent compiler should produce — not by echoing the reference implementation.
 * `tests/evaluation/run.mjs` drives the shipped `runAuthoringSession` over every
 * case and scores the eight §3.7 measures against these expectations.
 *
 * Base document (`base`):
 *   - null            → an empty document authored from scratch
 *   - 'example:<name>' → an official example from spec/examples/<name>.iap.yaml
 *   - { seed: [...] }  → author each seed request (auto-answering defaults) in
 *                        sequence and use the committed result as the base
 *
 * Expectations (`expect`):
 *   - outcome       — the closed runAuthoringSession outcome
 *   - resources     — multiset of NEW resource kinds the request should create
 *   - relationships — NEW edges as `<from>-<type>-><to>`
 *   - triggers      — clarification triggers that SHOULD fire (exact set)
 *   - unsupported   — capabilities that should be reported unsupported (exact set)
 *   - allowedAssumptions — assumption fields the compiler MAY default (anything
 *                          it assumes outside this set is a false assumption)
 *
 * Validity, semantic equivalence, and deterministic serialization are checked
 * automatically for every case whose expected outcome is `committed`.
 */

/** @typedef {import('../../packages/intent-compiler/dist/index.js').AuthoringOutcome} Outcome */

export const CATEGORIES = [
  'clear',
  'ambiguous',
  'conflicting',
  'missing',
  'unsupported',
  'provider-specific',
  'incremental',
  'destructive',
  'security-sensitive',
  'cost-sensitive',
  'compliance',
];

export const CASES = [
  /* --- Clear requirements ---------------------------------------- */
  {
    id: 'clear-webapp',
    category: 'clear',
    input:
      'A public web app running image registry.example.com/app:1.0.0 behind a gateway with a ' +
      'highly available postgresql 16 database and a redis cache.',
    base: null,
    expect: {
      outcome: 'committed',
      resources: ['Gateway', 'Service', 'Database', 'Cache'],
      relationships: ['web-connectsTo->db', 'web-connectsTo->cache', 'edge-routesTo->web'],
      triggers: [],
      unsupported: [],
      allowedAssumptions: [],
    },
  },
  {
    id: 'clear-job-with-storage',
    category: 'clear',
    input:
      'A batch job running image registry.example.com/etl:2.0.0 and an object store for results.',
    base: null,
    expect: {
      outcome: 'committed',
      resources: ['Job', 'ObjectStore'],
      relationships: ['job-storesDataIn->assets'],
      triggers: [],
      unsupported: [],
      allowedAssumptions: [],
    },
  },

  /* --- Ambiguous requirements ------------------------------------ */
  {
    id: 'ambiguous-messaging',
    category: 'ambiguous',
    input:
      'The orders service publishes to a queue or a topic. Web app image registry.example.com/app:1.0.0.',
    base: null,
    expect: {
      // A materially divergent interpretation: the engine asks rather than guesses.
      outcome: 'needs-input',
      resources: ['Service', 'Topic'],
      relationships: [],
      triggers: ['unresolved-reference'],
      unsupported: [],
      allowedAssumptions: [],
    },
  },

  /* --- Conflicting constraints ----------------------------------- */
  {
    id: 'conflict-budget-vs-ha',
    category: 'conflicting',
    input:
      'A highly available postgresql database on a budget of $200 per month, ' +
      'web app image registry.example.com/app:1.0.0.',
    base: null,
    expect: {
      outcome: 'needs-input',
      resources: ['Service', 'Database'],
      relationships: ['web-connectsTo->db'],
      triggers: ['cost-availability-conflict'],
      unsupported: [],
      allowedAssumptions: [],
    },
  },

  /* --- Missing information --------------------------------------- */
  {
    id: 'missing-artifact',
    category: 'missing',
    input: 'We need a web app',
    base: null,
    expect: {
      outcome: 'needs-input',
      resources: ['Service'],
      relationships: [],
      triggers: ['required-field'],
      unsupported: [],
      allowedAssumptions: [],
    },
  },

  /* --- Unsupported capabilities ---------------------------------- */
  {
    id: 'unsupported-products',
    category: 'unsupported',
    input: 'We need a vpn and a dynamodb table',
    base: null,
    expect: {
      outcome: 'no-operations',
      resources: [],
      relationships: [],
      triggers: [],
      unsupported: ['dynamodb', 'vpn'],
      allowedAssumptions: [],
    },
  },
  {
    id: 'unsupported-region-otherwise-clear',
    category: 'unsupported',
    input:
      'A postgresql database in the us-east-1 region, web app image registry.example.com/app:1.0.0.',
    base: null,
    expect: {
      outcome: 'committed',
      resources: ['Service', 'Database'],
      relationships: ['web-connectsTo->db'],
      triggers: [],
      unsupported: ['region us-east-1'],
      allowedAssumptions: [],
    },
  },

  /* --- Provider-specific requests -------------------------------- */
  {
    id: 'provider-selection',
    category: 'provider-specific',
    input: 'Deploy on AWS and also on GCP a web app image registry.example.com/app:1.0.0.',
    base: null,
    expect: {
      outcome: 'needs-input',
      resources: ['Service'],
      relationships: [],
      triggers: ['provider-selection'],
      unsupported: [],
      allowedAssumptions: [],
    },
  },

  /* --- Incremental edits ----------------------------------------- */
  {
    id: 'incremental-add-cache',
    category: 'incremental',
    input: 'Add a cache for the API',
    base: 'example:basic-webapp',
    expect: {
      outcome: 'committed',
      resources: ['Cache'],
      relationships: ['web-connectsTo->cache'],
      triggers: [],
      unsupported: [],
      // Engine unstated → redis default; a legitimate, surfaced assumption.
      allowedAssumptions: ['cache.spec.engine'],
    },
  },
  {
    id: 'incremental-max-availability',
    category: 'incremental',
    input: 'Move to maximum availability',
    base: 'example:basic-webapp',
    options: { autoAnswerDefaults: true },
    expect: {
      outcome: 'committed',
      resources: [],
      relationships: [],
      triggers: [],
      unsupported: [],
      allowedAssumptions: [],
    },
  },

  /* --- Destructive requests -------------------------------------- */
  {
    id: 'destructive-remove-commits',
    category: 'destructive',
    input: 'Remove the db',
    base: {
      seed: [
        'A web app running image registry.example.com/w:1.0.0 and a postgresql database and a redis cache',
      ],
    },
    options: { acknowledgeDestructive: true },
    expect: {
      outcome: 'committed',
      resources: [],
      relationships: [],
      triggers: ['destructive-update'],
      unsupported: [],
      allowedAssumptions: [],
    },
  },
  {
    id: 'destructive-remove-refused-dangling-output',
    category: 'destructive',
    input: 'Remove the orders-db',
    base: 'example:basic-webapp',
    options: { acknowledgeDestructive: true },
    expect: {
      // basic-webapp's outputs reference orders-db; removal fails closed (IAP203).
      outcome: 'refused',
      resources: [],
      relationships: [],
      triggers: ['destructive-update'],
      unsupported: [],
      allowedAssumptions: [],
    },
  },

  /* --- Security-sensitive requests ------------------------------- */
  {
    id: 'security-public-gateway',
    category: 'security-sensitive',
    input: 'A public web app image registry.example.com/app:1.0.0 behind a gateway.',
    base: null,
    expect: {
      outcome: 'committed',
      resources: ['Gateway', 'Service'],
      relationships: ['edge-routesTo->web'],
      triggers: [],
      unsupported: [],
      allowedAssumptions: [],
    },
  },

  /* --- Cost-sensitive requests ----------------------------------- */
  {
    id: 'cost-budget-annotation',
    category: 'cost-sensitive',
    input: 'A web app image registry.example.com/app:1.0.0 with a budget of $500 per month.',
    base: null,
    expect: {
      outcome: 'committed',
      resources: ['Service'],
      relationships: [],
      triggers: [],
      unsupported: [],
      allowedAssumptions: [],
    },
  },

  /* --- Compliance requests --------------------------------------- */
  {
    id: 'compliance-pci-controls',
    category: 'compliance',
    input: 'Add PCI DSS controls',
    base: 'example:basic-webapp',
    expect: {
      outcome: 'committed',
      resources: [],
      relationships: [],
      triggers: [],
      unsupported: [],
      allowedAssumptions: [],
    },
  },
  {
    id: 'compliance-hipaa-scope',
    category: 'compliance',
    input: 'A web app image registry.example.com/app:1.0.0 storing data, must be HIPAA compliant.',
    base: null,
    expect: {
      outcome: 'needs-input',
      resources: ['Service'],
      relationships: [],
      triggers: ['compliance-scope'],
      unsupported: [],
      allowedAssumptions: [],
    },
  },
];
