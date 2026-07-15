/**
 * Exact-rational quantity and duration normalization (spec ch. 1 §1.5.2).
 *
 * Quantities denote exact rational values: the mantissa multiplied by the
 * suffix multiplier. All arithmetic here is integral over BigInt milli-units
 * (10⁻³) — implementations MUST NOT use binary floating point (normative).
 * A value that is not an integer multiple of 10⁻³ is invalid (IAP103):
 * precision finer than `m` is not representable.
 */

/** Quantity grammar (schema `$defs/common/quantity`), with capture groups. */
export const QUANTITY_PATTERN = /^([0-9]+)(?:\.([0-9]+))?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/;

/** Duration grammar (schema `$defs/common/duration`), with capture groups. */
export const DURATION_PATTERN = /^([0-9]+)(ms|s|m|h|d)$/;

/**
 * Milli-units (10⁻³) contributed by one unit of mantissa, per suffix.
 * `m` = 10⁻³, no suffix = 1, `k` = 10³, `M` = 10⁶, `G` = 10⁹, `T` = 10¹²,
 * `Ki` = 2¹⁰, `Mi` = 2²⁰, `Gi` = 2³⁰, `Ti` = 2⁴⁰.
 */
const SUFFIX_MILLI: Readonly<Record<string, bigint>> = {
  m: 1n,
  '': 1_000n,
  k: 1_000_000n,
  M: 1_000_000_000n,
  G: 1_000_000_000_000n,
  T: 1_000_000_000_000_000n,
  Ki: 1_024n * 1_000n,
  Mi: 1_048_576n * 1_000n,
  Gi: 1_073_741_824n * 1_000n,
  Ti: 1_099_511_627_776n * 1_000n,
};

/**
 * Canonical suffix preference for positive integers (§1.5.2 step 4): the
 * first of Ti, Gi, Mi, Ki, T, G, M, k that divides the value exactly wins;
 * if none divides, the bare integer is emitted.
 */
const CANONICAL_SUFFIXES: ReadonlyArray<readonly [suffix: string, size: bigint]> = [
  ['Ti', 1_099_511_627_776n],
  ['Gi', 1_073_741_824n],
  ['Mi', 1_048_576n],
  ['Ki', 1_024n],
  ['T', 1_000_000_000_000n],
  ['G', 1_000_000_000n],
  ['M', 1_000_000n],
  ['k', 1_000n],
];

/** Duration unit sizes in milliseconds. */
const DURATION_UNIT_MS: Readonly<Record<string, bigint>> = {
  ms: 1n,
  s: 1_000n,
  m: 60_000n,
  h: 3_600_000n,
  d: 86_400_000n,
};

/** Largest-unit-first ladder for canonical duration spelling. */
const DURATION_LADDER: ReadonlyArray<readonly [unit: string, size: bigint]> = [
  ['d', 86_400_000n],
  ['h', 3_600_000n],
  ['m', 60_000n],
  ['s', 1_000n],
  ['ms', 1n],
];

/** Result of a canonical-spelling computation (IAP103 semantics on failure). */
export type CanonicalUnitResult = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Parse a quantity into its exact value in milli-units (10⁻³).
 * Returns `null` when the input violates the grammar or carries precision
 * finer than `m` (both IAP103 conditions — callers produce the finding).
 */
export function parseQuantity(input: string): { milli: bigint } | null {
  const match = QUANTITY_PATTERN.exec(input);
  if (!match) return null;
  const intPart = match[1] ?? '';
  const fracPart = match[2] ?? '';
  const suffix = match[3] ?? '';
  const multiplier = SUFFIX_MILLI[suffix];
  if (multiplier === undefined) return null;
  // mantissa = digits / 10^f — keep everything as exact integers.
  const numerator = BigInt(intPart + fracPart) * multiplier;
  const denominator = 10n ** BigInt(fracPart.length);
  if (numerator % denominator !== 0n) return null; // finer than 10⁻³ (IAP103)
  return { milli: numerator / denominator };
}

/** Canonical spelling of an exact quantity value given in milli-units (§1.5.2 steps 3–5). */
export function formatQuantityMilli(milli: bigint): string {
  if (milli < 0n) throw new RangeError('IaP quantities are non-negative');
  if (milli === 0n) return '0';
  if (milli % 1_000n === 0n) {
    const v = milli / 1_000n;
    for (const [suffix, size] of CANONICAL_SUFFIXES) {
      if (v % size === 0n) return `${v / size}${suffix}`;
    }
    return `${v}`;
  }
  return `${milli}m`;
}

/**
 * Rewrite a quantity to its canonical spelling (a pure function of the exact
 * value). Failure carries IAP103 semantics; the caller produces the finding.
 */
export function canonicalQuantity(input: string): CanonicalUnitResult {
  if (!QUANTITY_PATTERN.test(input)) {
    return { ok: false, reason: `"${input}" does not match the quantity grammar` };
  }
  const parsed = parseQuantity(input);
  if (parsed === null) {
    return {
      ok: false,
      reason: `"${input}" has precision finer than m (10^-3), which is not representable`,
    };
  }
  return { ok: true, value: formatQuantityMilli(parsed.milli) };
}

/**
 * Parse a duration into its exact value in milliseconds.
 * Returns `null` when the input violates the grammar.
 */
export function parseDuration(input: string): { ms: bigint } | null {
  const match = DURATION_PATTERN.exec(input);
  if (!match) return null;
  const size = DURATION_UNIT_MS[match[2] ?? ''];
  if (size === undefined) return null;
  return { ms: BigInt(match[1] ?? '0') * size };
}

/**
 * Canonical spelling of a duration in milliseconds: the largest unit that
 * represents the value as an integer (`60s` → `1m`, `1440m` → `1d`). Zero is
 * an integer in every unit, so it spells `0d` under the same rule.
 */
export function formatDurationMs(ms: bigint): string {
  if (ms < 0n) throw new RangeError('IaP durations are non-negative');
  for (const [unit, size] of DURATION_LADDER) {
    if (ms % size === 0n) return `${ms / size}${unit}`;
  }
  /* istanbul ignore next -- ms divides 1n; unreachable */
  return `${ms}ms`;
}

/** Rewrite a duration to its canonical spelling (ch. 1 §1.5.2). */
export function canonicalDuration(input: string): CanonicalUnitResult {
  const parsed = parseDuration(input);
  if (parsed === null) {
    return { ok: false, reason: `"${input}" does not match the duration grammar` };
  }
  return { ok: true, value: formatDurationMs(parsed.ms) };
}
