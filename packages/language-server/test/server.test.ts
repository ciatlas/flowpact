import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { readSettings, startServer } from '@flowpact/language-server';
import { analyze, writeContracts } from '@flowpact/lint';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConnection,
  createProtocolConnection,
  type Diagnostic,
  DiagnosticTag,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidChangeWatchedFilesNotification,
  type DidChangeWatchedFilesParams,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  FileChangeType,
  InitializedNotification,
  InitializeRequest,
  ProposedFeatures,
  type ProtocolConnection,
  PublishDiagnosticsNotification,
  StreamMessageReader,
  StreamMessageWriter,
  type TextEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';

const CALLER = '.github/workflows/caller.yml';
const CALLEE = '.github/workflows/callee.yml';
const CONFIG = '.github/flowpact/flowpact.config.yml';

const REPO: Record<string, string> = {
  [CALLER]: [
    'on: push',
    'jobs:',
    '  call:',
    '    uses: ./.github/workflows/callee.yml',
    '    with:',
    '      nmae: x',
    '',
  ].join('\n'),
  [CALLEE]: [
    'on:',
    '  workflow_call:',
    '    inputs:',
    '      name:',
    '        type: string',
    '        description: Who to greet',
    'jobs:',
    '  greet:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo "${{ inputs.name }}"',
    '',
  ].join('\n'),
};
const FIXED = REPO[CALLER]!.replace('nmae', 'name');

const dirs: string[] = [];
const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string> = REPO): string {
  // realpath: macOS's tmpdir is a symlink, and the server reports real paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flowpact-lsp-')));
  dirs.push(dir);
  write(dir, files);
  return dir;
}

function write(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

const uri = (dir: string, rel: string) => URI.file(join(dir, rel)).toString();

interface Client {
  conn: ProtocolConnection;
  diagnostics: Map<string, Diagnostic[]>;
  logs: string[];
  /** The edits the server asked the client to apply (`workspace/applyEdit`). */
  applied: WorkspaceEdit[];
  /** The messages the server showed (`window/showMessage`). */
  shown: string[];
  settled(): Promise<void>;
  /** The diagnostics of a file once the server has analyzed every pending edit. */
  diagnosticsOf(dir: string, rel: string): Promise<Diagnostic[]>;
  open(dir: string, rel: string, text: string): Promise<void>;
  dispose(): void;
}

/** `fileOps`: the files the client can create and delete in a workspace edit (VS Code can do both). */
async function start(
  dir: string,
  settings: Record<string, unknown> = {},
  folder = dir,
  fileOps: ('create' | 'delete')[] = [],
  annotations = false,
): Promise<Client> {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  // Readers and writers rather than raw streams: on a raw stream's end, the library exits the process.
  startServer(
    createConnection(
      ProposedFeatures.all,
      new StreamMessageReader(toServer),
      new StreamMessageWriter(toClient),
    ),
  );
  const conn = createProtocolConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
  const diagnostics = new Map<string, Diagnostic[]>();
  const logs: string[] = [];
  const applied: WorkspaceEdit[] = [];
  const shown: string[] = [];
  conn.onNotification('window/showMessage', (p: { message: string }) => {
    shown.push(p.message);
  });
  conn.onRequest('window/showMessageRequest', (p: { message: string }) => {
    shown.push(p.message);
    return null;
  });
  conn.onRequest('workspace/applyEdit', (p: { edit: WorkspaceEdit }) => {
    applied.push(p.edit);
    return { applied: true };
  });
  conn.onNotification(PublishDiagnosticsNotification.type, (p) => {
    diagnostics.set(p.uri, p.diagnostics);
  });
  conn.onNotification('window/logMessage', (p: { message: string }) => {
    logs.push(p.message);
  });
  conn.onRequest('client/registerCapability', () => null);
  conn.listen();
  await conn.sendRequest(InitializeRequest.type, {
    processId: null,
    rootUri: null,
    workspaceFolders: [{ uri: URI.file(folder).toString(), name: 'repo' }],
    capabilities: {
      textDocument: { definition: { linkSupport: true } },
      workspace: {
        workspaceFolders: true,
        didChangeWatchedFiles: { dynamicRegistration: true },
        ...(fileOps.length || annotations
          ? {
              workspaceEdit: {
                documentChanges: true,
                resourceOperations: fileOps,
                ...(annotations ? { changeAnnotationSupport: { groupsOnLabel: true } } : {}),
              },
            }
          : {}),
      },
    },
    initializationOptions: settings,
  });
  await conn.sendNotification(InitializedNotification.type, {});
  const settled = async () => {
    await conn.sendRequest('flowpact/settled');
  };
  const client: Client = {
    conn,
    diagnostics,
    logs,
    applied,
    shown,
    settled,
    async diagnosticsOf(d, rel) {
      // The server publishes before it answers, and messages arrive in order.
      await settled();
      return diagnostics.get(uri(d, rel)) ?? [];
    },
    async open(d, rel, text) {
      await conn.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: uri(d, rel), languageId: 'yaml', version: 1, text },
      });
    },
    dispose() {
      conn.dispose();
      toServer.end();
    },
  };
  clients.push(client);
  return client;
}

/** 0-based position of `needle` in a file's text, moved right by `offset`. */
function position(text: string, needle: string, offset = 0) {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`${needle} not found`);
  const before = text.slice(0, i + offset).split('\n');
  return { line: before.length - 1, character: before.at(-1)!.length };
}

const codesOf = (list: Diagnostic[]) => list.map((d) => d.code);

