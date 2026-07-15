# Contributing

Thank you for contributing to the Infrastructure as Prompt (IaP). This guide covers the development workflow, local commands, and what "done" means here.

> **Current mode — no git yet.** This repository is intentionally not under version control during the bootstrap phase. The branch/PR workflow below is staged and inert until git is enabled. Until then, **reviewable milestone documents under [`docs/milestones/`](docs/milestones/) substitute for pull requests**: every unit of work produces a milestone report that serves as the review artifact. Everything else in this guide applies unchanged.

## Development workflow (roadmap §9.1)

1. **Never commit directly to the protected `main` branch.** Create a branch for every feature or phase increment (e.g. `feature/short-topic`).
2. **Submit changes through pull requests.** Tests and review are required before merge.
3. **Keep each pull request small enough to review.** Split large phases into milestones.
4. **Use [Conventional Commits](https://www.conventionalcommits.org/)** — `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, with scopes like `feat(parser): ...`.
5. **Add a changelog entry** to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) for every user-visible change.
6. **Link every change to a roadmap item or an IEP** in the PR description (or milestone report).

### Specification changes

Normative changes — anything under `spec/chapters/`, `spec/schema/`, or `spec/conformance/` — require an **accepted IEP** before they can merge. See [spec/ieps/README.md](spec/ieps/README.md) and [GOVERNANCE.md](GOVERNANCE.md). Editorial fixes (typos, links, formatting) are exempt.

## Local development

Prerequisites: Node.js ≥ 22, pnpm 11.x (pinned via `packageManager` in `package.json`).

```sh
pnpm install          # install workspace dependencies
pnpm run build        # build all packages
pnpm run lint         # ESLint
pnpm run format:check # Prettier (spec prose is excluded from formatting)
pnpm run typecheck    # tsc --noEmit across packages
pnpm run test         # unit tests (vitest)
pnpm run test:spec    # spec validation: schemas, examples, conformance cases
pnpm run verify       # build + lint + test + test:spec — run before submitting
```

`pnpm run verify` must pass on a clean checkout before any change is considered submittable.

## Definition of done (roadmap §13, summarized)

A feature is complete only when:

- Behavior is documented and its public API is typed.
- It has unit tests, integration tests, at least one valid example, and at least one invalid/failure example.
- It has security analysis, error codes, and deterministic-behavior tests where applicable.
- It has CLI or SDK exposure where relevant.
- The full conformance suite passes.
- It introduces **no provider concepts into the core** and **no AI into the execution path**.
- It is merged through a reviewed pull request (currently: recorded in a milestone report).
- Roadmap status and evidence are updated.

## Reporting issues

Use the issue templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) — bug report, feature request, or IEP proposal. For security vulnerabilities, do **not** open a public issue; see [SECURITY.md](SECURITY.md).

## License

The project license is TBD (see [GOVERNANCE.md](GOVERNANCE.md)). By contributing, you agree that your contributions will be licensed under the license the project ultimately adopts.
