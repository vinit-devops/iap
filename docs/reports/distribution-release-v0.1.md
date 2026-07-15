# IaP Distribution Release v0.1 — Public IDE & Assistant Distribution (Phase 20, M20.6)

**Status:** PARTIALLY RELEASED — npm publish executed 2026-07-15 (approver-directed in-session): `@infraasprompt/cli@0.1.0` + `@infraasprompt/mcp-server@0.1.0` live on public npm. Marketplace/OpenVSX publish and closing sign-off still pending.
**Date:** 2026-07-15.

> Publishing (npm publish, VS Code Marketplace / OpenVSX publish, Claude plugin
> marketplace push) is a **human-approval gate** (roadmap-v3; extends the M19.8
> public-release gate) and additionally requires registry accounts and credentials
> this repo does not hold. This document is the release artifact + gate check;
> the actual publish steps are the user runbook in
> [`distribution-release-runbook.md`](distribution-release-runbook.md) and happen
> only on your word.

## Context

Phase 19 ended with the Developer Preview v0.1 release record
(`docs/reports/developer-preview-v0.1-release.md`): everything buildable, verifiable,
and prepared — nothing published. Phase 20 (roadmap-v3, tracked in `ROADMAP-V3.yml`)
takes the same artifacts to the public distribution boundary: self-contained npm
packages, a publishable VS Code extension, a Claude Code plugin, verbatim MCP client
configs, and real-client interop evidence. This document is the Phase 20 counterpart
of the M19.8 record: it states exactly what is proven, what is staged, and what only
the user can do.

## What ships (distribution surfaces)

- **`@infraasprompt/cli`** (bin `iap`) — self-contained zero-dependency npm package built by
  `tools/packaging/build-cli.mjs` into `dist-pkg/cli`. `npm publish --dry-run` clean.
- **`@infraasprompt/mcp-server`** (bin `iap-mcp-server`) — self-contained zero-dependency npm
  package built by `tools/packaging/build-mcp.mjs` into `dist-pkg/mcp-server`.
  Read-only authoring/analysis tools only (iap_author, iap_validate, iap_cost,
  iap_security, iap_compliance); no deploy/mutation tool exposed. `npm publish --dry-run` clean.
- **VS Code extension** (`extensions/vscode`, publisher `iap`) — self-contained
  `.vsix` (LSP bundled; 13 files, 314 KB via `npx @vscode/vsce package`), targeting
  the VS Code Marketplace and OpenVSX (Cursor/Windsurf).
- **Claude Code plugin** (`.claude-plugin/` + `commands/iap-*.md`) — marketplace +
  plugin manifests validate clean (incl. `--strict`); install from a local path
  proven; the committed form launches `npx -y @infraasprompt/mcp-server` (pending publish).
- **Install documentation** — `docs/guides/ide-integration.md` with verbatim,
  machine-validated configs for VS Code, Cursor, Windsurf, Claude Code, Claude
  Desktop, JetBrains, and the CLI, plus a trust-boundary section.

## Decisions taken (requester-directed, 2026-07-15)

- **License:** Apache-2.0. Root `LICENSE` added; all 30 `package.json` license
  fields swept (`grep -rn "SEE LICENSE" --include=package.json .` → 0 matches).
- **Public identities:** npm `@infraasprompt/cli` (bin `iap`) and `@infraasprompt/mcp-server`
  (bin `iap-mcp-server`); VS Code Marketplace publisher `iap`; OpenVSX namespace
  `iap`; public repo `https://github.com/vinit-devops/iap`.
- **Naming resolution (2026-07-15):** unscoped `iap` on npm is taken by a third
  party (v1.1.1) and the `@iap` scope could not be obtained. npm org
  **`infraasprompt`** was created (owner `vinit-devops`) and the published
  identities renamed to `@infraasprompt/cli` / `@infraasprompt/mcp-server`
  (bins and in-repo `@iap/*` workspace names unchanged).
- **Deferred:** M20.7 (VS Code in-editor assistant panel) deferred by requester
  2026-07-15; standalone language-server npm publish deferred (bundled into the
  extension instead).

## Milestone status (M20.0–M20.7)

| Milestone | Title                                      | Status                  | Evidence                                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M20.0     | Licensing & publish prerequisites          | in-progress (user gate) | `LICENSE`; license-field sweep; identities recorded in `ROADMAP-V3.yml`; account creation + sign-off = user actions (runbook steps 1, 4, 5)                                                                                                                         |
| M20.1     | Self-contained MCP server package          | **completed**           | `tools/packaging/build-mcp.mjs` + `smoke-mcp.mjs`; `pnpm run smoke:mcp` green; clean-cache `npx` handshake green; transport framing fix (below); `verify` now ends `… && pnpm run smoke:cli && pnpm run smoke:mcp`                                                  |
| M20.2     | Publish npm packages (public)              | prepared (⛔ publish)   | `npm publish --dry-run` clean for `dist-pkg/cli` AND `dist-pkg/mcp-server`; `smoke:cli` + `demo-e2e` green; stale root `iap-0.1.0.tgz` removed; actual publish = runbook step 2                                                                                     |
| M20.3     | VS Code Marketplace + OpenVSX publish      | prepared (⛔ publish)   | `npx @vscode/vsce package` → clean `.vsix` (13 files, 314 KB); `smoke:vsix` green; scripts `package:vsce` / `publish:marketplace` / `publish:openvsx` in `extensions/vscode/package.json`; publisher/PAT + publish = runbook steps 4–5                              |
| M20.4     | Claude Code plugin                         | prepared (⛔ publish)   | `.claude-plugin/plugin.json` + `marketplace.json` validate clean (incl. `--strict`); isolated-env install from local path proven (`docs/reports/evidence/m20.6/claude-code-plugin-install.md`); committed form needs `@infraasprompt/mcp-server` on npm (runbook 6) |
| M20.5     | MCP client configs + install docs          | **completed**           | `docs/guides/ide-integration.md` rewritten against the published identities; 7 JSON snippets machine-validated; trust-boundary section; assistant panel honestly marked M20.7-deferred                                                                              |
| M20.6     | Real-client interop + release verification | in-progress (user gate) | `docs/reports/evidence/m20.6/interop-matrix.md` + evidence files; this document; sign-off pending                                                                                                                                                                   |
| M20.7     | VS Code assistant panel (stretch)          | deferred                | Requester decision 2026-07-15                                                                                                                                                                                                                                       |

