import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import * as vscode from 'vscode';
import {
  DidChangeConfigurationNotification,
  LanguageClient,
  type LanguageClientOptions,
  RevealOutputChannelOn,
  type ServerOptions,
  State,
  TransportKind,
} from 'vscode-languageclient/node';
import {
  type ExtensionSettings,
  hidesOverlapInOpenedFiles,
  isInside,
  serverSettings,
  withoutOverlap,
} from './settings';

const GITHUB_ACTIONS = 'GitHub.vscode-github-actions';

/**
 * Workflows, action metadata, and flowpact's config and contracts. Matched by path, not language: the GitHub Actions
 * extension gives workflows its own language id. `file` only, so the original side of a git diff is not analyzed.
 */
const SELECTOR = [
  { scheme: 'file', pattern: '**/.github/workflows/*.{yml,yaml}' },
  { scheme: 'file', pattern: '**/action.{yml,yaml}' },
  { scheme: 'file', pattern: '**/.github/flowpact/**/*.{yml,yaml}' },
];

/** At a workspace folder's root, these make the server worth starting; checked by path, without a search. */
const AT_ROOT = ['.github/workflows', 'action.yml', 'action.yaml'];
/**
 * The same anywhere in the workspace (nested repositories). VS Code gives up the search behind a `workspaceContains`
 * glob after 7 seconds and then does not activate at all, so the extension also activates after startup and runs this
 * search itself, in the background: a file search can stall while VS Code starts.
 */