describe('diagnostics', () => {
  it('reports the whole repository at startup, with docs links and related locations', async () => {
    const dir = repo();
    const client = await start(dir);
    await client.settled();
    const [d] = (await client.diagnosticsOf(dir, CALLER)).filter((x) => x.code === 'FP102');
    expect(d).toMatchObject({
      source: 'flowpact',
      severity: 1,
      range: { start: position(REPO[CALLER]!, 'nmae'), end: position(REPO[CALLER]!, 'nmae', 4) },
      codeDescription: { href: expect.stringMatching(/fp102$/) },
      data: { fingerprint: expect.any(String) },
    });
    expect(d!.relatedInformation?.[0]?.location.uri).toBe(uri(dir, CALLEE));
  });

  it('analyzes unsaved edits and falls back to the file on disk when the buffer closes', async () => {
    const dir = repo();
    const client = await start(dir);
    await client.open(dir, CALLER, REPO[CALLER]!);
    expect(codesOf(await client.diagnosticsOf(dir, CALLER))).toContain('FP102');
    await client.conn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: uri(dir, CALLER), version: 2 },
      contentChanges: [{ text: FIXED }],
    });
    expect(await client.diagnosticsOf(dir, CALLER)).toEqual([]);
    await client.conn.sendNotification(DidCloseTextDocumentNotification.type, {
      textDocument: { uri: uri(dir, CALLER) },
    });
    expect(codesOf(await client.diagnosticsOf(dir, CALLER))).toContain('FP102');
  });

  it('re-analyzes when files change on disk', async () => {
    const dir = repo();
    const client = await start(dir);
    expect(codesOf(await client.diagnosticsOf(dir, CALLER))).toContain('FP102');
    write(dir, { [CALLER]: FIXED });
    await client.conn.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: uri(dir, CALLER), type: FileChangeType.Changed }],
    });
    expect(await client.diagnosticsOf(dir, CALLER)).toEqual([]);
  });

  it("reports GitHub's actions.lock it cannot read on that file, until it changes on disk", async () => {
    const LOCK = '.github/workflows/actions.lock';
    const dir = repo({ ...REPO, [LOCK]: "version: 'v0.1.0'\n" });
    const client = await start(dir);
    expect(codesOf(await client.diagnosticsOf(dir, LOCK))).toEqual(['FP614']);
    write(dir, { [LOCK]: "version: 'v0.0.3'\n" });
    await client.conn.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: uri(dir, LOCK), type: FileChangeType.Changed }],
    });
    expect(await client.diagnosticsOf(dir, LOCK)).toEqual([]);
  });

  it('hides the rules the client asks it to, also after a settings change', async () => {
    const dir = repo();
    const client = await start(dir, { hiddenRules: ['fp102'] });
    expect(codesOf(await client.diagnosticsOf(dir, CALLER))).not.toContain('FP102');
    await client.conn.sendNotification(DidChangeConfigurationNotification.type, {
      settings: { flowpact: { hiddenRules: [] } },
    });
    expect(codesOf(await client.diagnosticsOf(dir, CALLER))).toContain('FP102');
  });

  it('reports config problems on the config file and keeps analyzing', async () => {
    const dir = repo({ ...REPO, [CONFIG]: 'rules:\n  FP999: error\n' });
    const client = await start(dir);
    const [problem] = await client.diagnosticsOf(dir, CONFIG);
    expect(problem?.message).toMatch(/FP999/);
    expect(codesOf(await client.diagnosticsOf(dir, CALLER))).toContain('FP102');
    // A config that is not even YAML, while being typed: the last good config is used.
    await client.open(dir, CONFIG, 'rules: [');
    expect((await client.diagnosticsOf(dir, CONFIG))[0]?.message).toMatch(/not valid YAML/);
    expect(codesOf(await client.diagnosticsOf(dir, CALLER))).toContain('FP102');
  });

  it('loads plugins only when the client trusts the workspace', async () => {
    const plugin = `export default {
      code: 'ACME601', name: 'every-workflow', category: 'structure', defaultSeverity: 'warning',
      docsUrl: 'https://example.com/acme601', docs: { summary: 's', why: 'w', fix: 'f' },
      check(ctx) {
        for (const wf of ctx.index.project.workflows.values()) ctx.report({ message: 'seen', loc: wf.source.loc(0) });
      },
    };\n`;
    const files = {
      ...REPO,
      [CONFIG]: 'plugins: [.github/flowpact/rule.mjs]\n',
      '.github/flowpact/rule.mjs': plugin,
    };
    const untrusted = repo(files);
    const off = await start(untrusted);
    expect(codesOf(await off.diagnosticsOf(untrusted, CALLER))).not.toContain('ACME601');
    expect(off.logs.join('\n')).toMatch(/plugins; they are not loaded/);
    const trusted = repo(files);
    const on = await start(trusted, { plugins: true });
    expect(codesOf(await on.diagnosticsOf(trusted, CALLER))).toContain('ACME601');
    // A trusted folder inside the repository does not make the repository's own plugins trusted.
    const above = repo({ ...files, 'sub/action.yml': 'name: x\nruns: { using: composite, steps: [] }\n' });
    const sub = await start(above, { plugins: true }, join(above, 'sub'));
    await sub.open(above, 'sub/action.yml', 'name: x\nruns: { using: composite, steps: [] }\n');
    expect(codesOf(await sub.diagnosticsOf(above, CALLER))).toContain('FP102');
    expect(codesOf(await sub.diagnosticsOf(above, CALLER))).not.toContain('ACME601');
    expect(sub.logs.join('\n')).toMatch(/outside the workspace folders/);
  });

  it('analyzes a nested repository when one of its files is opened, and ignores other YAML', async () => {
    const dir = repo({ ...REPO, [`sub/${CALLER}`]: REPO[CALLER]!, [`sub/${CALLEE}`]: REPO[CALLEE]! });
    const client = await start(dir);
    await client.settled();
    expect(client.diagnostics.has(uri(dir, `sub/${CALLER}`))).toBe(false);
    await client.open(dir, `sub/${CALLER}`, REPO[CALLER]!);
    expect(codesOf(await client.diagnosticsOf(dir, `sub/${CALLER}`))).toContain('FP102');
    await client.open(dir, 'docker-compose.yml', 'services: {}\n');
    await client.settled();
    expect(client.diagnostics.has(uri(dir, 'docker-compose.yml'))).toBe(false);
  });
});

