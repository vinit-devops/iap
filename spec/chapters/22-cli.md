# 22. CLI

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter designs `iap`, the reference command-line interface. The CLI is a thin shell over the reference SDK ([Chapter 21](21-reference-sdk.md)): every command invokes SDK components and formats their artifacts; the CLI adds no semantics of its own. This chapter is normative for command behavior, exit codes, and the plan/deploy safety contract; sample outputs are informative.

## 22.1 Global Conventions

- **Input.** Every command reads `infrastructure.iap.yaml` in the working directory by default; `--file <path>` (`-f`) overrides. JSON documents are accepted wherever YAML is.
- **Profile.** `--profile <name>` selects the active profile. For `plan` and `deploy`, `--profile` is REQUIRED whenever the document declares any profiles — an ambiguous merge MUST NOT be guessed. Commands that only inspect (`validate`, `graph`, `diagram`, …) default to the unmerged base document and accept `--profile` to inspect a merged view.
- **Output.** `--output human|json|sarif` (`-o`, default `human`). `json` emits the underlying SDK artifact verbatim; `sarif` emits findings as SARIF 2.1.0 for CI and code-scanning integrations. Machine outputs are canonical-form serializations and therefore byte-stable across runs.
- **Exit codes.** `0` success; `1` error-severity findings were produced (warnings alone do not affect the exit code unless `--strict`); `2` usage error (unknown flag, missing required `--profile`, unreadable file); `3` plan or apply failure at execution time.
- **Determinism.** Plan artifacts are content-hashed over their canonical serialization; `deploy` verifies the hash before acting (§22.2.8). Identical inputs produce byte-identical machine output for every command.

## 22.2 Command Reference

### 22.2.1 `iap validate`

```
iap validate [-f FILE] [--profile NAME] [-o FORMAT] [--strict]
```

Runs the full validation pipeline, phases 1–8 of [Chapter 8](08-validation.md): schema → reference → relationship → dependency/cycle → policy → security → compliance → version. `--strict` treats warnings as errors. With `--profile`, validation runs against the merged canonical document (and additionally verifies the merge itself is valid).

```
$ iap validate --profile production
✔ schema          0 findings
✖ reference       1 finding
    IAP201 error  resources.api.relationships[1].target
                  target "cachee" does not exist in the profile-merged document
– relationship    skipped (reference errors)
✔ dependency      0 findings
⚠ policy          1 finding
    IAP5xx warn   resources.reports-store
                  policy "require-versioning" — versioning is "disabled"
1 error, 1 warning · exit 1
```

### 22.2.2 `iap plan`

```
iap plan --profile NAME [-f FILE] [--against SOURCE] [--out plan.iap-plan.json]
         [--snapshot ID] [-o FORMAT]
```

Produces an execution plan: the diff against current state, ordered into waves ([Chapter 14](14-planning-model.md)), plus the derived grant delta ([Chapter 15](15-security-model.md)) and — when a price snapshot is available — the cost delta ([Chapter 16](16-cost-model.md)). `--against` names the infrastructure-model state source ([Chapter 13](13-infrastructure-model.md)); absent state, everything plans as create. `--out` writes the reviewable plan artifact; its content hash is printed and embedded in the artifact.

```
$ iap plan --profile production --against ./state --out plan.iap-plan.json
Plan: 3 to create, 1 to update, 0 to delete
  wave 1  + db (Database)            + identity-api (Identity)
  wave 2  ~ api (Service)            scaling.max: 3 → 6
  wave 3  + gateway (Gateway)
Grants:   + identity-api → db  read-write
Cost:     +$212.40/mo (snapshot prices-2026-07-01)
Plan hash: sha256:9f2c…e1a0 → plan.iap-plan.json
```

### 22.2.3 `iap graph`

```
iap graph [-f FILE] [--profile NAME] [-o human|json|dot]
```

Emits the normalized canonical edge set ([Chapter 4 §4.7](04-relationship-model.md)) — inline edges and expanded rule edges — as text, JSON, or DOT.

```
$ iap graph
api      connectsTo    db       tcp/5432  read-write
api      connectsTo    cache    tcp/6379  read-write
gateway  routesTo      api      https/443 path=/
```

### 22.2.4 `iap diagram`

```
iap diagram --view architecture|dependency|network|security|application
            [-f FILE] [--profile NAME] [-o mermaid|dot] [--out FILE]
```

Renders one of the five derived views of [Chapter 18](18-architecture-model.md) via the Diagram Generator. There is no flag to inject manual layout or content: diagrams are pure derivations.

```
$ iap diagram --view dependency -o mermaid
graph LR
  db --> api
  cache --> api
  api --> gateway
```

