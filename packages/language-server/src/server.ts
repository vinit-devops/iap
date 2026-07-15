/**
 * The thin LSP binding over the pure provider core (`./providers.js`).
 *
 * This module contains protocol plumbing ONLY (ch. 23 §23.1): connection
 * setup, capability announcement, request routing, and the mapping between
 * the providers' protocol-neutral shapes and LSP structures. No feature
 * logic lives here — everything computable is computed in `providers.ts`,
 * which is what the test suite exercises without a connection.
 *
 * Performance contract (ch. 23 §23.4): diagnostics are debounced 150 ms per
 * document; a validation pass is dropped when a newer document version
 * supersedes it before or during computation, so diagnostics computed from a
 * stale version are never published.
 */

import {
  CodeActionKind,
  CompletionItemKind,
  DiagnosticSeverity,
  ErrorCodes,
  ProposedFeatures,
  ResponseError,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
} from 'vscode-languageserver/node.js';
import type {
  CodeAction as LspCodeAction,
  CompletionItem as LspCompletionItem,
  Diagnostic as LspDiagnostic,
  DocumentSymbol as LspDocumentSymbol,
  Range as LspRange,
  TextEdit as LspTextEdit,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  PREVIEW_VIEWS,
  computeCanonicalPreview,
  computeCodeActions,
  computeCompletions,
  computeDefinition,
  computeDiagnostics,
  computeHover,
  computePreview,
  computeReferences,
  computeRename,
  computeSymbols,
} from './providers.js';
import type { CompletionItem, Diagnostic, DocumentSymbol, Range, TextEdit } from './providers.js';
import type { ViewName } from '@iap/architecture';

/** Debounce interval for diagnostics publication (ch. 23 §23.4). */
export const DIAGNOSTICS_DEBOUNCE_MS = 150;

/** Parameters of the custom `iap/preview` request (ch. 23 §23.2.9). */
export interface PreviewParams {
  uri: string;
  view: ViewName;
  application?: string;
}

/** Parameters of the custom `iap/canonical` request (canonical projection preview). */
export interface CanonicalParams {
  uri: string;
}

/* ------------------------------------------------------------------ */
/* Provider-shape → LSP-shape mapping                                  */
/* ------------------------------------------------------------------ */

function toLspRange(range: Range): LspRange {
  return range; // identical shape: 0-based {line, character}
}

function toLspDiagnostic(diagnostic: Diagnostic): LspDiagnostic {
  return {
    range: toLspRange(diagnostic.range),
    severity:
      diagnostic.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    code: diagnostic.code,
    message: diagnostic.message,
    source: diagnostic.source,
  };
}

const COMPLETION_KIND = {
  value: CompletionItemKind.EnumMember,
  property: CompletionItemKind.Property,
  reference: CompletionItemKind.Reference,
} as const;

function toLspCompletionItem(item: CompletionItem): LspCompletionItem {
  const mapped: LspCompletionItem = { label: item.label, kind: COMPLETION_KIND[item.kind] };
  if (item.detail !== undefined) mapped.detail = item.detail;
  if (item.documentation !== undefined) {
    mapped.documentation = { kind: 'markdown', value: item.documentation };
  }
  if (item.sortText !== undefined) mapped.sortText = item.sortText;
  return mapped;
}

const SYMBOL_KIND = {
  group: SymbolKind.Namespace,
  resource: SymbolKind.Object,
  profile: SymbolKind.Module,
  policy: SymbolKind.Key,
  output: SymbolKind.Variable,
} as const;

function toLspSymbol(symbol: DocumentSymbol): LspDocumentSymbol {
  const mapped: LspDocumentSymbol = {
    name: symbol.name,
    kind: SYMBOL_KIND[symbol.kind],
    range: toLspRange(symbol.range),
    selectionRange: toLspRange(symbol.selectionRange),
  };
  if (symbol.detail !== undefined) mapped.detail = symbol.detail;
  if (symbol.children !== undefined) mapped.children = symbol.children.map(toLspSymbol);
  return mapped;
}