describe('navigation', () => {
  const ready = async () => {
    const dir = repo({ ...REPO, [CALLER]: FIXED });
    const client = await start(dir);
    await client.open(dir, CALLER, FIXED);
    await client.open(dir, CALLEE, REPO[CALLEE]!);
    return { dir, client };
  };

  it('shows the declaration and the data flow on hover', async () => {
    const { dir, client } = await ready();
    const hover = await client.conn.sendRequest('textDocument/hover', {
      textDocument: { uri: uri(dir, CALLEE) },
      position: position(REPO[CALLEE]!, 'inputs.name', 8),
    });
    const value = (hover as { contents: { value: string } }).contents.value;
    expect(value.split('\n')[0]).toMatch(/^\*\*flowpact\*\* · input · \[docs\]\(.+#hover\)$/);
    expect(value).toContain('`inputs.name` in `callee.yml` · `string` · optional');
    expect(value).toContain('Who to greet');
    expect(value).toContain('**From** literal `"x"` in `caller.yml › jobs.call`');
    expect(value).toContain('**To** run script in `jobs.greet › steps[0] › run`');
  });

  it('goes from a `with:` key to the callee’s input', async () => {
    const { dir, client } = await ready();
    const links = await client.conn.sendRequest('textDocument/definition', {
      textDocument: { uri: uri(dir, CALLER) },
      position: position(FIXED, 'name: x', 1),
    });
    expect(links).toEqual([
      {
        originSelectionRange: { start: position(FIXED, 'name: x'), end: position(FIXED, 'name: x', 4) },
        targetUri: uri(dir, CALLEE),
        targetRange: { start: position(REPO[CALLEE]!, 'name:'), end: position(REPO[CALLEE]!, 'name:', 4) },
        targetSelectionRange: {
          start: position(REPO[CALLEE]!, 'name:'),
          end: position(REPO[CALLEE]!, 'name:', 4),
        },
      },
    ]);
  });

  it('finds references across files, with or without the declaration', async () => {
    const { dir, client } = await ready();
    const at = { textDocument: { uri: uri(dir, CALLEE) }, position: position(REPO[CALLEE]!, 'name:') };
    const all = (await client.conn.sendRequest('textDocument/references', {
      ...at,
      context: { includeDeclaration: true },
    })) as { uri: string }[];
    expect(all.map((l) => l.uri)).toEqual([uri(dir, CALLEE), uri(dir, CALLEE), uri(dir, CALLER)]);
    const refs = (await client.conn.sendRequest('textDocument/references', {
      ...at,
      context: { includeDeclaration: false },
    })) as unknown[];
    expect(refs).toHaveLength(2);
  });

  it('lists a read of a whole outputs object among the references of each output', async () => {
    const W = '.github/workflows/whole.yml';
    const text = [
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    outputs:',
      '      digest: x',
      '    steps: [{ run: echo }]',
      '  use:',
      '    needs: build',
      '    runs-on: ubuntu-latest',
      '    steps:',
      "      - run: echo '${{ toJSON(needs.build.outputs) }}'",
      '',
    ].join('\n');
    const dir = repo({ [W]: text });
    const client = await start(dir);
    await client.open(dir, W, text);
    const refs = (await client.conn.sendRequest('textDocument/references', {
      textDocument: { uri: uri(dir, W) },
      position: position(text, 'digest:'),
      context: { includeDeclaration: false },
    })) as { uri: string; range: { start: unknown } }[];
    expect(refs).toEqual([
      expect.objectContaining({
        uri: uri(dir, W),
        range: expect.objectContaining({ start: position(text, 'needs.build') }),
      }),
    ]);
  });

  it('highlights a symbol within the file', async () => {
    const { dir, client } = await ready();
    const highlights = await client.conn.sendRequest('textDocument/documentHighlight', {
      textDocument: { uri: uri(dir, CALLEE) },
      position: position(REPO[CALLEE]!, 'inputs.name'),
    });
    expect((highlights as { kind: number }[]).map((h) => h.kind)).toEqual([3, 2]);
  });

  it('describes a remote call and its keys from the lockfile, and finds the callers passing an input', async () => {
    const R = '.github/workflows/remote.yml';
    const text = [
      'on: push',
      'jobs:',
      '  a:',
      '    uses: octo/ship/.github/workflows/deploy.yml@v1',
      '    with: { env: prod }',
      '  b:',
      '    uses: octo/ship/.github/workflows/deploy.yml@v1',
      '    with: { env: dev }',
      '',
    ].join('\n');
    const lock = [
      'version: 1',
      'remotes:',
      '  octo/ship/.github/workflows/deploy.yml@v1:',
      `    sha: ${'a'.repeat(40)}`,
      '    kind: workflow',
      '    inputs: { env: { type: string, required: true } }',
      '',
    ].join('\n');
    const dir = repo({ [R]: text, '.github/flowpact/remotes.lock.yaml': lock });
    const client = await start(dir);
    await client.open(dir, R, text);
    const hoverAt = async (needle: string) =>
      (
        (await client.conn.sendRequest('textDocument/hover', {
          textDocument: { uri: uri(dir, R) },
          position: position(text, needle),
        })) as { contents: { value: string } }
      ).contents.value;
    expect(await hoverAt('octo/ship')).toContain(
      'reusable workflow at `aaaaaaa`, recorded in `remotes.lock.yaml`',
    );
    expect(await hoverAt('env: prod')).toContain(
      '`inputs.env` in `octo/ship/.github/workflows/deploy.yml@v1` · `string` · required',
    );
    const refs = (await client.conn.sendRequest('textDocument/references', {
      textDocument: { uri: uri(dir, R) },
      position: position(text, 'env: prod'),
      context: { includeDeclaration: true },
    })) as { range: { start: { line: number } } }[];
    expect(refs.map((l) => l.range.start.line)).toEqual([4, 7]);
  });

  it('goes to the cached source of a remote call, and leaves the cached file unanalyzed', async () => {
    const R = '.github/workflows/remote.yml';
    const SHA = 'a'.repeat(40);
    const text = [
      'on: push',
      'jobs:',
      '  a:',
      '    uses: octo/ship/.github/workflows/deploy.yml@v1',
      '    with: { env: prod }',
      '',
    ].join('\n');
    const lock = [
      'version: 1',
      'remotes:',
      '  octo/ship/.github/workflows/deploy.yml@v1:',
      `    sha: ${SHA}`,
      '    kind: workflow',
      '    inputs: { env: { type: string, required: true } }',
      '',
    ].join('\n');
    const source = [
      'on:',
      '  workflow_call:',
      '    inputs:',
      '      env: { type: string, required: true }',
      'jobs:',
      '  d:',
      '    runs-on: x',
      '    steps:',
      '      - uses: elsewhere/unlocked@v1',
      '',
    ].join('\n');
    const dir = repo({ [R]: text, '.github/flowpact/remotes.lock.yaml': lock });
    const cache = repo({});
    const cached = join(cache, 'remotes', 'octo', 'ship', SHA, '.github', 'workflows', 'deploy.yml');
    write(cache, { [join('remotes', 'octo', 'ship', SHA, '.github', 'workflows', 'deploy.yml')]: source });
    const before = process.env.FLOWPACT_CACHE_DIR;
    process.env.FLOWPACT_CACHE_DIR = cache;
    let client: Client;
    try {
      client = await start(dir);
    } finally {
      if (before === undefined) delete process.env.FLOWPACT_CACHE_DIR;
      else process.env.FLOWPACT_CACHE_DIR = before;
    }
    await client.open(dir, R, text);
    expect(await client.conn.sendRequest('flowpact/sourcesDir')).toBe(join(cache, 'remotes'));
    const definition = async (needle: string) =>
      (await client.conn.sendRequest('textDocument/definition', {
        textDocument: { uri: uri(dir, R) },
        position: position(text, needle),
      })) as { targetUri: string; targetRange: { start: { line: number } } }[];
    expect((await definition('octo/ship')).map((l) => [l.targetUri, l.targetRange.start.line])).toEqual([
      [URI.file(cached).toString(), 1],
    ]);
    expect((await definition('env: prod')).map((l) => [l.targetUri, l.targetRange.start.line])).toEqual([
      [URI.file(cached).toString(), 3],
    ]);
    // Opening the cached file analyzes nothing there: it would report FP603 for its own remote call otherwise.
    await client.conn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: URI.file(cached).toString(), languageId: 'yaml', version: 1, text: source },
    });
    await client.settled();
    expect(client.diagnostics.get(URI.file(cached).toString())).toBeUndefined();
    expect(client.logs.some((l) => l.includes(join(cache, 'remotes')))).toBe(false);
  });

  it('reads the sources cache the cacheDir setting names, and follows it when it changes', async () => {
    const SHA = 'b'.repeat(40);
    const R = '.github/workflows/remote.yml';
    const text = 'on: push\njobs:\n  a:\n    uses: octo/ship/.github/workflows/deploy.yml@v1\n';
    const lock = `version: 1\nremotes:\n  octo/ship/.github/workflows/deploy.yml@v1:\n    sha: ${SHA}\n    kind: workflow\n`;
    const dir = repo({ [R]: text, '.github/flowpact/remotes.lock.yaml': lock });
    const first = repo({});
    const second = repo({});
    const rel = join('remotes', 'octo', 'ship', SHA, '.github', 'workflows', 'deploy.yml');
    write(first, { [rel]: 'on:\n  workflow_call: {}\njobs: {}\n' });
    write(second, { [rel]: '# second\non:\n  workflow_call: {}\njobs: {}\n' });
    const client = await start(dir, { cacheDir: first });
    await client.open(dir, R, text);
    const target = async () =>
      (
        (await client.conn.sendRequest('textDocument/definition', {
          textDocument: { uri: uri(dir, R) },
          position: position(text, 'octo/ship'),
        })) as { targetUri: string }[]
      ).map((l) => l.targetUri);
    expect(await client.conn.sendRequest('flowpact/sourcesDir')).toBe(join(first, 'remotes'));
    expect(await target()).toEqual([URI.file(join(first, rel)).toString()]);
    await client.conn.sendNotification(DidChangeConfigurationNotification.type, {
      settings: { flowpact: { cacheDir: second } },
    });
    expect(await client.conn.sendRequest('flowpact/sourcesDir')).toBe(join(second, 'remotes'));
    expect(await target()).toEqual([URI.file(join(second, rel)).toString()]);
  });

  it('does not analyze a workspace folder inside the sources cache', async () => {
    const cache = repo({});
    const folder = join(cache, 'remotes', 'octo', 'ship', 'c'.repeat(40));
    write(folder, {
      '.github/workflows/deploy.yml': 'on: push\njobs:\n  a:\n    uses: elsewhere/unlocked@v1\n',
    });
    const client = await start(folder, { cacheDir: cache });
    await client.settled();
    expect(client.logs.some((l) => l.includes(`analyzing ${folder}`))).toBe(false);
    expect(client.diagnostics.size).toBe(0);
  });

  it('answers nothing where no symbol is written', async () => {
    const { dir, client } = await ready();
    const at = { textDocument: { uri: uri(dir, CALLEE) }, position: position(REPO[CALLEE]!, 'runs-on') };
    expect(await client.conn.sendRequest('textDocument/hover', at)).toBeNull();
    expect(await client.conn.sendRequest('textDocument/definition', at)).toBeNull();
    const elsewhere = { textDocument: { uri: 'untitled:Untitled-1' }, position: { line: 0, character: 0 } };
    expect(await client.conn.sendRequest('textDocument/hover', elsewhere)).toBeNull();
  });

  it('hovers an expression inside its `${{ }}` where no symbol is written', async () => {
    const { dir, client } = await ready();
    const hover = (await client.conn.sendRequest('textDocument/hover', {
      textDocument: { uri: uri(dir, CALLEE) },
      position: position(REPO[CALLEE]!, '${{ inputs.name', 3),
    })) as { contents: { value: string }; range: unknown };
    expect(hover.contents.value.split('\n').slice(1)).toEqual([
      '',
      'written into the script as text  ',
      "yields text of `inputs.name` | '' (`inputs.name` omitted)",
    ]);
    // The range is the expression with its `${{ }}`.
    expect(hover.range).toEqual({ start: { line: 10, character: 19 }, end: { line: 10, character: 37 } });
  });
});

