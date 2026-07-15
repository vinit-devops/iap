# Machine-tidy verification (M20.6)

Date: 2026-07-15. Rule: nothing outside the repo may change except temp dirs under
the session scratchpad, which must be deleted afterwards.

## What was isolated and how

- All `claude mcp add` / `claude plugin ...` state went into throwaway
  `CLAUDE_CONFIG_DIR` directories under the session scratchpad
  (`.../scratchpad/m206/claude-config-mcp` and `.../claude-config-plugin`).
- Real tool-call `-p` sessions registered the server ONLY via
  `--mcp-config <scratchpad file> --strict-mcp-config` — no persistent registration.
  They used the user's existing login session read-only (as sanctioned by the work item).
- GUI apps (Cursor, Windsurf, Claude Desktop): configs were NOT touched; ready-to-paste
  files were staged inside the repo (`staged-configs/`) with a manual checklist.
- The `m206` scratchpad directory (temp config dirs, throwaway project, transcripts —
  already copied into this evidence dir) was deleted at the end.

## Baseline vs final state of the user's REAL Claude config (read-only checks)

`claude mcp list` BEFORE any test (verbatim):

```
claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication
plugin:aws-serverless:aws-serverless-mcp: uvx awslabs.aws-serverless-mcp-server@latest --allow-write - ✔ Connected
plugin:playwright:playwright: npx @playwright/mcp@latest - ✔ Connected
```

`claude mcp list` AFTER all tests and cleanup (verbatim):

```
claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication
plugin:aws-serverless:aws-serverless-mcp: uvx awslabs.aws-serverless-mcp-server@latest --allow-write - ✔ Connected
plugin:playwright:playwright: npx @playwright/mcp@latest - ✔ Connected
```

Identical: no `iap` entry existed before, none exists after. The user also had no
`iap` plugin beforehand and `claude plugin list | grep -i iap` finds none after.

## Verdict

PASS — user's real Claude state untouched; no GUI config modified; scratchpad temp
dirs deleted.
