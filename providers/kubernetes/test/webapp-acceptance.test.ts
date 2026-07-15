/**
 * The mandatory acceptance surface (phase-6 exit criterion): the canonical
 * form of spec/examples/basic-webapp.iap.yaml under the production profile
 * maps through this package with ZERO diagnostics — the same document the
 * AWS reference package maps, proving one model reaches two targets. Also
 * covers the plan obligations: provenance on every attribute (exit criterion
 * "every parameter traceable"), complete output bindings, double-run hash
 * equality (PC-3), and non-interference (CM-6).
 */

import { describe, expect, it } from 'vitest';
import { abstractOutputsForKind, applyMapping } from '@iap/provider-sdk';
import type { ProviderPlan } from '@iap/provider-sdk';
import { TARGETS } from '../src/index';
import { canonicalWebapp, coreMapping } from './helpers';

function webappPlan(): ProviderPlan {
  const result = applyMapping(canonicalWebapp(), coreMapping());
  if (!result.ok) {
    throw new Error(
      `basic-webapp must map cleanly:\n  ${result.diagnostics
        .map((d) => `[${d.reason}] ${d.message}`)
        .join('\n  ')}`,
    );
  }
  return result.plan;
}

describe('basic-webapp acceptance (production profile)', () => {
  it('maps with zero diagnostics and a non-empty plan', () => {
    const result = applyMapping(canonicalWebapp(), coreMapping());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.resources.length).toBeGreaterThan(0);
      expect(result.plan.provider).toBe('kubernetes');
      expect(result.plan.profile).toBe('production');
      expect('diagnostics' in result).toBe(false);
    }
  });

  it('realizes every document resource into its kubernetes decomposition', () => {
    const plan = webappPlan();
    expect(plan.resources.map((r) => r.logicalId).sort()).toEqual(
      [
        `edge.${TARGETS.gateway}`,
        `edge.${TARGETS.httpRoute}`,
        `web.${TARGETS.deployment}`,
        `web.${TARGETS.service}`,
        `web.${TARGETS.horizontalPodAutoscaler}`,
        `web.${TARGETS.networkPolicy}`,
        `orders-db.${TARGETS.postgresCluster}`,
        `orders-db.${TARGETS.secret}`,
        `orders-db.${TARGETS.networkPolicy}`,
        `session-cache.${TARGETS.redisFailover}`,
        `session-cache.${TARGETS.secret}`,
        `session-cache.${TARGETS.networkPolicy}`,
        `assets.${TARGETS.bucket}`,
        `assets.${TARGETS.networkPolicy}`,
        `web-identity.${TARGETS.serviceAccount}`,
        `storefront-app.${TARGETS.namespace}`,
      ].sort(),
    );
  });

  it('every desiredAttributes entry has a provenance record (every parameter traceable)', () => {
    const plan = webappPlan();
    for (const resource of plan.resources) {
      const attributes = Object.keys(resource.desiredAttributes).sort();
      expect(attributes.length).toBeGreaterThan(0);
      expect(Object.keys(resource.provenance).sort()).toEqual(attributes);
      for (const record of Object.values(resource.provenance)) {
        expect(['constant', 'from', 'map']).toContain(record.form);
        if (record.form !== 'constant') {
          expect(record.source).toMatch(/^spec\./);
        }
      }
    }
  });

  it('derives the production-profile values, not the base document values', () => {
    const plan = webappPlan();
    const attr = (logicalId: string) =>
      plan.resources.find((r) => r.logicalId === logicalId)?.desiredAttributes ?? {};
    // web: size l, scaling {min: 2, max: 6}, availability high (production overrides).
    expect(attr(`web.${TARGETS.deployment}`)).toMatchObject({
      image: 'registry.example.com/storefront:1.4.2',
      cpuRequest: '2',
      memoryRequest: '4Gi',
      replicas: 2,
      zoneSpread: true,
      probePath: '/healthz',
      probePort: 8080,
      probeInterval: '30s',
    });
    expect(attr(`web.${TARGETS.horizontalPodAutoscaler}`)).toMatchObject({
      minReplicas: 2,
      maxReplicas: 6,
      targetCPUUtilizationPercentage: 70,
    });
    // orders-db: availability high in production → 2 synchronous instances.
    expect(attr(`orders-db.${TARGETS.postgresCluster}`)).toMatchObject({
      engine: 'postgres',
      postgresVersion: '16',
      instances: 2,
      synchronousReplication: true,
      storage: '20Gi',
      storageClassEncrypted: true,
      tlsRequired: true,
      backupsEnabled: true,
    });
    // exposure: private realizes as default-deny NetworkPolicy; web is
    // internal, so its policy does not default-deny.
    expect(attr(`orders-db.${TARGETS.networkPolicy}`).defaultDenyIngress).toBe(true);
    expect(attr(`web.${TARGETS.networkPolicy}`).defaultDenyIngress).toBe(false);
  });

  it('binds every abstract output attribute of every mapped kind (ch. 12 §12.5)', () => {
    const plan = webappPlan();
    const model = canonicalWebapp();
    for (const [resourceId, resource] of Object.entries(model.resources)) {
      const bindings = plan.outputBindings[resourceId] ?? {};
      expect(Object.keys(bindings).sort()).toEqual(
        [...abstractOutputsForKind(resource.kind)].sort(),
      );
      for (const binding of Object.values(bindings)) {
        expect(plan.resources.some((r) => r.logicalId === binding.logicalId)).toBe(true);
        expect(binding.attribute.length).toBeGreaterThan(0);
      }
    }
    // The document's own outputs resolve through the bindings.
    expect(plan.outputBindings['edge']?.['endpoint']).toEqual({
      logicalId: `edge.${TARGETS.gateway}`,
      attribute: 'status.address',
    });
    expect(plan.outputBindings['orders-db']?.['connectionSecret']).toEqual({
      logicalId: `orders-db.${TARGETS.secret}`,
      attribute: 'metadata.name',
    });
  });

  it('derives dependsOn from the canonical edges', () => {
    const plan = webappPlan();
    const web = plan.resources.find((r) => r.logicalId === `web.${TARGETS.deployment}`);
    expect(web?.dependsOn).toEqual(
      [
        `orders-db.${TARGETS.postgresCluster}`,
        `orders-db.${TARGETS.secret}`,
        `orders-db.${TARGETS.networkPolicy}`,
        `session-cache.${TARGETS.redisFailover}`,
        `session-cache.${TARGETS.secret}`,
        `session-cache.${TARGETS.networkPolicy}`,
        `assets.${TARGETS.bucket}`,
        `assets.${TARGETS.networkPolicy}`,
        `web-identity.${TARGETS.serviceAccount}`,
      ].sort(),
    );
    const edge = plan.resources.find((r) => r.logicalId === `edge.${TARGETS.gateway}`);
    expect(edge?.dependsOn).toEqual(
      [
        `web.${TARGETS.deployment}`,
        `web.${TARGETS.service}`,
        `web.${TARGETS.horizontalPodAutoscaler}`,
        `web.${TARGETS.networkPolicy}`,
      ].sort(),
    );
  });

  it('double-run: byte-identical plans and equal plan hashes (PC-3)', () => {
    const first = applyMapping(canonicalWebapp(), coreMapping());
    const second = applyMapping(canonicalWebapp(), coreMapping());
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.plan.planHash).toBe(first.plan.planHash);
      expect(JSON.stringify(second.plan)).toBe(JSON.stringify(first.plan));
    }
  });

  it('non-interference: the canonical model is unchanged and frozen (CM-6)', () => {
    const model = canonicalWebapp();
    const hashBefore = model.hash;
    const result = applyMapping(model, coreMapping());
    expect(result.ok).toBe(true);
    expect(model.hash).toBe(hashBefore);
    // Mapping must never edit intent: the engine froze the model.
    expect(() => {
      (model.resources['web'] as { spec: Record<string, unknown> }).spec['size'] = 'xs';
    }).toThrow(TypeError);
    // A fresh canonicalization still hashes identically.
    expect(canonicalWebapp().hash).toBe(hashBefore);
  });
});