describe('readSettings', () => {
  it('takes an absolute cacheDir, keeps it when missing, and clears it when empty or relative', () => {
    const set = readSettings({ cacheDir: '/srv/cache' });
    expect(set.cacheDir).toBe('/srv/cache');
    expect(readSettings({}, set).cacheDir).toBe('/srv/cache');
    expect(readSettings({ cacheDir: '' }, set).cacheDir).toBeUndefined();
    expect(readSettings({ cacheDir: 'relative' }, set).cacheDir).toBeUndefined();
  });

  it('keeps the previous value for anything missing or invalid', () => {
    const base = readSettings({ plugins: true, contracts: 'on', hiddenRules: ['FP503'], logLevel: 'debug' });
    expect(readSettings({ contracts: 'sometimes', hiddenRules: [1], logLevel: 'loud' }, base)).toEqual(base);
    expect(readSettings(null)).toEqual({
      plugins: false,
      contracts: 'auto',
      hiddenRules: [],
      logLevel: 'info',
    });
  });
});

/** A text with LSP edits made (from the last to the first). */
function edited(text: string, edits: TextEdit[]): string {
  const lines = text.split('\n');
  const at = (p: { line: number; character: number }) =>
    lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  return [...edits]
    .sort((a, b) => at(b.range.start) - at(a.range.start))
    .reduce((t, e) => t.slice(0, at(e.range.start)) + e.newText + t.slice(at(e.range.end)), text);
}

describe('code actions', () => {
  const actionsFor = async (client: Client, dir: string) => {
    const [d] = (await client.diagnosticsOf(dir, CALLER)).filter((x) => x.code === 'FP102');
    return client.conn.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri(dir, CALLER) },
      range: d!.range,
      context: { diagnostics: [d] },
    }) as Promise<
      {
        title: string;
        isPreferred?: boolean;
        edit?: WorkspaceEdit;
        command?: { command: string; arguments: unknown[] };
      }[]
    >;
  };

  it("offers a finding's suggestion as the preferred quick fix", async () => {
    const dir = repo();
    const client = await start(dir);
    const [rename] = await actionsFor(client, dir);
    expect(rename).toMatchObject({ title: 'Rename "nmae" to "name"', isPreferred: true });
    expect(edited(REPO[CALLER]!, rename!.edit!.changes![uri(dir, CALLER)]!)).toBe(FIXED);
  });

  it("fades a redundant `!= ''` and removes it with the quick fix", async () => {
    const WF = '.github/workflows/w.yml';
    const text =
      "on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - id: s\n        run: echo\n      - if: ${{ steps.s.outputs.o != '' }}\n        run: echo\n";
    const dir = repo({ [WF]: text, [CONFIG]: 'rules:\n  FP507: info\n' });
    const client = await start(dir);
    const [d] = (await client.diagnosticsOf(dir, WF)).filter((x) => x.code === 'FP507');
    expect(d).toMatchObject({
      tags: [DiagnosticTag.Unnecessary],
      range: { start: { line: 7, character: 34 }, end: { line: 7, character: 39 } },
    });
    const [fix] = (await client.conn.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri(dir, WF) },
      range: d!.range,
      context: { diagnostics: [d] },
    })) as { title: string; isPreferred?: boolean; edit?: WorkspaceEdit }[];
    expect(fix).toMatchObject({ title: "Remove `!= ''`", isPreferred: true });
    expect(edited(text, fix!.edit!.changes![uri(dir, WF)]!)).toBe(
      text.replace("steps.s.outputs.o != ''", 'steps.s.outputs.o'),
    );
  });

  it('accepts a finding with an override in a new config file, with a reason to replace', async () => {
    const dir = repo();
    const client = await start(dir, {}, dir, ['create']);
    const accept = (await actionsFor(client, dir)).find(
      (a) => a.title === 'Accept this finding with an override',
    );
    const [create, change] = accept!.edit!.documentChanges as [
      { kind: string; uri: string },
      { textDocument: { uri: string }; edits: TextEdit[] },
    ];
    expect(create).toMatchObject({ kind: 'create', uri: uri(dir, CONFIG) });
    expect(change.edits[0]!.newText).toBe(
      'overrides:\n  - rule: FP102\n    target: ".github/workflows/callee.yml#inputs.nmae"\n    reason: "Explain why this finding is accepted"\n',
    );
  });

  it('offers no accept for a client that cannot create the config file', async () => {
    const dir = repo();
    const client = await start(dir);
    expect((await actionsFor(client, dir)).map((a) => a.title)).toEqual([
      'Rename "nmae" to "name"',
      'Ignore FP102 on this line with a comment',
    ]);
  });

  it('ignores a finding with a comment above its line, after which it is no longer reported', async () => {
    const dir = repo();
    const client = await start(dir);
    const ignore = (await actionsFor(client, dir)).find((a) => a.title.startsWith('Ignore'));
    const text = edited(REPO[CALLER]!, ignore!.edit!.changes![uri(dir, CALLER)]!);
    expect(text).toBe(
      REPO[CALLER]!.replace('      nmae: x', '      # flowpact: ignore[FP102]\n      nmae: x'),
    );
    write(dir, { [CALLER]: text });
    await client.conn.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: uri(dir, CALLER), type: FileChangeType.Changed }],
    });
    expect(codesOf(await client.diagnosticsOf(dir, CALLER))).not.toContain('FP102');
  });

  it('adds the override to the config the repository has', async () => {
    const dir = repo({ ...REPO, [CONFIG]: 'rules:\n  FP604: warning\n' });
    const client = await start(dir);
    const accept = (await actionsFor(client, dir)).find((a) => a.title.startsWith('Accept'));
    expect(edited('rules:\n  FP604: warning\n', accept!.edit!.changes![uri(dir, CONFIG)]!)).toContain(
      'rules:\n  FP604: warning\noverrides:\n  - rule: FP102\n',
    );
  });

  it('lets a client that asks for the reason run its command, then adds the override with that reason', async () => {
    const dir = repo();
    const client = await start(dir, { acceptFindingPrompt: true }, dir, ['create']);
    const accept = (await actionsFor(client, dir)).find((a) => a.title.startsWith('Accept'));
    expect(accept).toMatchObject({
      title: 'Accept this finding with an override…',
      command: { command: 'flowpact.acceptFindingWithReason', arguments: [{ uri: uri(dir, CALLER) }] },
    });
    expect(accept!.edit).toBeUndefined();
    const [args] = accept!.command!.arguments as [{ uri: string; fingerprint: string }];
    await client.conn.sendRequest('workspace/executeCommand', {
      command: 'flowpact.acceptFinding',
      arguments: [{ ...args, reason: 'The callee reads it under another name', expires: '2099-01-31' }],
    });
    const [edit] = client.applied;
    const change = (edit!.documentChanges as { edits?: TextEdit[] }[])[1]!;
    const config = edited('', change.edits!);
    expect(config).toContain('reason: "The callee reads it under another name"\n    expires: 2099-01-31');
    // With the config written, the finding is accepted.
    write(dir, { [CONFIG]: config });
    await client.conn.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: uri(dir, CONFIG), type: FileChangeType.Created }],
    });
    expect(codesOf(await client.diagnosticsOf(dir, CALLER))).not.toContain('FP102');
  });
});

