/**
 * Provider package loader (IEP-0012 "Loading (normative)"; phase-6 design
 * decisions 2 and 6).
 *
 * `loadProviderPackage(dir, options)` verifies, in order: manifest shape,
 * publisher allowlist, ed25519 signature against the trust store, every
 * artifact digest against exact file bytes, specCompat/sdkCompat ranges,
 * mapping-artifact schema validity, and static coverage tiling (supports ⊆
 * realize, total derive maps, complete output binding). ANY failure refuses
 * the whole package with structured refusals — there is no degraded load
 * (PC-1). Verification stops at the first stage that fails but reports every
 * failure found within that stage.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseAllDocuments } from 'yaml';
import type { JsonSchema } from '@iap/model';
import { X_IIS_ANNOTATION_KEYWORDS } from '@iap/model';
import type { PluginManifest } from './manifest.js';
import { IAP_SPEC_VERSION, PROVIDER_SDK_VERSION, validateManifest } from './manifest.js';
import type { MappingArtifact } from './mapping.js';
import { validateMappingArtifact } from './mapping.js';
import { satisfiesRange } from './semver.js';
import type { TrustStore } from './signing.js';
import { computeArtifactDigest, verifyManifestSignature } from './signing.js';
import { verifyMappingArtifact } from './verify-mapping.js';

export type LoadRefusalCode =
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'allowlist'
  | 'signature'
  | 'integrity'
  | 'spec-compat'
  | 'sdk-compat'
  | 'artifact-invalid'
  | 'coverage-tiling';

export interface LoadRefusal {
  code: LoadRefusalCode;
  message: string;
  /** Package-relative artifact path, where the refusal is file-scoped. */
  path?: string;
}

export interface LoadProviderPackageOptions {
  /** keyId → PEM public key. Empty trust store trusts nothing. */
  trustStore: TrustStore;
  /** Explicit set of permitted package names. Empty allowlist permits nothing. */
  allowlist: readonly string[];
  /** Specification version in force; defaults to IAP_SPEC_VERSION. */
  specVersion?: string;
  /** SDK version in force; defaults to PROVIDER_SDK_VERSION. */
  sdkVersion?: string;
}

export interface LoadedMapping {
  /** Package-relative artifact path. */
  path: string;
  artifact: MappingArtifact;
}

export interface LoadedProviderPackage {
  dir: string;
  manifest: PluginManifest;
  mappings: LoadedMapping[];
  extensionSchema: JsonSchema;
}

export type LoadProviderPackageResult =
  { ok: true; pkg: LoadedProviderPackage } | { ok: false; refusals: LoadRefusal[] };

/* ------------------------------------------------------------------ */

/** Reject absolute paths and `.`/`..` segments — artifacts stay inside the package. */
function isSafeRelativePath(path: string): boolean {
  if (path.startsWith('/') || path.length === 0) return false;
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  return trimmed
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** All files under a directory, as sorted package-relative paths. */
function walkFiles(dir: string, relative: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const childRelative = `${relative}${entry.name}`;
    if (entry.isDirectory()) {
      walkFiles(join(dir, entry.name), `${childRelative}/`, out);
    } else if (entry.isFile()) {
      out.push(childRelative);
    }
  }
}

function stripTrailingSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Load and verify a provider package directory. Refuses outright on any
 * signature, digest, compatibility, allowlist, schema, or coverage-tiling
 * failure (IEP-0012 PC-1).
 */
