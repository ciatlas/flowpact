import { join } from 'node:path';
import { createLogger, type Logger, type LogRecord } from '@ciatlas/core';
import { VERSION } from '@flowpact/lint';
import {
  type Connection,
  createConnection,
  DidChangeWatchedFilesNotification,
  type DocumentHighlight,
  DocumentHighlightKind,
  type Location,
  type LocationLink,
  type Position,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { pathToUri, toRange, uriToPath } from './convert';
import { hoverMarkdown, remoteBindingMarkdown } from './hover';
import { readSettings, type Settings } from './settings';
import { type Root, Workspace } from './workspace';

const HIGHLIGHT = {
  declaration: DocumentHighlightKind.Write,
  binding: DocumentHighlightKind.Write,
  read: DocumentHighlightKind.Read,
  needs: DocumentHighlightKind.Text,
  uses: DocumentHighlightKind.Text,
} as const;

/** Wires flowpact's analysis to a language-server connection and starts listening. */
export function startServer(connection: Connection): void {
  const documents = new TextDocuments(TextDocument);
  let settings: Settings = readSettings(undefined);
  let logger = createLogger();
  let analysisLogger = createLogger();
  let workspace: Workspace | undefined;
  let linkSupport = false;
  let watchFiles = false;
  let folderEvents = false;

  const makeLogger = (level: Settings['logLevel']): Logger =>
    createLogger({
      level,
      sink: {
        write: (r: LogRecord) => {
          const line = `[${r.scope}] ${r.message}${r.data ? ` ${JSON.stringify(r.data)}` : ''}`;
          if (r.level === 'error') connection.console.error(line);
          else if (r.level === 'warn') connection.console.warn(line);
          else if (r.level === 'info') connection.console.info(line);
          // Not `log`: editors filter `debug` by the output's log level, while `log` lines always show.
          else connection.console.debug(line);
        },
      },
    });
  // Every analysis logs its stages; at the default level they would add lines on each edit, so only show them when
  // debugging.
  const setLevel = (level: Settings['logLevel']) => {
    logger = makeLogger(level);
    analysisLogger = makeLogger(level === 'debug' || level === 'trace' ? level : 'warn');
  };

  connection.onInitialize((params) => {
    settings = readSettings(params.initializationOptions);
    setLevel(settings.logLevel);
    linkSupport = params.capabilities.textDocument?.definition?.linkSupport === true;
    watchFiles = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    folderEvents = params.capabilities.workspace?.workspaceFolders === true;
    const folders = params.workspaceFolders?.length
      ? params.workspaceFolders.map((f) => uriToPath(f.uri))
      : [params.rootUri ? uriToPath(params.rootUri) : undefined];
    workspace = new Workspace(
      {
        documents: function* () {
          for (const doc of documents.all()) {
            const path = uriToPath(doc.uri);
            if (path) yield { path, text: doc.getText() };
          }
        },
        publish: (path, diagnostics) =>
          void connection.sendDiagnostics({ uri: pathToUri(path), diagnostics }),
        get logger() {
          return logger;
        },
        get analysisLogger() {
          return analysisLogger;
        },
      },
      settings,
      folders.filter((f): f is string => f !== undefined),
    );
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
      },
      serverInfo: { name: 'flowpact', version: VERSION },
    };
  });

  connection.onInitialized(() => {
    // Files changed outside the editor (a checkout, a pull) change the analysis too.
    if (watchFiles) {
      void connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [{ globPattern: '**/.github/**/*.{yml,yaml}' }, { globPattern: '**/action.{yml,yaml}' }],
      });
    }
    if (folderEvents) {
      connection.workspace.onDidChangeWorkspaceFolders((e) => {
        for (const f of e.removed) {
          const path = uriToPath(f.uri);
          if (path) workspace?.removeFolder(path);
        }
        for (const f of e.added) {
          const path = uriToPath(f.uri);
          if (path) workspace?.addFolder(path);
        }
      });
    }
    workspace?.start();
  });

  connection.onDidChangeConfiguration((params) => {
    const raw = (params.settings as { flowpact?: unknown } | null)?.flowpact ?? params.settings;
    settings = readSettings(raw, settings);
    setLevel(settings.logLevel);
    workspace?.configure(settings);
  });

  const changed = (uri: string) => {
    const path = uriToPath(uri);
    if (path) workspace?.changed(path);
  };
  documents.onDidChangeContent((e) => changed(e.document.uri));
  documents.onDidClose((e) => changed(e.document.uri));
  connection.onDidChangeWatchedFiles((params) => {
    for (const c of params.changes) changed(c.uri);
  });

  const locate = async (uri: string, position: Position) => {
    const path = uriToPath(uri);
    return path ? workspace?.locate(path, position.line + 1, position.character + 1) : undefined;
  };
  const location = (root: Root, loc: Parameters<typeof toRange>[0] & { file: string }): Location => ({
    uri: pathToUri(join(root.dir, loc.file)),
    range: toRange(loc),
  });

  /** Every occurrence of the found symbol; a remote call's key is one the locator does not know. */
  const occurrencesOf = (found: NonNullable<Awaited<ReturnType<typeof locate>>>) =>
    found.remote
      ? found.root.remotes!.occurrences(found.at.symbol)
      : found.root.locator!.occurrences(found.at.symbol);

  connection.onHover(async ({ textDocument, position }) => {
    const found = await locate(textDocument.uri, position);
    if (!found?.root.locator) return null;
    const { root, at, remote } = found;
    const value = remote
      ? remoteBindingMarkdown(remote, occurrencesOf(found).length)
      : hoverMarkdown(root.locator!, at, root.result?.remotes);
    return { contents: { kind: 'markdown', value }, range: toRange(at.loc) };
  });

  connection.onDefinition(async ({ textDocument, position }): Promise<Location[] | LocationLink[] | null> => {
    const found = await locate(textDocument.uri, position);
    if (!found?.root.locator) return null;
    const { root, at } = found;
    const decls = root.locator!.declarations(at.symbol);
    if (!linkSupport) return decls.map((d) => location(root, d.loc));
    return decls.map((d) => ({
      originSelectionRange: toRange(at.loc),
      targetUri: pathToUri(join(root.dir, d.loc.file)),
      targetRange: toRange(d.loc),
      targetSelectionRange: toRange(d.loc),
    }));
  });

  connection.onReferences(async ({ textDocument, position, context }) => {
    const found = await locate(textDocument.uri, position);
    if (!found?.root.locator) return null;
    return occurrencesOf(found)
      .filter((o) => context.includeDeclaration || o.role !== 'declaration')
      .map((o) => location(found.root, o.loc));
  });

  connection.onDocumentHighlight(async ({ textDocument, position }): Promise<DocumentHighlight[] | null> => {
    const found = await locate(textDocument.uri, position);
    if (!found?.root.locator) return null;
    return occurrencesOf(found)
      .filter((o) => o.loc.file === found.at.loc.file)
      .map((o) => ({ range: toRange(o.loc), kind: HIGHLIGHT[o.role] }));
  });

  // Lets tests (and clients that want to) wait until every pending edit is analyzed.
  connection.onRequest('flowpact/settled', async () => {
    await workspace?.settled();
    return null;
  });

  documents.listen(connection);
  connection.listen();
}

const TRANSPORT_FLAGS = /^--(stdio|node-ipc|socket|pipe)(=|$)/;

/**
 * Starts the server on the transport named on the command line (`--stdio`, `--node-ipc`, `--socket <port>`,
 * `--pipe <name>`, also with `=`), or on stdin/stdout when none is named.
 */
export function startLanguageServer(argv: string[] = process.argv): Connection {
  const connection = argv.some((a) => TRANSPORT_FLAGS.test(a))
    ? createConnection(ProposedFeatures.all)
    : createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  startServer(connection);
  return connection;
}
