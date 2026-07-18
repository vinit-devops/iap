import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateDocument } from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
const casesDir = join(repoRoot, 'spec', 'conformance', 'cases');
const examplesDir = join(repoRoot, 'spec', 'examples');

const read = (path: string) => readFileSync(path, 'utf8');
const expectedOf = (text: string) => /^# expected:\s*(\S+)/m.exec(text)?.[1];
const profileOf = (text: string) => /^# profile:\s*(\S+)/m.exec(text)?.[1] ?? null;
const errorsOf = (findings: { severity: string }[]) =>
  findings.filter((f) => f.severity === 'error');

describe('conformance cases — invalid (phases 1–4 executed)', () => {
  const files = readdirSync(join(casesDir, 'invalid')).sort();

  for (const file of files) {
    const text = read(join(casesDir, 'invalid', file));
    const expected = expectedOf(text);
    if (expected === undefined) throw new Error(`${file}: missing "# expected:" header`);

    if (expected === 'schema-invalid') {
      it(`${file} → rejected in phase 1 (schema)`, () => {
        const result = validateDocument(text);
        expect(result.ok).toBe(false);
        expect(errorsOf(result.phases.schema.findings).length).toBeGreaterThan(0);
        expect(result.phases.reference.skipped).toBe(true);
      });
      continue;
    }

    if (!/^IAP[1-4]/.test(expected)) {
      // Cases 17–21 expect IAP5xx/IAP6xx/IAP8xx: policy, security, and
      // version/extension phases (5+) are out of M2.4 scope — deferred to the
      // later phase engines. The harness reports them as deferred, not validated.
      it.skip(`${file} → ${expected} (phase 5+ engine pending)`, () => {});
      continue;
    }

    it(`${file} → ${expected}`, () => {
      const result = validateDocument(text, { profile: profileOf(text) });
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain(expected);
      // The expected code must be an error, per the registry.
      expect(
        result.findings.filter((f) => f.code === expected).every((f) => f.severity === 'error'),
      ).toBe(true);
    });
  }
});

describe('conformance cases — valid corpus (zero errors)', () => {
  for (const file of readdirSync(join(casesDir, 'valid')).sort()) {
    it(`valid/${file}`, () => {
      const result = validateDocument(read(join(casesDir, 'valid', file)));
      expect(errorsOf(result.findings)).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.phases.dependency.skipped).toBe(false);
    });
  }

  for (const file of readdirSync(examplesDir)
    .filter((f) => f.endsWith('.iap.yaml'))
    .sort()) {
    it(`examples/${file}`, () => {
      const result = validateDocument(read(join(examplesDir, file)));
      expect(errorsOf(result.findings)).toEqual([]);
      expect(result.ok).toBe(true);
      // Every official example that declares a Gateway routes traffic, so the
      // IAP303 advisory must not fire on the valid corpus.
      expect(result.findings.filter((f) => f.code === 'IAP303')).toEqual([]);
    });
  }
});

