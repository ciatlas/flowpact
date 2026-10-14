/** `flowpact remotes update` against a local stand-in for the GitHub API (#152). */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
afterAll(() => new Promise<void>((r) => server.close(() => r())));

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
    env: { PATH: process.env.PATH ?? '', NO_COLOR: '1', GITHUB_API_URL: api, ...env },
  });

describe('flowpact remotes update', () => {
  it('writes the lockfile, records what it cannot read, exits 0, and lint then checks the remote step', async () => {
    const root = repo();
    const r = await run(root, ['update'], { GH_TOKEN: 's3cr3t' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`wrote ${LOCK}`);
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
    expect(() => readFileSync(join(root, LOCK))).toThrow();
    await run(root, ['update']);
    const again = await run(root, ['update']);
    expect(again.stdout).toContain(`${LOCK} is up to date`);
  });

  it('lint --fetch-remotes checks what the lockfile lacks for this run, writes nothing, and warns what it could not fetch', async () => {
    const root = repo();
    const env = { NO_COLOR: '1', GITHUB_API_URL: api, PATH: process.env.PATH ?? '' };
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
  });

  it('refuses another action', async () => {
    const r = await run(repo(), ['check']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('use `flowpact remotes update`');
  });
});
