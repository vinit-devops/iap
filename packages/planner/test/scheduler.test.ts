import { describe, expect, it } from 'vitest';
import { determineActions, emptySnapshot, scheduleWaves } from '../src/index';
import { removeResource, stateFromPlan, syntheticPlan, webshopPlan } from './helpers';

function waveIds(waves: ReturnType<typeof scheduleWaves>): string[][] {
  return waves.map((wave) => wave.map((entry) => entry.resource));
}

describe('forward waves (ch. 14 §14.4)', () => {
  it('layers the webshop creates by longest dependency path, sorted within waves', () => {
    const desired = webshopPlan();
    const state = emptySnapshot();
    const waves = scheduleWaves(determineActions(desired, state), desired, state);
    expect(waveIds(waves)).toEqual([
      [
        'api-token.mock:core:SecretBox',
        'emails.mock:core:Queue',
        'jobs.mock:core:Queue',
        'orders-db.mock:core:SecretBox',
        'orders-db.mock:core:Store',
      ],
      ['web.mock:core:Compute'], // dependsOn all five
    ]);
  });

  it('inserts transitive ordering edges through no-op nodes (§14.3)', () => {
    const desired = syntheticPlan([
      { logicalId: 'c.mock:test:Thing', desiredAttributes: { v: 1 } },
      {
        logicalId: 'b.mock:test:Thing',
        desiredAttributes: { v: 1 },
        dependsOn: ['c.mock:test:Thing'],
      },
      {
        logicalId: 'a.mock:test:Thing',
        desiredAttributes: { v: 1 },
        dependsOn: ['b.mock:test:Thing'],
      },
    ]);
    // b exists and matches (no-op); a and c are creates. The a→b→c chain
    // must survive restriction as a→c.
    const state = stateFromPlan(desired, (objects) => {
      delete objects['a.mock:test:Thing'];
      delete objects['c.mock:test:Thing'];
    });
    const waves = scheduleWaves(determineActions(desired, state), desired, state);
    expect(waveIds(waves)).toEqual([['c.mock:test:Thing'], ['a.mock:test:Thing']]);
  });

  it('refuses a dependency cycle (malformed input, fail closed)', () => {
    const desired = syntheticPlan([
      { logicalId: 'a.mock:test:Thing', dependsOn: ['b.mock:test:Thing'] },
      { logicalId: 'b.mock:test:Thing', dependsOn: ['a.mock:test:Thing'] },
    ]);
    const state = emptySnapshot();
    expect(() => scheduleWaves(determineActions(desired, state), desired, state)).toThrow(
      /dependency cycle/,
    );
  });
});

describe('delete waves (ch. 14 §14.3 reverse ordering)', () => {
  it('schedules deletes after forward waves, dependents before dependencies', () => {
    const full = webshopPlan();
    // Remove web and orders-db (web carries every relationship, so edges go
    // with it); nudge jobs so one forward action exists as well.
    const desired = webshopPlan({
      mutateDocument: (document) => {
        removeResource(document, 'web');
        removeResource(document, 'orders-db');
        const resources = (document as unknown as { resources: Record<string, unknown> }).resources;
        (resources.jobs as { spec: Record<string, unknown> }).spec.messageRetention = '5d';
      },
    });
    const state = stateFromPlan(full);
    const waves = scheduleWaves(determineActions(desired, state), desired, state);
    expect(waveIds(waves)).toEqual([
      ['jobs.mock:core:Queue'], // forward wave (update-in-place)
      ['web.mock:core:Compute'], // dependent deleted first
      ['orders-db.mock:core:SecretBox', 'orders-db.mock:core:Store'],
    ]);
    expect(waves[0]?.[0]?.action).toBe('update-in-place');
    expect(waves[1]?.[0]?.action).toBe('delete');
    expect(waves[2]?.every((entry) => entry.action === 'delete')).toBe(true);
  });

  it('treats deletes without deployed-time edges as one mutually independent wave', () => {
    const full = webshopPlan();
    const desired = webshopPlan({
      mutateDocument: (document) => {
        removeResource(document, 'web');
        removeResource(document, 'orders-db');
      },
    });
    const state = stateFromPlan(full, (objects) => {
      for (const object of Object.values(objects)) {
        delete (object as { dependsOn?: readonly string[] }).dependsOn;
      }
    });
    const waves = scheduleWaves(determineActions(desired, state), desired, state);
    expect(waveIds(waves)).toEqual([
      ['orders-db.mock:core:SecretBox', 'orders-db.mock:core:Store', 'web.mock:core:Compute'],
    ]);
  });

  it('preserves delete chains through retained state objects (transitive)', () => {
    // State: top → mid → base (deployed-time edges); top and base are
    // deleted, mid is retained (still desired, unchanged). top must still
    // delete before base.
    const desired = syntheticPlan([
      { logicalId: 'mid.mock:test:Thing', desiredAttributes: { v: 1 } },
    ]);
    const state = stateFromPlan(desired, (objects) => {
      (objects['mid.mock:test:Thing'] as { dependsOn?: readonly string[] }).dependsOn = [
        'base.mock:test:Thing',
      ];
      objects['base.mock:test:Thing'] = {
        type: 'mock:test:Thing',
        attributes: {},
        managed: true,
      };
      objects['top.mock:test:Thing'] = {
        type: 'mock:test:Thing',
        attributes: {},
        managed: true,
        dependsOn: ['mid.mock:test:Thing'],
      };
    });
    const waves = scheduleWaves(determineActions(desired, state), desired, state);
    expect(waveIds(waves)).toEqual([['top.mock:test:Thing'], ['base.mock:test:Thing']]);
  });
});
