# IaP Developer Preview v0.1 — Packaging (Phase 19, M19.4)

**Date:** 2026-07-12 · **Scope:** v0.1 plan-preview (real AWS deploy deferred to v0.2/M19.3).
Every artifact is verified by a runnable smoke test; nothing was published to a registry.

## Artifacts

| #   | Artifact                      | What was built                                                                                                                                                                                                                                                                                                                                                                            | Smoke                                                                                                |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | **Installable `iap` CLI**     | The 10 `@iap/* workspace:*` deps blocked external install. Fixed by bundling `packages/cli/src/cli.ts` into a **zero-dependency** self-contained ESM binary (esbuild) + staged runtime assets (8 schemas, 2 prompts, error-code registry, cost snapshot). Ships as `dist-pkg/cli/`.                                                                                                       | `pnpm smoke:cli` — clean `mktemp` install → `iap --version/init/validate/plan`, deterministic planId |
| 2   | **MCP server (stdio)**        | Built the missing wire transport: a hand-rolled MCP JSON-RPC 2.0 over stdio + `bin` (`iap-mcp-server`). (Originally shipped with LSP-style `Content-Length` framing; since corrected to the spec-required newline-delimited JSON — see the MCP stdio transport, protocol 2025-06-18.) `initialize`/`tools/list`/`tools/call` over the real read-only tools; read-only boundary preserved. | `packages/mcp-server` tests (25) incl. a spawned-child stdio test                                    |
| 3   | **VS Code `.vsix`**           | New `extensions/vscode/`: registers the `iap` language (`.iap.yaml`/`.iap-map.yaml`), launches the `iap-language-server` over LSP, commands (restart, preview). `.vsix` assembled by hand (OPC zip; no vsce, offline). `vscode-languageclient` require is guarded so the extension degrades gracefully.                                                                                   | `pnpm smoke:vsix` — valid archive, manifest declares the language                                    |
| 4   | **Runnable Designer shell**   | New `apps/designer/` (`iap-designer` bin): a `node:http` local web shell over the headless `DesignerSession`. The browser holds no authoring logic — every canvas edit POSTs an action that commits through the compiler **gate** server-side, then the doc is re-validated.                                                                                                              | `pnpm smoke:designer` — 15/15; add Service+Database, connect, valid IaP                              |
| 5   | **Clean-machine smoke tests** | `tools/packaging/smoke-cli.mjs` (init path) + `tools/packaging/demo-e2e.mjs` (NL path), both install the packed tarball into a fresh temp project outside the repo.                                                                                                                                                                                                                       | wired as `smoke:cli` / `smoke:demo`                                                                  |
| 6   | **Demo repo**                 | `examples/iap-demo/` — README + NL `request.txt` + a bare AWS mapping. Uses packaged artifacts only.                                                                                                                                                                                                                                                                                      | covered by `smoke:demo`                                                                              |

## The release gate (M19.4 → M19.5) — MET

`pnpm run smoke:demo` proves an **external clean environment** can, using only packaged
artifacts (no monorepo source paths):

1. install the `iap` tarball into an empty project,
2. author a valid `infrastructure.iap.yaml` **from a natural-language request** (`iap create`),
3. `iap validate`, then `iap cost` / `security` / `compliance` / `diagram`,
4. produce a **deterministic AWS plan preview** — `planId sha256:ff21f7f9…`, identical across two runs.

Full `pnpm verify` is green (1226 tests, 65 conformance, 45 provider, 29 determinism,
`check:names`), and `pnpm format:check` + `eslint .` pass across the new `apps/`/`extensions/`.

## Honest packaging limitations (v0.1)

- **CLI package name** is `iap` (placeholder); confirm the final published name before release.
- **No registry publish** was performed (out of scope; nothing is public).
- **VS Code extension**: full LSP features require the host to have `vscode-languageclient`
  available to the extension (bundle it into the `.vsix` when registry access exists) and the
  `iap-language-server` bin resolvable; absent those, only language registration works.
- **Designer / MCP** are runnable locally but are not hosted services.
- **Container images / signed release checksums** (roadmap §10) are not built in v0.1 — deferred
  to the release milestone (M19.8) where signing/SBOM (M19.6) also land.
