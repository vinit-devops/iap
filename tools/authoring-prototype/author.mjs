#!/usr/bin/env node
/**
 * Natural-language authoring prototype — runnable demo (roadmap §3, M3.5).
 *
 * A thin, human-facing driver over the shipped `runAuthoringSession` engine:
 * it turns a natural-language request into an IaP document (or stops at the
 * first human gate) and prints the whole transcript — extracted intent,
 * clarifications, assumptions, the semantic preview, and the committed YAML.
 * The Phase 5 `iap create` command (M5.3) productizes this same engine; this
 * script exists to exercise and demonstrate it without the CLI.
 *
 * Runs against the BUILT package — run `pnpm build` first.
 *
 * Usage:
 *   node tools/authoring-prototype/author.mjs "<request>" [options]
 *   node tools/authoring-prototype/author.mjs --demo
 *
 * Options:
 *   --base <path>            author against an existing IaP document
 *   --yes-defaults           auto-answer clarifications with recommended defaults
 *   --acknowledge-destructive  proceed with destructive changes (the human "yes")
 *   --json                   print the raw session result as JSON
 *   --demo                   run a short scripted tour of representative requests
 *
 * The audit timestamp is fixed (this is a deterministic demo, never a clock).
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TIMESTAMP = '2026-07-11T12:00:00Z';

async function importBuilt(relative, label) {
  try {
    return await import(pathToFileURL(join(repoRoot, relative)).href);
  } catch (error) {
    console.error(`Could not import built ${label}. Run \`pnpm build\` first.\n${String(error)}`);
    process.exit(1);
  }
}

const { runAuthoringSession } = await importBuilt(
  'packages/intent-compiler/dist/index.js',
  '@iap/intent-compiler',
);
const { load } = await importBuilt('packages/sdk/dist/index.js', '@iap/sdk');

const OUTCOME_LABEL = {
  committed: '✔ committed a valid document',
  explained: 'ℹ explained (no changes authored)',
  'no-operations': '∅ nothing to author',
  'needs-input': '⏸ needs input before it can commit',
  refused: '✖ refused',
};

function facetSummary(facets) {
  return facets.map((f) => {
    const value = f.workload ?? f.service ?? f.intent ?? f.value ?? f.framework ?? f.level ?? '';
    return value === '' ? f.facet : `${f.facet}:${value}`;
  });
}

async function render(input, options) {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`request:  ${input}`);
  const result = await runAuthoringSession(input, options);
  console.log(`outcome:  ${OUTCOME_LABEL[result.outcome] ?? result.outcome}`);

  if (options.json) {
    const { committed, ...rest } = result;
    console.log(JSON.stringify({ ...rest, committed: committed !== undefined }, null, 2));
    return result;
  }

  const facets = facetSummary(result.facets);
  if (facets.length > 0) console.log(`intent:   ${facets.join(', ')}`);
  if (result.unsupported.length > 0) {
    console.log('unsupported:');
    for (const u of result.unsupported) {
      console.log(
        `  • ${u.capability} — ${u.reason}${u.suggestion ? ` (try: ${u.suggestion})` : ''}`,
      );
    }
  }
  if (result.questions.length > 0) {
    console.log('clarifications:');
    for (const q of result.questions) {
      console.log(`  ? [${q.trigger}] ${q.question}`);
      for (const opt of q.options) {
        const rec = opt.id === q.recommendedOptionId ? ' (recommended)' : '';
        console.log(`      - ${opt.label}${rec}`);
      }
    }
  }
  if (result.answered.length > 0) {
    console.log(
      `answered: ${result.answered
        .map(
          (a) =>
            `${a.questionId}=${a.optionId ?? JSON.stringify(a.value)}${a.fromRecommendedDefault ? '*' : ''}`,
        )
        .join(', ')}`,
    );
  }
  if (result.unanswered.length > 0) {
    console.log(`awaiting: ${result.unanswered.map((q) => q.id).join(', ')}`);
  }
  if (result.explain !== undefined && result.explain.ok) {
    console.log('preview:');
    for (const line of result.explain.text.split('\n')) console.log(`  ${line}`);
  }
  if (result.refusals.length > 0) {
    console.log('refusals:');
    for (const r of result.refusals)
      console.log(`  ✖ ${r.code ?? ''} ${r.message ?? ''}`.trimEnd());
  }
  if (result.committed !== undefined) {
    console.log(`hash:     ${result.committed.canonicalHash}`);
    console.log('document:');
    for (const line of result.committed.serialize('yaml').split('\n')) console.log(`  ${line}`);
  }
  return result;
}

async function baseDocument(path) {
  const ws = await load({ path: resolve(process.cwd(), path) });
  if (!ws.ok || ws.document === undefined) {
    console.error(`Could not load base document at ${path}`);
    process.exit(1);
  }
  return structuredClone(ws.document);
}

const DEMO = [
  [
    'A public web app running image registry.example.com/app:1.0.0 behind a gateway with a highly available postgresql 16 database and a redis cache.',
    {},
  ],
  ['We need a web app', {}],
  [
    'A highly available postgresql database on a budget of $200 per month, web app image registry.example.com/app:1.0.0.',
    {},
  ],
  ['We need a vpn and a dynamodb table', {}],
];

async function main() {
  const argv = process.argv.slice(2);
  const options = {
    timestamp: TIMESTAMP,
    documentName: 'authoring-demo',
    autoAnswerDefaults: argv.includes('--yes-defaults'),
    acknowledgeDestructive: argv.includes('--acknowledge-destructive'),
    json: argv.includes('--json'),
  };

  if (argv.includes('--demo')) {
    console.log('Natural-language authoring prototype — scripted tour (M3.5)');
    for (const [request, extra] of DEMO) {
      await render(request, { ...options, ...extra });
    }
    return;
  }

  const baseIdx = argv.indexOf('--base');
  if (baseIdx !== -1) options.document = await baseDocument(argv[baseIdx + 1]);

  const request = argv.find((a) => !a.startsWith('--') && a !== argv[baseIdx + 1]);
  if (request === undefined) {
    console.error(
      'Usage: node tools/authoring-prototype/author.mjs "<request>" [--base <path>] [--yes-defaults] [--acknowledge-destructive] [--json]',
    );
    console.error('   or: node tools/authoring-prototype/author.mjs --demo');
    process.exit(2);
  }

  const result = await render(request, options);
  process.exit(result.outcome === 'refused' ? 1 : 0);
}

await main();