function toLspEdits(edits: TextEdit[]): LspTextEdit[] {
  return edits.map((edit) => ({ range: toLspRange(edit.range), newText: edit.newText }));
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

/**
 * Create the connection over stdio, wire every capability to its provider,
 * and start listening. Used by the `iap-language-server` bin entry.
 */
export function startServer(): void {
  const connection = createConnection(ProposedFeatures.all);
  const documents = new TextDocuments(TextDocument);
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  connection.onInitialize(() => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: [':', ' ', '-'] },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: true,
      documentSymbolProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
    },
  }));

  const publishDiagnostics = async (uri: string, version: number): Promise<void> => {
    const document = documents.get(uri);
    if (document === undefined || document.version !== version) return; // superseded before start
    const diagnostics = await computeDiagnostics(document.getText());
    const current = documents.get(uri);
    if (current === undefined || current.version !== version) return; // superseded mid-computation
    void connection.sendDiagnostics({
      uri,
      version,
      diagnostics: diagnostics.map(toLspDiagnostic),
    });
  };

  const scheduleDiagnostics = (document: TextDocument): void => {
    const existing = debounceTimers.get(document.uri);
    if (existing !== undefined) clearTimeout(existing);
    const version = document.version;
    debounceTimers.set(
      document.uri,
      setTimeout(() => {
        debounceTimers.delete(document.uri);
        void publishDiagnostics(document.uri, version);
      }, DIAGNOSTICS_DEBOUNCE_MS),
    );
  };

  documents.onDidOpen((event) => scheduleDiagnostics(event.document));
  documents.onDidChangeContent((event) => scheduleDiagnostics(event.document));
  documents.onDidClose((event) => {
    const timer = debounceTimers.get(event.document.uri);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.delete(event.document.uri);
    void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  connection.onCompletion(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return [];
    const items = await computeCompletions(document.getText(), params.position);
    return items.map(toLspCompletionItem);
  });

  connection.onHover(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return null;
    const hover = await computeHover(document.getText(), params.position);
    if (hover === undefined) return null;
    return {
      contents: { kind: 'markdown' as const, value: hover.contents },
      ...(hover.range !== undefined ? { range: toLspRange(hover.range) } : {}),
    };
  });

  connection.onDefinition(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return null;
    const definition = await computeDefinition(document.getText(), params.position);
    if (definition === undefined) return null;
    return { uri: params.textDocument.uri, range: toLspRange(definition.range) };
  });

  connection.onReferences(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return [];
    const references = await computeReferences(document.getText(), params.position);
    return references.map((reference) => ({
      uri: params.textDocument.uri,
      range: toLspRange(reference.range),
    }));
  });

  connection.onRenameRequest(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return null;
    const result = await computeRename(document.getText(), params.position, params.newName);
    if ('error' in result) {
      throw new ResponseError(ErrorCodes.InvalidParams, result.error);
    }
    return { changes: { [params.textDocument.uri]: toLspEdits(result.edits) } };
  });

  connection.onDocumentSymbol(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return [];
    const symbols = await computeSymbols(document.getText());
    return symbols.map(toLspSymbol);
  });

  connection.onCodeAction(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document === undefined) return [];
    const actions = await computeCodeActions(document.getText(), params.range);
    return actions.map((action): LspCodeAction => ({
      title: action.title,
      kind: CodeActionKind.QuickFix,
      edit: { changes: { [params.textDocument.uri]: toLspEdits(action.edits) } },
    }));
  });

  // Custom protocol extension (ch. 23 §23.2.9): live architecture preview.
  // Clients that do not know the request simply never send it.
  connection.onRequest('iap/preview', async (params: PreviewParams) => {
    const document = documents.get(params.uri);
    if (document === undefined) {
      throw new ResponseError(ErrorCodes.InvalidParams, `unknown document: ${params.uri}`);
    }
    if (!PREVIEW_VIEWS.includes(params.view)) {
      throw new ResponseError(
        ErrorCodes.InvalidParams,
        `unknown view "${String(params.view)}" — expected one of ${PREVIEW_VIEWS.join(', ')}`,
      );
    }
    try {
      return await computePreview(document.getText(), params.view, params.application);
    } catch (error) {
      throw new ResponseError(
        ErrorCodes.InvalidRequest,
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  // Custom protocol extension: canonical projection preview (`iap normalize` parity).
  connection.onRequest('iap/canonical', async (params: CanonicalParams) => {
    const document = documents.get(params.uri);
    if (document === undefined) {
      throw new ResponseError(ErrorCodes.InvalidParams, `unknown document: ${params.uri}`);
    }
    try {
      return await computeCanonicalPreview(document.getText());
    } catch (error) {
      throw new ResponseError(
        ErrorCodes.InvalidRequest,
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  documents.listen(connection);
  connection.listen();
}
