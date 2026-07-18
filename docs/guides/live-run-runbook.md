# Live-Run Runbook & Evidence Template

**Roadmap Phases 21–24 (ROADMAP-V4).** Every wave with live runs (M21.2, M21.3, M22.1–M22.5,
M23.2, M23.4, M23.5, M24.2, M24.3) follows this runbook. Live runs execute **per service
individually** (requester-directed 2026-07-16): within an approved wave, each service deploys,
passes the 9 lifecycle tests, tears down fully, and gets its own evidence doc
(`docs/reports/<milestone>-<service>-live-run-evidence.md`) before the next service starts; a
failed service run stops the wave. The template generalizes the M19.3 golden-path run
(recoverable at `e10ebe0^:docs/reports/m19.3-live-run-evidence.md`), which proved the
9-lifecycle-test shape on S3/SQS/IAM.

## Pre-flight (every wave)

The pre-flight is executable (M21.1 harness):

```sh
pnpm run live:preflight -- --region <region> --aws-profile <profile> [--run-id infraasprompt-<epoch>]
# dry-run against mock (no credentials, no network; mapping checks still real):
pnpm run live:preflight -- --mock
```

It verifies: region chosen (fail-closed), run-id scheme, mapping integrity digests, manifest
ed25519 signature, credentials, and the budget alarm. All steps must PASS before the run.

1. **Human approval.** Every live run is a HUMAN-APPROVAL gate in `ROADMAP-V4.yml`. Do not
   execute without it.
2. **AWS account/profile.** On the **first** live-run wave (M21.2) the executing agent asks the
   user which AWS account/profile to use. **Every subsequent wave reuses that provided profile
   without re-asking.** Pass it via `--aws-profile` (the `--profile` flag stays the IaP merge
   profile — an M19.3 lesson). In committed evidence docs, record account ids and profile names
   as `REDACTED`.
3. **Region.** One region per wave, recorded in the evidence doc; default to the region chosen
   at M21.2 unless a service forces otherwise.
4. **Run id.** `infraasprompt-<epoch-seconds>` (infraasprompt naming, requester-directed 2026-07-16; the
   first Resource Groups run pre-dates it with `iapg-…`). Every resource is named with the run
   id and tagged `iap:managed=true` / `iap:planId` / `iap:resourceId` — the `iap:*` tag keys
   are product contract, not resource names, and stay unchanged.
5. **Budget alarm.** Verify an AWS Budgets alarm exists on the account (threshold at or below
   the remaining roadmap ceiling — <$25 total across all waves). If absent, create it before
   the first resource. No alarm → no run.
6. **Mapping signature.** Verify `providers/aws/mappings/core.iap-map.yaml` digest matches
   `providers/aws/manifest.json` and the ed25519 signature verifies. A wave that bumped the
   mapping re-signs **before** the live run (procedure below).

## The 9 lifecycle tests (every service run)

Each service's live run drives that service's workload through all nine, in order. Results go in
the evidence table. A test that cannot apply to the wave's resource types gets an explicit
justification, never a silent skip — M19.3 recorded test 4 as "⚠️ deferred" because S3/SQS/IAM
identity _is_ the name; from M21.1 onward replacement semantics exist, so waves with an
immutable-attribute resource (first: DynamoDB in M22.2) must exercise it for real.

| #   | Test                   | What must be shown                                                                               |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | **Create**             | All resources created; live ARNs/ids recorded                                                    |
| 2   | **No-op**              | Immediate re-run plans all `no-op` (idempotent)                                                  |
| 3   | **Safe update**        | A mutable attribute change plans `update-in-place` and reconciles                                |
| 4   | **Replacement update** | An immutable attribute change plans `replace`; gated delete+create executes (or a justified N/A) |
| 5   | **Drift**              | Out-of-band change via raw AWS CLI → `iap drift` reports `inSync:false`; read-only               |
| 6   | **Controlled failure** | An induced failure fails closed: recorded in `errors[]`, non-zero exit, no silent success        |
| 7   | **Recovery**           | Re-deploy after the fix converges: `errors: []`, exit 0                                          |
| 8   | **Destroy**            | `iap destroy --confirm` deletes all managed resources, managed-only                              |
| 9   | **Cleanup verify**     | Direct API reads → NotFound; drift → all `absent`; tag sweep → zero orphans                      |

## Evidence doc template

One doc per **service run** at `docs/reports/<milestone-id>-<service>-live-run-evidence.md`
(lowercase, e.g. `m21.2-secrets-manager-live-run-evidence.md`). Copy this skeleton:

