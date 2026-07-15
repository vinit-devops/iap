import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  compareCodePoints,
  flattenEdges,
  materializeDefaults,
  mergePatch,
  mergeProfile,
  normalizeUnits,
} from '../src/canonicalize';
import type { IaPDocument } from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
const examplesDir = join(repoRoot, 'spec', 'examples');

function loadExample(name: string): IaPDocument {
  return parse(readFileSync(join(examplesDir, name), 'utf8')) as IaPDocument;
}

function doc(yamlText: string): IaPDocument {
  return parse(yamlText) as IaPDocument;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* Key-order independence (IEP-0008 I7; Phase 2 exit criterion)        */
/* ------------------------------------------------------------------ */

describe('key-order independence', () => {
  const ordered = `
apiVersion: iap.dev/v1
metadata:
  name: order-demo
  owner: team-a
resources:
  api:
    kind: Service
    labels:
      tier: backend
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/api:1.0.0
      size: m
    relationships:
      - type: connectsTo
        target: db
        port: 5432
        protocol: tcp
  db:
    kind: Database
    spec:
      class: relational
      engine: postgresql
`;
  const reordered = `
metadata:
  owner: team-a
  name: order-demo
apiVersion: iap.dev/v1
resources:
  db:
    spec:
      engine: postgresql
      class: relational
    kind: Database
  api:
    spec:
      size: m
      artifact:
        reference: registry.example.com/api:1.0.0
        type: container-image
    labels:
      tier: backend
    kind: Service
    relationships:
      - target: db
        type: connectsTo
        protocol: tcp
        port: 5432
`;

  it('documents differing only in key/resource order hash identically', () => {
    const a = canonicalize(doc(ordered));
    const b = canonicalize(doc(reordered));
    expect(a.findings).toEqual([]);
    expect(b.findings).toEqual([]);
    expect(a.canonicalJson).toBe(b.canonicalJson);
    expect(a.hash).toBe(b.hash);
  });

  it('accepts JSON text input (C1 parse of the JSON form)', () => {
    const asObject = canonicalize(doc(ordered));
    const asJsonText = canonicalize(JSON.stringify(doc(ordered)));
    expect(asJsonText.hash).toBe(asObject.hash);
  });

  it('sorts keys by Unicode code point', () => {
    expect(compareCodePoints('a', 'b')).toBeLessThan(0);
    expect(compareCodePoints('Z', 'a')).toBeLessThan(0); // 0x5A < 0x61
    expect(compareCodePoints('x-a', 'x-a')).toBe(0);
    expect(compareCodePoints('ab', 'a')).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Default materialization (ch. 1 §1.5.1)                              */
/* ------------------------------------------------------------------ */

describe('default materialization', () => {
  const explicitDefaults = `
apiVersion: iap.dev/v1
metadata:
  name: defaults-demo
resources:
  web:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/web:1.0.0
      runtime: container
      size: m
      exposure: private
      availability: standard
      scaling:
        min: 1
        max: 1
        targetUtilization: 70
      encryption:
        atRest: required
        inTransit: required
      observability:
        logs: required
        metrics: preferred
        traces: none
  db:
    kind: Database
    spec:
      class: relational
      capacity:
        storage: 10Gi
      exposure: private
`;
  const omittedDefaults = `
apiVersion: iap.dev/v1
metadata:
  name: defaults-demo
resources:
  web:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/web:1.0.0
  db:
    kind: Database
    spec:
      class: relational
`;

  it('default invisibility: explicit defaults and omissions hash identically', () => {
    const explicit = canonicalize(doc(explicitDefaults));
    const omitted = canonicalize(doc(omittedDefaults));
    expect(explicit.findings).toEqual([]);
    expect(omitted.findings).toEqual([]);
    expect(omitted.canonicalJson).toBe(explicit.canonicalJson);
    expect(omitted.hash).toBe(explicit.hash);
  });

  it('a Queue with no spec canonicalizes to all Queue defaults (rule 1)', () => {
    const result = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: queue-demo
resources:
  jobs:
    kind: Queue
`),
    );
    const spec = result.model.resources['jobs']?.spec;
    expect(spec).toMatchObject({
      delivery: 'at-least-once',
      ordering: 'none',
      messageRetention: '7d',
      encryption: { atRest: 'required', inTransit: 'required' },
      observability: { logs: 'required', metrics: 'preferred', traces: 'none' },
    });
    // Presence-semantic constructs are never synthesized (rule 4).
    expect(spec).not.toHaveProperty('deadLetter');
  });

  it('presence-semantic counter-test: explicit healthCheck differs from omission (rule 4)', () => {
    const base = `
apiVersion: iap.dev/v1
metadata:
  name: hc-demo
resources:
  web:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/web:1.0.0
`;
    const withHealthCheck = `${base}      healthCheck: {}
`;
    const without = canonicalize(doc(base));
    const withHc = canonicalize(doc(withHealthCheck));
    expect(withHc.hash).not.toBe(without.hash);
    // When present, member defaults still materialize (rule 1).
    expect(withHc.model.resources['web']?.spec).toMatchObject({
      healthCheck: { interval: '30s' },
    });
  });

  it('conditional default: deadLetter.maxReceives materializes only while enabled (rule 5)', () => {
    const enabled = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: dl-demo
resources:
  q:
    kind: Queue
    spec:
      deadLetter:
        enabled: true
`),
    );
    expect(enabled.model.resources['q']?.spec).toMatchObject({
      deadLetter: { enabled: true, maxReceives: 5 },
    });
    expect(enabled.model.provenance['/resources/q/spec/deadLetter/maxReceives']?.source).toBe(
      'default',
    );

    const disabled = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: dl-demo
resources:
  q:
    kind: Queue
    spec:
      deadLetter:
        enabled: false
`),
    );
    expect(disabled.model.resources['q']?.spec).toMatchObject({ deadLetter: { enabled: false } });
    expect(
      (disabled.model.resources['q']?.spec.deadLetter as Record<string, unknown>).maxReceives,
    ).toBeUndefined();
  });

  it('arrays are never materialized; empty differs from absent (rule 3)', () => {
    const base = `
apiVersion: iap.dev/v1
metadata:
  name: ports-demo
resources:
  web:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/web:1.0.0
`;
    const absent = canonicalize(doc(base));
    const empty = canonicalize(
      doc(`${base}      ports: []
`),
    );
    expect(absent.canonicalJson).not.toContain('"ports"');
    expect(empty.canonicalJson).toContain('"ports":[]');
    expect(empty.hash).not.toBe(absent.hash);
  });

  it('present array items gain member defaults (rule 1 inside arrays)', () => {
    const result = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: ports-default-demo
resources:
  web:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/web:1.0.0
      ports:
        - port: 8080
`),
    );
    expect(result.model.resources['web']?.spec).toMatchObject({
      ports: [{ port: 8080, protocol: 'tcp' }],
    });
  });

  it('per-kind resilience defaults (rule 6): Database required, ObjectStore preferred', () => {
    const result = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: resilience-demo
resources:
  db:
    kind: Database
    spec:
      class: relational
  blobs:
    kind: ObjectStore
`),
    );
    expect(result.model.resources['db']?.spec).toMatchObject({
      resilience: { backup: 'required' },
    });
    expect(result.model.resources['blobs']?.spec).toMatchObject({
      resilience: { backup: 'preferred' },
    });
  });

  it('kind-specific defaults win over shared vocabulary defaults (Function size s)', () => {
    const result = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: fn-demo
resources:
  fn:
    kind: Function
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/fn:1.0.0
`),
    );
    expect(result.model.resources['fn']?.spec).toMatchObject({ size: 's', timeout: '30s' });
  });

  it('Gateway defaults: exposure public, tls materialized with minimumVersion (rule 2)', () => {
    const result = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: gw-demo
resources:
  edge:
    kind: Gateway
`),
    );
    expect(result.model.resources['edge']?.spec).toMatchObject({
      exposure: 'public',
      tls: { minimumVersion: '1.2' },
    });
    // domains is an array: never materialized (rule 3).
    expect(result.model.resources['edge']?.spec).not.toHaveProperty('domains');
  });

  it('reserved kinds materialize no defaults; extensions and x-* are untouched (rule 7)', () => {
    const result = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: reserved-demo
resources:
  alerts:
    kind: Alert
    x-team: sre
    spec:
      severityFloor: high
    extensions:
      acme:
        channel: pager
`),
    );
    expect(result.model.resources['alerts']?.spec).toEqual({ severityFloor: 'high' });
    expect(result.canonicalJson).toContain('"x-team":"sre"');
    expect(result.canonicalJson).toContain('"channel":"pager"');
  });

  it('materializeDefaults records default provenance and leaves the input intact', () => {
    const input = doc(`
apiVersion: iap.dev/v1
metadata:
  name: prov-demo
resources:
  q:
    kind: Queue
`);
    const { materialized, provenance } = materializeDefaults(input);
    expect(input.resources['q']?.spec).toBeUndefined(); // pure
    expect(materialized.resources['q']?.spec).toMatchObject({ messageRetention: '7d' });
    expect(provenance['/resources/q/spec']?.source).toBe('default');
    expect(provenance['/resources/q/spec/messageRetention']?.source).toBe('default');
  });
});

