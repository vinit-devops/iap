import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KINDS, RELATIONSHIP_TYPES } from '@iap/model';
import { createValidator } from '@iap/parser';
import {
  DESTRUCTIVE_REASONS,
  OPERATION_TYPES,
  PROPOSAL_CHANNELS,
  PROVENANCE_SOURCES,
  compilerOperationsSchema,
  validateBatchStructure,
} from '../src/index';
import { batch, op, repoRoot } from './helpers';

const specCopy = () =>
  readFileSync(join(repoRoot, 'spec', 'schema', 'compiler-operations-v1.schema.json'), 'utf8');
const embeddedCopy = () =>
  readFileSync(join(__dirname, '..', 'schemas', 'compiler-operations-v1.schema.json'), 'utf8');

describe('schema drift guard (ADR-0002)', () => {
  it('embedded compiler-operations-v1.schema.json is byte-identical to spec/schema', () => {
    expect(embeddedCopy()).toBe(specCopy());
  });
});

describe('schema quality', () => {
  it('compiles under ajv 2020-12 strict mode with the x-iap vocabulary', () => {
    expect(() => createValidator(compilerOperationsSchema())).not.toThrow();
  });

  it('describes every declared property', () => {
    const undescribed: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}/${index}`));
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      if (typeof record.properties === 'object' && record.properties !== null) {
        for (const [name, child] of Object.entries(record.properties)) {
          if (
            typeof child === 'object' &&
            child !== null &&
            typeof (child as Record<string, unknown>).description !== 'string'
          ) {
            undescribed.push(`${path}/properties/${name}`);
          }
        }
      }
      for (const [key, child] of Object.entries(record)) walk(child, `${path}/${key}`);
    };
    walk(compilerOperationsSchema(), '#');
    expect(undescribed).toEqual([]);
  });
});

describe('closed-vocabulary drift (schema enums match the package/model constants)', () => {
  const defs = () => compilerOperationsSchema().$defs as Record<string, Record<string, unknown>>;

  it('operation type enum is exactly the twelve OPERATION_TYPES', () => {
    const envelope = defs().envelope as { properties: { type: { enum: string[] } } };
    expect(envelope.properties.type.enum).toEqual([...OPERATION_TYPES]);
    expect(OPERATION_TYPES).toHaveLength(12);
  });

  it('kindName enum matches @iap/model KINDS', () => {
    expect((defs().kindName as { enum: string[] }).enum).toEqual([...KINDS]);
  });

  it('relationship verb enums match @iap/model RELATIONSHIP_TYPES', () => {
    const edge = defs().relationshipEdge as { properties: { type: { enum: string[] } } };
    const ref = defs().relationshipRef as { properties: { type: { enum: string[] } } };
    expect(edge.properties.type.enum).toEqual([...RELATIONSHIP_TYPES]);
    expect(ref.properties.type.enum).toEqual([...RELATIONSHIP_TYPES]);
  });

  it('provenance source and channel enums match the closed vocabularies', () => {
    const envelope = defs().envelope as {
      properties: {
        provenance: { properties: { source: { enum: string[] }; channel: { enum: string[] } } };
      };
    };
    expect(envelope.properties.provenance.properties.source.enum).toEqual([...PROVENANCE_SOURCES]);
    expect(envelope.properties.provenance.properties.channel.enum).toEqual([...PROPOSAL_CHANNELS]);
  });

  it('destructive reason enum matches DESTRUCTIVE_REASONS', () => {
    const envelope = defs().envelope as {
      properties: {
        previewDiff: {
          properties: {
            destructiveOperations: { items: { properties: { reason: { enum: string[] } } } };
          };
        };
      };
    };
    expect(
      envelope.properties.previewDiff.properties.destructiveOperations.items.properties.reason.enum,
    ).toEqual([...DESTRUCTIVE_REASONS]);
  });
});

describe('structural validation (stage 1)', () => {
  const create = () =>
    op(
      'op-1',
      'CreateResource',
      { resourceId: 'db' },
      { kind: 'Database', spec: { class: 'relational' } },
    );

  it('accepts a well-formed batch, including echoed outputs', () => {
    const envelope = create();
    envelope.validationResult = { status: 'pass', findings: [] };
    envelope.previewDiff = { format: 'iap-semantic-diff/v1', adds: ['resources.db'] };
    expect(validateBatchStructure(batch(envelope)).ok).toBe(true);
  });

  const rejections: Array<[string, unknown, string]> = [
    ['a non-object', 42, 'schema-violation'],
    [
      'a wrong apiVersion',
      { apiVersion: 'operations.iap.dev/v2', operations: [create()] },
      'schema-violation',
    ],
    ['an empty operations array', batch(), 'schema-violation'],
    [
      'an unknown operation type (closed vocabulary)',
      batch({ ...create(), type: 'RenameResource' as never }),
      'invalid-operation-type',
    ],
    [
      'a missing envelope member (confidence)',
      (() => {
        const envelope = create() as Record<string, unknown>;
        delete envelope.confidence;
        return batch(envelope as never);
      })(),
      'schema-violation',
    ],
    [
      'an undeclared envelope property',
      batch({ ...create(), extra: true } as never),
      'schema-violation',
    ],
    ['an out-of-range confidence', batch({ ...create(), confidence: 1.5 }), 'schema-violation'],
    [
      'a resource id violating the DNS-label grammar',
      batch(op('op-1', 'CreateResource', { resourceId: 'Bad_ID' }, { kind: 'Database' })),
      'id-grammar',
    ],
    [
      'an extension namespace violating its grammar',
      batch(op('op-1', 'SetExtensionValue', { namespace: 'AWS' }, { set: { version: '1.0.0' } })),
      'id-grammar',
    ],
    [
      'RemoveResource carrying a change',
      batch(op('op-1', 'RemoveResource', { resourceId: 'db' }, {})),
      'schema-violation',
    ],
    [
      'UpdateResource without a change',
      batch(op('op-1', 'UpdateResource', { resourceId: 'db' })),
      'schema-violation',
    ],
    [
      'an empty set/unset change',
      batch(op('op-1', 'UpdateResource', { resourceId: 'db' }, {})),
      'schema-violation',
    ],
    [
      'CreateResource smuggling extensions into the entry',
      batch(
        op(
          'op-1',
          'CreateResource',
          { resourceId: 'db' },
          { kind: 'Database', extensions: { aws: {} } },
        ),
      ),
      'schema-violation',
    ],
    [
      'a provenance source outside the closed vocabulary',
      batch(
        op(
          'op-1',
          'CreateResource',
          { resourceId: 'db' },
          { kind: 'Database' },
          {
            provenance: { source: 'model-guess' as never, channel: 'api' },
          },
        ),
      ),
      'schema-violation',
    ],
    [
      'an assumption without a reason',
      batch(
        op(
          'op-1',
          'CreateResource',
          { resourceId: 'db' },
          { kind: 'Database' },
          {
            assumptions: [{ field: 'spec.class', assumed: 'relational' } as never],
          },
        ),
      ),
      'schema-violation',
    ],
  ];

  it.each(rejections)('rejects %s', (_name, value, code) => {
    const result = validateBatchStructure(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.map((refusal) => refusal.code)).toContain(code);
    }
  });

  it('collects every structural refusal, not just the first', () => {
    const result = validateBatchStructure(
      batch(
        { ...create(), type: 'RenameResource' as never },
        op('op-2', 'CreateResource', { resourceId: 'Bad_ID' }, { kind: 'Database' }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.refusals.map((refusal) => refusal.code);
      expect(codes).toContain('invalid-operation-type');
      expect(codes).toContain('id-grammar');
    }
  });

  it('attributes refusals to the offending operationId', () => {
    const result = validateBatchStructure(batch({ ...create(), type: 'RenameResource' as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals[0]?.operationId).toBe('op-1');
    }
  });
});
