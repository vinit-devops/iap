# 16. Cost Model

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter defines how cost information attaches to IaP documents. Cost is an **annotation layer computed by tooling**: the core document describes intent, and cost tooling projects prices onto that intent. This chapter is normative for the annotation interface and budget-policy semantics; the report field vocabulary is normative for tools that emit cost reports.

## 16.1 Cost Is an Annotation, Never Content

The core document MUST NOT contain prices, rates, or currency amounts. Cost depends on provider, region, term, and time — all binding decisions that occur to the right of the intent document ([Chapter 1, §1.3](01-architecture.md)). Embedding prices would couple the document to one provider's commercial terms and break determinism across time.

Instead, conformant cost tooling computes a **cost report** from three inputs:

1. the canonical document with the active profile merged ([Chapter 6](06-profiles.md)),
2. a **mapping cost model** — cost functions distributed with a provider mapping artifact ([Chapter 12](12-provider-mapping.md)) that price each supported kind/field combination,
3. a **price snapshot** — a versioned capture of provider list prices, obtainable via MCP pricing sources ([Chapter 20](20-mcp-integration.md)) or vendored files.

Tools MAY surface the report inline by attaching `x-iap-cost` annotation objects to resources in *derived* artifacts (annotated plan output, LSP hovers, diffs). Such annotations are tool output; writing them back into the source document is NOT RECOMMENDED, and validators MUST ignore them for all semantic purposes.

## 16.2 Per-Resource Cost Fields

A cost report entry for a resource contains:

| Field | Type | Meaning |
|---|---|---|
| `estimatedMonthly` | number | Projected cost per 730-hour month |
| `estimatedHourly` | number | Projected cost per hour |
| `currency` | string | ISO 4217 code; one currency per report |
| `confidence` | `exact` \| `estimate` \| `unknown` | `exact`: price fully determined by declared fields; `estimate`: usage-dependent, priced from stated assumptions; `unknown`: the cost model does not cover this resource |
| `assumptions` | string list | Every usage assumption behind an `estimate` (e.g. request volume, storage growth, egress) |

`confidence: unknown` entries MUST report no numbers rather than a guess; document roll-ups that include `unknown` entries MUST be flagged as lower bounds.

## 16.3 Roll-Up

Reports MUST support aggregation of `estimatedMonthly` **per application** (over each `Application`'s `components`), **per label** (any label key/value pair), and **per profile** (one report per profile, since profiles change resources and sizes). Roll-up confidence is the weakest member confidence.

## 16.4 Optimization Suggestions

Cost tooling MAY emit suggestions. Every suggestion MUST come from a **deterministic rule** over the document (and, where available, observed utilization supplied as a versioned input) — never from model inference ([Chapter 19](19-ai-guidelines.md)). Representative rules:

- **Oversizing** — declared `size` exceeds what observed utilization supports (e.g. `l` with sustained utilization consistent with `s`).
- **Excess availability** — a resource declares `availability` higher than the active profile's floor requires.
- **Orphaned resources** — data or messaging resources with no inbound edge from any workload ([Chapter 4](04-relationship-model.md)).

Each suggestion carries the rule id, the resource path, and the projected delta. Suggestions are advisory: tools MUST NOT modify the document; a human (or AI assistant, at the authoring layer only) applies them as document diffs.

## 16.5 Reserved and Committed-Use Savings

Where a mapping cost model can price term commitments, tooling SHOULD surface the savings as suggestions with the commitment term in `assumptions`. Commitments are financial decisions: they MUST be surfaced as suggestions and MUST NOT be applied automatically to plans or purchases.

## 16.6 Carbon Footprint (Optional)

Tools MAY emit a parallel `x-iap-carbon` annotation with the identical structure and semantics: `estimatedMonthly` in **gCO2e/month**, the same `confidence` enum, the same `assumptions` discipline, and roll-up rules. Carbon data enters via mapping carbon models and versioned intensity snapshots, exactly as prices do.

## 16.7 Budget Validation

Budgets are ordinary policies ([Chapter 7](07-policy-language.md)) — no separate budget mechanism exists. A budget policy uses `greater-than` over the cost annotation path, and carries its threshold in `params` so tooling can display and roll it up:

```yaml
policies:
  - id: db-monthly-budget
    description: No single database may exceed 300 USD per month.
    target:
      kinds: [Database]
    rule:
      field: x-iap-cost.estimatedMonthly
      operator: greater-than
      value: 300
    effect: deny
    params:
      maxMonthly: 300
      currency: USD
```

Evaluation semantics are normative:

- Cost annotations exist only after cost computation, so budget policies are evaluated **at plan time**, when the annotated plan carries `x-iap-cost` on each resource. At validation time (no annotations), the `field` path is absent and the rule cannot match; tools SHOULD report budget policies as *not yet evaluated* rather than passed.
- A matching `deny` budget rule fails the plan with error **IAP505** (`budget-exceeded`), naming the policy id, the resource path, the annotated amount, and the `params` threshold.
- Resources with `confidence: unknown` MUST be reported as unevaluable against the budget (a warning), never silently passed.
- Document-level budgets target the roll-up: a policy with `target.kinds: [Application]` and `params.maxMonthly` is evaluated against the application's aggregated `x-iap-cost.estimatedMonthly`.

## 16.8 Cost Report Sketch (Informative)

```json
{
  "reportVersion": "1",
  "document": "orders",
  "profile": "production",
  "priceSnapshot": "example-cloud-list-2026-07-01T00:00:00Z#sha256:9f2c…",
  "costModel": "example-cloud-reference@1.3.0",
  "currency": "USD",
  "resources": {
    "orders-db": {
      "estimatedMonthly": 264.90,
      "estimatedHourly": 0.3629,
      "confidence": "estimate",
      "assumptions": ["storage grows to declared 100Gi", "multi-zone per availability: high"]
    },
    "orders-api": {
      "estimatedMonthly": 118.26,
      "estimatedHourly": 0.1620,
      "confidence": "estimate",
      "assumptions": ["mean 2 replicas of size m within scaling 1..4"]
    }
  },
  "rollups": {
    "byApplication": { "orders": 383.16 },
    "byLabel": { "tier=data": 264.90 }
  },
  "suggestions": [
    {
      "rule": "excess-availability",
      "resource": "orders-db",
      "detail": "availability: high exceeds the development profile requirement (standard)",
      "estimatedMonthlySavings": 121.40
    }
  ]
}
```

## 16.9 Determinism

Cost reporting is a pure function: **the same canonical document, the same mapping cost model version, and the same price snapshot id MUST produce a byte-identical report** ([Chapter 1, §1.2.2](01-architecture.md)). Price snapshots are versioned, content-addressed inputs — never live lookups at computation time; MCP pricing sources ([Chapter 20](20-mcp-integration.md)) are used to *produce and refresh snapshots*, not to answer per-run queries. Report changes are therefore always attributable: the document changed, the cost model changed, or the snapshot changed.
