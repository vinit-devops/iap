# IaP Security-Readiness Report (Phase 19, M19.6)

**Date:** 2026-07-12 · **Scope:** IaP v0.1 (Developer Preview — plan-preview only) ·
**Companion documents:** [`threat-model.md`](../security/threat-model.md),
[`known-risks.yaml`](../security/known-risks.yaml), [`implementation-audit.md`](implementation-audit.md).

> **This is NOT a penetration test and NOT a security certification.** It is an internal
> engineering review by coordinated Claude Code agents that read the actual source and tests
> and ran the repository's own security tooling. No external audit, third-party attestation,
> or formal certification has been performed. Claims below are grounded in file evidence and
> tool output; deferred items are stated as deferred.

## Purpose

Report which security controls **exist and are verified** in v0.1, which are **deferred** (and
to when), and the honest boundaries of that assessment — so the Developer Preview scope
freeze (M19.2) and release gate (M19.8) can rely on an accurate picture.

## Security tooling

All runnable from the repo root; all currently pass or report clean:

| Command                         | Tool                                            | Result                                                                             |
| ------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm audit`                    | pnpm advisory database                          | **0 vulnerabilities** across 215 deps (11 prod / 204 dev / 52 optional)            |
| `pnpm run scan:secrets`         | `tools/security/scan-secrets.mjs`               | **Clean** — no unallowlisted secrets                                               |
| `pnpm run sbom`                 | `tools/security/gen-sbom.mjs`                   | Writes `docs/security/sbom.cdx.json` (CycloneDX 1.5, 32 components), deterministic |
| provider signature verification | `packages/provider-sdk/src/{signing,loader}.ts` | Fail-closed, verified 4 ways (M19.1 audit)                                         |

The secret scanner is token-scoped and fails (exit 1) on any finding not covered by its
reviewed baseline. The only committed key material is the ed25519 **TEST** keys used by the
provider-signing tests (`providers/*/keys/*-test-*.pem`,
`packages/provider-sdk/test/fixtures/keys/test-only*.pem`); five additional "secret" matches
are documented fixtures/false-positives in the scanner's baseline (e.g. AWS's published
example key `AKIA…EXAMPLE`, a deliberate fake `ghp_` token that the AI-review test verifies
gets flagged, and namespaced resource identifiers that resemble `token:`/`secret:`
assignments). No real credentials are committed.

## Controls that exist and are verified

Grounded in the M19.1 implementation audit (`pnpm verify` → PASS: build, lint, 1213 unit
tests, 65 spec/conformance, 45 provider-conformance, 29 determinism, all evaluation cases)
and re-checked against the source for this review.

1. **Provider-plugin signature verification (real, fail-closed).** ed25519 manifest signing +
   `sha256:` artifact digests (`signing.ts`) behind a 7-stage fail-closed loader (`loader.ts`):
   any signature, integrity, allowlist, compat, schema, or coverage failure refuses the whole
   package — no degraded load. Verified valid-loads / empty-trust-store-refuses /
   wrong-key-fails / tampered-artifact-fails.
2. **Read-only MCP boundary.** Registry is authoring/analysis only; `assertReadOnly`
   (`packages/mcp-server/src/tools.ts`) rejects any non-read-only tool kind or mutation-verb
   tool name at build/test time. The stdio transport writes only protocol bytes to stdout,
   logs to stderr (`transport.ts`).
3. **Transactional authoring gate.** structural → resolve → copy-on-write dry-run → full
   pipeline → confirmation/destructive gate → commit + per-field provenance; AI output never
   reaches execution (SECURITY.md invariant 2).
4. **Adapter middleware for BYO LLMs.** residency allowlist, redaction hooks, integer
   token/cost limits, and bounded structured-output repair — all fail closed
   (`packages/intent-compiler/src/adapter.ts`).
5. **Signed plans with no embedded secrets.** ed25519-signed envelope over hashed content;
   `verifyPlan` recomputes identities and refuses on mismatch/expiry
   (`packages/planner/src/envelope.ts`); plan content carries attribute names only, never
   values (`plan.ts`).
6. **0-vulnerability dependency graph + tiny runtime surface** (`yaml`, `ajv`,
   `vscode-languageserver`); pinned `pnpm-lock.yaml`; zero-dependency bundled CLI.
7. **Clean secret scan** and a **deterministic CycloneDX SBOM**.

## What is deferred (and to when)

| Control                                                                      | Status                                         | Target                     |
| ---------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------- |
| Real cloud execution, deployment credentials, OIDC, restricted IAM           | Not built (no execution surface in v0.1)       | v0.2 / M19.3               |
| Durable, genuinely encrypted state backend                                   | Not built; v0.1 is plaintext in-memory         | v0.2                       |
| Correcting the misleading `encryptionAtRest: true` flag over plaintext state | Open (documented)                              | before durable state ships |
| Public playground hardening (no creds, no deploy, no plaintext secrets)      | Pre-registered constraints only; not built     | M19.5                      |
| Package-publishing signing / build provenance; signed release checksums      | Deferred                                       | M19.8                      |
| Container image scanning                                                     | Not applicable — no container images exist yet | when containers land       |
| Central audit-record / log-redaction subsystem                               | Not built                                      | v0.2 (roadmap §9.4)        |

## Honest boundaries of this assessment

- It reasons about the code **as written** and the tooling output as run; it does not exercise
  a live deployment (there is none) or a hosted service (there is none).
- The deterministic in-tree path is what was reviewed. Guarantees that depend on a BYO
  out-of-tree LLM adapter hold only when the operator applies the sanctioned middleware.
- Provider-package and plan trust reduce to **operator management of the trust store and
  allowlist**; key distribution/rotation is out of scope for v0.1.
- The `RELEASE_READINESS.yaml` class distribution and the M19.1 audit's honesty gaps
  (roadmap labels vs. shipped end-to-end capability) are the authoritative capability picture;
  this report does not restate them beyond the security-relevant items above.

## Readiness conclusion

For a **plan-preview** Developer Preview, the security-relevant controls are present and
verified, and the attack surface is small by construction (no execution, no cloud credentials,
no in-tree LLM, no hosted service). The gating security work before any release that performs
real deployment is the **v0.2 execution boundary** (credentials/OIDC/IAM), a **durable
encrypted state backend** (and removing the misleading capability flag), and
**package-publishing provenance** (M19.8). See [`known-risks.yaml`](../security/known-risks.yaml)
for the itemized register.
