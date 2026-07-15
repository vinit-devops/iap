import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginManifest, UnsignedPluginManifest } from '../src/index';
import {
  computeArtifactDigest,
  manifestSigningBytes,
  signManifest,
  verifyManifestSignature,
} from '../src/index';

const fixtures = join(__dirname, 'fixtures');
// Committed keypair — TEST MATERIAL ONLY (see fixtures/keys/README.md).
const privateKeyPem = readFileSync(join(fixtures, 'keys', 'test-only.private.pem'), 'utf8');
const publicKeyPem = readFileSync(join(fixtures, 'keys', 'test-only.public.pem'), 'utf8');
const trustStore = { 'test-only-2026': publicKeyPem };

function unsignedManifest(): UnsignedPluginManifest {
  const manifest = JSON.parse(
    readFileSync(join(fixtures, 'tiny-provider', 'manifest.json'), 'utf8'),
  ) as PluginManifest;
  const unsigned: Record<string, unknown> = { ...manifest };
  delete unsigned.signature;
  return unsigned as unknown as UnsignedPluginManifest;
}

describe('canonical signing form', () => {
  it('excludes the signature member and is key-order independent', () => {
    const unsigned = unsignedManifest();
    const signed = signManifest(unsigned, privateKeyPem, 'test-only-2026');
    expect(manifestSigningBytes(signed).equals(manifestSigningBytes(unsigned))).toBe(true);

    // Re-ordering keys must not change the canonical bytes.
    const shuffled = Object.fromEntries(Object.entries(unsigned).reverse());
    expect(manifestSigningBytes(shuffled as UnsignedPluginManifest)).toEqual(
      manifestSigningBytes(unsigned),
    );
  });

  it('is compact UTF-8 JSON with sorted keys', () => {
    const text = manifestSigningBytes(unsignedManifest()).toString('utf8');
    expect(text).not.toMatch(/\n/);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });
});

describe('signManifest / verifyManifestSignature', () => {
  it('sign then verify succeeds against the trust store', () => {
    const signed = signManifest(unsignedManifest(), privateKeyPem, 'test-only-2026');
    expect(signed.signature.keyId).toBe('test-only-2026');
    expect(signed.signature.alg).toBe('ed25519');
    expect(verifyManifestSignature(signed, trustStore)).toEqual({ ok: true });
  });

  it('signing is deterministic (ed25519 has no nonce): committed manifest matches a re-sign', () => {
    const committed = JSON.parse(
      readFileSync(join(fixtures, 'tiny-provider', 'manifest.json'), 'utf8'),
    ) as PluginManifest;
    const resigned = signManifest(committed, privateKeyPem, committed.signature.keyId);
    expect(resigned.signature.value).toBe(committed.signature.value);
  });

  it('refuses a tampered manifest field', () => {
    const signed = signManifest(unsignedManifest(), privateKeyPem, 'test-only-2026');
    const tampered = { ...signed, version: '1.0.1' };
    const result = verifyManifestSignature(tampered, trustStore);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not verify/);
  });

  it('refuses an unknown keyId', () => {
    const signed = signManifest(unsignedManifest(), privateKeyPem, 'rogue-key');
    const result = verifyManifestSignature(signed, trustStore);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not in the trust store/);
  });

  it('refuses a non-ed25519 algorithm', () => {
    const signed = signManifest(unsignedManifest(), privateKeyPem, 'test-only-2026');
    const tampered = {
      ...signed,
      signature: { ...signed.signature, alg: 'rsa' },
    } as unknown as PluginManifest;
    const result = verifyManifestSignature(tampered, trustStore);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unsupported signature algorithm/);
  });

  it('refuses a signature by a different (untrusted) key under a trusted keyId', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signed = signManifest(
      unsignedManifest(),
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      'test-only-2026',
    );
    expect(verifyManifestSignature(signed, trustStore).ok).toBe(false);
  });

  it('rejects non-ed25519 signing keys with TypeError', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => signManifest(unsignedManifest(), pem, 'ec-key')).toThrow(TypeError);
  });
});

describe('computeArtifactDigest', () => {
  it('produces sha256:<hex> over exact bytes', () => {
    const digest = computeArtifactDigest(Buffer.from('intent\n', 'utf8'));
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('any byte change produces a different digest', () => {
    const a = computeArtifactDigest(Buffer.from('spec: high', 'utf8'));
    const b = computeArtifactDigest(Buffer.from('spec: High', 'utf8'));
    expect(a).not.toBe(b);
  });

  it('matches the committed fixture digests', () => {
    const manifest = JSON.parse(
      readFileSync(join(fixtures, 'tiny-provider', 'manifest.json'), 'utf8'),
    ) as PluginManifest;
    for (const [path, expected] of Object.entries(manifest.integrity.digests)) {
      const bytes = readFileSync(join(fixtures, 'tiny-provider', path));
      expect(computeArtifactDigest(bytes), path).toBe(expected);
    }
  });
});
