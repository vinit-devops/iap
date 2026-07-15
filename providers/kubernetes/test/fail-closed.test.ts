/**
 * Fail-closed mapping behavior (ch. 12 §12.3): intent outside the supports
 * matrix rejects loudly with a diagnostic naming the unsupported kind,
 * field, or value — never a silent downgrade, never a partial plan — plus
 * the first-match-wins realization variants (ch. 12 §12.4).
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMapping } from '@iap/provider-sdk';
import { TARGETS } from '../src/index';
import { canonicalFromFile, canonicalFromText, coreMapping, corpusDir } from './helpers';

describe('fail-closed rejections', () => {
  it('rejects engine mysql, naming the field and value (deliberate rejection surface)', () => {
    const model = canonicalFromFile(join(corpusDir, 'corpus', 'orders-mysql.iap.yaml'), null);
    const result = applyMapping(model, coreMapping());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          reason: 'unsupported-value',
          resourceId: 'orders-db',
          field: 'spec.engine',
          value: 'mysql',
        }),
      );
      expect('plan' in result).toBe(false);
    }
  });

  it('rejects an uncovered kind (Function) with unsupported-kind', () => {
    const model = canonicalFromFile(join(corpusDir, 'corpus', 'image-resizer.iap.yaml'), null);
    const result = applyMapping(model, coreMapping());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          reason: 'unsupported-kind',
          kind: 'Function',
          resourceId: 'image-resizer',
        }),
      );
    }
  });

  it('rejects exactly-once queue delivery, naming spec.delivery', () => {
    const model = canonicalFromFile(join(corpusDir, 'corpus', 'queue-exactly-once.iap.yaml'), null);
    const result = applyMapping(model, coreMapping());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          reason: 'unsupported-value',
          field: 'spec.delivery',
          value: 'exactly-once',
        }),
      );
    }
  });

  it('rejects availability maximum — a single cluster cannot attest a multi-region floor', () => {
    const model = canonicalFromText(`
apiVersion: iap.dev/v1
metadata:
  name: max-availability
resources:
  orders-db:
    kind: Database
    spec:
      class: relational
      engine: postgresql
      availability: maximum
`);
    const result = applyMapping(model, coreMapping());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          reason: 'unsupported-value',
          field: 'spec.availability',
          value: 'maximum',
        }),
      );
    }
  });

  it('rejects observability.traces required — no tracing pipeline to attest', () => {
    const model = canonicalFromText(`
apiVersion: iap.dev/v1
metadata:
  name: traced-queue
resources:
  order-events:
    kind: Queue
    spec:
      observability:
        traces: required
`);
    const result = applyMapping(model, coreMapping());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          reason: 'unsupported-value',
          field: 'spec.observability.traces',
          value: 'required',
        }),
      );
    }
  });
});

describe('first-match-wins realization (ch. 12 §12.4)', () => {
  it('a fifo queue takes the quorum/single-active-consumer variant', () => {
    const model = canonicalFromFile(join(corpusDir, 'corpus', 'work-queue.iap.yaml'), null);
    const result = applyMapping(model, coreMapping());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const queue = result.plan.resources.find(
        (r) => r.logicalId === `order-events.${TARGETS.queue}`,
      );
      expect(queue?.desiredAttributes).toMatchObject({
        queueType: 'quorum',
        singleActiveConsumer: true,
        messageTtl: '4d',
        deadLetterEnabled: true,
        deadLetterMaxReceives: 3,
        storageClassEncrypted: true,
      });
      expect(queue?.provenance['queueType']).toMatchObject({ form: 'constant', ruleIndex: 0 });
    }
  });

  it('an unordered queue falls through to the classic default rule', () => {
    const model = canonicalFromText(`
apiVersion: iap.dev/v1
metadata:
  name: plain-queue
resources:
  order-events:
    kind: Queue
    spec:
      messageRetention: 7d
`);
    const result = applyMapping(model, coreMapping());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const queue = result.plan.resources.find(
        (r) => r.logicalId === `order-events.${TARGETS.queue}`,
      );
      expect(queue?.desiredAttributes).toMatchObject({
        queueType: 'classic',
        singleActiveConsumer: false,
      });
      expect(queue?.provenance['queueType']).toMatchObject({ form: 'constant', ruleIndex: 1 });
    }
  });
});
