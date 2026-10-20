/** How flowpact reaches the GitHub API, says so before fetching, and what it says to check when fetching fails. */

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessLines, fetchAdvice, type GithubAccess, githubAccess } from '../src/lib/github-access';

/** A `gh` that prints a token for `host` only, on a PATH of its own. */
function fakeGh(host: string, token: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'flowpact-gh-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh\n[ "$4" = "${host}" ] && echo ${token} && exit 0\nexit 1\n`);
  chmodSync(gh, 0o755);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('githubAccess', () => {
  const clean = (path: string) => {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_API_URL', 'GITHUB_COM_TOKEN'])
      vi.stubEnv(name, '');
    vi.stubEnv('PATH', path);
  };

  it('takes the API from the option, else GITHUB_API_URL, else github.com', () => {
    clean('');
    vi.stubEnv('GH_TOKEN', 't');
    expect(githubAccess({ apiUrl: 'https://a.example/api/v3' })).toMatchObject({ apiFrom: 'option' });
    vi.stubEnv('GITHUB_API_URL', 'https://gh.corp.example/api/v3');
    expect(githubAccess({})).toMatchObject({
      apiUrl: 'https://gh.corp.example/api/v3',
      apiFrom: 'GITHUB_API_URL',
    });
    vi.stubEnv('GITHUB_API_URL', '');
    expect(githubAccess({})).toMatchObject({ apiUrl: 'https://api.github.com', apiFrom: 'default' });
  });

  it('takes the token from the option, GH_TOKEN, GITHUB_TOKEN, then the GitHub CLI for the API host', () => {
    clean(fakeGh('gh.corp.example', 'gho_x'));
    expect(githubAccess({ token: 'o' })).toMatchObject({ token: 'o', tokenSource: 'the token option' });
    vi.stubEnv('GITHUB_TOKEN', 'g');
    expect(githubAccess({})).toMatchObject({ token: 'g', tokenSource: 'GITHUB_TOKEN' });
    vi.stubEnv('GH_TOKEN', 'h');
    expect(githubAccess({})).toMatchObject({ token: 'h', tokenSource: 'GH_TOKEN' });
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GITHUB_API_URL', 'https://gh.corp.example/api/v3');
    expect(githubAccess({})).toMatchObject({
      token: 'gho_x',
      tokenSource: '`gh auth token --hostname gh.corp.example`',
    });
  });

  it('says why there is no token: the GitHub CLI is missing, or not signed in to the host', () => {
    clean(mkdtempSync(join(tmpdir(), 'flowpact-no-gh-')));
    expect(githubAccess({})).toEqual({
      apiUrl: 'https://api.github.com',
      apiFrom: 'default',
      noToken: 'the GitHub CLI (gh) is not installed',
    });
    clean(fakeGh('gh.corp.example', 'gho_x'));
    expect(githubAccess({}).noToken).toBe('the GitHub CLI is not signed in to github.com');
  });

  it("looks on github.com too with githubCom, with GITHUB_COM_TOKEN and never the enterprise's", () => {
    clean('');
    vi.stubEnv('GH_TOKEN', 'enterprise');
    vi.stubEnv('GITHUB_API_URL', 'https://gh.corp.example/api/v3');
    expect(githubAccess({ githubCom: true }).fallback).toEqual({ apiUrl: 'https://api.github.com' });
    vi.stubEnv('GITHUB_COM_TOKEN', 'public');
    expect(githubAccess({ githubCom: true }).fallback).toEqual({
      apiUrl: 'https://api.github.com',
      token: 'public',
    });
    vi.stubEnv('GITHUB_API_URL', '');
    expect(githubAccess({ githubCom: true }).fallback).toBeUndefined();
  });
});

const GITHUB: GithubAccess = { apiUrl: 'https://api.github.com', apiFrom: 'default' };
const GHES: GithubAccess = { apiUrl: 'https://gh.corp.example/api/v3', apiFrom: 'GITHUB_API_URL' };
const withToken = (a: GithubAccess, tokenSource = 'GH_TOKEN', token = 'ghp_x'): GithubAccess => ({
  ...a,
  token,
  tokenSource,
});

describe('accessLines', () => {
  it('names the API and where it came from, and the token’s source and kind, never the token', () => {
    const lines = accessLines(withToken(GITHUB, 'GH_TOKEN', 'github_pat_s3cr3t'));
    expect(lines).toEqual([
      'GitHub API: https://api.github.com (github.com: GITHUB_API_URL is not set)',
      'token: GH_TOKEN, a fine-grained personal access token',
    ]);
    expect(lines.join('\n')).not.toContain('s3cr3t');
    expect(accessLines(withToken(GHES, '`gh auth token --hostname gh.corp.example`', 'gho_x'))).toEqual([
      'GitHub API: https://gh.corp.example/api/v3 (GITHUB_API_URL)',
      'token: `gh auth token --hostname gh.corp.example`, an OAuth token (GH_TOKEN and GITHUB_TOKEN are not set)',
    ]);
    expect(accessLines(withToken(GHES, 'GITHUB_TOKEN', '0123abcd'))[1]).toBe('token: GITHUB_TOKEN');
  });

  it('says why there is no token, and that github.com is looked at too', () => {
    const none = { ...GHES, noToken: 'the GitHub CLI is not signed in to gh.corp.example', fallback: GITHUB };
    expect(accessLines(none).slice(1)).toEqual([
      'token: none, so public repositories only, at 60 requests an hour (GH_TOKEN and GITHUB_TOKEN are not set, and the GitHub CLI is not signed in to gh.corp.example)',
      'also on github.com, for what gh.corp.example lacks: no token',
    ]);
  });
});

describe('fetchAdvice', () => {
  it('says nothing without a failure it can help with', () => {
    expect(fetchAdvice(withToken(GITHUB), ['other'], undefined)).toEqual({ hints: [] });
    expect(fetchAdvice(withToken(GITHUB), ['rate-limit'], undefined)).toEqual({ hints: [] });
  });

  it('names the enterprise API the origin is on when github.com cannot be reached', () => {
    const { hints, guide } = fetchAdvice(GITHUB, ['unreachable', 'timeout'], 'gh.corp.example');
    expect(hints).toEqual([
      "could not reach https://api.github.com: this repository's origin is on gh.corp.example: if that is a GitHub Enterprise Server or GHE.com, set GITHUB_API_URL=https://gh.corp.example/api/v3. Behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1",
    ]);
    expect(guide).toEqual([
      { github: 'github.com', api: 'GITHUB_API_URL not set', token: 'GH_TOKEN, else `gh auth login`' },
      {
        github: 'GitHub Enterprise Server',
        api: 'GITHUB_API_URL=https://gh.corp.example/api/v3',
        token: 'GH_TOKEN, else `gh auth login --hostname gh.corp.example`',
      },
      {
        github: 'GHE.com',
        api: 'GITHUB_API_URL=https://api.<name>.ghe.com',
        token: 'GH_TOKEN, else `gh auth login --hostname <name>.ghe.com`',
      },
    ]);
    // An origin on github.com (or an SSH alias of it) names no other API.
    for (const origin of [undefined, 'github.com', 'github.com-work'])
      expect(fetchAdvice(GITHUB, ['unreachable'], origin).hints[0]).toContain(
        'on GitHub Enterprise Server or GHE.com, set GITHUB_API_URL to its API',
      );
    expect(fetchAdvice(GITHUB, ['unreachable'], 'acme.ghe.com').hints[0]).toContain(
      'GITHUB_API_URL=https://api.acme.ghe.com',
    );
  });

  it('asks to check GITHUB_API_URL when the API it names cannot be reached', () => {
    const { hints, guide } = fetchAdvice(GHES, ['timeout'], undefined);
    expect(hints[0]).toMatch(
      /^could not reach https:\/\/gh\.corp\.example\/api\/v3 \(GITHUB_API_URL\): check/,
    );
    expect(guide?.[1]?.api).toBe('GITHUB_API_URL=https://gh.corp.example/api/v3');
  });

  it('tells a token the API refused from one it wants, and that GH_TOKEN comes before the GitHub CLI', () => {
    expect(fetchAdvice(GHES, ['token'], undefined).hints).toEqual([
      'gh.corp.example asks for a token: set GH_TOKEN, or sign in with `gh auth login --hostname gh.corp.example`',
    ]);
    expect(fetchAdvice(withToken(GHES), ['token'], undefined).hints).toEqual([
      "gh.corp.example rejected the token from GH_TOKEN: it may have expired, or be for another host. GH_TOKEN comes before the GitHub CLI's sign-in: set it to a token from gh.corp.example, or unset it and sign in with `gh auth login --hostname gh.corp.example`",
    ]);
    expect(
      fetchAdvice(withToken(GITHUB, '`gh auth token --hostname github.com`'), ['token'], undefined).hints[0],
    ).toMatch(/sign in again with `gh auth login`$/);
  });

  it('says where references not found may be, and what reading them takes', () => {
    expect(fetchAdvice(withToken(GITHUB), ['not-found'], 'gh.corp.example').hints).toEqual([
      "some references are not on github.com, or not readable: this repository's origin is on gh.corp.example: if that is a GitHub Enterprise Server or GHE.com, set GITHUB_API_URL=https://gh.corp.example/api/v3; private and internal repositories need a token that can read their contents",
    ]);
    expect(fetchAdvice(withToken(GHES), ['not-found'], undefined).hints[0]).toContain(
      'actions from github.com (through GitHub Connect) are looked for there with --github-com',
    );
    expect(
      fetchAdvice({ ...withToken(GHES), fallback: GITHUB }, ['not-found'], undefined).hints[0],
    ).not.toContain('--github-com');
    expect(fetchAdvice(GITHUB, ['not-found'], undefined).hints[0]).toBe(
      'some references are not on github.com, or not readable: without a token only public repositories can be read: set GH_TOKEN, or sign in with `gh auth login`',
    );
  });

  it('adds no guide when the API and the token are not in doubt', () => {
    const advice = fetchAdvice(GITHUB, ['access', 'rate-limit', 'server'], undefined);
    expect(advice.hints).toEqual([
      expect.stringContaining('a fine-grained token needs Contents: read on them'),
      'without a token, github.com allows 60 requests an hour: set GH_TOKEN, or sign in with `gh auth login`',
      'github.com answered with server errors: try again later',
    ]);
    expect(advice.guide).toBeUndefined();
  });
});
