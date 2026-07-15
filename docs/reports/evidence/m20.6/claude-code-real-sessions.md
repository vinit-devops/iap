# Claude Code — real `-p` tool-call sessions against the local @iap/mcp-server

- Date: 2026-07-15, Claude Code 2.1.210, model `haiku`, run from a throwaway
  project dir under the session scratchpad containing a copy of
  `spec/examples/basic-webapp.iap.yaml`.
- MCP registration was fully ephemeral: `--mcp-config <scratchpad>/mcp-config.json
  --strict-mcp-config` (the config pointed `iap` at
  `node /Users/vinitkumar/iap/dist-pkg/mcp-server/dist/iap-mcp-server.js`).
  `--strict-mcp-config` means no MCP server from the user's real config was loaded,
  and nothing was registered persistently.
- These sessions used the user's existing Claude Code login session (read-only use,
  as sanctioned by the work item). The user's real MCP config was verified untouched
  afterwards (see `machine-tidy-verification.md`).

## Session 1 — analysis call: `iap_validate`

Prompt: validate `basic-webapp.iap.yaml` and report the verdict verbatim.
Allowed tools: `mcp__iap__iap_validate,Read`.
Full stream-json transcript: `claude-code-session-validate.stream.jsonl`.

Key events extracted from the transcript:

```
TOOL_USE:   Read {"file_path": ".../proj/basic-webapp.iap.yaml"}
TOOL_USE:   mcp__iap__iap_validate {"document":"# Basic web application: gateway -> service -> database + cache + object storage. ..."}
TOOL_RESULT: [{"type":"text","text":"{\"ok\":true,\"findings\":[]}"}]
RESULT:     Validation Verdict: {"ok":true,"findings":[]} — passed with no findings.
```

Outcome: PASS-local.

## Session 2a — authoring call: `iap_author` (clarify gate demonstrated)

Prompt: author from "an HTTPS gateway in front of a stateless web service backed by
a Postgres database" (no container image given).
Full transcript: `claude-code-session-author-needs-input.stream.jsonl`.

The tool returned `outcome: "needs-input"` with the blocking clarification
`q-artifact-web`: "What should service \"web\" run? Provide a container image
reference...". No document and no provenance are emitted before commit — the
gate works as specified.

## Session 2b — authoring call: `iap_author` (committed, provenance shown)

Same request plus `running container image registry.example.com/shop/web:1.4.2`.
Full transcript: `claude-code-session-author-committed.stream.jsonl`.

```
TOOL_USE:   mcp__iap__iap_author {"request":"A small web application: an HTTPS gateway in front of a stateless
             web service running container image registry.example.com/shop/web:1.4.2, backed by a Postgres
             database","name":"evidence-webapp","autoAnswerDefaults":true}
TOOL_RESULT: {"outcome":"committed","unsupported":[],"clarifications":[],"preview":"Applying 5 operation(s) ..."}
```

Per-field provenance entries quoted verbatim from the tool result by the model:

```
{"path":"resources.db.kind","operationId":"op-create-db","source":"explicit-user"}
{"path":"resources.edge.relationships.0.target","operationId":"op-routesto-edge-web","source":"explicit-user"}
{"path":"resources.web.spec.artifact.reference","operationId":"op-create-web","source":"explicit-user"}
```

Outcome: PASS-local — real end-to-end authoring call with per-field provenance
through a real Claude Code client session.
