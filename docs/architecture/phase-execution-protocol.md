# Phase Execution Protocol

How every roadmap phase is executed, tracked, and closed. This operationalizes roadmap §10 for this repository.

## The twelve steps (roadmap §10)

For every roadmap phase:

1. **Read all dependent specification chapters** before writing anything.
2. **Produce a phase design document** (under `docs/architecture/` or `docs/reports/`).
3. **Identify unresolved normative questions** raised by the phase.
4. **Create IEPs** for any specification changes the phase requires ([spec/ieps/](../../spec/ieps/README.md)).
5. **Create ADRs** for significant implementation choices ([docs/adr/](../adr/README.md)).
6. **Break the phase into milestones** — each independently reviewable.
7. **Implement one milestone at a time**; do not interleave milestones.
8. **Add automated tests with every milestone** — never defer testing to a later milestone.
9. **Update documentation and examples** in the same milestone as the change.
10. **Run the entire conformance suite** (`pnpm run test:spec`, and `pnpm run verify` for the full gate).
11. **Produce a phase completion report** (under `docs/reports/`).
12. **Do not mark the phase complete until exit criteria pass.** Exit criteria — not dates, not effort spent — gate phase completion. A phase with a failing exit criterion is in progress, and dependent phases must not start (roadmap §14).

## Machine-readable tracking: ROADMAP.yaml

[`ROADMAP.yaml`](../../ROADMAP.yaml) at the repository root is the machine-readable tracker. It lists every phase with:

```yaml
phases:
  - id: '0'
    status: completed # pending | in-progress | completed
    milestones: [] # milestone ids with status
    evidence: [] # links to milestone reports, test output, reports
```

Status in `ROADMAP.yaml` is updated in the same change that completes the work; "evidence" links to the milestone reports and test results that justify the status. A phase's status may be `completed` only when every exit criterion has linked evidence.

## Milestone reports

Every milestone produces a report at:

```text
docs/milestones/M<phase>.<n>-<slug>.md
```

using the roadmap §17 report template. Each report contains exactly these fields:

- **Phase**
- **Milestone**
- **Implemented**
- **Files changed**
- **Tests added**
- **Conformance status**
- **Architecture decisions**
- **Specification gaps**
- **Security findings**
- **Known limitations**
- **Next milestone**

While the repository is in its no-git bootstrap mode, these milestone reports are the review artifacts that substitute for pull requests (see [CONTRIBUTING.md](../../CONTRIBUTING.md)); once git is enabled, each milestone maps to one reviewed PR and the report doubles as its description.

## Exit criteria discipline

- Exit criteria are copied from the roadmap phase definition into the phase design document at step 2, so they cannot drift.
- Each criterion is checked off with a link to evidence (test run, report, conformance output).
- If a criterion turns out to be unachievable as written, that is a roadmap change — record why, and what replaced it, in the phase completion report. Never silently reinterpret a criterion.
