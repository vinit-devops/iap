/**
 * Manifest signing and artifact digest pinning (IEP-0012; phase-6 design
 * decision 2: zero new dependencies — ed25519 and SHA-256 via node:crypto).
 *
 * The signing input is the manifest with its `signature` member removed,
 * canonically serialized: keys sorted by Unicode code point, compact UTF-8
 * JSON with no insignificant whitespace (the same canonical serialization
 * `@iap/model` uses for document hashing, so there is exactly one canonical
 * byte form in the toolchain). Artifact digests are `sha256:<hex>` over the
 * exact file bytes.
 */

import { Buffer } from 'node:buffer';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalJsonStringify } from '@iap/model';
import type { ManifestSignature, PluginManifest, UnsignedPluginManifest } from './manifest.js';

/** Explicit keyId → PEM public key map supplied to the loader (design decision 2). */
export type TrustStore = Readonly<Record<string, string>>;

/**
 * The canonical signing form: the manifest minus `signature`, key-sorted,
 * compact, UTF-8. Both signing and verification derive their bytes from
 * this single function.
 */
export function manifestSigningBytes(manifest: UnsignedPluginManifest | PluginManifest): Buffer {
  const unsigned: Record<string, unknown> = { ...manifest };
  delete unsigned.signature;
  return Buffer.from(canonicalJsonStringify(unsigned), 'utf8');
}

/** `sha256:<hex>` digest over exact bytes — the integrity.digests value format. */
export function computeArtifactDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Sign the canonical signing form with an ed25519 private key (PEM, PKCS#8)
 * and return the manifest with its `signature` member (re)filled.
 */
export function signManifest(
  manifest: UnsignedPluginManifest | PluginManifest,
  privateKeyPem: string,
  keyId: string,
): PluginManifest {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(`signing key must be ed25519, got ${String(key.asymmetricKeyType)}`);
  }
  const signature: ManifestSignature = {
    keyId,
    alg: 'ed25519',
    value: sign(null, manifestSigningBytes(manifest), key).toString('base64'),
  };
  return { ...(manifest as PluginManifest), signature };
}

export type SignatureVerification = { ok: true } | { ok: false; reason: string };

/**
 * Verify a manifest's ed25519 signature against the trust store. Fail-closed:
 * unknown key ids, non-ed25519 algorithms, unparseable keys, and invalid
 * signatures all refuse (IEP-0012 PC-1 — unsigned or partially verified
 * loading is categorically rejected).
 */
export function verifyManifestSignature(
  manifest: PluginManifest,
  trustStore: TrustStore,
): SignatureVerification {
  const signature = manifest.signature;
  if (typeof signature !== 'object' || signature === null) {
    return { ok: false, reason: 'manifest carries no signature' };
  }
  if (signature.alg !== 'ed25519') {
    return { ok: false, reason: `unsupported signature algorithm "${String(signature.alg)}"` };
  }
  const publicKeyPem = trustStore[signature.keyId];
  if (publicKeyPem === undefined) {
    return { ok: false, reason: `keyId "${signature.keyId}" is not in the trust store` };
  }
  try {
    const key = createPublicKey(publicKeyPem);
    const valid = verify(
      null,
      manifestSigningBytes(manifest),
      key,
      Buffer.from(signature.value, 'base64'),
    );
    return valid
      ? { ok: true }
      : { ok: false, reason: 'signature does not verify over the canonical signing form' };
  } catch (error) {
    return {
      ok: false,
      reason: `signature verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
