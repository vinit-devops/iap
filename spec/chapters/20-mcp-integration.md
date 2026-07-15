# 20. MCP Integration

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

IaP toolchains need external knowledge — current prices, current security advisories, current provider documentation, an organization's current policy library. The Model Context Protocol (MCP) is the recommended integration surface for that knowledge. This chapter fixes the role of MCP servers in an IaP toolchain: they are **authoritative knowledge sources that enrich validation and recommendations — never participants in execution**, and never a source of nondeterminism in planning.

## 20.1 Position in the Architecture

MCP servers attach to the *tooling* around the layer chain of [Chapter 1](01-architecture.md); they do not occupy a layer. Knowledge flows from MCP servers into editors, validators, recommendation engines, and rule/price snapshot stores. Nothing flows from an MCP server into normalization, planning, mapping, or execution at run time, and nothing flows back out toward infrastructure: an MCP server in an IaP toolchain is read-only with respect to the world.

The deterministic pipeline consumes MCP-sourced knowledge only in one form: **versioned, pinned artifacts** (price snapshots, rule bundles, policy bundles, profile libraries) that are fetched out-of-band, given a version identity, and thereafter behave exactly like any other input file. Live MCP calls happen when a human or a scheduled refresh updates such an artifact — never inside `validate`, `plan`, or `deploy`.

## 20.2 Integration Points

### 20.2.1 Documentation sources

Provider documentation MCP servers — for example an AWS Documentation MCP server, a Microsoft Learn MCP server, or a Google Cloud documentation MCP server — serve as knowledge sources for the *humans and AI assistants* working on documents and mappings. They inform hover documentation and completion detail in the language server ([Chapter 23](23-lsp.md)), suggestion and explanation text, and the research a mapping author does when deciding coverage. Documentation content is prose for people; it MUST NOT alter validation results, derived views, or plan output. (This is the one context in which provider names legitimately appear in an IaP toolchain's user interface: as the names of documentation sources, per [Chapter 11](11-extension-framework.md).)

### 20.2.2 Pricing sources

Pricing MCP servers feed the cost model's **price snapshots** ([Chapter 16](16-cost-model.md)). A snapshot is a versioned, cached artifact: it records the prices retrieved, the source, and a snapshot identifier. Cost estimation and budget-policy evaluation are pure functions of the canonical document, the mapping set, and the pinned snapshot set — so plans and cost reports are reproducible even as market prices move. A live MCP call occurs **at snapshot refresh time only**, never at plan time; two plans run against the same snapshot set MUST report identical costs.

### 20.2.3 Well-architected and best-practice sources

Best-practice MCP servers (well-architected guidance, framework review tooling, internal architecture standards) feed **recommendation engines**: "this document declares `availability: maximum` but `resilience.backup` is unset", "consider a `Cache` in front of this read-heavy `Database`". Their output is advisory only. Recommendations sourced from MCP knowledge MUST surface at **warn level at most** — they MUST NOT produce deny-effect findings, block validation, or modify a document without human review. A hard requirement belongs in a policy ([Chapter 7](07-policy-language.md)), where it is versioned, reviewable, and deterministic.

### 20.2.4 Security advisory sources

Security advisory MCP servers supply updates to security validation ([Chapter 15](15-security-model.md)) — newly deprecated protocol versions, weakened algorithms, engine versions under advisory. Updates enter the toolchain as **versioned rule bundles**: the advisory feed is consulted at bundle refresh, the bundle gets a version, and security validation runs deterministically against the pinned bundle. A validation report MUST identify the rule-bundle version it used, so any finding can be reproduced.

### 20.2.5 Enterprise sources

Enterprise MCP servers supply organization-specific governance: policy bundles ([Chapter 7](07-policy-language.md), [Chapter 17](17-compliance-model.md)), profile libraries ([Chapter 6](06-profiles.md)), approved engine/version lists, and naming conventions. This lets a central platform team publish "how we build here" once and have every editor, validator, and AI assistant in the organization consume it — again as versioned artifacts, pinned per document repository or per pipeline run.

## 20.3 Normative Constraints

1. **Plan invariance.** For a fixed canonical document, mapping set, and pinned snapshot/bundle set, MCP data MUST NOT change plan output. If two runs differ, the toolchain has let a live lookup into the pipeline and is non-conformant ([Chapter 24](24-conformance.md)).
2. **Graceful degradation.** MCP unavailability MUST NOT fail validation or planning. Validation completes against the last pinned bundles; enrichment (hover docs, recommendations, fresh advisories) is marked **unavailable**, and reports SHOULD note the age of the snapshots used. A stale price is a caveat; a blocked pipeline is a failure mode IaP does not permit MCP to introduce.
3. **No mutation path.** No MCP server in an IaP toolchain is ever granted credentials for, or invoked to perform, infrastructure mutation. MCP servers that expose mutating capabilities MUST NOT be connected to IaP tooling in a configuration where those capabilities are callable. This is the MCP-specific corollary of the layer boundary in [Chapter 19](19-ai-guidelines.md): knowledge in, nothing out.
4. **Provenance.** Every artifact derived from MCP data (snapshot, rule bundle, policy bundle, profile library) MUST carry a version identifier and SHOULD record its source and retrieval time, so that any validation or cost result can name the exact knowledge it was computed from.

## 20.4 Summary Table

| MCP source type | Enriches | Never does |
|---|---|---|
| Provider documentation | Hover/completion docs ([Chapter 23](23-lsp.md)), suggestion and explanation text, mapping-author research | Alter validation results, derived views, or plan output |
| Pricing | Versioned price snapshots for cost estimates and budget policies ([Chapter 16](16-cost-model.md)) | Live plan-time price lookups; change plan output under a fixed snapshot set |
| Well-architected / best practice | Warn-level recommendations and improvement suggestions | Deny-effect findings; block validation; unreviewed document changes |
| Security advisory | Versioned security rule-bundle updates ([Chapter 15](15-security-model.md)) | Unversioned live checks at plan time; direct plan or document mutation |
| Enterprise / organizational | Policy bundles ([Chapter 7](07-policy-language.md), [Chapter 17](17-compliance-model.md)), profile libraries ([Chapter 6](06-profiles.md)), approved-value lists | Receive infrastructure credentials; perform mutation; approve deployments |

The pattern across every row is identical: MCP servers make IaP tooling *smarter* — better documentation, fresher prices, current advisories, organizational context — while the deterministic core stays exactly as dumb, and exactly as reproducible, as [Chapter 1](01-architecture.md) requires.
