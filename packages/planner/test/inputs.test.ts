import { describe, expect, it } from 'vitest';
import {
  computeInputsHash,
  computeStateIntegrity,
  emptySnapshot,
  sha256Digest,
} from '../src/index';
import type { DeterminismInputs } from '../src/index';
import { baseInputs, reverseKeys } from './helpers';

const SHA256_SPELLING = /^sha256:[0-9a-f]{64}$/;

describe('sha256Digest', () => {
  it('spells digests sha256:<hex> (IEP-0011 artifact spelling)', () => {
    expect(sha256Digest('')).toMatch(SHA256_SPELLING);
    expect(sha256Digest('x')).not.toBe(sha256Digest('y'));
  });
});

describe('emptySnapshot', () => {
  it('is revision 0 with no objects and a verifying integrity hash', () => {
    const snapshot = emptySnapshot();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.objects).toEqual({});
    expect(snapshot.integrity).toBe(computeStateIntegrity(snapshot.objects));
    expect(snapshot.integrity).toMatch(SHA256_SPELLING);
  });

  it('is stable across calls (no ambient input)', () => {
    expect(emptySnapshot()).toEqual(emptySnapshot());
  });
});

describe('computeStateIntegrity', () => {
  it('is key-order independent and content sensitive', () => {
    const objects = {
      b: { type: 't', attributes: { y: 2, x: 1 }, managed: true },
      a: { type: 't', attributes: {}, managed: false },
    };
    expect(computeStateIntegrity(objects)).toBe(computeStateIntegrity(reverseKeys(objects)));
    const changed = structuredClone(objects);
    changed.b.attributes.x = 3;
    expect(computeStateIntegrity(changed)).not.toBe(computeStateIntegrity(objects));
  });
});

describe('computeInputsHash (the nine-element vector)', () => {
  it('is identical for identical vectors', () => {
    expect(computeInputsHash(baseInputs())).toBe(computeInputsHash(baseInputs()));
    expect(computeInputsHash(baseInputs())).toMatch(SHA256_SPELLING);
  });

  it('is independent of member key order', () => {
    expect(computeInputsHash(reverseKeys(baseInputs()))).toBe(computeInputsHash(baseInputs()));
  });

  it('ignores extraneous properties (closed identity set)', () => {
    const padded = { ...baseInputs(), extraneous: 'never-hashed' } as DeterminismInputs;
    expect(computeInputsHash(padded)).toBe(computeInputsHash(baseInputs()));
  });

  const perturbations: Array<[string, (inputs: DeterminismInputs) => void]> = [
    ['documentHash', (i) => (i.documentHash = `sha256:${'f'.repeat(64)}`)],
    ['target.provider', (i) => (i.target.provider = 'other')],
    ['target.profile', (i) => (i.target.profile = null)],
    ['profileHashes', (i) => (i.profileHashes.production = `sha256:${'e'.repeat(64)}`)],
    ['policyBundles', (i) => (i.policyBundles['org-baseline'] = '1.5.0')],
    ['extensionVersions', (i) => (i.extensionVersions.mock = '1.0.1')],
    ['mappingVersions', (i) => (i.mappingVersions.mock = '2.0.0')],
    ['discoverySnapshot', (i) => (i.discoverySnapshot = null)],
    ['pricingSnapshot', (i) => (i.pricingSnapshot = 'price-2026-08-01')],
    ['stateRevision', (i) => (i.stateRevision = 15)],
    ['stateIntegrity', (i) => (i.stateIntegrity = `sha256:${'d'.repeat(64)}`)],
    ['plannerVersion', (i) => (i.plannerVersion = '9.9.9')],
  ];

  it.each(perturbations)('changes when %s is perturbed (PL-2 groundwork)', (_name, perturb) => {
    const perturbed = baseInputs();
    perturb(perturbed);
    expect(computeInputsHash(perturbed)).not.toBe(computeInputsHash(baseInputs()));
  });
});
