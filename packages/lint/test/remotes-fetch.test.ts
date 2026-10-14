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
          level: { type: 'choice', required: false, default: 'low', options: ['low', 'high'] },
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
    expect(u.failed).toEqual([
      { ref: 'octo/gone@v1', error: 'octo/gone@v1 not found, or not readable with this token' },
    ]);
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
