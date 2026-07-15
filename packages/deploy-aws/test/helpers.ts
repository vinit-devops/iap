/**
 * Test fixtures. NOT a `*.test.ts` file, so vitest does not collect it.
 * Builds minimal but well-formed `ProviderPlan` / `PlanResource` values.
 */

import type { PlanResource, ProviderPlan, Scalar } from '@iap/provider-sdk';

export function planResource(
  resourceId: string,
  type: string,
  desiredAttributes: Record<string, Scalar> = {},
): PlanResource {
  return {
    type,
    logicalId: `${resourceId}.${type}`,
    desiredAttributes,
    dependsOn: [],
    lifecycle: { createOnly: [], replaceOn: [], updateInPlace: [] },
    sensitiveFields: [],
    provenance: {},
  };
}

export function providerPlan(resources: PlanResource[], planHash = 'plan-hash-0001'): ProviderPlan {
  return {
    formatVersion: 1,
    provider: 'aws',
    mappingVersion: '1.0.0',
    specVersion: '1.0.0',
    profile: null,
    documentHash: 'doc-hash',
    inputs: {},
    resources,
    outputBindings: {},
    planHash,
  };
}

/** Build an SDK-style service error with a discriminator name + optional status. */
export function serviceError(name: string, httpStatusCode?: number): Error {
  const err = new Error(name);
  err.name = name;
  if (httpStatusCode !== undefined) {
    (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode };
  }
  return err;
}
