/**
 * Package-level conformance: the signed mock package loads through the SDK
 * loader (PC-1), its mapping is deterministic (PC-3 double-run), pure
 * (CM-6 non-interference), and fully traceable (per-attribute provenance).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify } from '@iap/model';
import { abstractOutputsForKind, applyMapping, loadProviderPackage } from '@iap/provider-sdk';
import { canonicalWebshop, mockMapping, packageDir, webshopPlan } from './helpers';

// Committed keypair — TEST MATERIAL ONLY (see keys/README.md).
const publicKeyPem = readFileSync(join(packageDir, 'keys', 'mock-test-2026.public.pem'), 'utf8');
const options = {
  trustStore: { 'mock-test-2026': publicKeyPem },
  allowlist: ['iap-provider-mock'],
};

describe('mock package loads through loadProviderPackage (PC-1)', () => {
  const result = loadProviderPackage(packageDir, options);

  it('verifies signature, digests, compatibility, and coverage tiling', () => {
    expect(result.ok).toBe(true);
  });

  it('claims certification level execution with execute/read/import handlers (PC-5)', () => {
    if (!result.ok) throw new Error('package did not load');
    expect(result.pkg.manifest.certificationLevel).toBe('execution');
    expect(result.pkg.manifest.capabilities.handlers).toEqual(['execute', 'read', 'import']);
    expect(result.pkg.manifest.capabilities.hooks).toBeUndefined();
    expect([...result.pkg.manifest.capabilities.kinds].sort()).toEqual([
      'Alert',
      'Application',
      'Cache',
      'Dashboard',
      'Database',
      'Function',
      'Gateway',
      'Identity',
      'Job',
      'ObjectStore',
      'Queue',
      'Secret',
      'Service',
      'Stream',
      'Topic',
      'Volume',
    ]);
  });

  it('exposes the single core mapping and the extension schema', () => {
    if (!result.ok) throw new Error('package did not load');
    expect(result.pkg.mappings).toHaveLength(1);
    expect(result.pkg.mappings[0]?.artifact.provider).toBe('mock');
    expect(result.pkg.extensionSchema.$id).toBe(
      'https://iap.dev/providers/mock/extension.schema.json',
    );
  });

  it('refuses with an empty trust store (fail closed)', () => {
    const refused = loadProviderPackage(packageDir, { ...options, trustStore: {} });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusals.map((r) => r.code)).toContain('signature');
  });

  it('refuses when the package name is not allowlisted', () => {
    const refused = loadProviderPackage(packageDir, { ...options, allowlist: ['someone-else'] });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusals.map((r) => r.code)).toContain('allowlist');
  });
});

describe('mapping determinism and purity', () => {
  it('double-run hash equality: identical inputs give byte-identical plans (PC-3)', () => {
    const first = webshopPlan();
    const second = webshopPlan();
    expect(first.planHash).toBe(second.planHash);
    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
  });

  it('explicit mapping inputs are recorded and part of the hashed identity', () => {
    const first = webshopPlan({ inputs: { deployRegion: 'mock-east-1' } });
    const second = webshopPlan({ inputs: { deployRegion: 'mock-west-9' } });
    expect(first.inputs).toEqual({ deployRegion: 'mock-east-1' });
    expect(first.planHash).not.toBe(second.planHash);
  });

  it('non-interference: mapping never alters the canonical model (CM-6)', () => {
    const model = canonicalWebshop();
    const hashBefore = model.hash;
    const result = applyMapping(model, mockMapping(), {
      inputs: { deployRegion: 'mock-east-1' },
    });
    expect(result.ok).toBe(true);
    expect(model.hash).toBe(hashBefore);
    expect(Object.isFrozen(model.resources['orders-db']?.spec)).toBe(true);
    expect(() => {
      (model.resources as Record<string, unknown>)['injected'] = {};
    }).toThrow();
  });

  it('every desiredAttributes entry of every plan resource has provenance', () => {
    const plan = webshopPlan();
    expect(plan.resources.length).toBeGreaterThan(0);
    for (const resource of plan.resources) {
      expect(Object.keys(resource.provenance).sort()).toEqual(
        Object.keys(resource.desiredAttributes).sort(),
      );
    }
  });

  it('binds every abstract output attribute of every mapped resource', () => {
    const plan = webshopPlan();
    const model = canonicalWebshop();
    for (const [resourceId, resource] of Object.entries(model.resources)) {
      const bindings = plan.outputBindings[resourceId];
      expect(bindings, resourceId).toBeDefined();
      expect(Object.keys(bindings ?? {}).sort()).toEqual(
        [...abstractOutputsForKind(resource.kind)].sort(),
      );
    }
    expect(plan.outputBindings['orders-db']?.connectionSecret).toEqual({
      logicalId: 'orders-db.mock:core:SecretBox',
      attribute: 'ref',
    });
  });
});