/* ------------------------------------------------------------------ */
/* Quantity/duration normalization in documents (ch. 1 §1.5.2)         */
/* ------------------------------------------------------------------ */

describe('unit normalization in documents', () => {
  it('rewrites schema-typed quantities and durations only', () => {
    const result = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: units-demo
resources:
  cache:
    kind: Cache
    spec:
      engine: redis-compatible
      capacity:
        memory: 1024Mi
  vol:
    kind: Volume
    spec:
      capacity:
        storage: 0.5Gi
  web:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: "1024Mi"
      configuration:
        THRESHOLD: "0.5"
      healthCheck:
        interval: 60s
`),
    );
    expect(result.findings).toEqual([]);
    expect(result.model.resources['cache']?.spec).toMatchObject({ capacity: { memory: '1Gi' } });
    expect(result.model.resources['vol']?.spec).toMatchObject({ capacity: { storage: '512Mi' } });
    expect(result.model.resources['web']?.spec).toMatchObject({ healthCheck: { interval: '1m' } });
    // Look-alike strings outside quantity/duration-typed fields are data.
    expect(result.canonicalJson).toContain('"reference":"1024Mi"');
    expect(result.canonicalJson).toContain('"THRESHOLD":"0.5"');
  });

  it('reports IAP103 for unrepresentable precision and keeps the authored value', () => {
    const { normalized, findings } = normalizeUnits(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: bad-units-demo
resources:
  cache:
    kind: Cache
    spec:
      engine: redis-compatible
      capacity:
        memory: 1.5m
`),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'IAP103',
      severity: 'error',
      path: '/resources/cache/spec/capacity/memory',
    });
    expect(normalized.resources['cache']?.spec?.capacity).toEqual({ memory: '1.5m' });
  });
});