describe('IAP801 reserved-kind warning (spec 1.2.0, IEP-0016 — registry now empty)', () => {
  const docWithKind = (kind: string, spec = '{}') => `
apiVersion: iap.dev/v1
metadata: { name: reserved-scope }
resources:
  subject:
    kind: ${kind}
    spec: ${spec}
`;

  // As of 1.2.0 (IEP-0016) all nine reserved kinds have graduated, so the
  // reserved registry is empty and IAP801 fires for nothing (ch. 5 §5.6
  // rule 5). The four kinds graduated in 1.2.0 MUST NOT warn any more.
  const graduated: Array<[string, string]> = [
    // 1.1.0 wave (IEP-0015)
    ['Certificate', '{ domains: [shop.example.com] }'],
    ['DnsZone', '{ zoneName: shop.example.com }'],
    ['Registry', '{ format: container-image }'],
    ['Dashboard', '{ audience: platform-operations }'],
    ['Alert', '{ severity: high }'],
    // 1.2.0 wave (IEP-0016)
    ['Network', '{ tiers: [public, private] }'],
    ['Stream', '{ retention: 24h }'],
    ['Workflow', '{ steps: 3 }'],
    ['SearchIndex', '{ indexType: text }'],
  ];

  it.each(graduated)('does not fire for graduated kind %s (ch. 5 §5.6 rule 5)', (kind, spec) => {
    const result = validateDocument(docWithKind(kind, spec));
    expect(result.findings.filter((f) => f.code === 'IAP801')).toEqual([]);
    expect(result.ok).toBe(true);
    // Warnings never gate: all phases ran.
    expect(result.phases.dependency.skipped).toBe(false);
  });

  it('emits IAP801 for no kind in the closed vocabulary (reserved registry empty)', () => {
    const kinds = [
      'Application',
      'Service',
      'Job',
      'Function',
      'Gateway',
      'Database',
      'Cache',
      'ObjectStore',
      'Volume',
      'Queue',
      'Topic',
      'Identity',
      'Secret',
      'Network',
      'Certificate',
      'DnsZone',
      'Stream',
      'Workflow',
      'SearchIndex',
      'Registry',
      'Dashboard',
      'Alert',
    ];
    for (const kind of kinds) {
      const result = validateDocument(docWithKind(kind, '{}'));
      expect(
        result.findings.filter((f) => f.code === 'IAP801'),
        kind,
      ).toEqual([]);
    }
  });

  it('graduated kinds enforce their promoted contracts (Certificate without domains fails phase 1)', () => {
    const result = validateDocument(docWithKind('Certificate', '{ issuance: managed }'));
    expect(result.ok).toBe(false);
    expect(errorsOf(result.phases.schema.findings).length).toBeGreaterThan(0);
  });

  it('graduated kinds enforce their promoted contracts (SearchIndex without indexType fails phase 1)', () => {
    const result = validateDocument(docWithKind('SearchIndex', '{ exposure: internal }'));
    expect(result.ok).toBe(false);
    expect(errorsOf(result.phases.schema.findings).length).toBeGreaterThan(0);
  });

  it('accepts the Database class values added in 1.1.0 and pairs wide-column with cassandra-compatible', () => {
    const result = validateDocument(`
apiVersion: iap.dev/v1
metadata: { name: new-classes }
resources:
  events-db:
    kind: Database
    spec: { class: wide-column, engine: cassandra-compatible }
  analytics-db:
    kind: Database
    spec: { class: warehouse }
`);
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects any engine paired with class warehouse as IAP104 (no engine pairs in 1.1.0)', () => {
    const result = validateDocument(`
apiVersion: iap.dev/v1
metadata: { name: warehouse-engine }
resources:
  analytics-db:
    kind: Database
    spec: { class: warehouse, engine: postgresql }
`);
    const codes = result.phases.schema.findings.map((f) => f.code);
    expect(codes).toContain('IAP104');
    expect(result.ok).toBe(false);
  });
});

