# Schema Compatibility Report — IaP 1.0.0 Baseline

**Date:** 2026-07-10 · **Artifacts:** `spec/schema/iap-v1.schema.json`, `spec/schema/iap-mapping-v1.schema.json` (JSON Schema draft 2020-12)

## Baseline declaration

This report establishes the **1.0.0 compatibility baseline** against which all future schema revisions are audited (chapter 10 rules: minors strictly additive; anything else requires an accepted IEP and a major).

**Frozen for the implementation milestone** (Phase 1 exit criterion):

- The **kind registry**: 13 fully specified kinds + 9 reserved kinds (the `$defs/kindName` enum). Additions require a spec minor; removals/renames a major.
- The **relationship verb set** (10 verbs) — closed for the entire 1.x major.
- The **top-level key set** (`apiVersion`, `metadata`, `profiles`, `resources`, `relationships`, `policies`, `compliance`, `extensions`, `outputs` + `x-*`).
- The **policy operator set** (9 operators) and effect set (`deny`/`warn`/`require`).
- The **identifier grammar**, **quantity grammar**, **duration grammar**.
- The **error-code registry** (32 codes; `spec/conformance/error-codes.yaml`, cross-checked against chapter 8 by the harness on every run).
- The **annotation vocabulary**: `x-iap-since`, `x-iap-deprecated`, `x-iap-capability`, `x-iap-reserved`, `x-iap-presence-semantic`, `x-iap-default-when`.

## Revision audit within this baseline

The M1.2 corrections were audited as **annotation-only** (non-breaking):

| Change                                                                         | Class                                 | Validation behavior                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------- |
| `access` `default: read-write` on both edge defs                               | annotation                            | unchanged                                                                        |
| `resilience` split into `resilienceBackupRequired`/`resilienceBackupPreferred` | structural refactor, same constraints | unchanged (verified: all examples/cases produce identical outcomes before/after) |
| `x-iap-presence-semantic` on `healthCheck`, `deadLetter`                       | annotation                            | unchanged                                                                        |
| `x-iap-default-when` on `deadLetter.maxReceives`                               | annotation                            | unchanged                                                                        |

Evidence: `pnpm run test:spec` green before and after; no example or conformance case changed outcome.

## Compatibility promises (restated from chapter 10)

- A document valid under 1.0.0 remains valid under every 1.x.
- A validator built for 1.x accepts documents using later-1.x constructs with IAP804 warnings — never silent acceptance, never rejection.
- Deprecations (IAP805) persist for the whole major; removals ship only in 2.0 with a deterministic `iap migrate` transform.
- Generic JSON Schema validators MUST register the annotation vocabulary (or run annotation-tolerant) — chapter 24 CV-6; the reference packages pre-register it with ajv strict mode ON.

## Known non-blocking notes

- `x-iap-since` is omitted schema-wide (absence = 1.0.0 by convention); explicit annotations begin with the first 1.1 addition.
- The mapping schema's `specCompat` is a free semver-range string in 1.0; a closed range grammar may be tightened in a minor (accepting a subset of current strings — non-breaking).
