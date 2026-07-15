/**
 * `iap create` — natural-language authoring at the command line (ch. 22
 * "Natural-language creation"; roadmap Phase 5, M5.3). A thin, non-interactive
 * shell over `@iap/intent-compiler`'s `runAuthoringSession`: accept a
 * natural-language requirement, run the compiler, surface any clarifications,
 * show a semantic preview, and — only when the request fully commits — write
 * `infrastructure.iap.yaml`.
 *
 * The normative boundary is the engine's, not the CLI's: the compiler never
 * writes YAML; a document is produced solely by the gate after the whole ch. 8
 * pipeline passes (OP-1). This command adds argv parsing, answer plumbing, and
 * rendering — it holds no authoring logic of its own and cannot deploy.
 *
 * Non-interactive by contract (§22 automation): the request comes from a
 * positional argument, `--request`, or stdin; clarifications are answered with
 * `--answers`/`--answers-file` or resolved with `--yes-defaults`; destructive
 * changes require `--acknowledge-destructive`. Machine output (`-o json`) and
 * the written document are deterministic; the injected `--timestamp` keeps even
 * audit fields reproducible (it never reaches the document, which carries no
 * timestamps).
 *
 * Exit codes (§22.1): 0 committed/explained · 1 the request needs the author's
 * attention (clarifications, unsupported capabilities, or a validation refusal)
 * · 2 usage error · 3 an adapter/operation failure.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { runAuthoringSession } from '@iap/intent-compiler';
import type {
  AuthoringSessionResult,
  ClarificationAnswer,
  ClarificationQuestion,
  IntentFacet,
} from '@iap/intent-compiler';
import type { CliIO, ParsedArgs } from '../shared.js';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_OPERATION,
  EXIT_USAGE,
  JSON_FORMAT_VERSION,
  booleanFlag,
  stringFlag,
  writeJson,
} from '../shared.js';

const DEFAULT_OUT = 'infrastructure.iap.yaml';
const DEFAULT_ACTOR = 'iap-cli';

/** A one-token summary of a facet, for the human "intent" line. */
function facetLabel(facet: IntentFacet): string {
  const f = facet as unknown as Record<string, unknown>;
  const value =
    f.workload ?? f.service ?? f.intent ?? f.framework ?? f.level ?? f.value ?? f.region ?? '';
  return value === '' ? String(f.facet) : `${String(f.facet)}:${String(value)}`;
}

