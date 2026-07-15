/**
 * Small pure helpers shared across the AWS execution runtime. No SDK, no I/O.
 */

import type { PlanResource, Scalar } from '@iap/provider-sdk';

/**
 * Recover the canonical resourceId from a plan resource. Plan logicalIds are
 * `<resourceId>.<targetType>` (engine.ts), and the targetType is carried
 * verbatim in `resource.type`, so the resourceId is the logicalId with the
 * `.<type>` suffix removed. Physical AWS names are derived from it.
 */
export function resourceIdOf(resource: PlanResource): string {
  const suffix = `.${resource.type}`;
  return resource.logicalId.endsWith(suffix)
    ? resource.logicalId.slice(0, resource.logicalId.length - suffix.length)
    : resource.logicalId;
}

/** Stringify a plan scalar for SDK params / drift comparison; absent → ''. */
export function scalarStr(value: Scalar | undefined): string {
  return value === undefined ? '' : String(value);
}

/** Deterministic serialization of a flat string projection (keys sorted). */
export function canonical(projection: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(projection).sort()) {
    sorted[key] = projection[key] ?? '';
  }
  return JSON.stringify(sorted);
}

/** Extract a human-readable message from an unknown thrown value. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Service-error discriminator name (SDK uses `name`; wire uses `Code`/`__type`). */
export function errorName(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; Code?: unknown; __type?: unknown };
    if (typeof e.name === 'string') return e.name;
    if (typeof e.Code === 'string') return e.Code;
    if (typeof e.__type === 'string') return e.__type;
  }
  return '';
}

/** HTTP status code from an SDK error's `$metadata`, if present. */
export function httpStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
    if (meta && typeof meta.httpStatusCode === 'number') return meta.httpStatusCode;
  }
  return undefined;
}

/** True when the error's discriminator name contains any of the given tokens. */
export function nameMatches(err: unknown, tokens: readonly string[]): boolean {
  const name = errorName(err);
  return tokens.some((token) => name.includes(token));
}