## The transport-framing bug — why real-client interop testing exists

M20.6's real-client testing caught exactly the class of bug it was designed for.
The MCP server's stdio transport (`packages/mcp-server/src/transport.ts`) originally
used LSP-style `Content-Length` framing. Every in-repo unit test passed against
that framing — the suite spoke the same dialect as the implementation. But the
**MCP spec (2025-06-18) requires newline-delimited JSON** on stdio, and the first
attempt to connect the real Claude Code client failed for precisely that reason.

The fix converted the transport to spec-compliant newline-delimited JSON-RPC.
Post-fix evidence:

- 29 transport unit tests green (`packages/mcp-server/test/transport.test.ts`).
- `pnpm run smoke:mcp` green, including a clean-npm-cache `npx` handshake.
- Isolated `claude mcp add … && claude mcp list` → **"✔ Connected"**
  (`docs/reports/evidence/m20.6/claude-code-mcp-add-connected.md`).

No amount of additional self-referential unit testing would have found this; only
pointing a real, independently implemented client at the server did.

## Interop matrix (summary)

Full matrix with per-cell evidence links:
[`evidence/m20.6/interop-matrix.md`](evidence/m20.6/interop-matrix.md).

| Client                   | Result                  | Meaning                                                                                                                                                                                          |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code (MCP direct) | PASS-local              | Real sessions: `iap_validate` → `{"ok":true,"findings":[]}`; `iap_author` → `committed` with per-field provenance; 5 read-only tools listed; trust boundary held; "✔ Connected"                  |
| Claude Code (plugin)     | **PASS** (post-publish) | GitHub-form install (`claude plugin marketplace add vinit-devops/iap`) + bundled `npx -y @infraasprompt/mcp-server` → ✔ Connected via public npm (`evidence/m20.6/post-publish-verification.md`) |
| Claude Desktop           | STAGED-pending-manual   | App present; ready-to-paste config + checklist staged (`evidence/m20.6/staged-configs/`, `manual-checklist.md`); user applies                                                                    |
| Cursor                   | STAGED-pending-manual   | Same — staged config + checklist; user applies                                                                                                                                                   |
| Windsurf                 | STAGED-pending-manual   | Same — staged config + checklist; user applies                                                                                                                                                   |
| VS Code (ext + MCP)      | N/A-not-installed       | VS Code absent on this machine; offline `smoke:vsix` gate is the pre-publish proof; post-publish manual steps in `manual-checklist.md`                                                           |

No GUI application configuration on this machine was modified; Claude Code testing
used ephemeral/isolated config and the user's persistent config was verified
unchanged (`evidence/m20.6/machine-tidy-verification.md`).

## What is NOT yet true (must be read before sign-off)

- ~~Nothing is published.~~ **npm published 2026-07-15** (both packages, clean-cache verification green). Still true: no Marketplace/OpenVSX listing, no
  public plugin marketplace. Every "published identity" above is a decided name,
  not a live artifact.
- ~~The `@iap` npm scope is unverified.~~ **Resolved 2026-07-15:** scope
  unavailable; renamed to the `@infraasprompt` org (created, owner
  `vinit-devops`) — see the runbook's resolved fallback section.
- **GUI client rows are staged, not proven.** Cursor, Windsurf, and Claude Desktop
  have ready-to-paste configs and checklists but have not been exercised — client-side
  quirks are not ruled out.
- **VS Code is untested on this machine** (not installed). The `.vsix` passes the
  offline smoke gate; live Marketplace install + LSP behaviour needs a machine with
  VS Code.
- **The plugin's committed form fails until publish** — by design it references
  `npx -y @infraasprompt/mcp-server`.
- **The repo is not pushed.** GitHub `vinit-devops/iap` must receive the current
  local commit plus this cycle's uncommitted work before the Claude plugin
  marketplace step can work.
- **M20.7 (assistant panel) is deferred**, and the standalone language-server npm
  package is not being published (it ships inside the `.vsix`).

## ⛔ Publish gate

Publishing awaits approver sign-off (roadmap-v3 human-approval gate; extends the
M19.8 public-release gate). On your go-ahead, execute
[`distribution-release-runbook.md`](distribution-release-runbook.md) in order, then
record the sign-off in `ROADMAP-V3.yml` as shown in the runbook's final step.

**Nothing here is published. Awaiting your go-ahead.**
