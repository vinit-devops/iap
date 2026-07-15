/**
 * Shared front half of the execution commands (`deploy`, `destroy`, `drift`):
 * load + canonicalize the target document and apply the mapping to a
 * `ProviderPlan`, applying exactly the same fail-closed gates as `iap plan`
 * (§22.1; CP-4; ch. 19 §19.6). The mapping resolution (`resolveMapping`,
 * `buildTrustStore`, `writeDiagnostics`) is defined here and reused by
 * `iap plan` so the two paths can never drift.
 *
 * This module produces the pure `ProviderPlan` artifact only — it imports no
 * execution machinery, so the mapping stage stays structurally unable to touch
 * a cloud.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Finding } from '@iap/model';
import {
  applyMapping,
  loadProviderPackage,
  validateMappingArtifact,
  verifyMappingArtifact,
} from '@iap/provider-sdk';
import type {
  MappingArtifact,
  MappingDiagnostic,
  ProviderPlan,
  TrustStore,
} from '@iap/provider-sdk';
import type { CliIO, ParsedArgs } from '../shared.js';
import { EXIT_FINDINGS, EXIT_USAGE, openWorkspace, stringFlag, writeFindings } from '../shared.js';

export type MappingResolution =
  { ok: true; artifact: MappingArtifact } | { ok: false; message: string };

/** Trust store from a keys directory (keyId = filename stem), as in the harness. */
export function buildTrustStore(keysDir: string): TrustStore {
  if (!existsSync(keysDir) || !statSync(keysDir).isDirectory()) return {};
  const store: Record<string, string> = {};
  for (const file of readdirSync(keysDir).sort()) {
    if (!file.endsWith('.public.pem')) continue;
    store[file.slice(0, -'.public.pem'.length)] = readFileSync(join(keysDir, file), 'utf8');
  }
  return store;
}

/**
 * Resolve `--mapping`: a provider package directory loads through
 * `loadProviderPackage` with trust material from `--keys` or the package's
 * own `keys/` directory; a bare `*.iap-map.yaml` artifact is schema-validated
 * and statically verified (coverage tiling) — the same checks the loader runs,
 * minus signature and digests, which a bare artifact cannot carry.
 */
export function resolveMapping(path: string, keysDir: string | undefined): MappingResolution {
  if (!existsSync(path)) {
    return { ok: false, message: `cannot read mapping "${path}": no such file or directory` };
  }
  if (statSync(path).isDirectory()) {
    let name: string;
    try {
      name = (JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as { name: string })
        .name;
    } catch (error) {
      return {
        ok: false,
        message: `mapping package "${path}" has no readable manifest.json: ${String(error)}`,
      };
    }
    const trustStore = buildTrustStore(keysDir ?? join(path, 'keys'));
    const result = loadProviderPackage(path, { trustStore, allowlist: [name] });
    if (!result.ok) {
      return {
        ok: false,
        message: `provider package refused:\n${result.refusals
          .map((refusal) => `  [${refusal.code}] ${refusal.message}`)
          .join('\n')}`,
      };
    }
    const artifact = result.pkg.mappings[0]?.artifact;
    if (artifact === undefined) {
      return { ok: false, message: `provider package "${path}" ships no mapping artifact` };
    }
    return { ok: true, artifact };
  }
  const validation = validateMappingArtifact(parse(readFileSync(path, 'utf8')));
  if (!validation.ok) {
    return {
      ok: false,
      message: `mapping "${path}" violates iap-mapping-v1.schema.json:\n  ${validation.errors.join('\n  ')}`,
    };
  }
  const defects = verifyMappingArtifact(validation.artifact);
  if (defects.length > 0) {
    return {
      ok: false,
      message: `mapping "${path}" fails coverage-tiling verification:\n${defects
        .map((defect) => `  [${defect.code}] ${defect.kind}: ${defect.message}`)
        .join('\n')}`,
    };
  }
  return { ok: true, artifact: validation.artifact };
}

export function writeDiagnostics(io: CliIO, diagnostics: MappingDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    io.stderr.write(`${diagnostic.reason}  ${diagnostic.message}\n`);
  }
  io.stderr.write(
    `${diagnostics.length} mapping diagnostic(s) — nothing outside the coverage matrix is ever silently dropped (ch. 12 §12.3)\n`,
  );
}

export type LoadedProviderPlan =
  | { ok: true; plan: ProviderPlan; documentName: string; profile: string | null }
  | { ok: false; code: number };

/**
 * Load the target document and apply `--mapping`, returning the resulting
 * `ProviderPlan`. Every refusal mirrors `iap plan` verbatim: a missing mapping
 * or unusable package/artifact is a usage error (exit 2); a non-conforming
 * document, a canonicalization error, or a mapping diagnostic is a findings
 * refusal (exit 1) — never a partial plan.
 */
export async function loadProviderPlan(
  args: ParsedArgs,
  io: CliIO,
  command: string,
): Promise<LoadedProviderPlan> {
  const mappingPath = stringFlag(args, 'mapping');
  if (mappingPath === undefined) {
    io.stderr.write(
      `iap ${command}: --mapping <provider-package-dir | artifact.iap-map.yaml> is required\n`,
    );
    return { ok: false, code: EXIT_USAGE };
  }

  const opened = await openWorkspace(args);
  if (!opened.ok) {
    io.stderr.write(`iap ${command}: ${opened.message}\n`);
    return { ok: false, code: opened.code };
  }
  const { ws, profile, file } = opened;

  // §22.1: --profile is REQUIRED whenever the document declares profiles.
  const declaredProfiles = Object.keys(
    (ws.document as { profiles?: Record<string, unknown> } | undefined)?.profiles ?? {},
  );
  if (profile === null && declaredProfiles.length > 0) {
    io.stderr.write(
      `iap ${command}: the document declares profiles (${declaredProfiles
        .sort()
        .join(
          ', ',
        )}) — --profile is required; an ambiguous merge is never guessed (ch. 22 §22.1)\n`,
    );
    return { ok: false, code: EXIT_USAGE };
  }

  // CP-4: refuse to act on a document that is not conforming (validation
  // phases 1–4 plus deny-gating policy findings, ch. 19 §19.6).
  const validation = ws.validate();
  const findings: Finding[] = [...validation.findings];
  if (ws.document !== undefined) findings.push(...ws.policies().findings);
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (ws.document === undefined || errors.length > 0) {
    io.stderr.write(`iap ${command}: refusing to act on a non-conforming document (CP-4):\n`);
    writeFindings(io.stderr, errors.length > 0 ? errors : findings);
    return { ok: false, code: EXIT_FINDINGS };
  }

  const canonical = ws.canonical();
  const canonicalErrors = canonical.findings.filter((finding) => finding.severity === 'error');
  if (canonicalErrors.length > 0) {
    io.stderr.write(`iap ${command}: canonicalization failed:\n`);
    writeFindings(io.stderr, canonicalErrors);
    return { ok: false, code: EXIT_FINDINGS };
  }

  const mapping = resolveMapping(mappingPath, stringFlag(args, 'keys'));
  if (!mapping.ok) {
    io.stderr.write(`iap ${command}: ${mapping.message}\n`);
    return { ok: false, code: EXIT_USAGE };
  }

  const mapped = applyMapping(canonical.model, mapping.artifact);
  if (!mapped.ok) {
    writeDiagnostics(io, mapped.diagnostics);
    return { ok: false, code: EXIT_FINDINGS };
  }

  const documentName =
    (ws.document as { metadata?: { name?: string } } | undefined)?.metadata?.name ?? file;
  return { ok: true, plan: mapped.plan, documentName, profile };
}