const NESTED = ['**/.github/workflows/*.{yml,yaml}', '**/action.{yml,yaml}'];

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('flowpact', { log: true });
  const status = vscode.languages.createLanguageStatusItem('flowpact.status', SELECTOR);
  status.name = 'flowpact';
  status.text = 'flowpact';
  context.subscriptions.push(output, status);

  const read = (): ExtensionSettings => {
    const c = vscode.workspace.getConfiguration('flowpact');
    return {
      plugins: c.get('plugins', true),
      contracts: c.get('contracts', 'auto'),
      overlappingRules: c.get('overlappingRules', 'auto'),
      hiddenRules: c.get('hiddenRules', []),
      cacheDir: c.get('cacheDir', ''),
    };
  };
  const current = () =>
    serverSettings(read(), {
      trusted: vscode.workspace.isTrusted,
      logLevel: output.logLevel,
      home: homedir(),
    });
  const overlapHidden = () =>
    hidesOverlapInOpenedFiles(read(), {
      trusted: vscode.workspace.isTrusted,
      githubActions: vscode.extensions.getExtension(GITHUB_ACTIONS) !== undefined,
    });

  // FP502–FP505 are dropped from the files GitHub's extension validates: those opened in the editor. Its findings stay
  // after a file closes, so a file stays filtered once opened. The server's diagnostics are kept as sent, so opening a
  // file (or installing that extension) can filter them again.
  const sentDiagnostics = new Map<string, vscode.Diagnostic[]>();
  const opened = new Set<string>();
  const noteOpened = (d: vscode.TextDocument) => {
    if (vscode.languages.match(SELECTOR, d) > 0) opened.add(d.uri.toString());
  };
  vscode.workspace.textDocuments.forEach(noteOpened);
  let hiding = overlapHidden();
  const visible = (uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) =>
    hiding && opened.has(uri.toString()) ? withoutOverlap(diagnostics) : diagnostics;
  const refilter = (only?: vscode.Uri) => {
    const collection = client?.diagnostics;
    if (!collection) return;
    for (const [key, diagnostics] of sentDiagnostics) {
      if (only && only.toString() !== key) continue;
      const uri = vscode.Uri.parse(key);
      collection.set(uri, visible(uri, diagnostics));
    }
  };

  /** The settings the server has, so unchanged settings are not sent again. */
  let sent: string | undefined;
  const push = () => {
    if (overlapHidden() !== hiding) {
      hiding = !hiding;
      refilter();
    }
    if (client?.state !== State.Running) return;
    const settings = current();
    const json = JSON.stringify(settings);
    if (json === sent) return;
    const unloadPlugins =
      sent !== undefined && (JSON.parse(sent) as { plugins: boolean }).plugins && !settings.plugins;
    sent = json;
    // An imported plugin module stays loaded in the server; only a restart unloads it.
    if (unloadPlugins) {
      restart().catch((err: unknown) => output.error(`could not restart the server: ${String(err)}`));
      return;
    }
    const c = client;
    c.sendNotification(DidChangeConfigurationNotification.type, { settings: { flowpact: settings } })
      .then(() => askSourcesDir(c))
      .catch((err: unknown) => output.error(`could not send the settings: ${String(err)}`));
  };

  const showState = (state: State) => {
    status.busy = state === State.Starting;
    const failed = state === State.Stopped || state === State.StartFailed;
    status.severity = failed
      ? vscode.LanguageStatusSeverity.Error
      : vscode.LanguageStatusSeverity.Information;
    if (failed) {
      status.detail = 'stopped';
      status.command = { title: 'Restart', command: 'flowpact.restartServer' };
    } else if (!vscode.workspace.isTrusted) {
      status.detail = 'plugins off: workspace not trusted';
      status.command = { title: 'Manage Trust', command: 'workbench.trust.manage' };
    } else {
      status.detail = state === State.Starting ? 'starting' : undefined;
      status.command = { title: 'Show Output', command: 'flowpact.showOutput' };
    }
  };

  const module = context.asAbsolutePath(join('dist', 'server.mjs'));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: SELECTOR,
    outputChannel: output,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    progressOnInitialization: true,
    // Evaluated on every start, including restarts after a crash.
    initializationOptions: () => {
      const settings = current();
      sent = JSON.stringify(settings);
      return settings;
    },
    middleware: {
      handleDiagnostics: (uri, diagnostics, next) => {
        if (diagnostics.length) sentDiagnostics.set(uri.toString(), diagnostics);
        else sentDiagnostics.delete(uri.toString());
        next(uri, visible(uri, diagnostics));
      },
    },
  };
  // Go to Definition opens the sources of remote references from the server's cache: another repository's files at a
  // pinned commit, so they open read-only. The server says where its cache is.
  let sourcesDir: string | undefined;
  // Decided by the active tab, which the command marks: focusing a Peek or a side of a diff changes the active text
  // editor but not the tab, and must not mark the file that holds it.
  const readOnlyIfSource = () => {
    const path = activeTextTab();
    if (path && sourcesDir && isInside(sourcesDir, path, relative))
      void vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
  };
  const askSourcesDir = (c: LanguageClient) =>
    c.sendRequest<string | null>('flowpact/sourcesDir').then(
      (dir) => {
        sourcesDir = dir ?? undefined;
        readOnlyIfSource();
      },
      (err: unknown) => output.warn(`could not ask where remote sources are cached: ${String(err)}`),
    );

  const create = () => {
    const c = new LanguageClient('flowpact', 'flowpact', serverOptions, clientOptions);
    c.onDidChangeState(({ newState }) => {
      // Every start (a restart, or recovering from a crash) begins with an empty diagnostic collection.
      if (newState === State.Starting) sentDiagnostics.clear();
      showState(newState);
      if (newState === State.Running) {
        push();
        void askSourcesDir(c);
      }
    });
    return c;
  };
  let starting: Promise<void> | undefined;
  /** Starts the server once; later calls wait for that start. */
  const start = (): Promise<void> =>
    (starting ??= (async () => {
      client = create();
      await client.start();
    })());
  const startOrLog = () =>
    start().catch((err: unknown) => output.error(`could not start the server: ${String(err)}`));
  let restarting: Promise<void> | undefined;
  /** One restart at a time; a start in progress is waited out, so no second server is left running. */
  const restart = (): Promise<void> =>
    (restarting ??= (async () => {
      try {
        if (!client) return await start();
        if (client?.state === State.Starting) await client.start().catch(() => undefined);
        if (client?.state === State.Running) {
          await client.restart();
          return;
        }
        // After a failed start the client cannot start again; replace it.
        await client?.dispose().catch(() => undefined);
        client = create();
        await client.start();
      } finally {
        restarting = undefined;
      }
    })());

  context.subscriptions.push(
    vscode.commands.registerCommand('flowpact.restartServer', restart),
    vscode.commands.registerCommand('flowpact.showOutput', () => output.show()),
    vscode.window.onDidChangeActiveTextEditor(() => readOnlyIfSource()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flowpact')) push();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      push();
      if (client) showState(client.state);
    }),
    vscode.extensions.onDidChange(push),
    output.onDidChangeLogLevel(push),
    vscode.workspace.onDidOpenTextDocument((d) => {
      noteOpened(d);
      if (hiding) refilter(d.uri);
      if (!starting && vscode.languages.match(SELECTOR, d) > 0) startOrLog();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      if (!starting && ((await atRoot()) || (await nested()))) startOrLog();
    }),
  );

  // Also activated after startup in any workspace: start only where there are workflows or action metadata, or once
  // such a file is opened.
  if (
    vscode.workspace.textDocuments.some((d) => vscode.languages.match(SELECTOR, d) > 0) ||
    (await atRoot())
  ) {
    await start();
    return;
  }
  output.info(
    'no workflows or action.yml at the workspace root; searching the workspace, or waiting for one to open',
  );
  nested().then(
    (found) => {
      if (found && !starting) startOrLog();
    },
    (err: unknown) => output.warn(`could not search the workspace: ${String(err)}`),
  );
}

/** The file of the active tab, when a text editor shows it. */
function activeTextTab(): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputText ? input.uri.fsPath : undefined;
}

async function atRoot(): Promise<boolean> {
  const checks = (vscode.workspace.workspaceFolders ?? []).flatMap((folder) =>
    AT_ROOT.map((path) =>
      vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, path)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return (await Promise.all(checks)).some(Boolean);
}

async function nested(): Promise<boolean> {
  const found = await Promise.all(
    NESTED.map((glob) =>
      vscode.workspace.findFiles(glob, '**/node_modules/**', 1).then((uris) => uris.length > 0),
    ),
  );
  return found.some(Boolean);
}

export function deactivate(): Promise<void> | undefined {
  return client?.dispose().catch(() => undefined);
}
