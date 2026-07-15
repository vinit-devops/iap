import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { X_IIS_ANNOTATION_KEYWORDS, canonicalize, iisDocumentSchema } from '@iap/model';
import type { IaPDocument, Policy } from '@iap/model';
import { POLICY_PACKS, evaluatePolicies } from '../src/index';
import type { PolicyEvaluationInput, PolicyException } from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');
const examplesDir = join(repoRoot, 'spec', 'examples');
const casesDir = join(repoRoot, 'spec', 'conformance', 'cases');

/** Two databases around the 50Gi threshold, plus label/exposure variety. */
const RESOURCES: PolicyEvaluationInput['resources'] = {
  'big-db': {
    kind: 'Database',
    labels: { tier: 'critical', costCenter: 'cc-7' },
    spec: {
      class: 'relational',
      engine: 'postgresql',
      availability: 'standard',
      capacity: { storage: '100Gi' },
      encryption: { atRest: 'preferred', inTransit: 'required' },
      resilience: { backup: 'preferred', recoveryPointObjective: '1h' },
      exposure: 'private',
    },
  },
  'small-db': {
    kind: 'Database',
    labels: { tier: 'dev' },
    spec: {
      class: 'relational',
      engine: 'postgresql',
      availability: 'high',
      capacity: { storage: '20Gi' },
      encryption: { atRest: 'required', inTransit: 'required' },
      resilience: { backup: 'required', recoveryPointObjective: '30s' },
      exposure: 'private',
    },
  },
  web: {
    kind: 'Service',
    labels: { costCenter: 'cc-7' },
    spec: {
      artifact: { type: 'container-image', reference: 'registry.example.com/web:1.0.0' },
      exposure: 'public',
      scaling: { min: 2, max: 10 },
    },
  },
};

function evaluate(policies: Policy[], options?: Parameters<typeof evaluatePolicies>[1]) {
  return evaluatePolicies({ resources: RESOURCES, policies }, options);
}

function denyOn(rule: Policy['rule'], target: Policy['target'] = {}): Policy {
  return { id: 'probe', target, rule, effect: 'deny' };
}

/** Resource ids the probe deny policy fired on. */
function firedOn(rule: Policy['rule'], target: Policy['target'] = {}): string[] {
  return evaluate([denyOn(rule, target)])
    .findings.filter((f) => f.code === 'IAP501')
    .map((f) => /^resources\.([^.]+)/.exec(f.path)?.[1] ?? '');
}

