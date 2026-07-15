/**
 * IaP product-evidence benchmark manifest (roadmap-v2 §13, milestone M19.7).
 *
 * A curated corpus of >=20 natural-language infrastructure requests spanning
 * every §13 request category. Each case is driven end-to-end through the REAL
 * pipeline by `run.mjs`:
 *
 *   runAuthoringSession (@iap/intent-compiler, the DETERMINISTIC rules adapter)
 *     -> load / validate / policies (@iap/sdk)
 *     -> applyMapping over providers/aws/mappings/core.iap-map.yaml (@iap/provider-sdk)
 *     -> plan (@iap/planner)
 *
 * HONESTY (roadmap-v2 §13): in-tree authoring is a rules engine, NOT an LLM.
 * These expectations encode what a CORRECT system SHOULD do for each request;
 * the runner measures what the rules engine ACTUALLY does and reports the
 * detection/generation rates verbatim — including the requests it does not
 * flag. No customer data is used: every request is synthetic/personal, authored
 * from the §13 category list.
 *
 * Case shape:
 *   id        — stable identifier
 *   category  — one of CATEGORIES (the §13 request categories)
 *   request   — the natural-language input (what a user would type)
 *   options   — runAuthoringSession options (autoAnswerDefaults, acknowledgeDestructive)
 *   base      — base document to author into:
 *                 null              -> author from scratch
 *                 'example:<name>'  -> spec/examples/<name>.iap.yaml
 *                 { seed: [req...] } -> author each seed request first, use the result
 *   expect    — the IDEAL correct behavior (the oracle), for scoring:
 *                 validDoc  — should commit a schema+phase-valid document
 *                 clarifies — should stop and ask (under-specified/ambiguous)
 *                 flag      — should flag an unsupported OR conflicting request
 *                 kinds     — resource kinds the request implies (false-assumption oracle:
 *                             any created kind outside this set is an invented resource)
 */

export const CATEGORIES = [
  'web-application',
  'internal-api',
  'event-driven',
  'serverless',
  'database',
  'cache',
  'private-service',
  'high-availability',
  'budget',
  'security',
  'compliance',
  'incremental',
  'removal',
  'drift-reconciliation',
  'unsupported',
  'conflicting',
];

