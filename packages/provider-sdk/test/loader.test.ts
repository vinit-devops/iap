import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import type { LoadProviderPackageResult, PluginManifest } from '../src/index';
import { computeArtifactDigest, loadProviderPackage, signManifest } from '../src/index';

const fixtures = join(__dirname, 'fixtures');
const packageDir = join(fixtures, 'tiny-provider');
// Committed keypair — TEST MATERIAL ONLY (see fixtures/keys/README.md).
const privateKeyPem = readFileSync(join(fixtures, 'keys', 'test-only.private.pem'), 'utf8');
const publicKeyPem = readFileSync(join(fixtures, 'keys', 'test-only.public.pem'), 'utf8');

const options = {
  trustStore: { 'test-only-2026': publicKeyPem },
  allowlist: ['iap-provider-tiny'],
};

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Copy the fixture package into a temp dir, mutate it, and (optionally) re-pin + re-sign. */
function tamperedCopy(
  mutate: (dir: string, manifest: PluginManifest) => void,
  {
    resign = true,
    afterPin,
  }: { resign?: boolean; afterPin?: (manifest: PluginManifest) => void } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'iap-provider-sdk-test-'));
  tempDirs.push(dir);
  cpSync(packageDir, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as PluginManifest;
  mutate(dir, manifest);
  if (resign) {
    for (const path of Object.keys(manifest.integrity.digests)) {
      manifest.integrity.digests[path] = computeArtifactDigest(readFileSync(join(dir, path)));
    }
    afterPin?.(manifest);
    const signed = signManifest(manifest, privateKeyPem, 'test-only-2026');
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(signed, null, 2)}\n`);
  } else {
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return dir;
}

function refusalCodes(result: LoadProviderPackageResult): string[] {
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

type MappingDoc = {
  mappings: Record<
    string,
    {
      realize: Array<{
        when?: Record<string, unknown>;
        derive?: Record<string, Record<string, unknown>>;
      }>;
      outputs?: Record<string, { from: string }>;
    }
  >;
};

function rewriteMapping(dir: string, edit: (mapping: MappingDoc) => void): void {
  const path = join(dir, 'mappings', 'core.iap-map.yaml');
  const mapping = parse(readFileSync(path, 'utf8')) as MappingDoc;
  edit(mapping);
  writeFileSync(path, stringify(mapping));
}

describe('loadProviderPackage — happy path (PC-1 obverse)', () => {
  it('loads the committed, signed fixture package', () => {
    const result = loadProviderPackage(packageDir, options);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pkg.manifest.namespace).toBe('tiny');
      expect(result.pkg.mappings).toHaveLength(1);
      expect(Object.keys(result.pkg.mappings[0]!.artifact.mappings).sort()).toEqual([
        'Database',
        'Queue',
      ]);
      expect(result.pkg.extensionSchema).toHaveProperty('$id');
    }
  });
});

describe('loadProviderPackage — refusals (PC-1: no degraded load)', () => {
  it('refuses when manifest.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iap-provider-sdk-empty-'));
    tempDirs.push(dir);
    expect(refusalCodes(loadProviderPackage(dir, options))).toEqual(['manifest-missing']);
  });

  it('refuses a package not on the allowlist', () => {
    const result = loadProviderPackage(packageDir, { ...options, allowlist: ['iap-provider-aws'] });
    expect(refusalCodes(result)).toEqual(['allowlist']);
  });

  it('refuses a tampered manifest (bad signature)', () => {
    const dir = tamperedCopy(
      (_dir, manifest) => {
        manifest.version = '1.0.1';
      },
      { resign: false },
    );
    expect(refusalCodes(loadProviderPackage(dir, options))).toEqual(['signature']);
  });

  it('refuses an unknown signing key', () => {
    const result = loadProviderPackage(packageDir, { ...options, trustStore: {} });
    expect(refusalCodes(result)).toEqual(['signature']);
  });

  it('refuses a tampered artifact (digest mismatch)', () => {
    const dir = tamperedCopy(
      (copyDir) => {
        const path = join(copyDir, 'mappings', 'core.iap-map.yaml');
        writeFileSync(path, readFileSync(path, 'utf8').replace('multiZone', 'singleZone'));
      },
      { resign: false },
    );
    // Manifest untouched: signature still verifies, but the pinned bytes changed.
    const result = loadProviderPackage(dir, options);
    expect(refusalCodes(result)).toEqual(['integrity']);
    if (!result.ok) expect(result.refusals[0]!.message).toMatch(/digest mismatch/);
  });

  it('refuses a missing digest entry', () => {
    const dir = tamperedCopy((_dir, manifest) => {
      delete manifest.integrity.digests['schema/extension.schema.json'];
    });
    const result = loadProviderPackage(dir, options);
    expect(refusalCodes(result)).toEqual(['integrity']);
    if (!result.ok) expect(result.refusals[0]!.message).toMatch(/no integrity digest/);
  });

  it('refuses path traversal in artifact paths', () => {
    const dir = tamperedCopy(() => {}, {
      afterPin: (manifest) => {
        manifest.integrity.digests['../escape.yaml'] = `sha256:${'0'.repeat(64)}`;
      },
    });
    expect(refusalCodes(loadProviderPackage(dir, options))).toEqual(['integrity']);
  });

  it('refuses a package whose specCompat excludes the spec version in force', () => {
    const result = loadProviderPackage(packageDir, { ...options, specVersion: '2.5.0' });
    expect(refusalCodes(result)).toContain('spec-compat');
  });

  it('refuses a package whose sdkCompat excludes the SDK version in force', () => {
    const result = loadProviderPackage(packageDir, { ...options, sdkVersion: '9.9.9' });
    expect(refusalCodes(result)).toEqual(['sdk-compat']);
  });

  it('refuses a mapping whose provider differs from the package namespace', () => {
    const dir = tamperedCopy((copyDir) => {
      const path = join(copyDir, 'mappings', 'core.iap-map.yaml');
      writeFileSync(path, readFileSync(path, 'utf8').replace('provider: tiny', 'provider: mega'));
    });
    expect(refusalCodes(loadProviderPackage(dir, options))).toEqual(['artifact-invalid']);
  });

  it('refuses capability claims not backed by a mapping (no inflated claims)', () => {
    const dir = tamperedCopy((_dir, manifest) => {
      manifest.capabilities.kinds = [...manifest.capabilities.kinds, 'Service'];
    });
    const result = loadProviderPackage(dir, options);
    expect(refusalCodes(result)).toEqual(['artifact-invalid']);
    if (!result.ok) expect(result.refusals[0]!.message).toMatch(/claims Service/);
  });

  it('refuses a schema-invalid mapping artifact', () => {
    const dir = tamperedCopy((copyDir) => {
      rewriteMapping(copyDir, (mapping) => {
        delete (mapping.mappings.Queue as { supports?: unknown }).supports;
      });
    });
    expect(refusalCodes(loadProviderPackage(dir, options))).toContain('artifact-invalid');
  });

  it('refuses a derive-map gap (CM-3: total maps)', () => {
    const dir = tamperedCopy((copyDir) => {
      rewriteMapping(copyDir, (mapping) => {
        const derive = mapping.mappings.Database!.realize[0]!.derive!;
        delete (derive['tiny:sql:Instance.engine']!.map as Record<string, unknown>).mysql;
      });
    });
    const result = loadProviderPackage(dir, options);
    expect(refusalCodes(result)).toEqual(['coverage-tiling']);
    if (!result.ok) expect(result.refusals[0]!.message).toMatch(/derive-map-gap.*mysql/s);
  });

  it('refuses an unbound abstract output attribute (CM-4)', () => {
    const dir = tamperedCopy((copyDir) => {
      rewriteMapping(copyDir, (mapping) => {
        delete mapping.mappings.Database!.outputs!.connectionSecret;
      });
    });
    const result = loadProviderPackage(dir, options);
    expect(refusalCodes(result)).toEqual(['coverage-tiling']);
    if (!result.ok)
      expect(result.refusals[0]!.message).toMatch(/unbound-output.*connectionSecret/s);
  });

  it('refuses a supports/realize tiling gap (ch. 12 §12.4)', () => {
    const dir = tamperedCopy((copyDir) => {
      rewriteMapping(copyDir, (mapping) => {
        // Drop the default Queue rule: spec.ordering = none becomes unreachable.
        mapping.mappings.Queue!.realize = mapping.mappings.Queue!.realize.slice(0, 1);
      });
    });
    const result = loadProviderPackage(dir, options);
    expect(refusalCodes(result)).toEqual(['coverage-tiling']);
    if (!result.ok) {
      expect(result.refusals[0]!.message).toMatch(/realize-tiling-gap.*spec\.ordering: "none"/s);
    }
  });

  it('refuses an extension schema that does not compile', () => {
    const dir = tamperedCopy((copyDir) => {
      writeFileSync(
        join(copyDir, 'schema', 'extension.schema.json'),
        JSON.stringify({ type: 'objekt' }),
      );
    });
    expect(refusalCodes(loadProviderPackage(dir, options))).toEqual(['artifact-invalid']);
  });
});
