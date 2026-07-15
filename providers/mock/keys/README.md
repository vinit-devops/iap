# TEST MATERIAL ONLY

The `mock-test-2026.*.pem` ed25519 keypair in this directory exists solely to
sign the mock provider package's committed `manifest.json`. It is deliberately
public, carries no trust, and MUST NOT be used to sign anything outside
`providers/mock/`.

Convention (relied on by `tests/conformance/providers.mjs`): every provider
package commits its public key(s) as `providers/<name>/keys/*.public.pem`,
with the signing `keyId` as the filename stem (here: `mock-test-2026`).

Generated with:

```
node tools/provider-packaging/sign-manifest.mjs --generate-key providers/mock/keys --prefix mock-test-2026
```

Re-sign after any change to a digest-pinned artifact (mappings/, schema/,
conformance/):

```
pnpm build
node tools/provider-packaging/sign-manifest.mjs providers/mock \
  --key providers/mock/keys/mock-test-2026.private.pem --key-id mock-test-2026
```