describe('regenerating the contracts', () => {
  /** The repository with its contracts generated; then `change` is made to it. */
  const withContracts = (change: Record<string, string | null>) => {
    const dir = repo({ ...REPO, [CALLER]: FIXED });
    writeContracts(dir, analyze({ root: dir, checkContracts: true }).contracts!);
    for (const [rel, text] of Object.entries(change))
      if (text === null) rmSync(join(dir, rel));
      else write(dir, { [rel]: text });
    return dir;
  };
  /** The callee with one more optional input: its contract is outdated (FP802). */
  const OUTDATED = {
    [CALLEE]: REPO[CALLEE]!.replace('    inputs:\n', '    inputs:\n      greeting:\n        type: string\n'),
  };
  const OTHER = '.github/workflows/other.yml';
  const NEW = {
    [OTHER]:
      'on:\n  workflow_call:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n',
  };

  type Action = { title: string; edit?: WorkspaceEdit };
  const regenerate = async (client: Client, dir: string, rel: string, code: string) => {
    const [d] = (await client.diagnosticsOf(dir, rel)).filter((x) => x.code === code);
    expect(d, code).toBeDefined();
    const actions = (await client.conn.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri(dir, rel) },
      range: d!.range,
      context: { diagnostics: [d] },
    })) as Action[];
    return actions.find((a) => a.title.startsWith('Regenerate the contracts'));
  };

  /** Makes one change of a workspace edit on disk, as a client would; the file it changes, if any. */
  function change(c: NonNullable<WorkspaceEdit['documentChanges']>[number]): string | undefined {
    if (!('kind' in c)) {
      const path = URI.parse(c.textDocument.uri).fsPath;
      writeFileSync(path, edited(readFileSync(path, 'utf8'), c.edits as TextEdit[]));
      return c.textDocument.uri;
    }
    if (c.kind === 'delete') rmSync(URI.parse(c.uri).fsPath);
    if (c.kind !== 'create') return c.kind === 'delete' ? c.uri : undefined;
    mkdirSync(dirname(URI.parse(c.uri).fsPath), { recursive: true });
    writeFileSync(URI.parse(c.uri).fsPath, '');
    return undefined;
  }

  /** Makes a workspace edit on disk, as a client would, and tells the server which files changed. */
  async function apply(client: Client, edit: WorkspaceEdit) {
    const plain = Object.entries(edit.changes ?? {}).map(([u, edits]) =>
      change({ textDocument: { uri: u, version: null }, edits }),
    );
    const changed = [...plain, ...(edit.documentChanges ?? []).map(change)].filter((u): u is string => !!u);
    const params: DidChangeWatchedFilesParams = {
      changes: changed.map((u) => ({ uri: u, type: FileChangeType.Changed })),
    };
    await client.conn.sendNotification(DidChangeWatchedFilesNotification.type, params);
  }

  const contractCodes = async (client: Client, dir: string, rels: string[]) =>
    (await Promise.all(rels.map((r) => client.diagnosticsOf(dir, r))))
      .flat()
      .map((d) => String(d.code))
      .filter((c) => /^FP80[1-5]$/.test(c));

  it('replaces an outdated contract, also for a client that takes only plain text edits', async () => {
    const dir = withContracts(OUTDATED);
    const client = await start(dir);
    const action = await regenerate(client, dir, CALLEE, 'FP802');
    expect(action?.title).toBe('Regenerate the contracts (1 file)');
    expect(action?.edit?.changes).toBeDefined();
    await apply(client, action!.edit!);
    expect(await contractCodes(client, dir, [CALLEE, CALLER])).toEqual([]);
  });

  it("creates a new workflow's contract, only for a client that can create files", async () => {
    const dir = withContracts({ ...OUTDATED, ...NEW });
    expect(await regenerate(await start(dir), dir, CALLEE, 'FP802')).toBeUndefined();
    const client = await start(dir, {}, dir, ['create', 'delete']);
    const action = await regenerate(client, dir, CALLEE, 'FP802');
    expect(action?.title).toBe('Regenerate the contracts (2 files)');
    await apply(client, action!.edit!);
    expect(await contractCodes(client, dir, [CALLEE, CALLER, OTHER])).toEqual([]);
  });

  it("deletes a removed workflow's contract, only for a client that can delete files", async () => {
    const dir = withContracts({ [CALLER]: FIXED.replace('callee.yml', 'gone.yml'), [CALLEE]: null });
    const contract = '.github/flowpact/contracts/workflows/callee.contract.yaml';
    expect(await regenerate(await start(dir, {}, dir, ['create']), dir, contract, 'FP804')).toBeUndefined();
    const client = await start(dir, {}, dir, ['create', 'delete']);
    const action = await regenerate(client, dir, contract, 'FP804');
    expect(action?.edit?.documentChanges).toContainEqual(
      expect.objectContaining({ kind: 'delete', uri: uri(dir, contract) }),
    );
    await apply(client, action!.edit!);
    expect(await contractCodes(client, dir, [CALLER, contract])).toEqual([]);
  });
});

