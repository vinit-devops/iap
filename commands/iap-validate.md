---
description: Validate the project's IaP document with the iap_validate MCP tool (full validation pipeline, identical to `iap validate`) and summarize findings
argument-hint: [path to .iap.yaml file]
---

Validate the current project's IaP document.

Target file: $ARGUMENTS

Follow these steps:

1. Resolve the IaP document to validate: use the path given above if provided; otherwise look for `infrastructure.iap.yaml` in the project root, then any `*.iap.yaml` / `*.iap.yml` file in the project. If none exists, tell the user and suggest `/iap-author` to create one.
2. Read the document and call the `iap_validate` MCP tool (from the `iap` MCP server bundled with this plugin) against it. The tool runs the full validation pipeline (phases 1-5) and returns exactly the same findings as the `iap validate` CLI.
3. Summarize the results for the user:
   - Overall verdict (valid / invalid).
   - Each finding with its rule id, severity, message, and the document location it points at.
   - Group findings by severity (errors first, then warnings, then info).
4. For each error, briefly explain what in the document triggered it and propose a concrete fix. Do not apply fixes without the user's approval.
5. If the document is valid, say so and suggest the follow-up analyses: `/iap-cost`, `/iap-security`, `/iap-compliance`.

The IaP MCP server is read-only: validation never modifies the document or touches any cloud provider.
