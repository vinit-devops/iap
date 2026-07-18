# IaP Conformance Test Suite

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.3.0 (IEP-0017) · Status: Released**

This directory contains the machine-runnable conformance cases referenced by [Chapter 24 — Conformance](../chapters/24-conformance.md). A Conforming Validator MUST pass every case in this suite (requirement CV-8).

## Layout

```
conformance/
├── README.md
└── cases/
    ├── valid/       # documents that MUST pass
    │   ├── 01-minimal.iap.yaml
    │   ├── 02-relationships.iap.yaml
    │   ├── 03-profiles-policies.iap.yaml
    │   ├── 04-graduated-kinds.iap.yaml
    │   └── 05-remaining-kinds-graduated.iap.yaml
    └── invalid/     # documents that MUST fail
        ├── 01-unknown-kind.iap.yaml
        ├── 02-bad-enum.iap.yaml
        ├── 03-provider-field.iap.yaml
        ├── 04-dangling-target.iap.yaml
        ├── 05-ordering-cycle.iap.yaml
        ├── 06-bad-resource-id.iap.yaml
        ├── 07-inert-deadletter.iap.yaml
        ├── 08-scaling-min-gt-max.iap.yaml
        ├── 09-engine-class-mismatch.iap.yaml
        ├── 10-dangling-component.iap.yaml
        ├── 11-dangling-output.iap.yaml
        ├── 12-dangling-certificate.iap.yaml
        ├── 13-profile-extends-cycle.iap.yaml
        ├── 14-verb-kind-violation.iap.yaml
        ├── 15-attribute-verb-violation.iap.yaml
        ├── 16-zero-match-selector.iap.yaml
        ├── 17-policy-deny-violation.iap.yaml
        ├── 18-policy-require-violation.iap.yaml
        ├── 19-public-data-store.iap.yaml
        ├── 20-secret-in-configuration.iap.yaml
        ├── 21-noninterference-violation.iap.yaml
        ├── 22-postmerge-invalid.iap.yaml
        ├── 23-certificate-missing-domains.iap.yaml
        ├── 24-warehouse-engine-mismatch.iap.yaml
        ├── 25-searchindex-missing-indextype.iap.yaml
        └── 26-network-bad-tier.iap.yaml
```

The example documents in [`examples/`](../examples/) are part of the valid corpus by reference and must also pass.

## Case expectations

Every case file begins with a machine-readable comment header:

```yaml
# expected: <schema-invalid | IaP<code> | pass>
# reason: <one-sentence explanation>
```

A case whose outcome is relative to a profile carries one additional machine-readable header line, `# profile: <name>`, naming the profile a full validator must select when running it (e.g. `invalid/22-postmerge-invalid` requires `# profile: production`).

Two kinds of failure expectation exist, and they are **not interchangeable**:

- **`expected: schema-invalid`** — the document violates `spec/schema/iap-v1.schema.json` itself. Schema validation alone (phase 1) MUST reject it.
- **`expected: IaP<code>`** — the document is **schema-valid by design** and MUST be rejected by a **full IaP validator** with the named semantic error code (reference resolution, cycle analysis, and the other phases of [Chapter 8](../chapters/08-validation.md)). A tool that only performs JSON Schema validation MUST report these documents as _valid_ — if your schema check rejects `04-dangling-target` or `05-ordering-cycle`, your schema check is wrong.

