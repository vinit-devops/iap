# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report suspected vulnerabilities privately to the maintainer:

- Contact: _security contact to be established — until then, reach the maintainer directly through a private channel_ <!-- TODO: replace with security@… or GitHub private vulnerability reporting once the repo is hosted -->

Include: a description of the issue, affected files or packages, reproduction steps, and impact assessment if known. You will receive an acknowledgment, and coordinated disclosure timing will be agreed before any public discussion.

## Scope

This policy covers:

- The specification itself (`spec/chapters/`) — e.g. a normative requirement that, if implemented as written, produces an insecure system.
- The JSON Schemas (`spec/schema/`) — e.g. a schema gap that admits documents the prose forbids.
- Examples and conformance cases (`spec/examples/`, `spec/conformance/`) — e.g. an official example demonstrating an insecure pattern.
- Implementation packages under `packages/`, `providers/`, `extensions/`, and `apps/` as they land.

## Standing security invariants

These invariants are normative for the specification and for every implementation in this repository. A violation of any of them is a security bug, not a design discussion:

1. **No plaintext credentials, anywhere.** Secret values never appear in IaP documents, state, plans, or telemetry — documents carry only secret _intent_ (source and rotation), and outputs are handles, never values. Validators reject secret material in documents with error IAP602. (Spec Chapter 15, §15.5; roadmap §9.4.)
2. **AI is never in the execution path.** AI may author, explain, and suggest; it must never execute infrastructure changes, produce provider plans, resolve mappings, or mutate model/state. A pipeline that lets AI output reach execution without the full deterministic validation pipeline is non-conformant. (Spec Chapter 19, §19.3; roadmap §5.3.)
3. **Mappings fail closed.** Unmapped or unsupported intent is a hard error, never a silent downgrade, inference, or dropped field. Planning and deployment stop when required intent is unresolved, a mapping is incomplete, policy fails, or a mapping would weaken declared intent. (Spec Chapter 12, §12.3; roadmap §5.5.)

Additional engineering requirements (short-lived credentials/OIDC, sensitive-response redaction, signed releases, SBOM, dependency pinning, plugin allowlists, audit records) are defined in roadmap §9.4 and apply to every implementation phase.

## Tooling

Security tooling runs from the repository root and is part of the standard checks:

- `pnpm run scan:secrets` — token-scoped secret scan of the working tree (`tools/security/scan-secrets.mjs`); fails on any finding not in its reviewed baseline. Currently clean.
- `pnpm run sbom` — deterministic CycloneDX 1.5 SBOM (`tools/security/gen-sbom.mjs`) written to `docs/security/sbom.cdx.json`.
- `pnpm audit` — dependency vulnerability scan; currently reports 0 vulnerabilities.
- **Provider-plugin signature verification** — ed25519 manifest signing + `sha256:` artifact digests behind a 7-stage fail-closed loader (`packages/provider-sdk/src/signing.ts`, `packages/provider-sdk/src/loader.ts`).

See the [threat model](docs/security/threat-model.md), the [security-readiness report](docs/reports/security-readiness.md), and the machine-readable [known-risk register](docs/security/known-risks.yaml). These are an internal engineering review, not an external penetration test or certification.

## Supported versions

The specification is at 1.0.0 (Draft); no packages have been released. Security fixes target the current draft. A supported-versions table will be maintained here once releases begin.
