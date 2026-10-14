/** Fetching remote interfaces (#152): `updateRemotesLock` against a fake GitHub API. */

import { parseRemoteRef, type RemotesLock, serializeRemotesLock, updateRemotesLock } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { lint, WF, yaml } from './helpers';

const SHA = (c: string) => c.repeat(40);
const DEPLOY = yaml`
  on:
    workflow_call:
      inputs:
        env: { type: string, required: true }
        level: { type: choice, required: false, default: low, options: [low, high] }
      secrets:
        token: { required: true }
      outputs:
        url: { value: x }
  jobs: {}
`;
const SETUP = yaml`
  name: setup
  description: d
  inputs:
    version: { description: v, required: true }
  outputs:
    path: { description: p }
  runs:
    using: node24
    main: index.js
`;

/** A fake GitHub API: commits by ref, files by `<owner>/<repo>/<path>@<sha>`; records every request. */
function fakeApi(commits: Record<string, string>, files: Record<string, string>) {
  const seen: { url: string; auth?: string }[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({
      url: url.href,
      ...(headers.get('authorization') ? { auth: headers.get('authorization')! } : {}),
    });
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(commits|contents)\/(.+)$/.exec(decodeURIComponent(url.pathname));
    const key =
      m &&
      (m[3] === 'commits'
        ? `${m[1]}/${m[2]}@${m[4]}`
        : `${m[1]}/${m[2]}/${m[4]}@${url.searchParams.get('ref')}`);
    const body = key ? (m![3] === 'commits' ? commits[key] : files[key]) : undefined;
    return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const caller = yaml`
  on: push
  jobs:
    deploy:
      uses: octo/ship/.github/workflows/deploy.yml@v1
    build:
      runs-on: x
      steps:
        - uses: octo/setup@v2
        - uses: Octo/Setup@v2
        - uses: docker://alpine:3
        - uses: octo/gone@v1
`;

describe('updateRemotesLock', () => {
  const api = fakeApi(
    { 'octo/ship@v1': SHA('a'), 'octo/setup@v2': SHA('b') },
    {
      [`octo/ship/.github/workflows/deploy.yml@${SHA('a')}`]: DEPLOY,
      [`octo/setup/action.yaml@${SHA('b')}`]: SETUP,
    },
  );
  const index = lint({ [`${WF}/ci.yml`]: caller }).index;

  it('records the interface of every remote reference at the commit it resolves to', async () => {
    const u = await updateRemotesLock(index, undefined, { fetch: api.fetch, token: 't0k3n' });
    expect(u.lock.remotes).toEqual({
      'octo/ship/.github/workflows/deploy.yml@v1': {
        sha: SHA('a'),
        kind: 'workflow',
        inputs: {
          env: { type: 'string', required: true },
          level: { type: 'choice', default: 'low', options: ['low', 'high'] },
        },
        secrets: { token: { required: true } },
        outputs: ['url'],
      },
      'octo/setup@v2': {
        sha: SHA('b'),
        kind: 'action',
        using: 'node24',
        inputs: { version: { required: true } },
        outputs: ['path'],
      },
    });
    expect(u.added).toEqual(['octo/setup@v2', 'octo/ship/.github/workflows/deploy.yml@v1']);
    expect(u.failed).toEqual([]);
    expect(u.unreadable).toEqual([
      { ref: 'octo/gone@v1', error: 'octo/gone@v1 not found, or not readable with this token' },
    ]);
    // Without an entry, it is recorded, so FP612 counts it as accounted for.
    expect(u.lock.unreadable).toEqual({
      'octo/gone@v1': 'octo/gone@v1 not found, or not readable with this token',
    });
  });

  it('sends the token to the API only, and reads action.yml before action.yaml', async () => {
    const seen = api.seen.splice(0);
    expect(seen.every((r) => r.url.startsWith('https://api.github.com/') && r.auth === 'Bearer t0k3n')).toBe(
      true,
    );
    expect(seen.map((r) => new URL(r.url).pathname)).toContain('/repos/octo/setup/contents/action.yml');
  });

  it('keeps a previous entry it cannot fetch, drops entries nothing uses, and reports changes', async () => {
    const previous: RemotesLock = {
      version: 1,
      remotes: {
        'octo/gone@v1': { sha: SHA('c'), kind: 'action', inputs: {}, outputs: [] },
        'octo/old@v1': { sha: SHA('d'), kind: 'action', inputs: {}, outputs: [] },
        'OCTO/SETUP@v2': { sha: SHA('e'), kind: 'action', inputs: {}, outputs: [] },
      },
    };
    const u = await updateRemotesLock(index, previous, { fetch: api.fetch });
    expect(Object.keys(u.lock.remotes).sort()).toEqual([
      'octo/gone@v1',
      'octo/setup@v2',
      'octo/ship/.github/workflows/deploy.yml@v1',
    ]);
    expect(u.lock.remotes['octo/gone@v1']!.sha).toBe(SHA('c'));
    expect(u).toMatchObject({
      added: ['octo/ship/.github/workflows/deploy.yml@v1'],
      changed: ['octo/setup@v2'],
      removed: ['octo/old@v1'],
    });
  });

  it('writes a lockfile flowpact reads back, sorted, with a header', async () => {
    const u = await updateRemotesLock(index, undefined, { fetch: api.fetch });
    const text = serializeRemotesLock(u.lock);
    expect(text.startsWith('# Generated by flowpact')).toBe(true);
    const findings = lint({ [`${WF}/ci.yml`]: caller, '.github/flowpact/remotes.lock.yaml': text }).findings;
    expect(findings.filter((f) => f.code === 'FP611')).toEqual([]);
    expect(findings.filter((f) => f.code === 'FP101').map((f) => f.message)).toContain(
      'jobs.deploy calls octo/ship/.github/workflows/deploy.yml@v1 without required input "env"',
    );
  });
});

describe('parseRemoteRef', () => {
  it('splits owner, repository, path and ref, and refuses what is not a remote reference', () => {
    expect(parseRemoteRef('octo/ship/.github/workflows/d.yml@v1', 'workflow')).toMatchObject({
      owner: 'octo',
      repo: 'ship',
      path: '.github/workflows/d.yml',
      ref: 'v1',
    });
    expect(parseRemoteRef('octo/setup@v2', 'action')).toMatchObject({ path: '', ref: 'v2' });
    for (const bad of ['docker://alpine:3', 'octo/setup', './local', 'octo@v1'])
      expect(parseRemoteRef(bad, 'action')).toBeUndefined();
  });
});

describe('fetchRemoteEntry limits', () => {
  it('refuses a response over 1 MB', async () => {
    const big = (async (input: string | URL) =>
      String(input).includes('/commits/')
        ? new Response(SHA('a'))
        : new Response(`# ${'x'.repeat(1_000_001)}`)) as typeof globalThis.fetch;
    const index = lint({
      [`${WF}/ci.yml`]: 'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/big@v1\n',
    }).index;
    const u = await updateRemotesLock(index, undefined, { fetch: big });
    expect(u.failed).toEqual([{ ref: 'octo/big@v1', error: 'a response over 1000000 bytes' }]);
  });
});

describe('unreadable references', () => {
  it('takes a SHA that is no commit of the repository (422) as not found, and a server error as a failure', async () => {
    const api = (async (input: string | URL) =>
      String(input).includes('/repos/octo/odd/')
        ? new Response('', { status: 422 })
        : new Response('', { status: 502, statusText: 'Bad Gateway' })) as typeof globalThis.fetch;
    const index = lint({
      [`${WF}/ci.yml`]:
        'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/odd@0123\n      - uses: octo/down@v1\n',
    }).index;
    const u = await updateRemotesLock(index, undefined, { fetch: api });
    expect(u.unreadable).toEqual([
      { ref: 'octo/odd@0123', error: 'octo/odd@0123 not found, or not readable with this token' },
    ]);
    expect(u.failed).toEqual([{ ref: 'octo/down@v1', error: '502 Bad Gateway from the GitHub API' }]);
    expect(Object.keys(u.lock.unreadable ?? {})).toEqual(['octo/odd@0123']);
  });

  it('keeps FP612 quiet for a reference the lockfile records as unreadable, and writes it back sorted', async () => {
    const files = {
      [`${WF}/ci.yml`]: 'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/private@v1\n',
      '.github/flowpact/remotes.lock.yaml': serializeRemotesLock({
        version: 1,
        remotes: {},
        unreadable: { 'octo/private@v1': 'not readable' },
      }),
    };
    expect(files['.github/flowpact/remotes.lock.yaml']).toContain(
      'unreadable:\n  octo/private@v1: not readable',
    );
    const findings = lint(files).findings.map((f) => f.code);
    expect(findings).not.toContain('FP612');
    expect(findings).not.toContain('FP611');
  });
});

describe('updateRemotesLock with paths', () => {
  const files = {
    [`${WF}/a.yml`]: 'on: push\njobs:\n  c:\n    uses: ./.github/workflows/_inner.yml\n',
    [`${WF}/_inner.yml`]:
      'on: workflow_call\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/setup@v2\n',
    [`${WF}/b.yml`]: 'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/other@v1\n',
  };
  const api = fakeApi(
    { 'octo/setup@v2': SHA('b'), 'octo/other@v1': SHA('c') },
    {
      [`octo/setup/action.yml@${SHA('b')}`]: SETUP,
      [`octo/other/action.yml@${SHA('c')}`]: SETUP,
    },
  );
  const previous: RemotesLock = {
    version: 1,
    remotes: {
      'octo/other@v1': { sha: SHA('d'), kind: 'action', inputs: {}, outputs: [] },
      'octo/unused@v1': { sha: SHA('e'), kind: 'action', inputs: {}, outputs: [] },
    },
    unreadable: { 'octo/private@v1': 'not readable' },
  };

  it('fetches only what the given workflows reach, keeps other entries, and drops only what nothing uses', async () => {
    api.seen.length = 0;
    const index = lint(files, { paths: [`${WF}/a.yml`] }).index;
    const u = await updateRemotesLock(index, previous, { fetch: api.fetch });
    // a.yml reaches octo/setup@v2 through _inner.yml; b.yml's octo/other@v1 is not fetched and keeps its entry.
    expect(api.seen.map((r) => new URL(r.url).pathname)).not.toContain('/repos/octo/other/commits/v1');
    expect(u.added).toEqual(['octo/setup@v2']);
    expect(u.lock.remotes['octo/other@v1']!.sha).toBe(SHA('d'));
    expect(u.removed).toEqual(['octo/unused@v1']);
    expect(Object.keys(u.lock.remotes).sort()).toEqual(['octo/other@v1', 'octo/setup@v2']);
    // octo/private@v1 is used nowhere: it goes with the rest.
    expect(u.lock.unreadable).toBeUndefined();
  });

  it('keeps an unreadable reference used outside the paths', async () => {
    const withPrivate = {
      ...files,
      [`${WF}/b.yml`]: `${files[`${WF}/b.yml`]}      - uses: octo/private@v1\n`,
    };
    const u = await updateRemotesLock(lint(withPrivate, { paths: [`${WF}/a.yml`] }).index, previous, {
      fetch: api.fetch,
    });
    expect(u.lock.unreadable).toEqual({ 'octo/private@v1': 'not readable' });
  });
});

describe('fetch errors say why and what to do, and progress is reported', () => {
  const index = () =>
    lint({
      [`${WF}/ci.yml`]: 'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/setup@v2\n',
    }).index;
  const failing = (fail: () => Response | never) =>
    (async () => fail()) as unknown as typeof globalThis.fetch;
  const error = async (fail: () => Response | never, token?: string) =>
    (await updateRemotesLock(index(), undefined, { fetch: failing(fail), ...(token ? { token } : {}) }))
      .failed[0]?.error;

  it('names the network error behind `fetch failed`, and a timeout', async () => {
    const offline = () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    };
    expect(await error(offline)).toBe(
      'could not reach https://api.github.com (ENOTFOUND): check the network and GITHUB_API_URL; behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1',
    );
    const slow = () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    };
    expect(await error(slow)).toBe(
      'no answer from https://api.github.com within 30 s: check the network, or try again',
    );
  });

  it('says what to do about a rejected token, a used-up rate limit and a refused request', async () => {
    expect(await error(() => new Response('', { status: 401 }), 't')).toBe(
      'the GitHub API rejected the token (401): check GH_TOKEN or GITHUB_TOKEN, or run `gh auth status`',
    );
    const limited = () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    expect(await error(limited)).toBe(
      'the GitHub API rate limit is used up (403): without a token it allows 60 requests an hour; set GH_TOKEN or GITHUB_TOKEN, or sign in with `gh auth login`',
    );
    expect(await error(() => new Response('', { status: 403 }), 't')).toBe(
      "the GitHub API refused the request (403): the token needs read access to the repository's contents",
    );
  });

  it('reports progress for each reference as it is done', async () => {
    const seen: string[] = [];
    const api = fakeApi({ 'octo/setup@v2': SHA('b') }, { [`octo/setup/action.yml@${SHA('b')}`]: SETUP });
    await updateRemotesLock(lint({ [`${WF}/ci.yml`]: caller }).index, undefined, {
      fetch: api.fetch,
      onProgress: (p) => seen.push(`${p.done}/${p.total} ${p.ref} ${p.outcome}`),
    });
    expect(seen).toHaveLength(3);
    expect(seen.at(-1)).toMatch(/^3\/3 /);
    expect(seen.some((line) => /^[123]\/3 octo\/setup@v2 fetched$/.test(line))).toBe(true);
  });
});

describe('an unchanged entry read back from the lockfile', () => {
  it('is not reported as changed, whatever the order of its keys', async () => {
    const api = fakeApi({ 'octo/setup@v2': SHA('b') }, { [`octo/setup/action.yml@${SHA('b')}`]: SETUP });
    const index = lint({
      [`${WF}/ci.yml`]: 'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/setup@v2\n',
    }).index;
    const first = await updateRemotesLock(index, undefined, { fetch: api.fetch });
    const files = { '.github/flowpact/remotes.lock.yaml': serializeRemotesLock(first.lock) };
    const { readRemotesLock } = await import('@flowpact/lint');
    const { memoryFileSystem } = await import('@ciatlas/core');
    const again = await updateRemotesLock(index, readRemotesLock(memoryFileSystem(files)).lock, {
      fetch: api.fetch,
    });
    expect(again).toMatchObject({ added: [], changed: [], removed: [] });
  });
});
