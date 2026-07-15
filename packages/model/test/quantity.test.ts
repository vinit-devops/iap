import { describe, expect, it } from 'vitest';
import {
  canonicalDuration,
  canonicalQuantity,
  formatDurationMs,
  formatQuantityMilli,
  parseDuration,
  parseQuantity,
} from '../src/quantity';

function quantity(input: string): string {
  const result = canonicalQuantity(input);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function duration(input: string): string {
  const result = canonicalDuration(input);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe('quantity canonical spelling (ch. 1 §1.5.2)', () => {
  it.each([
    // The normative example table, byte-exact.
    ['1024Mi', '1Gi'],
    ['0.5Gi', '512Mi'],
    ['1000000', '1M'],
    ['0.5', '500m'],
    ['2000m', '2'],
    ['1536Mi', '1536Mi'],
  ])('spec example: %s → %s', (input, expected) => {
    expect(quantity(input)).toBe(expected);
  });

  it('rejects 1.5m — precision finer than m is not representable (IAP103)', () => {
    const result = canonicalQuantity('1.5m');
    expect(result.ok).toBe(false);
    expect(parseQuantity('1.5m')).toBeNull();
  });

  it.each(['0', '0.000', '0Gi', '0m', '0k'])('zero in any spelling → 0 (%s)', (input) => {
    expect(quantity(input)).toBe('0');
  });

  it('prefers binary suffixes largest-first, then decimal, then bare', () => {
    expect(quantity('1024')).toBe('1Ki');
    expect(quantity('1048576')).toBe('1Mi');
    expect(quantity('2048')).toBe('2Ki');
    expect(quantity('1000')).toBe('1k');
    expect(quantity('16000')).toBe('16k');
    expect(quantity('1125899906842624')).toBe('1024Ti'); // 2^50
    expect(quantity('4096Ti')).toBe('4096Ti');
  });

  it('emits bare integers when no suffix divides exactly', () => {
    expect(quantity('2.5k')).toBe('2500');
    expect(quantity('123')).toBe('123');
  });

  it('emits sub-integer values in m', () => {
    expect(quantity('0.001')).toBe('1m');
    expect(quantity('1.5')).toBe('1500m');
    expect(quantity('0.25')).toBe('250m');
  });

  it('treats equal exact values as equal (1Gi ≡ 1024Mi ≡ 0.5Gi × 2)', () => {
    expect(parseQuantity('1Gi')?.milli).toBe(parseQuantity('1024Mi')?.milli);
    expect(parseQuantity('1k')?.milli).toBe(parseQuantity('1000')?.milli);
    expect(parseQuantity('0.5')?.milli).toBe(parseQuantity('500m')?.milli);
  });

  it.each(['', 'abc', '1.', '.5', '-1', '1e3', '1 Gi', '1KiB', 'Gi', '1,5'])(
    'rejects grammar violations (%j)',
    (input) => {
      expect(parseQuantity(input)).toBeNull();
      expect(canonicalQuantity(input).ok).toBe(false);
    },
  );

  it('rejects precision finer than milli', () => {
    expect(parseQuantity('0.0001')).toBeNull();
    expect(parseQuantity('0.1234')).toBeNull();
    expect(canonicalQuantity('0.0005k').ok).toBe(true); // 0.5 exactly
    expect(quantity('0.0005k')).toBe('500m');
  });

  it('is idempotent: canonical spellings re-canonicalize to themselves', () => {
    for (const input of ['1Gi', '512Mi', '1M', '500m', '2', '1536Mi', '0', '16k']) {
      expect(quantity(input)).toBe(input);
    }
  });

  it('formatQuantityMilli rejects negatives', () => {
    expect(() => formatQuantityMilli(-1n)).toThrow(RangeError);
  });
});

describe('duration canonical spelling (ch. 1 §1.5.2)', () => {
  it.each([
    // The normative example set, byte-exact.
    ['60s', '1m'],
    ['1440m', '1d'],
    ['90m', '90m'],
    ['1000ms', '1s'],
  ])('spec example: %s → %s', (input, expected) => {
    expect(duration(input)).toBe(expected);
  });

  it('canonicalizes to the largest unit representing an integer', () => {
    expect(duration('48h')).toBe('2d');
    expect(duration('36h')).toBe('36h');
    expect(duration('120s')).toBe('2m');
    expect(duration('90s')).toBe('90s');
    expect(duration('7d')).toBe('7d');
    expect(duration('86400000ms')).toBe('1d');
    expect(duration('30s')).toBe('30s');
  });

  it('spells zero as 0d (zero is an integer in every unit; d is the largest)', () => {
    expect(duration('0ms')).toBe('0d');
    expect(duration('0s')).toBe('0d');
    expect(duration('0d')).toBe('0d');
  });

  it.each(['', '5', '1w', '1.5h', 'ms', 'h1', '1H'])('rejects grammar violations (%j)', (input) => {
    expect(parseDuration(input)).toBeNull();
    expect(canonicalDuration(input).ok).toBe(false);
  });

  it('parses exact millisecond values', () => {
    expect(parseDuration('1d')?.ms).toBe(86_400_000n);
    expect(parseDuration('90m')?.ms).toBe(5_400_000n);
    expect(parseDuration('1ms')?.ms).toBe(1n);
  });

  it('formatDurationMs rejects negatives', () => {
    expect(() => formatDurationMs(-1n)).toThrow(RangeError);
  });
});
