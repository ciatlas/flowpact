/** Fetching remote interfaces (#152): `updateRemotesLock` against a fake GitHub API. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cachedSource,
  commitOf,
  downloadRemoteSources,
  type FetchedSource,
  hostOf,
  parseRemoteRef,
  type RemotesLock,
  serializeRemotesLock,
  updateRemotesLock,
} from '@flowpact/lint';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('a 404 the GitHub API answers now and then', () => {
  const index = () =>
    lint({
      [`${WF}/ci.yml`]: 'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/setup@v2\n',
    }).index;

  /** The fake API, answering 404 the first time each URL whose path matches `flaky` is asked for. */
  function flaky(api: ReturnType<typeof fakeApi>, matches: RegExp) {
    const asked = new Set<string>();
    return (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (matches.test(new URL(url).pathname) && !asked.has(url)) {
        asked.add(url);
        return new Response('', { status: 404 });
      }
      return api.fetch(input, init);
    }) as typeof globalThis.fetch;
  }

  it('asks once more for a file or a commit, rather than recording the reference as unreadable', async () => {
    const api = fakeApi({ 'octo/setup@v2': SHA('b') }, { [`octo/setup/action.yml@${SHA('b')}`]: SETUP });
    for (const matches of [/\/contents\//, /\/commits\//]) {
      const u = await updateRemotesLock(index(), undefined, { fetch: flaky(api, matches), retryDelayMs: 0 });
      expect(u.unreadable).toEqual([]);
      expect(u.lock.remotes['octo/setup@v2']?.sha).toBe(SHA('b'));
    }
  });

  it('still records a reference that is not there as unreadable, after one more request', async () => {
    const api = fakeApi({}, {});
    const u = await updateRemotesLock(index(), undefined, { fetch: api.fetch, retryDelayMs: 0 });
    expect(u.unreadable.map((p) => p.ref)).toEqual(['octo/setup@v2']);
    expect(api.seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/repos/octo/setup/commits/v2',
      '/repos/octo/setup/commits/v2',
    ]);
  });
});

