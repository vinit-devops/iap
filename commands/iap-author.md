---
description: Author an IaP document from a natural-language requirement via the iap_author MCP tool, write infrastructure.iap.yaml, and show provenance
argument-hint: <natural-language infrastructure requirement>
---

Author an IaP (Infrastructure as Prompt) document from this natural-language requirement:

$ARGUMENTS

Follow these steps:

1. If no requirement was given above, ask the user what infrastructure they want before doing anything else.
2. Call the `iap_author` MCP tool (from the `iap` MCP server bundled with this plugin) with the requirement. The tool runs the intent-compiler gate: it may return clarification questions, a semantic preview, and — on commit — the finished document with per-field provenance. It never writes to disk itself.
3. If the tool returns clarification questions, relay them to the user, collect answers, and call `iap_author` again with the answers until it produces a committed document.
4. Show the user the semantic preview / summary of what will be authored before finalizing.
5. Write the committed document to `infrastructure.iap.yaml` in the project root (or the path the user specifies). If the file already exists, show a diff and ask before overwriting.
6. After writing, present the provenance information returned by the tool: for each field, where its value came from (user requirement, clarification answer, or default), so the user can audit every committed value.
7. Suggest running `/iap-validate` next to confirm the document passes the full validation pipeline.

Notes:
- The IaP MCP server is read-only by construction: it has no deploy, mutate, or provider-API capability. Only you (with the user's approval) write the file.
- Do not hand-edit the generated YAML beyond what the tool committed; if changes are needed, re-run `iap_author` with an updated requirement so provenance stays accurate.
