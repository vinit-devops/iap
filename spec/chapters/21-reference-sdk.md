# 21. Reference SDK

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter designs the reference SDK — the library that every conformant tool in the IaP ecosystem is expected to build on: the CLI ([Chapter 22](22-cli.md)), the language server ([Chapter 23](23-lsp.md)), CI integrations, and provider execution engines. The SDK is a **design**, not an implementation; this chapter is normative for the component contracts and the facade shape, and informative for the interface sketches.

## 21.1 Design Principles

### 21.1.1 Pure core

Every SDK engine is a **pure function** over the canonical document ([Chapter 1 §1.5](01-architecture.md)) plus explicitly versioned inputs. No engine performs ambient lookups: no network calls, no wall-clock reads, no environment inspection, no model inference. Anything an engine needs beyond the document — price snapshots, mapping artifacts, observed infrastructure state, policy bundles — is passed in as a versioned, content-addressable argument. This is the SDK-level restatement of the determinism principle ([Chapter 1 §1.2.2](01-architecture.md)) and the layer boundary ([Chapter 1 §1.4](01-architecture.md)): given identical inputs, every engine MUST produce byte-identical outputs.

Purity is what makes the conformance determinism tests ([Chapter 24](24-conformance.md)) possible: two independent implementations of the same engine contract, given the same inputs, are directly comparable.

### 21.1.2 Language-agnostic contract, single reference implementation

The component contracts in §21.3 are **language-neutral**: they are defined by input artifact, output artifact, and error-code range, all expressible as JSON values. A conformant SDK MAY be written in any language.

For the reference implementation, TypeScript is RECOMMENDED for ecosystem reach — it serves the CLI, the language server (LSP is natively at home in the Node ecosystem), browser-based editors, and CI runners from a single codebase. Nothing normative depends on this choice; the sketches in §21.4 are TypeScript-flavored solely for concreteness.

### 21.1.3 Findings, not exceptions

Engines never throw on document problems. Every engine returns its output artifact **plus** a list of *findings* — structured diagnostics carrying an IaP error code ([Chapter 8](08-validation.md)), severity, message, and source position. Exceptions are reserved for SDK misuse (e.g. passing a price snapshot to the parser). This keeps partial results available: an editor wants the AST and best-effort graph even when the document has errors.

### 21.1.4 Schema-driven, no bespoke knowledge

Field documentation, defaults, enum values, deprecation flags, and kind discrimination all live in the machine-readable schema (`schema/iap-v1.schema.json`, [Chapter 2](02-document-layout.md)) via `description`, `default`, `x-iap-since`, `x-iap-deprecated`, and `x-iap-capability` annotations. SDK components MUST derive this knowledge from the schema at build or load time rather than duplicating it in code, so that a schema revision is automatically reflected in every downstream tool.

## 21.2 Pipeline Overview

Components compose left-to-right; each consumes the artifact of its predecessor. The first five stages mirror validation phases 1–8 of [Chapter 8](08-validation.md); the remainder are the operational engines of Chapters 13–18.

```
source text
  → Parser → document AST
  → Profile Merger → canonical document
  → Schema Validator → findings (IAP1xx)
  → Reference/Relationship Engine → normalized edge set (IAP2xx/IAP3xx)
  → Dependency Engine → ordering DAG (IAP4xx)
  → Policy Engine → findings (IAP5xx)
  → Security Engine → derived grants (IAP6xx)
  → Compliance Engine → evidence report (IAP7xx)
  ├→ Cost Engine → cost annotations
  ├→ Diagram Generator → derived views
  └→ Planner → execution plan
       ├→ Deployment Planner → waves + rollback plan
       └→ Drift Engine → drift report
```

## 21.3 Component Contracts

Each component is specified as *(input) → (output)*. All outputs are deterministic per §21.1.1.

**Parser.** *(YAML or JSON source text)* → *(document AST with source positions)*. The AST preserves, for every node, its byte offset, line, and column, plus key ordering as authored. The parser accepts syntactically valid YAML/JSON only; syntax errors are findings with position but no code range (they precede the pipeline). The parser MUST NOT resolve defaults, merge profiles, or interpret semantics — it is a lossless lift of text into a positioned tree, and it is the sole component that ever sees source text.

**Schema Validator.** *(AST, core schema, registered extension sub-schemas)* → *(IAP1xx findings)*. Validates the document against JSON Schema draft 2020-12, mapping each schema violation to an IAP1xx code and the AST position of the offending node. Runs against both the raw document and (after merging) the canonical document, since a profile merge MUST itself yield a valid document ([Chapter 6](06-profiles.md)).

**Reference/Relationship Engine.** *(canonical document)* → *(normalized edge set; IAP2xx/IAP3xx findings)*. Resolves every identifier reference (relationship targets, `outputs.resource`, `Application.components`, profile `extends`, `tls.certificate`) and normalizes inline edges and selector rule edges into the single canonical edge model `(source, type, target, attributes)` per [Chapter 4 §4.7](04-relationship-model.md), including the lexicographic selector expansion order. Dangling references are IAP2xx (IAP201–IAP204); verb/attribute shape violations are IAP3xx (IAP301/IAP302).

**Dependency Engine.** *(normalized edge set)* → *(ordering DAG; IAP4xx findings)*. Derives ordering arcs per [Chapter 9](09-dependency-model.md) (every verb except `replicatesTo` implies *target before source*), detects cycles (IAP401, reported with the full cycle path), and emits the DAG with a deterministic topological ordering (ties broken lexicographically by resource identifier).

**Profile Merger.** *(raw document, selected profile name)* → *(canonical document)*. Applies RFC 7386 JSON Merge Patch in the order base → `extends` chain (root first) → selected profile, then normalizes quantities and key order into canonical form. The merger is the only component that understands profiles; every downstream engine sees a profile-free canonical document.

