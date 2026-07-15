/**
 * `@iap/compliance` — the compliance engine (spec ch. 17). Pins the six-bundle
 * registry, control dispositions (satisfied/violated/not-applicable), IAP701
 * control findings and IAP702 structural findings, label scoping, the ch. 17.8
 * worked example, determinism, and the configuration-coverage-not-certification
 * distinction.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from '@iap/sdk';
import type { CanonicalModel } from '@iap/model';
import { FRAMEWORK_BUNDLES, evaluateCompliance } from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
async function modelOf(name: string): Promise<CanonicalModel> {
  return (await load({ path: join(repoRoot, 'spec', 'examples', name) })).canonical().model;
}

function model(
  resources: Record<string, unknown>,
  frameworks: string[],
  extra: Record<string, unknown> = {},
): CanonicalModel {
  return {
    apiVersion: 'iap.dev/v1',
    metadata: { name: 't' },
    resources,
    edges: [],
    policies: [],
    compliance: { frameworks },
    profile: null,
    hash: '0'.repeat(64),
    provenance: {},
    diagnostics: [],
    ...extra,
  } as unknown as CanonicalModel;
}

describe('the framework registry (§17.1)', () => {
  it('contains exactly the six schema-enum frameworks, each versioned', () => {
    expect(Object.keys(FRAMEWORK_BUNDLES).sort()).toEqual([
      'cis-8.0',
      'hipaa',
      'iso27001-2022',
      'nist-800-53-r5',
      'pci-dss-4.0',
      'soc2',
    ]);
    for (const bundle of Object.values(FRAMEWORK_BUNDLES)) {
      expect(bundle.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(bundle.controls.length).toBeGreaterThan(0);
    }
  });
});

describe('dispositions and IAP701 (§17.4/§17.6)', () => {
  it('a satisfying resource yields a satisfied disposition and no finding for that control', () => {
    const m = model(
      {
        db: {
          kind: 'Database',
          labels: {},
          spec: { encryption: { atRest: 'required' } },
          extensions: {},
        },
      },
      ['iso27001-2022'],
    );
    const report = evaluateCompliance(m);
    const a824 = report.evidence.find((e) => e.control === 'A.8.24'); // encryption at rest
    expect(a824?.disposition).toBe('satisfied');
    expect(report.findings.some((f) => String(f.policyId).includes('A.8.24'))).toBe(false);
  });

  it('a violating resource yields a violated disposition and an IAP701 finding with the control id', () => {
    const m = model(
      {
        db: {
          kind: 'Database',
          labels: {},
          spec: { encryption: { atRest: 'preferred' } },
          extensions: {},
        },
      },
      ['iso27001-2022'],
    );
    const report = evaluateCompliance(m);
    const a824 = report.evidence.find((e) => e.control === 'A.8.24');
    expect(a824?.disposition).toBe('violated');
    expect(a824?.remediation).toBeDefined();
    const finding = report.findings.find(
      (f) => f.code === 'IAP701' && String(f.policyId).includes('A.8.24'),
    );
    expect(finding).toMatchObject({ severity: 'error', path: '/resources/db' });
    expect(finding?.policyId).toBe('iso27001-2022/A.8.24@1.0.0');
  });

  it('a control with no matching resources is not-applicable', () => {
    const m = model({ web: { kind: 'Service', labels: {}, spec: {}, extensions: {} } }, [
      'iso27001-2022',
    ]);
    // A.8.24 targets data kinds; there are none.
    expect(evaluateCompliance(m).evidence.find((e) => e.control === 'A.8.24')?.disposition).toBe(
      'not-applicable',
    );
  });
});

describe('label scoping (§17.7)', () => {
  it('scoped controls only apply to resources carrying the scope label', () => {
    const m = model(
      {
        scoped: {
          kind: 'Database',
          labels: { 'pci-scope': 'true' },
          spec: { encryption: { atRest: 'preferred' } },
          extensions: {},
        },
        unscoped: {
          kind: 'Database',
          labels: {},
          spec: { encryption: { atRest: 'preferred' } },
          extensions: {},
        },
      },
      ['pci-dss-4.0'],
    );
    const report = evaluateCompliance(m);
    const finding = report.findings.find(
      (f) => f.code === 'IAP701' && f.path === '/resources/scoped',
    );
    expect(finding).toBeDefined();
    // The unscoped database is out of scope → no finding.
    expect(report.findings.some((f) => f.path === '/resources/unscoped')).toBe(false);
  });

  it('IAP702: a scoped framework declared with nothing in scope is structurally unmet', () => {
    const m = model(
      {
        db: {
          kind: 'Database',
          labels: {},
          spec: { encryption: { atRest: 'required' } },
          extensions: {},
        },
      },
      ['pci-dss-4.0'],
    );
    expect(evaluateCompliance(m).findings.some((f) => f.code === 'IAP702')).toBe(true);
  });
});

describe('the ch. 17.8 worked example', () => {
  it('the PCI encryption downgrade on the in-scope db is a control violation', () => {
    const m = model(
      {
        'payments-api': {
          kind: 'Service',
          labels: { 'pci-scope': 'true' },
          spec: { exposure: 'private' },
          extensions: {},
        },
        'payments-db': {
          kind: 'Database',
          labels: { 'pci-scope': 'true' },
          spec: { class: 'relational', encryption: { atRest: 'preferred', inTransit: 'required' } },
          extensions: {},
        },
        'audit-log-store': {
          kind: 'ObjectStore',
          labels: {},
          spec: { versioning: 'enabled' },
          extensions: {},
        },
      },
      ['pci-dss-4.0'],
    );
    const report = evaluateCompliance(m);
    const req3 = report.evidence.find((e) => e.control === '3.5.1');
    expect(req3?.disposition).toBe('violated');
    expect(req3?.resources).toContain('payments-db');
    // audit-log-store is unscoped → not the subject of scoped controls.
    expect(report.findings.some((f) => f.path === '/resources/audit-log-store')).toBe(false);
  });
});

describe('reports over the corpus', () => {
  it('a document with active frameworks evaluates; one without produces an empty report', async () => {
    const pci = evaluateCompliance(await modelOf('enterprise-pci.iap.yaml'));
    expect(pci.frameworks).toContain('pci-dss-4.0');
    expect(pci.evidence.length).toBeGreaterThan(0);
    expect(pci.disclaimer).toContain('NOT a claim of formal certification');

    const none = evaluateCompliance(await modelOf('basic-webapp.iap.yaml'));
    expect(none.frameworks).toEqual([]);
    expect(none.evidence).toEqual([]);
  });

  it('is deterministic (§17.3): identical input yields an identical report', async () => {
    const m = await modelOf('enterprise-pci.iap.yaml');
    expect(JSON.stringify(evaluateCompliance(m))).toBe(JSON.stringify(evaluateCompliance(m)));
  });
});
