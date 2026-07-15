# Claude Code — MCP direct: `claude mcp add` + `claude mcp list` (isolated config)

- Date: 2026-07-15
- Claude Code version: 2.1.210
- Isolation: `CLAUDE_CONFIG_DIR` pointed at a throwaway directory under the session
  scratchpad (`.../scratchpad/m206/claude-config-mcp`). The user's real Claude config
  was never touched; the temp dir was deleted after the run.

## Commands and verbatim output

```
$ export CLAUDE_CONFIG_DIR="$SCRATCH/claude-config-mcp"
$ claude mcp add iap -- node /Users/vinitkumar/iap/dist-pkg/mcp-server/dist/iap-mcp-server.js
Added stdio MCP server iap with command: node /Users/vinitkumar/iap/dist-pkg/mcp-server/dist/iap-mcp-server.js to local config
File modified: /private/tmp/claude-501/-Users-vinitkumar-iap/862d0fad-6bd2-4349-a408-8ddc21149089/scratchpad/m206/claude-config-mcp/.claude.json [project: .../scratchpad/m206]

$ claude mcp list
Checking MCP server health…

iap: node /Users/vinitkumar/iap/dist-pkg/mcp-server/dist/iap-mcp-server.js - ✔ Connected
```

## Result

PASS-local — the built `@iap/mcp-server` package (`dist-pkg/mcp-server/dist/iap-mcp-server.js`,
newline-delimited JSON-RPC over stdio) registers and connects in Claude Code.
