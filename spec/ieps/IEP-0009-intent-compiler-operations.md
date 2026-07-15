# IEP-0009: Intent Compiler Operations

| Field | Value |
|---|---|
| **Title** | Structured Intent Compiler Operation Model |
| **Number** | IEP-0009 |
| **Status** | Draft |
| **Authors** | IaP Maintainers |
| **Created date** | 2026-07-10 |
| **Target version** | Implementation (non-normative) |

## Summary

This IEP defines the **compiler operation model**: the closed set of typed, validated operations through which all authoring surfaces — natural language, guided UI, IDE commands, visual designer — mutate the Canonical Infrastructure Model (IEP-0008). The core rule is normative for the reference implementation: **an LLM never writes YAML into the source-of-truth file**. Model output is expressed as structured operations; only operations that pass validation are applied to the CIM, and the IaP document is then produced by deterministic serialization.

## Motivation

The Layer Boundary Invariant ([Chapter 1, §1.4](../chapters/01-architecture.md#14-the-layer-boundary-invariant)) permits AI to author intent, but raw LLM-generated YAML is untrusted text: it can hallucinate kinds, smuggle provider nouns, or corrupt unrelated document regions. Roadmap Phase 3.1 requires a typed operation vocabulary with an envelope carrying confidence, assumptions, and provenance, so that AI proposals are inspectable, individually validated, replayable, and model-independent: the same confirmed operations must produce the same IaP regardless of which model produced them.

## Problem statement

Neither the specification nor the SDK contract defines: (a) the operation vocabulary; (b) the envelope metadata each operation carries; (c) the validation gate between proposal and application; (d) how confirmed operations map to CIM provenance (IEP-0008 I4); or (e) how preview diffs are produced before anything is saved. Without this contract, every authoring surface would invent its own mutation path and determinism claims would be unverifiable.

## Goals

- Define the closed v1 operation set and its envelope.
- Guarantee that only validated operations reach the CIM, and only the serializer writes the document.
- Make operation application deterministic and replayable (audit log of accepted operations).
- Bind operation provenance to CIM field provenance.

## Non-goals

- Intent *extraction* quality, prompt design, clarification-question policy (roadmap Phase 3.2/3.3).
- Model-vendor adapter interfaces (roadmap Phase 3.6).
- Any deployment or planning behavior.

## Terminology

- **Operation** — a typed, self-contained request to change the CIM.
- **Envelope** — metadata wrapping an operation: identity, confidence, assumptions, provenance, validation result, preview diff.
- **Batch** — an ordered list of operations applied transactionally.
- **Confirmation** — explicit human acceptance of a low-confidence or assumption-bearing operation.

## Detailed design

**Operation vocabulary (closed in v1):**

```text
CreateResource      UpdateResource      RemoveResource
CreateRelationship  UpdateRelationship  RemoveRelationship
ApplyProfile        RemoveProfile
AddPolicy           ChangeConstraint
SetMetadata         SetExtensionValue
```

Each operation targets core constructs only; `SetExtensionValue` is the sole path into `extensions:` and is namespace-scoped, preserving the Extension Non-Interference Rule ([Chapter 11](../chapters/11-extension-framework.md)).

**Envelope and one concrete operation:**

```json
{
  "operationId": "op-7f3a2c",
  "type": "CreateResource",
  "target": { "resourceId": "orders-db" },
  "change": {
    "kind": "Database",
    "spec": {
      "class": "relational",
      "engine": "postgresql",
      "availability": "high",
      "exposure": "private",
      "capacity": { "storage": "100Gi" }
    }
  },
  "sourceSpan": { "input": "nl-request-19", "start": 42, "end": 96,
                  "text": "a highly available Postgres database, private" },
  "confidence": 0.93,
  "assumptions": [
    { "field": "spec.capacity.storage", "assumed": "100Gi",
      "reason": "no size stated; organization default applied" }
  ],
  "requiredClarifications": [],
  "provenance": { "source": "explicit", "channel": "natural-language",
                  "modelId": "adapter:extraction@3", "promptVersion": "12" },
  "validationResult": { "status": "pass", "findings": [] },
  "previewDiff": { "format": "iap-semantic-diff/v1", "adds": ["resources.orders-db"] }
}
```

**Pipeline (normative for the reference implementation):**

```text
proposal (LLM / UI / IDE)
→ operation-schema validation          (structural; unknown types rejected)
→ target resolution against the CIM    (dangling targets rejected)
→ transactional dry-run apply          (copy-on-write CIM)
→ full validation pipeline (Ch. 8)     (all eight phases on the resulting CIM)
→ preview diff + clarification gate    (low confidence / assumptions require confirmation)
→ commit: apply to CIM, append to operation log, deterministic serialization (C1–C6)
```

Rules:

1. Batches are atomic: any operation failing validation aborts the batch; the CIM and document are untouched (fail closed, roadmap §5.5).
2. `confidence` below a configurable threshold, any non-empty `assumptions`, or any `requiredClarifications` force human confirmation before commit — low-confidence output is never silently treated as intent (roadmap §3.4).
3. On commit, each written field receives a CIM provenance record: `explicit` with `channel` detail (`user-input`, `confirmed-clarification`, `accepted-recommendation`), or `default`/`profile`/`policy` when the value was materialized rather than authored. Accepted MCP-sourced recommendations must cite their knowledge snapshot (IEP-0013).
4. The operation log is append-only and replayable: replaying a confirmed batch against the same base CIM yields a byte-identical document.
5. `RemoveResource` on a stateful kind and any operation whose preview diff would classify as `replace` at plan time are flagged `destructive: true` in the preview and require explicit acknowledgment ([Chapter 14, §14.2](../chapters/14-planning-model.md#142-diff-taxonomy)).

## Schema impact

None to `iap-v1.schema.json`. A machine-readable operation schema (`compiler-operations-v1.schema.json`) is published as a companion artifact used for structured-output enforcement against model adapters.

## Runtime-model impact

Adds the only sanctioned mutation API to the otherwise immutable CIM (IEP-0008 I6): `apply(cim, batch) → { cim', log entries }`, a pure function.

## Validation impact

Every dry-run apply invokes the full [Chapter 8](../chapters/08-validation.md) pipeline; operation-level findings reuse the IaP error-code taxonomy plus an `IEP9xx`-style operation-error namespace (invalid type, dangling target, batch conflict) to be registered in the error-code registry.

## Provider impact

Providers are untouched: operations exist entirely left of the mapping boundary. `SetExtensionValue` writes namespaced refinement that mappings MAY read — e.g. an advanced-mode UI setting a maintenance window under `extensions.aws.resources.orders-db` — subject to the extension schema shipped by the provider package (IEP-0012).

## Security impact

The operation gate is the primary defense against prompt-injected or hallucinated model output reaching the document: unknown constructs fail structural validation instead of entering YAML. The operation log is an audit trail (actor, model id, prompt version, confirmation), supporting roadmap §9.4 audit requirements. Operations never carry secret values (CD-6 applies to the resulting document).

## Cost impact

Preview diffs enable pre-commit cost deltas (Chapter 16 tooling) but this IEP imposes none.

## Compatibility

Additive. Documents produced via operations are indistinguishable from hand-authored documents ([Chapter 19, §19.5](../chapters/19-ai-guidelines.md)).

## Migration

None; existing documents load into a CIM and are edited via operations thereafter.

## Alternatives considered

1. LLM writes full YAML, then validate-and-repair — rejected: unreviewable blast radius, unstable diffs, no per-change provenance.
2. JSON Patch (RFC 6902) against the document — considered: too low-level; patches express *where*, not *what*; no semantic validation unit, no confidence/assumption carrier.
3. Free-form function-calling per surface — rejected: divergent mutation paths break replayability.

## Rejected alternatives

Alternative 1 is categorically rejected by roadmap Phase 3 ("no unvalidated LLM-generated YAML is written to disk").

## Implementation plan

1. Operation types + JSON schema in `packages/intent-compiler` (blocked on Phase 2 CIM mutation/serialization contracts, roadmap §17.12).
2. Transactional dry-run apply + batch semantics.
3. Operation log with replay tests.
4. Adapter-facing structured-output enforcement; evaluation harness cases for invalid-operation rejection.

## Conformance requirements

- OP-1: no path exists by which model output is serialized to the document without passing the operation gate.
- OP-2: replaying a confirmed batch reproduces a byte-identical document (model-independence test: two adapters emitting the same batch yield the same IaP).
- OP-3: operations with assumptions or sub-threshold confidence cannot commit without recorded confirmation.
- OP-4: every field written by an operation has a CIM provenance record citing the operation id.

## Open questions

1. Should `UpdateResource` carry field-level merge semantics (RFC 7386 subset) or explicit per-field set/unset lists?
2. Is a `RenameResource` operation needed, given Chapter 13 treats rename as delete+create?
3. Standard confidence threshold default (0.8?) and whether policy can raise it per environment.

## Decision

Pending review.

## References

- [Chapter 1 — Architecture (§1.4)](../chapters/01-architecture.md)
- [Chapter 8 — Validation](../chapters/08-validation.md)
- [Chapter 19 — AI Guidelines](../chapters/19-ai-guidelines.md)
- IEP-0008 (Canonical Infrastructure Model), IEP-0013 (AI and MCP Trust Boundaries)
- Roadmap §6.1, Phase 3.1–3.5
