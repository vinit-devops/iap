/**
 * The IaP error-code registry (spec/conformance/error-codes.yaml), embedded
 * as `registry/error-codes.yaml` so the published CLI is self-contained —
 * the same pattern `@iap/model` uses for the normative schemas. A drift test
 * in `test/cli.test.ts` pins the embedded copy byte-identical to the spec
 * artifact.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface RegistryCode {
  code: string;
  phase: number;
  severity: 'error' | 'warning' | 'contextual';
  stage: 'validation' | 'plan-time';
  title: string;
}

export interface ErrorCodeRegistry {
  version: string;
  codes: RegistryCode[];
}

let cached: ErrorCodeRegistry | undefined;

/** Parse (once) and return the embedded registry, codes in file order. */
export function errorCodeRegistry(): ErrorCodeRegistry {
  if (cached === undefined) {
    const url = new URL('../registry/error-codes.yaml', import.meta.url);
    cached = parse(readFileSync(url, 'utf8')) as ErrorCodeRegistry;
  }
  return cached;
}