describe('failures that pass', () => {
  const index = () =>
    lint({
      [`${WF}/ci.yml`]: 'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: octo/setup@v2\n',
    }).index;
  const github = () =>
    fakeApi({ 'octo/setup@v2': SHA('b') }, { [`octo/setup/action.yml@${SHA('b')}`]: SETUP });

  /** The fake API, after these answers to the first requests (an Error is the network's). */
  function first(answers: (Response | Error)[], api = github()) {
    let n = 0;
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      n++;
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? api.fetch(input, init);
    }) as typeof globalThis.fetch;
    return { fetch, sent: () => n };
  }
  const update = (fetch: typeof globalThis.fetch) =>
    updateRemotesLock(index(), undefined, { fetch, retryDelayMs: 0 });
  const status = (code: number, headers: Record<string, string> = {}) =>
    new Response('', { status: code, headers });

  it('sends a request again after a server error or no answer, three times at most', async () => {
    for (const failure of [status(502), status(503), new TypeError('fetch failed')]) {
      const api = first([failure]);
      const u = await update(api.fetch);
      expect(u.lock.remotes['octo/setup@v2']?.sha).toBe(SHA('b'));
      expect(api.sent()).toBe(3); // the failure, then the commit and the file
    }
    const down = first([status(503), status(503), status(503)]);
    const u = await update(down.fetch);
    expect(u.failed).toEqual([{ ref: 'octo/setup@v2', error: '503 from the GitHub API' }]);
    expect(down.sent()).toBe(3);
  });

  it('waits as long as the secondary rate limit asks, up to a minute', async () => {
    const soon = first([status(403, { 'retry-after': '0' }), status(429)]);
    expect((await update(soon.fetch)).lock.remotes['octo/setup@v2']?.sha).toBe(SHA('b'));
    expect(soon.sent()).toBe(4);
    const later = first([status(429, { 'retry-after': '3600' })]);
    expect((await update(later.fetch)).failed).toEqual([
      { ref: 'octo/setup@v2', error: 'the GitHub API asks to slow down (429): try again in 3600 s' },
    ]);
    expect(later.sent()).toBe(1);
  });

  it('does not send again what another try cannot change', async () => {
    const usedUp = status(403, { 'x-ratelimit-remaining': '0' });
    for (const [answer, error] of [
      [status(401), /rejected the token/],
      [status(403), /needs read access/],
      [usedUp, /rate limit is used up/],
      [status(429, { 'x-ratelimit-remaining': '0' }), /rate limit is used up/],
    ] as const) {
      const api = first([answer]);
      expect((await update(api.fetch)).failed[0]?.error).toMatch(error);
      expect(api.sent()).toBe(1);
    }
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

describe('GitHub Enterprise Server and github.com through GitHub Connect', () => {
  const GHES = 'https://ghes.example/api/v3';
  const index = () =>
    lint({
      [`${WF}/ci.yml`]:
        'on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - uses: corp/internal@v1\n      - uses: octo/setup@v2\n',
    }).index;
  const ROUTES: Record<string, string> = {
    'ghes.example/repos/corp/internal/commits/v1': SHA('c'),
    'ghes.example/repos/corp/internal/contents/action.yml': SETUP,
    'api.github.com/repos/octo/setup/commits/v2': SHA('b'),
    'api.github.com/repos/octo/setup/contents/action.yml': SETUP,
  };
  /** The enterprise server has corp/internal; github.com has octo/setup. Records every request with its host and token. */
  function twoHosts() {
    const seen: { host: string; auth: string | null }[] = [];
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ host: url.host, auth: new Headers(init?.headers).get('authorization') });
      const path = decodeURIComponent(url.pathname).replace(/^\/api\/v3/, '');
      const body = ROUTES[`${url.host}${path}`];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    }) as typeof globalThis.fetch;
    return { fetch, seen };
  }

  it('asks only the enterprise server unless told to look on github.com', async () => {
    const api = twoHosts();
    const u = await updateRemotesLock(index(), undefined, { fetch: api.fetch, apiUrl: GHES, token: 'ghes' });
    expect(Object.keys(u.lock.remotes)).toEqual(['corp/internal@v1']);
    expect(Object.keys(u.lock.unreadable ?? {})).toEqual(['octo/setup@v2']);
    expect(api.seen.every((r) => r.host === 'ghes.example')).toBe(true);
  });

  it('looks on github.com for what the enterprise server lacks, with its own token, never the enterprise one', async () => {
    const api = twoHosts();
    const got: string[] = [];
    const u = await updateRemotesLock(index(), undefined, {
      fetch: api.fetch,
      apiUrl: GHES,
      token: 'ghes',
      fallback: { apiUrl: 'https://api.github.com', token: 'dotcom' },
      onSource: (s) => got.push(`${s.ref.raw} ${s.sha} ${s.file}`),
    });
    // The file read on github.com goes to the sources cache too.
    expect(got.sort()).toEqual([
      `corp/internal@v1 ${SHA('c')} action.yml`,
      `octo/setup@v2 ${SHA('b')} action.yml`,
    ]);
    expect(u.lock.remotes['corp/internal@v1']).not.toHaveProperty('host');
    expect(u.lock.remotes['octo/setup@v2']).toMatchObject({ sha: SHA('b'), host: 'github.com' });
    expect(u.lock.unreadable).toBeUndefined();
    expect(api.seen.filter((r) => r.host === 'api.github.com').every((r) => r.auth === 'Bearer dotcom')).toBe(
      true,
    );
    expect(api.seen.filter((r) => r.host === 'ghes.example').every((r) => r.auth === 'Bearer ghes')).toBe(
      true,
    );
    // Without a github.com token, it asks github.com without one.
    const anon = twoHosts();
    await updateRemotesLock(index(), undefined, {
      fetch: anon.fetch,
      apiUrl: GHES,
      token: 'ghes',
      fallback: { apiUrl: 'https://api.github.com' },
    });
    expect(anon.seen.filter((r) => r.host === 'api.github.com').every((r) => r.auth === null)).toBe(true);
  });

  it('names the host an API serves', () => {
    expect(hostOf('https://api.github.com')).toBe('github.com');
    expect(hostOf('https://ghes.example/api/v3')).toBe('ghes.example');
    expect(hostOf('https://api.acme.ghe.com')).toBe('acme.ghe.com');
  });
});

