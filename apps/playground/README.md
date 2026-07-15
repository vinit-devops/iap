# @iap/playground — IaP Planning Playground

A safe, local, **plan-only** web app (roadmap-v2 Phase 19, M19.5). Type a
natural-language request; it is authored into an IaP document and run through
the full plan-preview pipeline, and the result is shown — validation,
architecture, dependencies, cost, security, compliance, and a deterministic AWS
plan preview.

It reuses the existing engines server-side and reimplements none of them:

| Stage        | Engine                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Author       | `@iap/intent-compiler` `runAuthoringSession` (rules-based NL → IaP, deterministic with a pinned timestamp)                     |
| Validate     | `@iap/sdk` `load()` → `.validate()` + `.policies()`                                                                            |
| Architecture | `@iap/architecture` `deriveView` + `toMermaid`                                                                                 |
| Dependencies | `@iap/graph` `deriveOrdering` + `executionWaves`                                                                               |
| Cost         | `@iap/cost` `estimateCost` (`referenceCostModel` / `referenceSnapshot`)                                                        |
| Security     | `@iap/security` `securityReport`                                                                                               |
| Compliance   | `@iap/compliance` `evaluateCompliance`                                                                                         |
| AWS preview  | `@iap/provider-sdk` `applyMapping` over the bundled AWS mapping → `@iap/planner` `plan()` against `emptySnapshot()` → `planId` |
| Provenance   | the per-field provenance the authoring gate produces                                                                           |

## Guardrails (roadmap-v2 §11)

This app **must not**, and by construction cannot:

- **Accept AWS credentials.** Every request body is scanned; any
  credential/profile/secret-looking key is rejected with `400`. There is no AWS
  SDK anywhere and no dependency on `@iap/deploy-aws`.
- **Deploy anything.** There is no apply/deploy route — only plan preview.
- **Store plaintext secrets.** Request bodies are never written to disk; results
  live in memory for the duration of the response only.
- **Claim exact costs.** Cost output is labelled _"estimate (illustrative
  pricing, not a quote)"_.
- **Claim compliance certification.** Compliance output is labelled
  _"configuration coverage only — not a certification"_.

## Determinism

The authoring clock is injected (a pinned timestamp), and the planner runs
against `emptySnapshot()`, so the same request always yields the same document
and the same `planId`. A plan can be shared as a `#d=<base64 document>` fragment
(or `GET /api/share?d=…`) that reproduces the result read-only.

## Run

```sh
pnpm --filter @iap/playground run build
node apps/playground/dist/server.js            # or: iap-playground
# --port <n> | PORT env | default 5173; binds 127.0.0.1 only
```

Then open http://127.0.0.1:5173.

## API

- `GET  /` — the self-contained single-page UI (inline CSS/JS).
- `POST /api/plan` — body `{ "request": "…" }` or `{ "document": "…yaml…" }` → the plan preview as JSON. Credential-ish keys → `400`.
- `GET  /api/share?d=` — base64 IaP document → the plan preview, reproduced read-only.

## Smoke test

```sh
pnpm smoke:playground        # builds, then runs apps/playground/smoke.mjs
```
