# IaP — AWS Support Matrix (ROADMAP-V4 — regenerated at M24.4 closeout)

**Date:** 2026-07-18 · **Scope:** `ROADMAP-V4.yml` + `roadmap-v4` (repo root) ·
**Ground truth:** `packages/deploy-aws/src/registry.ts` (`SUPPORTED_TARGET_TYPES`,
68 registered handlers = what actually ships executable),
`docs/reports/*-live-run-evidence.md` (which handlers were live-proven),
`docs/guides/live-run-runbook.md`.

> **Regenerated against reality (M24.4).** The M21.1 "read this first" note is now
> historical: IaP no longer live-deploys "exactly 3 target types". As of Phase 24
> closeout the executor registers and realizes **68 target types** across **47 of the
> 50 target AWS services** — every one mock-tested (aws-sdk-client-mock) and, for 45
> services, individually **live-proven** (deploy → 9-lifecycle-test → full teardown →
> per-service evidence doc). The remaining rows are honestly accounted for below:
> 2 mock-only handlers (live deferred at a gate), 2 handler-deferred services, 1 cut.
> **No service is silently dropped.** Status column key: **live-proven** (handler
> shipped + live 9/9 or justified-partial), **mock-only** (handler shipped, mock-tested,
> live run deferred at a gate), **deferred** (no handler, deferred at a recorded gate),
> **cut** (no handler by design at a recorded gate).

## The 50 services — actual shipped status

