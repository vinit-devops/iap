# IaP IDE and Assistant Integration Guide

How to install IaP support in your editor and connect AI assistants to the IaP MCP server.
Every integration reuses the same reference components as the CLI — the language server
(`@iap/language-server`) for editor features and the IaP MCP server (`@infraasprompt/mcp-server`) for
assistant authoring/analysis — so an IDE never has its own semantics, and an assistant never
gains a deployment path (spec ch. 19).

Published identities (v0.1.0, Apache-2.0, repo <https://github.com/vinit-devops/iap>):

| Component | Identity | Install command / binary |
| --- | --- | --- |
| CLI | npm `@infraasprompt/cli` | `npm i -g @infraasprompt/cli` → `iap` |
| MCP server | npm `@infraasprompt/mcp-server` | `npx -y @infraasprompt/mcp-server` → `iap-mcp-server` |
| VS Code extension | Marketplace `infraasprompt.iap-vscode` (publisher `infraasprompt`) | Extensions view → search "IaP" |
| Cursor / VSCodium extension | OpenVSX namespace `iap` | Extensions view → search "IaP" |
| Language server | `@iap/language-server` (bin `iap-language-server`) | not yet published — build from source (see JetBrains) |

## What the MCP server can and cannot do (the trust boundary — read first)

The IaP MCP server (stdio JSON-RPC, MCP protocol `2025-06-18`) exposes **exactly five
read-only tools** and nothing else:

| Tool | Kind | What it does |
| --- | --- | --- |
| `iap_author` | authoring | Natural-language requirement → intent-compiler gate → clarifications, semantic preview, and (on commit) the document with per-field provenance. Never writes to disk. |
| `iap_validate` | analysis | Full validation pipeline (phases 1–5); identical findings to `iap validate`. |
| `iap_cost` | analysis | Cost estimate and budget evaluation (identical to `iap cost`). |
| `iap_security` | analysis | Security posture: grants, reachability, IAP6xx findings (identical to `iap security`). |
| `iap_compliance` | analysis | Active compliance framework bundles → evidence report (identical to `iap compliance`). |

What it **cannot** do — by construction, not by configuration:

- **No deploy, mutate, destroy, apply, or rollback tool exists.** The server refuses to start
  if its registry ever contains one (the `assertReadOnly` guard rejects any tool whose name
  contains a mutation verb). An assistant using this server structurally cannot deploy or
  reach a cloud provider (spec ch. 19 §19.2).
- **No provider/cloud API access and no credentials.** The tools parse and analyse IaP
  documents in-process; nothing leaves your machine.
- **No unreviewed YAML.** Authoring runs through the intent-compiler gate: the LLM proposes
  operations, the gate validates and commits them, and every committed value carries
  provenance. Deployment stays with the CLI/control plane behind explicit human approval.

Because the analysis tools run the same engines as the CLI, an assistant's review matches
`iap validate` / `cost` / `security` / `compliance` exactly.

## VS Code

Install **IaP** from the Visual Studio Marketplace — extension id `infraasprompt.iap-vscode`,
publisher `infraasprompt`: <https://marketplace.visualstudio.com/items?itemName=infraasprompt.iap-vscode>
(live after first publish). Or from the command line:

```sh
code --install-extension infraasprompt.iap-vscode
```

What you get for `*.iap.yaml` / `*.iap.yml` / `*.iap-map.yaml` (and
`infrastructure.iap.yaml`): diagnostics identical to `iap validate`, completion, hover,
definition/references/rename, code actions, and the "IaP: Show Architecture Preview" and
"IaP: Restart Language Server" commands. The extension is a thin client that spawns the
bundled language server over stdio — it adds no language semantics of its own and performs
no network I/O beyond the server it spawns.

Settings:

- `iap.languageServer.path` — absolute path to an `iap-language-server` executable. Leave
  empty (the default) to use the language server bundled with the extension; set it only to
  point at a development build.
- `iap.trace.server` — `off` | `messages` | `verbose` LSP tracing.

To use the IaP MCP server with VS Code's native MCP support (e.g. Copilot agent mode),
create `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "iap": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@infraasprompt/mcp-server"]
    }
  }
}
```

> **In-editor assistant panel (planned, roadmap M20.7).** A dedicated IaP assistant panel
> inside VS Code is not implemented yet. Today, MCP authoring flows (`iap_author` and the
> analysis tools) are available through MCP clients — Claude Code, Claude Desktop, Cursor,
> Windsurf, VS Code agent mode — using the configs in this guide.

## Cursor

Extension: Cursor installs from OpenVSX — search "IaP" in the Extensions view, or see
<https://open-vsx.org/extension/infraasprompt/iap-vscode> (live after first publish).

MCP server, per project — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "iap": {
      "command": "npx",
      "args": ["-y", "@infraasprompt/mcp-server"]
    }
  }
}
```

Or globally — `~/.cursor/mcp.json`, same shape:

```json
{
  "mcpServers": {
    "iap": {
      "command": "npx",
      "args": ["-y", "@infraasprompt/mcp-server"]
    }
  }
}
```

## Windsurf

Add the server to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "iap": {
      "command": "npx",
      "args": ["-y", "@infraasprompt/mcp-server"]
    }
  }
}
```

