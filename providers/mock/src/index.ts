/**
 * @iap/provider-mock — the IEP-0012 reference provider package
 * (`providers/mock`, namespace `mock`, certification level **execution**).
 *
 * Normative-by-example: the signed package artifacts (manifest, mapping,
 * extension schema, conformance corpus) exercise every feature of the
 * provider harness, and this module supplies the runtime halves —
 * attestation functions and the execution-level handlers over a
 * deterministic in-memory substrate with injectable failures.
 */

export const PROVIDER_PACKAGE = '@iap/provider-mock';
export const PROVIDER_NAMESPACE = 'mock';

export {
  MOCK_OPERATIONS,
  MOCK_REPLACE_ON,
  MOCK_SENSITIVE_ATTRIBUTES,
  MockSubstrate,
  REDACTED,
  generateOutputs,
  sensitiveFieldsFor,
} from './substrate.js';
export type {
  FailureInjection,
  MockObjectRecord,
  MockObjectView,
  MockOperation,
  MockSubstrateOptions,
} from './substrate.js';

export { executePlan, importObject, readObject, verifyConvergence } from './handlers.js';
export type {
  ConvergenceResult,
  ExecutedOperation,
  ExecutionResult,
  ImportResult,
  PlanAction,
  ReadResult,
} from './handlers.js';

export { createAttestationRegistry } from './attestations.js';
export { mockCostModel } from './cost.js';