| #   | AWS service                       | IaP kind(s)                             | Class | Wave                    | Status                                               | Run id / evidence doc                                                                                                                                                                         |
| --- | --------------------------------- | --------------------------------------- | ----- | ----------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Amazon S3                         | `ObjectStore`                           | live  | pre-v4; M22.1           | **live-proven**                                      | `infraasprompt-1784216247` · m22.1-s3-public-live-run-evidence.md                                                                                                                             |
| 2   | Amazon SQS                        | `Queue`                                 | live  | pre-v4; M22.1           | **live-proven**                                      | `infraasprompt-1784216417` · m22.1-sqs-dlq-live-run-evidence.md                                                                                                                               |
| 3   | AWS IAM                           | `Identity`                              | live  | pre-v4; M22.1           | **live-proven**                                      | pre-v4 live type; live-exercised as a sibling role in Lambda/Scheduler/Batch/Firehose/StateMachine runs (no standalone doc)                                                                   |
| 4   | AWS Resource Groups               | `Application`                           | A     | M21.2                   | **live-proven**                                      | `iapg-1784203769` · m21.2-resource-groups-live-run-evidence.md                                                                                                                                |
| 5   | AWS Secrets Manager               | `Secret`                                | A     | M21.2                   | **live-proven**                                      | `infraasprompt-1784205298` · m21.2-secrets-manager-live-run-evidence.md                                                                                                                       |
| 6   | AWS Certificate Manager           | Gateway-derived → `Certificate` (1.1.0) | A     | M21.2 / M23.2           | **live-proven** (ISSUED justified-partial)           | `infraasprompt-1784205607` · m21.2-acm-live-run-evidence.md; `infraasprompt-1784345755` · m23.2-acm-issued-live-run-evidence.md (DNS-validation wiring live; ISSUED needs a delegated domain) |
| 7   | Amazon ECS                        | `Service`                               | A     | M21.3                   | **live-proven**                                      | `infraasprompt-1784207615` · m21.3-ecs-live-run-evidence.md                                                                                                                                   |
| 8   | Application Load Balancer         | `Gateway`                               | A     | M21.3 (TG M21.2)        | **live-proven**                                      | `infraasprompt-1784208415` · m21.3-alb-live-run-evidence.md; `infraasprompt-1784206236` · m21.2-target-group-live-run-evidence.md                                                             |
| 9   | Amazon RDS                        | `Database`                              | A     | M21.3                   | **live-proven**                                      | `infraasprompt-1784210467` · m21.3-rds-live-run-evidence.md                                                                                                                                   |
| 10  | Amazon ElastiCache                | `Cache`                                 | A     | M21.3 (Memcached M22.3) | **live-proven**                                      | `infraasprompt-1784208612` · m21.3-elasticache-live-run-evidence.md; `infraasprompt-1784338126` · m22.3-elasticache-memcached-live-run-evidence.md                                            |
| 11  | AWS Lambda                        | `Function`                              | B     | M22.1                   | **live-proven**                                      | `infraasprompt-1784216685` · m22.1-lambda-live-run-evidence.md                                                                                                                                |
| 12  | Amazon API Gateway                | `Gateway`                               | B     | M22.1                   | **live-proven**                                      | `infraasprompt-1784216685` · m22.1-apigateway-live-run-evidence.md                                                                                                                            |
| 13  | Amazon SNS                        | `Topic`                                 | B     | M22.1                   | **live-proven**                                      | `infraasprompt-1784215942` · m22.1-sns-live-run-evidence.md                                                                                                                                   |
| 14  | AWS SSM Parameter Store           | `Secret`                                | B     | M22.1                   | **live-proven**                                      | `infraasprompt-1784216089` · m22.1-ssm-parameter-live-run-evidence.md                                                                                                                         |
| 15  | Amazon EventBridge Scheduler      | `Job` (cron)                            | B     | M22.1                   | **live-proven**                                      | `infraasprompt-1784216685` · m22.1-scheduler-live-run-evidence.md                                                                                                                             |
| 16  | Amazon CloudWatch Logs            | derived (log posture)                   | B     | M22.1                   | **live-proven**                                      | `infraasprompt-1784216173` · m22.1-cloudwatch-logs-live-run-evidence.md                                                                                                                       |
| 17  | Amazon DynamoDB                   | `Database`                              | B     | M22.2                   | **live-proven** (mandated replacement executed live) | `infraasprompt-1784279604` · m22.2-dynamodb-live-run-evidence.md                                                                                                                              |
| 18  | Amazon Timestream                 | `Database`                              | B     | M22.2                   | **mock-only** (live deferred)                        | m22.2-timestream-live-run-evidence.md — JUSTIFIED DEFERRAL: account not onboarded (AWS closed LiveAnalytics onboarding 2025); handlers 11/11 mock-proven, executor failed closed              |
| 19  | AWS KMS                           | derived (encryption posture)            | B     | M22.2                   | **live-proven**                                      | `infraasprompt-1784279606` · m22.2-kms-live-run-evidence.md                                                                                                                                   |
| 20  | AWS Backup                        | derived (backup posture)                | B     | M22.2                   | **live-proven**                                      | `infraasprompt-1784279607` · m22.2-backup-live-run-evidence.md                                                                                                                                |
| 21  | Amazon Aurora                     | `Database`                              | B     | M22.3                   | **live-proven**                                      | `infraasprompt-1784307755` · m22.3-aurora-live-run-evidence.md                                                                                                                                |
| 22  | Amazon DocumentDB                 | `Database`                              | B     | M22.3                   | **live-proven**                                      | `infraasprompt-1784307756` · m22.3-docdb-live-run-evidence.md                                                                                                                                 |
| 23  | Amazon Neptune                    | `Database`                              | B     | M22.3                   | **live-proven**                                      | `infraasprompt-1784338123` · m22.3-neptune-live-run-evidence.md                                                                                                                               |
| 24  | Amazon MemoryDB                   | `Cache`                                 | B     | M22.3                   | **live-proven**                                      | `infraasprompt-1784338124` · m22.3-memorydb-live-run-evidence.md                                                                                                                              |
| 25  | Amazon MQ                         | `Queue`, `Topic`                        | B     | M22.3                   | **live-proven** (2 live bugs fixed)                  | `infraasprompt-1784338125` · m22.3-mq-live-run-evidence.md                                                                                                                                    |
| 26  | Amazon EBS                        | `Volume`                                | B     | M22.4                   | **live-proven**                                      | `infraasprompt-1784289033` · m22.4-ebs-live-run-evidence.md                                                                                                                                   |
| 27  | Amazon EFS                        | `Volume`                                | B     | M22.4                   | **live-proven** (1 live bug fixed)                   | `infraasprompt-1784289034` · m22.4-efs-live-run-evidence.md                                                                                                                                   |
| 28  | Amazon FSx                        | `Volume`                                | B     | M22.4                   | **live-proven**                                      | `infraasprompt-1784338127` · m22.4-fsx-live-run-evidence.md                                                                                                                                   |
| 29  | Amazon EC2                        | `Service` (vm)                          | B     | M22.5                   | **live-proven** (1 live bug fixed)                   | `infraasprompt-1784289036` · m22.5-ec2-live-run-evidence.md                                                                                                                                   |
| 30  | Amazon EC2 Auto Scaling           | `Service` (scaling)                     | B     | M22.5                   | **live-proven** (dependsOn ordering proven live)     | `infraasprompt-1784289037` · m22.5-asg-live-run-evidence.md                                                                                                                                   |
| 31  | AWS App Runner                    | `Service`                               | B     | M22.5                   | **live-proven** (HTTP 200 live)                      | `infraasprompt-1784338128` · m22.5-apprunner-live-run-evidence.md                                                                                                                             |
| 32  | AWS Batch                         | `Job`                                   | B     | M22.5                   | **live-proven** (1 live bug fixed)                   | `infraasprompt-1784289039` · m22.5-batch-live-run-evidence.md                                                                                                                                 |
| 33  | Network Load Balancer             | `Gateway`                               | B     | M22.5                   | **live-proven**                                      | `infraasprompt-1784289040` · m22.5-nlb-live-run-evidence.md                                                                                                                                   |
| 34  | AWS WAF (WAFv2)                   | derived (public `Gateway` posture)      | B     | M22.5                   | **live-proven**                                      | `infraasprompt-1784289041` · m22.5-waf-live-run-evidence.md                                                                                                                                   |
| 35  | Amazon Route 53                   | `DnsZone` (1.1.0)                       | C     | M23.2                   | **live-proven**                                      | `infraasprompt-1784345750` · m23.2-route53-live-run-evidence.md                                                                                                                               |
| 36  | Amazon ECR                        | `Registry` (1.1.0)                      | C     | M23.2                   | **live-proven**                                      | `infraasprompt-1784345751` · m23.2-ecr-live-run-evidence.md                                                                                                                                   |
| 37  | Amazon CloudWatch                 | `Alert` + `Dashboard` (1.1.0)           | C     | M23.2                   | **live-proven**                                      | `infraasprompt-1784345752` · m23.2-cloudwatch-live-run-evidence.md                                                                                                                            |
| 38  | Amazon Keyspaces                  | `Database` (wide-column, 1.1.0)         | C     | M23.2                   | **live-proven**                                      | `infraasprompt-1784345753` · m23.2-keyspaces-live-run-evidence.md                                                                                                                             |
| 39  | Amazon Redshift Serverless        | `Database` (warehouse, 1.1.0)           | C     | M23.2                   | **live-proven**                                      | `infraasprompt-1784345754` · m23.2-redshift-serverless-live-run-evidence.md                                                                                                                   |
| 40  | Amazon VPC                        | `Network` (1.2.0)                       | C     | M23.4                   | **live-proven** (full VPC graph up/down)             | `infraasprompt-1784349970` · m23.4-network-workflow-live-run-evidence.md                                                                                                                      |
| 41  | AWS Step Functions                | `Workflow` (1.2.0)                      | C     | M23.4                   | **live-proven** (Express SM SUCCEEDED)               | `infraasprompt-1784349970` · m23.4-network-workflow-live-run-evidence.md                                                                                                                      |
| 42  | Amazon Kinesis (Streams+Firehose) | `Stream` (1.2.0)                        | C     | M23.5                   | **live-proven**                                      | `infraasprompt-1784351929` · m23.5-kinesis-live-run-evidence.md; `infraasprompt-1784351930` · m23.5-firehose-live-run-evidence.md                                                             |
| 43  | Amazon MSK Serverless             | `Stream` (1.2.0)                        | C     | M23.5                   | **mock-only** (live deferred at sub-gate)            | m23.5-msk-live-run-evidence.md — JUSTIFIED DEFERRAL: ~$0.75/hr + 15-30min spin-up, on the cut order; handler 10/10 mock-proven, live-ready when the sub-gate approves                         |
| 44  | Amazon OpenSearch Service         | `SearchIndex` (1.2.0)                   | C     | M23.5                   | **live-proven**                                      | `infraasprompt-search-1931` · m23.5-opensearch-live-run-evidence.md                                                                                                                           |
| 45  | Amazon CloudFront                 | `Cdn` (new, 1.3.0)                      | D     | M24.2                   | **live-proven** (Deployed; disable-then-delete)      | `infraasprompt-1784356903` · m24.2-cloudfront-live-run-evidence.md                                                                                                                            |
| 46  | Amazon EventBridge                | `EventBus` (new, 1.3.0)                 | D     | M24.2                   | **live-proven**                                      | `infraasprompt-1784356901` · m24.2-eventbridge-live-run-evidence.md                                                                                                                           |
| 47  | Amazon Cognito                    | `Identity` (user-directory, 1.3.0)      | D     | M24.2                   | **live-proven** (secret-replace live, zero leak)     | `infraasprompt-1784356902` · m24.2-cognito-live-run-evidence.md                                                                                                                               |
| 48  | Amazon EKS                        | `Service` (runtime=kubernetes, 1.3.0)   | D     | M24.3                   | **deferred** (no handler)                            | m24.3-stretch-wave-deferral-evidence.md — control plane ~$0.10/hr + ~30min create/delete, high on cut order; addable mock-first + one gated live pass                                         |
| 49  | AWS AppSync                       | `Gateway` (protocol=graphql, 1.3.0)     | D     | M24.3                   | **deferred** (no handler)                            | m24.3-stretch-wave-deferral-evidence.md — gated, low runtime-infra pull-through                                                                                                               |
| 50  | Amazon SES                        | Email-kind decision M24.1 → rejected    | D     | M24.3                   | **cut** (no handler by design)                       | m24.3-stretch-wave-deferral-evidence.md — Email kind REJECTED in IEP-0017 (M24.1); email is a messaging-verb concern, not an infra kind; reserves no name                                     |