describe('secrets a remote workflow reads without declaring them', () => {
  const SHIP = yaml`
    on:
      workflow_call:
        inputs:
          publish: { type: boolean }
          i: { type: string, default: '\${{ secrets.IN_DEFAULT }}' }
        secrets:
          declared: { required: false }
        outputs:
          o: { value: '\${{ secrets.OUT_VALUE }}' }
    jobs:
      a:
        runs-on: x
        env:
          OPT: \${{ secrets.OPT_TOKEN }}
        steps:
          - run: echo "\${{ secrets.NPM_TOKEN }} \${{ secrets.npm_token }} \${{ secrets.declared }} \${{ secrets.GITHUB_TOKEN }}"
          - if: inputs.publish
            run: echo "\${{ secrets.PUBLISH_KEY }}"
          - if: false
            run: echo "\${{ secrets.NEVER }}"
          - if: \${{ secrets.CHECKED != '' }}
            run: echo "\${{ secrets.CHECKED }}"
          - if: env.OPT != ''
            run: echo "\${{ env.OPT }}"
      b:
        if: github.event_name == 'push'
        runs-on: x
        steps:
          - run: echo "\${{ secrets.SLACK_WEBHOOK }}"
      c:
        needs: b
        runs-on: x
        steps:
          - run: echo "\${{ secrets.AFTER_PUSH }}"
      d:
        needs: b
        if: always()
        runs-on: x
        steps:
          - run: echo "\${{ secrets.ALWAYS }}"
      e:
        uses: ./.github/workflows/inner.yml
        with: { x: '\${{ secrets.IN_WITH }}' }
  `;

  it('records only reads that run on every call, where GitHub allows secrets', async () => {
    const api = fakeApi(
      { 'octo/ship@v1': SHA('a') },
      { [`octo/ship/.github/workflows/ship.yml@${SHA('a')}`]: SHIP },
    );
    const index = lint({
      [`${WF}/ci.yml`]: 'on: push\njobs:\n  s:\n    uses: octo/ship/.github/workflows/ship.yml@v1\n',
    }).index;
    const u = await updateRemotesLock(index, undefined, { fetch: api.fetch });
    // Recorded: a plain read (in any case), a job env value, and a job that runs whatever the jobs it needs did.
    // Not: declared, GITHUB_TOKEN, a read under any if: (inputs, false, a secret check, env, the caller's event, or a
    // job it needs that has one), a read in a condition, nor where GitHub allows no secrets (an input default, a
    // workflow_call output, a call's with:).
    expect(u.lock.remotes['octo/ship/.github/workflows/ship.yml@v1']?.undeclaredSecrets).toEqual([
      'ALWAYS',
      'NPM_TOKEN',
      'OPT_TOKEN',
    ]);
  });

  it('records nothing for a file that cannot be called', async () => {
    const api = fakeApi(
      { 'octo/ship@v1': SHA('a') },
      {
        [`octo/ship/.github/workflows/ship.yml@${SHA('a')}`]:
          'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo "${{ secrets.X }}"\n',
      },
    );
    const index = lint({
      [`${WF}/ci.yml`]: 'on: push\njobs:\n  s:\n    uses: octo/ship/.github/workflows/ship.yml@v1\n',
    }).index;
    const u = await updateRemotesLock(index, undefined, { fetch: api.fetch });
    expect(u.lock.remotes['octo/ship/.github/workflows/ship.yml@v1']?.undeclaredSecrets).toBeUndefined();
  });
});