| Case                                                | Expectation                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `valid/01-minimal.iap.yaml`                         | pass                                                                                                                                  |
| `valid/02-relationships.iap.yaml`                   | pass (under 1.0.0 validators the then-reserved `Alert` warned IAP801; since 1.1.0 — IEP-0015 — it MUST NOT)                           |
| `valid/03-profiles-policies.iap.yaml`               | pass                                                                                                                                  |
| `valid/04-graduated-kinds.iap.yaml`                 | pass (kinds graduated in 1.1.0 + Database `wide-column`/`warehouse` classes; **no IAP801** may fire)                                  |
| `valid/05-remaining-kinds-graduated.iap.yaml`       | pass (kinds graduated in 1.2.0 — `Network`, `Stream`, `Workflow`, `SearchIndex`; reserved registry now empty, **no IAP801** may fire) |
| `valid/06-new-kinds-and-widenings.iap.yaml`         | pass (kinds introduced directly in 1.3.0 — `Cdn`, `EventBus` — plus the `Identity.type`/`Service.runtime`/`Gateway.protocol` widenings; **no IAP801** may fire) |
| `invalid/01-unknown-kind.iap.yaml`                  | schema-invalid (kind enum)                                                                                                            |
| `invalid/02-bad-enum.iap.yaml`                      | schema-invalid (availability enum)                                                                                                    |
| `invalid/03-provider-field.iap.yaml`                | schema-invalid (`additionalProperties: false` on the Service spec)                                                                    |
| `invalid/04-dangling-target.iap.yaml`               | IAP201 — schema-valid; dangling `connectsTo` target                                                                                   |
| `invalid/05-ordering-cycle.iap.yaml`                | IAP401 — schema-valid; `dependsOn` cycle                                                                                              |
| `invalid/06-bad-resource-id.iap.yaml`               | schema-invalid (resource-key `propertyNames` pattern)                                                                                 |
| `invalid/07-inert-deadletter.iap.yaml`              | IAP104 — schema-valid; `deadLetter.maxReceives` set while `enabled: false` (inert field combination)                                  |
| `invalid/08-scaling-min-gt-max.iap.yaml`            | IAP104 — schema-valid; `scaling.min` > `scaling.max` (cross-field constraint)                                                         |
| `invalid/09-engine-class-mismatch.iap.yaml`         | IAP104 — schema-valid; Database `engine: postgresql` with `class: document`                                                           |
| `invalid/10-dangling-component.iap.yaml`            | IAP202 — schema-valid; Application `components` entry naming no resource                                                              |
| `invalid/11-dangling-output.iap.yaml`               | IAP203 — schema-valid; `outputs.*.resource` naming no resource                                                                        |
| `invalid/12-dangling-certificate.iap.yaml`          | IAP204 — schema-valid; Gateway `tls.certificate` naming no resource                                                                   |
| `invalid/13-profile-extends-cycle.iap.yaml`         | IAP205 — schema-valid; two profiles `extends`-ing each other                                                                          |
| `invalid/14-verb-kind-violation.iap.yaml`           | IAP301 — schema-valid; `routesTo` edge targeting a `Volume`                                                                           |
| `invalid/15-attribute-verb-violation.iap.yaml`      | IAP302 — schema-valid; `path` attribute on a `connectsTo` edge                                                                        |
| `invalid/16-zero-match-selector.iap.yaml`           | IAP402 — schema-valid; rule-edge selector matching zero resources                                                                     |
| `invalid/17-policy-deny-violation.iap.yaml`         | IAP501 — schema-valid; `deny` condition true for a targeted resource                                                                  |
| `invalid/18-policy-require-violation.iap.yaml`      | IAP502 — schema-valid; `require` condition false for a targeted resource                                                              |
| `invalid/19-public-data-store.iap.yaml`             | IAP601 — schema-valid; public ObjectStore that is a `storesDataIn` target                                                             |
| `invalid/20-secret-in-configuration.iap.yaml`       | IAP602 — schema-valid; credential-patterned `configuration` key (`DB_PASSWORD`)                                                       |
| `invalid/21-noninterference-violation.iap.yaml`     | IAP803 — schema-valid; extension block overriding core exposure intent                                                                |
| `invalid/22-postmerge-invalid.iap.yaml`             | IAP101 — pre-merge schema-valid; profile merge deletes required `spec.class` (post-merge schema failure)                              |
| `invalid/23-certificate-missing-domains.iap.yaml`   | schema-invalid (since 1.1.0/IEP-0015: `Certificate.spec.domains` is required under the promoted contract)                             |
| `invalid/24-warehouse-engine-mismatch.iap.yaml`     | IAP104 — schema-valid; Database `class: warehouse` (1.1.0) with `engine: postgresql` (no engine pairs with warehouse)                 |
| `invalid/25-searchindex-missing-indextype.iap.yaml` | schema-invalid (since 1.2.0/IEP-0016: `SearchIndex.spec.indexType` is required under the promoted contract)                           |
| `invalid/26-network-bad-tier.iap.yaml`              | schema-invalid (since 1.2.0/IEP-0016: `Network.spec.tiers` is a closed enum; `dmz` is not a member)                                   |
| `invalid/27-cdn-missing-origins.iap.yaml`           | schema-invalid (since 1.3.0/IEP-0017: `Cdn.spec.origins` is required — min 1 — under the new contract)                                |
| `invalid/28-eventbus-bad-source.iap.yaml`           | schema-invalid (since 1.3.0/IEP-0017: `EventBus.spec.sources` is a closed enum; `external` is not a member)                           |
| `invalid/29-identity-bad-type.iap.yaml`             | schema-invalid (1.3.0/IEP-0017 widened `Identity.type` to add `user-directory`; the enum stays closed — `external-user` is rejected)  |

