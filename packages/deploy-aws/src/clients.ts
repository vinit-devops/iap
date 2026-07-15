/**
 * Constructs the three SDK clients the runtime needs, wired with the resolved
 * region + credential provider. Construction performs no network I/O (the
 * credential provider is lazy); nothing here reaches AWS until a command is
 * sent by a handler under an open apply gate.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { IAMClient } from '@aws-sdk/client-iam';
import { resolveCredentials, resolveRegion } from './credentials.js';
import type { AwsRuntimeOptions } from './credentials.js';

export interface ClientBundle {
  s3: S3Client;
  sqs: SQSClient;
  iam: IAMClient;
}

export function createClientBundle(options: AwsRuntimeOptions = {}): ClientBundle {
  const region = resolveRegion(options);
  const credentials = resolveCredentials(options);
  return {
    s3: new S3Client({ region, credentials }),
    sqs: new SQSClient({ region, credentials }),
    iam: new IAMClient({ region, credentials }),
  };
}
