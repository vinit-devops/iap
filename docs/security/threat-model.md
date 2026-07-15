# IaP Threat Model (Phase 19, M19.6)

**Date:** 2026-07-12 · **Scope:** IaP v0.1 (Developer Preview — plan-preview only) ·
**Method:** internal engineering review by coordinated Claude Code agents reading the actual
source and tests.

> This is an **internal engineering review**, not an external penetration test, third-party
> security audit, or certification. It reasons about the code as written. Claims are grounded
> in file evidence; where a control is deferred, that is stated plainly.

## What IaP is (and is not) in v0.1

IaP v0.1 authors, validates, analyzes, and maps IaP documents to AWS/Kubernetes resource
_intents_, then produces a **deterministic, ed25519-signed plan preview**. It has:

- **No real cloud execution.** There is no `@aws-sdk`/`aws-sdk` (or any cloud SDK), no
  network code, and no credential handling anywhere in the tree. Providers under
  `providers/aws` and `providers/kubernetes` are mapping-only; the only substrate that
  "applies" objects is `@iap/provider-mock`, entirely in memory.
- **No in-tree LLM.** In-tree authoring (`@iap/intent-compiler`) and AI review
  (`@iap/ai-review`) are **deterministic rule engines**. The LLM is a vendor-neutral
  out-of-tree `ModelAdapter` contract; in-tree there is only a fixture-replay adapter and the
  rules extractor.
- **No hosted control plane / service, and no public playground yet** (the playground is
  M19.5, pre-registered in §10 below).

These absences shrink the v0.1 attack surface dramatically: the most dangerous surfaces in an
infrastructure tool — live cloud credentials, execution, a hosted multi-tenant service — do
not exist yet. They are the substance of v0.2 and are flagged throughout as deferred.

## Trust boundaries

1. **Author → deterministic pipeline.** Any natural-language or document input crosses into
   the transactional intent-compiler gate. AI output is never trusted directly; it is
   validated and gated before it can become a document (SECURITY.md invariant 2).
2. **AI assistant (MCP) → engines.** An assistant drives IaP over a read-only MCP tool
   registry. The boundary is structural: no mutation/deployment tool exists.
3. **Provider package → loader.** A third-party provider plugin crosses a 7-stage
   fail-closed loader (signature + integrity + allowlist + coverage) before any mapping is
   trusted.
4. **Plan producer → plan consumer.** A plan is an ed25519-signed envelope over hashed
   content; a consumer verifies the signature and recomputes identities before trust.
5. **(Deferred, v0.2) Pipeline → real cloud.** Does not exist in v0.1. This is the central
   future boundary — deployment credentials, OIDC, IAM scoping.

---

## STRIDE review by component

Each entry: **Threat → Current mitigation (file evidence) → Residual risk.** Residual risks
that have a register entry are cross-referenced as `RISK-00x` (see
[`known-risks.yaml`](known-risks.yaml)).

### 1. Intent Compiler (authoring gate)

- **Threat (Tampering / Elevation):** AI- or NL-derived intent reaches execution or mutates
  the model without deterministic validation, or authoring commits a partial/inconsistent
  document.
