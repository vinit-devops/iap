# M20.6 manual checklist — GUI client verification (user-applied)

Machine-safety rule for this milestone: no automated process modified any GUI app
config. The ready-to-paste entries live in `staged-configs/` in TWO variants each:

- `*.LOCAL-NOW.json` — works today: runs the built local server via
  `node /Users/vinitkumar/iap/dist-pkg/mcp-server/dist/iap-mcp-server.js`.
- `*.POST-PUBLISH.json` — for after `@iap/mcp-server` is published to npm:
  `npx -y @iap/mcp-server`. Will NOT connect until publish.

General merge rule for every app below: the staged file contains one entry under
`mcpServers` named `"iap"`. If your config file already exists, add ONLY the
`"iap"` object inside your existing `"mcpServers"` map — do not replace the file,
so existing servers are preserved. If the file does not exist, you can paste the
staged file as-is.

Apps verified PRESENT in /Applications on this machine (2026-07-15): Cursor.app,
Windsurf.app, Claude.app (Claude Desktop). Visual Studio Code: NOT installed.

---

## Cursor

- Config file: `~/.cursor/mcp.json` (global) — or per-project `.cursor/mcp.json`.
- Staged entry: `staged-configs/cursor-mcp.LOCAL-NOW.json` (or `.POST-PUBLISH.json` later).
- Merge: open `~/.cursor/mcp.json`; inside `"mcpServers"`, add the `"iap"` object.
  Alternatively use Cursor Settings → MCP → "Add new MCP server".
- 2-minute verification:
  1. Fully quit and relaunch Cursor.
  2. Cursor Settings → MCP: the `iap` server should show a green/enabled state and
     list 5 tools (iap_author, iap_validate, iap_cost, iap_security, iap_compliance).
  3. In chat (Agent mode), ask: "Use the iap_validate tool to validate this document"
     and paste the contents of `spec/examples/basic-webapp.iap.yaml`.
     Expected tool result: `{"ok":true,"findings":[]}`.
- Remove: delete the `"iap"` entry from `"mcpServers"` in `~/.cursor/mcp.json`,
  relaunch Cursor.

## Windsurf

- Config file: `~/.codeium/windsurf/mcp_config.json`.
- Staged entry: `staged-configs/windsurf-mcp_config.LOCAL-NOW.json` (or `.POST-PUBLISH.json`).
- Merge: add the `"iap"` object inside the existing `"mcpServers"` map. Alternatively
  Windsurf → Cascade panel → MCP servers (hammer/plugins icon) → Configure.
- 2-minute verification:
  1. Fully quit and relaunch Windsurf (or press the MCP "Refresh" button in Cascade).
  2. Cascade → MCP servers: `iap` shows as available with 5 tools.
  3. Ask Cascade: "List the iap MCP tools you have" — expect exactly the 5 iap_* tools;
     then run an iap_validate call on `spec/examples/basic-webapp.iap.yaml`
     (expected: `{"ok":true,"findings":[]}`).
- Remove: delete the `"iap"` entry from `~/.codeium/windsurf/mcp_config.json`, refresh.

## Claude Desktop

- Config file: `~/Library/Application Support/Claude/claude_desktop_config.json`.
  (Also reachable via Claude Desktop → Settings → Developer → Edit Config.)
- Staged entry: `staged-configs/claude_desktop_config.LOCAL-NOW.json` (or `.POST-PUBLISH.json`).
- Merge: add the `"iap"` object inside the existing `"mcpServers"` map (create the map
  if the file has none).
- 2-minute verification:
  1. Fully quit Claude Desktop (Cmd+Q — closing the window is not enough) and relaunch.
  2. In a new chat, open the tools / connectors ("search and tools") icon: `iap` should
     be listed with 5 tools.
  3. Ask: "Use iap_author to author: a small web application — an HTTPS gateway in front
     of a stateless web service running container image registry.example.com/shop/web:1.4.2,
     backed by a Postgres database." Expected: outcome `committed` with a per-field
     provenance list (every entry `"source":"explicit-user"`).
- Remove: delete the `"iap"` entry from `claude_desktop_config.json`, relaunch.

## VS Code — N/A on this machine (not installed)

- Verified 2026-07-15: no `code` CLI on PATH and no `/Applications/Visual Studio Code.app`.
- Pre-publish proof that exists instead: the offline extension gate
  `corepack pnpm run smoke:vsix` (builds the VSIX from `extensions/vscode/` and runs
  its smoke test) is part of the repo's gates.
- Post-publish manual verification (on a machine with VS Code):
  1. Extension path: install the built VSIX (`code --install-extension <iap>.vsix`),
     open a `*.iap.yaml` file, confirm diagnostics/LSP features activate.
  2. Native MCP path (VS Code 1.102+): add the `"iap"` server to `mcp.json` via
     "MCP: Open User Configuration" (same `command`/`args` as the staged configs,
     under VS Code's `"servers"` key), then in Copilot Chat (Agent mode) → tools:
     confirm the 5 iap_* tools and run one iap_validate call.

---

## Record your results

After running each app's steps, update the corresponding row in
`interop-matrix.md` from STAGED-pending-manual to PASS-manual (or record the failure).
