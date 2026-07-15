# IaP Ecosystem: Migration, CI/CD, Registries, Governance

**Roadmap Phase 18.** How IaP meets the surrounding ecosystem. The migration importers ship as
`@iap/migrate` (M18.1); the CI/CD integrations, registries, and open-governance model below are
thin adapters and process over the tested reference toolchain (M18.2–M18.4).

## Migration importers (M18.1)

`@iap/migrate` translates existing infrastructure into IaP **through the operation gate**, so an
imported result is validated IaP and any construct the importer cannot faithfully map is
reported explicitly — never guessed. The Kubernetes importer (`importKubernetes`) ships:
Deployment/StatefulSet/ReplicaSet → Service, Job/CronJob → Job, PersistentVolumeClaim → Volume,
Ingress → Gateway, Secret → Secret; ConfigMaps and K8s Services are reported unmapped (they fold
into workload config / exposure). Terraform, CloudFormation, Pulumi, Crossplane, and live-resource
importers implement the same `ImportResult` contract (map what is faithful, report the rest); each
consumes a source format and emits validated IaP + an unmapped report.

## CI/CD integrations (M18.2)

Every integration shells out to the reference CLI, so a pipeline check matches local review. A
GitHub Actions job:

```yaml
name: iap
on: [pull_request]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm i -g @iap/cli
      - run: iap validate --file infrastructure.iap.yaml -o sarif > iap.sarif
      - run: iap cost --file infrastructure.iap.yaml # exit 1 blocks on a budget breach
      - run: iap security --file infrastructure.iap.yaml # exit 1 blocks on a security error
      - run: iap compliance --file infrastructure.iap.yaml # exit 1 blocks on a control violation
```

GitLab CI, Jenkins, Argo, and Backstage integrations are the same commands wired to each
platform's job/step model and status surface; the SARIF output feeds code-scanning UIs. The
enterprise control plane's `prChecks` (Phase 16) is the hosted equivalent for a git application.

## Registries (M18.3)

A registry is an index of versioned, signed artifacts — provider packages (`plugin.iap.dev/v1`,
Phase 6), extension packages (ch. 11), policy packs (Phase 9), and profile libraries (ch. 6) —
each entry carrying name, version, `specCompat`, publisher, and content digest, resolved exactly
like the provider loader verifies a package today (trust store + digest pinning). Certification is
"passes the conformance suite at level X": provider packages run the provider conformance program
(`pnpm run test:providers`), and a registry records the level a version attained.

## Open governance (M18.4)

- **Specification and conformance are implementation-independent.** The normative text
  (`spec/chapters`), schemas (`spec/schema`), and conformance suite (`tests/`, `spec/conformance`)
  define IaP; the reference packages are one conforming implementation. A second implementation
  passes the same suite to claim conformance.
- **Changes go through IEPs.** Every normative change requires an accepted IEP (Phase 0.5);
  external contributors open IEPs the same way, reviewed by a Technical Steering Committee.
- **LTS policy.** A major line receives a defined support window; breaking changes require a major
  and an accepted IEP; the schema-compatibility report (`docs/reports/schema-compatibility-1.0.md`)
  tracks the contract.

## Exit-criteria posture

- _At least two independent implementations pass core conformance_ — the suite is
  implementation-independent by construction; a second implementation runs the same `pnpm run
test:spec` / `test:determinism`. (The reference implementation is the first.)
- _Multiple provider packages pass provider conformance_ — mock, AWS, and Kubernetes already pass
  `pnpm run test:providers` (Phase 6).
- _Ecosystem not dependent on one UI, one LLM, or one cloud_ — the CLI, language server, MCP
  server, and designer are separate surfaces; adapters are vendor-neutral interfaces; the core is
  provider-agnostic.
- _Specification and conformance suite remain implementation-independent_ — enforced by the
  spec/schema/conformance split and the IEP process.
