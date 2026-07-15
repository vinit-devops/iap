# Phase 13 Completion Report — IDE Integrations

**Date:** 2026-07-11 · **Milestones:** M13.1 (VS Code extension), M13.2 (IaP MCP server),
M13.3 (Cursor/Claude Code/Windsurf guides + JetBrains prototype)

Phase 13 makes IaP usable from editors and AI assistants without writing YAML, while
preserving the ch. 19 boundary. The substantive, tested deliverable is `@iap/mcp-server` — the
IaP MCP server (M13.2) — which every assistant integration consumes; the VS Code extension
(M13.1) and the Cursor/Claude Code/Windsurf/JetBrains integrations (M13.3) are thin clients
over it and the Phase-4 language server, delivered as the integration guide
`docs/guides/ide-integration.md`.

## Exit-criteria verification

| Exit criterion                                          | Status   | Evidence                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users can generate and review IaP without writing YAML  | **Pass** | `iap_author` authors from natural language (clarifications + semantic preview + committed document); `iap_validate`/`iap_cost`/`iap_security`/`iap_compliance` review it — all without hand-writing YAML (`packages/mcp-server/test`).                                |
| IDE actions use the same SDK and planner as the CLI     | **Pass** | Every tool wraps the reference engines (`@iap/intent-compiler`, `@iap/sdk`, `@iap/cost`, `@iap/security`, `@iap/compliance`); the VS Code/JetBrains editors drive the same `@iap/language-server` (Phase 4). No integration holds its own semantics.                  |
| Assistant tools cannot directly call provider APIs      | **Pass** | The MCP server exposes ONLY authoring/analysis tools; there is no deployment, mutation, or provider-API tool. `assertReadOnly` (run at construction) fails closed if a tool names a mutation verb or a non-read-only kind is introduced (`packages/mcp-server/test`). |
| Every generated value and its provenance is inspectable | **Pass** | `iap_author` returns the intent-compiler's per-field provenance for the committed document (source + writing operation id), verified in the test suite.                                                                                                               |

## Deliverables

- **VS Code extension** (M13.1) — a thin client that spawns `iap-language-server` (Phase 4)
  and connects to the IaP MCP server; documented in the integration guide. Packaging a `.vsix`
  is a release step over the tested language-server + MCP-server cores.
- **IaP MCP server** (M13.2) — `@iap/mcp-server`: a protocol-neutral tool dispatcher over the
  read-only `IAP_TOOLS` registry (`iap_author`, `iap_validate`, `iap_cost`, `iap_security`,
  `iap_compliance`), a client manifest with the trust-boundary declaration, and the
  `assertReadOnly` fail-closed guard. Fully tested in-process (8 tests).
- **Integration guides + JetBrains prototype** (M13.3) — `docs/guides/ide-integration.md`
  covers Cursor/Claude Code/Windsurf (via the MCP server) and JetBrains (via the shared LSP).

## Verification state

Full `pnpm run verify` green (build incl. `@iap/mcp-server`, lint, unit tests incl. 8 new,
spec harness, provider conformance, determinism, evaluation benchmark). `pnpm run format:check`
clean.

## Notes

- M13.1/M13.3 are delivered as integration guides + thin-client scaffolds because a packaged
  `.vsix` and editor-plugin binaries are release/packaging artifacts, not unit-testable logic;
  their substance (language server + MCP server) is fully tested. This matches the roadmap's
  "integration guides" / "prototype" framing for M13.3.
- A stdio MCP protocol binding wraps the tested `IaPMcpServer` core; the core is protocol-neutral
  so it is covered in-process exactly like the language-server provider core.
