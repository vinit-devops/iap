/**
 * Structural validation of proposal batches against the embedded companion
 * schema (`compiler-operations-v1.schema.json`, synced from `spec/schema/`
 * and drift-tested by byte equality — ADR-0002 no-second-source). Runs under
 * ajv draft 2020-12 with strict mode ON via `@iap/parser`'s `createValidator`.
 *
 * ajv errors are folded into the closed refusal taxonomy: an out-of-enum
 * `type` refuses as `invalid-operation-type`, an identifier pattern failure
 * as `id-grammar`, everything else as `schema-violation` — so structured
 * refusals are machine-readable before any target resolution happens.
 */

import { readFileSync } from 'node:fs';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { JsonSchema } from '@iap/model';
import { createValidator } from '@iap/parser';
import type { OperationRefusal } from './errors.js';
import { refuse } from './errors.js';
import type { OperationBatch } from './operations.js';

let cachedSchema: JsonSchema | undefined;

/** The embedded compiler-operations-v1 companion schema (parsed, cached). */
export function compilerOperationsSchema(): JsonSchema {
  cachedSchema ??= JSON.parse(
    readFileSync(new URL('../schemas/compiler-operations-v1.schema.json', import.meta.url), 'utf8'),
  ) as JsonSchema;
  return cachedSchema;
}

let cachedValidator: ValidateFunction | undefined;

export type BatchStructureResult =
  { ok: true; batch: OperationBatch } | { ok: false; refusals: OperationRefusal[] };

/** `/operations/<i>/...` → the envelope's operationId when the index parses and the id is a string. */
function operationIdAt(value: unknown, instancePath: string): string | undefined {
  const match = /^\/operations\/(\d+)/.exec(instancePath);
  if (match === null) return undefined;
  const operations = (value as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return undefined;
  const envelope = operations[Number(match[1])] as { operationId?: unknown } | undefined;
  return typeof envelope?.operationId === 'string' ? envelope.operationId : undefined;
}

/** Identifier-bearing envelope locations whose pattern failures are grammar refusals. */
const ID_PATTERN_PATHS = /\/(resourceId|profile|policyId|namespace|target)$/;

function toRefusal(value: unknown, error: ErrorObject): OperationRefusal {
  const path = error.instancePath || '/';
  const detail: { operationId?: string; path: string } = { path };
  const operationId = operationIdAt(value, error.instancePath);
  if (operationId !== undefined) detail.operationId = operationId;

  if (/\/operations\/\d+\/type$/.test(error.instancePath) && error.keyword === 'enum') {
    return refuse(
      'invalid-operation-type',
      `unknown operation type — the v1 vocabulary is closed at twelve operations (IEP-0009)`,
      detail,
    );
  }
  if (error.keyword === 'pattern' && ID_PATTERN_PATHS.test(error.instancePath)) {
    return refuse(
      'id-grammar',
      `identifier violates its grammar at ${path}: ${error.message ?? 'pattern violation'} (ch. 2 §2.6.1 / ch. 11 §11.1)`,
      detail,
    );
  }
  return refuse(
    'schema-violation',
    `${path} ${error.message ?? 'violates the operation schema'}`,
    detail,
  );
}

/**
 * Validate a value against the embedded companion schema and fold failures
 * into the refusal taxonomy. All structural findings are collected — the
 * proposer sees every problem at once, not the first.
 */
export function validateBatchStructure(value: unknown): BatchStructureResult {
  const validator = (cachedValidator ??= createValidator(compilerOperationsSchema()));
  if (validator(value)) {
    return { ok: true, batch: value as OperationBatch };
  }
  const refusals = (validator.errors ?? []).map((error) => toRefusal(value, error));
  return {
    ok: false,
    refusals: refusals.length > 0 ? refusals : [refuse('schema-violation', 'invalid batch')],
  };
}
