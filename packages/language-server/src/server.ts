import { join } from 'node:path';
import { createLogger, type Logger, type LogRecord } from '@ciatlas/core';
import { type Finding, overrideFor, remotesCacheDir, VERSION } from '@flowpact/lint';
import {
  type CodeAction,
  CodeActionKind,
  type Connection,
  createConnection,
  type Diagnostic,
  DidChangeWatchedFilesNotification,
  type DocumentHighlight,
  DocumentHighlightKind,
  type InitializeParams,
  type Location,
  type LocationLink,
  type Position,
  ProposedFeatures,
  type Range,
  TextDocumentSyncKind,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  ACCEPT_COMMAND,
  type AcceptArgs,
  acceptAction,
  acceptEdit,
  type FileOps,
  regenerateAction,
  suggestionActions,
} from './actions';
import { pathToUri, toRange, uriToPath } from './convert';
import { hoverMarkdown, remoteBindingMarkdown } from './hover';
import { readSettings, type Settings } from './settings';
import { RemoteSources, remoteTarget, type SourceTarget } from './sources';
import { type Root, Workspace } from './workspace';

const HIGHLIGHT = {
  declaration: DocumentHighlightKind.Write,
  binding: DocumentHighlightKind.Write,
  read: DocumentHighlightKind.Read,
  needs: DocumentHighlightKind.Text,
  uses: DocumentHighlightKind.Text,
} as const;

/** What a client can do in a workspace edit, from the resource operations it lists (none without `documentChanges`). */
function fileOpsOf(operations: string[] | undefined): FileOps {
  return {
    documentChanges: operations !== undefined,
    create: operations?.includes('create') === true,
    delete: operations?.includes('delete') === true,
  };
}

/** What the client can do: from its capabilities, and the options VS Code's extension sends. */
function clientFeatures(params: InitializeParams) {
  const { textDocument, workspace } = params.capabilities;
  const edits = workspace?.workspaceEdit;
  return {
    linkSupport: textDocument?.definition?.linkSupport === true,
    /** The files it can create and delete in a workspace edit: a new config file, contract files. */
    fileOps: fileOpsOf(edits?.documentChanges === true ? (edits.resourceOperations ?? []) : undefined),
    /** It asks for an override's reason itself, so "Accept" runs its command. */
    promptForReason:
      (params.initializationOptions as { acceptFindingPrompt?: unknown } | undefined)?.acceptFindingPrompt ===
      true,
    watchFiles: workspace?.didChangeWatchedFiles?.dynamicRegistration === true,
    folderEvents: workspace?.workspaceFolders === true,
  };
}

/** Wires flowpact's analysis to a language-server connection and starts listening. */
export function startServer(connection: Connection): void {
  const documents = new TextDocuments(TextDocument);
  let settings: Settings = readSettings(undefined);
  let logger = createLogger();
  let analysisLogger = createLogger();
  let workspace: Workspace | undefined;
  /** The remote sources cache: the client's `cacheDir` setting, else `FLOWPACT_CACHE_DIR`, else the per-user cache. */
  const sourcesFor = (s: Settings) =>
    new RemoteSources(s.cacheDir ? join(s.cacheDir, 'remotes') : remotesCacheDir());
  let sources = sourcesFor(settings);
  let linkSupport = false;
  /** The files the client can create and delete in a workspace edit. */
  let fileOps: FileOps = { documentChanges: false, create: false, delete: false };
  /** The client asks for an override's reason itself (VS Code's extension), so "Accept" runs its command. */
  let promptForReason = false;
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
    sources = sourcesFor(settings);
    setLevel(settings.logLevel);
    ({ linkSupport, fileOps, promptForReason, watchFiles, folderEvents } = clientFeatures(params));
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
      () => sources,
    );
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
        executeCommandProvider: { commands: [ACCEPT_COMMAND] },
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
    const before = settings.cacheDir;
    settings = readSettings(raw, settings);
    if (settings.cacheDir !== before) sources = sourcesFor(settings);
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
    const lock = root.result?.remotes;
    const value = remote
      ? remoteBindingMarkdown(remote, occurrencesOf(found).length, sources.of(lock?.lock, remote.ref))
      : hoverMarkdown(root.locator!, at, { ...(lock ? { lock } : {}), sources, webHost: root.webHost });
    return { contents: { kind: 'markdown', value }, range: toRange(at.loc) };
  });

  /** Go to Definition into the cached source of a remote reference: the file, or the declaration in it. */
  const toSource = (target: SourceTarget, origin: Range): Location | LocationLink => {
    const uri = pathToUri(target.path);
    const range = target.loc
      ? toRange(target.loc)
      : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    return linkSupport
      ? { originSelectionRange: origin, targetUri: uri, targetRange: range, targetSelectionRange: range }
      : { uri, range };
  };

  connection.onDefinition(async ({ textDocument, position }): Promise<Location[] | LocationLink[] | null> => {
    const found = await locate(textDocument.uri, position);
    if (!found?.root.locator) return null;
    const { root, at } = found;
    const target = remoteTarget(root.locator!, root.result?.remotes?.lock, sources, at, found.remote);
    if (target) return [toSource(target, toRange(at.loc))] as Location[] | LocationLink[];
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

  /** The finding a flowpact diagnostic was made from, by the fingerprint it carries. */
  const findingOf = (findings: Finding[], d: Diagnostic) =>
    d.source === 'flowpact'
      ? findings.find((f) => f.fingerprint === (d.data as { fingerprint?: string } | undefined)?.fingerprint)
      : undefined;

  connection.onCodeAction(async ({ textDocument, context }) => {
    const path = uriToPath(textDocument.uri);
    const found = path ? await workspace?.findingsOf(path) : undefined;
    if (!found || !workspace) return null;
    const config = workspace.configOf(found.root);
    const actions: CodeAction[] = [];
    for (const d of context.diagnostics) {
      const f = findingOf(found.findings, d);
      if (!f) continue;
      actions.push(...suggestionActions(found.root.dir, f, d));
      const accept = acceptAction(f, d, textDocument.uri, {
        prompt: promptForReason,
        canCreate: fileOps.create,
        config,
      });
      if (accept) actions.push(accept);
      const regenerate = regenerateAction(found.root.dir, found.root.result?.contracts, d, fileOps, (p) =>
        workspace?.textOf(p),
      );
      if (regenerate) actions.push(regenerate);
    }
    return actions;
  });

  /** Adds the override for a finding, with the reason (and the expiry) the client asked for. */
  const acceptFinding = async ({ uri, fingerprint, reason, expires }: AcceptArgs): Promise<void> => {
    const path = uriToPath(uri);
    const found = path && reason ? await workspace?.findingsOf(path) : undefined;
    const f = found?.findings.find((x) => x.fingerprint === fingerprint);
    if (!workspace || !found || !f || !reason) return;
    const config = workspace.configOf(found.root);
    const edit = acceptEdit(config.path, config.text, overrideFor(f, reason, expires), fileOps.create);
    if (edit) await connection.workspace.applyEdit({ label: `Accept ${f.code}`, edit });
    else
      connection.window.showWarningMessage(
        `flowpact could not add the override to ${config.path}: add it under \`overrides:\` by hand.`,
      );
  };

  connection.onExecuteCommand(async ({ command, arguments: args }) => {
    if (command === ACCEPT_COMMAND) await acceptFinding((args?.[0] ?? {}) as AcceptArgs);
    return null;
  });

  // The remote sources cache, so the client can open its files read-only.
  connection.onRequest('flowpact/sourcesDir', () => sources.dir ?? null);

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
