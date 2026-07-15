# Trust boundary — tool surface of @iap/mcp-server 0.1.0

Two independent captures, both on 2026-07-15, both against the built package at
`/Users/vinitkumar/iap/dist-pkg/mcp-server/dist/iap-mcp-server.js`.

## 1. Raw JSON-RPC `tools/list` (authoritative)

Full initialize + tools/list responses: `raw-jsonrpc-initialize-tools-list.json`.
serverInfo: `{"name":"@iap/mcp-server","version":"0.1.0"}`.

Tools returned — exactly five, all read-only analysis/authoring:

| Tool | Description (from the server) |
|---|---|
| `iap_author` | Author IaP from a natural-language requirement. Runs the intent compiler (extract → clarify → gate). "Never writes to disk or deploys." |
| `iap_compliance` | Evaluate active compliance framework bundles, return evidence report (ch. 17). "Read-only." |
| `iap_cost` | Estimate cost and evaluate budgets (ch. 16). "Read-only." |
| `iap_security` | Derive security posture (grants, reachability, IAP6xx findings) (ch. 15). "Read-only." |
| `iap_validate` | Validate an IaP document (phases 1–5), return findings. "Read-only." |

No deploy, apply, provision, write, delete, or any other mutation-named tool is exposed.

## 2. As seen from a real Claude Code session

`claude -p "List the full names of all MCP tools you have available..." --mcp-config <ephemeral> --strict-mcp-config`
(full output in `claude-code-p-tools-listing.txt`) listed exactly:

```
mcp__iap__iap_author
mcp__iap__iap_compliance
mcp__iap__iap_cost
mcp__iap__iap_security
mcp__iap__iap_validate
```

(The remaining names in that file are Claude Code built-ins, not MCP server tools.)

## Verdict

PASS-local — the client-visible tool surface is exactly the 5 documented `iap_*`
read-only tools; the trust boundary (no mutation capability) holds end to end.
