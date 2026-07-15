# M20.6 real-client interop matrix

Date: 2026-07-15. Server under test: built `@infraasprompt/mcp-server` 0.1.0 at
`dist-pkg/mcp-server/dist/iap-mcp-server.js` (newline-delimited JSON-RPC over stdio).
Nothing is published to npm; no GUI app config on this machine was modified
(staged configs + `manual-checklist.md` are provided for the user to apply).

Cell legend:
- **PASS-local** — proven on this machine, evidence file linked.
- **STAGED-pending-manual** — ready-to-paste config + checklist provided; requires the
  user to apply it in the GUI app (automation is forbidden by the machine-safety rule).
- **PENDING-publish** — blocked only on `npm publish @infraasprompt/mcp-server` (the committed
  integration intentionally references `npx -y @infraasprompt/mcp-server`).
- **N/A-not-installed** — client not present on this machine.

| Client | initialize | tools/list (5, read-only) | iap_author call | analysis call | install path proven |
|---|---|---|---|---|---|
| Claude Code (MCP direct) | PASS-local — [claude-code-mcp-add-connected.md](claude-code-mcp-add-connected.md), [raw-jsonrpc-initialize-tools-list.json](raw-jsonrpc-initialize-tools-list.json) | PASS-local — [trust-boundary-tools-list.md](trust-boundary-tools-list.md) | PASS-local — [claude-code-real-sessions.md](claude-code-real-sessions.md), [claude-code-session-author-committed.stream.jsonl](claude-code-session-author-committed.stream.jsonl) | PASS-local (iap_validate) — [claude-code-real-sessions.md](claude-code-real-sessions.md), [claude-code-session-validate.stream.jsonl](claude-code-session-validate.stream.jsonl) | PASS-local — `claude mcp add` → "✔ Connected" ([claude-code-mcp-add-connected.md](claude-code-mcp-add-connected.md)) |
| Claude Code (plugin) | PENDING-publish — bundled server is `npx -y @infraasprompt/mcp-server` (unpublished): "✘ Failed to connect" ([claude-code-plugin-install.md](claude-code-plugin-install.md)) | PENDING-publish (same reason; identical binary passes locally per row above) | PENDING-publish | PENDING-publish | PASS-local — marketplace add + install + list + details (5 commands) ([claude-code-plugin-install.md](claude-code-plugin-install.md)) |
| Claude Desktop | STAGED-pending-manual — [staged-configs/claude_desktop_config.LOCAL-NOW.json](staged-configs/claude_desktop_config.LOCAL-NOW.json), [manual-checklist.md](manual-checklist.md) | STAGED-pending-manual (same) | STAGED-pending-manual (checklist step 3) | STAGED-pending-manual | STAGED-pending-manual — app present in /Applications; config staged, user applies |
| Cursor | STAGED-pending-manual — [staged-configs/cursor-mcp.LOCAL-NOW.json](staged-configs/cursor-mcp.LOCAL-NOW.json), [manual-checklist.md](manual-checklist.md) | STAGED-pending-manual | STAGED-pending-manual | STAGED-pending-manual (checklist step 3: iap_validate) | STAGED-pending-manual — app present in /Applications; config staged, user applies |
| Windsurf | STAGED-pending-manual — [staged-configs/windsurf-mcp_config.LOCAL-NOW.json](staged-configs/windsurf-mcp_config.LOCAL-NOW.json), [manual-checklist.md](manual-checklist.md) | STAGED-pending-manual (checklist step 3 lists tools) | STAGED-pending-manual | STAGED-pending-manual | STAGED-pending-manual — app present in /Applications; config staged, user applies |
| VS Code (extension/LSP) | N/A-not-installed — no `code` CLI, no /Applications entry; offline `smoke:vsix` gate is the pre-publish proof ([manual-checklist.md](manual-checklist.md) VS Code section) | N/A-not-installed | N/A-not-installed | N/A-not-installed | N/A-not-installed |
| VS Code (native MCP) | N/A-not-installed — post-publish manual steps in [manual-checklist.md](manual-checklist.md) | N/A-not-installed | N/A-not-installed | N/A-not-installed | N/A-not-installed |

## Honest caveats

- The server-side `initialize` and `tools/list` behaviour is proven once, directly
  against the binary ([raw-jsonrpc-initialize-tools-list.json](raw-jsonrpc-initialize-tools-list.json));
  STAGED rows still need each GUI client to be exercised by the user before their cells
  can be called PASS — client-side quirks (schema, restart behaviour) are not proven here.
- Claude Code `-p` sessions used the user's existing login session (read-only) with
  MCP registration kept ephemeral via `--mcp-config`/`--strict-mcp-config`; the user's
  persistent MCP config was verified unchanged afterwards
  ([machine-tidy-verification.md](machine-tidy-verification.md)).
- `claude plugin details` shows "MCP servers (0)" despite the inline `mcpServers`
  declaration loading fine — noted as a display quirk in
  [claude-code-plugin-install.md](claude-code-plugin-install.md).
