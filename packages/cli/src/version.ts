/**
 * Package-version discovery. The CLI's own version comes from its
 * `package.json`; sibling workspace package versions are resolved through
 * Node's resolver (entry point → package root), so `iap doctor` reports the
 * versions actually loaded, not the ones assumed.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersion(packageJsonPath: string): string {
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
  return parsed.version ?? 'unknown';
}

let ownVersion: string | undefined;

/** The @iap/cli version (from the package's own package.json). */
export function cliVersion(): string {
  ownVersion ??= readVersion(fileURLToPath(new URL('../package.json', import.meta.url)));
  return ownVersion;
}

/** Version of a resolvable dependency (e.g. `@iap/sdk`), or `unknown`. */
export function dependencyVersion(specifier: string): string {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve(specifier); // …/<pkg>/dist/index.js
    return readVersion(join(dirname(entry), '..', 'package.json'));
  } catch {
    return 'unknown';
  }
}
