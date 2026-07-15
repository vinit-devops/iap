# IEP-0013: AI and MCP Trust Boundaries

| Field | Value |
|---|---|
| **Title** | AI and MCP Trust Boundaries — Implementation Contract |
| **Number** | IEP-0013 |
| **Status** | Draft |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | Implementation (non-normative) |

## Summary

[Chapter 19](../chapters/19-ai-guidelines.md) and [Chapter 20](../chapters/20-mcp-integration.md) state the normative boundary: AI authors intent only; MCP supplies knowledge only. This IEP consolidates that boundary into an **implementation contract** for the reference toolchain: segregated tool allowlists (authoring vs. deployment), the MCP knowledge **snapshot/citation/staleness** model, the acceptance rule (recommendations become explicit structured intent before planning), prompt-injection defenses, provenance recording, and the invariant that an AI or MCP outage never affects execution of a finalized plan. Each rule gets an enumerated conformance check.

## Motivation

The spec chapters define *what must never happen*; the roadmap (§5.3, Phase 12, Phase 13) requires concrete mechanisms: an MCP tool surface for IDE assistants, a source registry with trust classification, snapshot caching with expiry, and injection defenses. Without a single contract, each integration (VS Code, Claude Code, Cursor, the visual designer) would enforce the boundary differently — and the boundary is only as strong as its weakest surface.

## Problem statement

Unspecified today: (a) which tools an AI assistant may call, and how deployment tools are structurally — not just procedurally — separated; (b) the record format for MCP-retrieved knowledge and when it goes stale; (c) the exact mechanism by which an accepted recommendation enters the model; (d) defenses when retrieved documentation or document content itself carries adversarial instructions; (e) what is recorded so an auditor can reconstruct AI/MCP influence on any document.

## Goals

- Define two disjoint tool registries with independent transports and credentials.
- Define the knowledge snapshot record, its citation obligations, and staleness handling.
- Make "accepted recommendation → compiler operation with citation" the only path from knowledge to intent.
- Enumerate prompt-injection defenses and the conformance checks enforcing every rule.
- Guarantee finalized-plan execution is independent of AI/MCP availability.

## Non-goals

- Changing Chapters 19/20 normative text (this IEP implements them).
- Prompt engineering, model selection, adapter design (Phase 3.6, Phase 17).
- MCP server implementations for specific knowledge sources.

## Terminology

- **Authoring tools** — MCP/SDK tools that read models or propose validated changes.
- **Deployment tools** — tools that touch plans-for-execution, state, or providers.
- **Knowledge snapshot** — a versioned record of MCP-retrieved content.
- **Finalized plan** — a signed plan artifact (IEP-0011) whose approvals are recorded.

## Detailed design

### Tool allowlists

Two registries, disjoint by construction:

```yaml
# Authoring registry — exposed to AI assistants (roadmap Phase 13)
authoringTools:
  [iap_create_model, iap_get_model, iap_propose_change, iap_validate,
   iap_get_questions, iap_apply_confirmed_answers, iap_get_architecture,
   iap_get_cost, iap_get_security, iap_get_compliance,
   iap_create_plan, iap_get_plan]        # create_plan returns an artifact for humans; it cannot execute

# Deployment registry — NEVER exposed through an assistant-facing MCP server
deploymentTools:
  [iap_apply_plan, iap_destroy, iap_rollback, iap_state_write, iap_unlock_force]
```

Rules: (1) the two registries are served by separate endpoints with separate credentials; the assistant-facing MCP server has no code path to deployment tools — separation is structural, not a permission flag. (2) `iap_propose_change` accepts only compiler operations (IEP-0009); there is no raw-document write tool. (3) Deployment tools require an authenticated human principal and recorded approval; an AI identity is rejected as actor (Chapter 13 §13.4). (4) Adding a tool to the authoring registry requires review demonstrating it is read-only or operation-gated.

### Knowledge snapshot, citation, staleness

Every MCP retrieval used in authoring or recommendation produces:

```json
{
  "snapshotId": "ks-2026-07-10-0042",
  "source": { "registryId": "provider-docs", "trustClass": "authoritative-vendor" },
  "query": "engine version support policy",
  "retrievedAt": "2026-07-10T09:14:02Z",
  "contentVersion": "docs-rev-2026-06-28",
  "excerpt": "…",
  "confidence": "cited-verbatim",
  "expiresAt": "2026-08-10T00:00:00Z",
  "acceptance": { "accepted": true, "by": "vinit.kumar@example.org",
                  "materializedAs": "op-9c11d0" }
}
```

Rules: sources come from a **source registry** with trust classification; every AI-surfaced recommendation citing MCP content must reference snapshot ids — uncited claims are rendered as model opinion, never as fact. Expired snapshots are **stale**: they may not ground new recommendations; UI marks derived help as outdated; refresh is out-of-band ([Chapter 20, §20.1](../chapters/20-mcp-integration.md)). Deterministic-pipeline consumption remains snapshot-only (pinned bundles; §20.3.1).

### Acceptance rule

A recommendation has exactly one path into the model: user acceptance emits a **compiler operation** (IEP-0009) with provenance `explicit / accepted-recommendation`, citing the snapshot id, which then passes the full validation gate. Knowledge never bypasses validation, never lands in the document directly, and never enters a plan except through the document (roadmap Phase 12: "accepted recommendations become explicit model changes").

### Prompt-injection defenses

