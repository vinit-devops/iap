import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IaPError,
  load,
  registerExtension,
  registeredExtensions,
  unregisterExtension,
  validateExtensions,
} from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
const examplesDir = join(repoRoot, 'spec', 'examples');
const examples = readdirSync(examplesDir)
  .filter((f) => f.endsWith('.iap.yaml'))
  .sort();

const HASH = /^[0-9a-f]{64}$/;

const errorsOf = (findings: { severity: string }[]) =>
  findings.filter((f) => f.severity === 'error');

describe('official examples through the facade', () => {
  it('covers all 9 official examples', () => {
    expect(examples).toHaveLength(9);
  });

  for (const file of examples) {
    it(`${file}: load → validate → canonical → graph → waves → round-trip`, async () => {
      const ws = await load({ path: join(examplesDir, file) });
      expect(ws.ok).toBe(true);
      expect(ws.document).toBeDefined();

      // Four-phase validation: zero errors on the official corpus.
      const validation = ws.validate();
      expect(errorsOf(validation.findings)).toEqual([]);
      expect(validation.ok).toBe(true);

      // Canonicalization: a 64-hex SHA-256 content hash.
      const canon = ws.canonical();
      expect(canon.hash).toMatch(HASH);
      expect(errorsOf(canon.findings)).toEqual([]);

      // Graph over the canonical model: one node per resource.
      const graph = ws.graph();
      const resourceIds = Object.keys(ws.document!.resources);
      expect(graph.nodes.size).toBe(resourceIds.length);

      // Waves partition exactly the node set.
      const waves = ws.waves();
      expect(waves.flat().sort()).toEqual([...graph.nodes.keys()].sort());

      // Round trip: re-serialized YAML canonicalizes to the same hash.
      const reloaded = await load(ws.serialize('yaml'));
      expect(reloaded.ok).toBe(true);
      expect(reloaded.canonical().hash).toBe(canon.hash);

      // canonical-json serialization is the canonical byte projection.
      expect(ws.serialize('canonical-json')).toBe(canon.canonicalJson);
      expect(ws.serialize()).toBe(canon.canonicalJson);
    });
  }

  it('memoizes validate(), canonical(), graph(), waves(), and policies()', async () => {
    const ws = await load({ path: join(examplesDir, 'basic-webapp.iap.yaml') });
    expect(ws.validate()).toBe(ws.validate());
    expect(ws.canonical()).toBe(ws.canonical());
    expect(ws.graph()).toBe(ws.graph());
    expect(ws.waves()).toBe(ws.waves());
    expect(ws.policies()).toBe(ws.policies());
  });

  it('string input and file input produce identical canonical hashes', async () => {
    const path = join(examplesDir, 'serverless-api.iap.yaml');
    const fromFile = await load({ path });
    const fromText = await load(readFileSync(path, 'utf8'));
    expect(fromText.canonical().hash).toBe(fromFile.canonical().hash);
  });
});

describe('policy evaluation through the facade', () => {
  const VIOLATING = [
    'apiVersion: iap.dev/v1',
    'metadata:',
    '  name: policy-facade',
    'resources:',
    '  assets:',
    '    kind: ObjectStore',
    '    spec: { exposure: public }',
    'policies:',
    '  - id: no-public-object-stores',
    '    target: { kinds: [ObjectStore] }',
    '    rule: { field: spec.exposure, operator: equals, value: public }',
    '    effect: deny',
    '',
  ].join('\n');

  it('policies() evaluates the document policies against the canonical model', async () => {
    const ws = await load(VIOLATING);
    const result = ws.policies();
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'IAP501',
        severity: 'error',
        path: 'resources.assets.spec.exposure',
        policyId: 'no-public-object-stores',
      }),
    ]);
  });

  it('policies(options) is evaluated fresh and honors exceptions with injected now', async () => {
    const ws = await load(VIOLATING);
    const exempted = ws.policies({
      exceptions: [
        {
          policyId: 'no-public-object-stores',
          reason: 'public asset bucket',
          approver: 'security',
          expiry: '2027-01-01T00:00:00Z',
        },
      ],
      now: '2026-07-10T00:00:00Z',
    });
    expect(exempted.findings[0]).toMatchObject({ code: 'IAP501', severity: 'warning' });
    expect(exempted).not.toBe(ws.policies());
    // Exceptions without a caller-supplied instant are SDK misuse territory:
    // the engine never reads the clock (determinism), so it throws TypeError.
    expect(() =>
      ws.policies({
        exceptions: [
          {
            policyId: 'no-public-object-stores',
            reason: 'r',
            approver: 'a',
            expiry: '2027-01-01T00:00:00Z',
          },
        ],
      }),
    ).toThrow(TypeError);
  });

  it('every official example evaluates its own policies without errors', async () => {
    for (const file of examples) {
      const ws = await load({ path: join(examplesDir, file) });
      const result = ws.policies();
      expect(errorsOf(result.findings)).toEqual([]);
    }
  });
});

describe('profiles through the facade', () => {
  it('basic-webapp with profile "production" hashes differently from the base document', async () => {
    const path = join(examplesDir, 'basic-webapp.iap.yaml');
    const base = await load({ path });
    const production = await load({ path }, { profile: 'production' });
    expect(production.validate().ok).toBe(true);
    expect(production.canonical().hash).toMatch(HASH);
    expect(production.canonical().hash).not.toBe(base.canonical().hash);
    expect(production.canonical().model.profile).toBe('production');
  });

  it('round-trips relative to a profile: the YAML keeps the profiles block', async () => {
    const path = join(examplesDir, 'basic-webapp.iap.yaml');
    const ws = await load({ path }, { profile: 'production' });
    // serialize('yaml') emits the profile-UNmerged original, so reloading it
    // with the same profile selected reproduces the profile-relative hash.
    const reloaded = await load(ws.serialize('yaml'), { profile: 'production' });
    expect(reloaded.canonical().hash).toBe(ws.canonical().hash);
  });
});

