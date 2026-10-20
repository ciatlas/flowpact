/** `flowpact remotes update` against a local stand-in for the GitHub API (#152). */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BIN = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/cli/dist/index.js');
const SHA = 'a'.repeat(40);
/** octo/setup@v3, which renames v2's `version` input to `node-version`. */
const SHA3 = 'c'.repeat(40);
const LOCK = '.github/flowpact/remotes.lock.yaml';

const setupAction = (input: string) =>
  `name: s\ndescription: d\ninputs:\n  ${input}: { description: v, required: true }\nruns:\n  using: composite\n  steps: []\n`;
const files: Record<string, string> = {
  '/repos/octo/setup/commits/v2': SHA,
  [`/repos/octo/setup/contents/action.yml?ref=${SHA}`]: setupAction('version'),
  '/repos/octo/setup/commits/v3': SHA3,
  [`/repos/octo/setup/contents/action.yml?ref=${SHA3}`]: setupAction('node-version'),
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
    // Before fetching: which API, and where the token came from.
    expect(r.stderr).toContain(`GitHub API: ${api} (GITHUB_API_URL)\ntoken: GH_TOKEN`);
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
    expect(r.stderr).toContain(`GitHub API: ${api} (GITHUB_API_URL)`);
    expect(r.stderr).toContain(
      'what to check:\n  • some references are not on 127.0.0.1, or not readable: actions from github.com',
    );
    expect(r.stderr).toContain('GitHub Enterprise Server  GITHUB_API_URL=https://127.0.0.1/api/v3');
    expect(() => readFileSync(join(root, LOCK))).toThrow();
    // Fetched for this run only: nothing goes to the sources cache either.
    expect(existsSync(cache)).toBe(false);
  });

  it('says what to check when the API cannot be reached, after saying why it tries again', async () => {
    const root = repo();
    // A port nothing listens on any more.
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const down = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((r) => closed.close(() => r()));
    const r = await run(root, ['update', '--dry-run'], { GH_TOKEN: 's3cr3t', GITHUB_API_URL: down });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`${down.slice(7)}: connection refused; trying again (attempt 2 of 3)`);
    expect(r.stdout).toContain(
      `what to check:\n  • could not reach ${down} (GITHUB_API_URL): check that it is the API`,
    );
    expect(r.stdout).toContain('where flowpact reads remote repositories, and with which token:');
    expect(r.stdout).toContain('github.com                GITHUB_API_URL not set');
    expect(`${r.stdout}${r.stderr}`).not.toContain('s3cr3t');
    const json = await run(root, ['update', '--dry-run', '--format', 'json'], {
      GH_TOKEN: 's3cr3t',
      GITHUB_API_URL: down,
    });
    const result = JSON.parse(json.stdout);
    expect(result.apiUrl).toBe(down);
    expect(result.failed.map((f: { kind: string }) => f.kind)).toEqual(['unreachable', 'unreachable']);
    expect(result.hints).toHaveLength(1);
    expect(result.guide).toHaveLength(3);
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

  it("runs none of the repository's plugins: it runs no rule", async () => {
    const root = repo();
    const marker = join(root, 'plugin-ran');
    writeFileSync(
      join(root, 'plugin.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default { code: 'ACME601', name: 'acme', category: 'structure', defaultSeverity: 'error', docsUrl: 'https://x', docs: { summary: 's', why: 'w', fix: 'f' }, check() {} };\n`,
    );
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(
      join(root, '.github/flowpact/flowpact.config.yml'),
      'plugins: [./plugin.mjs]\nrules:\n  acme: warning\n',
    );
    const r = await run(root, ['update']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(r.stderr).not.toContain('plugin');
    const d = await run(root, ['download']);
    expect(d.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("reads a reference at the commit GitHub's actions.lock pins, and says so", async () => {
    const D = 'd'.repeat(40);
    files[`/repos/octo/setup/contents/action.yml?ref=${D}`] =
      'name: s\ndescription: d\ninputs:\n  version: { description: v }\nruns:\n  using: composite\n  steps: []\n';
    const root = repo();
    const pin = (version: string) =>
      `version: '${version}'\nworkflows:\n  '.github/workflows/ci.yml':\n    - 'octo/setup@v2'\ndependencies:\n  'octo/setup@v2':\n    ref: 'v2'\n    commit: 'sha1-${D}'\n    owner_id: 1\n    repo_id: 2\n`;
    writeFileSync(join(root, '.github/workflows/actions.lock'), pin('v0.0.3'));
    const r = await run(root, ['update']);
    expect(r.stdout).toContain('.github/workflows/actions.lock: 1 reference read at the commit it pins');
    expect(readFileSync(join(root, LOCK), 'utf8')).toContain(`octo/setup@v2:\n    sha: ${D}`);
    writeFileSync(join(root, '.github/workflows/actions.lock'), pin('v9'));
    const unknown = await run(root, ['update', '--dry-run']);
    expect(unknown.stdout).toContain(
      '.github/workflows/actions.lock: not used, version v9 is not one flowpact reads (v0.0.x)',
    );
    expect(unknown.stdout).toContain(`changed octo/setup@v2: ddddddd → ${SHA.slice(0, 7)}`);
  });

  it('refuses another action', async () => {
    const r = await run(repo(), ['check']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('use `flowpact remotes update`, `download` or `clean`');
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

  it('keeps the 3 most recently used commits of each repository it uses, and remotes clean empties the cache', async () => {
    rmSync(cache, { recursive: true, force: true });
    const ship = join(cache, 'remotes', 'octo', 'setup');
    for (const [i, c] of ['1', '2', '3', '4'].entries()) {
      mkdirSync(join(ship, c.repeat(40)), { recursive: true });
      writeFileSync(join(ship, c.repeat(40), 'action.yml'), c);
      const at = new Date(1_700_000_000_000 + i * 1000);
      utimesSync(join(ship, c.repeat(40)), at, at);
    }
    const root = repo();
    const r = await run(root, ['update']);
    expect(r.stdout).toContain(`sources: ${join(cache, 'remotes')} (1 new, 2 old commits removed)`);
    expect(readdirSync(ship).sort()).toEqual(['3'.repeat(40), '4'.repeat(40), SHA]);
    const keep = await run(root, ['clean', '--keep', '1']);
    expect(keep.stdout).toContain(`removed 2 cached commits from ${join(cache, 'remotes')}`);
    expect(keep.stdout).toContain('kept the 1 most recently used of each repository');
    expect(readdirSync(ship)).toEqual([SHA]);
    const all = await run(root, ['clean']);
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain('removed 1 cached commit from');
    expect(existsSync(ship)).toBe(false);
    expect((await run(root, ['clean'])).stdout).toContain('nothing to remove in');
  });

  it('remotes clean takes no paths, --dry-run, --no-cache or a --keep that is not a whole number; --keep is for clean', async () => {
    const root = repo();
    for (const args of [
      ['clean', '.github/workflows/ci.yml'],
      ['clean', '--dry-run'],
      ['clean', '--no-cache'],
      ['clean', '--keep', 'two'],
      ['update', '--keep', '2'],
    ])
      expect((await run(root, args)).exitCode, args.join(' ')).toBe(2);
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

describe('what a changed entry does to the calls', () => {
  /** A repository that locked octo/setup@v2 at an older commit, whose action took a `cache` input; v2 has since moved. */
  function drifted(): string {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-remotes-drift-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/ci.yml'),
      'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/setup@v2\n        with: { version: 1, cache: x }\n      - uses: octo/setup@v2\n        with: { version: 2 }\n',
    );
    writeFileSync(
      join(root, LOCK),
      `version: 1\nremotes:\n  octo/setup@v2:\n    sha: ${'b'.repeat(40)}\n    kind: action\n    using: composite\n    inputs:\n      version: { required: true }\n      cache: {}\n`,
    );
    return root;
  }

  it('grades it against every call, on a dry run, without failing unless --fail-on asks', async () => {
    const root = drifted();
    const before = readFileSync(join(root, LOCK), 'utf8');
    const r = await run(root, ['update', '--dry-run']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      [
        `  changed octo/setup@v2: bbbbbbb → aaaaaaa, breaks 1 of 2 calls`,
        `    input "cache" was removed — steps that pass it get a warning, and their value is ignored`,
        `    breaks .github/workflows/ci.yml:6 jobs.b step #1`,
        `      FP102 octo/setup@v2 has no input "cache"`,
        `    1 other call fits`,
      ].join('\n'),
    );
    expect(readFileSync(join(root, LOCK), 'utf8')).toBe(before);
    expect((await run(root, ['update', '--dry-run', '--fail-on', 'breaks'])).exitCode).toBe(1);
    expect((await run(root, ['update', '--dry-run', '--fail-on', 'never'])).exitCode).toBe(0);
  });

  it('prints the grades as JSON, and grades a real update too', async () => {
    const root = drifted();
    const r = await run(root, ['update', '--format', 'json', '--fail-on', 'unchecked']);
    expect(r.exitCode).toBe(1);
    const result = JSON.parse(r.stdout);
    expect(result).toMatchObject({ changed: ['octo/setup@v2'], dryRun: false, changes: true });
    expect(result.grades).toHaveLength(1);
    expect(result.grades[0]).toMatchObject({
      ref: 'octo/setup@v2',
      commits: { before: 'b'.repeat(40), after: SHA },
      verdict: 'breaks',
    });
    expect(result.grades[0].calls.map((c: { verdict: string }) => c.verdict)).toEqual(['breaks', 'fits']);
    expect(result.grades[0].calls[0].added[0]).toMatchObject({ code: 'FP102', loc: { line: 7 } });
    expect(readFileSync(join(root, LOCK), 'utf8')).toContain(`sha: ${SHA}`);
  });

  it('prints download and clean as JSON too, and takes --fail-on only for update', async () => {
    const root = drifted();
    const clean = await run(root, ['clean', '--format', 'json']);
    expect(JSON.parse(clean.stdout)).toMatchObject({ dir: join(cache, 'remotes'), keep: 0 });
    const refused = await run(root, ['download', '--fail-on', 'breaks']);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('--fail-on is for `flowpact remotes update`');
  });
});

describe('lint --fetch-remotes on a pull request', () => {
  /**
   * A repository whose branch moves octo/setup from v2 to v3 and records v3 in its lockfile with v2's interface: the
   * analysis, which reads the lockfile, sees no break, while the version change, always fetched, does.
   */
  function bumped(): { root: string; base: string } {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-remotes-versions-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
    const ci = (v: string) =>
      `on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/setup@${v}\n        with: { version: '1' }\n`;
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, '.github/workflows/ci.yml'), ci('v2'));
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'bump');
    writeFileSync(join(root, '.github/workflows/ci.yml'), ci('v3'));
    mkdirSync(join(root, '.github/flowpact'));
    writeFileSync(
      join(root, LOCK),
      `version: 1\nremotes:\n  octo/setup@v3:\n    sha: ${SHA3}\n    kind: action\n    using: composite\n    inputs:\n      version: { required: true }\n`,
    );
    git('add', '-A');
    git('commit', '-q', '-m', 'bump');
    return { root, base };
  }

  const lint = (root: string, args: string[], env: Record<string, string> = {}) =>
    execa('node', [BIN, 'lint', '--root', root, '--fetch-remotes', ...args], {
      reject: false,
      extendEnv: false,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        NO_COLOR: '1',
        GITHUB_API_URL: api,
        GH_TOKEN: 't',
        ...env,
      },
    });

  it('grades the references the branch moves to another version, and fails when one breaks a call', async () => {
    const { root, base } = bumped();
    const r = await lint(root, ['--base', 'main']);
    expect(r.stdout).toContain('No problems found');
    expect(r.stdout).toContain(
      [
        `version changes from ${base.slice(0, 7)}: 1 call broken`,
        `  octo/setup@v3 (from octo/setup@v2): aaaaaaa → ccccccc, breaks 1 of 1 call`,
        `    input "version" was removed — steps that pass it get a warning, and their value is ignored`,
        `    input "node-version" was added and must be passed — existing callers do not pass it`,
        `    breaks .github/workflows/ci.yml:6 jobs.b step #1`,
        `      FP101 Step #1 uses octo/setup@v3 without required input "node-version" — GitHub will run it with an empty value`,
        `      FP102 octo/setup@v3 has no input "version"`,
      ].join('\n'),
    );
    expect(r.exitCode).toBe(1);
    expect((await lint(root, ['--base', 'main', '--fail-on', 'never'])).exitCode).toBe(0);
    // Beside a data format on stdout, the grades go to stderr; the report itself stays as it was.
    const json = await lint(root, ['--base', 'main', '--format', 'json']);
    expect(JSON.parse(json.stdout).findings).toEqual([]);
    expect(json.stderr).toContain(`version changes from ${base.slice(0, 7)}: 1 call broken`);
    expect(json.exitCode).toBe(1);
    // In the Markdown report, as the action's job summary has them.
    const markdown = await lint(root, ['--base', 'main', '--format', 'markdown']);
    expect(markdown.stdout).toContain('### Version changes');
    expect(markdown.stderr).not.toContain('version changes from');
    // Without a base, nothing is graded.
    expect(await lint(root, [])).toMatchObject({
      exitCode: 0,
      stderr: expect.not.stringContaining('version changes'),
    });
  });

  it('grades from the pull request base in GitHub Actions, but not on pull_request_target', async () => {
    const { root, base } = bumped();
    const event = join(mkdtempSync(join(tmpdir(), 'flowpact-remotes-event-')), 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base } } }));
    const actions = (name: string) => ({
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: name,
      GITHUB_EVENT_PATH: event,
    });
    const pr = await lint(root, [], actions('pull_request'));
    expect(pr.stdout).toContain(`version changes from ${base.slice(0, 7)}: 1 call broken`);
    expect(pr.exitCode).toBe(1);
    const target = await lint(root, [], actions('pull_request_target'));
    expect(target.stdout).not.toContain('version changes');
    expect(target.stderr).toContain(
      'version changes: not graded on pull_request_target, whose checkout may be untrusted',
    );
    expect(target.exitCode).toBe(0);
  });
});
