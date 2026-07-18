/**
 * Shared plumbing for the live-run harness (docs/guides/live-run-runbook.md;
 * ROADMAP-V4 M21.1). Arg parsing, step reporting, and the AWS CLI seam with a
 * `--mock` mode: mock runs execute the SAME step sequence but AWS reads come
 * from canned clean fixtures, so the harness is exercisable with zero
 * credentials and zero network (the runbook's "dry-run against mock").
 */

import { execFileSync } from 'node:child_process';

export function parseArgs(argv, allowed) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(`unexpected positional argument ${arg}`);
    const name = arg.slice(2);
    if (!(name in allowed)) fail(`unknown option --${name}`);
    if (allowed[name] === 'flag') args[name] = true;
    else args[name] = argv[(i += 1)];
  }
  return args;
}

export function fail(message) {
  console.error(`live-run: ${message}`);
  process.exit(1);
}

/** Numbered PASS/FAIL step reporter; tracks overall outcome. */
export function stepper(title) {
  console.log(title);
  let n = 0;
  let failed = 0;
  return {
    step(name, fn) {
      n += 1;
      try {
        const detail = fn();
        console.log(`  ${n}. PASS ${name}${detail ? ` — ${detail}` : ''}`);
      } catch (err) {
        failed += 1;
        console.log(`  ${n}. FAIL ${name} — ${err?.message ?? err}`);
      }
    },
    finish() {
      if (failed > 0) {
        console.error(`RESULT: FAIL (${failed} step${failed === 1 ? '' : 's'} failed)`);
        process.exit(1);
      }
      console.log('RESULT: PASS');
    },
  };
}

/**
 * Run an AWS CLI read command and parse its JSON output. In mock mode the
 * canned fixture is returned instead and nothing is executed.
 */
export function awsCli(args, { mock, mockResult, profile, region }) {
  if (mock) return mockResult;
  const full = [...args, '--output', 'json'];
  if (profile) full.push('--profile', profile);
  if (region) full.push('--region', region);
  const stdout = execFileSync('aws', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return stdout.trim() === '' ? null : JSON.parse(stdout);
}
