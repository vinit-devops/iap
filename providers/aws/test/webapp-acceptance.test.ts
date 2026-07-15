/**
 * The milestone's mandatory acceptance surface: the canonical form of
 * `spec/examples/basic-webapp.iap.yaml` under the **production** profile maps
 * with zero diagnostics — the exact document the shared conformance runner
 * uses for the cross-provider equivalence check against the Kubernetes
 * package. Also proves the phase-6 exit criteria on a real package: every
 * parameter traceable (provenance), double-run hash equality (PC-3), and
 * non-interference with the canonical model (CM-6).
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify } from '@iap/model';
import type { ProviderPlan } from '@iap/provider-sdk';
import { abstractOutputsForKind, applyMapping } from '@iap/provider-sdk';
import { canonicalModelFor, coreMapping, repoRoot } from './helpers';

const webappPath = join(repoRoot, 'spec', 'examples', 'basic-webapp.iap.yaml');

function mapWebapp(): ProviderPlan {
  const model = canonicalModelFor(webappPath, 'production');
  const result = applyMapping(model, coreMapping());
  if (!result.ok) {
    throw new Error(
      `basic-webapp did not map cleanly: ${result.diagnostics
        .map((d) => `[${d.reason}] ${d.message}`)
        .join('; ')}`,
    );
  }
  return result.plan;
}

describe('basic-webapp acceptance (production profile)', () => {
  it('maps with zero diagnostics and a complete, non-empty plan', () => {
    const model = canonicalModelFor(webappPath, 'production');
    const result = applyMapping(model, coreMapping());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.resources.length).toBeGreaterThan(0);
    expect(result.plan.provider).toBe('aws');
    expect(result.plan.mappingVersion).toBe('0.1.0');
    expect(result.plan.profile).toBe('production');
    expect(result.plan.documentHash).toBe(model.hash);
  });

  it('realizes every resource into the expected AWS targets', () => {
    const plan = mapWebapp();
    expect(plan.resources.map((r) => r.logicalId)).toEqual([
      'assets.aws:s3:Bucket',
      'edge.aws:elasticloadbalancing:LoadBalancer',
      'edge.aws:acm:Certificate',
      'orders-db.aws:rds:DBInstance',
      'orders-db.aws:rds:DBSubnetGroup',
      'orders-db.aws:secretsmanager:Secret',
      'session-cache.aws:elasticache:ReplicationGroup',
      'session-cache.aws:secretsmanager:Secret',
      'storefront-app.aws:resourcegroups:Group',
      'web.aws:ecs:Service',
      'web.aws:elasticloadbalancing:TargetGroup',
      'web-identity.aws:iam:Role',
    ]);
  });

  it('every desiredAttributes entry has a provenance record (every parameter traceable)', () => {
    const plan = mapWebapp();
    for (const resource of plan.resources) {
      const attributes = Object.keys(resource.desiredAttributes).sort();
      expect(attributes.length, `${resource.logicalId} derives no attributes`).toBeGreaterThan(0);
      expect(Object.keys(resource.provenance).sort()).toEqual(attributes);
      for (const record of Object.values(resource.provenance)) {
        expect(['constant', 'from', 'map']).toContain(record.form);
        if (record.form !== 'constant') expect(record.source).toMatch(/^spec\./);
      }
    }
  });

  it('derives the production-profile intent floors into AWS attributes', () => {
    const plan = mapWebapp();
    const attrs = new Map(plan.resources.map((r) => [r.logicalId, r.desiredAttributes]));
    const db = attrs.get('orders-db.aws:rds:DBInstance')!;
    expect(db.multiAZ).toBe(true); // availability: high (production override)
    expect(db.storageEncrypted).toBe(true);
    expect(db.requireSecureTransport).toBe(true);
    expect(db.publiclyAccessible).toBe(false);
    expect(db.engine).toBe('postgres');
    expect(db.instanceClass).toBe('db.m7g.large'); // size: m (specification default)
    expect(db.backupRetentionPeriod).toBe(30); // resilience.backup: required
    const web = attrs.get('web.aws:ecs:Service')!;
    expect(web.cpu).toBe(2048); // size: l (production override)
    expect(web.desiredCount).toBe(2); // scaling.min: 2 (production override)
    expect(web.availabilityZoneSpread).toBe(3); // availability: high
    const lb = attrs.get('edge.aws:elasticloadbalancing:LoadBalancer')!;
    expect(lb.scheme).toBe('internet-facing');
    expect(lb.sslPolicy).toBe('ELBSecurityPolicy-TLS13-1-3-2021-06'); // tls 1.3
  });

  it('binds every abstract output attribute for every document resource', () => {
    const plan = mapWebapp();
    const model = canonicalModelFor(webappPath, 'production');
    for (const [resourceId, resource] of Object.entries(model.resources)) {
      const bindings = plan.outputBindings[resourceId] ?? {};
      expect(Object.keys(bindings).sort()).toEqual(
        [...abstractOutputsForKind(resource.kind)].sort(),
      );
      for (const binding of Object.values(bindings)) {
        expect(plan.resources.some((r) => r.logicalId === binding.logicalId)).toBe(true);
      }
    }
  });

  it('derives dependsOn from the canonical edges', () => {
    const plan = mapWebapp();
    const web = plan.resources.find((r) => r.logicalId === 'web.aws:ecs:Service')!;
    expect(web.dependsOn).toEqual([
      'assets.aws:s3:Bucket',
      'orders-db.aws:rds:DBInstance',
      'orders-db.aws:rds:DBSubnetGroup',
      'orders-db.aws:secretsmanager:Secret',
      'session-cache.aws:elasticache:ReplicationGroup',
      'session-cache.aws:secretsmanager:Secret',
      'web-identity.aws:iam:Role',
    ]);
    const edge = plan.resources.find((r) => r.logicalId === 'edge.aws:acm:Certificate')!;
    expect(edge.dependsOn).toEqual([
      'web.aws:ecs:Service',
      'web.aws:elasticloadbalancing:TargetGroup',
    ]);
  });

  it('double-run produces byte-identical plans with equal hashes (PC-3)', () => {
    const first = mapWebapp();
    const second = mapWebapp();
    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
    expect(first.planHash).toBe(second.planHash);
  });

  it('never modifies the canonical model (CM-6 non-interference)', () => {
    const model = canonicalModelFor(webappPath, 'production');
    const hashBefore = model.hash;
    const result = applyMapping(model, coreMapping());
    expect(result.ok).toBe(true);
    expect(canonicalModelFor(webappPath, 'production').hash).toBe(hashBefore);
    // The engine deep-freezes its input: post-mapping mutation attempts throw.
    expect(() => {
      (model.resources['orders-db']!.spec as Record<string, unknown>).engine = 'mysql';
    }).toThrow(TypeError);
  });
});
