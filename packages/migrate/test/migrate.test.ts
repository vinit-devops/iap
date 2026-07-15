/**
 * `@iap/migrate` — the Kubernetes migration importer (roadmap Phase 18). Pins
 * the importer contract: existing infrastructure is translated into IaP through
 * the operation gate (so the result is validated IaP), and constructs the
 * importer cannot faithfully map are reported explicitly, never guessed.
 */
import { describe, expect, it } from 'vitest';
import { load, validateExtensions } from '@iap/sdk';
import type { IaPDocument } from '@iap/model';
import { importKubernetes } from '../src/index';

const MANIFESTS = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web-app }
spec:
  template:
    spec:
      containers:
        - name: web
          image: registry.example.com/web:1.4.2
---
apiVersion: batch/v1
kind: Job
metadata: { name: nightly }
spec:
  template:
    spec:
      containers:
        - name: etl
          image: registry.example.com/etl:2.0.0
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: data }
spec:
  resources: { requests: { storage: 20Gi } }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: settings }
---
apiVersion: v1
kind: Service
metadata: { name: web-svc }
`;

describe('importKubernetes', () => {
  it('imports mappable workloads/volumes and reports unmappable constructs', async () => {
    const result = await importKubernetes(MANIFESTS, 'migrated');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byKind = Object.fromEntries(result.imported.map((i) => [i.from, i.kind]));
    expect(byKind['Deployment/web-app']).toBe('Service');
    expect(byKind['Job/nightly']).toBe('Job');
    expect(byKind['PersistentVolumeClaim/data']).toBe('Volume');

    // ConfigMap and Service are reported unmapped, never guessed into intent.
    const unmappedFrom = result.unmapped.map((u) => u.from);
    expect(unmappedFrom).toContain('ConfigMap/settings');
    expect(unmappedFrom).toContain('Service/web-svc');
    for (const u of result.unmapped) expect(u.reason.length).toBeGreaterThan(0);
  });

  it('the imported document is valid IaP (produced through the gate)', async () => {
    const result = await importKubernetes(MANIFESTS, 'migrated');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ws = await load(result.yaml);
    expect(ws.ok).toBe(true);
    const findings = [
      ...ws.validate().findings,
      ...ws.policies().findings,
      ...validateExtensions(ws.document as IaPDocument),
    ];
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    // The Volume carried its capacity through.
    expect((ws.document as IaPDocument).resources.data).toBeDefined();
  });

  it('is deterministic: the same manifests import to byte-identical IaP', async () => {
    const a = await importKubernetes(MANIFESTS, 'migrated');
    const b = await importKubernetes(MANIFESTS, 'migrated');
    expect(a.ok && b.ok && a.yaml === b.yaml).toBe(true);
  });

  it('manifests with nothing mappable fail with the unmapped report, not a guess', async () => {
    const result = await importKubernetes(
      'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: only }\n',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unmapped.map((u) => u.from)).toContain('ConfigMap/only');
  });
});
