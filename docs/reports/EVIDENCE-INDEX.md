# ROADMAP-V4 — Consolidated Live-Run Evidence Index (M24.4 closeout)

**Date:** 2026-07-18 · **Milestone:** M24.4 · **Ceiling:** <$25 total live spend ·
**Region:** eu-central-1 (M21.2 gate; reused per roadmap) · **Naming:** `jarvis-` prefix.

> All cost figures are **resource-hour estimates** reconciled from each doc's Cost section.
> **Cost Explorer actuals lag ~24 h** — these are not billed actuals. Every clean run tore down
> to **zero orphans** (per-run run-scoped checks + coordinator global sweeps). "9/9" = all nine
> lifecycle tests passed; "8+repl-N/A" or "repl-deferred" = full lifecycle with the replacement
> leg justified-N/A or classification-only (execution deferred, discharged live at M22.2 DynamoDB).

## Evidence docs in roadmap order (50 evidence files = 47 live-run + 3 deferral records)

| # | Milestone | Service(s) | Doc | Run id | Result | Cost (est.) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | M21.2 | Resource Groups | m21.2-resource-groups-live-run-evidence.md | `iapg-1784203769` | 9/9 (repl N/A) | $0.00 |
| 2 | M21.2 | Secrets Manager | m21.2-secrets-manager-live-run-evidence.md | `jarvis-1784205298` | 9/9 (repl N/A) | $0.00 |
| 3 | M21.2 | ACM Certificate | m21.2-acm-live-run-evidence.md | `jarvis-1784205607` | 9/9 (1st live replacement) | $0.00 |
| 4 | M21.2 | ALB TargetGroup | m21.2-target-group-live-run-evidence.md | `jarvis-1784206236` | 9/9 (port-replace live) | $0.00 |
| 5 | M21.3 | ECS | m21.3-ecs-live-run-evidence.md | `jarvis-1784207615` | 9/9 | $0.02 |
| 6 | M21.3 | ALB | m21.3-alb-live-run-evidence.md | `jarvis-1784208415` | 9/9 | $0.01 |
| 7 | M21.3 | ElastiCache (Redis) | m21.3-elasticache-live-run-evidence.md | `jarvis-1784208612` | 9/9 | $0.03 |
| 8 | M21.3 | RDS | m21.3-rds-live-run-evidence.md | `jarvis-1784210467` | 9/9 | $0.02 |
| 9 | M22.1 | SNS | m22.1-sns-live-run-evidence.md | `jarvis-1784215942` | 9/9 | $0.00 |
| 10 | M22.1 | SSM Parameter | m22.1-ssm-parameter-live-run-evidence.md | `jarvis-1784216089` | 9/9 (SSM type replace live) | $0.00 |
| 11 | M22.1 | CloudWatch Logs | m22.1-cloudwatch-logs-live-run-evidence.md | `jarvis-1784216173` | 9/9 | $0.00 |
| 12 | M22.1 | S3 (public) | m22.1-s3-public-live-run-evidence.md | `jarvis-1784216247` | 9/9 (anon 200→403) | $0.00 |
| 13 | M22.1 | SQS (DLQ) | m22.1-sqs-dlq-live-run-evidence.md | `jarvis-1784216417` | 9/9 | $0.00 |
| 14 | M22.1 | Lambda | m22.1-lambda-live-run-evidence.md | `jarvis-1784216685` | 9/9 | ~$0.00 |
| 15 | M22.1 | EventBridge Scheduler | m22.1-scheduler-live-run-evidence.md | `jarvis-1784216685` | 9/9 | $0.00 |
| 16 | M22.1 | API Gateway | m22.1-apigateway-live-run-evidence.md | `jarvis-1784216685` | 9/9 (public URL→Lambda live) | $0.00 |
| 17 | M22.2 | DynamoDB | m22.2-dynamodb-live-run-evidence.md | `jarvis-1784279604` | 9/9 (**mandated replacement executed live**) | ~$0.00 |
| 18 | M22.2 | KMS | m22.2-kms-live-run-evidence.md | `jarvis-1784279606` | 9/9 (keySpec replace live) | $0.003 |
| 19 | M22.2 | AWS Backup | m22.2-backup-live-run-evidence.md | `jarvis-1784279607` | 9/9 (repl N/A) | $0.00 |
| 20 | M22.2 | **Timestream — DEFERRAL** | m22.2-timestream-live-run-evidence.md | — | **justified deferral** (account not onboarded); handler 11/11 mock | $0.00 |
| 21 | M22.3 | Aurora | m22.3-aurora-live-run-evidence.md | `jarvis-1784307755` | 9/9 (repl deferred) | ~$0.05 |
| 22 | M22.3 | DocumentDB | m22.3-docdb-live-run-evidence.md | `jarvis-1784307756` | 9/9 | ~$0.03 |
| 23 | M22.3 | Neptune | m22.3-neptune-live-run-evidence.md | `jarvis-1784338123` | 9/9 (repl deferred) | ~$0.09 |
| 24 | M22.3 | MemoryDB | m22.3-memorydb-live-run-evidence.md | `jarvis-1784338124` | 9/9 (repl deferred) | ~$0.10 |
| 25 | M22.3 | Amazon MQ | m22.3-mq-live-run-evidence.md | `jarvis-1784338125` | 9/9 (**2 live bugs fixed**) | ~$0.01 |
| 26 | M22.3 | ElastiCache Memcached | m22.3-elasticache-memcached-live-run-evidence.md | `jarvis-1784338126` | 9/9 | ~$0.02 |
| 27 | M22.4 | EBS | m22.4-ebs-live-run-evidence.md | `jarvis-1784289033` | 9/9 (AZ-pin replace live) | ~$0.00 |
| 28 | M22.4 | EFS | m22.4-efs-live-run-evidence.md | `jarvis-1784289034` | 9/9 (**1 live bug fixed**) | ~$0.00 |
| 29 | M22.4 | FSx | m22.4-fsx-live-run-evidence.md | `jarvis-1784338127` | 9/9 (repl deferred) | ~$0.03 |
| 30 | M22.5 | EC2 + LaunchTemplate | m22.5-ec2-live-run-evidence.md | `jarvis-1784289036` | 9/9 (**1 live bug fixed**) | <$0.01 |
| 31 | M22.5 | Auto Scaling (ASG) | m22.5-asg-live-run-evidence.md | `jarvis-1784289037` | 9/9 (dependsOn ordering live) | ~$0.01 |
| 32 | M22.5 | AWS Batch | m22.5-batch-live-run-evidence.md | `jarvis-1784289039` | 9/9 (**1 live bug fixed**) | $0.00 |
| 33 | M22.5 | NLB | m22.5-nlb-live-run-evidence.md | `jarvis-1784289040` | 9/9 (repl deferred) | ~$0.03 |
| 34 | M22.5 | WAFv2 | m22.5-waf-live-run-evidence.md | `jarvis-1784289041` | 9/9 | ~$0.01 |
| 35 | M22.5 | App Runner | m22.5-apprunner-live-run-evidence.md | `jarvis-1784338128` | 9/9 (HTTP 200 live) | ~$0.01 |
| 36 | M23.2 | Route 53 | m23.2-route53-live-run-evidence.md | `jarvis-1784345750` | 9/9 | ~$0.00 |
| 37 | M23.2 | ECR | m23.2-ecr-live-run-evidence.md | `jarvis-1784345751` | 9/9 (encryption replace live) | ~$0.00 |
| 38 | M23.2 | CloudWatch Alarm+Dashboard | m23.2-cloudwatch-live-run-evidence.md | `jarvis-1784345752` | 9/9 | ~$0.00 |
| 39 | M23.2 | Keyspaces | m23.2-keyspaces-live-run-evidence.md | `jarvis-1784345753` | 9/9 (schema replace live; **3 live bugs fixed** wave) | ~$0.00–0.01 |
| 40 | M23.2 | Redshift Serverless | m23.2-redshift-serverless-live-run-evidence.md | `jarvis-1784345754` | 9/9 | ~$0.00 |
| 41 | M23.2 | ACM → ISSUED | m23.2-acm-issued-live-run-evidence.md | `jarvis-1784345755` | **justified-partial** (DNS-validation wiring live; ISSUED needs delegated domain) | $0.00 |
| 42 | M23.4 | VPC graph + Step Functions | m23.4-network-workflow-live-run-evidence.md | `jarvis-1784349970` | full graph up/down + Express SM SUCCEEDED (**1 live bug fixed**) | <$0.01 |
| 43 | M23.5 | Kinesis | m23.5-kinesis-live-run-evidence.md | `jarvis-1784351929` | 9/9 (mode change in-place live) | ~$0.01 |
| 44 | M23.5 | Firehose | m23.5-firehose-live-run-evidence.md | `jarvis-1784351930` | 9/9 (survived token expiry) | $0.00 |
| 45 | M23.5 | OpenSearch | m23.5-opensearch-live-run-evidence.md | `jarvis-search-1931` | 9/9 (repl deferred) | ~$0.02 |
| 46 | M23.5 | **MSK Serverless — DEFERRAL** | m23.5-msk-live-run-evidence.md | — | **justified deferral** at sub-gate (cost/spin-up, cut order); handler 10/10 mock | $0.00 |
| 47 | M24.2 | EventBridge | m24.2-eventbridge-live-run-evidence.md | `jarvis-1784356901` | 9/9 | $0.00 |
| 48 | M24.2 | Cognito | m24.2-cognito-live-run-evidence.md | `jarvis-1784356902` | 9/9 (secret-replace live, zero leak) | $0.00 |
| 49 | M24.2 | CloudFront | m24.2-cloudfront-live-run-evidence.md | `jarvis-1784356903` | 9/9 (Deployed; disable-then-delete; teardown corrected by coordinator sweep) | ~$0.00 |
| 50 | M24.3 | **EKS / AppSync / SES — DEFERRAL** | m24.3-stretch-wave-deferral-evidence.md | — | all three **deferred/cut** at per-item gates (SES Email-kind rejected) | $0.00 |

