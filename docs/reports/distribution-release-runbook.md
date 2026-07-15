# Distribution release v0.1 — USER PUBLISH RUNBOOK

Companion to [`distribution-release-v0.1.md`](distribution-release-v0.1.md). Every
step below is a **user action** (credentials required); the agent prepared everything
up to this boundary. Run the steps **in order** — later steps depend on earlier ones.

**Total estimated time:** 1.5–3 hours (dominated by account creation in steps 1, 4, 5).

**Irreversibility warning:** npm package **names are effectively permanent** once
published — `npm unpublish` is only unrestricted for 72 hours, the name is then
blocked for reuse for 24 hours and republishing the same version is forbidden
forever. Marketplace/OpenVSX extension IDs (`iap.iap-vscode`) similarly persist
after unpublish. Do not publish until the report's "What is NOT yet true" section
has been read and accepted.

---

## Step 0 — prerequisite: commit and push the repo (~10 min)

The repo currently has **1 local commit plus this entire cycle's uncommitted work**
and no remote push. Steps 2–7 assume the built artifacts you publish match the
committed tree, and step 6 (Claude plugin) hard-requires the repo to be public on
GitHub at `https://github.com/vinit-devops/iap` (the plugin marketplace is served
from the repo itself).

```bash
cd /Users/vinitkumar/iap
git add -A
git commit -m "Phase 20: public distribution preparation (M20.0-M20.6)"
git remote add origin https://github.com/vinit-devops/iap.git   # if not yet added
git push -u origin main
```

## Step 1 — npm account + org — ✅ DONE 2026-07-15

Resolved: authenticated as `vinit-devops` (token in `~/.npmrc`); npm org
**`infraasprompt`** created (`npm org ls infraasprompt` → `vinit-devops - owner`).
The published identities were renamed accordingly across the repo:
**`@infraasprompt/cli`** (bin `iap`) and **`@infraasprompt/mcp-server`**
(bin `iap-mcp-server`). The original `@iap/*` plan and its fallback section
(bottom of this document) are retained for the historical record only.

## Step 2 — publish the two npm packages (~10 min, IRREVERSIBLE)

Rebuild fresh, dry-run, then publish (both packages carry
`publishConfig.access: public`):

```bash
cd /Users/vinitkumar/iap
corepack pnpm run build:cli-pkg
corepack pnpm run build:mcp-pkg

cd /Users/vinitkumar/iap/dist-pkg/cli
npm publish --dry-run   # expect the same clean file list as prepared
npm publish

cd /Users/vinitkumar/iap/dist-pkg/mcp-server
npm publish --dry-run
npm publish
```

## Step 3 — post-npm verification (~10 min)

CLI, from any machine without the repo:

```bash
npm i -g @infraasprompt/cli && iap --version
```

