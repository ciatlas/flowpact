/** `flowpact remotes update` against a local stand-in for the GitHub API (#152). */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BIN = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/cli/dist/index.js');
const SHA = 'a'.repeat(40);
const LOCK = '.github/flowpact/remotes.lock.yaml';

const files: Record<string, string> = {
  '/repos/octo/setup/commits/v2': SHA,
  [`/repos/octo/setup/contents/action.yml?ref=${SHA}`]:
    'name: s\ndescription: d\ninputs:\n  version: { description: v, required: true }\nruns:\n  using: composite\n  steps: []\n',
};
const auth: (string | undefined)[] = [];
/** A HOME of its own: the CLI asks `gh` for a token, which writes its state under HOME (or the working directory). */
const home = mkdtempSync(join(tmpdir(), 'flowpact-remotes-home-'));
/** The sources cache (FLOWPACT_CACHE_DIR), and where it keeps octo/setup's action.yml. */
const cache = join(home, 'cache');
const SETUP_SOURCE = join(cache, 'remotes', 'octo', 'setup', SHA, 'action.yml');
let server: Server;
let api = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    auth.push(req.headers.authorization);
    const body = files[req.url ?? ''];
    res.writeHead(body === undefined ? 404 : 200).end(body ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  rmSync(home, { recursive: true, force: true });
  await new Promise<void>((r) => server.close(() => r()));
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'flowpact-remotes-'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(root, '.github/workflows/ci.yml'),
    'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/setup@v2\n      - uses: octo/missing@v1\n',
  );
  return root;
}

const run = (root: string, args: string[], env: Record<string, string> = {}) =>
  execa('node', [BIN, 'remotes', ...args, '--root', root], {
    reject: false,
    extendEnv: false,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      NO_COLOR: '1',
      GITHUB_API_URL: api,
      FLOWPACT_CACHE_DIR: cache,
      ...env,
    },
  });

