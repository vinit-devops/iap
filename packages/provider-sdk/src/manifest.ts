/**
 * Plugin manifest types and validation (IEP-0012).
 *
 * The normative machine-readable contract is
 * `spec/schema/plugin-manifest-v1.schema.json`; the copy embedded under
 * `../schemas/` is synced by `tools/schema-generation/sync-schemas.mjs` and
 * drift-tested by byte equality (ADR-0002 no-second-source). Where these
 * types and the schema disagree, the schema governs.
 */

import { readFileSync } from 'node:fs';
import type { ValidateFunction } from 'ajv';
import type { JsonSchema, Kind } from '@iap/model';
import { createValidator } from '@iap/parser';

export const PLUGIN_MANIFEST_API_VERSION = 'plugin.iap.dev/v1' as const;
export const CONFORMANCE_CASE_API_VERSION = 'conformance.iap.dev/v1' as const;

/**
 * The IaP specification version this SDK implements (spec ch. 10). Mapping
 * and package `specCompat` ranges are checked against it; a range that
 * excludes it refuses the artifact.
 */
export const IAP_SPEC_VERSION = '1.0.0' as const;

/** The provider-SDK version checked against package `sdkCompat` ranges. */
export const PROVIDER_SDK_VERSION = '0.1.0' as const;

export const CERTIFICATION_LEVELS = ['core', 'execution', 'drift'] as const;
export type CertificationLevel = (typeof CERTIFICATION_LEVELS)[number];

export const PROVIDER_HOOKS = ['validate', 'discover', 'cost', 'security'] as const;
export type ProviderHook = (typeof PROVIDER_HOOKS)[number];

export const PROVIDER_HANDLERS = ['execute', 'read', 'drift', 'import'] as const;
export type ProviderHandler = (typeof PROVIDER_HANDLERS)[number];

export interface PluginManifestArtifacts {
  /** Package-relative paths of the mapping artifacts (*.iap-map.yaml). */
  mappings: string[];
  /** JSON Schema validating this package's extensions.<namespace> blocks. */
  extensionSchema: string;
  /** Directory of conformance cases and corpus documents. */
  conformanceCases: string;
  icons?: string;
  docs?: string;
  [xKey: `x-${string}`]: unknown;
}

export interface PluginCapabilities {
  kinds: Kind[];
  hooks?: ProviderHook[];
  handlers?: ProviderHandler[];
  [xKey: `x-${string}`]: unknown;
}

export interface ManifestSignature {
  /** Resolved against the loader's trust store; unknown ids refuse the package. */
  keyId: string;
  alg: 'ed25519';
  /** Base64 ed25519 signature over the canonical signing form. */
  value: string;
  [xKey: `x-${string}`]: unknown;
}

export interface ManifestIntegrity {
  /** Package-relative file path → `sha256:<hex>` over the exact file bytes. */
  digests: Record<string, string>;
  [xKey: `x-${string}`]: unknown;
}

/** A signed provider package manifest (`manifest.json`). */
export interface PluginManifest {
  apiVersion: typeof PLUGIN_MANIFEST_API_VERSION;
  name: string;
  namespace: string;
  version: string;
  specCompat: string;
  sdkCompat: string;
  certificationLevel: CertificationLevel;
  artifacts: PluginManifestArtifacts;
  capabilities: PluginCapabilities;
  attestations?: string;
  integrity: ManifestIntegrity;
  signature: ManifestSignature;
  [xKey: `x-${string}`]: unknown;
}

/** The manifest before (or without) its signature member — the signing form's shape. */
export type UnsignedPluginManifest = Omit<PluginManifest, 'signature'>;

/* ------------------------------------------------------------------ */
/* Embedded companion schemas                                          */
/* ------------------------------------------------------------------ */

function loadEmbeddedSchema(name: string): JsonSchema {
  const url = new URL(`../schemas/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as JsonSchema;
}

/** The plugin-manifest companion schema (embedded copy; drift-tested against spec/schema). */
export function pluginManifestSchema(): JsonSchema {
  return loadEmbeddedSchema('plugin-manifest-v1.schema.json');
}

/** The conformance-case companion schema (embedded copy; drift-tested against spec/schema). */
export function conformanceCaseSchema(): JsonSchema {
  return loadEmbeddedSchema('conformance-case-v1.schema.json');
}

let manifestValidator: ValidateFunction | undefined;

export type ManifestValidation =
  { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] };

/**
 * Validate a parsed manifest against the embedded plugin-manifest schema
 * (ajv 2020-12, strict mode ON with the x-iap-* vocabulary registered,
 * exactly like every other normative validation in this repository).
 */
export function validateManifest(value: unknown): ManifestValidation {
  manifestValidator ??= createValidator(pluginManifestSchema());
  if (manifestValidator(value)) {
    return { ok: true, manifest: value as PluginManifest };
  }
  const errors = (manifestValidator.errors ?? []).map(
    (error) => `${error.instancePath || '/'} ${error.message ?? 'schema violation'}`,
  );
  return { ok: false, errors };
}
