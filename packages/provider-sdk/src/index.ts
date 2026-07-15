/**
 * @iap/provider-sdk — provider plugin framework for IaP v1 (spec ch. 12,
 * IEP-0012, phase-6 design):
 *
 * - **manifest** — plugin manifest types + validation against the embedded
 *   plugin-manifest-v1 companion schema (drift-tested against spec/schema).
 * - **signing** — canonical manifest signing form, ed25519 sign/verify via
 *   node:crypto, sha256 artifact digest pinning.
 * - **loader** — `loadProviderPackage`: signature, allowlist, digest,
 *   specCompat/sdkCompat, mapping schema, and static coverage-tiling
 *   verification; any failure refuses the package (PC-1).
 * - **engine** — `applyMapping`: the pure, fail-closed mapping function from
 *   canonical model to provider plan with per-attribute provenance and
 *   deterministic planHash.
 * - **conformance** — the shared capability-assertion evaluator and the
 *   attestation-registration types provider packages implement.
 */

export {
  CERTIFICATION_LEVELS,
  CONFORMANCE_CASE_API_VERSION,
  IAP_SPEC_VERSION,
  PLUGIN_MANIFEST_API_VERSION,
  PROVIDER_HANDLERS,
  PROVIDER_HOOKS,
  PROVIDER_SDK_VERSION,
  conformanceCaseSchema,
  pluginManifestSchema,
  validateManifest,
} from './manifest.js';
export type {
  CertificationLevel,
  ManifestIntegrity,
  ManifestSignature,
  ManifestValidation,
  PluginCapabilities,
  PluginManifest,
  PluginManifestArtifacts,
  ProviderHandler,
  ProviderHook,
  UnsignedPluginManifest,
} from './manifest.js';

export {
  ABSTRACT_OUTPUT_ATTRIBUTES,
  MAPPING_API_VERSION,
  abstractOutputsForKind,
  collectSpecLeafPaths,
  getValueAtPath,
  isPathCovered,
  resolveKindField,
  splitTargetAttribute,
  supportedDomain,
  validateMappingArtifact,
} from './mapping.js';
export type {
  DeriveSpec,
  FieldSchemaInfo,
  KindMapping,
  MappingArtifact,
  MappingValidation,
  OutputBindingSpec,
  RealizeRule,
  Scalar,
  SupportsMatrix,
} from './mapping.js';

export {
  computeArtifactDigest,
  manifestSigningBytes,
  signManifest,
  verifyManifestSignature,
} from './signing.js';
export type { SignatureVerification, TrustStore } from './signing.js';

export { parseRange, parseSemver, compareSemver, satisfiesRange } from './semver.js';
export type { SemVer } from './semver.js';

export { MAX_TILING_COMBINATIONS, verifyMappingArtifact } from './verify-mapping.js';
export type { MappingDefect, MappingDefectCode } from './verify-mapping.js';

export { loadProviderPackage } from './loader.js';
export type {
  LoadProviderPackageOptions,
  LoadProviderPackageResult,
  LoadRefusal,
  LoadRefusalCode,
  LoadedMapping,
  LoadedProviderPackage,
} from './loader.js';

export { MAPPING_DIAGNOSTIC_REASONS, applyMapping } from './engine.js';
export type {
  ApplyMappingOptions,
  ApplyMappingResult,
  AttributeProvenance,
  MappingDiagnostic,
  MappingDiagnosticReason,
  MappingInputs,
  OutputBinding,
  PlanResource,
  PlanResourceLifecycle,
  ProviderPlan,
} from './engine.js';

export {
  AttestationRegistry,
  evaluateConformanceCase,
  validateConformanceCase,
} from './conformance.js';
export type {
  AssertionOutcome,
  AssertionSelect,
  AssertionVerdict,
  AttestationFn,
  AttestationInput,
  ConformanceAssertion,
  ConformanceCase,
  ConformanceCaseResult,
  ConformanceCaseValidation,
  EvaluateConformanceCaseOptions,
} from './conformance.js';
