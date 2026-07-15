import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding } from '@iap/model';
import {
  MAX_ALIAS_COUNT,
  attachPositions,
  buildSourceMap,
  escapePointerSegment,
  loadDocument,
  loadFile,
  loadStream,
  parseText,
} from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
const examplePath = join(repoRoot, 'spec', 'examples', 'basic-webapp.iap.yaml');
const exampleText = readFileSync(examplePath, 'utf8');

/** 1-based line on which `needle` first appears in `text`. */
const lineOf = (text: string, needle: string): number =>
  text.slice(0, text.indexOf(needle)).split('\n').length;

describe('buildSourceMap pointer coverage (basic-webapp example)', () => {
  const { map, errors } = buildSourceMap(exampleText);
  const totalLines = exampleText.split('\n').length;

  it('reports no builder errors on a valid example', () => {
    expect(errors).toEqual([]);
  });

  it('covers root, maps, nested scalars, and sequence items', () => {
    for (const pointer of [
      '',
      '/resources',
      '/resources/web/spec/size',
      '/resources/web/relationships/0',
      '/resources/web/relationships/0/target',
    ]) {
      expect(map.has(pointer), `missing pointer ${JSON.stringify(pointer)}`).toBe(true);
    }
  });

  it('has 1-based lines and columns within file bounds on every range', () => {
    expect(map.size).toBeGreaterThan(50);
    for (const [pointer, range] of map) {
      expect(range.start.line, pointer).toBeGreaterThanOrEqual(1);
      expect(range.end.line, pointer).toBeLessThanOrEqual(totalLines);
      expect(range.start.col, pointer).toBeGreaterThanOrEqual(1);
      expect(range.start.offset, pointer).toBeLessThanOrEqual(range.end.offset);
      expect(range.end.offset, pointer).toBeLessThanOrEqual(exampleText.length);
    }
  });

  it('points /resources/web/spec/size at its authored line', () => {
    expect(map.get('/resources/web/spec/size')?.start.line).toBe(lineOf(exampleText, 'size: m'));
  });
});

describe('JSON Pointer escaping (RFC 6901)', () => {
  it('escapes ~ before / (a/b~c → a~1b~0c)', () => {
    expect(escapePointerSegment('a/b~c')).toBe('a~1b~0c');
    expect(escapePointerSegment('~1')).toBe('~01');
  });

  it('maps keys containing / and ~ to escaped pointers', () => {
    const text = [
      'apiVersion: iap.dev/v1',
      'metadata:',
      '  name: x',
      '  labels:',
      '    "a/b": v1',
      '    "c~d": v2',
      '',
    ].join('\n');
    const { map, errors } = buildSourceMap(text);
    expect(errors).toEqual([]);
    expect(map.has('/metadata/labels/a~1b')).toBe(true);
    expect(map.has('/metadata/labels/c~0d')).toBe(true);
    expect(map.get('/metadata/labels/c~0d')?.start.line).toBe(lineOf(text, '"c~d"'));
  });
});

describe('sourceMap option on parseText/loadDocument', () => {
  it('is absent unless requested', () => {
    expect(parseText(exampleText).sourceMap).toBeUndefined();
    expect(loadDocument(exampleText).sourceMap).toBeUndefined();
  });

  it('is populated and propagated through loadDocument when requested', () => {
    const result = loadDocument(exampleText, { sourceMap: true });
    expect(result.ok).toBe(true);
    expect(result.sourceMap?.has('/resources/web/spec/size')).toBe(true);
  });
});

describe('attachPositions', () => {
  it('prefixes a schema enum error with file:line:col of the offending value', () => {
    const text = [
      'apiVersion: iap.dev/v1',
      'metadata: {name: x}',
      'resources:',
      '  a:',
      '    kind: Database',
      '    spec:',
      '      class: relational',
      '      engine: postgresql',
      '      availability: wrong',
      '',
    ].join('\n');
    const result = loadDocument(text, { filename: 'bad.yaml', sourceMap: true });
    expect(result.ok).toBe(false);
    const finding = result.findings.find(
      (f) => f.code === 'IAP103' && f.path.endsWith('/availability'),
    );
    expect(finding).toBeDefined();

    // loadDocument returns findings even when invalid; combine with the map.
    const attached = attachPositions(result.findings, result.sourceMap!, 'bad.yaml');
    const message = attached.find((f) => f.path.endsWith('/availability'))!.message;
    expect(message).toMatch(
      new RegExp(`^bad\\.yaml:${lineOf(text, 'availability: wrong')}:\\d+: `),
    );
  });

  it('falls back to the nearest recorded ancestor for unmapped pointers', () => {
    const { map } = buildSourceMap(exampleText);
    const finding: Finding = {
      code: 'IAP201',
      severity: 'error',
      path: '/resources/web/nonexistent/deep',
      message: 'dangling reference',
    };
    const [attached] = attachPositions([finding], map, 'ex.yaml');
    const ancestor = map.get('/resources/web')!.start;
    expect(ancestor.line).not.toBe(map.get('')!.start.line); // nearest ancestor, not root
    expect(attached!.message).toBe(`ex.yaml:${ancestor.line}:${ancestor.col}: dangling reference`);
  });

  it('leaves findings unchanged (and does not mutate input) when nothing resolves', () => {
    const finding: Finding = { code: 'IAP101', severity: 'error', path: '/x', message: 'm' };
    const [attached] = attachPositions([finding], new Map(), 'f.yaml');
    expect(attached!.message).toBe('m');
    expect(finding.message).toBe('m');
  });
});

describe('alias/anchor safety limits', () => {
  it('rejects an alias-expansion bomb with IAP101 quickly', () => {
    const bomb = [
      'apiVersion: iap.dev/v1',
      'a: &a ["x","x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: [*e,*e,*e,*e,*e,*e,*e,*e,*e,*e]',
      '',
    ].join('\n');
    const result = parseText(bomb, { sourceMap: true });
    expect(result.ok).toBe(false);
    expect(result.document).toBeUndefined();
    expect(result.findings[0]?.code).toBe('IAP101');
    expect(result.findings[0]?.message).toMatch(/alias expansion limit/);
    expect(result.findings[0]?.message).toContain(String(MAX_ALIAS_COUNT));
  }, 2000); // timeout guard: rejection must not require expanding the bomb

  it('accepts legitimate small anchor/alias use', () => {
    const result = parseText('a: &x 1\nb: *x\n');
    expect(result.ok).toBe(true);
    expect(result.document).toEqual({ a: 1, b: 1 });
  });
});

describe('file and stream input', () => {
  it('loadFile parses an official example with the path as default filename', async () => {
    const result = await loadFile(examplePath, { sourceMap: true });
    expect(result.ok).toBe(true);
    expect(result.document?.apiVersion).toBe('iap.dev/v1');
    expect(result.sourceMap?.has('/resources')).toBe(true);
  });

  it('loadStream parses chunked string/Buffer input to the same document', async () => {
    async function* chunks(): AsyncGenerator<string | Buffer> {
      const step = 64;
      for (let i = 0; i < exampleText.length; i += step) {
        const piece = exampleText.slice(i, i + step);
        yield (i / step) % 2 === 0 ? piece : Buffer.from(piece, 'utf8');
      }
    }
    const result = await loadStream(chunks(), { filename: 'stream.yaml' });
    expect(result.ok).toBe(true);
    expect(result.document).toEqual(loadDocument(exampleText).document);
  });
});
