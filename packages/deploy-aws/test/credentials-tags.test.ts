import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTags,
  isManaged,
  MANAGED_TAG_KEY,
  PLAN_TAG_KEY,
  RESOURCE_TAG_KEY,
  resolveRegion,
  resourceIdOf,
} from '../src/index.js';
import { planResource } from './helpers.js';

describe('resolveRegion', () => {
  const saved = { region: process.env.AWS_REGION, def: process.env.AWS_DEFAULT_REGION };
  beforeEach(() => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });
  afterEach(() => {
    if (saved.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = saved.region;
    if (saved.def === undefined) delete process.env.AWS_DEFAULT_REGION;
    else process.env.AWS_DEFAULT_REGION = saved.def;
  });

  it('prefers the explicit option', () => {
    expect(resolveRegion({ region: 'eu-west-1' })).toBe('eu-west-1');
  });

  it('falls back to AWS_REGION', () => {
    process.env.AWS_REGION = 'ap-south-1';
    expect(resolveRegion()).toBe('ap-south-1');
  });

  it('fails closed when no region is configured', () => {
    expect(() => resolveRegion()).toThrow(/region is not configured/);
  });
});

describe('mandatory tags', () => {
  it('always includes the three provenance tags; caller cannot override them', () => {
    const tags = buildTags('plan-1', 'assets.aws:s3:Bucket', {
      team: 'core',
      [MANAGED_TAG_KEY]: 'false', // attempted override
    });
    expect(tags[MANAGED_TAG_KEY]).toBe('true');
    expect(tags[PLAN_TAG_KEY]).toBe('plan-1');
    expect(tags[RESOURCE_TAG_KEY]).toBe('assets.aws:s3:Bucket');
    expect(tags.team).toBe('core');
  });

  it('isManaged gates on iap:managed=true', () => {
    expect(isManaged({ 'iap:managed': 'true' })).toBe(true);
    expect(isManaged({ 'iap:managed': 'false' })).toBe(false);
    expect(isManaged({})).toBe(false);
  });
});

describe('resourceIdOf', () => {
  it('strips the target-type suffix (which itself contains colons)', () => {
    expect(resourceIdOf(planResource('assets', 'aws:s3:Bucket'))).toBe('assets');
    expect(resourceIdOf(planResource('task', 'aws:iam:Role'))).toBe('task');
  });
});
