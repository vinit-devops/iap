/**
 * In-memory execution substrate for the mock provider (IEP-0012 "Mock
 * provider as reference harness"; phase-6 design decision 7 — the mock
 * claims certification level execution).
 *
 * The substrate is a deterministic, in-memory stand-in for a provider
 * control plane: a map of objects keyed by plan `logicalId`, mutated only by
 * the handlers in `handlers.ts`. Nothing here reads a clock, the network,
 * the environment, or a random source — identity generation runs off an
 * **injectable sequence counter** supplied by the caller (deterministic
 * 1, 2, 3, … by default), and failures are injected as an explicit failure
 * plan ("fail object X on operation Y"), never sampled.
 *
 * Secret hygiene (IEP-0012 execution level, CE-6): every externalized view
 * of an object — handler results, execution logs, snapshots, convergence
 * differences — replaces the values of sensitive attributes with the
 * `REDACTED` placeholder. Sensitivity is the union of the plan resource's
 * `sensitiveFields` (neutral-empty in mapping v1 plans, honored when
 * present) and the mock's own per-target knowledge in
 * `MOCK_SENSITIVE_ATTRIBUTES`.
 */

import { canonicalJsonStringify, compareCodePoints, sha256Hex } from '@iap/model';
import type { Scalar } from '@iap/provider-sdk';

/** Operations a failure injection can target. */
export const MOCK_OPERATIONS = ['create', 'update', 'replace', 'delete', 'read', 'import'] as const;
export type MockOperation = (typeof MOCK_OPERATIONS)[number];

/** One entry of an injectable failure plan: fail `logicalId` on `operation`. */
export interface FailureInjection {
  logicalId: string;
  operation: MockOperation;
}

/**
 * Attributes the mock provider itself treats as sensitive, per target type —
 * the provider-side analog of a plan's `sensitiveFields` (which mapping v1
 * plans always emit empty; both sources are honored, unioned).
 */
export const MOCK_SENSITIVE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  'mock:core:SecretBox': ['value'],
};

/**
 * Attributes that are immutable-after-create per target type: a diff that
 * changes one of them classifies as `replace`, not `update` (ch. 14 §14.2
 * defers mutability to per-kind lifecycle rules; this table is the mock
 * provider's target-level projection of them — e.g. a Store's `engine`
 * mirrors ch. 3's "Database.spec.engine is immutable-after-create").
 * Unioned with the plan resource's `lifecycle.replaceOn` (neutral-empty in
 * mapping v1 plans; design decision 4 fixed the shape so it is honored here
 * once a mapping-schema minor fills it).
 */
export const MOCK_REPLACE_ON: Readonly<Record<string, readonly string[]>> = {
  'mock:core:Store': ['engine'],
  'mock:core:Queue': ['fifo'],
  'mock:core:SecretBox': ['material'],
};

/** Placeholder substituted for sensitive attribute values in every externalized view. */
export const REDACTED = '[REDACTED]';

/** One object in the substrate. `outputs` are provider-generated attributes. */
export interface MockObjectRecord {
  logicalId: string;
  type: string;
  /** Desired attributes as last applied (or observed, for seeded objects). */
  desiredAttributes: Record<string, Scalar>;
  /** Provider-generated output attributes (id, endpoint, ref, value, …). */
  outputs: Record<string, Scalar>;
  /** Stored dependency edges (plan `dependsOn` at apply time). */
  dependsOn: string[];
  /** Attribute names redacted in every externalized view. */
  sensitiveFields: string[];
  status: 'ready' | 'failed';
  /** False for objects created out-of-band; import adopts them. */
  managed: boolean;
  /** Increments on update/replace; 0 for a failed create placeholder. */
  generation: number;
  /** Identity sequence from the injected counter; replace assigns a new one. */
  sequence: number;
}

/** Redacted external view of a substrate object (the read-handler surface). */
export interface MockObjectView {
  logicalId: string;
  type: string;
  status: 'ready' | 'failed';
  managed: boolean;
  generation: number;
  /** Desired + generated attributes, sensitive values replaced by REDACTED. */
  attributes: Record<string, Scalar>;
}

export interface MockSubstrateOptions {
  /** Injectable failure plan; also settable later via `setFailures`. */
  failures?: readonly FailureInjection[];
  /**
   * Injected identity counter (deterministic by default: 1, 2, 3, …). The
   * substrate never reads a clock or a random source.
   */
  nextSequence?: () => number;
}

/**
 * Provider-generated output attributes for a freshly (re)created object.
 * Purely deterministic in `(type, logicalId, sequence)`.
 */
