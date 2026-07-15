import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createValidator, loadDocument, parseText } from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), 'utf8');

describe('parseText', () => {
  it('rejects duplicate keys', () => {
    const result = parseText('apiVersion: iap.dev/v1\napiVersion: iap.dev/v1\n');
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.code).toBe('IAP101');
    expect(result.findings[0]?.message).toMatch(/unique|duplicate/i);
  });

  it('rejects multi-document streams (spec ch. 2 §2.2)', () => {
    const result = parseText('apiVersion: iap.dev/v1\n---\napiVersion: iap.dev/v1\n');
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.message).toMatch(/multi-document/);
  });

  it('rejects non-object roots', () => {
    expect(parseText('- a\n- b\n').ok).toBe(false);
    expect(parseText('"just a string"\n').ok).toBe(false);
  });

  it('reports parse errors with line positions', () => {
    const result = parseText('a: [1, 2\n', { filename: 'broken.yaml' });
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.message).toMatch(/broken\.yaml:\d+:\d+/);
  });

  it('accepts JSON input (YAML subset)', () => {
    const result = parseText('{"apiVersion": "iap.dev/v1"}');
    expect(result.ok).toBe(true);
  });
});

describe('loadDocument against official examples', () => {
  const examplesDir = join(repoRoot, 'spec', 'examples');
  const examples = readdirSync(examplesDir).filter((f) => f.endsWith('.iap.yaml'));

  it('finds the nine official examples', () => {
    expect(examples).toHaveLength(9);
  });

  it.each(examples)('%s parses and schema-validates', (file) => {
    const result = loadDocument(read('spec', 'examples', file), { filename: file });
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document?.apiVersion).toBe('iap.dev/v1');
    expect(Object.keys(result.document?.resources ?? {}).length).toBeGreaterThan(0);
  });

  it('rejects an unrecognized apiVersion (IAP101)', () => {
    const result = loadDocument(
      'apiVersion: iap.dev/v2\nmetadata: {name: x}\nresources: {a: {kind: Service}}\n',
    );
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.path === '/apiVersion')).toBe(true);
    expect(result.findings.some((f) => f.code === 'IAP101' && f.path === '/apiVersion')).toBe(true);
  });
});

describe('hard rename: legacy apiVersion is rejected (ADR-0003, no compatibility)', () => {
  const legacyDoc = 'apiVersion: iis.dev/v1\nmetadata: {name: x}\nresources: {a: {kind: Queue}}\n';
  const canonicalDoc =
    'apiVersion: iap.dev/v1\nmetadata: {name: x}\nresources: {a: {kind: Queue}}\n';

  it('REJECTS the pre-release iis.dev/v1 value with a fatal IAP101 error', () => {
    const result = loadDocument(legacyDoc);
    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.path === '/apiVersion');
    expect(finding).toBeDefined();
    expect(finding?.code).toBe('IAP101');
    expect(finding?.severity).toBe('error');
    // The message names the pre-release IIS origin so the fix is obvious.
    expect(finding?.message).toContain('pre-release');
    // It is NOT normalized to the canonical value.
    expect(result.document?.apiVersion).toBe('iis.dev/v1');
  });

  it('accepts the canonical iap.dev/v1 value with no apiVersion finding', () => {
    const canonical = loadDocument(canonicalDoc);
    expect(canonical.ok).toBe(true);
    expect(canonical.findings.some((f) => f.path === '/apiVersion')).toBe(false);
  });

  it('rejects a genuinely unknown apiVersion with IAP101', () => {
    const result = loadDocument(
      'apiVersion: nope.dev/v9\nmetadata: {name: x}\nresources: {a: {kind: Service}}\n',
    );
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'IAP101' && f.path === '/apiVersion')).toBe(true);
  });
});

describe('conformance case expectations', () => {
  const casesDir = join(repoRoot, 'spec', 'conformance', 'cases');

  for (const file of readdirSync(join(casesDir, 'valid'))) {
    it(`valid/${file} passes`, () => {
      const result = loadDocument(read('spec', 'conformance', 'cases', 'valid', file));
      expect(result.ok).toBe(true);
    });
  }

  for (const file of readdirSync(join(casesDir, 'invalid'))) {
    const text = read('spec', 'conformance', 'cases', 'invalid', file);
    const expected = /^# expected:\s*(\S+)/m.exec(text)?.[1] ?? '';
    const schemaDetectable = expected === 'schema-invalid';
    it(`invalid/${file} is ${schemaDetectable ? 'rejected by schema' : `schema-valid (expects ${expected} from a full validator)`}`, () => {
      const result = loadDocument(text);
      if (schemaDetectable) {
        expect(result.ok).toBe(false);
        expect(result.findings.some((f) => f.code.startsWith('IAP1'))).toBe(true);
      } else {
        expect(result.ok).toBe(true);
      }
    });
  }

  it('unknown kind maps to IAP102', () => {
    const result = loadDocument(
      'apiVersion: iap.dev/v1\nmetadata: {name: x}\nresources: {a: {kind: VirtualMachine}}\n',
    );
    expect(result.findings.some((f) => f.code === 'IAP102')).toBe(true);
  });
});

describe('createValidator', () => {
  it('compiles the normative schema under ajv strict mode with the x-iap vocabulary', () => {
    expect(() => createValidator()).not.toThrow();
  });
});
