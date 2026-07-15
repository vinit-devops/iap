# Governance

This document describes how the Infrastructure as Prompt (IaP) project is governed: who decides what, through which processes, and which parts of the repository carry normative weight.

## Project status

IaP is in its **bootstrap phase**: a single-maintainer project building toward the open, multi-party governance described in roadmap Phase 18. Governance is intentionally lightweight now and formalizes as the project matures.

## Decision authority

| Decision class                                                                                         | Authority  | Process                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normative specification changes (anything under `spec/chapters/`, `spec/schema/`, `spec/conformance/`) | Maintainer | Requires an **accepted IEP** (see [spec/ieps/](spec/ieps/README.md)). No normative change merges without one — this is a Phase 0.5 exit criterion. |
| Implementation and tooling choices                                                                     | Maintainer | Recorded as **ADRs** (see [docs/adr/](docs/adr/README.md)) when architecturally significant.                                                       |
| Editorial changes (typos, formatting, broken links, informative docs)                                  | Maintainer | Ordinary review; no IEP or ADR required.                                                                                                           |
| Releases and versioning                                                                                | Maintainer | Governed by the versioning policy in [spec/chapters/10-versioning.md](spec/chapters/10-versioning.md).                                             |

The current maintainer is the project founder. When the project reaches ecosystem scale (roadmap Phase 18 — Open Standardization), decision authority for the specification transfers to a **technical steering committee** that accepts external IEPs, publishes decision records, and supports independent implementations. This document will be revised through the normal review process when that transition occurs.

## Change processes

- **IaP Enhancement Proposals (IEPs)** govern the evolution of the specification itself. Template, lifecycle, review rules, and index: [spec/ieps/README.md](spec/ieps/README.md).
- **Architecture Decision Records (ADRs)** capture significant implementation decisions in the reference toolchain. Template, numbering, and index: [docs/adr/README.md](docs/adr/README.md).
- **Versioning** of the specification, kinds, extensions, and mappings follows [spec/chapters/10-versioning.md](spec/chapters/10-versioning.md): minor releases are strictly additive; removals happen only at a major version and must ship with a deterministic migration transform.

## Normative and informative boundaries

Conformance obligations attach only to normative artifacts.

| Area                                                                  | Status                                                                                                                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec/chapters/`                                                      | **Normative** (except sections explicitly marked non-normative). Where prose and schema disagree, the schema governs structural questions and the prose governs semantic ones (Chapter 2, §2.1).     |
| `spec/schema/`                                                        | **Normative.** The machine-readable contract (see ADR-0002).                                                                                                                                         |
| `spec/conformance/`                                                   | **Normative.** Defines what a conforming implementation must accept and reject.                                                                                                                      |
| `spec/examples/`                                                      | **Informative**, but conformance-referenced: every official example must remain schema-valid at all times, and the conformance suite validates them. An example that breaks validation blocks merge. |
| `spec/mappings/`                                                      | **Informative** reference artifacts; they must remain valid against `iap-mapping-v1.schema.json`.                                                                                                    |
| `README.md`, `docs/`, `roadmap`                                       | **Informative.**                                                                                                                                                                                     |
| `packages/`, `providers/`, `extensions/`, `apps/`, `tests/`, `tools/` | Implementation code; conforms to the specification, never defines it.                                                                                                                                |

## License

License selection is an open decision (tracked for resolution before the 1.0.0 final specification release). Until a license is chosen, treat the repository as all-rights-reserved; the intent is an open specification license.
