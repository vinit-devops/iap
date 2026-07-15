/**
 * @iap/provider-aws — AWS reference provider package (IEP-0012, certification
 * level **core**: mapping-only; execution handlers arrive with Phase 14).
 *
 * This module exports the package's **attestation registry**: pure predicates
 * over plan attributes registered per (capability, target type), the
 * package's auditable claim of *how* its AWS resources realize each abstract
 * intent floor. The shared conformance evaluator
 * (`@iap/provider-sdk`'s `evaluateConformanceCase`) runs them against plans
 * generated from the package's `conformance/` corpus; tampered-plan fixtures
 * in the test suite prove they can fail (PC-4 — no vacuous attestations).
 */

import type { AttestationInput } from '@iap/provider-sdk';
import { AttestationRegistry } from '@iap/provider-sdk';

/** Package name checked against the publisher allowlist. */
export const AWS_PROVIDER_PACKAGE_NAME = 'iap-provider-aws';

/** Provider namespace every bundled mapping realizes. */
export const AWS_PROVIDER_NAMESPACE = 'aws';

/** keyId of the committed test-only signing key (`keys/aws-test-2026.public.pem`). */
export const AWS_SIGNING_KEY_ID = 'aws-test-2026';

/**
 * Availability zones the RDS realization provides: a Multi-AZ deployment
 * keeps a synchronous standby in a second zone; a single-AZ instance is one.
 */
function rdsZonesRealized(input: AttestationInput): number {
  return input.resource.desiredAttributes.multiAZ === true ? 2 : 1;
}

/**
 * The AWS package's attestation functions. Each predicate reads only the
 * plan handed to it — pure data, nothing ambient — and returns whether the
 * realized provider resource attests the abstract capability:
 *
 * - `encryption.atRest` — RDS `storageEncrypted`, ElastiCache
 *   `atRestEncryptionEnabled`, SQS `sqsManagedSseEnabled`, S3 `sseAlgorithm`.
 * - `encryption.inTransit` — RDS `requireSecureTransport`, ElastiCache
 *   `transitEncryptionEnabled`, SQS `enforceTlsInTransit`, S3
 *   `enforceTlsOnly`.
 * - `exposure.private` — RDS `publiclyAccessible === false`, S3
 *   `blockPublicAccess === true`.
 * - `availability.zonesMinimum` — RDS Multi-AZ realizes two zones
 *   (`params.min` beyond 2 fails: this mapping cannot attest more).
 */
export function createAwsAttestations(): AttestationRegistry {
  return new AttestationRegistry()
    .register(
      'encryption.atRest',
      'aws:rds:DBInstance',
      ({ resource }) => resource.desiredAttributes.storageEncrypted === true,
    )
    .register(
      'encryption.inTransit',
      'aws:rds:DBInstance',
      ({ resource }) => resource.desiredAttributes.requireSecureTransport === true,
    )
    .register(
      'exposure.private',
      'aws:rds:DBInstance',
      ({ resource }) => resource.desiredAttributes.publiclyAccessible === false,
    )
    .register(
      'availability.zonesMinimum',
      'aws:rds:DBInstance',
      (input) => rdsZonesRealized(input) >= Number(input.params.min),
    )
    .register(
      'encryption.atRest',
      'aws:elasticache:ReplicationGroup',
      ({ resource }) => resource.desiredAttributes.atRestEncryptionEnabled === true,
    )
    .register(
      'encryption.inTransit',
      'aws:elasticache:ReplicationGroup',
      ({ resource }) => resource.desiredAttributes.transitEncryptionEnabled === true,
    )
    .register(
      'encryption.atRest',
      'aws:sqs:Queue',
      ({ resource }) => resource.desiredAttributes.sqsManagedSseEnabled === true,
    )
    .register(
      'encryption.inTransit',
      'aws:sqs:Queue',
      ({ resource }) => resource.desiredAttributes.enforceTlsInTransit === true,
    )
    .register(
      'encryption.atRest',
      'aws:s3:Bucket',
      ({ resource }) =>
        resource.desiredAttributes.sseAlgorithm === 'aws:kms' ||
        resource.desiredAttributes.sseAlgorithm === 'AES256',
    )
    .register(
      'encryption.inTransit',
      'aws:s3:Bucket',
      ({ resource }) => resource.desiredAttributes.enforceTlsOnly === true,
    )
    .register(
      'exposure.private',
      'aws:s3:Bucket',
      ({ resource }) => resource.desiredAttributes.blockPublicAccess === true,
    );
}
