# Infrastructure as Prompt (IaP)

**Version 1.0.0 · Status: Draft · `apiVersion: iap.dev/v1`**

The Infrastructure as Prompt is an open, cloud-agnostic, deterministic specification for describing **what infrastructure should exist** — independent of any cloud provider or implementation. IaP is to infrastructure what OpenAPI is to HTTP APIs: a stable, versioned, machine-readable contract that an ecosystem of validators, planners, IDE integrations, visual designers, and deployment engines can consume.

An IaP document describes intent:

```yaml
apiVersion: iap.dev/v1
metadata:
  name: order-platform
  owner: team-payments
resources:
  api:
    kind: Service
    spec:
      artifact: { type: container-image, reference: registry.example.com/api:2.1.0 }
      size: m
      availability: high
    relationships:
      - type: connectsTo
        target: orders-db
        port: 5432
        protocol: tcp
        access: read-write
  orders-db:
    kind: Database
    spec:
      class: relational
      engine: postgresql
      availability: high
      encryption: { atRest: required, inTransit: required }
```

No VPCs, no instance types, no provider products. The same document can be realized on AWS, Azure, GCP, Kubernetes, or on-premises through deterministic **provider mappings** — and every realization must satisfy the same intent.

## Core principles

1. **Intent over implementation** — documents say _what_ (private network, relational database, high availability), never _how_ (route tables, parameter groups).
2. **Cloud agnostic** — no provider concept appears in the core specification; provider refinements live in namespaced, removable `extensions`.
3. **Deterministic** — every field has a definition, allowed values, and a default; identical inputs produce identical plans. No AI interpretation is ever required or permitted in the execution path.
4. **Human readable** — infrastructure is reviewable by engineers with no cloud-specific knowledge.
5. **Extensible** — providers add capabilities through versioned extensions and mappings without ever changing the core.

## Specification

| #   | Chapter                                                          | Contents                                                                                            |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | [Architecture](spec/chapters/01-architecture.md)                 | Philosophy, layer boundary, canonical form, comparisons (Terraform, Kubernetes, Pulumi, Crossplane) |
| 2   | [Document Layout](spec/chapters/02-document-layout.md)           | Top-level keys, resource entry shape, identifier grammar, RFC 2119 conventions                      |
| 3   | [Resource Model](spec/chapters/03-resource-model.md)             | The 13 core kinds, shared intent vocabulary, abstract outputs                                       |
| 4   | [Relationship Model](spec/chapters/04-relationship-model.md)     | The ten relationship verbs, edge attributes, graph normalization                                    |
| 5   | [Capability Model](spec/chapters/05-capability-model.md)         | Capability families, kind registry, reserved kinds                                                  |
| 6   | [Profiles](spec/chapters/06-profiles.md)                         | Overlays, RFC 7386 merge semantics, built-in profile library                                        |
| 7   | [Policy Language](spec/chapters/07-policy-language.md)           | Declarative governance rules and operators                                                          |
| 8   | [Validation](spec/chapters/08-validation.md)                     | The eight-phase validation pipeline and IaP error codes                                             |
| 9   | [Dependency Model](spec/chapters/09-dependency-model.md)         | Derived ordering; documents never express execution order                                           |
| 10  | [Versioning](spec/chapters/10-versioning.md)                     | Spec/kind/extension version axes, deprecation, migration                                            |
| 11  | [Extension Framework](spec/chapters/11-extension-framework.md)   | Namespaces, the Non-Interference Rule, extension packages                                           |
| 12  | [Provider Mapping](spec/chapters/12-provider-mapping.md)         | Mapping artifacts, purity, fail-closed coverage                                                     |
| 13  | [Infrastructure Model](spec/chapters/13-infrastructure-model.md) | The internal object model that replaces provider state files                                        |
| 14  | [Planning Model](spec/chapters/14-planning-model.md)             | Execution graphs, parallelism, rollback, drift, reconciliation                                      |
| 15  | [Security Model](spec/chapters/15-security-model.md)             | Derived least privilege, zero trust, secrets, encryption                                            |
| 16  | [Cost Model](spec/chapters/16-cost-model.md)                     | Cost annotations, budgets, optimization, carbon footprint                                           |
| 17  | [Compliance Model](spec/chapters/17-compliance-model.md)         | Framework bundles (SOC 2, PCI DSS, HIPAA, ISO 27001, NIST, CIS), evidence                           |
| 18  | [Architecture Model](spec/chapters/18-architecture-model.md)     | The five derived diagram views — no manual diagrams                                                 |
| 19  | [AI Guidelines](spec/chapters/19-ai-guidelines.md)               | AI may author and explain; AI never executes                                                        |
| 20  | [MCP Integration](spec/chapters/20-mcp-integration.md)           | Knowledge sources that enrich validation, never execution                                           |
| 21  | [Reference SDK](spec/chapters/21-reference-sdk.md)               | The engine pipeline all implementations share                                                       |
| 22  | [CLI](spec/chapters/22-cli.md)                                   | The `iap` command reference                                                                         |
| 23  | [LSP](spec/chapters/23-lsp.md)                                   | The language server powering IDE integrations                                                       |
| 24  | [Conformance](spec/chapters/24-conformance.md)                   | Conformance classes, determinism tests, the banned-word list                                        |

