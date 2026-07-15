// Negative-safety tests for the IIS -> IaP hard rename (roadmap-v2 §17).
// Proves the ordered rename rules are token-scoped: they rename project-specific
// identifiers but leave unrelated words, hashes, and external references alone.
// The rules under test are the SAME ones the engine (tools/rename-iis-to-iap.mjs)
// applied, imported from the shared module.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs helper, no types
import { applyRules } from '../tools/rename-rules.mjs';

const repoRoot = join(__dirname, '..');

describe('rename rules do NOT touch unrelated text (roadmap-v2 §2, §17)', () => {
  const untouched = [
    'this',
    'missing',
    'permissions',
    'commission',
    'submission',
    'dismiss',
    'Hawaii',
    'the mission is dismissed with permissions',
    'sha256:9d29c9d7dfa6aca0f99ca66b80490ba266ba4f1f100f6a1f8b397ac32aac5c09',
    'https://example.com/docs/iisomething', // no word boundary -> not a token
  ];
  for (const s of untouched) {
    it(`leaves ${JSON.stringify(s)} unchanged`, () => {
      expect(applyRules(s)).toBe(s);
    });
  }
});

describe('rename rules DO rename project-specific identifiers', () => {
  const cases: [string, string][] = [
    ['apiVersion: iis.dev/v1', 'apiVersion: iap.dev/v1'],
    ['@iis/cli', '@iap/cli'],
    ['infrastructure.iis.yaml', 'infrastructure.iap.yaml'],
    ['core.iis-map.yaml', 'core.iap-map.yaml'],
    ['IisDocument', 'IaPDocument'],
    ['IISSDK', 'IaPSDK'],
    ['iis_validate', 'iap_validate'],
    ['IIS_TOOLS', 'IAP_TOOLS'],
    ['IIS402', 'IAP402'],
    ['^IIS[1-8][0-9]{2}$', '^IAP[1-8][0-9]{2}$'],
    ['the iis CLI', 'the iap CLI'],
    ['Infrastructure Intent Specification', 'Infrastructure as Prompt'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(applyRules(input)).toBe(expected);
    });
  }

  it('never produces a mis-cased IaP[ in an error-code regex', () => {
    expect(applyRules('/^IIS[1-4]/')).toBe('/^IAP[1-4]/');
    expect(applyRules('/^IIS5[0-9]{2}$/')).toBe('/^IAP5[0-9]{2}$/');
  });
});

describe('external Microsoft IIS references are protected at the file level', () => {
  it('roadmap-v2 still contains the literal "Microsoft IIS"', () => {
    const text = readFileSync(join(repoRoot, 'roadmap-v2'), 'utf8');
    expect(text).toContain('Microsoft IIS');
  });
});