/* ------------------------------------------------------------------ */
/* Profile merge (C2, ch. 6)                                           */
/* ------------------------------------------------------------------ */

describe('profile merge', () => {
  it('applies RFC 7386 semantics: deep-merge, array replace, null delete', () => {
    expect(
      mergePatch(
        { a: { x: 1, y: 2 }, list: [1, 2], gone: true },
        { a: { y: 3 }, list: [9], gone: null },
      ),
    ).toEqual({ a: { x: 1, y: 3 }, list: [9] });
  });

  it('basic-webapp with production: overrides present, profiles key gone', () => {
    const result = canonicalize(loadExample('basic-webapp.iap.yaml'), { profile: 'production' });
    expect(result.findings).toEqual([]);
    expect(result.model.profile).toBe('production');
    expect(result.model.resources['web']?.spec).toMatchObject({
      size: 'l',
      availability: 'high',
      scaling: { min: 2, max: 6, targetUtilization: 70 },
    });
    expect(result.canonicalJson).not.toContain('"profiles"');
  });

  it('basic-webapp with development: deep merge keeps untouched sibling fields', () => {
    const result = canonicalize(loadExample('basic-webapp.iap.yaml'), { profile: 'development' });
    expect(result.findings).toEqual([]);
    expect(result.model.resources['orders-db']?.spec).toMatchObject({
      availability: 'standard',
      capacity: { storage: '5Gi' },
      // backup overridden, RPO/RTO retained from the base document.
      resilience: {
        backup: 'none',
        recoveryPointObjective: '1d',
        recoveryTimeObjective: '4h',
      },
    });
  });

  it('extends chains apply root-first, nearer profiles winning (ch. 6 §6.5)', () => {
    const chained = doc(`
apiVersion: iap.dev/v1
metadata:
  name: chain-demo
profiles:
  root:
    overrides:
      resources:
        app:
          spec:
            configuration:
              A: root
              B: root
              C: root
  mid:
    extends: root
    overrides:
      resources:
        app:
          spec:
            configuration:
              B: mid
              C: mid
  leaf:
    extends: mid
    overrides:
      resources:
        app:
          spec:
            configuration:
              C: leaf
resources:
  app:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/app:1.0.0
`);
    const result = canonicalize(chained, { profile: 'leaf' });
    expect(result.findings).toEqual([]);
    expect(result.model.resources['app']?.spec).toMatchObject({
      configuration: { A: 'root', B: 'mid', C: 'leaf' },
    });
  });

  it('null deletes keys through profiles', () => {
    const merged = mergeProfile(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: delete-demo
profiles:
  production:
    overrides:
      resources:
        app:
          spec:
            configuration:
              FEATURE_PREVIEW: null
resources:
  app:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/app:1.0.0
      configuration:
        FEATURE_PREVIEW: "true"
        LOG_LEVEL: info
`),
      'production',
    );
    expect(merged.findings).toEqual([]);
    expect(merged.merged.resources['app']?.spec?.configuration).toEqual({ LOG_LEVEL: 'info' });
  });

  it('reports IAP205 for extends cycles and aborts the merge', () => {
    const cyclic = doc(`
apiVersion: iap.dev/v1
metadata:
  name: cycle-demo
profiles:
  a:
    extends: b
    overrides: {}
  b:
    extends: a
    overrides: {}
resources:
  app:
    kind: Identity
`);
    const result = mergeProfile(cyclic, 'a');
    expect(result.findings.map((f) => f.code)).toEqual(['IAP205']);
  });

  it('reports IAP205 for unknown selected profiles and unknown extends targets', () => {
    const document = doc(`
apiVersion: iap.dev/v1
metadata:
  name: unknown-demo
profiles:
  a:
    extends: ghost
    overrides: {}
resources:
  app:
    kind: Identity
`);
    expect(mergeProfile(document, 'nope').findings.map((f) => f.code)).toEqual(['IAP205']);
    const viaExtends = mergeProfile(document, 'a');
    expect(viaExtends.findings.map((f) => f.code)).toEqual(['IAP205']);
    expect(viaExtends.findings[0]?.path).toBe('/profiles/a/extends');
  });

  it('rejects overrides that carry a profiles key (ch. 6 §6.4)', () => {
    const selfReferential = doc(`
apiVersion: iap.dev/v1
metadata:
  name: self-demo
profiles:
  a:
    overrides:
      profiles: {}
      metadata:
        owner: overridden
resources:
  app:
    kind: Identity
`);
    const result = mergeProfile(selfReferential, 'a');
    expect(result.findings.map((f) => f.code)).toEqual(['IAP205']);
    // The rest of the patch still applies; profiles never reappears.
    expect(result.merged.metadata.owner).toBe('overridden');
    expect(result.merged).not.toHaveProperty('profiles');
  });
});

/* ------------------------------------------------------------------ */
/* Relationship flattening (C3, ch. 4 §4.7)                            */
/* ------------------------------------------------------------------ */

describe('relationship flattening', () => {
  it('expands rule edges with lexicographically sorted matches', () => {
    const result = canonicalize(loadExample('kubernetes-platform.iap.yaml'));
    expect(result.findings).toEqual([]);
    const monitored = result.model.edges.filter((e) => e.type === 'monitoredBy');
    expect(monitored.map((e) => e.source)).toEqual(['api', 'nightly-report', 'notifier', 'worker']);
    expect(monitored.every((e) => e.target === 'ops-dashboard')).toBe(true);
  });

  it('dedupes rule and inline duplicates, keeping inline non-semantic fields', () => {
    const result = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: dedupe-demo
resources:
  api:
    kind: Service
    labels:
      tier: backend
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/api:1.0.0
    relationships:
      - type: monitoredBy
        target: alerts
        description: inline wins
  alerts:
    kind: Alert
relationships:
  - type: monitoredBy
    description: from rule
    source:
      selector:
        labels:
          tier: backend
    target: alerts
`),
    );
    expect(result.findings).toEqual([]);
    const monitored = result.model.edges.filter((e) => e.type === 'monitoredBy');
    expect(monitored).toHaveLength(1);
    expect(monitored[0]?.description).toBe('inline wins');
  });

  it('sorts by verb enumeration order, not alphabetically (§4.7 step 6)', () => {
    const result = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: verb-order-demo
resources:
  api:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/api:1.0.0
    relationships:
      - type: connectsTo
        target: db
        port: 5432
      - type: dependsOn
        target: db
  db:
    kind: Database
    spec:
      class: relational
`),
    );
    // dependsOn precedes connectsTo in the §4.3 enumeration.
    expect(result.model.edges.map((e) => e.type)).toEqual(['dependsOn', 'connectsTo']);
  });

  it('keeps edges with distinct attributes distinct, ordered by serialized attributes', () => {
    const result = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: multi-port-demo
resources:
  api:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/api:1.0.0
    relationships:
      - type: connectsTo
        target: db
        port: 9090
      - type: connectsTo
        target: db
        port: 8080
  db:
    kind: Database
    spec:
      class: relational
`),
    );
    expect(result.model.edges.map((e) => e.attributes.port)).toEqual([8080, 9090]);
  });

  it('reports IAP402 when a rule-edge selector matches zero resources', () => {
    const { findings } = flattenEdges(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: iis402-demo
resources:
  app:
    kind: Identity
relationships:
  - type: monitoredBy
    source:
      selector:
        labels:
          tier: nothing-has-this
    target: app
`),
    );
    expect(findings.map((f) => f.code)).toEqual(['IAP402']);
    expect(findings[0]?.path).toBe('/relationships/0');
  });

  it('materializes access: read-write on connectsTo/storesDataIn only (ch. 4 §4.4)', () => {
    const withDefault = `
apiVersion: iap.dev/v1
metadata:
  name: access-demo
resources:
  edge:
    kind: Gateway
    relationships:
      - type: routesTo
        target: api
        path: /
  api:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/api:1.0.0
    relationships:
      - type: connectsTo
        target: db
        port: 5432
  db:
    kind: Database
    spec:
      class: relational
`;
    const explicit = withDefault.replace(
      '        port: 5432',
      '        port: 5432\n        access: read-write',
    );
    const omittedResult = canonicalize(doc(withDefault));
    const explicitResult = canonicalize(doc(explicit));
    expect(omittedResult.hash).toBe(explicitResult.hash);
    const connects = omittedResult.model.edges.find((e) => e.type === 'connectsTo');
    const routes = omittedResult.model.edges.find((e) => e.type === 'routesTo');
    expect(connects?.attributes.access).toBe('read-write');
    expect(routes?.attributes).not.toHaveProperty('access');
    const accessPointer = Object.entries(omittedResult.model.provenance).find(
      ([pointer, record]) => pointer.endsWith('/attributes/access') && record.source === 'default',
    );
    expect(accessPointer).toBeDefined();
  });

  it('excludes description and x-* from edge identity (§4.7 step 5)', () => {
    const result = canonicalize(
      doc(`
apiVersion: iap.dev/v1
metadata:
  name: nonsemantic-demo
resources:
  api:
    kind: Service
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/api:1.0.0
    relationships:
      - type: dependsOn
        target: db
        description: first spelling
        x-note: kept
      - type: dependsOn
        target: db
        description: second spelling
  db:
    kind: Database
    spec:
      class: relational
`),
    );
    const depends = result.model.edges.filter((e) => e.type === 'dependsOn');
    expect(depends).toHaveLength(1);
    expect(depends[0]?.description).toBe('first spelling');
    expect(depends[0]?.['x-note']).toBe('kept');
  });
});

/* ------------------------------------------------------------------ */
/* Official examples: base and every declared profile                  */
/* ------------------------------------------------------------------ */

describe('official examples', () => {
  const declaredProfiles: Record<string, string[]> = {
    'basic-webapp.iap.yaml': ['development', 'production'],
    'data-processing.iap.yaml': [],
    'enterprise-pci.iap.yaml': ['production'],
    'hybrid-environment.iap.yaml': ['cloud', 'onprem'],
    'import-intent.iap.yaml': [],
    'kubernetes-platform.iap.yaml': [],
    'multi-region.iap.yaml': [],
    'private-internal-service.iap.yaml': [],
    'serverless-api.iap.yaml': [],
  };

  it('the profile inventory covers every official example', () => {
    const files = readdirSync(examplesDir).filter((f) => f.endsWith('.iap.yaml'));
    expect(files.sort()).toEqual(Object.keys(declaredProfiles).sort());
  });

  for (const [file, profiles] of Object.entries(declaredProfiles)) {
    for (const profile of [null, ...profiles]) {
      it(`${file} canonicalizes deterministically without findings (profile: ${profile ?? 'base'})`, () => {
        const first = canonicalize(loadExample(file), { profile });
        const second = canonicalize(loadExample(file), { profile });
        expect(first.findings).toEqual([]);
        expect(first.hash).toMatch(HEX_64);
        expect(second.canonicalJson).toBe(first.canonicalJson);
        expect(second.hash).toBe(first.hash);
      });
    }
  }

  it('retains x-* keys as data (import-intent)', () => {
    const result = canonicalize(loadExample('import-intent.iap.yaml'));
    expect(result.findings).toEqual([]);
    expect(result.canonicalJson).toContain('"x-iap-import":true');
  });
});

/* ------------------------------------------------------------------ */
/* Idempotence and golden vectors (Phase 2 exit criteria)              */
/* ------------------------------------------------------------------ */

describe('idempotence', () => {
  it.each([null, 'production', 'development'])(
    'canonicalize(canonical output) is a fixed point (basic-webapp, profile: %s)',
    (profile) => {
      const first = canonicalize(loadExample('basic-webapp.iap.yaml'), { profile });
      const second = canonicalize(first.canonicalJson);
      expect(second.findings).toEqual([]);
      expect(second.canonicalJson).toBe(first.canonicalJson);
      expect(second.hash).toBe(first.hash);
    },
  );
});

describe('golden vectors', () => {
  const goldenQueue = {
    apiVersion: 'iap.dev/v1',
    metadata: { name: 'golden-queue' },
    resources: { jobs: { kind: 'Queue' } },
  } as unknown as IaPDocument;

  const goldenWebDb = {
    apiVersion: 'iap.dev/v1',
    metadata: { name: 'golden-web-db' },
    resources: {
      web: {
        kind: 'Service',
        spec: {
          artifact: { type: 'container-image', reference: 'registry.example.com/web:1.0.0' },
        },
        relationships: [{ type: 'connectsTo', target: 'db', port: 5432, protocol: 'tcp' }],
      },
      db: { kind: 'Database', spec: { class: 'relational', capacity: { storage: '1024Mi' } } },
    },
  } as unknown as IaPDocument;

  const goldenProfiled = {
    apiVersion: 'iap.dev/v1',
    metadata: { name: 'golden-profiled' },
    profiles: {
      production: { overrides: { resources: { store: { spec: { versioning: 'enabled' } } } } },
    },
    resources: { store: { kind: 'ObjectStore' } },
  } as unknown as IaPDocument;

  it('golden-queue: pinned canonical JSON and hash', () => {
    const result = canonicalize(goldenQueue);
    expect(result.findings).toEqual([]);
    expect(result.canonicalJson).toBe(
      '{"apiVersion":"iap.dev/v1","edges":[],"metadata":{"name":"golden-queue"},"resources":' +
        '{"jobs":{"kind":"Queue","spec":{"delivery":"at-least-once","encryption":' +
        '{"atRest":"required","inTransit":"required"},"messageRetention":"7d","observability":' +
        '{"logs":"required","metrics":"preferred","traces":"none"},"ordering":"none"}}}}',
    );
    expect(result.hash).toBe('05d462e9d1284031b10c47da6a0f812fa8c9e3128986f70acea38e8457343b43');
  });

  it('golden-web-db: pinned hash', () => {
    const result = canonicalize(goldenWebDb);
    expect(result.findings).toEqual([]);
    expect(result.hash).toBe('d4e2db3454049eba76da1cccedc39fa6b286748f9849e3c08a0a6b91e12886c5');
  });

  it('golden-profiled (profile production): pinned hash', () => {
    const result = canonicalize(goldenProfiled, { profile: 'production' });
    expect(result.findings).toEqual([]);
    expect(result.hash).toBe('644eb1700f95fcfac55bb581e8ee4e561a59b272d76a864cb547868fd39a88e9');
  });
});

/* ------------------------------------------------------------------ */
/* Provenance (IEP-0008 I4 — totality)                                 */
/* ------------------------------------------------------------------ */

describe('provenance', () => {
  it('classifies explicit, default, and profile sources', () => {
    const result = canonicalize(loadExample('basic-webapp.iap.yaml'), { profile: 'production' });
    expect(result.model.provenance['/resources/web/spec/size']).toMatchObject({
      source: 'profile',
      originId: 'production',
    });
    expect(result.model.provenance['/resources/web/spec/runtime']?.source).toBe('default');
    expect(result.model.provenance['/resources/web/spec/exposure']?.source).toBe('explicit');
  });

  it('is total: every leaf of the canonical document has exactly one record', () => {
    const result = canonicalize(loadExample('enterprise-pci.iap.yaml'), { profile: 'production' });
    const leaves: string[] = [];
    const collect = (value: unknown, pointer: string): void => {
      if (Array.isArray(value)) {
        if (value.length === 0) leaves.push(pointer);
        value.forEach((item, index) => collect(item, `${pointer}/${index}`));
      } else if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) leaves.push(pointer);
        for (const [key, item] of entries) {
          collect(item, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
        }
      } else {
        leaves.push(pointer);
      }
    };
    collect(JSON.parse(result.canonicalJson), '');
    expect(leaves.length).toBeGreaterThan(0);
    const missing = leaves.filter((pointer) => result.model.provenance[pointer] === undefined);
    expect(missing).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* CIM shape (IEP-0008)                                                */
/* ------------------------------------------------------------------ */

describe('canonical model shape', () => {
  it('normalizes resource projections and carries diagnostics out-of-band', () => {
    const result = canonicalize(loadExample('basic-webapp.iap.yaml'), { profile: 'production' });
    const cache = result.model.resources['session-cache'];
    expect(cache?.kind).toBe('Cache');
    expect(cache?.labels).toEqual({ tier: 'data' });
    expect(cache?.extensions).toEqual({});
    expect(result.model.policies).toEqual([]);
    expect(result.model.hash).toBe(result.hash);
    expect(result.model.diagnostics).toBe(result.findings);
    // The canonical byte projection never carries provenance or diagnostics.
    expect(result.canonicalJson).not.toContain('provenance');
    expect(result.canonicalJson).not.toContain('diagnostics');
  });
});