describe('repositories without a .github folder', () => {
  /** A composite action that reads an input it does not declare: FP108. */
  const ACTION = [
    'name: Build',
    'description: Builds the project',
    'inputs:',
    '  version:',
    '    description: The version to build',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - run: echo "${{ inputs.verison }}"',
    '      shell: bash',
    '',
  ].join('\n');
  const GIT = { '.git/HEAD': 'ref: refs/heads/main\n' };

  it('analyzes a git repository whose action is at its root, from the start and as it is edited', async () => {
    const dir = repo({ ...GIT, 'action.yml': ACTION });
    const client = await start(dir);
    expect(codesOf(await client.diagnosticsOf(dir, 'action.yml'))).toContain('FP108');
    await client.open(dir, 'action.yml', ACTION);
    await client.conn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: uri(dir, 'action.yml'), version: 2 },
      contentChanges: [{ text: ACTION.replace('verison', 'version') }],
    });
    expect(codesOf(await client.diagnosticsOf(dir, 'action.yml'))).not.toContain('FP108');
  });

  it('takes the git root as the repository of an action in a subdirectory, once its file is opened', async () => {
    // The root action uses ./build, so the analysis reaches it.
    const root =
      'name: Root\ndescription: d\nruns:\n  using: composite\n  steps:\n    - uses: ./build\n      with:\n        version: 1\n';
    const dir = repo({ ...GIT, 'action.yml': root, 'build/action.yml': ACTION });
    const client = await start(dir);
    await client.open(dir, 'build/action.yml', ACTION);
    expect(codesOf(await client.diagnosticsOf(dir, 'build/action.yml'))).toContain('FP108');
  });

  it('analyzes nothing outside a repository', async () => {
    const dir = repo({ 'action.yml': ACTION });
    const client = await start(dir);
    await client.open(dir, 'action.yml', ACTION);
    expect(await client.diagnosticsOf(dir, 'action.yml')).toEqual([]);
  });

  it('keeps a .github folder above a nested git repository as the repository', async () => {
    // A vendored action with a .git of its own, used by a workflow: references to its input reach the workflow only
    // when both are one repository.
    const use =
      'on: push\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ./vendor/tool\n        with:\n          version: 1\n';
    const dir = repo({
      '.github/workflows/use.yml': use,
      'vendor/tool/.git': 'gitdir: ../../.git/modules/tool\n',
      'vendor/tool/action.yml': ACTION,
    });
    const client = await start(dir);
    await client.open(dir, 'vendor/tool/action.yml', ACTION);
    await client.settled();
    const refs = (await client.conn.sendRequest('textDocument/references', {
      textDocument: { uri: uri(dir, 'vendor/tool/action.yml') },
      position: position(ACTION, '  version:', 3),
      context: { includeDeclaration: false },
    })) as { uri: string }[];
    expect(refs.map((r) => r.uri)).toContain(uri(dir, '.github/workflows/use.yml'));
  });
});

describe('contract files', () => {
  const CONTRACT = '.github/flowpact/contracts/workflows/callee.contract.yaml';
  /** The repository with its contracts generated. */
  const withContracts = () => {
    const dir = repo({ ...REPO, [CALLER]: FIXED });
    writeContracts(dir, analyze({ root: dir, checkContracts: true }).contracts!);
    return { dir, text: readFileSync(join(dir, CONTRACT), 'utf8') };
  };
  type Target = { targetUri: string; targetRange: { start: { line: number } } };

  it('describes an input the contract records, as in the workflow', async () => {
    const { dir, text } = withContracts();
    const client = await start(dir);
    await client.settled();
    const hover = (await client.conn.sendRequest('textDocument/hover', {
      textDocument: { uri: uri(dir, CONTRACT) },
      position: position(text, '    name:', 5),
    })) as { contents: { value: string } } | null;
    expect(hover?.contents.value).toContain('Who to greet');
  });

  it('goes from an input, and from the path, to the workflow that declares them', async () => {
    const { dir, text } = withContracts();
    const client = await start(dir);
    await client.settled();
    const definition = (at: { line: number; character: number }) =>
      client.conn.sendRequest('textDocument/definition', {
        textDocument: { uri: uri(dir, CONTRACT) },
        position: at,
      }) as Promise<Target[] | null>;
    const [input] = (await definition(position(text, '    name:', 5)))!;
    expect(input).toMatchObject({ targetUri: uri(dir, CALLEE), targetRange: { start: { line: 3 } } });
    const [unit] = (await definition(position(text, 'path: ', 8)))!;
    expect(unit?.targetUri).toBe(uri(dir, CALLEE));
  });
});

