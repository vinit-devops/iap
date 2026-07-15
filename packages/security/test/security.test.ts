/**
 * `@iap/security` — the security analysis engine (spec ch. 15). Pins the
 * derivation (least-privilege from edges only; zero-trust reachability;
 * encryption posture), the IAP6xx findings (IAP601 contextual, IAP602 secret
 * scan, IAP603 downgrade-under-framework), risk scoring, and determinism —
 * against the ch. 15 §15.9 worked example and the official corpus.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from '@iap/sdk';
import type { CanonicalModel } from '@iap/model';
import { deriveGrants, securityReport } from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
const EXAMPLES = [
  'basic-webapp.iap.yaml',
  'serverless-api.iap.yaml',
  'data-processing.iap.yaml',
  'enterprise-pci.iap.yaml',
  'private-internal-service.iap.yaml',
];
async function modelOf(name: string, profile?: string): Promise<CanonicalModel> {
  const ws = await load(
    { path: join(repoRoot, 'spec', 'examples', name) },
    profile === undefined ? {} : { profile },
  );
  return ws.canonical().model;
}

/** The ch. 15 §15.9 worked example, verbatim. */
function ordersModel(): CanonicalModel {
  return {
    apiVersion: 'iap.dev/v1',
    metadata: { name: 'orders' },
    resources: {
      'orders-api': { kind: 'Service', labels: {}, spec: { exposure: 'private' }, extensions: {} },
      'orders-db': { kind: 'Database', labels: {}, spec: { class: 'relational' }, extensions: {} },
      'orders-cache': { kind: 'Cache', labels: {}, spec: {}, extensions: {} },
      'orders-identity': {
        kind: 'Identity',
        labels: {},
        spec: { type: 'workload' },
        extensions: {},
      },
    },
    edges: [
      { source: 'orders-api', type: 'authenticatedBy', target: 'orders-identity', attributes: {} },
      {
        source: 'orders-api',
        type: 'connectsTo',
        target: 'orders-db',
        attributes: { port: 5432, protocol: 'tcp', access: 'read-write' },
      },
      {
        source: 'orders-api',
        type: 'connectsTo',
        target: 'orders-cache',
        attributes: { port: 6379, protocol: 'tcp', access: 'read-write' },
      },
    ],
    policies: [],
    profile: null,
    hash: '0'.repeat(64),
    provenance: {},
    diagnostics: [],
  } as unknown as CanonicalModel;
}

/** Build a one-off model. */
function model(
  resources: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): CanonicalModel {
  return {
    apiVersion: 'iap.dev/v1',
    metadata: { name: 't' },
    resources,
    edges: [],
    policies: [],
    profile: null,
    hash: '0'.repeat(64),
    provenance: {},
    diagnostics: [],
    ...extra,
  } as unknown as CanonicalModel;
}

describe('least-privilege derivation (§15.3)', () => {
  it('derives one grant per workload edge with access, attached to the bound identity', () => {
    const grants = deriveGrants(ordersModel());
    expect(grants).toHaveLength(2);
    expect(
      grants.every((g) => g.principal === 'orders-identity' && g.workload === 'orders-api'),
    ).toBe(true);
    expect(grants.map((g) => `${g.target}:${g.access}`).sort()).toEqual([
      'orders-cache:read-write',
      'orders-db:read-write',
    ]);
  });

  it('no edge → no grant, and edges without access derive none', () => {
    const m = model(
      {
        web: { kind: 'Service', labels: {}, spec: {}, extensions: {} },
        db: { kind: 'Database', labels: {}, spec: {}, extensions: {} },
      },
      { edges: [{ source: 'web', type: 'connectsTo', target: 'db', attributes: { port: 5432 } }] }, // no access
    );
    expect(deriveGrants(m)).toEqual([]);
  });

  it('a workload with no authenticatedBy uses an implicit per-workload identity', () => {
    const m = model(
      {
        web: { kind: 'Service', labels: {}, spec: {}, extensions: {} },
        db: { kind: 'Database', labels: {}, spec: {}, extensions: {} },
      },
      {
        edges: [
          { source: 'web', type: 'connectsTo', target: 'db', attributes: { access: 'read' } },
        ],
      },
    );
    expect(deriveGrants(m)[0].principal).toBe('web');
  });
});

