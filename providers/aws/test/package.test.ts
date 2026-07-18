/**
 * Package-level verification: the committed AWS package loads through
 * `loadProviderPackage` (signature, digests, compat, coverage tiling), any
 * tampering refuses the whole package (PC-1), capability claims match
 * coverage exactly (PC-5), and the extension schema validates the documented
 * refinement shape.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createValidator } from '@iap/parser';
import { abstractOutputsForKind, loadProviderPackage } from '@iap/provider-sdk';
import { AWS_PROVIDER_NAMESPACE, AWS_PROVIDER_PACKAGE_NAME } from '../src/index';
import { coreMapping, loadAwsPackage, loadOptions, packageDir } from './helpers';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Copy only the signed artifact surface into a temp dir, then mutate it. */
function tamperedCopy(mutate: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'iap-provider-aws-test-'));
  tempDirs.push(dir);
  for (const entry of ['mappings', 'schema', 'conformance']) {
    cpSync(join(packageDir, entry), join(dir, entry), { recursive: true });
  }
  cpSync(join(packageDir, 'manifest.json'), join(dir, 'manifest.json'));
  mutate(dir);
  return dir;
}

describe('signed package loads (PC-1 happy path)', () => {
  it('loads with the committed trust store and allowlist', () => {
    const pkg = loadAwsPackage();
    expect(pkg.manifest.name).toBe(AWS_PROVIDER_PACKAGE_NAME);
    expect(pkg.manifest.namespace).toBe(AWS_PROVIDER_NAMESPACE);
    expect(pkg.manifest.version).toBe('0.1.0');
    expect(pkg.manifest.certificationLevel).toBe('core');
    expect(pkg.manifest.specCompat).toBe('>=1.0.0 <2.0.0');
    expect(pkg.mappings.map((m) => m.path)).toEqual(['mappings/core.iap-map.yaml']);
  });

  it('capabilities.kinds exactly matches the kinds the mapping covers (PC-5)', () => {
    const pkg = loadAwsPackage();
    const covered = Object.keys(pkg.mappings[0]!.artifact.mappings).sort();
    expect([...pkg.manifest.capabilities.kinds].sort()).toEqual(covered);
    expect(covered).toEqual([
      'Application',
      'Cache',
      'Database',
      'Function',
      'Gateway',
      'Identity',
      'Job',
      'ObjectStore',
      'Queue',
      'Secret',
      'Service',
      'Topic',
    ]);
  });

  it('binds every abstract output attribute of every covered kind (CM-4)', () => {
    const mapping = coreMapping();
    for (const [kind, km] of Object.entries(mapping.mappings)) {
      for (const attribute of abstractOutputsForKind(kind)) {
        expect(km.outputs, `${kind} must bind ${attribute}`).toHaveProperty(attribute);
      }
    }
  });
});

describe('load refusals (PC-1 fail closed)', () => {
  it('refuses with an empty trust store', () => {
    const result = loadProviderPackage(packageDir, { ...loadOptions(), trustStore: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.map((r) => r.code)).toEqual(['signature']);
  });

  it('refuses a package name outside the allowlist', () => {
    const result = loadProviderPackage(packageDir, {
      ...loadOptions(),
      allowlist: ['iap-provider-other'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.map((r) => r.code)).toEqual(['allowlist']);
  });

  it('refuses tampered mapping bytes — stale digest fails the loader', () => {
    const dir = tamperedCopy((copy) => {
      const path = join(copy, 'mappings', 'core.iap-map.yaml');
      writeFileSync(path, readFileSync(path, 'utf8').replace('storageEncrypted', 'weakened'));
    });
    const result = loadProviderPackage(dir, loadOptions());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.map((r) => r.code)).toEqual(['integrity']);
      expect(result.refusals[0]!.message).toMatch(/digest mismatch/);
    }
  });

  it('refuses an unsigned artifact smuggled into the conformance corpus', () => {
    const dir = tamperedCopy((copy) => {
      mkdirSync(join(copy, 'conformance', 'corpus'), { recursive: true });
      writeFileSync(
        join(copy, 'conformance', 'corpus', 'extra.iap.yaml'),
        'apiVersion: iap.dev/v1\n',
      );
    });
    const result = loadProviderPackage(dir, loadOptions());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.map((r) => r.code)).toEqual(['integrity']);
      expect(result.refusals[0]!.message).toMatch(/no integrity digest/);
    }
  });
});

describe('extension schema (extensions.aws refinement)', () => {
  const validator = () => createValidator(loadAwsPackage().extensionSchema);

  it('accepts the documented refinement shape', () => {
    const validate = validator();
    expect(
      validate({
        version: '0.1.0',
        resources: {
          'orders-db': {
            backupWindow: '03:00-04:00',
            instanceClassHint: 'db.r7g.large',
            tags: { costCenter: 'cc-142' },
          },
        },
      }),
    ).toBe(true);
  });

  it('rejects a malformed backup window', () => {
    const validate = validator();
    expect(validate({ resources: { 'orders-db': { backupWindow: '3am-4am' } } })).toBe(false);
  });

  it('rejects unknown refinement properties (additionalProperties: false)', () => {
    const validate = validator();
    expect(validate({ resources: { 'orders-db': { publiclyAccessible: true } } })).toBe(false);
    expect(validate({ region: 'us-east-1' })).toBe(false);
  });
});
