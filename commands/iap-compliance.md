---
description: Produce a compliance evidence report for the project's IaP document with the iap_compliance MCP tool (identical to `iap compliance`) and summarize findings
argument-hint: [path to .iap.yaml file]
---

Run a compliance analysis of the current project's IaP document.

Target file: $ARGUMENTS

Follow these steps:

1. Resolve the IaP document: use the path given above if provided; otherwise look for `infrastructure.iap.yaml` in the project root, then any `*.iap.yaml` / `*.iap.yml` file in the project. If none exists, tell the user and suggest `/iap-author` to create one.
2. Read the document and call the `iap_compliance` MCP tool (from the `iap` MCP server bundled with this plugin) against it. The tool evaluates the document's active compliance framework bundles and returns the same evidence report as the `iap compliance` CLI, computed in-process.
3. Summarize the results for the user:
   - Which compliance frameworks/bundles are active for the document.
   - Per-control status: satisfied, violated, or not applicable, with the evidence the tool cites for each.
   - Violations first, each with control id, severity, message, and the document location it points at.
4. For each violated control, explain what the control requires and propose a concrete document change that would satisfy it. Do not modify the document without the user's approval.
5. If no frameworks are active, say so and explain that compliance bundles are declared in the IaP document itself.

The IaP MCP server is read-only: compliance analysis never modifies the document, uses no credentials, and touches no cloud provider.