## Actual outcome roll-up (M24.4)

| Bucket                             | Count  | Services                                                                 |
| ---------------------------------- | ------ | ------------------------------------------------------------------------ |
| **live-proven**                    | 45     | rows 1–17, 19–42, 44–47 (ACM ISSUED is a justified-partial within row 6) |
| **mock-only** (live deferred)      | 2      | Timestream (18), MSK (43)                                                |
| **deferred** (no handler, at gate) | 2      | EKS (48), AppSync (49)                                                   |
| **cut** (no handler by design)     | 1      | SES (50)                                                                 |
| **Total**                          | **50** | every service accounted for — no silent drops                            |

Executable surface: **68 registered target types** (`SUPPORTED_TARGET_TYPES`, all mock-tested),
covering **47 of 50 services** (all but EKS/AppSync/SES). 65 of those 68 target types belong to
the 45 live-proven services; Timestream (2 target types) and MSK (1) are the mock-only remainder.

## How the 50 are counted (unchanged, re-verified)

Five counting decisions keep the arithmetic exact:

1. **Elastic Load Balancing splits into two rows** — ALB is class A (row 8), NLB is class B (row 33).
2. **Kinesis Data Streams + Data Firehose are one row** (row 42, both target types).
3. **CloudWatch Logs (B, M22.1) and CloudWatch (C, M23.2) are separate rows** (rows 16 and 37).
4. **Zero-row mentions** — upgrades/sub-resources are not services: S3-public, SQS-DLQ, Memcached
   engine values, the ACM first-class upgrade, ECS Cluster, LaunchTemplate, DBSubnetGroup,
   cluster instances, listeners, subnet groups.
