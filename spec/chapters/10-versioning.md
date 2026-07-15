# 10. Versioning

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter defines how the specification, its kinds, and its satellite artifacts evolve over time, and the compatibility guarantees that every conforming tool MUST uphold. The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in [Chapter 2](02-document-layout.md).

## 10.1 Three Independent Version Axes

IaP versioning operates on three axes that evolve independently:

| Axis | Identifier | Scheme | Who pins what |
|---|---|---|---|
| Specification | `apiVersion: iap.dev/v1` | Semantic version `1.x.y` | Documents pin the **major** only |
| Kinds | — | Versioned **with** the specification | No per-kind versions in v1 |
| Extensions & mappings | `extensions.<ns>.version`, mapping `version` + `specCompat` | Independent semver per artifact | Each artifact pins its own version and declares a spec range |

No other version indicator is defined. Tools MUST NOT invent additional version fields (for example, per-resource or per-field version markers) outside the annotations defined in this chapter.

## 10.2 Specification Versioning

The specification carries a semantic version of the form `1.x.y` (analogous to OpenAPI 3.1). Documents do **not** state the full version: `apiVersion: iap.dev/v1` pins the major version only. A document written against specification 1.0.0 is, by construction, a document written against every 1.x.y release.

### 10.2.1 Minor Versions Are Strictly Additive

A minor release (`1.x.0`) MAY add:

- new kinds (typically graduating reserved kinds from the registry in [Chapter 5](05-capability-model.md));
- new optional fields on existing kinds or common definitions;
- new enum values for existing fields;
- new error codes, policy operators, or diagnostic categories.

A minor release MUST NOT:

- remove or rename any kind, field, or enum value;
- change the default value or the meaning of any existing field;
- make a previously optional field required;
- tighten any grammar or validation constraint such that a previously valid document becomes invalid;
- add relationship verbs. **The relationship verb set of [Chapter 4](04-relationship-model.md) is closed for the entire major version.** Verbs are load-bearing for dependency derivation, security derivation, and mapping coverage; a validator that does not recognize a verb cannot degrade safely. New verbs arrive only at a major version boundary.

The invariant is: every document valid under specification `1.a.*` remains valid, with unchanged semantics, under every specification `1.b.*` where `b ≥ a`.

### 10.2.2 Patch Versions Are Editorial

A patch release (`1.x.y`) contains editorial changes only: clarified prose, corrected typos, improved examples, non-normative reorganization. A patch release MUST NOT change the set of valid documents, any default, or any semantic rule. If a patch changes tool behavior, it was not a patch.

### 10.2.3 The `x-iap-since` Annotation

Every kind, field, and enum value added after 1.0.0 carries an `x-iap-since` annotation in the machine-readable schema stating the minor version that introduced it (e.g. `"x-iap-since": "1.2.0"`). **Absence of `x-iap-since` means "since 1.0.0."** These annotations are the mechanical basis for the compatibility behavior in §10.6 and for language-server features described in [Chapter 23](23-lsp.md); they are generated into the field registry of [Chapter 3](03-resource-model.md) and MUST be kept accurate as a condition of publishing a specification release.

## 10.3 Kind Versioning

Kinds are versioned with the specification. There are **no per-kind versions in v1**: no `Database/v2`, no per-kind `apiVersion`. The set of kinds, their fields, and their defaults are fully determined by the specification version, which keeps the document surface flat and the compatibility story one-dimensional.

Reserved kinds (`Network`, `Certificate`, `DnsZone`, `Stream`, `Workflow`, `SearchIndex`, `Registry`, `Dashboard`, `Alert`) are intentionally thin in 1.0.0. Validators MUST accept documents that use them and SHOULD emit warning **IAP801** (reserved kind in use) so authors understand the contract is not yet frozen. A reserved kind graduates to a fully specified kind in a minor release; because its 1.0.0 schema accepts any object body, graduation is additive from the validator's perspective, but field-level guarantees begin only at the graduating minor.

## 10.4 Extension and Mapping Versioning

Extensions and provider mappings are independently versioned artifacts; their release cadence is decoupled from the specification's.