**Policy Engine.** *(canonical document, normalized edge set, active policy set — document policies plus compliance-activated bundles)* → *(IAP5xx findings)*. Evaluates each policy's condition tree against each targeted resource per [Chapter 7](07-policy-language.md). `deny` violations are error-severity findings; `warn` violations are warnings; `require` violations are errors that MAY carry a deterministic autofix patch (consumed by the LSP's code actions, [Chapter 23](23-lsp.md)).

**Security Engine.** *(canonical document, normalized edge set)* → *(derived grant set; IAP6xx findings)*. Computes least-privilege grants from relationship `access` attributes and verb semantics per [Chapter 15](15-security-model.md) — e.g. `connectsTo` with `access: read` yields a read-only grant from the source's Identity to the target — and the network reachability matrix from `exposure` plus `connectsTo`/`routesTo` edges. Findings flag contradictions such as a `public` exposure on a resource no gateway routes to, or an edge requiring a grant no Identity can carry.

**Compliance Engine.** *(canonical document, findings from prior phases, framework registry)* → *(IAP7xx findings; evidence report)*. Maps declared `compliance.frameworks` to their policy bundles ([Chapter 17](17-compliance-model.md)) and produces a machine-readable evidence report: per control, the resources in scope, the satisfying field values or edges, and pass/fail status.

**Cost Engine.** *(canonical document, price snapshot)* → *(cost annotations)*. Annotates each resource and the document total with estimated monthly/hourly cost per [Chapter 16](16-cost-model.md). The price snapshot is a versioned, content-hashed input artifact (typically produced via MCP enrichment, [Chapter 20](20-mcp-integration.md)); the engine itself never fetches prices. Identical document + identical snapshot → identical annotations.

**Diagram Generator.** *(normalized edge set, canonical document)* → *(derived views as Mermaid and DOT)*. Renders the five derived views of [Chapter 18](18-architecture-model.md) — architecture, dependency, network, security, application — from the graph alone. There is no manual diagram input.

**Planner.** *(ordering DAG, infrastructure model, mapping artifacts)* → *(execution plan)*. Diffs desired state (canonical document through mappings) against the infrastructure model ([Chapter 13](13-infrastructure-model.md)) and emits an ordered set of create/update/replace/delete actions per [Chapter 14](14-planning-model.md). Plans are content-hashed over their canonical serialization.

**Drift Engine.** *(observed state snapshot, infrastructure model)* → *(drift report)*. Classifies divergence between observed reality and the model: intent drift (field changed), unmanaged drift (object exists outside the model), missing (object gone). Observation itself happens outside the SDK; the engine consumes a snapshot.

**Deployment Planner.** *(execution plan)* → *(wave schedule + rollback plan)*. Partitions plan actions into maximally parallel waves respecting the DAG, and derives the reverse-order rollback plan and per-wave failure-recovery boundaries ([Chapter 14](14-planning-model.md)).

## 21.4 Facade and Finding Type (interface sketch, informative)

```typescript
interface IaPSDK {
  parse(source: string, format?: "yaml" | "json"): ParseResult;
  merge(doc: DocumentAST, profile?: string): CanonicalDocument;
  validate(doc: CanonicalDocument, opts?: ValidateOptions): Finding[];   // phases 1–8
  plan(doc: CanonicalDocument, state: InfrastructureModel,
       mappings: MappingArtifact[]): PlanResult;
  diagram(doc: CanonicalDocument,
          view: "architecture" | "dependency" | "network" | "security" | "application",
          format?: "mermaid" | "dot"): string;
  cost(doc: CanonicalDocument, snapshot: PriceSnapshot): CostReport;
  evidence(doc: CanonicalDocument, framework?: FrameworkId): EvidenceReport;

  registerExtension(pkg: ExtensionPackage): void;                        // §21.5
}

interface Finding {
  code: string;                       // "IAP201"
  severity: "error" | "warning" | "info";
  message: string;                    // human-readable, deterministic text
  path: string;                       // JSON Pointer into the canonical document
  position?: SourcePosition;          // line/column in authored source, when known
  resource?: string;                  // resource identifier, when applicable
  fix?: JsonMergePatch;               // deterministic autofix (require-effect policies)
}
```

Facade methods compose the §21.3 components; a facade MUST NOT add behavior a caller could not reproduce by invoking the components directly.

## 21.5 Extension Loading

An **extension package** is a versioned bundle a host registers with the SDK before parsing. It MAY contribute: sub-schemas validating its `extensions.<ns>` blocks, mapping artifacts ([Chapter 12](12-provider-mapping.md)), cost models/price snapshot schemas, additional security or policy rules, and documentation/icon metadata ([Chapter 11](11-extension-framework.md)). Registration is explicit and ordered; the SDK MUST reject two packages claiming the same namespace. Per the Extension Non-Interference Rule, a registered extension MUST NOT alter core semantics: core validation results with and without any set of extensions loaded MUST be identical except for findings scoped inside `extensions.<ns>` blocks. Unknown namespaces produce IAP8xx warnings, never errors.

## 21.6 Stability Contract

SDK **major** versions track specification majors: SDK 1.x consumes `iap.dev/v1` documents, and a document valid under spec 1.n MUST validate identically under every SDK 1.m with m ≥ n. Component contracts (§21.3) — artifact shapes and error-code ranges — are frozen within a major; minors MAY add components, optional inputs, and finding codes within the [Chapter 8](08-validation.md) ranges, but MUST NOT change the output of any existing component for an existing valid input. The `iap migrate` transform for major boundaries ([Chapter 10](10-versioning.md)) ships as an SDK component like any other: a pure function from a v*N* document to a v*N+1* document.
