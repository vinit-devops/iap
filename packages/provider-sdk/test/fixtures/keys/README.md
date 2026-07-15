# TEST MATERIAL ONLY

The `test-only.*.pem` ed25519 keypair in this directory exists solely to sign
the committed test fixture package (`../tiny-provider`) in unit tests. It is
deliberately public, carries no trust, and MUST NOT be used to sign anything
outside `packages/provider-sdk/test/`.

Generated with:

```
node tools/provider-packaging/sign-manifest.mjs --generate-key packages/provider-sdk/test/fixtures/keys --prefix test-only
```
