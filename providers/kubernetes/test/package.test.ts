/**
 * Package-level checks: the signed kubernetes provider package loads through
 * `loadProviderPackage` (signature, digests, compat, coverage tiling — PC-1
 * is enforced by the loader; a load here proves the package passes it), the
 * manifest claims exactly what the mapping covers (PC-5), and the extension
 * schema validates `extensions.kubernetes` refinement content.
 */

import { describe, expect, it } from 'vitest';
import { createValidator } from '@iap/parser';
import { loadProviderPackage } from '@iap/provider-sdk';
import { PROVIDER_NAMESPACE, PROVIDER_PACKAGE_NAME, TARGETS } from '../src/index';
import { coreMapping, loadPackage, packageDir, packageTrustStore } from './helpers';

describe('kubernetes provider package — loading (PC-1 surface)', () => {
  it('loads via loadProviderPackage with the committed trust material', () => {
    const pkg = loadPackage();
    expect(pkg.manifest.name).toBe(PROVIDER_PACKAGE_NAME);
    expect(pkg.manifest.namespace).toBe(PROVIDER_NAMESPACE);
    expect(pkg.manifest.version).toBe('0.1.0');
  });

  it('claims exactly one certification level: core (PC-5)', () => {
    expect(loadPackage().manifest.certificationLevel).toBe('core');
  });

  it('claims exactly the kinds the mapping covers', () => {
    const pkg = loadPackage();
    const covered = Object.keys(coreMapping().mappings).sort();
    expect([...pkg.manifest.capabilities.kinds].sort()).toEqual(covered);
    expect(covered).toEqual([
      'Application',
      'Cache',
      'Database',
      'Gateway',
      'Identity',
      'ObjectStore',
      'Queue',
      'Service',
    ]);
  });

  it('the mapping artifact belongs to the kubernetes namespace', () => {
    const mapping = coreMapping();
    expect(mapping.provider).toBe('kubernetes');
    expect(mapping.specCompat).toBe('>=1.0.0 <2.0.0');
  });

  it('refuses to load when the package name is not allowlisted', () => {
    const result = loadProviderPackage(packageDir, {
      trustStore: packageTrustStore(),
      allowlist: ['some-other-package'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.map((r) => r.code)).toContain('allowlist');
    }
  });

  it('refuses to load against an empty trust store (fail closed)', () => {
    const result = loadProviderPackage(packageDir, {
      trustStore: {},
      allowlist: [PROVIDER_PACKAGE_NAME],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.map((r) => r.code)).toContain('signature');
    }
  });
});

describe('kubernetes provider package — extension schema', () => {
  const validate = () => createValidator(loadPackage().extensionSchema);

  it('accepts a well-formed extensions.kubernetes refinement', () => {
    expect(
      validate()({
        version: '0.1.0',
        resources: {
          'orders-db': {
            namespace: 'shop-data',
            storageClassHint: 'encrypted-ssd',
            replicasHint: 3,
          },
        },
      }),
    ).toBe(true);
  });

  it('rejects unknown refinement properties (additionalProperties: false)', () => {
    expect(validate()({ resources: { 'orders-db': { instanceClass: 'db.r6g' } } })).toBe(false);
  });

  it('rejects a namespace that is not a DNS label', () => {
    expect(validate()({ resources: { 'orders-db': { namespace: 'Not-A-Label-' } } })).toBe(false);
  });

  it('rejects resource keys outside the resource-id grammar', () => {
    expect(validate()({ resources: { Bad_Key: { namespace: 'shop' } } })).toBe(false);
  });
});

describe('kubernetes provider package — target vocabulary', () => {
  it('every target type the mapping produces is provider-namespaced to kubernetes', () => {
    const mapping = coreMapping();
    const produced = new Set(
      Object.values(mapping.mappings).flatMap((km) => km.realize.flatMap((r) => r.targets)),
    );
    for (const target of produced) {
      expect(target.startsWith('kubernetes:')).toBe(true);
    }
    // The exported constants stay in lockstep with the mapping artifact.
    for (const target of Object.values(TARGETS)) {
      expect(produced.has(target)).toBe(true);
    }
    expect(produced.size).toBe(Object.values(TARGETS).length);
  });
});
