#!/usr/bin/env node
/**
 * Spec-validation harness (`pnpm run test:spec`).
 *
 * Proves, on every run:
 *   1. Both normative schemas compile under ajv draft 2020-12 with the
 *      x-iap-* annotation vocabulary registered (strict mode ON).
 *   2. Every official example validates; the reference mapping validates.
 *   3. Every conformance case produces its declared outcome
 *      (`# expected: schema-invalid` fails; `# expected: IISnnn` passes
 *      schema validation and is deferred to the full semantic validator).
 *   4. ROADMAP.yaml parses and has a well-formed phase/milestone shape.
 *
 * Exit code 0 = all green; 1 = any mismatch.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse, parseAllDocuments } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
let checks = 0;
function check(ok, label, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ok      ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL    ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function loadYaml(path) {
  const docs = parseAllDocuments(readFileSync(path, 'utf8'), { uniqueKeys: true });
  if (docs.length !== 1) throw new Error(`expected single document, found ${docs.length}`);
  const doc = docs[0];
  if (doc.errors.length > 0) throw new Error(doc.errors[0].message);
  return doc.toJS();
}

const X_IIS = [
  'x-iap-since',
  'x-iap-deprecated',
  'x-iap-capability',
  'x-iap-reserved',
  'x-iap-presence-semantic',
  'x-iap-default-when',
];
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
for (const keyword of X_IIS) ajv.addKeyword({ keyword, valid: true });

console.log('schemas');
let validateDoc, validateMapping;
try {
  validateDoc = ajv.compile(
    JSON.parse(readFileSync(join(repoRoot, 'spec/schema/iap-v1.schema.json'), 'utf8')),
  );
  check(true, 'iap-v1.schema.json compiles (strict mode, x-iap vocabulary)');
} catch (e) {
  check(false, 'iap-v1.schema.json compiles', e.message);
}
try {
  validateMapping = ajv.compile(
    JSON.parse(readFileSync(join(repoRoot, 'spec/schema/iap-mapping-v1.schema.json'), 'utf8')),
  );
  check(true, 'iap-mapping-v1.schema.json compiles');
} catch (e) {
  check(false, 'iap-mapping-v1.schema.json compiles', e.message);
}
if (!validateDoc || !validateMapping) {
  console.error(`\n${failures} failure(s) out of ${checks} checks`);
  process.exit(1);
}

console.log('provider schemas');
for (const file of ['plugin-manifest-v1.schema.json', 'conformance-case-v1.schema.json']) {
  try {
    ajv.compile(JSON.parse(readFileSync(join(repoRoot, 'spec/schema', file), 'utf8')));
    check(true, `${file} compiles (strict mode, x-iap vocabulary)`);
  } catch (e) {
    check(false, `${file} compiles`, e.message);
  }
}

console.log('planner schema');
for (const file of ['plan-v1.schema.json']) {
  try {
    ajv.compile(JSON.parse(readFileSync(join(repoRoot, 'spec/schema', file), 'utf8')));
    check(true, `${file} compiles (strict mode, x-iap vocabulary)`);
  } catch (e) {
    check(false, `${file} compiles`, e.message);
  }
}

console.log('compiler operations schema');
for (const file of ['compiler-operations-v1.schema.json']) {
  try {
    ajv.compile(JSON.parse(readFileSync(join(repoRoot, 'spec/schema', file), 'utf8')));
    check(true, `${file} compiles (strict mode, x-iap vocabulary)`);
  } catch (e) {
    check(false, `${file} compiles`, e.message);
  }
}

console.log('cost schemas');
for (const file of ['price-snapshot-v1.schema.json', 'cost-report-v1.schema.json']) {
  try {
    ajv.compile(JSON.parse(readFileSync(join(repoRoot, 'spec/schema', file), 'utf8')));
    check(true, `${file} compiles (strict mode, x-iap vocabulary)`);
  } catch (e) {
    check(false, `${file} compiles`, e.message);
  }
}

const errorText = (validate) =>
  (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message}`)
    .slice(0, 3)
    .join('; ');

console.log('examples');
const examplesDir = join(repoRoot, 'spec/examples');
const exampleFiles = readdirSync(examplesDir).filter((f) => f.endsWith('.iap.yaml'));
check(exampleFiles.length === 9, `found 9 official examples (${exampleFiles.length})`);
for (const file of exampleFiles) {
  try {
    const ok = validateDoc(loadYaml(join(examplesDir, file)));
    check(ok, `examples/${file}`, ok ? '' : errorText(validateDoc));
  } catch (e) {
    check(false, `examples/${file}`, e.message);
  }
}

console.log('mappings');
for (const file of readdirSync(join(repoRoot, 'spec/mappings')).filter((f) =>
  f.endsWith('.iap-map.yaml'),
)) {
  try {
    const ok = validateMapping(loadYaml(join(repoRoot, 'spec/mappings', file)));
    check(ok, `mappings/${file}`, ok ? '' : errorText(validateMapping));
  } catch (e) {
    check(false, `mappings/${file}`, e.message);
  }
}

console.log('conformance cases');
const casesDir = join(repoRoot, 'spec/conformance/cases');
for (const file of readdirSync(join(casesDir, 'valid'))) {
  try {
    const ok = validateDoc(loadYaml(join(casesDir, 'valid', file)));
    check(ok, `valid/${file}`, ok ? '' : errorText(validateDoc));
  } catch (e) {
    check(false, `valid/${file}`, e.message);
  }
}
for (const file of readdirSync(join(casesDir, 'invalid'))) {
  const path = join(casesDir, 'invalid', file);
  const text = readFileSync(path, 'utf8');
  const expected = /^# expected:\s*(\S+)/m.exec(text)?.[1];
  if (!expected) {
    check(false, `invalid/${file}`, 'missing "# expected:" header');
    continue;
  }
  let ok;
  try {
    ok = validateDoc(parse(text));
  } catch {
    ok = false; // parse-level rejection also counts as schema-detectable failure
  }
  if (expected === 'schema-invalid') {
    check(ok === false, `invalid/${file} rejected by schema (expected: schema-invalid)`);
  } else {
    check(
      ok === true,
      `invalid/${file} schema-valid, deferred to semantic validator (expected: ${expected})`,
      ok ? '' : errorText(validateDoc),
    );
  }
}

console.log('semantic validation (phases 1-4)');
let validateDocument;
try {
  ({ validateDocument } = await import(
    pathToFileURL(join(repoRoot, 'packages/validator/dist/index.js')).href
  ));
} catch (e) {
  check(false, '@iap/validator build artifact loads (run `pnpm build` first)', e.message);
}
if (validateDocument) {
  for (const file of readdirSync(join(casesDir, 'invalid')).sort()) {
    const text = readFileSync(join(casesDir, 'invalid', file), 'utf8');
    const expected = /^# expected:\s*(\S+)/m.exec(text)?.[1];
    if (!expected || !/^IAP[0-9]{3}$/.test(expected)) continue; // schema-invalid cases handled above
    if (!/^IAP[1-4]/.test(expected)) {
      // Phase 5 (IAP5xx) cases run in the dedicated policy section below.
      // Phases 6+ (security, compliance, version/extension) have no engine
      // yet; not counted as a validated check.
      if (!/^IAP5/.test(expected)) {
        console.log(
          `  ok      invalid/${file} deferred (expected ${expected}: phase 6/8 engines pending)`,
        );
      }
      continue;
    }
    // Cases needing a profile-relative run carry a machine-readable header
    // (e.g. `# profile: production` on 22-postmerge-invalid).
    const profile = /^# profile:\s*(\S+)/m.exec(text)?.[1] ?? null;
    try {
      const result = validateDocument(text, { profile });
      const codes = result.findings.map((f) => f.code);
      check(
        codes.includes(expected) && result.ok === false,
        `invalid/${file} produces ${expected}${profile ? ` (profile: ${profile})` : ''}`,
        codes.includes(expected)
          ? 'expected ok === false'
          : `got [${[...new Set(codes)].join(', ')}]`,
      );
    } catch (e) {
      check(false, `invalid/${file} produces ${expected}`, e.message);
    }
  }
  for (const file of readdirSync(join(casesDir, 'valid')).sort()) {
    try {
      const result = validateDocument(readFileSync(join(casesDir, 'valid', file), 'utf8'));
      const errors = result.findings.filter((f) => f.severity === 'error');
      check(
        result.ok === true && errors.length === 0,
        `valid/${file} passes phases 1-4`,
        errors.map((f) => `${f.code} ${f.path}`).join('; '),
      );
    } catch (e) {
      check(false, `valid/${file} passes phases 1-4`, e.message);
    }
  }
}

console.log('policy evaluation (phase 5)');
let canonicalizeDocument, evaluatePolicies;
try {
  ({ canonicalize: canonicalizeDocument } = await import(
    pathToFileURL(join(repoRoot, 'packages/model/dist/index.js')).href
  ));
  ({ evaluatePolicies } = await import(
    pathToFileURL(join(repoRoot, 'packages/policy/dist/index.js')).href
  ));
} catch (e) {
  check(false, '@iap/policy build artifact loads (run `pnpm build` first)', e.message);
}
if (canonicalizeDocument && evaluatePolicies) {
  for (const file of readdirSync(join(casesDir, 'invalid')).sort()) {
    const text = readFileSync(join(casesDir, 'invalid', file), 'utf8');
    const expected = /^# expected:\s*(\S+)/m.exec(text)?.[1];
    if (!expected || !/^IAP5[0-9]{2}$/.test(expected)) continue;
    const profile = /^# profile:\s*(\S+)/m.exec(text)?.[1] ?? null;
    try {
      // Policies evaluate against the canonical, defaults-applied document
      // (ch. 7 §7.6) — canonicalize first, then run the policy engine.
      const { model } = canonicalizeDocument(parse(text), { profile });
      const result = evaluatePolicies(model);
      const codes = result.findings.map((f) => f.code);
      const asError = result.findings.some((f) => f.code === expected && f.severity === 'error');
      check(
        codes.includes(expected) && asError,
        `invalid/${file} produces ${expected}${profile ? ` (profile: ${profile})` : ''}`,
        codes.includes(expected)
          ? 'expected an error-severity finding'
          : `got [${[...new Set(codes)].join(', ')}]`,
      );
    } catch (e) {
      check(false, `invalid/${file} produces ${expected}`, e.message);
    }
  }
}

console.log('error-code registry');
try {
  const registry = loadYaml(join(repoRoot, 'spec/conformance/error-codes.yaml'));
  const registryCodes = new Set(registry.codes.map((c) => c.code));
  const ch08 = readFileSync(join(repoRoot, 'spec/chapters/08-validation.md'), 'utf8');
  const ch08Codes = new Set(ch08.match(/IAP[0-9]{3}/g) ?? []);
  const missingFromRegistry = [...ch08Codes].filter((c) => !registryCodes.has(c));
  const missingFromChapter = [...registryCodes].filter((c) => !ch08Codes.has(c));
  check(
    missingFromRegistry.length === 0 && missingFromChapter.length === 0,
    `error-codes.yaml matches chapter 8 (${registryCodes.size} codes)`,
    [
      missingFromRegistry.length ? `not in registry: ${missingFromRegistry}` : '',
      missingFromChapter.length ? `not in chapter 8: ${missingFromChapter}` : '',
    ]
      .filter(Boolean)
      .join('; '),
  );
  const shapeOk = registry.codes.every(
    (c) =>
      /^IAP[0-9]{3}$/.test(c.code) &&
      c.phase >= 1 &&
      c.phase <= 8 &&
      Number(c.code.slice(3, 4)) === c.phase &&
      ['error', 'warning', 'contextual'].includes(c.severity) &&
      ['validation', 'plan-time'].includes(c.stage) &&
      typeof c.title === 'string',
  );
  check(shapeOk, 'error-codes.yaml entries well-formed (phase digit matches code)');
} catch (e) {
  check(false, 'error-codes.yaml matches chapter 8', e.message);
}

console.log('roadmap tracker');
try {
  const roadmap = loadYaml(join(repoRoot, 'ROADMAP.yaml'));
  const statuses = new Set(['pending', 'in-progress', 'completed', 'blocked']);
  const phasesOk =
    Array.isArray(roadmap.phases) &&
    roadmap.phases.length >= 19 &&
    roadmap.phases.every(
      (p) =>
        typeof p.id === 'string' &&
        statuses.has(p.status) &&
        Array.isArray(p.milestones) &&
        p.milestones.every((m) => statuses.has(m.status) && Array.isArray(m.evidence)) &&
        Array.isArray(p.exitCriteria),
    );
  check(phasesOk, `ROADMAP.yaml well-formed (${roadmap.phases?.length ?? 0} phases)`);
} catch (e) {
  check(false, 'ROADMAP.yaml well-formed', e.message);
}

console.log(
  failures === 0
    ? `\nall ${checks} checks passed`
    : `\n${failures} failure(s) out of ${checks} checks`,
);
process.exit(failures === 0 ? 0 : 1);
