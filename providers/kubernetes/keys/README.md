# Test-only signing keys — kubernetes provider package

**TEST MATERIAL ONLY.** This ed25519 keypair (`kubernetes-test-2026`) exists
solely so the committed `manifest.json` of `iap-provider-kubernetes` carries a
verifiable signature for the conformance harness and the package test suite.
The private key is deliberately public in this repository; it authenticates
nothing and MUST NOT be trusted for, or reused in, any real distribution
channel. Production packages are signed per the registry/certification key
policy (IEP-0012 open question 2; roadmap Phase 18).

- `kubernetes-test-2026.private.pem` — PKCS#8 ed25519 private key (test only)
- `kubernetes-test-2026.public.pem` — SPKI public key; trust stores built by
  the shared runner use the filename stem (`kubernetes-test-2026`) as keyId

Re-sign after ANY artifact edit (digests are pinned by the signed manifest):

```sh
node tools/provider-packaging/sign-manifest.mjs providers/kubernetes \
  --key providers/kubernetes/keys/kubernetes-test-2026.private.pem \
  --key-id kubernetes-test-2026
```