export function generateOutputs(
  type: string,
  logicalId: string,
  sequence: number,
): Record<string, Scalar> {
  const outputs: Record<string, Scalar> = {
    id: `mock-${sequence}`,
    endpoint: `mock://${logicalId}`,
  };
  if (type === 'mock:core:SecretBox') {
    outputs.ref = `mock-secret-ref-${sequence}`;
    // The secret material itself — sensitive, never externalized unredacted.
    outputs.value = `mock-secret-value-${sequence}`;
  }
  return outputs;
}

function sortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  const record: Record<string, T> = {};
  for (const [key, value] of entries.sort((a, b) => compareCodePoints(a[0], b[0]))) {
    record[key] = value;
  }
  return record;
}

/** Union of plan-declared and provider-known sensitive attribute names, sorted. */
export function sensitiveFieldsFor(type: string, planSensitive: readonly string[]): string[] {
  return [...new Set([...planSensitive, ...(MOCK_SENSITIVE_ATTRIBUTES[type] ?? [])])].sort(
    compareCodePoints,
  );
}

export class MockSubstrate {
  private readonly objects = new Map<string, MockObjectRecord>();
  private failures = new Set<string>();
  readonly nextSequence: () => number;

  constructor(options: MockSubstrateOptions = {}) {
    this.setFailures(options.failures ?? []);
    if (options.nextSequence !== undefined) {
      this.nextSequence = options.nextSequence;
    } else {
      let counter = 0;
      this.nextSequence = () => {
        counter += 1;
        return counter;
      };
    }
  }

  /** Replace the injectable failure plan (e.g. cleared before a recovery run). */
  setFailures(failures: readonly FailureInjection[]): void {
    this.failures = new Set(failures.map((f) => `${f.logicalId}\n${f.operation}`));
  }

  /** Does the active failure plan fail this operation on this object? */
  shouldFail(logicalId: string, operation: MockOperation): boolean {
    return this.failures.has(`${logicalId}\n${operation}`);
  }

  /** Raw record access — substrate-internal; external surfaces use `view`. */
  getRecord(logicalId: string): MockObjectRecord | undefined {
    return this.objects.get(logicalId);
  }

  setRecord(record: MockObjectRecord): void {
    this.objects.set(record.logicalId, record);
  }

  deleteRecord(logicalId: string): void {
    this.objects.delete(logicalId);
  }

  /** All records, sorted by logicalId (deterministic iteration order). */
  listRecords(): MockObjectRecord[] {
    return [...this.objects.values()].sort((a, b) => compareCodePoints(a.logicalId, b.logicalId));
  }

  /**
   * Seed an out-of-band object (created outside any plan) for import
   * scenarios: unmanaged, ready, with generated provider outputs.
   */
  seedUnmanaged(input: {
    logicalId: string;
    type: string;
    attributes: Record<string, Scalar>;
    sensitiveFields?: readonly string[];
  }): MockObjectRecord {
    const sequence = this.nextSequence();
    const record: MockObjectRecord = {
      logicalId: input.logicalId,
      type: input.type,
      desiredAttributes: sortedRecord(Object.entries(input.attributes)),
      outputs: generateOutputs(input.type, input.logicalId, sequence),
      dependsOn: [],
      sensitiveFields: sensitiveFieldsFor(input.type, input.sensitiveFields ?? []),
      status: 'ready',
      managed: false,
      generation: 1,
      sequence,
    };
    this.objects.set(record.logicalId, record);
    return record;
  }

  /** Redacted external view of one object. */
  view(record: MockObjectRecord): MockObjectView {
    const attributes = sortedRecord([
      ...Object.entries(record.desiredAttributes),
      ...Object.entries(record.outputs),
    ]);
    for (const field of record.sensitiveFields) {
      if (Object.prototype.hasOwnProperty.call(attributes, field)) {
        attributes[field] = REDACTED;
      }
    }
    return {
      logicalId: record.logicalId,
      type: record.type,
      status: record.status,
      managed: record.managed,
      generation: record.generation,
      attributes,
    };
  }

  /** Redacted, deterministic snapshot of the whole substrate. */
  snapshot(): MockObjectView[] {
    return this.listRecords().map((record) => this.view(record));
  }

  /**
   * Canonical hash of the full (unredacted) substrate state — the
   * idempotent-convergence witness: executing the same plan twice must land
   * on the same hash, with the second run a no-op.
   */
  stateHash(): string {
    return sha256Hex(canonicalJsonStringify(this.listRecords()));
  }
}