1. **Content/instruction demarcation** — retrieved excerpts and document free-text fields (`description`, annotations) enter prompts only inside typed data blocks the orchestrator marks non-instructional.
2. **No retrieval-triggered tool calls** — tool invocation may only be caused by the user's turn or the orchestrator; content inside knowledge snapshots cannot cause a tool call.
3. **Structural gate as backstop** — even a fully compromised model can only emit compiler operations into validation; the operation gate (IEP-0009 OP-1) plus deny-level policy and human review gates ([Chapter 19, §19.6](../chapters/19-ai-guidelines.md)) bound the blast radius to a reviewable document diff.
4. **Approval isolation** — no AI output can satisfy, simulate, or auto-fill an approval (§19.6); approval UIs never render model text as the default-confirmed choice.
5. **Injection corpus** — an adversarial test corpus (instructions embedded in docs excerpts, resource descriptions, clarification answers) runs in CI against the authoring pipeline.

### Provenance recording

For every AI-assisted change, the operation log (IEP-0009) records: model/adapter id and version, prompt version, snapshot citations, confidence, confirmation events, and the human actor. Document-level `metadata.annotations` (e.g. `authored-by`) remain non-semantic per §19.5 — a conforming tool never branches on them.

### Outage invariant

Execution of a finalized plan reads only: the signed plan artifact, state (IEP-0010), provider credentials, and provider APIs. No component in `apply` links the MCP client or any model adapter; the deployment path is buildable with both packages absent. AI/MCP outage degrades authoring enrichment only (§20.3.2) — never validation completion against pinned bundles, never execution.

## Schema impact

None to `iap-v1.schema.json`. Companion schemas: `knowledge-snapshot-v1.schema.json`, tool-registry manifest schema.

## Runtime-model impact

Adds the MCP client framework, source registry, and snapshot store (`packages/mcp`) strictly outside the deterministic pipeline; CIM and planner have no dependency on them.

## Validation impact

None on outcomes: MCP-sourced recommendations surface at warn level at most (§20.2.3); rule/price updates enter only as versioned pinned bundles whose versions validation reports must name (§20.2.4).

## Provider impact

Provider documentation sources are the one place provider names legitimately surface in UI (§20.2.1). Provider packages may ship documentation-source registrations (e.g. an AWS documentation MCP server reference) in their manifests (IEP-0012); such sources receive `trustClass: authoritative-vendor` and are still knowledge-only — a provider package cannot register a mutating MCP capability (§20.3.3).

## Security impact

This IEP is a security boundary. Key properties: assistant-facing servers cannot reach deployment tools or credentials; retrieved content is data, not instructions; redaction hooks strip sensitive document content from prompts (roadmap §3.6, §9.5); the audit trail reconstructs all AI/MCP influence; approvals are human-only. Threat model entries: malicious MCP server, poisoned documentation, injected document descriptions, compromised model adapter — each mapped to the defenses above.

## Cost impact

Snapshot caching bounds MCP/model call volume; token/cost limits per adapter (roadmap §3.6). No effect on plan cost content beyond pinned pricing snapshots.

## Compatibility

Additive; implements existing normative chapters. Toolchains already conforming to Chapters 19/20 gain concrete checkable requirements.

## Migration

None for documents. Existing integrations must split any combined tool surface into the two registries before claiming conformance.

## Alternatives considered

1. Single tool registry with role-based flags — rejected: one misconfiguration exposes deployment tools; separation must be structural.
2. Free-text recommendation acceptance ("apply this suggestion" writes YAML) — rejected: bypasses the operation gate.
3. Live MCP lookups during planning with response pinning after the fact — rejected: violates plan invariance (§20.3.1).

## Rejected alternatives

Granting any MCP server mutation credentials, or making MCP availability a deployment-time dependency, is categorically rejected (§20.3.3; roadmap Phase 12).

## Implementation plan

1. `packages/mcp`: client framework, source registry with trust classes, snapshot store with expiry.
2. Dual-registry MCP server in the IDE integration layer (Phase 13), deployment tools behind the CLI/engine only.
3. Snapshot citation plumbing through the intent compiler and recommendation engines.
4. Injection corpus + outage tests in `tests/security/`; link-time check that deployment binaries exclude `mcp` and model-adapter packages.

## Conformance requirements

- TB-1: enumeration of the assistant-facing MCP server's tools equals the authoring registry exactly; no deployment tool is reachable through it (structural test).
- TB-2: with all MCP servers and model adapters unreachable, a finalized plan executes successfully and validation completes against pinned bundles.
- TB-3: every accepted recommendation in the operation log cites ≥1 knowledge snapshot; every AI-surfaced factual claim in UI carries a citation or an explicit "model opinion" marker.
- TB-4: expired snapshots ground no new recommendations (staleness test).
- TB-5: the injection corpus produces zero tool calls and zero uncommitted document mutations originating from retrieved content.
- TB-6: no history record or approval names an AI identity as actor or approver.
- TB-7: replaying the operation log reconstructs model id, prompt version, and citations for every AI-assisted field.

## Open questions

1. Trust-class vocabulary: is `authoritative-vendor / organization / community / unverified` sufficient for v1?
2. Should snapshot stores be shareable across a team (centralized cache) without weakening provenance?
3. Do clarification *answers* relayed by an assistant require independent confirmation UI, or is the operation-gate confirmation sufficient?

## Decision

Pending review.

## References

- [Chapter 1 — Architecture (§1.4)](../chapters/01-architecture.md)
- [Chapter 19 — AI Guidelines](../chapters/19-ai-guidelines.md)
- [Chapter 20 — MCP Integration](../chapters/20-mcp-integration.md)
- IEP-0009 (compiler operations), IEP-0010 (state), IEP-0011 (plan artifact)
- Roadmap §5.3, Phase 12, Phase 13