describe('rename', () => {
  const CALLER_RN = '.github/workflows/caller.yml';
  const CALLEE_RN = '.github/workflows/_callee.yml';
  /** A caller of a workflow no other repository calls (its name starts with _): it passes an input and reads an output. */
  const RN: Record<string, string> = {
    [CALLER_RN]: [
      'on: push',
      'jobs:',
      '  call:',
      '    uses: ./.github/workflows/_callee.yml',
      '    with:',
      '      name: x',
      '  next:',
      '    needs: call',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "${{ needs.call.outputs.greeting }}"',
      '',
    ].join('\n'),
    [CALLEE_RN]: [
      'on:',
      '  workflow_call:',
      '    inputs:',
      '      name:',
      '        type: string',
      '    outputs:',
      '      greeting:',
      '        value: ${{ jobs.greet.outputs.text }}',
      'jobs:',
      '  greet:',
      '    runs-on: ubuntu-latest',
      '    outputs:',
      '      text: ${{ steps.s.outputs.text }}',
      '    steps:',
      '      - id: s',
      '        run: echo "text=hi ${{ inputs.name }}" >> "$GITHUB_OUTPUT"',
      '',
    ].join('\n'),
  };

  type Edit = WorkspaceEdit & { changeAnnotations?: Record<string, { needsConfirmation?: boolean }> };
  const rename = (
    client: Client,
    dir: string,
    rel: string,
    at: { line: number; character: number },
    newName: string,
  ) =>
    client.conn.sendRequest('textDocument/rename', {
      textDocument: { uri: uri(dir, rel) },
      position: at,
      newName,
    }) as Promise<Edit | null>;

  /** The files with a workspace edit made: its plain changes, or its document changes. */
  function renamed(dir: string, files: Record<string, string>, edit: Edit): Record<string, string> {
    const out = { ...files };
    const byUri: [string, TextEdit[]][] = [
      ...Object.entries(edit.changes ?? {}),
      ...((edit.documentChanges ?? []) as { textDocument: { uri: string }; edits: TextEdit[] }[]).map(
        (c) => [c.textDocument.uri, c.edits] as [string, TextEdit[]],
      ),
    ];
    for (const [u, edits] of byUri) {
      const rel = Object.keys(files).find((r) => uri(dir, r) === u)!;
      out[rel] = edited(out[rel]!, edits);
    }
    return out;
  }

  /** Renames at a position, writes the result, and returns it with the errors flowpact then reports. */
  async function renameAndCheck(rel: string, needle: string, offset: number, newName: string) {
    const dir = repo(RN);
    const client = await start(dir);
    await client.settled();
    const edit = await rename(client, dir, rel, position(RN[rel]!, needle, offset), newName);
    const files = renamed(dir, RN, edit!);
    write(dir, files);
    const changed: DidChangeWatchedFilesParams = {
      changes: Object.keys(files).map((r) => ({ uri: uri(dir, r), type: FileChangeType.Changed })),
    };
    await client.conn.sendNotification(DidChangeWatchedFilesNotification.type, changed);
    const errors = [
      ...(await client.diagnosticsOf(dir, CALLER_RN)),
      ...(await client.diagnosticsOf(dir, CALLEE_RN)),
    ].filter((d) => d.severity === 1);
    return { files, errors };
  }

  it('renames an input where it is declared, passed and read', async () => {
    const { files, errors } = await renameAndCheck(CALLEE_RN, '      name:', 6, 'who');
    expect(files[CALLEE_RN]).toContain('    inputs:\n      who:\n');
    expect(files[CALLEE_RN]).toContain('hi ${{ inputs.who }}');
    expect(files[CALLER_RN]).toContain('    with:\n      who: x\n');
    expect(errors).toEqual([]);
  });

  it("renames the callee's input from the key a caller passes", async () => {
    const { files, errors } = await renameAndCheck(CALLER_RN, '      name: x', 7, 'who');
    expect(files[CALLEE_RN]).toContain('${{ inputs.who }}');
    expect(errors).toEqual([]);
  });

  it("renames a workflow's output from where a caller reads it, and a job's output", async () => {
    const out = await renameAndCheck(CALLER_RN, 'outputs.greeting', 9, 'message');
    expect(out.files[CALLEE_RN]).toContain('    outputs:\n      message:\n');
    expect(out.files[CALLER_RN]).toContain('needs.call.outputs.message');
    expect(out.errors).toEqual([]);
    const job = await renameAndCheck(CALLEE_RN, '      text:', 7, 'body');
    expect(job.files[CALLEE_RN]).toContain('jobs.greet.outputs.body');
    expect(job.files[CALLEE_RN]).toContain('      body: ${{ steps.s.outputs.text }}');
    expect(job.errors).toEqual([]);
  });

  it("renames an action's input and output where a step passes (quoted or not) and reads them", async () => {
    const ACTION = '.github/actions/greet/action.yml';
    const files = {
      [ACTION]: [
        'name: greet',
        'inputs:',
        '  name:',
        '    required: true',
        'outputs:',
        '  greeting:',
        '    value: ${{ steps.s.outputs.text }}',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - id: s',
        '      shell: bash',
        '      run: echo "text=hi ${{ inputs.name }}" >> "$GITHUB_OUTPUT"',
        '',
      ].join('\n'),
      [CALLER_RN]: [
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - id: g',
        '        uses: ./.github/actions/greet',
        '        with:',
        "          'name': x",
        '      - run: echo "${{ steps.g.outputs.greeting }}"',
        '',
      ].join('\n'),
    };
    const dir = repo(files);
    const client = await start(dir);
    await client.settled();
    const input = await rename(client, dir, ACTION, position(files[ACTION]!, '  name:', 2), 'who');
    expect(renamed(dir, files, input!)[CALLER_RN]).toContain("        with:\n          'who': x\n");
    const output = await rename(
      client,
      dir,
      CALLER_RN,
      position(files[CALLER_RN]!, 'outputs.greeting', 9),
      'message',
    );
    const after = renamed(dir, files, output!);
    expect(after[ACTION]).toContain('outputs:\n  message:\n');
    expect(after[CALLER_RN]).toContain('steps.g.outputs.message');
  });

  it('prepares a rename on the name at the cursor', async () => {
    const dir = repo(RN);
    const client = await start(dir);
    await client.settled();
    const text = RN[CALLER_RN]!;
    const prepared = await client.conn.sendRequest('textDocument/prepareRename', {
      textDocument: { uri: uri(dir, CALLER_RN) },
      position: position(text, 'outputs.greeting', 9),
    });
    expect(prepared).toEqual({
      range: { start: position(text, 'greeting'), end: position(text, 'greeting', 8) },
      placeholder: 'greeting',
    });
  });

  it('refuses a rename it cannot make whole, and says why', async () => {
    const refused = async (
      files: Record<string, string>,
      rel: string,
      needle: string,
      offset: number,
      newName = 'who',
    ) => {
      const dir = repo(files);
      const client = await start(dir);
      await client.settled();
      return rename(client, dir, rel, position(files[rel]!, needle, offset), newName).then(
        () => 'renamed',
        (err: Error) => err.message,
      );
    };
    expect(await refused(RN, CALLEE_RN, '      name:', 6, '1x')).toContain('is not a valid name');
    const two = {
      ...RN,
      [CALLEE_RN]: RN[CALLEE_RN]!.replace('    inputs:\n', '    inputs:\n      who: { type: string }\n'),
    };
    expect(await refused(two, CALLEE_RN, '      name:', 6)).toContain('already has "who"');
    const bracket = { ...RN, [CALLEE_RN]: RN[CALLEE_RN]!.replace('inputs.name', "inputs['name']") };
    expect(await refused(bracket, CALLEE_RN, '      name:', 6)).toContain('rename it by hand');
    const secret = {
      [CALLER_RN]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/_callee.yml\n    secrets: inherit\n',
      [CALLEE_RN]:
        'on:\n  workflow_call:\n    secrets:\n      token: { required: false }\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ secrets.token }}"\n',
    };
    expect(await refused(secret, CALLEE_RN, '      token:', 6)).toContain('secrets: inherit');
    expect(await refused(RN, CALLEE_RN, 'steps.s.outputs.text', 17)).toContain(
      "The step's script writes this output",
    );
    const remote = {
      [CALLER_RN]:
        'on: push\njobs:\n  a:\n    uses: octo/ship/.github/workflows/deploy.yml@v1\n    with: { env: prod }\n',
      '.github/flowpact/remotes.lock.yaml': `version: 1\nremotes:\n  octo/ship/.github/workflows/deploy.yml@v1:\n    sha: ${'a'.repeat(40)}\n    kind: workflow\n    inputs: { env: { type: string, required: true } }\n`,
    };
    expect(await refused(remote, CALLER_RN, 'env: prod', 1)).toContain('declared in another repository');
  });

  it('asks to confirm a rename in a published workflow, or warns where the editor cannot ask', async () => {
    const dir = repo({ ...REPO, [CALLER]: FIXED });
    const at = position(REPO[CALLEE]!, '      name:', 6);
    const confirming = await start(dir, {}, dir, [], true);
    await confirming.settled();
    const edit = await rename(confirming, dir, CALLEE, at, 'who');
    expect(Object.values(edit!.changeAnnotations!)[0]?.needsConfirmation).toBe(true);
    const plain = await start(dir);
    await plain.settled();
    expect((await rename(plain, dir, CALLEE, at, 'who'))?.changes).toBeDefined();
    await plain.settled();
    expect(plain.shown.join('\n')).toContain('is published');
  });
});

