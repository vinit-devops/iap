# IaP Developer Preview v0.1 — Demo

A self-contained demonstration of the **IaP plan-preview workflow** using **only the packaged
`iap` CLI** — no monorepo source paths. It takes a natural-language requirement to a validated
`infrastructure.iap.yaml`, derives architecture / cost / security / compliance, and produces a
deterministic, signed **AWS plan preview**.

> v0.1 is plan-and-analyze only. It does **not** deploy to AWS, maintain state, or detect drift
> — those arrive in the v0.2 Private Deployment Preview (milestone M19.3). See
> [`../../docs/reports/developer-preview-scope.md`](../../docs/reports/developer-preview-scope.md).

## Install the CLI (packaged, standalone)

The `iap` CLI is a self-contained, zero-dependency package. From this repo:

```bash
pnpm run build:cli-pkg          # builds dist-pkg/cli (a standalone package)
npm pack ./dist-pkg/cli             # -> iap-cli-0.1.0.tgz (package @infraasprompt/cli)
npm install -g ./iap-cli-0.1.0.tgz  # or: npm install ./iap-cli-0.1.0.tgz in your project
iap --version                   # iap 0.1.0
```

(An external user installs the published tarball; nothing here depends on the workspace.)

## The workflow (run from this directory)

```bash
# 1. Author from natural language (rules-based; deterministic with a pinned timestamp)
iap create "$(cat request.txt)" --timestamp 2026-07-12T00:00:00Z
#    -> writes infrastructure.iap.yaml (an internal Service + a managed Database)

# 2. Validate (schema + reference + relationship + dependency + policy)
iap validate -f infrastructure.iap.yaml

# 3. Analyze
iap cost       -f infrastructure.iap.yaml --output json
iap security   -f infrastructure.iap.yaml --output json
iap compliance -f infrastructure.iap.yaml --output json
iap diagram    -f infrastructure.iap.yaml --view architecture

# 4. Deterministic AWS plan preview (bare provider mapping artifact; run twice → identical planId)
iap plan -f infrastructure.iap.yaml --mapping aws-core.iap-map.yaml --output json
```

The plan's `planId` is a byte-stable `sha256:…` content hash — re-running yields the identical
id. `iap plan` imports no execution machinery; it produces artifacts only.

## Notes

- **Natural-language authoring is rules-based** in v0.1. Model-driven authoring is available by
  supplying a `ModelAdapter` (out-of-tree); it is not bundled.
- The AWS mapping fail-closes on unsupported intent (e.g. a `Service` with `exposure: public` —
  in AWS, public ingress must go through a `Gateway`). That is correct, honest behavior: nothing
  outside the coverage matrix is silently dropped.
- `aws-core.iap-map.yaml` here is a copy of the AWS provider's mapping artifact, shipped so the
  demo needs no workspace paths.

An automated end-to-end run of exactly this flow against the packaged tarball lives at
`tools/packaging/demo-e2e.mjs` (`pnpm run smoke:demo`).
