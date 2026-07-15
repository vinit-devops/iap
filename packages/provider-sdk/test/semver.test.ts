import { describe, expect, it } from 'vitest';
import { compareSemver, parseRange, parseSemver, satisfiesRange } from '../src/index';

describe('parseSemver', () => {
  it('parses release and prerelease versions', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('1.0.0-rc.1')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['rc', '1'],
    });
  });

  it('rejects malformed versions', () => {
    for (const bad of ['1.2', 'v1.2.3', '1.2.3.4', '1.2.x', '', '>=1.0.0']) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });
});

describe('compareSemver', () => {
  const v = (text: string) => parseSemver(text) as NonNullable<ReturnType<typeof parseSemver>>;

  it('orders the numeric core', () => {
    expect(compareSemver(v('1.0.0'), v('2.0.0'))).toBeLessThan(0);
    expect(compareSemver(v('1.10.0'), v('1.9.0'))).toBeGreaterThan(0);
    expect(compareSemver(v('1.0.1'), v('1.0.1'))).toBe(0);
  });

  it('orders prereleases below releases and by identifier precedence', () => {
    expect(compareSemver(v('1.0.0-rc.1'), v('1.0.0'))).toBeLessThan(0);
    expect(compareSemver(v('1.0.0-alpha'), v('1.0.0-alpha.1'))).toBeLessThan(0);
    expect(compareSemver(v('1.0.0-alpha.2'), v('1.0.0-alpha.10'))).toBeLessThan(0);
    expect(compareSemver(v('1.0.0-1'), v('1.0.0-alpha'))).toBeLessThan(0);
  });
});

describe('satisfiesRange', () => {
  it('handles the canonical specCompat range', () => {
    expect(satisfiesRange('1.0.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesRange('1.9.3', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfiesRange('0.9.9', '>=1.0.0 <2.0.0')).toBe(false);
  });

  it('supports every comparator and bare-version equality', () => {
    expect(satisfiesRange('1.0.0', '1.0.0')).toBe(true);
    expect(satisfiesRange('1.0.1', '=1.0.0')).toBe(false);
    expect(satisfiesRange('1.0.0', '>1.0.0')).toBe(false);
    expect(satisfiesRange('1.0.0', '<=1.0.0')).toBe(true);
    expect(satisfiesRange('0.1.0', '>=0.1.0 <1.0.0')).toBe(true);
  });

  it('fails closed on malformed inputs', () => {
    expect(satisfiesRange('not-a-version', '>=1.0.0')).toBe(false);
    expect(satisfiesRange('1.0.0', '')).toBe(false);
    expect(satisfiesRange('1.0.0', '^1.0.0')).toBe(false);
    expect(parseRange('~1.2')).toBeNull();
  });
});
