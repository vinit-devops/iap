---
description: Estimate cost and evaluate budgets for the project's IaP document with the iap_cost MCP tool (identical to `iap cost`) and summarize findings
argument-hint: [path to .iap.yaml file]
---

Run a cost analysis of the current project's IaP document.

Target file: $ARGUMENTS

Follow these steps:

1. Resolve the IaP document: use the path given above if provided; otherwise look for `infrastructure.iap.yaml` in the project root, then any `*.iap.yaml` / `*.iap.yml` file in the project. If none exists, tell the user and suggest `/iap-author` to create one.
2. Read the document and call the `iap_cost` MCP tool (from the `iap` MCP server bundled with this plugin) against it. The tool produces the same cost estimate and budget evaluation as the `iap cost` CLI, computed in-process from the document — no cloud APIs are called.
3. Summarize the results for the user:
   - Total estimated cost (with the period/currency the tool reports).
   - Per-resource or per-component cost breakdown, largest contributors first.
   - Budget evaluation: whether declared budgets pass or are exceeded, and by how much.
4. If a budget is exceeded, identify which components drive the overage and suggest concrete document changes (smaller sizes, fewer replicas, different tiers) — but do not modify the document without the user's approval.
5. Note any resources the tool could not price, if it reports them.

The IaP MCP server is read-only: cost analysis never modifies the document or touches any cloud provider.
