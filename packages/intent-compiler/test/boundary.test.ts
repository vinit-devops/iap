/**
 * Phase-3 exit criterion 5 / design decision 10: the compiler structurally
 * cannot deploy. The dependency set is pinned and no source module imports a
 * package right of the authoring boundary.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageDir = join(__dirname, '..');

const FORBIDDEN = ['@iap/provider-sdk', '@iap/planner', '@iap/cli'];
const ALLOWED_RUNTIME = [
  '@iap/model',
  '@iap/parser',
  '@iap/validator',
  '@iap/policy',
  '@iap/sdk',
  'ajv',
  'yaml',
];

describe('layer boundary (the compiler cannot call deployment APIs)', () => {
  const manifest = () =>
    JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

  it('runtime dependencies are exactly the permitted authoring-side set', () => {
    expect(Object.keys(manifest().dependencies ?? {}).sort()).toEqual([
      '@iap/model',
      '@iap/parser',
      '@iap/sdk',
      'ajv',
    ]);
  });

  it('every dependency (dev included) is inside the permitted set', () => {
    const all = [
      ...Object.keys(manifest().dependencies ?? {}),
      ...Object.keys(manifest().devDependencies ?? {}),
    ];
    for (const name of all) {
      if (!name.startsWith('@iap/')) continue;
      expect(ALLOWED_RUNTIME).toContain(name);
    }
    for (const name of FORBIDDEN) {
      expect(all).not.toContain(name);
    }
  });

  it('no src module imports a forbidden package', () => {
    const srcDir = join(packageDir, 'src');
    for (const file of readdirSync(srcDir)) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      // Every static or dynamic @iap import must be in the permitted set
      // (which excludes every execution-surface package).
      const imports = [
        ...text.matchAll(/from '(@iap\/[a-z-]+)'/g),
        ...text.matchAll(/import\('(@iap\/[a-z-]+)'\)/g),
        ...text.matchAll(/require\('(@iap\/[a-z-]+)'\)/g),
      ];
      for (const match of imports) {
        expect(ALLOWED_RUNTIME, `${file} imports ${match[1]}`).toContain(match[1]);
        expect(FORBIDDEN, `${file} imports ${match[1]}`).not.toContain(match[1]);
      }
    }
  });
});