/** Parse `--answers <json>` into the engine's answer shape (usage error on malformed). */
function parseAnswers(
  raw: string | undefined,
): { ok: true; answers: ClarificationAnswer[] } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, answers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, message: `--answers is not valid JSON: ${(error as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      message: '--answers must be a JSON array of {questionId, optionId?, value?}',
    };
  }
  const answers: ClarificationAnswer[] = [];
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { questionId?: unknown }).questionId !== 'string'
    ) {
      return { ok: false, message: 'each --answers entry needs a string "questionId"' };
    }
    answers.push(entry as ClarificationAnswer);
  }
  return { ok: true, answers };
}

function questionJson(question: ClarificationQuestion): Record<string, unknown> {
  return {
    id: question.id,
    trigger: question.trigger,
    question: question.question,
    blocking: question.operationIds.length > 0,
    recommendedOptionId: question.recommendedOptionId ?? null,
    options: question.options.map((opt) => ({
      id: opt.id,
      label: opt.label,
      impact: opt.impact,
      requiresValue: opt.requiresValue === true,
      recommended: opt.id === question.recommendedOptionId,
    })),
  };
}

/** Render the whole session as one deterministic JSON payload. */
function toJson(
  result: AuthoringSessionResult,
  request: string,
  writtenTo: string | null,
): Record<string, unknown> {
  const committed = result.committed;
  return {
    formatVersion: JSON_FORMAT_VERSION,
    outcome: result.outcome,
    request,
    intent: result.facets.map(facetLabel),
    unsupported: result.unsupported.map((u) => ({
      capability: u.capability,
      reason: u.reason,
      suggestion: u.suggestion ?? null,
    })),
    clarifications: result.questions.map(questionJson),
    answered: result.answered.map((a) => ({
      questionId: a.questionId,
      optionId: a.optionId ?? null,
      value: a.value ?? null,
      fromRecommendedDefault: a.fromRecommendedDefault,
    })),
    unanswered: result.unanswered.map((q) => q.id),
    preview: result.explain !== undefined && result.explain.ok ? result.explain.text : null,
    refusals: result.refusals.map((r) => ({
      code: 'code' in r ? r.code : null,
      message: r.message,
      path: 'path' in r && r.path !== undefined ? r.path : null,
    })),
    canonicalHash: committed?.canonicalHash ?? null,
    provenanceCount: committed?.provenance.length ?? 0,
    resources: committed === undefined ? [] : Object.keys(committed.document.resources).sort(),
    writtenTo,
    document: writtenTo === null && committed !== undefined ? committed.serialize('yaml') : null,
  };
}

/** Human-readable transcript for interactive terminals. */
function renderHuman(io: CliIO, result: AuthoringSessionResult, request: string): void {
  io.stdout.write(`request:  ${request}\n`);
  const intent = result.facets.map(facetLabel);
  if (intent.length > 0) io.stdout.write(`intent:   ${intent.join(', ')}\n`);

  if (result.unsupported.length > 0) {
    io.stdout.write('unsupported:\n');
    for (const u of result.unsupported) {
      io.stdout.write(
        `  • ${u.capability} — ${u.reason}${u.suggestion ? ` (try: ${u.suggestion})` : ''}\n`,
      );
    }
  }

  if (result.questions.length > 0) {
    io.stdout.write('clarifications:\n');
    for (const q of result.questions) {
      io.stdout.write(`  ? [${q.trigger}] ${q.question}\n`);
      for (const opt of q.options) {
        const rec = opt.id === q.recommendedOptionId ? ' (recommended)' : '';
        const val = opt.requiresValue === true ? ' <needs a value>' : '';
        io.stdout.write(`      - ${opt.id}: ${opt.label}${rec}${val}\n`);
      }
    }
  }

  if (result.answered.length > 0) {
    const rendered = result.answered
      .map(
        (a) =>
          `${a.questionId}=${a.optionId ?? JSON.stringify(a.value)}${a.fromRecommendedDefault ? '*' : ''}`,
      )
      .join(', ');
    io.stdout.write(`answered: ${rendered}\n`);
  }

  if (result.explain !== undefined && result.explain.ok) {
    io.stdout.write('preview:\n');
    for (const line of result.explain.text.split('\n')) io.stdout.write(`  ${line}\n`);
  }

  if (result.refusals.length > 0) {
    io.stdout.write('refused:\n');
    for (const r of result.refusals) {
      const code = 'code' in r ? `${r.code} ` : '';
      io.stdout.write(`  ✖ ${code}${r.message}\n`);
    }
  }
}

/** Map a session outcome to the normative exit code (§22.1). */
function exitFor(result: AuthoringSessionResult): number {
  switch (result.outcome) {
    case 'committed':
    case 'explained':
      return EXIT_OK;
    case 'needs-input':
    case 'no-operations':
      // The request is underspecified or unrealizable — the author must act.
      return EXIT_FINDINGS;
    case 'refused': {
      // A document-level validation refusal is findings-like (exit 1);
      // an adapter/other refusal is an operation failure (exit 3).
      const validationRefusal = result.refusals.some(
        (r) => 'code' in r && r.code === 'validation-failed',
      );
      return validationRefusal ? EXIT_FINDINGS : EXIT_OPERATION;
    }
    default:
      return EXIT_OPERATION;
  }
}

async function resolveRequest(args: ParsedArgs, io: CliIO): Promise<string | undefined> {
  const inline = stringFlag(args, 'request');
  if (inline !== undefined && inline.trim() !== '') return inline.trim();
  if (args.positionals.length > 0) return args.positionals.join(' ').trim();
  // Fall back to stdin when available (automation: piped requirement).
  if (io.readStdin !== undefined) {
    const piped = (await io.readStdin()).trim();
    if (piped !== '') return piped;
  }
  return undefined;
}

export async function createCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const output = stringFlag(args, 'output') ?? 'human';
  const quiet = booleanFlag(args, 'quiet');

  const request = await resolveRequest(args, io);
  if (request === undefined) {
    io.stderr.write(
      'iap create: no request — provide a natural-language requirement as an argument, via --request, or on stdin\n',
    );
    return EXIT_USAGE;
  }

  const answers = parseAnswers(stringFlag(args, 'answers'));
  if (!answers.ok) {
    io.stderr.write(`iap create: ${answers.message}\n`);
    return EXIT_USAGE;
  }

  const timestamp = stringFlag(args, 'timestamp') ?? new Date().toISOString();
  const result = await runAuthoringSession(request, {
    timestamp,
    actor: stringFlag(args, 'actor') ?? DEFAULT_ACTOR,
    documentName: stringFlag(args, 'name') ?? 'infrastructure',
    profile: stringFlag(args, 'profile') ?? null,
    answers: answers.answers,
    autoAnswerDefaults: booleanFlag(args, 'yes-defaults'),
    acknowledgeDestructive: booleanFlag(args, 'acknowledge-destructive'),
  });

  // Decide where a committed document goes before rendering, so JSON reports it.
  const toStdout = booleanFlag(args, 'stdout');
  const outPath = stringFlag(args, 'out') ?? DEFAULT_OUT;

  if (result.outcome === 'committed' && result.committed !== undefined && !toStdout) {
    if (existsSync(outPath) && !booleanFlag(args, 'force')) {
      io.stderr.write(`iap create: ${outPath} already exists — pass --force to overwrite\n`);
      return EXIT_USAGE;
    }
    try {
      await writeFile(outPath, result.committed.serialize('yaml'), 'utf8');
    } catch (error) {
      io.stderr.write(`iap create: cannot write ${outPath}: ${(error as Error).message}\n`);
      return EXIT_OPERATION;
    }
  }

  const committedToFile =
    result.outcome === 'committed' && result.committed !== undefined && !toStdout ? outPath : null;

  if (output === 'json') {
    writeJson(io.stdout, toJson(result, request, committedToFile));
    return exitFor(result);
  }

  // Human output.
  if (toStdout && result.committed !== undefined) {
    io.stdout.write(result.committed.serialize('yaml'));
    if (!result.committed.serialize('yaml').endsWith('\n')) io.stdout.write('\n');
    return exitFor(result);
  }

  if (!quiet) {
    renderHuman(io, result, request);
    if (committedToFile !== null && result.committed !== undefined) {
      io.stdout.write(
        `\ncreated ${committedToFile} (${Object.keys(result.committed.document.resources).length} resources)\n`,
      );
    } else if (result.outcome === 'needs-input') {
      io.stdout.write(
        '\nnot written — answer the clarifications above (e.g. --answers or --yes-defaults) and re-run\n',
      );
    } else if (result.outcome === 'no-operations') {
      io.stdout.write('\nnot written — the request produced no supported operations\n');
    } else if (result.outcome === 'refused') {
      io.stdout.write('\nnot written — the request was refused\n');
    }
  }
  return exitFor(result);
}