export const CASES = [
  /* --- Web applications ------------------------------------------ */
  {
    id: 'web-public-stack',
    category: 'web-application',
    request:
      'A public web app image registry.example.com/app:1.0.0 behind a gateway with a highly ' +
      'available postgresql 16 database and a redis cache.',
    base: null,
    expect: {
      validDoc: true,
      clarifies: false,
      flag: false,
      kinds: ['Gateway', 'Service', 'Database', 'Cache'],
    },
  },
  {
    id: 'web-budget-annotated',
    category: 'web-application',
    request: 'A web app image registry.example.com/app:1.0.0 with a budget of $500 per month.',
    base: null,
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Service'] },
  },

  /* --- Internal APIs --------------------------------------------- */
  {
    id: 'internal-api-with-db',
    category: 'internal-api',
    request:
      'An internal API service image registry.example.com/api:1.0.0 with a postgresql database, ' +
      'not public.',
    options: { autoAnswerDefaults: true },
    base: null,
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Service', 'Database'] },
  },
  {
    id: 'internal-api-underspecified',
    category: 'internal-api',
    request: 'We need an internal API',
    base: null,
    expect: { validDoc: false, clarifies: true, flag: false, kinds: ['Service'] },
  },

  /* --- Event-driven systems -------------------------------------- */
  {
    id: 'event-webapp-queue',
    category: 'event-driven',
    request: 'A web app image registry.example.com/app:1.0.0 and a message queue.',
    options: { autoAnswerDefaults: true },
    base: null,
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Service', 'Queue'] },
  },
  {
    id: 'event-worker-queue',
    category: 'event-driven',
    request:
      'A worker service image registry.example.com/orders:1.0.0 that writes to a queue named jobs.',
    options: { autoAnswerDefaults: true },
    base: null,
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Queue'] },
  },

  /* --- Serverless workloads -------------------------------------- */
  {
    id: 'serverless-image-resizer',
    category: 'serverless',
    request:
      'A serverless function image registry.example.com/resize:1.0.0 triggered by uploads to an ' +
      'object store.',
    options: { autoAnswerDefaults: true },
    base: null,
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Function', 'ObjectStore'] },
  },

  /* --- Databases ------------------------------------------------- */
  {
    id: 'database-ha-with-web',
    category: 'database',
    request:
      'A highly available postgresql 16 database and a web app image registry.example.com/app:1.0.0.',
    options: { autoAnswerDefaults: true },
    base: null,
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Service', 'Database'] },
  },

  /* --- Caches ---------------------------------------------------- */
  {
    id: 'cache-redis-sessions',
    category: 'cache',
    request: 'A redis cache for session storage.',
    base: null,
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Cache'] },
  },

  /* --- Private services ------------------------------------------ */
  {
    id: 'private-internal-service',
    category: 'private-service',
    request: 'An internal web app image registry.example.com/svc:1.0.0 that is not public.',
    options: { autoAnswerDefaults: true },
    base: null,
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Service'] },
  },

  /* --- High availability ----------------------------------------- */
  {
    id: 'ha-web-and-db',
    category: 'high-availability',
    request:
      'A highly available web app image registry.example.com/app:1.0.0 with a highly available ' +
      'postgresql database.',
    options: { autoAnswerDefaults: true },
    base: null,
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Service', 'Database'] },
  },

  /* --- Budget constraints ---------------------------------------- */
  {
    id: 'budget-constrained-web',
    category: 'budget',
    request: 'A web app image registry.example.com/app:1.0.0 with a monthly budget of $300.',
    base: null,
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Service'] },
  },

  /* --- Security requirements ------------------------------------- */
  {
    id: 'security-public-gateway',
    category: 'security',
    request: 'A public web app image registry.example.com/app:1.0.0 behind a gateway.',
    base: null,
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Gateway', 'Service'] },
  },

  /* --- Compliance requirements ----------------------------------- */
  {
    id: 'compliance-add-pci',
    category: 'compliance',
    request: 'Add PCI DSS controls',
    base: 'example:basic-webapp',
    expect: { validDoc: true, clarifies: false, flag: false, kinds: [] },
  },
  {
    id: 'compliance-hipaa-scope',
    category: 'compliance',
    request:
      'A web app image registry.example.com/app:1.0.0 storing data, must be HIPAA compliant.',
    base: null,
    expect: { validDoc: false, clarifies: true, flag: false, kinds: ['Service'] },
  },

  /* --- Incremental updates --------------------------------------- */
  {
    id: 'incremental-add-cache',
    category: 'incremental',
    request: 'Add a cache for the API',
    base: 'example:basic-webapp',
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Cache'] },
  },
  {
    id: 'incremental-add-queue',
    category: 'incremental',
    request: 'Add a message queue for background jobs',
    options: { autoAnswerDefaults: true },
    base: 'example:basic-webapp',
    expect: { validDoc: true, clarifies: false, flag: false, kinds: ['Queue'] },
  },

  /* --- Removal --------------------------------------------------- */
  {
    id: 'removal-commits-with-ack',
    category: 'removal',
    request: 'Remove the db',
    options: { acknowledgeDestructive: true },
    base: {
      seed: [
        'A web app running image registry.example.com/w:1.0.0 and a postgresql database and a redis cache',
      ],
    },
    expect: { validDoc: true, clarifies: false, flag: false, kinds: [] },
  },
  {
    id: 'removal-refused-dangling-output',
    category: 'removal',
    request: 'Remove the orders-db',
    options: { acknowledgeDestructive: true },
    base: 'example:basic-webapp',
    // basic-webapp's outputs reference orders-db; removal must fail closed (IAP203).
    expect: { validDoc: false, clarifies: false, flag: true, kinds: [] },
  },

  /* --- Drift reconciliation (plan-preview only; live = M19.3) ---- */
  {
    id: 'drift-webapp-store',
    category: 'drift-reconciliation',
    request:
      'A web app image registry.example.com/app:1.0.0 with a postgresql database and an object store.',
    options: { autoAnswerDefaults: true },
    base: null,
    expect: {
      validDoc: true,
      clarifies: false,
      flag: false,
      kinds: ['Service', 'Database', 'ObjectStore'],
    },
  },

  /* --- Unsupported requests -------------------------------------- */
  {
    id: 'unsupported-azure',
    category: 'unsupported',
    request: 'Deploy to Azure a web app image registry.example.com/app:1.0.0.',
    base: null,
    // A correct system flags the unsupported Azure target. (Measured: the rules
    // engine does NOT — it authors the provider-neutral Service and ignores the
    // target term. Reported as a detection miss.)
    expect: { validDoc: false, clarifies: false, flag: true, kinds: ['Service'] },
  },
  {
    id: 'unsupported-blockchain',
    category: 'unsupported',
    request: 'A blockchain validator node.',
    base: null,
    expect: { validDoc: false, clarifies: false, flag: true, kinds: [] },
  },
  {
    id: 'unsupported-vpn-dynamodb',
    category: 'unsupported',
    request: 'We need a vpn and a dynamodb table.',
    base: null,
    expect: { validDoc: false, clarifies: false, flag: true, kinds: [] },
  },

  /* --- Conflicting requirements ---------------------------------- */
  {
    id: 'conflict-budget-vs-ha',
    category: 'conflicting',
    request:
      'A highly available postgresql database on a budget of $200 per month, web app ' +
      'image registry.example.com/app:1.0.0.',
    base: null,
    expect: { validDoc: false, clarifies: true, flag: true, kinds: ['Service', 'Database'] },
  },
  {
    id: 'conflict-public-but-private',
    category: 'conflicting',
    request:
      'A public web app that must be fully private with no internet access, ' +
      'image registry.example.com/app:1.0.0.',
    base: null,
    // A correct system flags the public/private contradiction. (Measured: the
    // rules engine does not — reported as a detection miss.)
    expect: { validDoc: false, clarifies: false, flag: true, kinds: ['Service'] },
  },
  {
    id: 'conflict-cheapest-5region-ha',
    category: 'conflicting',
    request:
      'The cheapest possible setup with 5-region active-active high availability, web app ' +
      'image registry.example.com/app:1.0.0.',
    base: null,
    // Cost-minimization vs 5-region active-active is contradictory. (Measured:
    // the rules engine does not flag it — reported as a detection miss.)
    expect: { validDoc: false, clarifies: false, flag: true, kinds: ['Service'] },
  },
];
