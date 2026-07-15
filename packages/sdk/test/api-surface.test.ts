/**
 * Public API compatibility surface (Phase 2 exit criterion; ch. 21 §21.6).
 *
 * These assertions pin the module's export names and the IaPWorkspaceResult
 * property/method surface. Removing or renaming anything here is a breaking
 * change and MUST fail this test — additions require updating the expected
 * lists deliberately (minors MAY add, MUST NOT change or remove; §21.6).
 */
import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index';

const MINIMAL = [
  'apiVersion: iap.dev/v1',
  'metadata:',
  '  name: surface',
  'resources: {}',
  '',
].join('\n');

describe('module export surface', () => {
  it('exports exactly the frozen facade names', () => {
    // Additions land here deliberately: 'POLICY_PACKS' and 'evaluatePolicies'
    // were added with the Phase 9 policy engine (minors MAY add; §21.6).
    expect(Object.keys(sdk).sort()).toEqual([
      'IaPError',
      'POLICY_PACKS',
      'evaluatePolicies',
      'load',
      'registerExtension',
      'registeredExtensions',
      'unregisterExtension',
      'validateExtensions',
    ]);
  });

  it('exports are of the expected runtime types', () => {
    expect(typeof sdk.load).toBe('function');
    expect(typeof sdk.registerExtension).toBe('function');
    expect(typeof sdk.unregisterExtension).toBe('function');
    expect(typeof sdk.registeredExtensions).toBe('function');
    expect(typeof sdk.validateExtensions).toBe('function');
    expect(typeof sdk.evaluatePolicies).toBe('function');
    expect(typeof sdk.POLICY_PACKS).toBe('object');
    expect(Object.getPrototypeOf(sdk.IaPError)).toBe(Error);
  });
});

describe('IaPWorkspaceResult surface', () => {
  it('carries the frozen property and method names (parse success, no source map)', async () => {
    const ws = await sdk.load(MINIMAL);
    expect(Object.keys(ws).sort()).toEqual([
      'canonical',
      'document',
      'findings',
      'graph',
      'ok',
      'policies',
      'serialize',
      'validate',
      'waves',
    ]);
  });

  it('adds sourceMap when requested, and nothing else', async () => {
    const ws = await sdk.load(MINIMAL, { sourceMap: true });
    expect(Object.keys(ws).sort()).toEqual([
      'canonical',
      'document',
      'findings',
      'graph',
      'ok',
      'policies',
      'serialize',
      'sourceMap',
      'validate',
      'waves',
    ]);
  });

  it('the method surface is exactly validate/canonical/graph/waves/policies/serialize', async () => {
    const ws = await sdk.load(MINIMAL);
    const methods = Object.entries(ws)
      .filter(([, value]) => typeof value === 'function')
      .map(([key]) => key)
      .sort();
    expect(methods).toEqual(['canonical', 'graph', 'policies', 'serialize', 'validate', 'waves']);
  });
});