describe('operator matrix', () => {
  it('equals / not-equals', () => {
    expect(firedOn({ field: 'spec.engine', operator: 'equals', value: 'postgresql' })).toEqual([
      'big-db',
      'small-db',
    ]);
    expect(firedOn({ field: 'spec.engine', operator: 'not-equals', value: 'postgresql' })).toEqual(
      [],
    );
    // not-equals on an unresolved path is false, not true (ch. 7 §7.3/§7.4).
    expect(firedOn({ field: 'spec.engine', operator: 'not-equals', value: 'mysql' })).toEqual([
      'big-db',
      'small-db',
    ]);
  });

  it('equals is deep equality on objects', () => {
    expect(
      firedOn({ field: 'spec.capacity', operator: 'equals', value: { storage: '100Gi' } }),
    ).toEqual(['big-db']);
  });

  it('in / not-in', () => {
    expect(firedOn({ field: 'labels.tier', operator: 'in', value: ['critical', 'gold'] })).toEqual([
      'big-db',
    ]);
    // not-in only fires on RESOLVED values outside the list (unresolved → false).
    expect(firedOn({ field: 'labels.tier', operator: 'not-in', value: ['critical'] })).toEqual([
      'small-db',
    ]);
    // Malformed scalar value for in/not-in never fires.
    expect(firedOn({ field: 'labels.tier', operator: 'in', value: 'critical' })).toEqual([]);
  });

  it('exists / absent (including falsy-looking values and unresolved paths)', () => {
    expect(firedOn({ field: 'labels.costCenter', operator: 'exists' })).toEqual(['big-db', 'web']);
    expect(firedOn({ field: 'labels.costCenter', operator: 'absent' })).toEqual(['small-db']);
    expect(firedOn({ field: 'spec.nonexistent.deep', operator: 'absent' })).toEqual([
      'big-db',
      'small-db',
      'web',
    ]);
  });

  it('greater-than / less-than over numbers', () => {
    expect(firedOn({ field: 'spec.scaling.min', operator: 'greater-than', value: 1 })).toEqual([
      'web',
    ]);
    expect(firedOn({ field: 'spec.scaling.min', operator: 'less-than', value: 2 })).toEqual([]);
  });

  it('greater-than over quantities compares exact canonical magnitude', () => {
    // 100Gi > 50Gi fires; 20Gi does not (BigInt milli-units, not string order).
    expect(
      firedOn({ field: 'spec.capacity.storage', operator: 'greater-than', value: '50Gi' }),
    ).toEqual(['big-db']);
    expect(
      firedOn({ field: 'spec.capacity.storage', operator: 'less-than', value: '50Gi' }),
    ).toEqual(['small-db']);
    // Cross-suffix: 100Gi > 51200Mi (= 50Gi) exercises the exact arithmetic.
    expect(
      firedOn({ field: 'spec.capacity.storage', operator: 'greater-than', value: '51200Mi' }),
    ).toEqual(['big-db']);
  });

  it('greater-than over durations compares exact milliseconds', () => {
    // 1h > 45m fires; 30s does not. Note '45m' parses in both grammars; the
    // partner operand '1h' is duration-only, forcing the duration domain.
    expect(
      firedOn({
        field: 'spec.resilience.recoveryPointObjective',
        operator: 'greater-than',
        value: '45m',
      }),
    ).toEqual(['big-db']);
    expect(
      firedOn({
        field: 'spec.resilience.recoveryPointObjective',
        operator: 'less-than',
        value: '3600s',
      }),
    ).toEqual(['small-db']);
  });

  it('matches: unanchored RE2-subset regular expressions on strings', () => {
    expect(firedOn({ field: 'spec.engine', operator: 'matches', value: 'post' })).toEqual([
      'big-db',
      'small-db',
    ]);
    expect(firedOn({ field: 'spec.engine', operator: 'matches', value: '^gres$' })).toEqual([]);
    expect(firedOn({ field: 'spec.engine', operator: 'matches', value: '^postgresql$' })).toEqual([
      'big-db',
      'small-db',
    ]);
    // Non-string resolved values evaluate false, silently (ch. 7 §7.4).
    const result = evaluate([
      denyOn({ field: 'spec.scaling.min', operator: 'matches', value: '2' }),
    ]);
    expect(result.findings).toEqual([]);
  });
});

