'use strict';

/**
 * IaP VS Code extension entry (Phase 19, M19.4, artifact 3).
 *
 * Runtime dependencies are resolved at load time by the VS Code host:
 *   - `vscode`               — always provided by the host.
 *   - `vscode-languageclient` — OPTIONAL. When it is bundled/installed the
 *     extension starts the IaP language server as an LSP client (diagnostics,
 *     completion, hover, navigation, rename, code actions, architecture
 *     preview). When it is ABSENT the extension degrades gracefully: the `iap`
 *     language (grammar registration, bracket/comment editing) still works,
 *     the LSP features are simply unavailable and a one-time notice is shown.
 *
 * This module is intentionally plain CommonJS and does NOT depend on
 * `@types/vscode`, so it lints/formats cleanly with the repo toolchain and
 * requires no external types to ship.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscode = require('vscode');
// Node built-ins (available in the VS Code extension host).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('node:fs');

/** @type {any} The running language client, when the LSP layer is available. */
let client;

/**
 * Best-effort load of `vscode-languageclient`. Returns the module or
 * `undefined` when it is not present (offline / not bundled).
 * @returns {any}
 */
function tryLoadLanguageClient() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('vscode-languageclient/node');
  } catch {
    return undefined;
  }
}

/**
 * Resolve the path to the `iap-language-server` executable.
 * Order: bundled server (shipped inside the .vsix) → explicit setting →
 * resolved @iap/language-server bin → bare name (relies on PATH). Returns the
 * resolved path (a `.js` path is launched as `node <path> --stdio`).
 *
 * The bundled server is preferred FIRST so a clean install needs NO
 * `iap.languageServer.path` setting and NO globally installed package: the
 * self-contained `server/server.js` (bundled alongside this file) provides the
 * full LSP experience out of the box.
 * @returns {string}
 */
function resolveServerPath() {
  // 1. Bundled, self-contained server shipped next to this file in the .vsix.
  const bundledServer = path.join(__dirname, 'server', 'server.js');
  if (fs.existsSync(bundledServer)) {
    return bundledServer;
  }
  // 2. Explicit user override.
  const configured = vscode.workspace.getConfiguration('iap').get('languageServer.path');
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim();
  }
  // 3. Attempt to resolve the installed @iap/language-server bin.
  try {
    const pkgJson = require.resolve('@iap/language-server/package.json');
    const pkgDir = path.dirname(pkgJson);
    // package.json bin: iap-language-server -> ./dist/main.js
    const binTarget = path.join(pkgDir, 'dist', 'main.js');
    if (fs.existsSync(binTarget)) {
      return binTarget;
    }
  } catch {
    // fall through
  }
  // Last resort: rely on a globally installed bin on PATH.
  return 'iap-language-server';
}

/**
 * Build LanguageClient constructor arguments for the resolved server.
 * @param {any} lc The vscode-languageclient/node module.
 * @returns {any}
 */
function makeClient(lc) {
  const serverPath = resolveServerPath();
  const runsAsScript = serverPath.endsWith('.js');
  /** @type {any} */
  const serverOptions = runsAsScript
    ? {
        run: { module: serverPath, transport: lc.TransportKind.stdio },
        debug: { module: serverPath, transport: lc.TransportKind.stdio },
      }
    : {
        run: { command: serverPath, transport: lc.TransportKind.stdio },
        debug: { command: serverPath, transport: lc.TransportKind.stdio },
      };

  /** @type {any} */
  const clientOptions = {
    documentSelector: [{ scheme: 'file', language: 'iap' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{iap.yaml,iap.yml,iap-map.yaml}'),
    },
  };

  return new lc.LanguageClient('iap', 'IaP Language Server', serverOptions, clientOptions);
}

/**
 * Start (or restart) the language client if the LSP layer is available.
 * @returns {Promise<boolean>} true when a client was started.
 */
async function startClient() {
  const lc = tryLoadLanguageClient();
  if (lc === undefined) {
    return false;
  }
  if (client !== undefined) {
    try {
      await client.stop();
    } catch {
      // ignore
    }
    client = undefined;
  }
  client = makeClient(lc);
  await client.start();
  return true;
}

/**
 * VS Code entry point.
 * @param {any} context The extension context.
 */
async function activate(context) {
  // Command: restart the language server.
  context.subscriptions.push(
    vscode.commands.registerCommand('iap.restartServer', async () => {
      const started = await startClient();
      if (started) {
        vscode.window.showInformationMessage('IaP language server restarted.');
      } else {
        vscode.window.showWarningMessage(
          'IaP: vscode-languageclient is not available; cannot start the language server.',
        );
      }
    }),
  );

  // Command: architecture preview via the server's custom `iap/preview` request.
  context.subscriptions.push(
    vscode.commands.registerCommand('iap.showPreview', async () => {
      if (client === undefined) {
        vscode.window.showWarningMessage(
          'IaP: language server is not running; architecture preview is unavailable.',
        );
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined || editor.document.languageId !== 'iap') {
        vscode.window.showWarningMessage('IaP: open an .iap.yaml document to preview it.');
        return;
      }
      try {
        const result = await client.sendRequest('iap/preview', {
          uri: editor.document.uri.toString(),
          view: 'architecture',
        });
        const panel = vscode.window.createWebviewPanel(
          'iapPreview',
          'IaP Architecture Preview',
          vscode.ViewColumn.Beside,
          {},
        );
        panel.webview.html = `<!doctype html><html><body><pre>${escapeHtml(
          JSON.stringify(result, null, 2),
        )}</pre></body></html>`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`IaP preview failed: ${message}`);
      }
    }),
  );

  const started = await startClient();
  if (!started) {
    // Degrade gracefully: language registration still applies.
    vscode.window.showInformationMessage(
      'IaP: language registered. Install/bundle "vscode-languageclient" to enable diagnostics, completion and hover.',
    );
  }
}

/**
 * Escape HTML for safe embedding in the preview webview.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * VS Code teardown.
 * @returns {Promise<void> | undefined}
 */
function deactivate() {
  if (client === undefined) {
    return undefined;
  }
  return client.stop();
}

module.exports = { activate, deactivate };