describe('flowpact remotes update', () => {
  it('writes the lockfile, records what it cannot read, exits 0, and lint then checks the remote step', async () => {
    const root = repo();
    const r = await run(root, ['update'], { GH_TOKEN: 's3cr3t' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`wrote ${LOCK}`);
    expect(r.stdout).toContain('token: GH_TOKEN');
    expect(r.stdout).toContain('new     octo/setup@v2');
    expect(r.stdout).toContain(
      'unread  octo/missing@v1: octo/missing@v1 not found, or not readable with this token',
    );
    expect(`${r.stdout}${r.stderr}`).not.toContain('s3cr3t');
    expect(auth.every((a) => a === 'Bearer s3cr3t')).toBe(true);
    expect(readFileSync(join(root, LOCK), 'utf8')).toContain(`octo/setup@v2:\n    sha: ${SHA}`);
    const lint = await execa('node', [BIN, 'lint', '--root', root, '--format', 'json'], {
      reject: false,
      env: { NO_COLOR: '1' },
    });
    const codes = JSON.parse(lint.stdout).findings.map((f: { code: string }) => f.code);
    expect(codes).toContain('FP101');
  });

  it('writes nothing with --dry-run, and says it is up to date when nothing changes', async () => {
    const root = repo();
    const dry = await run(root, ['update', '--dry-run']);
    expect(dry.stdout).toContain(`would write ${LOCK}`);
    expect(dry.stdout).toContain('token: none: public repositories only, at 60 requests an hour');
    expect(() => readFileSync(join(root, LOCK))).toThrow();
    await run(root, ['update']);
    const again = await run(root, ['update']);
    expect(again.stdout).toContain(`${LOCK} is up to date`);
  });

  it('lint --fetch-remotes checks what the lockfile lacks for this run, writes nothing, and warns what it could not fetch', async () => {
    const root = repo();
    rmSync(cache, { recursive: true, force: true });
    const env = {
      NO_COLOR: '1',
      GITHUB_API_URL: api,
      PATH: process.env.PATH ?? '',
      HOME: home,
      FLOWPACT_CACHE_DIR: cache,
    };
    const plain = await execa('node', [BIN, 'lint', '--root', root, '--format', 'json'], {
      reject: false,
      extendEnv: false,
      env,
    });
    expect(JSON.parse(plain.stdout).findings.map((f: { code: string }) => f.code)).not.toContain('FP101');
    const r = await execa('node', [BIN, 'lint', '--root', root, '--format', 'json', '--fetch-remotes'], {
      reject: false,
      extendEnv: false,
      env,
    });
    const findings = JSON.parse(r.stdout).findings as { code: string; message: string }[];
    expect(findings.filter((f) => f.code === 'FP101').map((f) => f.message)).toEqual([
      'Step #1 uses octo/setup@v2 without required input "version" — GitHub will run it with an empty value',
    ]);
    expect(r.stderr).toContain('remote interface not fetched: octo/missing@v1');
    expect(() => readFileSync(join(root, LOCK))).toThrow();
    // Fetched for this run only: nothing goes to the sources cache either.
    expect(existsSync(cache)).toBe(false);
  });

  it('fetches only what the given paths use, and refuses a path that does not exist', async () => {
    const root = repo();
    writeFileSync(
      join(root, '.github/workflows/other.yml'),
      'on: push\njobs:\n  o:\n    runs-on: x\n    steps:\n      - uses: octo/elsewhere@v9\n',
    );
    const r = await run(root, ['update', '.github/workflows/other.yml']);
    expect(r.stdout).not.toContain('octo/setup@v2');
    expect(r.stdout).toContain('unread  octo/elsewhere@v9');
    const missing = await run(root, ['update', '.github/workflows/nope.yml']);
    expect(missing.exitCode).toBe(2);
  });

  it('refuses another action', async () => {
    const r = await run(repo(), ['check']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('use `flowpact remotes update` or `flowpact remotes download`');
  });
});

describe('the sources cache', () => {
  it('keeps the files remotes update reads, unless it is a dry run', async () => {
    rmSync(cache, { recursive: true, force: true });
    const root = repo();
    const dry = await run(root, ['update', '--dry-run']);
    expect(dry.stdout).not.toContain('sources:');
    expect(existsSync(SETUP_SOURCE)).toBe(false);
    const r = await run(root, ['update']);
    expect(r.stdout).toContain(`sources: ${join(cache, 'remotes')} (1 new)`);
    expect(readFileSync(SETUP_SOURCE, 'utf8')).toBe(
      files[`/repos/octo/setup/contents/action.yml?ref=${SHA}`],
    );
  });

  it('remotes download fills the cache from the lockfile, without resolving a ref or changing the lockfile', async () => {
    const root = repo();
    await run(root, ['update']);
    const lock = readFileSync(join(root, LOCK), 'utf8');
    rmSync(cache, { recursive: true, force: true });
    const seen = auth.length;
    const r = await run(root, ['download'], { GH_TOKEN: 'dl' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`downloaded 1 source to ${join(cache, 'remotes')}`);
    expect(r.stdout).toContain('token: GH_TOKEN');
    expect(r.stdout).toContain(
      'skipped  octo/missing@v1: the lockfile records it as not readable (octo/missing@v1 not found, or not readable with this token)',
    );
    expect(existsSync(SETUP_SOURCE)).toBe(true);
    expect(auth.length - seen).toBe(1);
    expect(readFileSync(join(root, LOCK), 'utf8')).toBe(lock);
    const again = await run(root, ['download']);
    expect(again.stdout).toContain('nothing to download');
    expect(again.stdout).toContain('1 source already there');
  });

  it('keeps nothing in CI unless asked, with --cache-dir or FLOWPACT_CACHE_DIR', async () => {
    const root = repo();
    const ci = await run(root, ['update'], { CI: 'true', FLOWPACT_CACHE_DIR: '' });
    expect(ci.exitCode).toBe(0);
    expect(ci.stdout).toContain('sources: not kept in CI (CI is set): --cache-dir keeps them');
    const given = join(home, 'given');
    const asked = await run(root, ['update', '--cache-dir', given], { CI: 'true', FLOWPACT_CACHE_DIR: '' });
    expect(asked.stdout).toContain(`sources: ${join(given, 'remotes')} (1 new)`);
    expect(existsSync(join(given, 'remotes', 'octo', 'setup', SHA, 'action.yml'))).toBe(true);
    rmSync(cache, { recursive: true, force: true });
    const env = await run(root, ['update'], { CI: 'true' });
    expect(env.stdout).toContain(`sources: ${join(cache, 'remotes')} (1 new)`);
  });

  it('keeps nothing with --no-cache, which neither --cache-dir nor remotes download takes', async () => {
    rmSync(cache, { recursive: true, force: true });
    const root = repo();
    const r = await run(root, ['update', '--no-cache']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('sources:');
    expect(existsSync(cache)).toBe(false);
    expect(readFileSync(join(root, LOCK), 'utf8')).toContain('octo/setup@v2');
    const both = await run(root, ['update', '--no-cache', '--cache-dir', cache]);
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain('give --no-cache or --cache-dir, not both');
    const download = await run(root, ['download', '--no-cache']);
    expect(download.exitCode).toBe(2);
    expect(download.stderr).toContain('--no-cache is for `flowpact remotes update`');
  });

  it('remotes download takes --cache-dir, and caches in CI too: downloading is all it does', async () => {
    const root = repo();
    await run(root, ['update']);
    const given = join(home, 'download-given');
    const r = await run(root, ['download', '--cache-dir', given], { CI: 'true' });
    expect(r.stdout).toContain(`downloaded 1 source to ${join(given, 'remotes')}`);
  });

  it('keeps going when the cache cannot be written, and counts what it could not keep', async () => {
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'remotes'), '');
    const root = repo();
    const r = await run(root, ['update']);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(root, LOCK), 'utf8')).toContain('octo/setup@v2');
    expect(r.stdout).toContain(`sources: ${join(cache, 'remotes')} (0 new, 1 not kept: `);
    rmSync(cache, { recursive: true, force: true });
  });

  it('remotes download lists what it cannot download as failed, says so in its headline, and exits 1', async () => {
    const root = repo();
    await run(root, ['update']);
    writeFileSync(join(root, LOCK), readFileSync(join(root, LOCK), 'utf8').replaceAll(SHA, 'b'.repeat(40)));
    const r = await run(root, ['download']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(`downloaded 0 of 1 source to ${join(cache, 'remotes')}`);
    expect(r.stdout).toContain(
      'failed   octo/setup@v2: no action.yml in the repository root at bbbbbbb, or not readable with this token',
    );
  });

  it('shows control characters from the lockfile and the YAML instead of sending them to the terminal', async () => {
    rmSync(cache, { recursive: true, force: true });
    const root = repo();
    writeFileSync(
      join(root, '.github/workflows/ci.yml'),
      'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/setup@v2\n      - uses: "octo/esc\\e]0;T\\a@v1"\n',
    );
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(
      join(root, LOCK),
      [
        'version: 1',
        'remotes:',
        '  octo/setup@v2:',
        `    sha: ${SHA}`,
        '    kind: action',
        '    host: "evil\\e]0;PWNED\\a\\e[2J"',
        'unreadable:',
        '  "octo/esc\\e]0;T\\a@v1": "gone\\e[31m"',
        '',
      ].join('\n'),
    );
    const r = await run(root, ['download', '-d']);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u0007');
    expect(r.stdout).toContain('on evil\\x1b]0;PWNED\\x07\\x1b[2J, which this run does not read');
    expect(r.stdout).toContain(
      'octo/esc\\x1b]0;T\\x07@v1: the lockfile records it as not readable (gone\\x1b[31m)',
    );
  });

  it('remotes download looks on github.com only with --github-com', async () => {
    const root = repo();
    await run(root, ['update']);
    const on = await run(root, ['download', '--github-com', '-d']);
    expect(on.stderr).toContain('also looking on github.com, with no token');
    const off = await run(root, ['download', '-d']);
    expect(off.stderr).not.toContain('also looking on github.com');
  });

  it('remotes download needs a lockfile it can use, and takes no --dry-run', async () => {
    const none = await run(repo(), ['download']);
    expect(none.exitCode).toBe(2);
    expect(none.stderr).toContain('no remotes lockfile: run `flowpact remotes update`');
    const broken = repo();
    mkdirSync(join(broken, '.github/flowpact'), { recursive: true });
    writeFileSync(
      join(broken, LOCK),
      'version: 1\nremotes:\n  octo/setup@v2:\n    sha: nope\n    kind: action\n',
    );
    const bad = await run(broken, ['download']);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain(`${LOCK} cannot be used: remotes.octo/setup@v2.sha`);
    const dry = await run(repo(), ['download', '--dry-run']);
    expect(dry.exitCode).toBe(2);
    expect(dry.stderr).toContain('--dry-run is for `flowpact remotes update`');
  });
});