## Machine-readable artifacts

| Artifact                                                                           | Purpose                                                                                                          |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`spec/schema/iap-v1.schema.json`](spec/schema/iap-v1.schema.json)                 | JSON Schema (draft 2020-12) validating IaP documents; the source of truth for kinds, fields, enums, and defaults |
| [`spec/schema/iap-mapping-v1.schema.json`](spec/schema/iap-mapping-v1.schema.json) | JSON Schema validating provider mapping artifacts (`*.iap-map.yaml`)                                             |
| [`spec/examples/`](spec/examples/)                                                 | Nine complete, schema-valid IaP documents and a reference provider mapping                                       |
| [`spec/conformance/`](spec/conformance/)                                           | Conformance test cases (valid documents and expected-failure documents)                                          |

Validating a document with a generic JSON Schema validator (the schemas use `x-iap-*` annotation keywords, so annotation-tolerant / non-strict mode is required):

```sh
python3 -c 'import yaml,json,sys; json.dump(yaml.safe_load(open(sys.argv[1])), open(sys.argv[2],"w"))' \
  spec/examples/basic-webapp.iap.yaml /tmp/doc.json
npx ajv-cli@5 validate --spec=draft2020 --strict=false \
  -s spec/schema/iap-v1.schema.json -d /tmp/doc.json
```

## Examples

| Document                                                                               | Demonstrates                                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`basic-webapp.iap.yaml`](spec/examples/basic-webapp.iap.yaml)                         | Service + Database + Cache + Gateway, development/production profiles                                  |
| [`kubernetes-platform.iap.yaml`](spec/examples/kubernetes-platform.iap.yaml)           | Multi-service application, queue/topic messaging, workload identity, `extensions.kubernetes`           |
| [`enterprise-pci.iap.yaml`](spec/examples/enterprise-pci.iap.yaml)                     | PCI DSS scope, policies, compliance frameworks, secrets and rotation, private-only networking          |
| [`multi-region.iap.yaml`](spec/examples/multi-region.iap.yaml)                         | `replicatesTo`, RPO/RTO intent, maximum availability                                                   |
| [`serverless-api.iap.yaml`](spec/examples/serverless-api.iap.yaml)                     | Function-centric compute behind a public Gateway, key-value Database class, topic-triggered function   |
| [`private-internal-service.iap.yaml`](spec/examples/private-internal-service.iap.yaml) | Zero public surface: no Gateway, internal/private exposure only, deny-public policy, secret rotation   |
| [`data-processing.iap.yaml`](spec/examples/data-processing.iap.yaml)                   | Scheduled Job, Queue-fed worker, timeseries Database class, Volume scratch space, reserved Stream kind |
| [`hybrid-environment.iap.yaml`](spec/examples/hybrid-environment.iap.yaml)             | Extension namespaces (`aws`, `onprem`), profiles as sites, cross-site `replicatesTo`                   |
| [`import-intent.iap.yaml`](spec/examples/import-intent.iap.yaml)                       | Brownfield adoption of existing resources via `x-*` passthrough annotations, intent-only core          |

## What IaP is not

- **Not Terraform** — IaP has no providers, no HCL, no provider-attribute state; it describes intent, and mappings (separate artifacts) realize it.
- **Not Kubernetes YAML** — IaP borrows Kubernetes' API conventions but targets any substrate; Kubernetes is just one mapping target.
- **Not Pulumi** — IaP documents are inert, diffable data, not programs.
- **Not Crossplane** — IaP needs no control plane and strictly separates the intent document from composition/mapping logic.

See [Chapter 1](spec/chapters/01-architecture.md) for the full comparisons.

## Status and versioning

This is **version 1.0.0 (Draft)** of the specification. The specification is versioned with semantic versioning; documents pin only the major version (`iap.dev/v1`). Minor releases are strictly additive. See [Chapter 10](spec/chapters/10-versioning.md).

## License

Copyright 2026 Vinit Kumar.

Licensed under the [Apache License, Version 2.0](LICENSE). See the [NOTICE](NOTICE) file for attribution details.
