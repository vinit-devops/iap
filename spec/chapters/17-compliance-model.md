# 17. Compliance Model

**Part of the [Infrastructure as Prompt](../../README.md) · Version 1.0.0 · Status: Draft**

This chapter defines how compliance frameworks attach to IaP documents. Compliance in IaP is **embedded, not bolted on**: because security posture, data protection, and reachability are all derived from the canonical document ([Chapter 15](15-security-model.md)), compliance controls can be evaluated — and evidenced — entirely at the intent level. This chapter is normative except for the control-mapping tables in §17.2, which are informative.

## 17.1 Frameworks Activate Policy Bundles

The document-level `compliance.frameworks` array declares which frameworks the document is in scope for. Each entry activates that framework's **registered policy bundle**: a versioned set of policies ([Chapter 7](07-policy-language.md)) plus control metadata, evaluated against the canonical document exactly as document-local policies are.

```yaml
compliance:
  frameworks: [pci-dss-4.0, soc2]
```

The v1 registry contains exactly six frameworks, matching the schema enum: `soc2`, `pci-dss-4.0`, `hipaa`, `iso27001-2022`, `nist-800-53-r5`, `cis-8.0`. Unknown framework identifiers are schema errors ([Chapter 8](08-validation.md)). Activating a framework adds rules; it never relaxes any rule from the document, another bundle, or the core defaults. When bundles overlap, each reports its own findings independently.

## 17.2 The Registered Frameworks (Informative Mappings)

The tables below map **representative** controls of each framework to the IaP policy rules its bundle expresses. They are informative illustrations of bundle content, not exhaustive control catalogs; authoritative rule sets ship in the versioned bundles themselves (§17.3). Because every rule is a deterministic condition over the document, each control check is reproducible by any conformant validator.

### soc2

| Control (representative) | IaP policy rule |
|---|---|
| CC6.1 logical access controls | Every workload→data edge declares `access`; least-privilege derivation per [Chapter 15, §15.3](15-security-model.md) |
| CC6.6 boundary protection | `spec.exposure` ≠ `public` on data kinds (`Database`, `Cache`, `ObjectStore`, `Volume`) |
| CC6.7 transmission protection | `spec.encryption.inTransit` = `required` |
| CC7.2 monitoring | `spec.observability.logs` = `required` on workloads and data kinds |

### pci-dss-4.0

| Control (representative) | IaP policy rule |
|---|---|
| Req 3 (protect stored account data) | `spec.encryption.atRest` = `required` on data kinds in scope |
| Req 4 (protect data in transmission) | `spec.encryption.inTransit` = `required`; `Gateway` `spec.tls.minimumVersion` = `1.2` or higher |
| Req 7 (need-to-know access) | No edge with `access: admin` from workloads to in-scope data kinds; every data edge declares `access` |
| Req 10 (log and monitor access) | `spec.observability.logs` = `required` on all in-scope resources |

### hipaa

| Control (representative) | IaP policy rule |
|---|---|
| §164.312(a)(1) access control | Workloads reaching data kinds have `authenticatedBy` identities; declared `access` on every edge |
| §164.312(a)(2)(ii) — data availability | `spec.resilience.backup` = `required` on data kinds |
| §164.312(b) audit controls | `spec.observability.logs` = `required` |
| §164.312(e)(1) transmission security | `spec.encryption.inTransit` = `required` |

### iso27001-2022

| Control (representative) | IaP policy rule |
|---|---|
| A.5.15 access control | Edge `access` declarations present; no grant without an edge |
| A.8.12 data leakage prevention | `spec.exposure` = `private` on data kinds; `ObjectStore` `spec.versioning` = `enabled` |
| A.8.13 information backup | `spec.resilience.backup` = `required` and `recoveryPointObjective` declared |
| A.8.24 use of cryptography | `spec.encryption.atRest` and `inTransit` = `required` |

### nist-800-53-r5

| Control (representative) | IaP policy rule |
|---|---|
| AC-6 least privilege | Access derivation solely from edges; `access: admin` denied for workload principals |
| SC-7 boundary protection | `spec.exposure` = `private` unless the resource is a `Gateway`; reachability only via declared edges |
| SC-28 protection at rest | `spec.encryption.atRest` = `required` |
| AU-2 event logging | `spec.observability.logs` = `required` |

### cis-8.0

| Control (representative) | IaP policy rule |
|---|---|
| Control 3 data protection | `spec.encryption.atRest` = `required`; `Secret` `spec.rotation.policy` ≠ `none` |
| Control 4 secure configuration | `spec.exposure` defaults honored; `Gateway` `spec.tls.minimumVersion` ≥ `1.2` |
| Control 8 audit log management | `spec.observability.logs` = `required` |
| Control 12 network infrastructure management | No undeclared reachability; zero-trust derivation per [Chapter 15, §15.4](15-security-model.md) |

## 17.3 Bundles Are Versioned Artifacts

