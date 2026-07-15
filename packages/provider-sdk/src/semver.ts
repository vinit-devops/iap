/**
 * Minimal semver parsing and range checking for specCompat/sdkCompat
 * enforcement (spec ch. 10; IEP-0012 loading obligations).
 *
 * Deliberately dependency-free: ranges are space-separated comparator lists
 * (`>=1.0.0 <2.0.0`) that must ALL hold, with operators `>=`, `>`, `<=`, `<`,
 * `=` and bare versions meaning exact equality — exactly the grammar the
 * plugin-manifest schema's semverRange definition admits. Comparison uses
 * integer arithmetic only.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers (dot-split); empty for release versions. */
  prerelease: string[];
}

const VERSION_RE = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse `MAJOR.MINOR.PATCH(-prerelease)?`; returns null on any deviation. */
export function parseSemver(text: string): SemVer | null {
  const match = VERSION_RE.exec(text);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^[0-9]+$/.test(a);
  const bNumeric = /^[0-9]+$/.test(b);
  if (aNumeric && bNumeric) {
    const na = Number(a);
    const nb = Number(b);
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Total order per semver.org §11 (numeric core, then prerelease precedence). */
export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  // A prerelease version precedes its release (1.0.0-rc.1 < 1.0.0).
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < shared; i += 1) {
    const cmp = compareIdentifiers(a.prerelease[i] as string, b.prerelease[i] as string);
    if (cmp !== 0) return cmp;
  }
  return a.prerelease.length === b.prerelease.length
    ? 0
    : a.prerelease.length < b.prerelease.length
      ? -1
      : 1;
}

interface Comparator {
  operator: '>=' | '>' | '<=' | '<' | '=';
  version: SemVer;
}

/** Parse a comparator list; returns null when any token is malformed. */
export function parseRange(range: string): Comparator[] | null {
  const tokens = range.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === '') return null;
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const opMatch = /^(>=|>|<=|<|=)?(.+)$/.exec(token);
    if (!opMatch) return null;
    const version = parseSemver(opMatch[2] as string);
    if (!version) return null;
    comparators.push({ operator: (opMatch[1] as Comparator['operator']) ?? '=', version });
  }
  return comparators;
}

/**
 * True when `version` satisfies every comparator of `range`. Fail-closed:
 * a malformed version or range never satisfies anything.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  const comparators = parseRange(range);
  if (!parsed || !comparators) return false;
  return comparators.every(({ operator, version: bound }) => {
    const cmp = compareSemver(parsed, bound);
    switch (operator) {
      case '>=':
        return cmp >= 0;
      case '>':
        return cmp > 0;
      case '<=':
        return cmp <= 0;
      case '<':
        return cmp < 0;
      case '=':
        return cmp === 0;
    }
  });
}