**Doc count:** 50 evidence files on disk — 49 named `*-live-run-evidence.md` + 1 named
`*-deferral-evidence.md`. By content: **47 true live runs + 3 justified deferrals** (Timestream
and MSK are recorded inside `*-live-run-evidence.md` files but are deferrals; the M24.3 stretch
record is the lone `*-deferral-evidence.md`). Rows 20 / 46 / 50 above are the 3 deferral records.

## Total live spend vs the <$25 ceiling

| Line | Amount | Note |
| --- | --- | --- |
| **Clean-run resource-hours (all live services, summed from the Cost sections above)** | **≈ $0.53** | Sum of per-service estimates; dominated by M22.3 clusters (Aurora/DocDB/Neptune/MemoryDB/MQ/Memcached ≈ $0.30) and M22.5 (≈ $0.07). Most services rounded to $0.00 (free-tier / zero-traffic / short-lived). |
| **M22.3 token-expiry overrun (avoidable)** | **≈ $3.50** | Two SSO-token-expiry episodes stranded billing resources (~5 h crash + ~15 h overnight, both fully cleaned up). Recorded honestly in the M22.3 evidence + roadmap; mitigation added (fail-fast on `ExpiredToken`, coordinator takeover). Not clean-run cost. |
| **HONEST TOTAL LIVE SPEND (resource-hour estimate)** | **≈ $4.0** | Matches the roadmap running estimate of **~$4 / $25**. |
| **Headroom vs ceiling** | **≈ $21** | ~$4 of $25 used; **under the <$25 ceiling with comfortable margin**. |

Caveat (verbatim from the docs): these are **resource-hour estimates**; **Cost Explorer actuals lag
~24 h** and are the reconciliation source of record. Had the two M22.3 token-expiry episodes not
occurred, clean-run spend would be ~$0.5. The overrun is called out as a distinct, avoidable line
rather than folded into the service costs.

## Workspace test count at closeout

`pnpm vitest run --reporter=dot` → **1780 passed · 5 skipped** across **124 test files**
(exit 0). The 5 skips are pre-existing and were **not** touched at closeout (report-only, per the
M24.4 brief). Every shipped handler is mock-tested (aws-sdk-client-mock) — no untested handler
sits behind `SUPPORTED_TARGET_TYPES`.

## Executable surface at closeout

`SUPPORTED_TARGET_TYPES` (derived from `HANDLER_REGISTRATIONS` in
`packages/deploy-aws/src/registry.ts`) = **68 registered handlers / target types**, all distinct
(duplicate registration fails fast), covering **47 of 50** target services. See
`aws-support-matrix.md` (regenerated) and `m24.4-coverage-audit.md` for the per-service breakdown.