- **Mitigation:** Authoring commits only through a transactional gate — structural check →
  resolve → copy-on-write dry-run → full validation pipeline → confirmation/destructive gate →
  commit with per-field provenance. In-tree extraction is deterministic
  (`packages/intent-compiler/src/extract-rules.js`); the MCP `iap_author` handler returns a
  committed document only when the gate fully commits
  (`packages/mcp-server/src/tools.ts:108-129`). Standing invariant 2 ("AI is never in the
  execution path", `SECURITY.md`) is normative.
- **Residual risk:** The gate's guarantees hold for the in-tree deterministic path. When a
  BYO out-of-tree adapter is supplied, the guarantees depend on the middleware being applied
  (see §2). Low for v0.1.

### 2. Prompt injection (BYO out-of-tree LLM adapter only)

- **Threat (Tampering / Information disclosure):** A malicious NL request or injected content
  steers an LLM adapter to emit unsafe intent, leak the request, or exceed cost/token budgets.
- **Applicability:** In-tree authoring is a **deterministic rules engine**, so prompt
  injection is **not a v0.1 in-tree risk**. It becomes a risk only when an operator supplies
  an out-of-tree `ModelAdapter`.
- **Mitigation:** The `runAdapter` middleware is the sanctioned (and only) way to drive an
  adapter (`packages/intent-compiler/src/adapter.ts`). It enforces, before/around any adapter
  call: caller-registered **redaction** hooks that scrub the request before any adapter sees
  it; a **data-residency** allowlist that refuses non-conforming adapters before invocation;
  integer **token/cost limits** that fail closed when configured limits lack counts; and
  **bounded structured-output repair** — invalid output is re-validated (never auto-accepted)
  at most `maxAttempts` times, then refuses. Every adapter return is still validated and
  passed through the gate regardless (§1).
- **Residual risk:** IaP cannot constrain what a third-party model does internally; it can
  only bound, redact, and validate at the boundary. An operator who disables the middleware or
  supplies a non-conforming adapter defeats these controls. Tracked as `RISK-004`.

### 3. MCP content injection / trust boundary

- **Threat (Elevation / Tampering):** An assistant is induced to call a mutation/deployment
  tool, or protocol output is corrupted/injected.
- **Mitigation:** The MCP registry contains **only** authoring/analysis tools; there is no
  deployment, mutation, or provider-API tool. `assertReadOnly`
  (`packages/mcp-server/src/tools.ts:185-199`) is a build- and test-time guard that throws if
  any tool has a non-read-only kind or if any tool name contains a forbidden mutation verb
  (`deploy`, `destroy`, `apply`, `rollback`, `provision`, `mutate`, `delete`, `push`,
  `execute`). The stdio transport writes **only** JSON-RPC protocol bytes to stdout, with all
  logs/diagnostics on stderr, because a stray stdout byte corrupts the frame stream
  (`packages/mcp-server/src/transport.ts:12-13,186-188`; readiness banner to stderr in
  `bin.ts:23`). The assistant therefore structurally cannot deploy or reach a provider.
- **Residual risk:** Tool _results_ are data derived from the user's own document; a
  downstream consumer that treats analysis text as instructions is out of IaP's control. The
  boundary prevents mutation, not misinterpretation of returned content. Low.

### 4. Provider plugins (signing, integrity, loader)

- **Threat (Tampering / Spoofing):** A malicious or tampered provider package injects
  mappings, or an unsigned/wrong-key package is loaded.
- **Mitigation:** ed25519 manifest signing over a single canonical byte form and `sha256:`
  artifact digests (`packages/provider-sdk/src/signing.ts`), consumed by a **7-stage
  fail-closed loader** (`packages/provider-sdk/src/loader.ts`): manifest shape → publisher
  allowlist → signature against the trust store → per-artifact digest over exact file bytes →
  spec/SDK compat → mapping-artifact schema → static coverage tiling. **Any** failure refuses
  the whole package (no degraded load, IEP-0012 PC-1). Verification is fail-closed on unknown
  key ids, non-ed25519 algorithms, unparseable keys, and invalid signatures
  (`signing.ts:66-98`); artifact paths are rejected if they escape the package directory
  (`loader.ts:77-84`). Verified four ways in the M19.1 audit (valid key loads; empty trust
  store refuses everything; wrong key → signature failure; tampered artifact → integrity
  failure).
- **Residual risk:** Trust reduces to trust-store and allowlist management by the operator: an
  attacker who can add a key to the trust store and a name to the allowlist can sign a
  malicious package. Key distribution/rotation and publisher-side release provenance are
  deferred to M19.8. Tracked as `RISK-007`.

### 5. State

- **Threat (Information disclosure / Tampering):** Sensitive values persist in state, or state
  is mutated concurrently/inconsistently.
- **Mitigation:** State is **in-memory only** in v0.1 (`LocalStateBackend`, a plaintext
  `Map`, `packages/state/src/local.ts:47`). Writes are CAS on a monotonic revision under a
  lease-based lock that fails closed while a live lease is held; the object store is
  integrity-hashed and history is append-only; force-unlock is audited and human-only
  (`packages/state/src/local.ts`, `types.ts`). No durable or remote backend exists.
- **Residual risk (called out):** The backend advertises `encryptionAtRest: true`
  (`packages/state/src/local.ts:52`) over a **plaintext in-memory `Map`** — the capability
  flag is **misleading**: there is no encryption. In v0.1 nothing persists across process
  exit, so exposure is limited to process memory, but the flag must not be read as a security
  guarantee. A durable, genuinely encrypted backend is a v0.2 requirement. Tracked as
  `RISK-001`.

### 6. Plans

- **Threat (Tampering / Information disclosure):** A plan is altered after signing, replayed
  after inputs change, or embeds secret values.
- **Mitigation:** A plan carries an ed25519-signed envelope
  (`packages/planner/src/envelope.ts`). `planId` is the SHA-256 of the canonical content
  serialization, and the signature binds the envelope timestamps to the exact content bytes;
  `verifyPlan` recomputes all nine determinism-input identities and refuses on any mismatch,
  an advanced state revision, expiry, or a missing/failed signature (closed refusal taxonomy;
  the remedy is always re-planning, never patching). Plan content **carries attribute names
  only, never values**: unresolved attributes are marked _unknown_ and provider-declared
  sensitive attributes are additionally flagged for reviewers
  (`packages/planner/src/plan.ts:44-50,302-303`). The planner has no dependency on secret
  material. A dedicated test fixture asserts a raw secret never appears in a plan
  (`packages/planner/test/plan.test.ts`).
- **Residual risk:** Signature trust again reduces to trust-store management. Determinism of
  `planId` is proven by a golden-byte + perturbed-environment + key-shuffle harness (29/29 in
  the audit). Low.

### 7. Deployment credentials + OIDC

- **Threat (Spoofing / Elevation / Information disclosure):** Long-lived cloud credentials are
  captured, over-scoped, or leaked; deployment runs without short-lived/OIDC identity.
- **Applicability:** **Not applicable in v0.1** — there is no execution, no network, and no
  credential handling anywhere in the tree (M19.1 audit). Nothing to steal because nothing
  authenticates to a cloud.
- **Mitigation (design intent for v0.2):** SECURITY.md and roadmap §9.4 require short-lived
  credentials / OIDC, restricted IAM, sandbox-account isolation, cost budgets, and mandatory
  tags for the future execution path (roadmap-v2 §9). Standing invariant 1 forbids plaintext
  credentials in any document, state, plan, or telemetry.
- **Residual risk:** This is **the central v0.2 concern**. When real execution lands, the
  credential/OIDC/IAM boundary becomes the highest-value target and must be designed and
  reviewed before any live deployment. Tracked as `RISK-002` (deferred).

### 8. Logs

- **Threat (Information disclosure):** Sensitive values leak into logs or protocol output.
- **Mitigation:** Standing invariant 1 forbids secret values in telemetry. The MCP transport
  keeps protocol bytes on stdout and diagnostics on stderr
  (`packages/mcp-server/src/transport.ts:12-13`); documents and plans carry intent and
  attribute names, never secret values (§6). The adapter middleware redacts requests before
  any adapter/log path (§2).
- **Residual risk:** There is no central structured-logging/audit subsystem in v0.1; log
  hygiene depends on components not printing user input verbatim. A dedicated audit-record and
  log-redaction layer is a v0.2 concern (roadmap §9.4). Low for v0.1 given no execution and no
  persisted state. Tracked as `RISK-008`.

### 9. Playground (not yet built — pre-registered constraints)

- **Status:** The public planning playground is **M19.5 and not yet built**. Its constraints
  are pre-registered here so they are review obligations before it ships.
- **Pre-registered constraints (roadmap-v2 §11):** the playground must **not** receive AWS
  credentials, must **not** deploy resources, must **not** store plaintext secrets, must
  **not** claim exact costs, and must **not** claim formal compliance certification. It offers
  NL → clarification → IaP generation → validate/architecture/deps/cost/security/compliance →
  AWS plan preview → provenance → IaP download → shareable read-only result.
- **Residual risk:** As a future hosted, internet-facing surface it introduces
  multi-tenant/DoS/input-abuse threats that do not exist in the local CLI today. It must be
  threat-modeled again when built. Tracked as `RISK-006` (pre-registered).

### 10. Visual Designer

- **Threat (Tampering / Elevation):** A UI edit bypasses validation and produces an unsafe
  model.
- **Mitigation:** The designer is a **local** shell (headless model library in v0.1, no
  hosted surface). All edits go through the same transactional authoring gate as every other
  authoring path (§1); UI naming must never change the Canonical Infrastructure Model
  (roadmap-v2 Visual Designer section). No credentials, no deployment.
- **Residual risk:** Low in v0.1 (local, no UI, gate-mediated). Re-review when a real UI or
  hosted designer ships.

### 11. Supply chain

- **Threat (Tampering / Spoofing):** A compromised dependency, tampered lockfile, or
  unverified provider package injects code or mappings.
- **Mitigation:** Tiny runtime dependency surface — `yaml`, `ajv`,
  `vscode-languageserver`(+textdocument); `pnpm audit` reports **0 vulnerabilities** across
  215 deps (11 prod / 204 dev / 52 optional). A pinned `pnpm-lock.yaml` fixes resolved
  versions. The distributable CLI is built zero-dependency (`tools/packaging/build-cli.mjs`).
  Provider packages are ed25519-signed and digest-pinned (§4). A CycloneDX 1.5 SBOM
  (`docs/security/sbom.cdx.json`, 32 components) is generated deterministically by
  `pnpm run sbom` (`tools/security/gen-sbom.mjs`). A token-scoped secret scanner
  (`pnpm run scan:secrets`, `tools/security/scan-secrets.mjs`) runs clean.
- **Residual risk:** Package-publishing **signing and build provenance** (npm provenance /
  signed release artifacts) are deferred to M19.8. Signed checksums for released artifacts are
  not yet produced. Tracked as `RISK-009` (deferred). Container scanning is N/A — there are no
  container images yet.

---

## Summary

The v0.1 attack surface is small by construction: no execution, no cloud credentials, no
in-tree LLM, no hosted service. The controls that matter for a plan-preview tool — a
fail-closed provider loader with real ed25519 signing/integrity, a structurally read-only MCP
boundary, a transactional authoring gate, signed plans that embed no secret values, a
0-vulnerability dependency graph, a clean secret scan, and a deterministic SBOM — are
implemented and verified. The top residual risks are (1) the **misleading `encryptionAtRest`
flag** over plaintext state (`RISK-001`) and (2) the **entire deployment-credential/OIDC
surface deferred to v0.2** (`RISK-002`), which will be the highest-value target the moment
real execution lands.
