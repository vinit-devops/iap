/**
 * Plan-artifact schema validation.
 *
 * The normative machine-readable contract is
 * `spec/schema/plan-v1.schema.json`; the copy embedded under `../schemas/`
 * is synced by `tools/schema-generation/sync-schemas.mjs` and drift-tested
 * by byte equality (ADR-0002 no-second-source). Validation runs under ajv
 * draft 2020-12 with strict mode ON via `@iap/parser`'s `createValidator`.
 */

import { readFileSync } from 'node:fs';
import type { ValidateFunction } from 'ajv';
import type { JsonSchema } from '@iap/model';
import { createValidator } from '@iap/parser';
import type { PlanArtifact } from './plan.js';

let cachedSchema: JsonSchema | undefined;

/** The embedded plan-v1 companion schema (parsed, cached). */
export function planSchema(): JsonSchema {
  cachedSchema ??= JSON.parse(
    readFileSync(new URL('../schemas/plan-v1.schema.json', import.meta.url), 'utf8'),
  ) as JsonSchema;
  return cachedSchema;
}

let cachedValidator: ValidateFunction | undefined;

export type PlanArtifactValidation =
  { ok: true; artifact: PlanArtifact } | { ok: false; errors: string[] };

/**
 * Validate a value against the embedded plan-v1 schema. A plan failing its
 * own schema is unexecutable (IEP-0011 validation impact); callers must
 * treat `ok: false` as a refusal, never a warning.
 */
export function validatePlanArtifact(value: unknown): PlanArtifactValidation {
  const validator = (cachedValidator ??= createValidator(planSchema()));
  if (validator(value)) {
    return { ok: true, artifact: value as PlanArtifact };
  }
  const errors = (validator.errors ?? []).map(
    (error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`,
  );
  return { ok: false, errors };
}
