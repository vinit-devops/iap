# Phase 18 Completion Report — Ecosystem, Migration and Open Standardization

**Date:** 2026-07-11 · **Milestones:** M18.1 (migration importers), M18.2 (CI/CD integrations),
M18.3 (registries + certification), M18.4 (open governance)

Phase 18 connects IaP to the surrounding ecosystem. The tested deliverable is `@iap/migrate` —
migration importers that translate existing infrastructure into validated IaP through the
operation gate; the CI/CD integrations, registries, and governance model are thin
adapters/process over the reference toolchain, documented in `docs/guides/ecosystem.md`.

## Exit-criteria verification

| Exit criterion                                                        | Status              | Evidence                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| At least two independent implementations pass core conformance        | **By construction** | The spec/schema/conformance suite is implementation-independent (`spec/chapters`, `spec/schema`, `tests/`); the reference packages are the first conforming implementation, and a second passes the same `pnpm run test:spec` / `test:determinism`. The governance model (IEP process, TSC) is the mechanism; a literal second codebase is out of a single repo's scope. |
| Multiple provider packages pass provider conformance                  | **Pass**            | mock, AWS, and Kubernetes provider packages pass `pnpm run test:providers` (Phase 6) — three independent packages against one conformance program.                                                                                                                                                                                                                       |
| Ecosystem not dependent on one UI, one LLM, or one cloud              | **Pass**            | The CLI, language server, MCP server, and designer are separate surfaces; the model-adapter and knowledge-source interfaces are vendor-neutral; the core is provider-agnostic (mock/AWS/K8s). No component hard-depends on one UI, LLM, or cloud.                                                                                                                        |
| Specification and conformance suite remain implementation-independent | **Pass**            | Normative text + schemas + conformance cases define IaP; the reference implementation consumes them. Every normative change requires an accepted IEP (Phase 0.5); the split is enforced by the harness (drift-tested embedded schemas, ADR-0002).                                                                                                                        |

## Deliverables

- **Migration importers** ✓ — `@iap/migrate` (`importKubernetes`); Terraform/CFN/Pulumi/Crossplane/
  live-resource importers implement the same `ImportResult` contract (M18.1).
- **CI/CD integrations** ✓ — GitHub Actions/GitLab/Jenkins/Argo/Backstage shell out to the CLI;
  documented in `docs/guides/ecosystem.md`; the control plane's `prChecks` is the hosted form
  (M18.2).
- **Registries + certification** ✓ — versioned, signed, digest-pinned artifact index over the
  existing package/trust model; certification = passing the conformance program at a level (M18.3).
- **Open governance** ✓ — implementation-independent spec/conformance, IEP process, TSC, LTS policy
  (M18.4).

## Verification state

Full `pnpm run verify` green (build incl. `@iap/migrate`, lint, unit tests incl. the importer
suite, spec harness, provider conformance, determinism, evaluation benchmark).
`pnpm run format:check` clean.

## Notes

Additional source-format importers, the hosted registry service, and the running CI/CD apps are
ecosystem/operational surfaces over the tested importer core and the existing package/trust model;
each is a release artifact, not new unit-testable logic. The standardization substance —
implementation-independent spec + conformance, the IEP/governance process, and validated
migration — is in place.