### 22.2.5 `iap cost`

```
iap cost [-f FILE] [--profile NAME] --snapshot ID [-o FORMAT]
```

Annotates the document with cost estimates from the identified price snapshot ([Chapter 16](16-cost-model.md)). `--snapshot` is required; the CLI never fetches live prices — snapshots are acquired out-of-band (e.g. via MCP enrichment, [Chapter 20](20-mcp-integration.md)) so the command stays pure.

```
$ iap cost --profile production --snapshot prices-2026-07-01
db        Database   $164.30/mo
api       Service    $87.10/mo   (2× m, scaling 2–6)
total                $274.55/mo  ± mapping variance
```

### 22.2.6 `iap security`

```
iap security [-f FILE] [--profile NAME] [-o FORMAT]
```

Prints the derived least-privilege grant set and network reachability matrix, plus IAP6xx findings ([Chapter 15](15-security-model.md)).

```
$ iap security
Grants (derived, least-privilege):
  identity-api → db      read-write   (from api connectsTo db, access: read-write)
  identity-api → secrets read         (from api protectedBy app-secret)
Findings:
  IAP6xx warn  resources.admin — exposure "public" but no gateway routesTo it
```

### 22.2.7 `iap compliance`

```
iap compliance [-f FILE] [--profile NAME] [--framework ID] [-o FORMAT]
               [--evidence FILE]
```

Evaluates the policy bundles activated by `compliance.frameworks` ([Chapter 17](17-compliance-model.md)), optionally filtered to one framework, and writes the machine-readable evidence report with `--evidence`.

```
$ iap compliance --framework pci-dss-4.0
pci-dss-4.0: 41 controls in scope · 39 satisfied · 2 failing
  ✖ 3.5.1  resources.legacy-db  encryption.atRest is "preferred", control requires "required"
```

### 22.2.8 `iap deploy`

```
iap deploy --plan plan.iap-plan.json [--auto-approve]
```

Executes a previously produced plan artifact — **only** that. `deploy` re-derives nothing: it verifies the plan file's embedded content hash against the current document, profile, mappings, and state source, and refuses (exit 2) if anything changed since the plan was reviewed. Deploying without a plan file requires `--auto-approve`, which composes `plan` and immediate execution; this is DISCOURAGED and MUST print a prominent warning. There is no bypass tied to authorship: documents authored by AI systems ([Chapter 19](19-ai-guidelines.md)) follow exactly this path — the reviewed-plan gate is the human checkpoint, and no flag exempts any author from it.

```
$ iap deploy --plan plan.iap-plan.json
Verified plan hash sha256:9f2c…e1a0 against current inputs ✔
wave 1/3  db ✔  identity-api ✔
wave 2/3  api ✔
wave 3/3  gateway ✔
Deployed revision 14 · recorded in deployment history
```

### 22.2.9 `iap rollback`

```
iap rollback --to REVISION [--plan-only]
```

Plans and executes the reverse transition to a prior revision from the deployment history ([Chapter 13](13-infrastructure-model.md)), using the Deployment Planner's rollback derivation. `--plan-only` emits the rollback plan artifact for review without executing — the same review-then-deploy contract as §22.2.8.

### 22.2.10 `iap drift`

```
iap drift [--against SOURCE] [-o FORMAT]
```

Compares an observed state snapshot with the infrastructure model and classifies each divergence — intent drift, unmanaged drift, missing — per [Chapter 14](14-planning-model.md). Exit `1` when drift is found.

```
$ iap drift --against ./state
~ db     capacity.storage  model 100Gi · observed 250Gi   (intent drift)
+ ?      unmanaged object adjacent to gateway              (unmanaged)
2 drift items · exit 1
```

### 22.2.11 `iap migrate`

```
iap migrate --to iap.dev/v2 [-f FILE] [--write]
```

Applies the deterministic major-version document transform ([Chapter 10](10-versioning.md)). Without `--write`, prints the transformed document to stdout; with it, rewrites the file. Migration output is byte-stable and idempotent.

### 22.2.12 `iap fmt`

```
iap fmt [-f FILE] [--check] [--write]
```

Rewrites the document into canonical form ([Chapter 1 §1.5](01-architecture.md)): UTF-8, sorted keys, normalized quantities. `--check` exits `1` if the file is not already canonical (for CI), changing nothing. Comments in YAML source are preserved where the underlying parser retains positions; semantic content is never altered.

## 22.3 Composition (informative)

The commands mirror SDK facade methods one-to-one (`validate` → `validate()`, `plan` → `plan()`, …), so a CI pipeline scripting the CLI and a service embedding the SDK are guaranteed identical results: same inputs, same findings, same hashes.
