# IaP Developer Preview v0.1 — AWS Support Matrix (frozen, M19.2)

**Date:** 2026-07-12 · **Scope:** [`developer-preview-scope.md`](developer-preview-scope.md) ·
**Evidence:** [`RELEASE_READINESS.yaml`](../../RELEASE_READINESS.yaml),
`providers/aws/mappings/core.iap-map.yaml`

> **Read this first.** In Developer Preview v0.1 the AWS support below is **mapping + plan
> coverage only** — IaP produces a deterministic, signed _plan_ that maps these IaP kinds to
> these AWS target types. **v0.1 does not deploy to real AWS.** Real create/update/replace/
> drift/destroy against a live account is the subject of milestone M19.3 (a build, per the
> M19.1 audit) and is out of scope for v0.1. This matrix freezes what the AWS _mapping_ covers.

## Supported IaP kinds → AWS targets (8 of 13 core kinds)

Conformance-tested (`providers/aws/conformance/`, 11 cases) and acceptance-tested (8 cases);
the AWS provider package is signed (ed25519) and digest-pinned.

| IaP kind      | AWS target type(s)                                                         | Notes                                                                    |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Service`     | `aws:ecs:Service`, `aws:elasticloadbalancing:TargetGroup`                  | Fargate/ECS; autoscaling, AZ spread, service-connect attributes          |
| `Database`    | `aws:rds:DBInstance`, `aws:rds:DBSubnetGroup`, `aws:secretsmanager:Secret` | encryption-at-rest, TLS-required, multi-AZ, backups, deletion-protection |
| `Cache`       | `aws:elasticache:ReplicationGroup`, `aws:secretsmanager:Secret`            | engine/version, encryption                                               |
| `Gateway`     | `aws:elasticloadbalancing:LoadBalancer`, `aws:acm:Certificate`             | ALB + managed cert                                                       |
| `Queue`       | `aws:sqs:Queue`                                                            | encryption at rest                                                       |
| `ObjectStore` | `aws:s3:Bucket`                                                            | encryption, private exposure                                             |
| `Identity`    | `aws:iam:Role`                                                             | workload identity                                                        |
| `Application` | `aws:resourcegroups:Group`                                                 | logical grouping                                                         |

Security floors are asserted by conformance **attestations** over the plan's desired
attributes (encryption at-rest/in-transit, private exposure, availability-zone spread on
RDS/ElastiCache/SQS/S3). These assert properties of the _plan_, not of deployed resources.

## Core kinds NOT AWS-mapped in v0.1 (5)

| IaP kind   | Status                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Job`      | Not AWS-mapped in v0.1 (mock provider maps it).                                                                          |
| `Function` | Not AWS-mapped in v0.1 (no Lambda mapping).                                                                              |
| `Volume`   | Not AWS-mapped in v0.1.                                                                                                  |
| `Topic`    | Not AWS-mapped in v0.1 (no SNS mapping).                                                                                 |
| `Secret`   | No standalone-kind AWS mapping; secrets are realized as `aws:secretsmanager:Secret` sub-resources of `Database`/`Cache`. |

## Reserved kinds (9) — not mapped by any provider in v0.1

`Network`, `Certificate`, `DnsZone`, `Stream`, `Workflow`, `SearchIndex`, `Registry`,
`Dashboard`, `Alert` — loose validation (IAP801 warning), no provider mapping.

## Other providers (context)

- **Kubernetes** maps the same 8 core kinds (cross-target equivalence), realizing 13 K8s
  target types. Mapping-only, like AWS.
- **Mock** maps 16 kinds (broadest) and is the only provider that _executes_ — entirely
  in-memory. It is the reference substrate, not a deployment target.

## Frozen for v0.1

This matrix is the frozen AWS surface for Developer Preview v0.1. Adding AWS kinds (Function/
Lambda, Topic/SNS, Job/Batch, Volume, standalone Secret) or **any** real execution is a
post-freeze change requiring a new milestone (execution ⇒ M19.3).