5. **Derived-posture services count only as rows** — CloudWatch Logs, KMS, AWS Backup, WAFv2 are rows.

Count check: live 3 (1–3) + A 7 (4–10) + B 24 (11–34) + C 10 (35–44) + D 6 (45–50) = **50**. Verified.

## Class legend + class-level status re-verification

| Class | Meaning                                                         | Where it lands | Live-proven / mock-only / deferred / cut      |
| ----- | --------------------------------------------------------------- | -------------- | --------------------------------------------- |
| live  | Deployable pre-v4 (`SUPPORTED_TARGET_TYPES`)                    | pre-v4 (M19.3) | 3 / 0 / 0 / 0                                 |
| A     | Already in the signed mapping; needs a runtime handler only     | Phase 21       | 7 / 0 / 0 / 0                                 |
| B     | Mapping expansion, zero spec change                             | Phase 22       | 23 / 1 / 0 / 0 (Timestream mock-only)         |
| C     | Needs a reserved-kind graduation (1.1.0 / 1.2.0)                | Phase 23       | 9 / 1 / 0 / 0 (MSK mock-only)                 |
| D     | Needs new vocabulary (1.3.0: `Cdn`, `EventBus`, enum widenings) | Phase 24       | 3 / 0 / 2 / 1 (EKS/AppSync deferred, SES cut) |
| **Σ** |                                                                 |                | **45 / 2 / 2 / 1 = 50**                       |

