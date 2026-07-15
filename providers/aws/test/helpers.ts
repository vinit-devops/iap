/** Shared test helpers: load the signed package and canonicalize documents. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalModel } from '@iap/model';
import { canonicalize } from '@iap/model';
import { loadDocument } from '@iap/parser';
import type { LoadedProviderPackage, MappingArtifact, TrustStore } from '@iap/provider-sdk';
import { loadProviderPackage } from '@iap/provider-sdk';
import { AWS_PROVIDER_PACKAGE_NAME, AWS_SIGNING_KEY_ID } from '../src/index';

export const packageDir = join(__dirname, '..');
export const repoRoot = join(packageDir, '..', '..');
export const corpusDir = join(packageDir, 'conformance');

export function awsTrustStore(): TrustStore {
  return {
    [AWS_SIGNING_KEY_ID]: readFileSync(
      join(packageDir, 'keys', `${AWS_SIGNING_KEY_ID}.public.pem`),
      'utf8',
    ),
  };
}

export const loadOptions = () => ({
  trustStore: awsTrustStore(),
  allowlist: [AWS_PROVIDER_PACKAGE_NAME],
});

/** Load the signed AWS package, throwing on any refusal (tests assert ok elsewhere). */
export function loadAwsPackage(): LoadedProviderPackage {
  const result = loadProviderPackage(packageDir, loadOptions());
  if (!result.ok) {
    throw new Error(
      `AWS package refused: ${result.refusals.map((r) => `[${r.code}] ${r.message}`).join('; ')}`,
    );
  }
  return result.pkg;
}

/** The package's single core mapping artifact. */
export function coreMapping(): MappingArtifact {
  const pkg = loadAwsPackage();
  const mapping = pkg.mappings[0];
  if (!mapping) throw new Error('AWS package bundles no mapping artifact');
  return mapping.artifact;
}

/** Parse and canonicalize a conforming document from an absolute path. */
export function canonicalModelFor(
  absolutePath: string,
  profile: string | null = null,
): CanonicalModel {
  const parsed = loadDocument(readFileSync(absolutePath, 'utf8'), { filename: absolutePath });
  if (!parsed.ok || parsed.document === undefined) {
    throw new Error(
      `"${absolutePath}" is not a conforming document: ${parsed.findings
        .map((f) => `${f.code} ${f.message}`)
        .join('; ')}`,
    );
  }
  const canonical = canonicalize(parsed.document, { profile });
  const errors = canonical.findings.filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `"${absolutePath}" failed canonicalization: ${errors.map((f) => `${f.code} ${f.path}`).join('; ')}`,
    );
  }
  return canonical.model;
}
