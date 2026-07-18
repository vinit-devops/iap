# Architecture Decision Records

ADRs capture significant, hard-to-reverse implementation decisions for the IaP reference toolchain: what was decided, in what context, and what the consequences are. They document _implementation_ choices; changes to the _specification_ itself go through IEPs ([spec/ieps/](../../spec/ieps/README.md)) instead. Decision authority is defined in [GOVERNANCE.md](../../GOVERNANCE.md).

## Conventions

- **Numbering:** `ADR-NNNN` (zero-padded, sequential). Filename: `ADR-NNNN-short-slug.md`.
- **Template:** [ADR-TEMPLATE.md](ADR-TEMPLATE.md).
- **Statuses:**
  - `Proposed` — written, under review, not yet binding.
  - `Accepted` — binding; implementations must follow it.
  - `Superseded` — replaced by a later ADR (link the successor). ADRs are immutable once accepted; to change a decision, write a new ADR that supersedes the old one.

## Index

| ADR                                                    | Title                                                         | Status   |
| ------------------------------------------------------ | ------------------------------------------------------------- | -------- |
| [ADR-0001](ADR-0001-monorepo-and-primary-language.md)  | Monorepo-first development and TypeScript as primary language | Accepted |
| [ADR-0002](ADR-0002-json-schema-normative-contract.md) | JSON Schema as the normative machine-readable contract        | Accepted |
| [ADR-0003](ADR-0003-iap-naming-migration.md)           | IIS → IaP naming migration and the error-code breaking rename | Accepted |
| [ADR-0004](ADR-0004-handler-registry-and-lazy-clients.md) | Derived handler registry and lazy per-service AWS clients  | Proposed |
| [ADR-0005](ADR-0005-default-vpc-live-testing.md)       | Default-VPC pragmatism for early live-run waves               | Proposed |
| [ADR-0006](ADR-0006-replacement-update-semantics.md)   | Replacement-update semantics (immutable attrs → gated delete+create) | Proposed |

## Required ADR topics (roadmap §15)

The roadmap requires ADRs covering at minimum the topics below. This table is the checklist; topics are recorded as the phases that need them arrive.

| Topic                                                     | ADR      | Status          |
| --------------------------------------------------------- | -------- | --------------- |
| Persistent source of truth versus runtime canonical model | —        | Not yet created |
| JSON Schema as normative machine-readable contract        | ADR-0002 | Accepted        |
| Canonical serialization rules                             | —        | Not yet created |
| Monorepo-first development                                | ADR-0001 | Accepted        |
| Primary implementation language                           | ADR-0001 | Accepted        |
| Provider plugin trust model                               | —        | Not yet created |
| State backend design                                      | —        | Not yet created |
| Plan format and signing                                   | —        | Not yet created |
| AI trust boundary                                         | —        | Not yet created |
| MCP trust boundary                                        | —        | Not yet created |
| Natural-language compiler operation model                 | —        | Not yet created |
| Profile and policy evaluation order                       | —        | Not yet created |
| Provider extension precedence                             | —        | Not yet created |
| Determinism inputs                                        | —        | Not yet created |
| Rollback semantics                                        | —        | Not yet created |
| Drift classification                                      | —        | Not yet created |
| Advanced provider parameter representation                | —        | Not yet created |
| IDE integration through LSP and MCP                       | —        | Not yet created |
| Basic versus advanced UI behavior                         | —        | Not yet created |
| Secret handling                                           | —        | Not yet created |
| Telemetry and privacy                                     | —        | Not yet created |
