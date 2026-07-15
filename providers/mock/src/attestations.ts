/**
 * Mock provider attestation functions (IEP-0012): pure predicates over plan
 * attributes, registered per (capability, target type). They are the
 * package's auditable claim of *how* its substrate objects realize each
 * abstract capability floor — and they are exercised against tampered-plan
 * fixtures in the test suite to prove they can fail (PC-4, no vacuous
 * attestations).
 *
 * Every capability asserted `satisfied` by a case under `conformance/cases/`
 * has exactly one registration here; `resilience.backup` is deliberately
 * unregistered — it is the corpus's `expect: unsupported` exercise.
 */

import { AttestationRegistry } from '@iap/provider-sdk';

/**
 * Build the mock package's attestation registry (a fresh instance per call —
 * registries reject duplicate registration).
 *
 * Convention for `tests/conformance/providers.mjs`: every provider package's
 * built module (`providers/<name>/dist/index.js`) exports
 * `createAttestationRegistry(): AttestationRegistry`.
 */
export function createAttestationRegistry(): AttestationRegistry {
  return new AttestationRegistry()
    .register(
      'encryption.atRest',
      'mock:core:Store',
      ({ resource }) => resource.desiredAttributes.encrypted === true,
    )
    .register(
      'exposure.private',
      'mock:core:Store',
      ({ resource }) => resource.desiredAttributes.public === false,
    )
    .register(
      'availability.zonesMinimum',
      'mock:core:Store',
      // multiZone gives the Store two zones; the mock substrate offers no
      // higher zone count, so the floor holds only for min <= 2.
      ({ resource, params }) =>
        resource.desiredAttributes.multiZone === true && Number(params.min) <= 2,
    )
    .register(
      'placement.regionPinned',
      'mock:core:Compute',
      // The region is an explicit mapping input recorded in the plan's
      // hashed identity (ch. 12 §12.2) — never an ambient lookup.
      ({ plan, params }) =>
        typeof params.region === 'string' && plan.inputs.deployRegion === params.region,
    )
    .register(
      'ordering.fifo',
      'mock:core:Queue',
      ({ resource }) => resource.desiredAttributes.fifo === true,
    )
    .register(
      'ordering.none',
      'mock:core:Queue',
      ({ resource }) => resource.desiredAttributes.fifo === false,
    )
    .register(
      'rotation.automatic',
      'mock:core:SecretBox',
      ({ resource }) => resource.desiredAttributes.rotationEnabled === true,
    );
}
