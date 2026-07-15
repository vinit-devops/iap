/**
 * Shared test helpers for the kubernetes provider package suite: package
 * loading with the committed test-only trust material (trust stores are
 * built from `keys/*.public.pem`, keyId = filename stem, exactly like the
 * shared conformance runner), and canonicalization of corpus documents.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CanonicalModel } from '@iap/model';
import { canonicalize } from '@iap/model';
import { loadDocument } from '@iap/parser';
import type { LoadedProviderPackage, MappingArtifact, TrustStore } from '@iap/provider-sdk';
import { loadProviderPackage } from '@iap/provider-sdk';
import { PROVIDER_PACKAGE_NAME } from '../src/index';

export const packageDir = join(__dirname, '..');
export const repoRoot = join(packageDir, '..', '..');
export const corpusDir = join(packageDir, 'conformance');

/** Trust store from the committed public keys: keyId = filename stem. */
export function packageTrustStore(): TrustStore {
  const keysDir = join(packageDir, 'keys');
  const store: Record<string, string> = {};
  for (const file of readdirSync(keysDir)) {
    if (!file.endsWith('.public.pem')) continue;
    store[basename(file, '.public.pem')] = readFileSync(join(keysDir, file), 'utf8');
  }
  return store;
}

let cachedPackage: LoadedProviderPackage | undefined;

/** Load (and cache) the signed package through the SDK loader. */
export function loadPackage(): LoadedProviderPackage {
  if (cachedPackage) return cachedPackage;
  const result = loadProviderPackage(packageDir, {
    trustStore: packageTrustStore(),
    allowlist: [PROVIDER_PACKAGE_NAME],
  });
  if (!result.ok) {
    const details = result.refusals.map((r) => `[${r.code}] ${r.message}`).join('\n  ');
    throw new Error(`kubernetes provider package refused to load:\n  ${details}`);
  }
  cachedPackage = result.pkg;
  return cachedPackage;
}

/** The package's single core mapping artifact. */
export function coreMapping(): MappingArtifact {
  const mapping = loadPackage().mappings[0];
  if (!mapping) throw new Error('package declares no mapping artifact');
  return mapping.artifact;
}

/** Parse + canonicalize a conforming document from an absolute path. */
export function canonicalFromFile(path: string, profile: string | null): CanonicalModel {
  const parsed = loadDocument(readFileSync(path, 'utf8'), { filename: basename(path) });
  if (!parsed.ok || parsed.document === undefined) {
    const details = parsed.findings.map((f) => `${f.code} ${f.message}`).join('; ');
    throw new Error(`"${path}" is not a conforming document: ${details}`);
  }
  return canonicalize(parsed.document, { profile }).model;
}

/** Parse + canonicalize a conforming document from inline YAML text. */
export function canonicalFromText(text: string, profile: string | null = null): CanonicalModel {
  const parsed = loadDocument(text, { filename: 'inline.iap.yaml' });
  if (!parsed.ok || parsed.document === undefined) {
    const details = parsed.findings.map((f) => `${f.code} ${f.message}`).join('; ');
    throw new Error(`inline document is not conforming: ${details}`);
  }
  return canonicalize(parsed.document, { profile }).model;
}

/** The shared acceptance surface: spec/examples/basic-webapp.iap.yaml, production profile. */
export function canonicalWebapp(): CanonicalModel {
  return canonicalFromFile(
    join(repoRoot, 'spec', 'examples', 'basic-webapp.iap.yaml'),
    'production',
  );
}