- **Extensions** declare their package version at the document-level registration point: `extensions.<ns>.version` is a full semver (e.g. `extensions.aws.version: 1.4.0`). Resource-level `extensions.<ns>` blocks refine and never re-declare a version. The registration and non-interference rules are defined in [Chapter 11](11-extension-framework.md).
- **Mappings** carry two version statements ([Chapter 12](12-provider-mapping.md)): their own `version` (semver of the mapping artifact) and `specCompat`, a semver **range** naming the specification versions the mapping supports (e.g. `">=1.0.0 <2.0.0"`). A tool MUST refuse to apply a mapping whose `specCompat` range does not include the specification version the tool implements.

Extension and mapping releases follow ordinary semver discipline: breaking changes to their own schemas or realization behavior require a major bump of the artifact, never of the specification.

## 10.5 Deprecation Lifecycle

Deprecation is how the specification signals *"stop using this"* without ever breaking a document mid-major.

1. **Deprecation** occurs in a minor release `1.n.0`. The deprecated kind, field, or enum value gains an `x-iap-deprecated` annotation in the schema recording the deprecating version and, where one exists, the replacement (e.g. `"x-iap-deprecated": {"since": "1.3.0", "replacedBy": "spec.resilience.backup"}`).
2. **During the remainder of the major version**, the deprecated element remains fully valid and fully functional. Validators MUST accept it and MUST emit warning **IAP805** (deprecated field use) identifying the element, the deprecating version, and the replacement. Language servers SHOULD render deprecated elements with strikethrough and surface the replacement in hover text ([Chapter 23](23-lsp.md)). Deprecation MUST NOT change semantics, defaults, or mapping behavior.
3. **Removal** happens only at the next major version, and a removal MUST ship with a deterministic migration transform executable as `iap migrate`. The transform rewrites any valid `1.*` document into an equivalent `2.*` document with no human judgment required; migrations that cannot be expressed deterministically block the removal. `iap migrate` is a pure document-to-document function and is subject to the same determinism conformance tests as validation ([Chapter 24](24-conformance.md)).

There is no "soft removal," no behavior change behind a deprecation flag, and no validity distinction between deprecated and non-deprecated usage inside a major version.

## 10.6 Compatibility Matrix

The interesting cases arise when the validator and the document were written against different minors of the same major.

| Validator implements | Document uses | Required behavior |
|---|---|---|
| `1.a` | Features of `1.b`, `b ≤ a` | Valid. Full validation. |
| `1.a` | Features of `1.b`, `b > a` (fields/kinds/enum values the validator does not know) | Document is processed; each unknown construct produces warning **IAP804** (unknown newer-minor field). **Silent acceptance is a conformance failure.** The validator MUST NOT report the document as fully validated, and MUST NOT fail it solely for using a newer minor's additions. |
| `2.a` (newer major) | `iap.dev/v1` document | The tool MUST either validate under its v1 rules or direct the user to `iap migrate`; it MUST NOT reinterpret v1 constructs under v2 semantics. |

Two consequences are normative:

- **Newer validator, older document: always valid.** Because minors are strictly additive, a 1.5-aware validator accepts every 1.0 document with identical semantics. No flag, mode, or pragma is needed.
- **Older validator, newer document: degrade loudly, never silently.** IAP804 exists so that a document exercising `1.4` additions is never waved through by a `1.2` validator as if fully checked. Planners and mapping engines are stricter than validators here: a planner or mapping engine encountering a construct it does not implement MUST reject rather than warn, consistent with the fail-closed rule of [Chapter 12](12-provider-mapping.md).

Unknown constructs are distinguished from typos by position and grammar: an unrecognized key that could only be a schema addition (correct casing, valid grammar, in a location where the schema is extensible across minors) yields IAP804; anything else remains an ordinary schema error under [Chapter 8](08-validation.md).

## 10.7 Versioning Error Codes

The `IAP8xx` range is reserved for versioning and extension diagnostics (taxonomy in [Chapter 8](08-validation.md)):

| Code | Severity | Meaning |
|---|---|---|
| IAP801 | warning | Reserved kind in use; full specification pending a future minor (§10.3) |
| IAP802 | warning | Unknown extension namespace ([Chapter 11](11-extension-framework.md)) |
| IAP803 | error | Extension Non-Interference Rule violation ([Chapter 11](11-extension-framework.md)) |
| IAP804 | warning | Construct from a newer minor unknown to this validator (§10.6) |
| IAP805 | warning | Use of a deprecated kind, field, or enum value (§10.5) |