describe('phase mechanics', () => {
  it('gates phases 2–4 behind phase 1 errors (ch. 8 §8.2)', () => {
    const result = validateDocument('apiVersion: iap.dev/v2\nmetadata: {name: x}\nresources: {}\n');
    expect(result.ok).toBe(false);
    expect(result.phases.schema.findings[0]?.code).toBe('IAP101');
    expect(result.phases.reference.skipped).toBe(true);
    expect(result.phases.relationship.skipped).toBe(true);
    expect(result.phases.dependency.skipped).toBe(true);
  });

  it('collects all findings within a phase instead of stopping at the first', () => {
    const result = validateDocument(`
apiVersion: iap.dev/v1
metadata: { name: multi-dangling }
resources:
  api:
    kind: Service
    spec: { artifact: { type: container-image, reference: r.example.com/a:1 } }
    relationships:
      - { type: connectsTo, target: ghost-db }
      - { type: connectsTo, target: ghost-cache }
`);
    const codes = result.phases.reference.findings.map((f) => f.code);
    expect(codes).toEqual(['IAP201', 'IAP201']);
  });

  it('prefixes post-merge phase-1 findings and reports the profile', () => {
    const text = read(join(casesDir, 'invalid', '22-postmerge-invalid.iap.yaml'));
    const result = validateDocument(text, { profile: 'production' });
    const postMerge = result.phases.schema.findings.filter((f) => f.code === 'IAP101');
    expect(postMerge.length).toBeGreaterThan(0);
    expect(postMerge[0]?.path).toMatch(/^post-merge:/);
    expect(postMerge[0]?.message).toContain('profile "production"');
    // Semantic validity is relative to a profile: the base document is fine.
    expect(validateDocument(text).ok).toBe(true);
  });

  it('reports an unknown selected profile as IAP205', () => {
    const result = validateDocument(
      'apiVersion: iap.dev/v1\nmetadata: {name: x}\nresources: {id: {kind: Identity}}\n',
      { profile: 'nope' },
    );
    expect(result.phases.reference.findings.map((f) => f.code)).toEqual(['IAP205']);
    expect(result.phases.relationship.skipped).toBe(true);
  });

  it('reports a self-referential ordering edge as IAP403 (not IAP401)', () => {
    const result = validateDocument(`
apiVersion: iap.dev/v1
metadata: { name: self-dep }
resources:
  api:
    kind: Service
    spec: { artifact: { type: container-image, reference: r.example.com/a:1 } }
    relationships: [{ type: dependsOn, target: api }]
`);
    const codes = result.phases.dependency.findings.map((f) => f.code);
    expect(codes).toEqual(['IAP403']);
    expect(result.ok).toBe(false);
  });

  it('reports the full cycle path in the IAP401 message (ch. 9 §9.3)', () => {
    const text = read(join(casesDir, 'invalid', '05-ordering-cycle.iap.yaml'));
    const result = validateDocument(text);
    const iis401 = result.findings.find((f) => f.code === 'IAP401');
    expect(iis401?.message).toContain('backend → frontend → backend');
  });

  it('emits the IAP303 advisory as a warning that never invalidates', () => {
    const result = validateDocument(`
apiVersion: iap.dev/v1
metadata: { name: routeless }
resources:
  edge:
    kind: Gateway
    spec: { exposure: public }
`);
    const advisory = result.findings.find((f) => f.code === 'IAP303');
    expect(advisory?.severity).toBe('warning');
    expect(result.ok).toBe(true);
    // Warnings never gate: all four phases ran (ch. 8 §8.2).
    expect(result.phases.dependency.skipped).toBe(false);
  });

  it('reports banned provider terms in core positions as IAP105 (ch. 24 §24.3)', () => {
    const result = validateDocument(`
apiVersion: iap.dev/v1
metadata: { name: banned-terms }
resources:
  web:
    kind: Service
    labels:
      network: my-vpc-id
    spec: { artifact: { type: container-image, reference: r.example.com/a:1 } }
`);
    const iis105 = result.findings.filter((f) => f.code === 'IAP105');
    expect(iis105).toHaveLength(1);
    expect(iis105[0]?.path).toBe('/resources/web/labels/network');
    expect(iis105[0]?.message).toContain('"vpc"');
    expect(result.ok).toBe(false);
  });

  it('matches banned terms on whole tokens only and honors the exempt positions', () => {
    const result = validateDocument(`
apiVersion: iap.dev/v1
metadata:
  name: exempt-positions
  description: deployed behind a vpc today            # description — exempt
  annotations:
    migrated-from: aws-vpc-0a1b2c                     # metadata.annotations — exempt
resources:
  web:
    kind: Service
    labels:
      shape: vpcx                                     # not a whole-token match
    spec:
      artifact:
        type: container-image
        reference: 123456.dkr.ecr.example.com/s3-sync:1   # artifact.reference — exempt
    extensions:
      vendor:
        vpc: vpc-0a1b2c                               # extensions — exempt
`);
    expect(result.findings.filter((f) => f.code === 'IAP105')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts an already-parsed document object', () => {
    const result = validateDocument({
      apiVersion: 'iap.dev/v1',
      metadata: { name: 'parsed' },
      resources: {
        q: { kind: 'Queue', spec: { deadLetter: { enabled: false, maxReceives: 3 } } },
      },
    });
    expect(result.findings.map((f) => f.code)).toContain('IAP104');
    expect(result.ok).toBe(false);
  });
});