## Running the schema-validation layer with ajv

The suite's schema layer can be run with stock [Ajv](https://ajv.js.org/). Two things to know first:

1. **YAML must be converted to JSON** — `ajv-cli` reads JSON. A dependency-free converter:

   ```sh
   python3 -c 'import yaml,json,sys; json.dump(yaml.safe_load(open(sys.argv[1])), open(sys.argv[2],"w"))' in.yaml out.json
   ```

2. **`--strict=false` is required.** The schema carries the `x-iap-*` annotation vocabulary (`x-iap-since`, `x-iap-deprecated`, `x-iap-capability`, `x-iap-reserved`), which strict Ajv rejects as unknown keywords. Generic JSON Schema validators must be run annotation-tolerant (Chapter 24, CV-6).

Validate one converted case from the repository root:

```sh
npx ajv-cli@5 validate --spec=draft2020 --strict=false -s spec/schema/iap-v1.schema.json -d <file-as-json>
```

Run the whole suite:

```sh
for f in conformance/cases/valid/*.iap.yaml conformance/cases/invalid/*.iap.yaml; do
  j="$(mktemp).json"
  python3 -c 'import yaml,json,sys; json.dump(yaml.safe_load(open(sys.argv[1])), open(sys.argv[2],"w"))' "$f" "$j"
  echo "== $f"
  npx ajv-cli@5 validate --spec=draft2020 --strict=false -s spec/schema/iap-v1.schema.json -d "$j"
done
```

Expected ajv results:

- all five `cases/valid/*` files → **valid**
- `invalid/01`, `invalid/02`, `invalid/03`, `invalid/06`, `invalid/23`, `invalid/25`, `invalid/26` → **invalid** (schema-invalid)
- `invalid/04`, `invalid/05`, `invalid/07`–`invalid/22`, `invalid/24` → **valid** (their failures are semantic; see below)

## Semantic cases require a full validator

Cases annotated `expected: IaP<code>` exercise validation phases 2–8, which no JSON Schema engine can perform: resolving references across the document, deriving the ordering graph, detecting cycles, evaluating policies. A validator claiming conformance MUST implement all eight phases ([Chapter 24 §24.2.2](../chapters/24-conformance.md)) and report the expected code for each such case, alongside rejecting every `schema-invalid` case.

Mapping artifacts (`*.iap-map.yaml`, e.g. [`spec/mappings/`](../mappings/)) validate the same way against `spec/schema/iap-mapping-v1.schema.json`.