describe('the files read, for the sources cache', () => {
  const api = () =>
    fakeApi(
      { 'octo/ship@v1': SHA('a'), 'octo/setup@v2': SHA('b') },
      {
        [`octo/ship/.github/workflows/deploy.yml@${SHA('a')}`]: DEPLOY,
        [`octo/setup/action.yaml@${SHA('b')}`]: SETUP,
      },
    );
  const index = lint({ [`${WF}/ci.yml`]: caller }).index;
  const dirs: string[] = [];
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'flowpact-sources-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('hands each workflow file and action.yml read to onSource, with its commit and path', async () => {
    const got: Omit<FetchedSource, 'ref'>[] = [];
    await updateRemotesLock(index, undefined, {
      fetch: api().fetch,
      onSource: ({ ref: _, ...s }) => got.push(s),
    });
    expect(got.sort((a, b) => (a.file < b.file ? -1 : 1))).toEqual([
      { sha: SHA('a'), file: '.github/workflows/deploy.yml', text: DEPLOY },
      { sha: SHA('b'), file: 'action.yaml', text: SETUP },
    ]);
  });

  const lock = async () => (await updateRemotesLock(index, undefined, { fetch: api().fetch })).lock;

  it('downloads the sources of the locked commits without resolving a ref, then finds them cached', async () => {
    const dir = tempDir();
    const a = api();
    const d = await downloadRemoteSources(index, await lock(), dir, { fetch: a.fetch, token: 't' });
    expect(d.downloaded).toEqual(['octo/setup@v2', 'octo/ship/.github/workflows/deploy.yml@v1']);
    // octo/gone@v1 is recorded as unreadable: there is nothing to download.
    expect(d.notLocked).toEqual([]);
    expect(d.skipped).toEqual([
      {
        ref: 'octo/gone@v1',
        reason:
          'the lockfile records it as not readable (octo/gone@v1 not found, or not readable with this token)',
      },
    ]);
    expect(d.failed).toEqual([]);
    expect(a.seen.map((r) => new URL(r.url).pathname).filter((p) => p.includes('/commits/'))).toEqual([]);
    const setup = cachedSource(dir, parseRemoteRef('octo/setup@v2', 'action')!, SHA('b'))!;
    expect(readFileSync(setup.path, 'utf8')).toBe(SETUP);
    const again = api();
    const d2 = await downloadRemoteSources(index, await lock(), dir, { fetch: again.fetch });
    expect(d2.downloaded).toEqual([]);
    expect(d2.cached).toEqual(['octo/setup@v2', 'octo/ship/.github/workflows/deploy.yml@v1']);
    expect(again.seen).toEqual([]);
  });

  it('downloads a source read on github.com only with the github.com fallback, and says why it skips it', async () => {
    const locked: RemotesLock = {
      version: 1,
      remotes: { 'octo/setup@v2': { sha: SHA('b'), kind: 'action', host: 'github.com' } },
    };
    const ghes = { apiUrl: 'https://ghes.example/api/v3', token: 'ghes' };
    const a = api();
    const skipped = await downloadRemoteSources(index, locked, tempDir(), { ...ghes, fetch: a.fetch });
    expect(skipped.skipped).toEqual([
      {
        ref: 'octo/setup@v2',
        reason: 'on github.com, which this run does not read: look there with --github-com',
      },
    ]);
    expect(a.seen).toEqual([]);
    const b = api();
    const fallback = { apiUrl: 'https://api.github.com', token: 'dotcom' };
    const d = await downloadRemoteSources(index, locked, tempDir(), { ...ghes, fetch: b.fetch, fallback });
    expect(d.downloaded).toEqual(['octo/setup@v2']);
    expect(
      b.seen.every((r) => r.url.startsWith('https://api.github.com/') && r.auth === 'Bearer dotcom'),
    ).toBe(true);
    // Without a github.com token it asks github.com without one, never with the enterprise token.
    const c = api();
    const anon = await downloadRemoteSources(index, locked, tempDir(), {
      ...ghes,
      fetch: c.fetch,
      fallback: { apiUrl: 'https://api.github.com' },
    });
    expect(anon.downloaded).toEqual(['octo/setup@v2']);
    expect(c.seen.length).toBeGreaterThan(0);
    expect(c.seen.every((r) => r.url.startsWith('https://api.github.com/') && r.auth === undefined)).toBe(
      true,
    );
  });

  it('reports each reference as it is done: downloaded, cached or skipped', async () => {
    const dir = tempDir();
    const locked = await lock();
    const outcomes = async () => {
      const seen: string[] = [];
      await downloadRemoteSources(index, locked, dir, {
        fetch: api().fetch,
        onProgress: (p) => seen.push(`${p.ref} ${p.outcome}`),
      });
      return seen.sort();
    };
    expect(await outcomes()).toEqual([
      'octo/gone@v1 skipped',
      'octo/setup@v2 fetched',
      'octo/ship/.github/workflows/deploy.yml@v1 fetched',
    ]);
    expect(await outcomes()).toEqual([
      'octo/gone@v1 skipped',
      'octo/setup@v2 cached',
      'octo/ship/.github/workflows/deploy.yml@v1 cached',
    ]);
  });

  it('matches a reference to its entry in any case of owner and repository, as GitHub does', async () => {
    const locked: RemotesLock = {
      version: 1,
      remotes: { 'OCTO/SETUP@v2': { sha: SHA('b'), kind: 'action' } },
    };
    const d = await downloadRemoteSources(index, locked, tempDir(), { fetch: api().fetch });
    expect(d.downloaded).toEqual(['octo/setup@v2']);
    expect(d.notLocked).not.toContain('octo/setup@v2');
  });

  it('downloads only what the given paths use', async () => {
    const scoped = lint(
      {
        [`${WF}/a.yml`]: 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: octo/setup@v2\n',
        [`${WF}/b.yml`]: 'on: push\njobs:\n  b:\n    uses: octo/ship/.github/workflows/deploy.yml@v1\n',
      },
      { paths: [`${WF}/a.yml`] },
    ).index;
    const a = api();
    const d = await downloadRemoteSources(scoped, await lock(), tempDir(), { fetch: a.fetch });
    expect(d.downloaded).toEqual(['octo/setup@v2']);
    expect(a.seen.some((r) => r.url.includes('/octo/ship/'))).toBe(false);
  });

  it('downloads a github.com entry when this run reads github.com, and skips a host it never writes', async () => {
    const at = (host: string): RemotesLock => ({
      version: 1,
      remotes: { 'octo/setup@v2': { sha: SHA('b'), kind: 'action', host } },
    });
    const own = await downloadRemoteSources(index, at('github.com'), tempDir(), { fetch: api().fetch });
    expect(own.downloaded).toEqual(['octo/setup@v2']);
    const a = api();
    const evil = await downloadRemoteSources(index, at('evil.example'), tempDir(), { fetch: a.fetch });
    expect(evil.skipped.map((s) => s.ref)).toContain('octo/setup@v2');
    expect(a.seen).toEqual([]);
  });

  it('skips a path the cache cannot hold before asking for it', async () => {
    const odd = lint({
      [`${WF}/ci.yml`]:
        'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: octo/setup/con@v2\n',
    }).index;
    const locked: RemotesLock = {
      version: 1,
      remotes: { 'octo/setup/con@v2': { sha: SHA('b'), kind: 'action' } },
    };
    const a = api();
    const d = await downloadRemoteSources(odd, locked, tempDir(), { fetch: a.fetch });
    expect(d.skipped).toEqual([
      { ref: 'octo/setup/con@v2', reason: 'its path cannot be a file name in the cache' },
    ]);
    expect(a.seen).toEqual([]);
  });

  it('downloads the commit a uses: pins in full, not one a lockfile entry claims for it', async () => {
    const pinned = SHA('d');
    const at = lint({
      [`${WF}/ci.yml`]: `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: octo/setup@${pinned}\n`,
    }).index;
    const locked: RemotesLock = {
      version: 1,
      remotes: { [`octo/setup@${pinned}`]: { sha: SHA('b'), kind: 'action' } },
    };
    const a = fakeApi(
      {},
      { [`octo/setup/action.yml@${pinned}`]: SETUP, [`octo/setup/action.yml@${SHA('b')}`]: 'name: x' },
    );
    const dir = tempDir();
    const d = await downloadRemoteSources(at, locked, dir, { fetch: a.fetch });
    expect(d.downloaded).toEqual([`octo/setup@${pinned}`]);
    const ref = parseRemoteRef(`octo/setup@${pinned}`, 'action')!;
    expect(cachedSource(dir, ref, pinned)).toBeDefined();
    expect(cachedSource(dir, ref, SHA('b'))).toBeUndefined();
    expect(commitOf({ ref: 'v2' }, { sha: SHA('b') })).toBe(SHA('b'));
    expect(commitOf({ ref: pinned.toUpperCase() }, { sha: SHA('b') })).toBe(pinned);
  });

  it('marks a failure to write the cache, which no token would fix', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'octo'), '');
    const d = await downloadRemoteSources(index, await lock(), dir, { fetch: api().fetch });
    expect(d.failed.map((f) => [f.ref, f.cache])).toEqual([
      ['octo/setup@v2', true],
      ['octo/ship/.github/workflows/deploy.yml@v1', true],
    ]);
    expect(d.failed[0]!.error).toMatch(/^could not write the cache: /);
  });

  it('lists what it cannot download, with why, and keeps going', async () => {
    const locked: RemotesLock = {
      version: 1,
      remotes: {
        'octo/setup@v2': { sha: SHA('c'), kind: 'action' },
        'octo/ship/.github/workflows/deploy.yml@v1': { sha: SHA('a'), kind: 'workflow' },
      },
    };
    const d = await downloadRemoteSources(index, locked, tempDir(), { fetch: api().fetch });
    expect(d.downloaded).toEqual(['octo/ship/.github/workflows/deploy.yml@v1']);
    expect(d.notLocked).toEqual(['octo/gone@v1']);
    expect(d.failed).toEqual([
      {
        ref: 'octo/setup@v2',
        error: `no action.yml in the repository root at ${SHA('c').slice(0, 7)}, or not readable with this token`,
      },
    ]);
  });
});