Framework bundles are distributed and versioned exactly like extension packages ([Chapter 11](11-extension-framework.md)): each bundle carries a semver version and a `specCompat` range, and a plan records the precise bundle versions it evaluated. Evaluating the same canonical document against the same bundle version MUST yield identical findings ([Chapter 1, §1.2.2](01-architecture.md)). Bundle upgrades are therefore explicit, reviewable events — a control added in a bundle revision can never silently change a previously approved document's compliance status without a recorded version change.

## 17.4 Compliance Findings: IAP7xx

Compliance violations use the **IAP7xx** code range, distinct from generic policy violations (**IAP5xx**, [Chapter 7](07-policy-language.md)): a compliance finding is attributable to an external control catalog, not merely to a document-local rule. The primary code is **IAP701** (`control-violation`); every IAP701 finding MUST carry the framework identifier, the framework's control id, the bundle version, and the violating resource path. Where a security-model check overlaps (for example an encryption downgrade under an active `pci-dss-4.0` or `soc2` framework), the security validator additionally reports **IAP603** ([Chapter 15, §15.6](15-security-model.md)); the two findings are distinct and both are emitted.

## 17.5 Profile Pairing: Defense in Depth

Built-in profiles such as `pci` and `soc2` ([Chapter 6](06-profiles.md)) and framework bundles are complementary, not redundant:

- the **profile** *sets* compliant defaults (e.g. the `pci` profile overlays `encryption: {atRest: required, inTransit: required}`, `observability.logs: required`, `exposure: private` onto in-scope resources);
- the **bundle** *enforces* those values on the merged result, catching any override — from another profile in the `extends` chain, a later document edit, or a mistaken overlay — that weakens them.

Selecting the `pci` profile without declaring `pci-dss-4.0` in `compliance.frameworks` yields compliant defaults with no enforcement; declaring the framework without the profile yields enforcement that the author must satisfy by hand. Documents intended for audit SHOULD do both.

## 17.6 Evidence Outputs

Conforming validators MUST be able to emit an **evidence report**: for every control in every active bundle, a disposition of `satisfied`, `violated`, or `not-applicable`, with the document paths of every resource that contributed to the disposition (`not-applicable` meaning no resource matched the control's target). The report is derived entirely from the canonical document and the bundle versions — no runtime inspection, screenshots, or provider console access — so an audit can be conducted at the intent level, and re-verified by any party by re-running evaluation on the same inputs. Evidence report format is specified alongside validator output formats in [Chapter 22](22-cli.md).

## 17.7 Scoping

Bundles target the whole document by default. Where a framework's scope is narrower than the system — the common case for `pci-dss-4.0` — **label-based scoping** narrows bundle targets: bundle rules carry a label selector, and resources opt in via labels such as `pci-scope: "true"`. Resources outside the selector receive `not-applicable` dispositions for scoped controls. Scoping narrows *targets* only; it never weakens a rule for in-scope resources, and document-wide controls (e.g. those governing the `compliance` block itself) ignore scoping.

## 17.8 Worked Example

The following schema-valid fragment declares PCI scope, labels the in-scope resources, and contains one violation: `payments-db` explicitly downgrades encryption at rest.

```yaml
apiVersion: iap.dev/v1
metadata:
  name: payments
  owner: payments-team
compliance:
  frameworks: [pci-dss-4.0]
resources:
  payments-api:
    kind: Service
    labels:
      pci-scope: "true"
    spec:
      artifact:
        type: container-image
        reference: registry.example.com/payments-api:2.0.1
      exposure: private
    relationships:
      - type: connectsTo
        target: payments-db
        port: 5432
        protocol: tcp
        access: read-write
  payments-db:
    kind: Database
    labels:
      pci-scope: "true"
    spec:
      class: relational
      engine: postgresql
      encryption:
        atRest: preferred   # violation: PCI Req 3 requires 'required'
        inTransit: required
  audit-log-store:
    kind: ObjectStore
    spec:
      versioning: enabled
```

`audit-log-store` carries no `pci-scope` label, so scoped controls report it `not-applicable`. Evaluation of the `pci-dss-4.0` bundle produces this finding:

```json
{
  "code": "IAP701",
  "severity": "error",
  "framework": "pci-dss-4.0",
  "control": "3.5.1",
  "bundleVersion": "1.2.0",
  "rule": "pci-req3-encryption-at-rest",
  "resource": "payments-db",
  "path": "resources.payments-db.spec.encryption.atRest",
  "expected": "required",
  "actual": "preferred",
  "message": "PCI DSS 4.0 Req 3 (control 3.5.1): stored account data must be encrypted at rest; spec.encryption.atRest is 'preferred' on a pci-scope resource.",
  "disposition": "violated"
}
```

The same downgrade also triggers **IAP603** from the security validator ([Chapter 15, §15.6](15-security-model.md)). Removing the two `atRest: preferred` / downgrade lines — or pairing the document with the `pci` profile, whose overlay restores the default — moves control 3.5.1 to `satisfied` in the evidence report.
