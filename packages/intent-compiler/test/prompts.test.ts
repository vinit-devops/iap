/**
 * M3.4 prompt registry: versioned prompt artifacts with pinned SHA-256
 * content hashes, exact-version lookup only — no floating "latest" exists in
 * any deterministic path.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getPrompt, promptRegistry } from '../src/index';

describe('prompt registry', () => {
  it('ships the extraction and repair prompts at version 1', () => {
    const entries = promptRegistry().map((entry) => `${entry.id}@${entry.version}`);
    expect(entries).toEqual(['extract-facets@1', 'repair-extraction@1']);
  });

  it('lookups are exact-version: unknown ids, versions, and "latest" all fail closed', () => {
    expect(() => getPrompt('extract-facets', 'latest')).toThrow(/exact-version only/);
    expect(() => getPrompt('extract-facets', '2')).toThrow(TypeError);
    expect(() => getPrompt('ghost-prompt', '1')).toThrow(TypeError);
  });

  it('resolved artifacts carry the body and a verified content hash', () => {
    const artifact = getPrompt('extract-facets', '1');
    expect(artifact.body.length).toBeGreaterThan(500);
    expect(artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const recomputed = createHash('sha256').update(artifact.body, 'utf8').digest('hex');
    expect(recomputed).toBe(artifact.contentHash);
    const pinned = promptRegistry().find((entry) => entry.id === 'extract-facets');
    expect(pinned?.contentHash).toBe(artifact.contentHash);
  });

  it('the registry is deterministic across calls', () => {
    expect(JSON.stringify(promptRegistry())).toBe(JSON.stringify(promptRegistry()));
    expect(getPrompt('repair-extraction', '1')).toBe(getPrompt('repair-extraction', '1'));
  });

  it('the extraction prompt encodes the never-guess and closed-vocabulary duties (ch. 19 §19.7)', () => {
    const artifact = getPrompt('extract-facets', '1');
    expect(artifact.body).toContain('Never invent kinds');
    expect(artifact.body).toContain('unsupported');
    expect(artifact.body).toContain('unparsed');
    expect(artifact.body).toContain('never write');
  });

  it('the repair prompt forbids trading honesty for validity', () => {
    const artifact = getPrompt('repair-extraction', '1');
    expect(artifact.body).toContain('Never delete');
    expect(artifact.body).toContain('bounded');
  });
});