MCP server handshake one-liner (expect a single JSON line whose
`result.serverInfo.name` is `@infraasprompt/mcp-server`):

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' | npx -y @infraasprompt/mcp-server
```

Register in Claude Code and confirm "✔ Connected":

```bash
claude mcp add iap -- npx -y @infraasprompt/mcp-server
claude mcp list
```

GUI clients: apply the **POST-PUBLISH** staged configs
(`docs/reports/evidence/m20.6/staged-configs/*.POST-PUBLISH.json`) for Cursor,
Windsurf, and Claude Desktop, following
`docs/reports/evidence/m20.6/manual-checklist.md` step by step, and record each
result in `docs/reports/evidence/m20.6/interop-matrix.md`
(STAGED-pending-manual → PASS-manual).

## Step 4 — VS Code Marketplace (~30–60 min incl. account setup, IRREVERSIBLE)

1. Create publisher `iap` at <https://marketplace.visualstudio.com/manage>
   (requires a Microsoft/Azure DevOps account).
2. Create an Azure DevOps Personal Access Token: <https://dev.azure.com> → User
   settings → Personal access tokens → New token, organization **All accessible
   organizations**, scope **Marketplace → Manage**.
3. Publish:

```bash
export VSCE_PAT=<your-token>
cd /Users/vinitkumar/iap/extensions/vscode
corepack pnpm run package:vsce        # sanity: clean .vsix (13 files)
corepack pnpm run publish:marketplace # wraps: npx @vscode/vsce publish --no-dependencies
```

4. Verify on a machine with VS Code: install "IaP" from the Marketplace, open a
   file named `infrastructure.iap.yaml`, confirm diagnostics/hover/completion
   appear with no manual binary setup (details:
   `docs/reports/evidence/m20.6/manual-checklist.md`, VS Code section).

## Step 5 — OpenVSX (Cursor/Windsurf extension source) (~20–40 min, IRREVERSIBLE)

1. Create an Eclipse account at <https://open-vsx.org> (sign in with GitHub),
   sign the publisher agreement, and generate an access token (user settings →
   Access Tokens).
2. Create the namespace and publish:

```bash
export OVSX_PAT=<your-token>
npx --yes ovsx create-namespace iap -p "$OVSX_PAT"
cd /Users/vinitkumar/iap/extensions/vscode
corepack pnpm run publish:openvsx     # wraps: npx ovsx publish
```

3. Verify in Cursor: Extensions panel → search "IaP" → install → open
   `infrastructure.iap.yaml` → diagnostics live.

## Step 6 — Claude Code plugin (~10 min; requires steps 0 and 2)

The marketplace manifest lives in the repo (`.claude-plugin/marketplace.json`),
so this works as soon as the repo is pushed (step 0) and `@infraasprompt/mcp-server` is on
npm (step 2):

```bash
claude plugin marketplace add vinit-devops/iap
claude plugin install iap@iap
```

Verify in a Claude Code session: run `/iap-validate` against
`spec/examples/basic-webapp.iap.yaml` — expect `{"ok":true,"findings":[]}` — and
confirm the 5 `iap_*` tools are listed (all read-only; no deploy/mutation tool).
Note: `claude plugin details` may show "MCP servers (0)" despite the server
loading fine — known display quirk
(`docs/reports/evidence/m20.6/claude-code-plugin-install.md`).

## Step 7 — final regression + sign-off (~15 min)

```bash
cd /Users/vinitkumar/iap
corepack pnpm run verify
corepack pnpm run smoke:vsix
```

Then record the release in `ROADMAP-V3.yml`, flipping exactly these lines:

- `M20.0`: `status: in-progress` → `status: completed`; exit criteria
  `Accounts provisioned [PENDING-USER]` → `[PASS]` and
  `Approver sign-off recorded [PENDING-USER]` → `[PASS]`.
- `M20.2`: `status: prepared` → `status: completed` (packages live on npm).
- `M20.3`: `status: prepared` → `status: completed` (Marketplace + OpenVSX live).
- `M20.4`: `status: prepared` → `status: completed` (plugin installs from GitHub).
- `M20.6`: `status: in-progress` → `status: completed`; exit criteria
  `[PENDING-USER]` entries → `[PASS]`; add an evidence line
  `"approver sign-off: <name>, <date>"`.
- Update the top-level `updated:` date.

Commit and push the tracker change.

---

## Fallback rename — RESOLVED (historical)

This section originally covered the case where the `@iap` npm scope was
unavailable. That happened: the scope could not be obtained, so on 2026-07-15
the npm org **`infraasprompt`** was created and the rename was executed
repo-wide — the published names are now **`@infraasprompt/cli`** and
**`@infraasprompt/mcp-server`** (bins unchanged: `iap`, `iap-mcp-server`;
in-repo workspace package names stay `@iap/*`, private and never published;
`serverInfo.name` remains `@iap/mcp-server` as product self-identification).
The unscoped names `iap-cli` / `iap-mcp-server` remain an unused alternative.
