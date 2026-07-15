import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ABSTRACT_OUTPUT_ATTRIBUTES,
  conformanceCaseSchema,
  pluginManifestSchema,
  validateConformanceCase,
  validateManifest,
} from '../src/index';
import { CORE_KINDS, iisDocumentSchema } from '@iap/model';

const repoRoot = join(__dirname, '..', '..', '..');
const fixtures = join(__dirname, 'fixtures');

function specSchema(name: string): string {
  return readFileSync(join(repoRoot, 'spec', 'schema', name), 'utf8');
}

function embeddedSchema(name: string): string {
  return readFileSync(join(__dirname, '..', 'schemas', name), 'utf8');
}

function fixtureManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(fixtures, 'tiny-provider', 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
}

describe('schema drift guard (ADR-0002)', () => {
  it.each(['plugin-manifest-v1.schema.json', 'conformance-case-v1.schema.json'])(
    'embedded %s is byte-identical to spec/schema',
    (name) => {
      expect(embeddedSchema(name)).toBe(specSchema(name));
    },
  );
});

describe('plugin manifest validation', () => {
  it('accepts the signed fixture manifest (round-trip)', () => {
    const result = validateManifest(fixtureManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe('iap-provider-tiny');
      expect(result.manifest.signature.alg).toBe('ed25519');
    }
  });

  it.each([
    ['missing name', (m: Record<string, unknown>) => delete m.name],
    ['missing signature', (m: Record<string, unknown>) => delete m.signature],
    ['unknown top-level property', (m: Record<string, unknown>) => (m.extra = true)],
    [
      'invalid certification level',
      (m: Record<string, unknown>) => (m.certificationLevel = 'partial'),
    ],
    [
      'malformed digest value',
      (m: Record<string, unknown>) =>
        ((m.integrity as { digests: Record<string, string> }).digests[
          'mappings/core.iap-map.yaml'
        ] = 'md5:abc'),
    ],
    ['non-semver version', (m: Record<string, unknown>) => (m.version = 'v1')],
    [
      'empty mappings list',
      (m: Record<string, unknown>) => ((m.artifacts as { mappings: string[] }).mappings = []),
    ],
    [
      'unknown kind in capabilities',
      (m: Record<string, unknown>) =>
        ((m.capabilities as { kinds: string[] }).kinds = ['DBInstance']),
    ],
  ])('rejects a manifest with %s', (_label, mutate) => {
    const manifest = fixtureManifest();
    mutate(manifest);
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it('passes x-* annotations through', () => {
    const manifest = fixtureManifest();
    manifest['x-fixture'] = { note: 'test material' };
    expect(validateManifest(manifest).ok).toBe(true);
  });

  it('the embedded schema declares descriptions on every property', () => {
    const schema = pluginManifestSchema() as {
      properties: Record<string, { description?: string; const?: string }>;
    };
    for (const [name, property] of Object.entries(schema.properties)) {
      expect(property.description ?? property.const, name).toBeTruthy();
    }
  });
});

describe('conformance case validation', () => {
  const fixtureCase = (): unknown =>
    parse(
      readFileSync(
        join(fixtures, 'tiny-provider', 'conformance', 'cases', 'database-core.case.yaml'),
        'utf8',
      ),
    );

  it('accepts the fixture case (round-trip)', () => {
    const result = validateConformanceCase(fixtureCase());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.caseDoc.case).toBe('database-core');
      expect(result.caseDoc.assertions).toHaveLength(5);
    }
  });

  it.each([
    ['missing assertions', (c: Record<string, unknown>) => delete c.assertions],
    [
      'unknown expect value',
      (c: Record<string, unknown>) => {
        (c.assertions as Array<Record<string, unknown>>)[0]!.expect = 'maybe';
      },
    ],
    [
      'select without resource',
      (c: Record<string, unknown>) => {
        (c.assertions as Array<Record<string, unknown>>)[0]!.select = { kind: 'Database' };
      },
    ],
    ['absolute document path', (c: Record<string, unknown>) => (c.document = '/etc/passwd')],
    ['non-scalar mapping input', (c: Record<string, unknown>) => (c.mappingInputs = { a: {} })],
  ])('rejects a case with %s', (_label, mutate) => {
    const caseDoc = fixtureCase() as Record<string, unknown>;
    mutate(caseDoc);
    expect(validateConformanceCase(caseDoc).ok).toBe(false);
  });

  it('exposes the embedded schema', () => {
    expect(conformanceCaseSchema()).toHaveProperty('$id');
  });
});

describe('abstract output attributes (ch. 3 §3.3)', () => {
  it('covers every core kind exactly', () => {
    expect(Object.keys(ABSTRACT_OUTPUT_ATTRIBUTES).sort()).toEqual([...CORE_KINDS].sort());
  });

  it('every kind declares identifier; endpoint/connectionSecret per the ch. 3 table', () => {
    for (const attributes of Object.values(ABSTRACT_OUTPUT_ATTRIBUTES)) {
      expect(attributes).toContain('identifier');
    }
    expect(ABSTRACT_OUTPUT_ATTRIBUTES.Database).toEqual([
      'identifier',
      'endpoint',
      'connectionSecret',
    ]);
    expect(ABSTRACT_OUTPUT_ATTRIBUTES.Cache).toEqual([
      'identifier',
      'endpoint',
      'connectionSecret',
    ]);
    expect(ABSTRACT_OUTPUT_ATTRIBUTES.Application).toEqual(['identifier']);
    expect(ABSTRACT_OUTPUT_ATTRIBUTES.Volume).toEqual(['identifier']);
    expect(ABSTRACT_OUTPUT_ATTRIBUTES.Identity).toEqual(['identifier']);
    expect(ABSTRACT_OUTPUT_ATTRIBUTES.Secret).toEqual(['identifier']);
    for (const kind of ['Service', 'Function', 'Gateway', 'ObjectStore', 'Queue', 'Topic']) {
      expect(ABSTRACT_OUTPUT_ATTRIBUTES[kind as keyof typeof ABSTRACT_OUTPUT_ATTRIBUTES]).toEqual([
        'identifier',
        'endpoint',
      ]);
    }
  });

  it('kinds it names all exist in the normative schema', () => {
    const kinds = (iisDocumentSchema() as { $defs: { kinds: Record<string, unknown> } }).$defs
      .kinds;
    for (const kind of Object.keys(ABSTRACT_OUTPUT_ATTRIBUTES)) {
      expect(kinds, kind).toHaveProperty(kind);
    }
  });
});