## Claude Code

Three ways, in order of preference:

**1. Plugin (preferred).** The IaP plugin bundles the MCP server config (and future
commands) in one install:

```sh
claude plugin marketplace add vinit-devops/iap
claude plugin install iap@iap
```

**2. One-liner.** Registers the MCP server directly:

```sh
claude mcp add iap -- npx -y @infraasprompt/mcp-server
```

**3. Project config.** Commit a `.mcp.json` at the repo root so every collaborator gets the
server:

```json
{
  "mcpServers": {
    "iap": {
      "command": "npx",
      "args": ["-y", "@infraasprompt/mcp-server"]
    }
  }
}
```

## Claude Desktop

Edit the Claude Desktop config file —
macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json` — and add:

```json
{
  "mcpServers": {
    "iap": {
      "command": "npx",
      "args": ["-y", "@infraasprompt/mcp-server"]
    }
  }
}
```

Restart Claude Desktop; the five `iap_*` tools appear in the tools list.

## JetBrains

Two honest options today:

**MCP (works now).** JetBrains AI Assistant supports MCP servers: in
Settings → Tools → AI Assistant → Model Context Protocol (MCP), add a stdio server with
command `npx` and arguments `-y @infraasprompt/mcp-server` (or paste the same
`{"mcpServers": ...}` JSON shape used above where a JSON import is offered). This gives
the authoring/analysis tools, not editor diagnostics.

**LSP (build from source for now).** Editor features (diagnostics, completion, hover) come
from the `iap-language-server` binary in `@iap/language-server`. That package is **not yet
published to npm** — `npm i -g @infraasprompt/cli @infraasprompt/mcp-server` does *not* install it. Until it is
published, build it from source:

```sh
git clone https://github.com/vinit-devops/iap
cd iap
corepack pnpm install
corepack pnpm build
# binary: packages/language-server/dist/main.js  (bin name: iap-language-server)
```

Then point a generic LSP client (e.g. the [LSP4IJ](https://plugins.jetbrains.com/plugin/23257-lsp4ij)
plugin, or the built-in LSP API in recent IDEs) at the built binary for IaP files. LSP4IJ
"Language Server definition", expressed as its JSON template equivalent:

```json
{
  "name": "IaP Language Server",
  "command": "node /path/to/iap/packages/language-server/dist/main.js --stdio",
  "fileMappings": [
    {
      "filePatterns": ["*.iap.yaml", "*.iap.yml", "*.iap-map.yaml"],
      "languageId": "yaml"
    }
  ]
}
```

Feature parity with VS Code follows from sharing the same server.

## CLI

```sh
npm i -g @infraasprompt/cli
```

installs the `iap` binary:

```sh
iap validate infrastructure.iap.yaml   # phases 1-5 validation
iap cost infrastructure.iap.yaml       # cost estimate + budget evaluation
iap security infrastructure.iap.yaml   # security posture report
iap compliance infrastructure.iap.yaml # compliance evidence report
iap plan --mapping <provider-mapping>  # deterministic provider plan
```

npm listing: <https://www.npmjs.com/package/@infraasprompt/cli> (live after first publish).

## Invariants every integration preserves

- IDE/assistant actions use the same SDK, engines, and gate as the CLI (no second
  implementation).
- Assistant tools cannot call provider APIs or deploy (ch. 19; enforced by tool absence and
  the server's `assertReadOnly` guard).
- Every generated value and its provenance is inspectable (the authoring result carries the
  operation provenance).
- Users can generate and review IaP without writing YAML (`iap_author` + the analysis tools).
