/**
 * SARIF 2.1.0 projection of validation findings (ch. 22 §22.1: `--output
 * sarif` for CI and code-scanning integrations). Deterministic: rules come
 * from the embedded error-code registry in registry order, results in
 * finding order, and no timestamps or absolute environment data are emitted.
 */

import type { Finding } from '@iap/model';
import type { SourceMap } from '@iap/parser';
import { errorCodeRegistry } from './registry.js';

const SARIF_SCHEMA =
  'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';

type SarifLevel = 'error' | 'warning';

interface SarifRegion {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: SarifRegion;
  };
  logicalLocations?: { fullyQualifiedName: string }[];
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations?: SarifLocation[];
}

/** Registry severity → SARIF level (`contextual` reports as warning by default). */
function registryLevel(severity: 'error' | 'warning' | 'contextual'): SarifLevel {
  return severity === 'error' ? 'error' : 'warning';
}

/**
 * Resolve a finding's JSON Pointer to a source region: exact match first,
 * then the nearest recorded ancestor (the parser's source map records every
 * node it can position — findings on merged/derived paths fall back).
 */
function resolveRegion(sourceMap: SourceMap, pointer: string): SarifRegion | undefined {
  let candidate = pointer;
  for (;;) {
    const range = sourceMap.get(candidate);
    if (range !== undefined) {
      return {
        startLine: range.start.line,
        startColumn: range.start.col,
        endLine: range.end.line,
        endColumn: range.end.col,
      };
    }
    if (candidate === '') return undefined;
    const cut = candidate.lastIndexOf('/');
    candidate = cut <= 0 ? '' : candidate.slice(0, cut);
  }
}

/**
 * Build the SARIF 2.1.0 log for one validation run. `file` becomes the
 * artifact URI (forward slashes); `sourceMap`, when present, attaches
 * physical regions to every finding whose pointer (or an ancestor) resolves.
 */
export function toSarif(
  findings: Finding[],
  options: { file: string; toolVersion: string; sourceMap?: SourceMap },
): Record<string, unknown> {
  const registry = errorCodeRegistry();
  const uri = options.file.replace(/\\/g, '/');

  const rules = registry.codes.map((code) => ({
    id: code.code,
    shortDescription: { text: code.title },
    defaultConfiguration: { level: registryLevel(code.severity) },
  }));

  const results: SarifResult[] = findings.map((finding) => {
    const result: SarifResult = {
      ruleId: finding.code,
      level: finding.severity,
      message: { text: finding.message },
    };
    const location: SarifLocation = {
      physicalLocation: { artifactLocation: { uri } },
    };
    if (finding.path !== '') {
      location.logicalLocations = [{ fullyQualifiedName: finding.path }];
    }
    if (options.sourceMap !== undefined) {
      const region = resolveRegion(options.sourceMap, finding.path);
      if (region !== undefined) location.physicalLocation.region = region;
    }
    result.locations = [location];
    return result;
  });

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'iap',
            version: options.toolVersion,
            informationUri: 'https://iap.dev',
            rules,
          },
        },
        results,
      },
    ],
  };
}