describe('two versions of one action in the same workflow', () => {
  const V1 = yaml`
    name: setup
    inputs:
      old: { required: true }
    runs: { using: composite, steps: [] }
  `;
  const V2 = yaml`
    name: setup
    inputs:
      new: { required: true }
    runs: { using: composite, steps: [] }
  `;
  const files = (ci: string) => ({ [`${WF}/ci.yml`]: ci });
  const both = yaml`
    on: push
    jobs:
      legacy:
        runs-on: x
        steps:
          - uses: octo/setup@v1
            with: { old: a }
      current:
        runs-on: x
        steps:
          - uses: octo/setup@v2
            with: { new: b }
  `;
  const api = () =>
    fakeApi(
      { 'octo/setup@v1': SHA('1'), 'octo/setup@v2': SHA('2') },
      { [`octo/setup/action.yml@${SHA('1')}`]: V1, [`octo/setup/action.yml@${SHA('2')}`]: V2 },
    );

  it('locks each version as its own entry, checks each call against its own version, and caches both', async () => {
    const u = await updateRemotesLock(lint(files(both)).index, undefined, { fetch: api().fetch });
    expect(Object.keys(u.lock.remotes)).toEqual(['octo/setup@v1', 'octo/setup@v2']);
    expect(u.lock.remotes['octo/setup@v1']).toMatchObject({
      sha: SHA('1'),
      inputs: { old: { required: true } },
    });
    expect(u.lock.remotes['octo/setup@v2']).toMatchObject({
      sha: SHA('2'),
      inputs: { new: { required: true } },
    });
    const lockText = serializeRemotesLock(u.lock);
    const codes = (ci: string) =>
      lint({ ...files(ci), '.github/flowpact/remotes.lock.yaml': lockText })
        .findings.filter((f) => f.code === 'FP101' || f.code === 'FP102')
        .map((f) => f.message);
    expect(codes(both)).toEqual([]);
    // Each call is checked against its own version: v1 has no input "new".
    expect(codes(both.replace('with: { old: a }', 'with: { new: a }'))).toEqual([
      'Step #1 uses octo/setup@v1 without required input "old" — GitHub will run it with an empty value',
      'octo/setup@v1 has no input "new"',
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'flowpact-versions-'));
    try {
      const d = await downloadRemoteSources(lint(files(both)).index, u.lock, dir, { fetch: api().fetch });
      expect(d.downloaded).toEqual(['octo/setup@v1', 'octo/setup@v2']);
      expect(
        readFileSync(cachedSource(dir, parseRemoteRef('octo/setup@v1', 'action')!, SHA('1'))!.path, 'utf8'),
      ).toBe(V1);
      expect(
        readFileSync(cachedSource(dir, parseRemoteRef('octo/setup@v2', 'action')!, SHA('2'))!.path, 'utf8'),
      ).toBe(V2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