describe('IAP504 — operand type mismatch (warning; leaf false)', () => {
  it('quantity vs duration is a cross-domain mismatch', () => {
    const result = evaluate([
      denyOn(
        {
          field: 'spec.resilience.recoveryPointObjective',
          operator: 'greater-than',
          value: '50Gi',
        },
        { kinds: ['Database'] },
      ),
    ]);
    const mismatches = result.findings.filter((f) => f.code === 'IAP504');
    expect(mismatches).toHaveLength(2); // both databases, deterministic order
    expect(mismatches[0]).toMatchObject({
      severity: 'warning',
      path: 'resources.big-db.spec.resilience.recoveryPointObjective',
      policyId: 'probe',
    });
    // The leaf evaluated false: the deny never fires.
    expect(result.findings.filter((f) => f.code === 'IAP501')).toEqual([]);
  });

  it('string vs number and boolean operands are mismatches', () => {
    const stringVsNumber = evaluate([
      denyOn(
        { field: 'spec.scaling.min', operator: 'greater-than', value: '1' },
        { kinds: ['Service'] },
      ),
    ]);
    expect(stringVsNumber.findings.map((f) => f.code)).toEqual(['IAP504']);

    const booleans = evaluate([
      denyOn({ field: 'spec.engine', operator: 'less-than', value: true }, { kinds: ['Database'] }),
    ]);
    expect(booleans.findings.map((f) => f.code)).toEqual(['IAP504', 'IAP504']);
  });

  it('matches rejects backreferences and lookbehind as unsupported RE2 constructs', () => {
    const backref = evaluate([
      denyOn(
        { field: 'spec.engine', operator: 'matches', value: '(post)\\1' },
        { kinds: ['Database'] },
      ),
    ]);
    expect(backref.findings.map((f) => f.code)).toEqual(['IAP504', 'IAP504']);
    expect(backref.findings[0]?.message).toContain('backreference');

    const lookbehind = evaluate([
      denyOn(
        { field: 'spec.engine', operator: 'matches', value: '(?<=post)gresql' },
        { kinds: ['Database'] },
      ),
    ]);
    expect(lookbehind.findings.map((f) => f.code)).toEqual(['IAP504', 'IAP504']);
    expect(lookbehind.findings[0]?.message).toContain('lookbehind');

    // An escaped backslash before a digit is NOT a backreference.
    const escaped = evaluate([
      denyOn(
        { field: 'spec.engine', operator: 'matches', value: 'post\\\\1?gresql' },
        { kinds: ['Database'] },
      ),
    ]);
    expect(escaped.findings.filter((f) => f.code === 'IAP504')).toEqual([]);

    // Invalid pattern syntax also degrades to IAP504 + false, never a throw.
    const invalid = evaluate([
      denyOn(
        { field: 'spec.engine', operator: 'matches', value: '(unclosed' },
        { kinds: ['Database'] },
      ),
    ]);
    expect(invalid.findings.map((f) => f.code)).toEqual(['IAP504', 'IAP504']);
  });
});

describe('effect polarity (ch. 7 §7.5)', () => {
  const forbidden: Policy['rule'] = { field: 'spec.exposure', operator: 'equals', value: 'public' };

  it('deny: condition true → IAP501 error; condition false → nothing', () => {
    const result = evaluate([{ id: 'no-public', target: {}, rule: forbidden, effect: 'deny' }]);
    expect(result.findings).toEqual([
      {
        code: 'IAP501',
        severity: 'error',
        path: 'resources.web.spec.exposure',
        message:
          'Policy no-public: forbidden state matched for resource "web" (spec.exposure is "public").',
        policyId: 'no-public',
      },
    ]);
  });

  it('warn: condition true → IAP503 warning (never fails validation)', () => {
    const result = evaluate([{ id: 'warn-public', target: {}, rule: forbidden, effect: 'warn' }]);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'IAP503', severity: 'warning', policyId: 'warn-public' }),
    ]);
  });

  it('require: condition false → IAP502 error; condition true → nothing', () => {
    const result = evaluate([
      {
        id: 'at-rest-required',
        target: { kinds: ['Database'] },
        rule: { field: 'spec.encryption.atRest', operator: 'equals', value: 'required' },
        effect: 'require',
      },
    ]);
    expect(result.findings).toEqual([
      {
        code: 'IAP502',
        severity: 'error',
        path: 'resources.big-db.spec.encryption.atRest',
        message:
          'Policy at-rest-required: spec.encryption.atRest must equal "required" (found "preferred").',
        policyId: 'at-rest-required',
      },
    ]);
    expect(result.evaluations.filter((e) => e.matched).map((e) => e.verdict)).toEqual([
      'violation',
      'pass',
    ]);
  });
});

