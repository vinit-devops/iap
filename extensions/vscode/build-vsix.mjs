/**
 * build-vsix.mjs — assemble an installable VS Code extension package
 * (`.vsix`) for the IaP extension WITHOUT `vsce` (Phase 19, M19.4, artifact 3).
 *
 * A `.vsix` is an OPC (Open Packaging Conventions) ZIP. `code --install-extension`
 * expects, at the archive root:
 *   - `[Content_Types].xml`     — OPC content-type map.
 *   - `extension.vsixmanifest`  — the VSIX 2.0 PackageManifest.
 *   - `extension/…`             — the extension payload (package.json, entry,
 *                                 language config, README, assets).
 *
 * We stage that tree in a build dir and zip it with the system `zip` CLI
 * (present on macOS/Linux). No network, no vsce, no external npm deps.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(extRoot, 'package.json'), 'utf8'));
const { name, version, publisher, displayName, description } = manifest;

const distDir = join(extRoot, 'dist');
const buildDir = join(distDir, 'build');
const payloadDir = join(buildDir, 'extension');
const vsixPath = join(distDir, `${name}-${version}.vsix`);

function log(msg) {
  process.stdout.write(`[build-vsix] ${msg}\n`);
}

/* 0. Produce the self-contained bundles the payload ships:
 *    - server/server.js + server/schemas/ + server/package.json (the LSP server)
 *    - extension.bundled.js (the extension entry with vscode-languageclient inlined)
 *    Both are prerequisites; build them fresh so the .vsix is never stale. */
log('bundling language server …');
execFileSync('node', [join(extRoot, 'build-server.mjs')], { stdio: 'inherit' });
log('bundling extension …');
execFileSync('node', [join(extRoot, 'build-extension.mjs')], { stdio: 'inherit' });

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* 1. Clean + stage the payload (extension/…). */
rmSync(distDir, { recursive: true, force: true });
mkdirSync(payloadDir, { recursive: true });

/* PROD payload ONLY: the bundled entry, the bundled server tree, language
 * config, manifest, README, CHANGELOG, icon and LICENSE (marketplace listing
 * assets). The unbundled `extension.js`, `src`, tests, `node_modules`, and the
 * build scripts are deliberately EXCLUDED. */
const payloadFiles = [
  'package.json',
  'extension.bundled.js',
  'language-configuration.json',
  'README.md',
  'CHANGELOG.md',
  'icon.png',
];
for (const file of payloadFiles) {
  const src = join(extRoot, file);
  if (!existsSync(src)) {
    throw new Error(`missing payload file: ${file}`);
  }
  cpSync(src, join(payloadDir, file));
}

/* LICENSE comes from the repo root (single source of truth; Apache-2.0).
 * Staged as extension/LICENSE.txt — the name vsce uses and the marketplace
 * renders for the listing's license link. */
const licenseSrc = join(extRoot, '..', '..', 'LICENSE');
if (!existsSync(licenseSrc)) {
  throw new Error(`missing repo-root LICENSE: ${licenseSrc}`);
}
cpSync(licenseSrc, join(payloadDir, 'LICENSE.txt'));

/* The self-contained language server (server.js + schemas/ + package.json). */
const serverSrc = join(extRoot, 'server');
const serverEntry = join(serverSrc, 'server.js');
if (!existsSync(serverEntry)) {
  throw new Error(`missing bundled server: ${serverEntry} — run build-server.mjs`);
}
cpSync(serverSrc, join(payloadDir, 'server'), { recursive: true });
log(`staged ${payloadFiles.length} payload files + LICENSE.txt + server/ under extension/`);

/* 2. [Content_Types].xml at the archive root. */
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
`;
writeFileSync(join(buildDir, '[Content_Types].xml'), contentTypes);

/* 3. extension.vsixmanifest (VSIX 2.0 PackageManifest) at the archive root. */
const engineVscode = manifest.engines.vscode;
const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(name)}" Version="${xmlEscape(version)}" Publisher="${xmlEscape(publisher)}" />
    <DisplayName>${xmlEscape(displayName)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(description)}</Description>
    <Tags>iap,yaml,infrastructure,lsp,infrastructure-as-code,devops</Tags>
    <Categories>Programming Languages</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(engineVscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/vinit-devops/iap" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="https://github.com/vinit-devops/iap" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="https://github.com/vinit-devops/iap/issues" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="#1e293b" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="dark" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
`;
writeFileSync(join(buildDir, 'extension.vsixmanifest'), vsixManifest);
log('wrote [Content_Types].xml + extension.vsixmanifest');

/* 4. Zip the staged tree into the .vsix with the system `zip` CLI.
 *    -r recurse, -X strip extra attrs, -q quiet. Run from buildDir so entry
 *    paths are relative to the archive root (no leading build/ segment). */
try {
  execFileSync('zip', ['-r', '-X', '-q', vsixPath, '.'], { cwd: buildDir });
  log('zipped with system `zip`');
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  throw new Error(`system \`zip\` CLI is required to assemble the .vsix and failed: ${detail}`);
}

if (!existsSync(vsixPath)) {
  throw new Error('vsix was not produced');
}

/* 5. Report the entry list for visibility. */
const entries = execFileSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8' })
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .sort();

log(`built ${vsixPath}`);
log('entries:');
for (const entry of entries) {
  process.stdout.write(`  ${entry}\n`);
}

/* 6. Tidy the staging dir; keep only the .vsix in dist/. */
rmSync(buildDir, { recursive: true, force: true });