export function loadProviderPackage(
  dir: string,
  options: LoadProviderPackageOptions,
): LoadProviderPackageResult {
  const specVersion = options.specVersion ?? IAP_SPEC_VERSION;
  const sdkVersion = options.sdkVersion ?? PROVIDER_SDK_VERSION;

  // Stage 1 — manifest presence and shape.
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      refusals: [
        { code: 'manifest-missing', message: `no manifest.json in ${dir}`, path: 'manifest.json' },
      ],
    };
  }
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      refusals: [
        {
          code: 'manifest-invalid',
          message: `manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          path: 'manifest.json',
        },
      ],
    };
  }
  const validation = validateManifest(parsedManifest);
  if (!validation.ok) {
    return {
      ok: false,
      refusals: validation.errors.map((message) => ({
        code: 'manifest-invalid' as const,
        message: `manifest schema violation: ${message}`,
        path: 'manifest.json',
      })),
    };
  }
  const manifest = validation.manifest;

  // Stage 2 — publisher allowlist.
  if (!options.allowlist.includes(manifest.name)) {
    return {
      ok: false,
      refusals: [
        {
          code: 'allowlist',
          message: `package name "${manifest.name}" is not in the publisher allowlist`,
        },
      ],
    };
  }

  // Stage 3 — signature against the trust store.
  const signatureCheck = verifyManifestSignature(manifest, options.trustStore);
  if (!signatureCheck.ok) {
    return {
      ok: false,
      refusals: [{ code: 'signature', message: signatureCheck.reason }],
    };
  }

  // Stage 4 — integrity: every referenced artifact has a digest, every digest verifies.
  const refusals: LoadRefusal[] = [];
  const digests = manifest.integrity.digests;
  const requiredFiles = new Set<string>();
  const referencedPaths: string[] = [
    ...manifest.artifacts.mappings,
    manifest.artifacts.extensionSchema,
    manifest.artifacts.conformanceCases,
    ...(manifest.artifacts.icons !== undefined ? [manifest.artifacts.icons] : []),
    ...(manifest.artifacts.docs !== undefined ? [manifest.artifacts.docs] : []),
    ...(manifest.attestations !== undefined ? [manifest.attestations] : []),
  ];
  for (const path of [...referencedPaths, ...Object.keys(digests)]) {
    if (!isSafeRelativePath(path)) {
      refusals.push({
        code: 'integrity',
        message: `artifact path "${path}" escapes the package directory`,
        path,
      });
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const expandDirectory = (path: string): void => {
    const absolute = join(dir, stripTrailingSlash(path));
    if (!existsSync(absolute)) {
      refusals.push({
        code: 'integrity',
        message: `artifact directory "${path}" does not exist`,
        path,
      });
      return;
    }
    const files: string[] = [];
    walkFiles(absolute, `${stripTrailingSlash(path)}/`, files);
    for (const file of files) requiredFiles.add(file);
  };

  for (const path of referencedPaths) {
    const absolute = join(dir, stripTrailingSlash(path));
    if (path.endsWith('/') || (existsSync(absolute) && statSync(absolute).isDirectory())) {
      expandDirectory(path);
    } else {
      requiredFiles.add(path);
    }
  }
  for (const file of [...requiredFiles].sort()) {
    if (!Object.prototype.hasOwnProperty.call(digests, file)) {
      refusals.push({
        code: 'integrity',
        message: `artifact "${file}" has no integrity digest`,
        path: file,
      });
    }
  }
  for (const [file, expected] of Object.entries(digests)) {
    const absolute = join(dir, file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      refusals.push({
        code: 'integrity',
        message: `pinned artifact "${file}" is missing from the package`,
        path: file,
      });
      continue;
    }
    const actual = computeArtifactDigest(readFileSync(absolute));
    if (actual !== expected) {
      refusals.push({
        code: 'integrity',
        message: `digest mismatch for "${file}": manifest pins ${expected}, file bytes hash to ${actual}`,
        path: file,
      });
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  // Stage 5 — compatibility ranges.
  if (!satisfiesRange(specVersion, manifest.specCompat)) {
    refusals.push({
      code: 'spec-compat',
      message: `package specCompat "${manifest.specCompat}" excludes specification ${specVersion}`,
    });
  }
  if (!satisfiesRange(sdkVersion, manifest.sdkCompat)) {
    refusals.push({
      code: 'sdk-compat',
      message: `package sdkCompat "${manifest.sdkCompat}" excludes SDK ${sdkVersion}`,
    });
  }
  if (refusals.length > 0) return { ok: false, refusals };

  // Stage 6 — mapping artifacts: schema-valid, namespace-coherent, spec-compatible.
  const mappings: LoadedMapping[] = [];
  const kindOwners = new Map<string, string>();
  for (const path of manifest.artifacts.mappings) {
    let parsed: unknown;
    try {
      const docs = parseAllDocuments(readFileSync(join(dir, path), 'utf8'), {
        uniqueKeys: true,
      });
      const doc = docs[0];
      if (docs.length !== 1 || !doc) throw new Error(`expected a single YAML document`);
      if (doc.errors.length > 0) throw new Error(doc.errors[0]?.message ?? 'YAML parse error');
      parsed = doc.toJS();
    } catch (error) {
      refusals.push({
        code: 'artifact-invalid',
        message: `mapping "${path}" failed to parse: ${error instanceof Error ? error.message : String(error)}`,
        path,
      });
      continue;
    }
    const result = validateMappingArtifact(parsed);
    if (!result.ok) {
      for (const message of result.errors) {
        refusals.push({
          code: 'artifact-invalid',
          message: `mapping "${path}" violates iap-mapping-v1.schema.json: ${message}`,
          path,
        });
      }
      continue;
    }
    const artifact = result.artifact;
    if (artifact.provider !== manifest.namespace) {
      refusals.push({
        code: 'artifact-invalid',
        message: `mapping "${path}" declares provider "${artifact.provider}", but the package namespace is "${manifest.namespace}"`,
        path,
      });
    }
    if (!satisfiesRange(specVersion, artifact.specCompat)) {
      refusals.push({
        code: 'spec-compat',
        message: `mapping "${path}" declares specCompat "${artifact.specCompat}", which excludes specification ${specVersion}`,
        path,
      });
    }
    for (const kind of Object.keys(artifact.mappings)) {
      const owner = kindOwners.get(kind);
      if (owner !== undefined) {
        refusals.push({
          code: 'artifact-invalid',
          message: `kind ${kind} is mapped by both "${owner}" and "${path}"`,
          path,
        });
      } else {
        kindOwners.set(kind, path);
      }
    }
    mappings.push({ path, artifact });
  }
  // Capability claims must match mapping coverage exactly (PC-5 spirit: no
  // partial or inflated claims).
  const coveredKinds = new Set(kindOwners.keys());
  for (const kind of manifest.capabilities.kinds) {
    if (!coveredKinds.has(kind)) {
      refusals.push({
        code: 'artifact-invalid',
        message: `capabilities.kinds claims ${kind}, but no mapping artifact covers it`,
      });
    }
  }
  for (const kind of coveredKinds) {
    if (!manifest.capabilities.kinds.includes(kind as never)) {
      refusals.push({
        code: 'artifact-invalid',
        message: `mapping artifacts cover ${kind}, which capabilities.kinds does not claim`,
      });
    }
  }

  // Extension schema must parse and compile (core certification requires it).
  let extensionSchema: JsonSchema | undefined;
  try {
    extensionSchema = JSON.parse(
      readFileSync(join(dir, manifest.artifacts.extensionSchema), 'utf8'),
    ) as JsonSchema;
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    for (const keyword of X_IIS_ANNOTATION_KEYWORDS) {
      ajv.addKeyword({ keyword, valid: true });
    }
    ajv.compile(extensionSchema);
  } catch (error) {
    refusals.push({
      code: 'artifact-invalid',
      message: `extension schema "${manifest.artifacts.extensionSchema}" does not compile: ${error instanceof Error ? error.message : String(error)}`,
      path: manifest.artifacts.extensionSchema,
    });
  }
  if (refusals.length > 0) return { ok: false, refusals };

  // Stage 7 — static coverage-tiling verification (design decision 6).
  for (const { path, artifact } of mappings) {
    for (const defect of verifyMappingArtifact(artifact)) {
      refusals.push({
        code: 'coverage-tiling',
        message: `[${defect.code}] ${defect.kind}: ${defect.message}`,
        path,
      });
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  return {
    ok: true,
    pkg: { dir, manifest, mappings, extensionSchema: extensionSchema as JsonSchema },
  };
}