describe('target matching (ch. 7 §7.2)', () => {
  const rule: Policy['rule'] = { field: 'kind', operator: 'exists' };

  it('kinds and selector must BOTH match when both are present', () => {
    expect(
      firedOn(rule, { kinds: ['Database'], selector: { labels: { tier: 'critical' } } }),
    ).toEqual(['big-db']);
    expect(
      firedOn(rule, { kinds: ['Service'], selector: { labels: { tier: 'critical' } } }),
    ).toEqual([]);
  });

  it('selector alone, kinds alone, and empty target', () => {
    expect(firedOn(rule, { selector: { labels: { costCenter: 'cc-7' } } })).toEqual([
      'big-db',
      'web',
    ]);
    expect(firedOn(rule, { kinds: ['Service'] })).toEqual(['web']);
    expect(firedOn(rule, {})).toEqual(['big-db', 'small-db', 'web']);
  });

  it('untargeted resources appear in the trace as not-targeted', () => {
    const result = evaluate([denyOn(rule, { kinds: ['Service'] })]);
    expect(result.evaluations).toEqual([
      { policyId: 'probe', resourceId: 'big-db', matched: false, verdict: 'not-targeted' },
      { policyId: 'probe', resourceId: 'small-db', matched: false, verdict: 'not-targeted' },
      { policyId: 'probe', resourceId: 'web', matched: true, verdict: 'violation' },
    ]);
  });
});

describe('require autofix (ch. 7 §7.5)', () => {
  it('an equals leaf emits an RFC 7386 merge patch on violation', () => {
    const result = evaluate([
      {
        id: 'at-rest-required',
        target: { kinds: ['Database'] },
        rule: { field: 'spec.encryption.atRest', operator: 'equals', value: 'required' },
        effect: 'require',
      },
    ]);
    expect(result.autofixes).toEqual([
      {
        policyId: 'at-rest-required',
        resourceId: 'big-db',
        patch: { spec: { encryption: { atRest: 'required' } } },
      },
    ]);
  });

  it('an allOf of equals leaves merges every field into one patch', () => {
    const result = evaluate([
      {
        id: 'hardened',
        target: { kinds: ['Database'] },
        rule: {
          allOf: [
            { field: 'spec.encryption.atRest', operator: 'equals', value: 'required' },
            { field: 'spec.resilience.backup', operator: 'equals', value: 'required' },
            { field: 'spec.availability', operator: 'equals', value: 'high' },
          ],
        },
        effect: 'require',
      },
    ]);
    expect(result.autofixes).toEqual([
      {
        policyId: 'hardened',
        resourceId: 'big-db',
        patch: {
          spec: {
            encryption: { atRest: 'required' },
            resilience: { backup: 'required' },
            availability: 'high',
          },
        },
      },
    ]);
  });

  it('non-equals conditions are report-only: no autofix emitted', () => {
    const reportOnly: Policy[] = [
      {
        id: 'r-exists',
        target: {},
        rule: { field: 'labels.owner', operator: 'exists' },
        effect: 'require',
      },
      {
        id: 'r-in',
        target: { kinds: ['Database'] },
        rule: { field: 'spec.engine', operator: 'in', value: ['mysql'] },
        effect: 'require',
      },
      {
        id: 'r-anyof',
        target: { kinds: ['Database'] },
        rule: {
          anyOf: [{ field: 'spec.availability', operator: 'equals', value: 'maximum' }],
        },
        effect: 'require',
      },
      {
        id: 'r-not',
        target: { kinds: ['Service'] },
        rule: { not: { field: 'spec.exposure', operator: 'equals', value: 'public' } },
        effect: 'require',
      },
    ];
    const result = evaluate(reportOnly);
    expect(result.findings.filter((f) => f.code === 'IAP502').length).toBeGreaterThan(0);
    expect(result.autofixes).toEqual([]);
  });

  it('deny and warn never emit autofixes, and compliant resources get none', () => {
    const result = evaluate([
      {
        id: 'deny-preferred',
        target: { kinds: ['Database'] },
        rule: { field: 'spec.encryption.atRest', operator: 'equals', value: 'preferred' },
        effect: 'deny',
      },
    ]);
    expect(result.findings.map((f) => f.code)).toEqual(['IAP501']);
    expect(result.autofixes).toEqual([]);
  });
});

