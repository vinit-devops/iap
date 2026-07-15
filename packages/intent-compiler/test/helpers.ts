import { join } from 'node:path';
import type { IaPDocument } from '@iap/model';
import type {
  ConfirmationRecord,
  OperationBatch,
  OperationEnvelope,
  OperationTarget,
} from '../src/index';

export const repoRoot = join(__dirname, '..', '..', '..');

/**
 * A small, phase-1-through-5-valid base document exercising the constructs
 * operations edit: a Service with an inline edge, a Database (stateful,
 * replacement-eligible fields), an unreferenced Volume and Queue (safe
 * remove targets), an ObjectStore, a profile, and a policy.
 */
export function fixtureDocument(): IaPDocument {
  return structuredClone({
    apiVersion: 'iap.dev/v1',
    metadata: { name: 'fixture', owner: 'team-fixture' },
    profiles: {
      production: {
        description: 'Production overlay',
        overrides: { resources: { 'orders-db': { spec: { availability: 'high' } } } },
      },
    },
    resources: {
      web: {
        kind: 'Service',
        spec: {
          artifact: { type: 'container-image', reference: 'registry.example.com/web:1.0.0' },
          exposure: 'internal',
        },
        relationships: [
          {
            type: 'connectsTo',
            target: 'orders-db',
            port: 5432,
            protocol: 'tcp',
            access: 'read-write',
          },
        ],
      },
      'orders-db': {
        kind: 'Database',
        spec: {
          class: 'relational',
          engine: 'postgresql',
          engineVersion: '16',
          capacity: { storage: '20Gi' },
        },
      },
      scratch: {
        kind: 'Volume',
        spec: { capacity: { storage: '10Gi' } },
      },
      jobs: {
        kind: 'Queue',
      },
      notes: {
        kind: 'ObjectStore',
        spec: { exposure: 'private' },
      },
    },
    policies: [
      {
        id: 'encryption-at-rest',
        target: { kinds: ['Database'] },
        rule: { field: 'spec.encryption.atRest', operator: 'equals', value: 'required' },
        effect: 'warn',
      },
    ],
  } as unknown as IaPDocument);
}

/** Envelope builder: high confidence, nothing assumed, explicit-user provenance. */
export function op(
  operationId: string,
  type: OperationEnvelope['type'],
  target: OperationTarget,
  change?: unknown,
  overrides: Partial<OperationEnvelope> = {},
): OperationEnvelope {
  const envelope: OperationEnvelope = {
    operationId,
    type,
    target,
    confidence: 0.95,
    assumptions: [],
    requiredClarifications: [],
    provenance: { source: 'explicit-user', channel: 'natural-language' },
    ...overrides,
  };
  if (change !== undefined) envelope.change = change;
  return envelope;
}

export function batch(...operations: OperationEnvelope[]): OperationBatch {
  return { apiVersion: 'operations.iap.dev/v1', operations };
}

/** Confirmation builder with an injected timestamp (never from a clock). */
export function confirm(
  operationId: string,
  overrides: Partial<ConfirmationRecord> = {},
): ConfirmationRecord {
  return {
    operationId,
    actor: 'reviewer@example.com',
    channel: 'user-input',
    timestamp: '2026-07-11T12:00:00Z',
    ...overrides,
  };
}
