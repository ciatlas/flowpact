import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { readSettings, startServer } from '@flowpact/language-server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConnection,
  createProtocolConnection,
  type Diagnostic,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidChangeWatchedFilesNotification,
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
  settled(): Promise<void>;
  /** The diagnostics of a file once the server has analyzed every pending edit. */
  diagnosticsOf(dir: string, rel: string): Promise<Diagnostic[]>;
  open(dir: string, rel: string, text: string): Promise<void>;
  dispose(): void;
}

async function start(dir: string, settings: Record<string, unknown> = {}, folder = dir): Promise<Client> {
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
      workspace: { workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: true } },
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

  it('answers nothing where no symbol is written', async () => {
    const { dir, client } = await ready();
    const at = { textDocument: { uri: uri(dir, CALLEE) }, position: position(REPO[CALLEE]!, 'runs-on') };
    expect(await client.conn.sendRequest('textDocument/hover', at)).toBeNull();
    expect(await client.conn.sendRequest('textDocument/definition', at)).toBeNull();
    const elsewhere = { textDocument: { uri: 'untitled:Untitled-1' }, position: { line: 0, character: 0 } };
    expect(await client.conn.sendRequest('textDocument/hover', elsewhere)).toBeNull();
  });
});

describe('readSettings', () => {
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