describe('reachability (§15.4)', () => {
  it('records declared inbound sources and flags external exposure', () => {
    const report = securityReport(ordersModel());
    const db = report.reachability.find((r) => r.target === 'orders-db');
    expect(db?.acceptsFrom).toEqual([{ source: 'orders-api', port: 5432, protocol: 'tcp' }]);
    expect(db?.externallyReachable).toBe(false);
    const api = report.reachability.find((r) => r.target === 'orders-api');
    expect(api?.acceptsFrom).toEqual([]); // private, no inbound
  });
});

describe('security findings (IAP6xx)', () => {
  it('IAP601: public exposure on a data store is an error; a non-store is a warning', () => {
    const store = model(
      {
        web: { kind: 'Service', labels: {}, spec: {}, extensions: {} },
        bucket: { kind: 'ObjectStore', labels: {}, spec: { exposure: 'public' }, extensions: {} },
      },
      {
        edges: [
          {
            source: 'web',
            type: 'storesDataIn',
            target: 'bucket',
            attributes: { access: 'read-write' },
          },
        ],
      },
    );
    expect(securityReport(store).findings.find((f) => f.code === 'IAP601')?.severity).toBe('error');

    const bare = model({
      cache: { kind: 'Cache', labels: {}, spec: { exposure: 'public' }, extensions: {} },
    });
    expect(securityReport(bare).findings.find((f) => f.code === 'IAP601')?.severity).toBe(
      'warning',
    );
  });

  it('IAP603: an encryption downgrade under an active framework is an error', () => {
    const m = model(
      {
        db: {
          kind: 'Database',
          labels: {},
          spec: { encryption: { atRest: 'preferred', inTransit: 'required' } },
          extensions: {},
        },
      },
      { compliance: { frameworks: ['pci-dss-4.0'] } },
    );
    const f = securityReport(m).findings.find((x) => x.code === 'IAP603');
    expect(f?.severity).toBe('error');
    expect(f?.path).toBe('/resources/db/spec/encryption/atRest');
  });

  it('IAP603 does not fire without an active framework', () => {
    const m = model({
      db: {
        kind: 'Database',
        labels: {},
        spec: { encryption: { atRest: 'preferred' } },
        extensions: {},
      },
    });
    expect(securityReport(m).findings.some((f) => f.code === 'IAP603')).toBe(false);
  });

  it('IAP602: secret-named config values and well-known token shapes are flagged', () => {
    const named = model({
      web: {
        kind: 'Service',
        labels: {},
        spec: { configuration: { DB_PASSWORD: 'hunter2supersecret' } },
        extensions: {},
      },
    });
    expect(securityReport(named).findings.some((f) => f.code === 'IAP602')).toBe(true);

    const token = model({
      web: {
        kind: 'Service',
        labels: {},
        spec: { configuration: { note: 'AKIAIOSFODNN7EXAMPLE' } },
        extensions: {},
      },
    });
    expect(securityReport(token).findings.some((f) => f.code === 'IAP602')).toBe(true);

    const clean = model({
      web: {
        kind: 'Service',
        labels: {},
        spec: { configuration: { LOG_LEVEL: 'info' } },
        extensions: {},
      },
    });
    expect(securityReport(clean).findings.some((f) => f.code === 'IAP602')).toBe(false);
  });
});

describe('reports over the official corpus', () => {
  it('every example produces a security report; the clean ones have no error findings', async () => {
    for (const name of EXAMPLES) {
      const report = securityReport(await modelOf(name));
      expect(report.reportVersion).toBe('1');
      expect(report.grants.length).toBeGreaterThanOrEqual(0);
      expect(['none', 'low', 'medium', 'high', 'critical']).toContain(report.risk);
      expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    }
  });

  it('is deterministic: identical input yields an identical report', async () => {
    const m = await modelOf('basic-webapp.iap.yaml');
    expect(JSON.stringify(securityReport(m))).toBe(JSON.stringify(securityReport(m)));
  });
});