describe('extension registration (ch. 21 §21.5)', () => {
  afterEach(() => {
    for (const pkg of registeredExtensions()) unregisterExtension(pkg.namespace);
  });

  const loadExample = async (name: string) => {
    const ws = await load({ path: join(examplesDir, name) });
    expect(ws.document).toBeDefined();
    return ws.document!;
  };

  it('a registered namespace with a satisfied schema produces no findings', async () => {
    registerExtension({
      namespace: 'kubernetes',
      version: '1.0.0',
      schema: {
        type: 'object',
        properties: {
          serviceAccountName: { type: 'string' },
          topologySpreadHint: { type: 'string' },
        },
        additionalProperties: false,
      },
    });
    const document = await loadExample('kubernetes-platform.iap.yaml');
    expect(validateExtensions(document)).toEqual([]);
  });

  it('registered-but-invalid extension content produces error findings (IAP802/error)', async () => {
    registerExtension({
      namespace: 'kubernetes',
      version: '1.0.0',
      schema: {
        type: 'object',
        properties: { serviceAccountName: { type: 'number' } },
      },
    });
    const document = await loadExample('kubernetes-platform.iap.yaml');
    const findings = validateExtensions(document);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.code === 'IAP802' && f.severity === 'error')).toBe(true);
    expect(findings[0]!.path).toBe('/resources/api/extensions/kubernetes/serviceAccountName');
    expect(findings[0]!.message).toContain('violates its package schema');
  });

  it('unregistered namespaces warn IAP802 — never error (ch. 11 §11.5)', async () => {
    registerExtension({ namespace: 'kubernetes', version: '1.0.0' });
    const document = await loadExample('hybrid-environment.iap.yaml');
    const findings = validateExtensions(document);
    // hybrid-environment uses aws + onprem; only kubernetes is registered.
    expect(findings.map((f) => [f.code, f.severity, f.path])).toEqual([
      ['IAP802', 'warning', '/extensions/aws'],
      ['IAP802', 'warning', '/extensions/onprem'],
    ]);
  });

  it('a registered namespace without a schema silences the warning and checks nothing', async () => {
    registerExtension({ namespace: 'aws', version: '1.2.0' });
    registerExtension({ namespace: 'onprem', version: '1.0.0' });
    const document = await loadExample('hybrid-environment.iap.yaml');
    expect(validateExtensions(document)).toEqual([]);
  });

  it('rejects two packages claiming the same namespace (IaPError, SDK misuse)', () => {
    registerExtension({ namespace: 'kubernetes', version: '1.0.0' });
    expect(() => registerExtension({ namespace: 'kubernetes', version: '2.0.0' })).toThrow(
      IaPError,
    );
    expect(() => registerExtension({ namespace: '', version: '1.0.0' })).toThrow(IaPError);
  });

  it('registeredExtensions reports registration order; unregisterExtension removes', () => {
    registerExtension({ namespace: 'onprem', version: '1.0.0' });
    registerExtension({ namespace: 'aws', version: '1.2.0' });
    expect(registeredExtensions().map((p) => p.namespace)).toEqual(['onprem', 'aws']);
    expect(unregisterExtension('onprem')).toBe(true);
    expect(unregisterExtension('onprem')).toBe(false);
    expect(registeredExtensions().map((p) => p.namespace)).toEqual(['aws']);
  });
});

describe('error paths (findings, not exceptions — ch. 21 §21.1.3)', () => {
  const unknownKind = [
    'apiVersion: iap.dev/v1',
    'metadata:',
    '  name: bad-kind',
    'resources:',
    '  thing:',
    '    kind: Blob',
    '',
  ].join('\n');

  it('unknown kind: ok false with findings, canonical() still works (independence)', async () => {
    const ws = await load(unknownKind);
    expect(ws.ok).toBe(false);
    expect(errorsOf(ws.findings).length).toBeGreaterThan(0);
    expect(ws.validate().ok).toBe(false);

    // Canonicalization does not require validity (phase-2 design decision 3).
    const canon = ws.canonical();
    expect(canon.hash).toMatch(HASH);
    expect(ws.serialize('canonical-json')).toBe(canon.canonicalJson);
    // The invalid document round-trips through YAML too.
    const reloaded = await load(ws.serialize('yaml'));
    expect(reloaded.canonical().hash).toBe(canon.hash);
  });

  it('unparseable input: no document; canonical()/serialize() throw IaPError', async () => {
    const ws = await load('{{{ not yaml');
    expect(ws.ok).toBe(false);
    expect(ws.document).toBeUndefined();
    expect(errorsOf(ws.findings).length).toBeGreaterThan(0);
    expect(ws.validate().ok).toBe(false);
    expect(() => ws.canonical()).toThrow(IaPError);
    expect(() => ws.serialize('yaml')).toThrow(IaPError);
  });

  it('serialize rejects unknown formats with IaPError (SDK misuse)', async () => {
    const ws = await load({ path: join(examplesDir, 'basic-webapp.iap.yaml') });
    expect(() => ws.serialize('toml' as never)).toThrow(IaPError);
  });

  it('sourceMap: true populates the per-node source map', async () => {
    const ws = await load(
      { path: join(examplesDir, 'basic-webapp.iap.yaml') },
      { sourceMap: true },
    );
    expect(ws.sourceMap).toBeDefined();
    expect(ws.sourceMap!.get('/metadata/name')).toBeDefined();
  });
});