describe('exceptions (roadmap phase 9 workflow)', () => {
  const requireHigh: Policy = {
    id: 'availability-high',
    target: { kinds: ['Database'] },
    rule: { field: 'spec.availability', operator: 'equals', value: 'high' },
    effect: 'require',
  };
  const exception: PolicyException = {
    policyId: 'availability-high',
    reason: 'legacy migration in flight',
    approver: 'platform-team',
    expiry: '2026-12-31T00:00:00Z',
    ticket: 'OPS-1234',
  };

  it('an unexpired exception downgrades the finding to a warning with the audit trail', () => {
    const result = evaluate([requireHigh], {
      exceptions: [exception],
      now: '2026-07-10T00:00:00Z',
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ code: 'IAP502', severity: 'warning' });
    expect(result.findings[0]?.message).toContain(
      '[exception: legacy migration in flight approved by platform-team until 2026-12-31T00:00:00Z]',
    );
    expect(result.evaluations.find((e) => e.resourceId === 'big-db')?.verdict).toBe('exempted');
  });

  it('an expired exception is ignored and reported as an IAP503 warning', () => {
    const result = evaluate([requireHigh], {
      exceptions: [{ ...exception, expiry: '2026-01-01T00:00:00Z' }],
      now: '2026-07-10T00:00:00Z',
    });
    const [violation, expired] = result.findings;
    expect(violation).toMatchObject({ code: 'IAP502', severity: 'error' });
    expect(expired).toMatchObject({
      code: 'IAP503',
      severity: 'warning',
      policyId: 'availability-high',
    });
    expect(expired?.message).toContain('expired exception');
  });

  it('an exception selector narrows the exempted resources', () => {
    const scoped: PolicyException = {
      ...exception,
      selector: { kinds: ['Database'], labels: { tier: 'dev' } },
    };
    // big-db (tier: critical) stays an error; the selector only covers tier: dev.
    const result = evaluate([requireHigh], {
      exceptions: [scoped],
      now: '2026-07-10T00:00:00Z',
    });
    expect(result.findings[0]).toMatchObject({
      code: 'IAP502',
      severity: 'error',
      path: 'resources.big-db.spec.availability',
    });
  });

  it('throws TypeError when exceptions are provided without now (no Date.now() in the library)', () => {
    expect(() => evaluate([requireHigh], { exceptions: [exception] })).toThrow(TypeError);
    expect(() => evaluate([requireHigh], { exceptions: [exception], now: 'not-a-date' })).toThrow(
      TypeError,
    );
    // No exceptions → now is not required.
    expect(() => evaluate([requireHigh], { exceptions: [] })).not.toThrow();
  });
});

