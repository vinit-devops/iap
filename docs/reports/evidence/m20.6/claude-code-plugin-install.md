# Claude Code — plugin path (local marketplace, isolated config)

- Date: 2026-07-15, Claude Code 2.1.210.
- Isolation: fresh `CLAUDE_CONFIG_DIR` under the session scratchpad
  (`.../scratchpad/m206/claude-config-plugin`), deleted after the run. The user's
  real Claude config was not touched.

## Commands and verbatim output

```
$ claude plugin marketplace add /Users/vinitkumar/iap
Adding marketplace…✔ Successfully added marketplace: iap (declared in user settings)

$ claude plugin install iap@iap
Installing plugin "iap@iap"...✔ Successfully installed plugin: iap@iap (scope: user)

$ claude plugin list
Installed plugins:

  ❯ iap@iap
    Version: 0.1.0
    Scope: user
    Status: ✔ enabled

$ claude plugin details iap
IaP (iap) 0.1.0
  IaP (Infrastructure as Prompt) for Claude Code: read-only authoring and analysis of *.iap.yaml
  documents via the @iap/mcp-server MCP tools (iap_author, iap_validate, iap_cost, iap_security,
  iap_compliance) plus /iap-* slash commands. No deploy or mutation capability by construction.
  Source: iap@iap

Component inventory
  Skills (5)  iap-author, iap-compliance, iap-cost, iap-security, iap-validate
  Agents (0)
  Hooks (0)
  MCP servers (0)
  LSP servers (0)
```

All 5 `/iap-*` commands are present (surfaced as "Skills (5)" in the inventory:
iap-author, iap-compliance, iap-cost, iap-security, iap-validate).

## MCP server bundled with the plugin (expected-pending-publish)

```
$ claude mcp list        # inside the same isolated config
plugin:iap:iap: npx -y @iap/mcp-server - ✘ Failed to connect
```

This failure is EXPECTED: the committed plugin.json intentionally references
`npx -y @iap/mcp-server`, and `@iap/mcp-server` is not yet published to npm.
The same server binary connects fine when addressed by local path (see
`claude-code-mcp-add-connected.md`), so the only missing step is `npm publish`.

## Observed quirk (informational, not fixed — out of scope)

`claude plugin details iap` reports "MCP servers (0)" in the component inventory even
though plugin.json declares one inline `mcpServers` entry and `claude mcp list` does
load it as `plugin:iap:iap`. This looks like a display quirk of the Claude Code
`plugin details` inventory (possibly counting only file-based MCP declarations), not
a defect in the plugin manifest.

## Result

- Install path: PASS-local (marketplace add + install + list + details all green).
- Bundled MCP connectivity: PENDING-publish (fails only because the npm package is unpublished).
