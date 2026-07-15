# Post-publish verification — 2026-07-15

`@infraasprompt/cli@0.1.0` and `@infraasprompt/mcp-server@0.1.0` were published
to public npm on 2026-07-15 by `vinit-devops` (approver directed the publish
in-session). Verification below ran against the **public registry** with a
fresh npm cache and isolated Claude Code config dirs (the user's real config
was never touched).

## 1. CLI from public npm (clean cache, no repo checkout)

```
$ npx --yes --package=@infraasprompt/cli iap --version
iap 0.1.0
```

## 2. MCP stdio handshake from public npm (clean cache)

```
$ printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}\n' | npx --yes @infraasprompt/mcp-server
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"@iap/mcp-server","version":"0.1.0"},"capabilities":{"tools":{}}}}
```

## 3. Claude Code — documented one-liner (isolated CLAUDE_CONFIG_DIR)

```
$ claude mcp add iap -- npx -y @infraasprompt/mcp-server
$ claude mcp list
iap: npx -y @infraasprompt/mcp-server - ✔ Connected
```

## 4. Claude Code plugin — full public install path (isolated CLAUDE_CONFIG_DIR)

```
$ claude plugin marketplace add vinit-devops/iap
✔ Successfully added marketplace: iap (declared in user settings)
$ claude plugin install iap@iap
✔ Successfully installed plugin: iap@iap (scope: user)
$ claude mcp list
plugin:iap:iap: npx -y @infraasprompt/mcp-server - ✔ Connected
```

This flips the interop-matrix "Claude Code (plugin)" row from PENDING-publish
to PASS: the committed `npx -y @infraasprompt/mcp-server` form now resolves and
connects from the public registry, installed via the GitHub marketplace form
(`vinit-devops/iap`).

Registry note: both packages returned 404 from `npm view` for ~20 seconds
after `npm publish` accepted them (propagation lag), then resolved normally.

Still pending after this file: VS Code Marketplace + OpenVSX publish (PATs,
runbook steps 4–5), the three GUI-app manual checks (`manual-checklist.md`),
and the closing release sign-off.