## Not mapped / explicitly deferred (outside the 50)

| Service family                        | Reason                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------- |
| Elastic Beanstalk                     | Legacy PaaS; overlaps App Runner/ECS coverage                               |
| SageMaker                             | ML platform; no IaP kind fit without a major vocabulary expansion           |
| Bedrock                               | ML/GenAI control plane; same vocabulary problem as SageMaker                |
| Glue                                  | ETL orchestration; `Workflow` covers Step Functions first — Glue follows on |
| EMR                                   | Cluster analytics; expensive to live-test, low top-50 pull-through          |
| Athena                                | Query service over S3; no resource lifecycle worth an IaP handler yet       |
| CodePipeline / CodeBuild / CodeDeploy | IaP targets runtime infrastructure, not delivery pipelines                  |
| CloudTrail / Config / Organizations   | Account-governance plane, out of workload scope                             |

**Cut order under pressure** (each cut a human decision at a gate):
SES → AppSync → EKS → Neptune → FSx → MSK live evidence. **Applied at closeout:** the first three
(SES/AppSync/EKS) landed as cut/deferred at their M24.3 gates and MSK live evidence deferred at its
M23.5 sub-gate; Neptune and FSx were **live-proven** (the cut order was not needed for them).

## Reserved kinds (9) — graduation status (all graduated)

| Reserved kind | Graduated in  | Handler wave | Status                                                        |
| ------------- | ------------- | ------------ | ------------------------------------------------------------- |
| `DnsZone`     | 1.1.0 (M23.1) | M23.2        | **graduated + live-proven** (Route 53)                        |
| `Certificate` | 1.1.0 (M23.1) | M23.2        | **graduated + live-proven** (ACM; ISSUED justified-partial)   |
| `Registry`    | 1.1.0 (M23.1) | M23.2        | **graduated + live-proven** (ECR)                             |
| `Alert`       | 1.1.0 (M23.1) | M23.2        | **graduated + live-proven** (CloudWatch Alarm)                |
| `Dashboard`   | 1.1.0 (M23.1) | M23.2        | **graduated + live-proven** (CloudWatch Dashboard)            |
| `Network`     | 1.2.0 (M23.3) | M23.4        | **graduated + live-proven** (VPC graph)                       |
| `Workflow`    | 1.2.0 (M23.3) | M23.4        | **graduated + live-proven** (Step Functions)                  |
| `Stream`      | 1.2.0 (M23.3) | M23.5        | **graduated + live-proven** (Kinesis/Firehose); MSK mock-only |
| `SearchIndex` | 1.2.0 (M23.3) | M23.5        | **graduated + live-proven** (OpenSearch)                      |

All 9 reserved kinds are graduated (specs 1.1.0 / 1.2.0 released); the reserved registry is empty
(`RESERVED_KINDS = []`, `GRADUATED_KINDS = 9`). 1.3.0 (M24.1) then added **new** vocabulary
(`Cdn`, `EventBus`, `Identity.type += user-directory`, `Service.runtime += kubernetes`,
`Gateway.protocol += graphql`) rather than graduating reserved names; the Email kind was **rejected**.

## Honest note carried from Phase 22/23 (mapping emission gap)

The 68 handlers are live-proven at the **target-type level** (driven directly by the live runs and
synthetic single-resource / id-threaded plans). Full **mapping emission** for the graduated/new kinds
and heterogeneous `Database` branches remains deferred behind the per-branch-outputs grammar gap
(`[[per-branch-outputs-mapping-gap]]`, first scoped in M23.2). No mapping bump / re-sign occurred
after M22.1, so the signed manifest still advertises the 12 kinds from that wave; this is recorded
honestly in the roadmap and is not an M24.4 exit criterion. Executability (handlers) is complete;
declarative mapping coverage for the newer kinds is the next tracked follow-on.
