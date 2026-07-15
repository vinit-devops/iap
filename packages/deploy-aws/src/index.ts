/**
 * `@iap/deploy-aws` — the real AWS execution runtime for IaP (Phase 19 /
 * M19.3). Consumes a `ProviderPlan` and reconciles it against live AWS across
 * a narrow golden path (S3 buckets, SQS queues, IAM roles).
 *
 * Safety is built into the shape of the API: the executor defaults to a
 * read-only dry run and issues mutating calls only when the caller passes an
 * explicit `apply: true`; every created resource is tagged `iap:managed=true`;
 * and destroy refuses any resource not carrying that tag.
 */

export { AwsExecutor } from './executor.js';
export type { AwsExecutorOptions, ApplyOptions, PlanOptions } from './executor.js';

export { createClientBundle } from './clients.js';
export type { ClientBundle } from './clients.js';

export { resolveRegion, resolveCredentials } from './credentials.js';
export type { AwsRuntimeOptions } from './credentials.js';

export {
  MANAGED_TAG_KEY,
  MANAGED_TAG_VALUE,
  PLAN_TAG_KEY,
  RESOURCE_TAG_KEY,
  buildTags,
  fromTagList,
  isManaged,
  toTagList,
} from './tags.js';

export { S3BucketHandler } from './s3.js';
export { SqsQueueHandler } from './sqs.js';
export { IamRoleHandler } from './iam.js';

export { resourceIdOf } from './util.js';

export {
  SUPPORTED_TARGET_TYPES,
  UnsupportedTargetTypeError,
  isSupportedTargetType,
} from './types.js';
export type {
  ApplyOutcomeItem,
  ApplyReport,
  PlanAction,
  PlanItem,
  PlanReport,
  ResourceState,
  SupportedTargetType,
  TargetHandler,
} from './types.js';