describe('determinism (ch. 7 §7.6)', () => {
  it('findings order is policy id then resource id, regardless of authoring order', () => {
    const policies: Policy[] = [
      { id: 'zz-last', target: {}, rule: { field: 'kind', operator: 'exists' }, effect: 'warn' },
      { id: 'aa-first', target: {}, rule: { field: 'kind', operator: 'exists' }, effect: 'warn' },
    ];
    const result = evaluate(policies);
    expect(result.findings.map((f) => `${f.policyId}/${f.path}`)).toEqual([
      'aa-first/resources.big-db.kind',
      'aa-first/resources.small-db.kind',
      'aa-first/resources.web.kind',
      'zz-last/resources.big-db.kind',
      'zz-last/resources.small-db.kind',
      'zz-last/resources.web.kind',
    ]);
  });

  it('identical inputs produce byte-identical results', () => {
    const policies = POLICY_PACKS['production-baseline'] as Policy[];
    const a = evaluate(policies);
    const b = evaluate(policies);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('built-in packs (M9.2)', () => {
  const root = iisDocumentSchema();
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  for (const keyword of X_IIS_ANNOTATION_KEYWORDS) ajv.addKeyword({ keyword, valid: true });
  ajv.addSchema(root);
  const validatePolicy = ajv.compile({ $ref: `${root.$id as string}#/$defs/common/policy` });

  const packNames = Object.keys(POLICY_PACKS);
  it('ships the six phase-9 packs', () => {
    expect(packNames.sort()).toEqual([
      'backup-baseline',
      'encryption-baseline',
      'logging-baseline',
      'private-only',
      'production-baseline',
      'tagging-baseline',
    ]);
  });

  for (const name of packNames) {
    it(`${name}: every policy validates against $defs/common/policy and ids carry the pack prefix`, () => {
      for (const policy of POLICY_PACKS[name] as Policy[]) {
        expect(policy.id.startsWith(name)).toBe(true);
        const ok = validatePolicy(policy);
        expect(
          ok,
          JSON.stringify(validatePolicy.errors?.map((e) => `${e.instancePath} ${e.message}`)),
        ).toBe(true);
      }
    });
  }

  const examples = readdirSync(examplesDir)
    .filter((f) => f.endsWith('.iap.yaml'))
    .sort();

  it('every pack evaluates all 9 official examples without crashing', () => {
    expect(examples).toHaveLength(9);
    const counts: Record<string, number> = {};
    for (const file of examples) {
      const doc = parse(readFileSync(join(examplesDir, file), 'utf8')) as IaPDocument;
      const { model } = canonicalize(doc);
      for (const name of packNames) {
        const result = evaluatePolicies({
          resources: model.resources,
          policies: POLICY_PACKS[name] as Policy[],
        });
        counts[`${file}/${name}`] = result.findings.length;
        expect(result.evaluations.length).toBe(
          Object.keys(model.resources).length * (POLICY_PACKS[name] as Policy[]).length,
        );
      }
    }
    // Counts are recorded, not pinned — except the specific assertion below.
    expect(Object.values(counts).every((n) => n >= 0)).toBe(true);
  });

  it('private-only flags the public Gateway "edge" in serverless-api', () => {
    const doc = parse(
      readFileSync(join(examplesDir, 'serverless-api.iap.yaml'), 'utf8'),
    ) as IaPDocument;
    const { model } = canonicalize(doc);
    const result = evaluatePolicies({
      resources: model.resources,
      policies: POLICY_PACKS['private-only'] as Policy[],
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'IAP501',
        severity: 'error',
        path: 'resources.edge.spec.exposure',
        policyId: 'private-only-no-public-exposure',
      }),
    );
  });
});

describe('conformance cases (phase 5)', () => {
  function evaluateCase(file: string) {
    const doc = parse(readFileSync(join(casesDir, 'invalid', file), 'utf8')) as IaPDocument;
    const { model } = canonicalize(doc);
    return evaluatePolicies(model);
  }

  it('17-policy-deny-violation produces IAP501', () => {
    const result = evaluateCase('17-policy-deny-violation.iap.yaml');
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'IAP501',
        severity: 'error',
        path: 'resources.assets.spec.exposure',
        policyId: 'no-public-object-stores',
      }),
    ]);
  });

  it('18-policy-require-violation produces IAP502 with the deterministic autofix', () => {
    const result = evaluateCase('18-policy-require-violation.iap.yaml');
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'IAP502',
        severity: 'error',
        path: 'resources.orders-db.spec.encryption.atRest',
        policyId: 'encryption-at-rest-required',
      }),
    ]);
    expect(result.autofixes).toEqual([
      {
        policyId: 'encryption-at-rest-required',
        resourceId: 'orders-db',
        patch: { spec: { encryption: { atRest: 'required' } } },
      },
    ]);
  });

  it('evaluation runs on the canonical document: materialized defaults are visible', () => {
    // Case 17's ObjectStore omits encryption; the canonical model carries the
    // defaults, so a require-equals policy over them passes (ch. 7 §7.6 rule 1).
    const doc = parse(
      readFileSync(join(casesDir, 'invalid', '17-policy-deny-violation.iap.yaml'), 'utf8'),
    ) as IaPDocument;
    const { model } = canonicalize(doc);
    const result = evaluatePolicies({
      resources: model.resources,
      policies: [
        {
          id: 'defaults-visible',
          target: { kinds: ['ObjectStore'] },
          rule: { field: 'spec.encryption.atRest', operator: 'equals', value: 'required' },
          effect: 'require',
        },
      ],
    });
    expect(result.findings).toEqual([]);
  });
});
