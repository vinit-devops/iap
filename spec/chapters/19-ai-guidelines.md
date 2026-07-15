# 19. AI Guidelines

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

IaP is designed to be safe for AI systems to author — and that safety comes from a single structural rule, not from trust in any model. This chapter makes the rule normative: AI participates on exactly one side of the layer boundary defined in [Chapter 1](01-architecture.md), and never crosses it.

## 19.1 The Boundary, Restated

The Layer Boundary Invariant ([Chapter 1](01-architecture.md), §1.4) governs this entire chapter:

> AI systems MAY generate, validate, suggest, explain, and document intent documents. Everything to the right of the intent document — normalization, validation, policy evaluation, planning, mapping, and execution — MUST be performed exclusively by deterministic tooling.

An "AI system" here means any component whose output is produced by model inference rather than by a specified, reproducible algorithm. The rule is positional, not qualitative: it does not matter how capable, well-aligned, or heavily reviewed an AI system is — its outputs enter an IaP toolchain only as (candidate) intent documents, document diffs, or prose.

## 19.2 What AI Systems MAY Do

An AI system operating within an IaP toolchain MAY:

1. **Generate** IaP documents and document diffs, in whole or in part, from natural-language requirements or existing systems.
2. **Invoke validation and linting** — by running the deterministic pipeline of [Chapter 8](08-validation.md) as a tool and relaying its output. The AI invokes the validator; it never *is* the validator.
3. **Suggest improvements** — cost, security, resilience, or style recommendations expressed as document diffs for human review.
4. **Explain** documents: describe what a document declares, what its derived views ([Chapter 18](18-architecture-model.md)) show, why validation failed, or what a policy finding means.
5. **Produce documentation** — prose, runbooks, and review summaries derived from documents.
6. **Ask clarifying questions** when requirements are ambiguous, rather than resolving ambiguity by guessing (§19.6).

## 19.3 What AI Systems MUST NEVER Do

An AI system MUST NOT, under any configuration of a conforming toolchain:

1. **Execute infrastructure changes**, directly or by driving an execution engine.
2. **Produce provider plans.** Plans are the output of the pure mapping function of [Chapter 12](12-provider-mapping.md); a plan of AI provenance is not a plan, it is a guess.
3. **Resolve mappings** — select, interpolate, or fill gaps in kind/field/value coverage. Mapping coverage is fail-closed; the answer to an unmapped construct is a mapping error, never an inference.
4. **Mutate the infrastructure model or state** ([Chapter 13](13-infrastructure-model.md)) — including "repairing" state, marking drift resolved, or editing deployment history.
5. **Occupy any position to the right of the intent document** in the layer chain: normalization, validation logic, policy evaluation, dependency derivation, planning, mapping, or execution.

## 19.4 Rationale (non-normative)

- **Determinism.** Every layer right of the document is a pure function so that identical inputs yield identical outcomes. Model inference is not a pure function; admitting it anywhere in the chain destroys the reproducibility that hashing, plan caching, and conformance testing ([Chapter 24](24-conformance.md)) depend on.
- **Auditability.** Because the document alone determines all downstream behavior, review of the document is review of everything. If AI could influence later layers, auditors would need to review model behavior — which cannot be diffed, pinned, or replayed.
- **Blast radius.** An AI error confined to a document is caught by schema validation, policy evaluation, and human review before anything exists. An AI error in planning or execution is an outage. The boundary converts model fallibility from an operational risk into an authoring inconvenience.

## 19.5 Conformance Implications

- A tool or pipeline that allows AI output to flow into execution **without passing through the full deterministic validation pipeline** of [Chapter 8](08-validation.md) is **non-conformant**, regardless of any human approval steps it adds elsewhere.
- Once a document validates, it is an IaP document, full stop: **AI-generated and human-authored documents are indistinguishable** to every conforming validator, planner, and mapping. v1 imposes **no provenance requirement** — no watermark, no authorship field, no differential treatment.
- Tools MAY record authorship in `metadata.annotations` (e.g. `authored-by: assistant/model-name`). Annotations are never semantic ([Chapter 2](02-document-layout.md)): a conforming tool MUST NOT change validation, planning, or approval behavior based on such a record.

## 19.6 Human Review Gates

Two findings require **human approval regardless of how the document was authored** — they gate humans and AI systems identically:

1. **Deny-effect policy findings.** A plan MUST NOT proceed over a `deny` policy result ([Chapter 7](07-policy-language.md)); only a human may amend the document or the policy.
2. **Stateful replacements.** Any plan step that replaces (destroys and recreates) a stateful resource — `Database`, `ObjectStore`, `Volume`, `Queue`, `Topic`, `Secret` — requires explicit human approval ([Chapter 14](14-planning-model.md)).

An AI system MUST NOT act as the approver for either gate, and MUST NOT be used to satisfy, simulate, or bypass an approval step.

## 19.7 Guidance for AI Authors

An AI system generating IaP documents SHOULD follow these practices; toolchain vendors SHOULD encode them in system instructions:

- **Prefer intent fields over extensions.** Express requirements in core vocabulary first; reach for `extensions:` only for genuinely provider-specific refinement, and never to smuggle in semantics (Extension Non-Interference Rule, [Chapter 11](11-extension-framework.md)).
- **Never invent kinds, fields, verbs, or enum values.** The kind set, relationship verbs, and field vocabulary are closed in v1; an unrecognized construct is a hallucination, not a proposal. Validate against the published schema, not against memory.
- **Ask rather than guess.** When intent is ambiguous — availability tier, exposure, retention, engine — ask the human. A clarifying question costs seconds; a silently guessed `exposure: public` costs an incident.
- **Cite validation output.** Claims that a document is valid, or explanations of why it is not, MUST be grounded in actual output of the deterministic validator, quoted with its error codes — never asserted from the model's own judgment.
