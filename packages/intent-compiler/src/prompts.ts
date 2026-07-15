/**
 * The prompt registry (M3.4, roadmap §3.6 prompt versioning): versioned
 * prompt ARTIFACTS — data files under `../prompts/`, each pinned by a
 * SHA-256 content hash in the manifest below. Adapters reference prompts by
 * exact `id` + `version`; there is deliberately NO "latest" lookup — a
 * floating version inside a deterministic path would make replayed batches
 * unattributable to the prompt that produced them (OP-2 audit trail:
 * envelope `provenance.promptVersion`).
 *
 * Lookups fail closed: an unknown id/version throws, and a body whose
 * recomputed hash differs from the pinned hash throws (a tampered or
 * reformatted artifact must never silently reach an adapter). The prompt
 * files are byte-pinned and excluded from reformatting for exactly this
 * reason.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** One versioned prompt artifact, resolved and hash-verified. */
export interface PromptArtifact {
  id: string;
  version: string;
  description: string;
  /** The prompt body (verbatim file bytes as UTF-8 text). */
  body: string;
  /** SHA-256 hex of the body bytes (matches the pinned manifest hash). */
  contentHash: string;
}

/** Registry entry metadata (no body). */
export interface PromptRegistryEntry {
  id: string;
  version: string;
  description: string;
  contentHash: string;
}

interface ManifestEntry extends PromptRegistryEntry {
  file: string;
}

/** The pinned manifest: id@version → file + expected content hash. */
const PROMPT_MANIFEST: readonly ManifestEntry[] = [
  {
    id: 'extract-facets',
    version: '1',
    description:
      'Facet extraction instructions for out-of-tree LLM adapters: closed facet vocabulary, unparsed/unsupported reporting duties, never-guess rules (ch. 19 §19.7)',
    file: 'extract-facets.v1.md',
    contentHash: '23740e5d9d99f355ccec2f9264a80cb39c2a66e99dd5897129cffc9d421e91b4',
  },
  {
    id: 'repair-extraction',
    version: '1',
    description:
      'Bounded repair instructions used on structured-output retry: fix only the identified issues, never substitute guesses, never drop unparsed/unsupported records',
    file: 'repair-extraction.v1.md',
    contentHash: '9a0cda9a4f6a04daa3d0f03b9fb724a6b1bddd8318657b2a3ebce101651061a7',
  },
];

const cache = new Map<string, PromptArtifact>();

/** Enumerate the registry (metadata only, deterministic order). */
export function promptRegistry(): PromptRegistryEntry[] {
  return PROMPT_MANIFEST.map(({ id, version, description, contentHash }) => ({
    id,
    version,
    description,
    contentHash,
  }));
}

/**
 * Resolve one prompt artifact by EXACT id and version. Throws for an unknown
 * id/version and for any hash mismatch between the file bytes and the pinned
 * manifest hash (fail closed — no floating versions, no silent edits).
 */
export function getPrompt(id: string, version: string): PromptArtifact {
  const key = `${id}@${version}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const entry = PROMPT_MANIFEST.find(
    (candidate) => candidate.id === id && candidate.version === version,
  );
  if (entry === undefined) {
    throw new TypeError(
      `unknown prompt "${key}" — the registry is exact-version only (no "latest"); known: ${PROMPT_MANIFEST.map(
        (candidate) => `${candidate.id}@${candidate.version}`,
      ).join(', ')}`,
    );
  }
  const body = readFileSync(new URL(`../prompts/${entry.file}`, import.meta.url), 'utf8');
  const contentHash = createHash('sha256').update(body, 'utf8').digest('hex');
  if (contentHash !== entry.contentHash) {
    throw new TypeError(
      `prompt "${key}" content hash mismatch: expected ${entry.contentHash}, found ${contentHash} — the artifact was modified without a version bump`,
    );
  }
  const artifact: PromptArtifact = {
    id: entry.id,
    version: entry.version,
    description: entry.description,
    body,
    contentHash,
  };
  cache.set(key, artifact);
  return artifact;
}