describe('completion', () => {
  const W = '.github/workflows/ci.yml';
  const SHA = 'c'.repeat(40);
  const LOCK = [
    'version: 1',
    'remotes:',
    '  octo/setup@v2:',
    `    sha: ${SHA}`,
    '    kind: action',
    '    inputs:',
    '      version: { required: true }',
    '      cache: { type: boolean, default: false }',
    '  octo/ship/.github/workflows/deploy.yml@v1:',
    `    sha: ${SHA}`,
    '    kind: workflow',
    '    inputs:',
    '      env: { type: string, required: true }',
    '      dry-run: { type: boolean, default: false }',
    '    secrets:',
    '      token: { required: true }',
    '',
  ].join('\n');

  type Item = { label: string; detail: string; sortText: string; documentation: { value: string } };
  /** Opens the workflow as the editor has it, and asks for completion where `|` is (removed from the text). */
  async function complete(files: Record<string, string>, typed: string, settings = {}) {
    const cursor = typed.indexOf('|');
    const text = typed.slice(0, cursor) + typed.slice(cursor + 1);
    const dir = repo({ ...files, [W]: text, '.github/flowpact/remotes.lock.yaml': LOCK });
    const client = await start(dir, settings);
    await client.open(dir, W, text);
    const before = typed.slice(0, cursor).split('\n');
    const items = (await client.conn.sendRequest('textDocument/completion', {
      textDocument: { uri: uri(dir, W) },
      position: { line: before.length - 1, character: before.at(-1)!.length },
    })) as Item[] | null;
    return items && [...items].sort((a, b) => a.sortText.localeCompare(b.sortText));
  }
  const step = (lines: string[]) =>
    ['on: push', 'jobs:', '  a:', '    runs-on: ubuntu-latest', '    steps:', ...lines, ''].join('\n');

  it("offers a remote action's inputs from the lockfile, required first, leaving out those passed", async () => {
    const all = await complete({}, step(['      - uses: octo/setup@v2', '        with:', '          |']));
    expect(all?.map((i) => i.label)).toEqual(['version', 'cache']);
    expect(all?.[0]?.detail).toBe('required input of octo/setup@v2');
    expect(all?.[1]?.documentation.value).toBe('optional · boolean · default `false`');
    // A key half typed under one already passed does not parse: the offers come from the text as the editor has it.
    const rest = await complete(
      {},
      step(['      - uses: octo/setup@v2', '        with:', '          cache: true', '          ver|']),
    );
    expect(rest?.map((i) => i.label)).toEqual(['version']);
  });

  it("offers a remote reusable workflow's inputs under with: and its secrets under secrets:", async () => {
    const call = (block: string) =>
      [
        'on: push',
        'jobs:',
        '  deploy:',
        '    uses: octo/ship/.github/workflows/deploy.yml@v1',
        `    ${block}:`,
        '      |',
        '',
      ].join('\n');
    expect((await complete({}, call('with')))?.map((i) => i.label)).toEqual(['env', 'dry-run']);
    expect((await complete({}, call('secrets')))?.map((i) => i.label)).toEqual(['token']);
  });

  it('offers what a local reusable workflow or action declares', async () => {
    const files = {
      '.github/workflows/build.yml':
        'on:\n  workflow_call:\n    inputs:\n      target: { type: string, required: true, description: Where to build }\njobs: {}\n',
      '.github/actions/lint/action.yml':
        "name: lint\ninputs:\n  strict: { description: 'Fail on warnings' }\nruns:\n  using: composite\n  steps: []\n",
    };
    const call = await complete(
      files,
      [
        'on: push',
        'jobs:',
        '  b:',
        '    with:',
        '      |',
        '    uses: ./.github/workflows/build.yml',
        '',
      ].join('\n'),
    );
    expect(call?.map((i) => [i.label, i.documentation.value])).toEqual([
      ['target', 'Where to build\n\nrequired · string'],
    ]);
    const action = await complete(
      files,
      step(['      - uses: ./.github/actions/lint', '        with:', '          |']),
    );
    expect(action?.map((i) => i.label)).toEqual(['strict']);
  });

  it("adds the descriptions of a remote reference's cached source", async () => {
    const cache = repo({});
    write(cache, {
      [join('remotes', 'octo', 'setup', SHA, 'action.yml')]:
        "name: setup\ninputs:\n  version: { required: true, description: 'The version to install' }\nruns:\n  using: node24\n  main: x.js\n",
    });
    const items = await complete({}, step(['      - uses: octo/setup@v2', '        with:', '          |']), {
      cacheDir: cache,
    });
    expect(items?.[0]?.documentation.value).toBe('The version to install\n\nrequired');
  });

  it('offers nothing outside a block of a call it knows', async () => {
    expect(
      await complete({}, step(['      - uses: octo/setup@v2', '        with:', '          version: |'])),
    ).toBeNull();
    expect(
      await complete({}, step(['      - uses: elsewhere/unlocked@v1', '        with:', '          |'])),
    ).toBeNull();
    expect(await complete({}, step(['      - run: echo', '        env:', '          |']))).toBeNull();
    expect(
      await complete({}, step(['      - uses: octo/setup@v2', '        secrets:', '          |'])),
    ).toBeNull();
  });
});

describe('steps and their own env', () => {
  const W = '.github/workflows/steps.yml';
  const TEXT = [
    'on: push',
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    env:',
    '      MODE: job',
    '    steps:',
    '      - id: test',
    '        name: Unit tests',
    '        run: make test',
    '        continue-on-error: true',
    '      - env:',
    '          MODE: step',
    "        if: steps.test.outcome == 'failure'",
    '        run: echo "${{ env.MODE }} ${{ steps.test.conclusion }}"',
    '',
  ].join('\n');
  async function open() {
    const dir = repo({ [W]: TEXT });
    const client = await start(dir);
    await client.open(dir, W, TEXT);
    const request = (method: string, needle: string, extra = {}, offset = 0) =>
      client.conn.sendRequest(`textDocument/${method}`, {
        textDocument: { uri: uri(dir, W) },
        position: position(TEXT, needle, offset),
        ...extra,
      });
    return { dir, client, request };
  }
  type Range = { start: { line: number; character: number } };
  /** Where each location or location link starts, as line:character (0-based). */
  const lines = (locations: unknown) =>
    (locations as { range?: Range; targetSelectionRange?: Range }[]).map((l) => {
      const { start } = (l.range ?? l.targetSelectionRange)!;
      return `${start.line}:${start.character}`;
    });

  it("goes to a step's own env, and hovers it", async () => {
    const { request } = await open();
    expect(lines(await request('definition', 'env.MODE'))).toEqual([`${12}:10`]);
    const hover = (await request('hover', 'env.MODE')) as { contents: { value: string } };
    expect(hover.contents.value).toContain('env variable');
    expect(hover.contents.value).toContain('value `step`');
  });

  it('goes to a step from its outcome and conclusion, lists its reads, and hovers it', async () => {
    const { request } = await open();
    expect(lines(await request('definition', 'steps.test.outcome'))).toEqual(['7:12']);
    expect(lines(await request('definition', 'steps.test.conclusion'))).toEqual(['7:12']);
    const refs = await request('references', 'id: test', { context: { includeDeclaration: true } }, 4);
    expect(lines(refs)).toEqual(['7:12', '13:12', '14:39']);
    const hover = (await request('hover', 'steps.test.conclusion')) as { contents: { value: string } };
    expect(hover.contents.value).toContain('**flowpact** · step');
    expect(hover.contents.value).toContain('name `Unit tests` · runs a script');
    expect(hover.contents.value).toContain('before `continue-on-error` applies');
  });

  it('does not rename a step id', async () => {
    const { request } = await open();
    const refused = await request('rename', 'steps.test.outcome', { newName: 'unit' }).then(
      () => 'renamed',
      (e: Error) => e.message,
    );
    expect(refused).toContain('Only an input, a secret or an output can be renamed');
  });
});
