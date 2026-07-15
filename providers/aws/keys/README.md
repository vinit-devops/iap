# Test-only signing keys

**This keypair is TEST MATERIAL ONLY.** It signs the committed
`providers/aws/manifest.json` so the loader, signature-verification, and
conformance test suites can run against a fully signed package. The private
key is deliberately committed; it protects nothing and must never be used
outside this repository's test and conformance harnesses.

- `aws-test-2026.private.pem` — ed25519 private key (PKCS#8 PEM), test only.
- `aws-test-2026.public.pem` — ed25519 public key (SPKI PEM). The shared
  conformance runner builds its trust store from
  `providers/<name>/keys/*.public.pem`; the keyId is the filename stem
  (`aws-test-2026`), matching `signature.keyId` in `manifest.json`.

Re-sign after editing any digest-pinned artifact (mappings, extension schema,
conformance cases or corpus):

```sh
node tools/provider-packaging/sign-manifest.mjs providers/aws \
  --key providers/aws/keys/aws-test-2026.private.pem --key-id aws-test-2026
```

Production packages are signed by publisher keys distributed through the
registry trust store (roadmap Phase 18), never by committed keys.
