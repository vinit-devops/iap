/**
 * @iap/provider-kubernetes — Kubernetes provider package (IEP-0012, core
 * certification level; spec ch. 12).
 *
 * The mapping artifact (`mappings/core.iap-map.yaml`) realizes eight kinds
 * on an in-cluster substrate; this module supplies the package's
 * **attestation functions**: pure predicates over plan attributes,
 * registered per (capability, target type), that state *how* the kubernetes
 * realization satisfies each abstract intent floor (IEP-0012 "attestations
 * are the package's auditable claim").
 *
 * The predicates attest the same abstract capabilities as the AWS reference
 * package through structurally different evidence:
 *
 * - `exposure.private`  — a default-deny NetworkPolicy scoped to the
 *   resource's pods (AWS: security-group non-reachability);
 * - `encryption.atRest` — an encrypted-StorageClass demand on the
 *   operator-managed volume (AWS: engine-level storage encryption);
 * - `encryption.inTransit` — operator-enforced TLS on client connections;
 * - `availability.zonesMinimum` — replica count on the operator cluster
 *   meeting the zone floor, with synchronous replication on the HA path
 *   (AWS: multi-AZ placement).
 *
 * Purity: every predicate reads only the plan resource it is handed — no
 * clock, no network, no environment (ch. 12 §12.2 extended package-wide).
 */

import { AttestationRegistry } from '@iap/provider-sdk';
import type { AttestationInput } from '@iap/provider-sdk';

/** Package name as declared in manifest.json (allowlist entry). */
export const PROVIDER_PACKAGE_NAME = 'iap-provider-kubernetes';

/** Provider namespace owned by this package. */
export const PROVIDER_NAMESPACE = 'kubernetes';

/** keyId of the committed test-only signing keypair (`keys/`). */
export const SIGNING_KEY_ID = 'kubernetes-test-2026';

/** Provider target types produced by the core mapping. */
export const TARGETS = {
  namespace: 'kubernetes:core:Namespace',
  deployment: 'kubernetes:apps:Deployment',
  service: 'kubernetes:core:Service',
  horizontalPodAutoscaler: 'kubernetes:autoscaling:HorizontalPodAutoscaler',
  networkPolicy: 'kubernetes:networking:NetworkPolicy',
  gateway: 'kubernetes:gateway:Gateway',
  httpRoute: 'kubernetes:gateway:HTTPRoute',
  postgresCluster: 'kubernetes:postgres-operator:PostgresCluster',
  redisFailover: 'kubernetes:redis-operator:RedisFailover',
  secret: 'kubernetes:core:Secret',
  bucket: 'kubernetes:objectstorage:Bucket',
  queue: 'kubernetes:messaging:Queue',
  serviceAccount: 'kubernetes:core:ServiceAccount',
} as const;

/** Encrypted-StorageClass demand on an operator-managed volume (at rest). */
function storageClassEncrypted({ resource }: AttestationInput): boolean {
  return resource.desiredAttributes.storageClassEncrypted === true;
}

/**
 * Build the package's attestation registry: one pure predicate per
 * (capability, target type) asserted by the `conformance/` cases. Exercised
 * against tampered plans in the package test suite to prove none of them is
 * vacuous (PC-4).
 */
export function createAttestationRegistry(): AttestationRegistry {
  return new AttestationRegistry()
    .register('encryption.atRest', TARGETS.postgresCluster, storageClassEncrypted)
    .register('encryption.atRest', TARGETS.queue, storageClassEncrypted)
    .register(
      'encryption.atRest',
      TARGETS.bucket,
      ({ resource }) => resource.desiredAttributes.encryptionAtRest === true,
    )
    .register(
      'encryption.inTransit',
      TARGETS.postgresCluster,
      ({ resource }) => resource.desiredAttributes.tlsRequired === true,
    )
    .register(
      'exposure.private',
      TARGETS.networkPolicy,
      // NetworkPolicy denial posture: nothing reaches the resource's pods
      // except the declared connectsTo edges (IEP-0012 "Provider impact").
      ({ resource }) =>
        resource.desiredAttributes.defaultDenyIngress === true &&
        resource.desiredAttributes.allowFromDeclaredConnections === true,
    )
    .register(
      'availability.zonesMinimum',
      TARGETS.postgresCluster,
      ({ resource, params }) =>
        Number(resource.desiredAttributes.instances) >= Number(params.min ?? 2) &&
        resource.desiredAttributes.synchronousReplication === true,
    );
}
