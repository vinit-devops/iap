import { describe, expect, it } from 'vitest';
import { OPERATION_ERROR_CODES, apply } from '../src/index';
import type { OperationErrorCode } from '../src/index';
import { batch, confirm, fixtureDocument, op } from './helpers';

async function refusalCodes(...args: Parameters<typeof apply>): Promise<OperationErrorCode[]> {
  const outcome = await apply(...args);
  expect(outcome.ok).toBe(false);
  return outcome.ok ? [] : outcome.refusals.map((refusal) => refusal.code);
}

describe('the closed refusal taxonomy (design decision 3)', () => {
  it('exports exactly the fifteen closed codes', () => {
    expect(OPERATION_ERROR_CODES).toHaveLength(15);
    expect(new Set(OPERATION_ERROR_CODES).size).toBe(15);
  });

  it('invalid-operation-type: an unknown type refuses structurally', async () => {
    const codes = await refusalCodes(
      fixtureDocument(),
      batch({
        ...op('op-1', 'RemoveResource', { resourceId: 'jobs' }),
        type: 'DropResource' as never,
      }),
    );
    expect(codes).toContain('invalid-operation-type');
  });

  it('schema-violation: malformed envelopes refuse structurally', async () => {
    const envelope = op('op-1', 'RemoveResource', { resourceId: 'jobs' }) as Record<
      string,
      unknown
    >;
    delete envelope.provenance;
    const codes = await refusalCodes(fixtureDocument(), batch(envelope as never));
    expect(codes).toContain('schema-violation');
  });

  it('id-grammar: identifier grammar violations get their own code', async () => {
    const codes = await refusalCodes(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'CreateResource',
          { resourceId: '-bad-' },
          { kind: 'Cache', spec: { engine: 'redis-compatible' } },
        ),
      ),
    );
    expect(codes).toContain('id-grammar');
  });

  const danglers: Array<[string, Parameters<typeof op>]> = [
    [
      'UpdateResource',
      ['op-1', 'UpdateResource', { resourceId: 'ghost' }, { set: { description: 'x' } }],
    ],
    ['RemoveResource', ['op-1', 'RemoveResource', { resourceId: 'ghost' }]],
    [
      'CreateRelationship (edge target)',
      [
        'op-1',
        'CreateRelationship',
        { resourceId: 'web' },
        { type: 'connectsTo', target: 'ghost' },
      ],
    ],
    [
      'UpdateRelationship (no matching edge)',
      [
        'op-1',
        'UpdateRelationship',
        { resourceId: 'web', relationship: { type: 'routesTo', target: 'orders-db' } },
        { set: { port: 80 } },
      ],
    ],
    ['RemoveProfile', ['op-1', 'RemoveProfile', { profile: 'ghost' }]],
    [
      'ChangeConstraint',
      ['op-1', 'ChangeConstraint', { policyId: 'ghost' }, { set: { effect: 'warn' } }],
    ],
    [
      'SetExtensionValue (resource level)',
      ['op-1', 'SetExtensionValue', { namespace: 'aws', resourceId: 'ghost' }, { set: { a: 1 } }],
    ],
  ];
  it.each(danglers)('dangling-target: %s', async (_name, args) => {
    const codes = await refusalCodes(fixtureDocument(), batch(op(...args)));
    expect(codes).toEqual(['dangling-target']);
  });

  it('ambiguous-target: two edges sharing (verb, target) cannot be addressed', async () => {
    const codes = await refusalCodes(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'CreateRelationship',
          { resourceId: 'web' },
          {
            type: 'connectsTo',
            target: 'orders-db',
            port: 5433,
          },
        ),
        op(
          'op-2',
          'UpdateRelationship',
          { resourceId: 'web', relationship: { type: 'connectsTo', target: 'orders-db' } },
          { set: { port: 5434 } },
        ),
      ),
    );
    expect(codes).toEqual(['ambiguous-target']);
  });

  const duplicates: Array<[string, Parameters<typeof op>]> = [
    [
      'CreateResource on an existing id',
      [
        'op-1',
        'CreateResource',
        { resourceId: 'web' },
        { kind: 'Service', spec: { artifact: { type: 'container-image', reference: 'r:1' } } },
      ],
    ],
    [
      'CreateRelationship duplicating an identical edge',
      [
        'op-1',
        'CreateRelationship',
        { resourceId: 'web' },
        {
          type: 'connectsTo',
          target: 'orders-db',
          port: 5432,
          protocol: 'tcp',
          access: 'read-write',
        },
      ],
    ],
    [
      'AddPolicy on an existing id',
      [
        'op-1',
        'AddPolicy',
        { policyId: 'encryption-at-rest' },
        { target: {}, rule: { field: 'kind', operator: 'exists' }, effect: 'warn' },
      ],
    ],
  ];
  it.each(duplicates)('duplicate-create: %s', async (_name, args) => {
    const codes = await refusalCodes(fixtureDocument(), batch(op(...args)));
    expect(codes).toEqual(['duplicate-create']);
  });

  it('batch-conflict: duplicate operationIds within one batch', async () => {
    const codes = await refusalCodes(
      fixtureDocument(),
      batch(
        op('op-1', 'RemoveProfile', { profile: 'production' }),
        op('op-1', 'SetMetadata', {}, { set: { description: 'x' } }),
      ),
    );
    expect(codes).toEqual(['batch-conflict']);
  });

  const badPaths: Array<[string, Parameters<typeof op>]> = [
    [
      'UpdateResource setting kind',
      ['op-1', 'UpdateResource', { resourceId: 'web' }, { set: { kind: 'Job' } }],
    ],
    [
      'UpdateResource reaching into relationships',
      ['op-1', 'UpdateResource', { resourceId: 'web' }, { set: { 'relationships.0.port': 1 } }],
    ],
    [
      'UpdateResource writing through a scalar',
      ['op-1', 'UpdateResource', { resourceId: 'web' }, { set: { 'spec.exposure.deep': 1 } }],
    ],
    [
      'UpdateResource creating a sparse array',
      ['op-1', 'UpdateResource', { resourceId: 'web' }, { set: { 'spec.ports.5.port': 8080 } }],
    ],
    [
      'UpdateRelationship retargeting an edge',
      [
        'op-1',
        'UpdateRelationship',
        { resourceId: 'web', relationship: { type: 'connectsTo', target: 'orders-db' } },
        { set: { target: 'notes' } },
      ],
    ],
    [
      'ChangeConstraint changing the policy id',
      ['op-1', 'ChangeConstraint', { policyId: 'encryption-at-rest' }, { set: { id: 'renamed' } }],
    ],
    [
      'SetExtensionValue declaring version at resource level',
      [
        'op-1',
        'SetExtensionValue',
        { namespace: 'aws', resourceId: 'web' },
        { set: { version: '1.0.0' } },
      ],
    ],
  ];
  it.each(badPaths)('invalid-change-path: %s', async (_name, args) => {
    const codes = await refusalCodes(fixtureDocument(), batch(op(...args)));
    expect(codes).toEqual(['invalid-change-path']);
  });

  it('extension-namespace-violation: a core operation writing into extensions', async () => {
    const codes = await refusalCodes(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'UpdateResource',
          { resourceId: 'web' },
          {
            set: { 'extensions.aws.instanceHint': 'memory-optimized' },
          },
        ),
      ),
    );
    expect(codes).toEqual(['extension-namespace-violation']);
  });

  it('validation-failed: IaP findings pass through with their codes untouched', async () => {
    const outcome = await apply(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'CreateRelationship',
          { resourceId: 'orders-db' },
          {
            // storesDataIn targeting a Service is a verb/kind incompatibility (IAP301, ch. 8).
            type: 'storesDataIn',
            target: 'web',
          },
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toHaveLength(1);
    const refusal = outcome.refusals[0];
    expect(refusal?.code).toBe('validation-failed');
    expect(refusal?.findings?.some((finding) => finding.code === 'IAP301')).toBe(true);
    expect(refusal?.findings?.every((finding) => /^IAP[1-8][0-9]{2}$/.test(finding.code))).toBe(
      true,
    );
  });

  it('below-confidence-threshold / unconfirmed-assumptions / unconfirmed-clarifications are separately machine-readable', async () => {
    const codes = await refusalCodes(
      fixtureDocument(),
      batch(
        op(
          'op-1',
          'SetMetadata',
          {},
          { set: { description: 'x' } },
          {
            confidence: 0.4,
            assumptions: [{ field: 'description', assumed: 'x', reason: 'unstated' }],
            requiredClarifications: [{ id: 'q-1', question: 'Really?' }],
          },
        ),
      ),
    );
    expect(codes.sort()).toEqual([
      'below-confidence-threshold',
      'unconfirmed-assumptions',
      'unconfirmed-clarifications',
    ]);
  });

  it('unacknowledged-destructive: a confirmation without the flag is not enough', async () => {
    const codes = await refusalCodes(
      fixtureDocument(),
      batch(op('op-1', 'RemoveResource', { resourceId: 'scratch' })),
      { confirmations: [confirm('op-1')] },
    );
    expect(codes).toEqual(['unacknowledged-destructive']);
  });

  const badConfirmations: Array<[string, Parameters<typeof confirm>[1]]> = [
    ['a missing actor', { actor: '' }],
    ['a channel outside the closed set', { channel: 'email' as never }],
    ['a non-instant timestamp', { timestamp: 'yesterday' }],
  ];
  it.each(badConfirmations)('invalid-confirmation: %s', async (_name, overrides) => {
    const codes = await refusalCodes(
      fixtureDocument(),
      batch(op('op-1', 'SetMetadata', {}, { set: { description: 'x' } })),
      { confirmations: [confirm('op-1', overrides)] },
    );
    expect(codes).toContain('invalid-confirmation');
  });

  it('invalid-confirmation: a confirmation for an operation not in the batch', async () => {
    const codes = await refusalCodes(
      fixtureDocument(),
      batch(op('op-1', 'SetMetadata', {}, { set: { description: 'x' } })),
      { confirmations: [confirm('op-ghost')] },
    );
    expect(codes).toEqual(['invalid-confirmation']);
  });

  it('invalid-confirmation: duplicate confirmations for one operation', async () => {
    const codes = await refusalCodes(
      fixtureDocument(),
      batch(op('op-1', 'SetMetadata', {}, { set: { description: 'x' } })),
      { confirmations: [confirm('op-1'), confirm('op-1')] },
    );
    expect(codes).toContain('invalid-confirmation');
  });

  it('an invalid confidenceThreshold is caller misuse, not a refusal', async () => {
    await expect(
      apply(
        fixtureDocument(),
        batch(op('op-1', 'SetMetadata', {}, { set: { description: 'x' } })),
        {
          confidenceThreshold: 2,
        },
      ),
    ).rejects.toThrow(TypeError);
  });
});