```markdown
# <MILESTONE> — <wave title>: LIVE RUN EVIDENCE

**Date:** YYYY-MM-DD · **Status:** COMPLETE — executed against **real AWS** and fully torn down.
**Account:** REDACTED · **Region:** <region> · **Profile:** `REDACTED`
· **Run id:** `infraasprompt-<epoch>`.

This is genuine live evidence, not a mock. <one sentence: what the CLI drove end to end.>

## Workload

<the IaP document kinds → target types applied, with --confirm, all tagged iap:managed=true.>

## The 9 lifecycle tests

| #   | Test                   | Result | Evidence |
| --- | ---------------------- | ------ | -------- |
| 1   | **Create**             |        |          |
| 2   | **No-op**              |        |          |
| 3   | **Safe update**        |        |          |
| 4   | **Replacement update** |        |          |
| 5   | **Drift**              |        |          |
| 6   | **Controlled failure** |        |          |
| 7   | **Recovery**           |        |          |
| 8   | **Destroy**            |        |          |
| 9   | **Cleanup verify**     |        |          |

## Real bugs caught by live execution (mock tests could not)

<numbered list; each item: the verbatim error, cause, fix, regression test path. "None" is a
valid and reportable outcome.>

## Honest scope notes

<what this wave did NOT prove; caveats such as default-VPC usage (ADR-0005), certificates
stuck at PENDING_VALIDATION pre-M23.2, deferred sub-gates.>

## Cost

<resources, live duration, estimated spend for THIS service run; running total against the
<$25 roadmap ceiling. Cost Explorer actuals lag ~24h — figures here are resource-hour
estimates, reconciled at closeout (M24.4).>
```

**Cost status after every service run** (requester directive 2026-07-16): report the run's
estimated cost and the roadmap's running total immediately after each service's teardown —
in the evidence doc's Cost section AND in the session report — before the next service starts.

## Post-run sweep (after every service run)

The sweep is executable (M21.1 harness):

```sh
pnpm run live:sweep -- --region <region> --aws-profile <profile> [--run-id infraasprompt-<epoch>]
# dry-run against mock:
pnpm run live:sweep -- --mock
```

1. Tagging-API sweep for `iap:managed=true` in the run's region → must return `[]`.
2. Name-prefix sweep for `infraasprompt-<runid>-*` on every service the wave touched (including IAM,
   which the tag API misses) → zero matches.
3. Record **"Zero orphans."** in the evidence doc, or list and delete the stragglers and
   re-sweep.

**Slow-teardown notes.** CloudFront (M24.2) must be **disabled, waited on, then deleted** —
budget the wall clock. NAT gateways (M23.4), cluster engines (M22.3), MSK (M23.5) and
OpenSearch domains have multi-minute deleters: set explicit waiter budgets before the run; a
wave that cannot finish teardown in-session is a failed wave, not a "finish later".

## Cost control

| Wave  | Live workload                                             | Est. cost    |
| ----- | --------------------------------------------------------- | ------------ |
| M21.2 | Resource Groups, Secrets Manager, ACM, TargetGroup        | ~$0          |
| M21.3 | 3-tier app (ECS + ALB + RDS + ElastiCache)                | ~$2–4        |
| M22.1 | Serverless API (Lambda, APIGW, SNS, SSM, Scheduler)       | ~$0          |
| M22.2 | DynamoDB, Timestream, KMS, Backup                         | <$0.25       |
| M22.3 | Aurora, DocumentDB, Neptune, MemoryDB, MQ                 | ~$3–6        |
| M22.4 | EBS, EFS, FSx                                             | <$1          |
| M22.5 | EC2, ASG, App Runner, Batch, NLB, WAF                     | <$1          |
| M23.2 | Route 53, ECR, CloudWatch, Keyspaces, Redshift Serverless | ~$2          |
| M23.4 | Full VPC up/down + Step Functions                         | <$1          |
| M23.5 | Kinesis, Firehose, MSK Serverless, OpenSearch             | ~$3–5        |
| M24.2 | CloudFront, EventBridge, Cognito                          | ~$0 (slow)   |
| M24.3 | EKS / AppSync / SES (each gated)                          | ~$1–3 if run |

Hard ceiling: **<$25 total** across all waves. Every evidence doc reports the running total.
Under pressure, apply the cut order — SES → AppSync → EKS → Neptune → FSx → MSK live
evidence — each cut a human decision at a gate.

## Mapping re-sign procedure & key custody (Phase 22+ waves)

Waves that expand the mapping (~8 bumps expected across Phases 22–24) re-sign before their
live run:

1. Edit `providers/aws/mappings/core.iap-map.yaml` (additive targets for the wave).
2. Recompute the file's SHA-256 and update `integrity.digests` in
   `providers/aws/manifest.json`.
3. Re-sign the manifest with the ed25519 key (`keyId: aws-test-2026`, keypair under
   `providers/aws/keys/` — repo-local **test** keys, allowlisted in the secret scanner).
4. Run the provider verification suite; a signature mismatch fails closed.

**Key custody.** The `aws-test-2026` keypair is test-only and lives in the repo by design.
Production key custody (who holds a non-test signing key, where it lives, rotation) is a
decision that must be taken **before Phase 22's first mapping bump (M22.1)** and recorded in
`ROADMAP-V4.yml` `decisionsTaken`.
