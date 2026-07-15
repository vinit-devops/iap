---
description: Analyze the security posture of the project's IaP document with the iap_security MCP tool (identical to `iap security`) and summarize findings
argument-hint: [path to .iap.yaml file]
---

Run a security analysis of the current project's IaP document.

Target file: $ARGUMENTS

Follow these steps:

1. Resolve the IaP document: use the path given above if provided; otherwise look for `infrastructure.iap.yaml` in the project root, then any `*.iap.yaml` / `*.iap.yml` file in the project. If none exists, tell the user and suggest `/iap-author` to create one.
2. Read the document and call the `iap_security` MCP tool (from the `iap` MCP server bundled with this plugin) against it. The tool reports the same security posture as the `iap security` CLI: grants, reachability, and IAP6xx findings, computed in-process from the document.
3. Summarize the results for the user:
   - Overall security posture.
   - Each IAP6xx finding with its id, severity, message, and the grant/edge/component it points at, ordered by severity.
   - The grants and reachability facts that explain each finding (who can reach or act on what, and why).
4. For each finding, explain the risk in plain language and propose a concrete document-level remediation (tighter grant, removed exposure, added boundary). Do not modify the document without the user's approval.
5. If there are no findings, state the posture is clean and mention `/iap-compliance` for framework-level evidence.

The IaP MCP server is read-only: security analysis never modifies the document, uses no credentials, and touches no cloud provider.
