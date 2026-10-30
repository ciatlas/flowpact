/**
 * How flowpact reaches the GitHub API to read remote repositories (`remotes update` and `download`, `--fetch-remotes`):
 * the API and the token, where each came from, the lines that say so before fetching, and what to check when fetching
 * fails. The token itself is never shown, only what kind it is.
 */
import { spawnSync } from 'node:child_process';
import { apiHost, GITHUB_COM_API, type RemoteFailureKind } from '@ciatlas/core';

/** How the GitHub API is reached. */
export interface GithubAccess {
  apiUrl: string;
  /** Where the API came from: the `apiUrl` option, `GITHUB_API_URL`, or github.com's by default. */
  apiFrom: 'option' | 'GITHUB_API_URL' | 'default';
  /** Never printed. */
  token?: string;
  /** Where the token came from: the option, `GH_TOKEN`, `GITHUB_TOKEN` or the GitHub CLI; undefined without one. */
  tokenSource?: string;
  /** Without a token: why the GitHub CLI gave none. */
  noToken?: string;
  /** With `githubCom` on GitHub Enterprise Server or GHE.com: github.com's API too, with `GITHUB_COM_TOKEN` or none. */
  fallback?: { apiUrl: string; token?: string };
}

/** The GitHub CLI's token for a host, or why there is none; never printed. */
function ghToken(host: string): { token: string } | { why: string } {
  const r = spawnSync('gh', ['auth', 'token', '--hostname', host], { encoding: 'utf8', timeout: 10_000 });
  if (r.status === 0 && r.stdout.trim()) return { token: r.stdout.trim() };
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')
    return { why: 'the GitHub CLI (gh) is not installed' };
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT')
    return { why: '`gh auth token` did not answer within 10 s' };
  return { why: `the GitHub CLI is not signed in to ${host}` };
}

/**
 * How to reach the GitHub API: the `apiUrl` option, else `GITHUB_API_URL` (GitHub Enterprise Server, GHE.com), else
 * github.com's; with the `token` option, else `GH_TOKEN`, else `GITHUB_TOKEN`, else the GitHub CLI's for the API's host
 * (`gh auth token --hostname`, so a GitHub Enterprise Server sign-in works too). With `githubCom`, also github.com's.
 */
export function githubAccess(options: {
  apiUrl?: string;
  token?: string;
  githubCom?: boolean;
}): GithubAccess {
  const env = process.env.GITHUB_API_URL;
  const api: Pick<GithubAccess, 'apiUrl' | 'apiFrom'> = options.apiUrl
    ? { apiUrl: options.apiUrl, apiFrom: 'option' }
    : env
      ? { apiUrl: env, apiFrom: 'GITHUB_API_URL' }
      : { apiUrl: GITHUB_COM_API, apiFrom: 'default' };
  return {
    ...api,
    ...tokenFor(api.apiUrl, options.token),
    ...githubComFallback(api.apiUrl, options.githubCom),
  };
}

function tokenFor(
  apiUrl: string,
  given: string | undefined,
): Pick<GithubAccess, 'token' | 'tokenSource' | 'noToken'> {
  if (given) return { token: given, tokenSource: 'the token option' };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN'] as const)
    if (process.env[name]) return { token: process.env[name], tokenSource: name };
  const host = apiHost(apiUrl);
  const gh = ghToken(host);
  return 'token' in gh
    ? { token: gh.token, tokenSource: `\`gh auth token --hostname ${host}\`` }
    : { noToken: gh.why };
}

/** github.com's API, for what an enterprise server lacks, as the runner reaches it through GitHub Connect. */
function githubComFallback(apiUrl: string, githubCom: boolean | undefined): Pick<GithubAccess, 'fallback'> {
  if (!githubCom || apiHost(apiUrl) === 'github.com') return {};
  const token = process.env.GITHUB_COM_TOKEN;
  return { fallback: { apiUrl: GITHUB_COM_API, ...(token ? { token } : {}) } };
}

/** Where the token for remote interfaces comes from, for a line of a result; the token itself is never shown. */
export const describeToken = (source: string | undefined) =>
  source ?? 'none: public repositories only, at 60 requests an hour';

/** The kinds of GitHub token, by prefix (see "About authentication to GitHub"); only the kind is shown. */
const TOKEN_KINDS: [prefix: string, kind: string][] = [
  ['github_pat_', 'a fine-grained personal access token'],
  ['ghp_', 'a personal access token (classic)'],
  ['gho_', 'an OAuth token'],
  ['ghu_', "a GitHub App's user token"],
  ['ghs_', "a GitHub App's installation token"],
];

const tokenKind = (token: string) => TOKEN_KINDS.find(([prefix]) => token.startsWith(prefix))?.[1];

/**
 * What the CLI prints before fetching: the API and where it came from, then the token's source and kind, or why there
 * is none, then github.com's API when it is looked at too.
 */
export function accessLines(a: GithubAccess): string[] {
  const host = apiHost(a.apiUrl);
  const from = {
    option: 'the apiUrl option',
    GITHUB_API_URL: 'GITHUB_API_URL',
    default: `${host}: GITHUB_API_URL is not set`,
  }[a.apiFrom];
  const kind = a.token ? tokenKind(a.token) : undefined;
  const fromGh = a.tokenSource?.startsWith('`gh');
  const token = a.tokenSource
    ? `token: ${a.tokenSource}${kind ? `, ${kind}` : ''}${fromGh ? ' (GH_TOKEN and GITHUB_TOKEN are not set)' : ''}`
    : `token: none, so public repositories only, at 60 requests an hour (GH_TOKEN and GITHUB_TOKEN are not set, and ${a.noToken ?? `the GitHub CLI has none for ${host}`})`;
  const fallback = a.fallback
    ? [`also on github.com, for what ${host} lacks: ${a.fallback.token ? 'GITHUB_COM_TOKEN' : 'no token'}`]
    : [];
  return [`GitHub API: ${a.apiUrl} (${from})`, token, ...fallback];
}

/** The API of a host: GHE.com's at `api.<name>.ghe.com`, GitHub Enterprise Server's at `/api/v3`. */
const apiOf = (host: string) =>
  host.endsWith('.ghe.com') ? `https://api.${host}` : `https://${host}/api/v3`;

/** Whether a git host is github.com: as is, its SSH host, or an SSH alias such as `github.com-work`. */
const isGithubCom = (host: string) =>
  host === 'github.com' || host === 'ssh.github.com' || host.startsWith('github.com-');

/** What the hints are written from: the access, the API's host, how to sign in to it, and the API the origin names. */
interface HintContext {
  a: GithubAccess;
  host: string;
  login: string;
  /** With the default API, when the repository's `origin` is on another host: the API to try instead. */
  elsewhere: string | undefined;
}

const PROXY = 'Behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1';

/** One hint per cause, in this order: the kinds of failure it is for, and the hint (none when it would not help). */
const HINTS: [kinds: RemoteFailureKind[], hint: (c: HintContext) => string | undefined][] = [
  [['unreachable', 'timeout'], unreachableHint],
  [['token'], tokenHint],
  [
    ['access'],
    () =>
      "the token may not read some repositories: a fine-grained token needs Contents: read on them, a classic one the repo scope, a GitHub App's contents: read and the app installed on them; with SAML single sign-on, the token must be authorized for the organization",
  ],
  [
    ['rate-limit'],
    ({ a, host, login }) =>
      a.token
        ? undefined
        : `without a token, ${host} allows 60 requests an hour: set GH_TOKEN, or sign in with ${login}`,
  ],
  [['not-found'], notFoundHint],
  [['server'], ({ host }) => `${host} answered with server errors: try again later`],
];

/**
 * What to check when references could not be fetched, by the kinds of failure: one hint per cause. `origin` is the host
 * of the repository's `origin`: on a host other than github.com, it names the API to try.
 */
function fetchHints(
  a: GithubAccess,
  kinds: (RemoteFailureKind | undefined)[],
  origin: string | undefined,
): string[] {
  const host = apiHost(a.apiUrl);
  const c: HintContext = {
    a,
    host,
    login: `\`gh auth login${host === 'github.com' ? '' : ` --hostname ${host}`}\``,
    elsewhere:
      a.apiFrom === 'default' && origin && !isGithubCom(origin)
        ? `this repository's origin is on ${origin}: if that is a GitHub Enterprise Server or GHE.com, set GITHUB_API_URL=${apiOf(origin)}`
        : undefined,
  };
  return HINTS.flatMap(([on, hint]) => {
    const text = on.some((k) => kinds.includes(k)) ? hint(c) : undefined;
    return text ? [text] : [];
  });
}

/** The API cannot be reached: the default one may be the wrong one, or the one given may be wrong or out of reach. */
function unreachableHint({ a, elsewhere }: HintContext): string {
  if (a.apiFrom === 'default')
    return `could not reach ${a.apiUrl}: ${elsewhere ?? 'on GitHub Enterprise Server or GHE.com, set GITHUB_API_URL to its API'}. ${PROXY}`;
  const from = a.apiFrom === 'option' ? 'the apiUrl option' : 'GITHUB_API_URL';
  return `could not reach ${a.apiUrl} (${from}): check that it is the API (https://<host>/api/v3 on GitHub Enterprise Server, https://api.<name>.ghe.com on GHE.com) and that this machine reaches it (a VPN?). ${PROXY}`;
}

/** The API refused the token, or wants one: which token was sent, and how to send the right one. */
function tokenHint({ a, host, login }: HintContext): string {
  if (!a.tokenSource) return `${host} asks for a token: set GH_TOKEN, or sign in with ${login}`;
  const fix =
    a.tokenSource === 'GH_TOKEN' || a.tokenSource === 'GITHUB_TOKEN'
      ? `${a.tokenSource} comes before the GitHub CLI's sign-in: set it to a token from ${host}, or unset it and sign in with ${login}`
      : `sign in again with ${login}`;
  return `${host} rejected the token from ${a.tokenSource}: it may have expired, or be for another host. ${fix}`;
}

/**
 * References not found: on another server (the one the origin names; github.com, from an enterprise server without
 * `--github-com`), or not readable with this token, or without one.
 */
function notFoundHint({ a, host, login, elsewhere }: HintContext): string {
  const connect =
    host === 'github.com' || a.fallback
      ? undefined
      : 'actions from github.com (through GitHub Connect) are looked for there with --github-com';
  const where = elsewhere ?? connect;
  const access = a.token
    ? 'private and internal repositories need a token that can read their contents'
    : `without a token only public repositories can be read: set GH_TOKEN, or sign in with ${login}`;
  return `some references are not on ${host}, or not readable: ${where ? `${where}; ` : ''}${access}`;
}

/** A row of the setup guide: a kind of GitHub, how to point flowpact at it, and the token it reads with. */
export interface GuideRow {
  github: string;
  api: string;
  token: string;
}

/**
 * What to check when references could not be fetched (see `fetchHints`) and, when the API or the token may be the wrong
 * one, where flowpact reads remote repositories, with which token (see `setupGuide`).
 */
export function fetchAdvice(
  a: GithubAccess,
  kinds: (RemoteFailureKind | undefined)[],
  origin: string | undefined,
): { hints: string[]; guide?: GuideRow[] } {
  const hints = fetchHints(a, kinds, origin);
  const guided = kinds.some(
    (k) => k === 'unreachable' || k === 'timeout' || k === 'token' || k === 'not-found',
  );
  return { hints, ...(hints.length && guided ? { guide: setupGuide(a.apiUrl, origin) } : {}) };
}

/**
 * Where flowpact reads remote repositories, and with which token, by kind of GitHub: with the enterprise host the API
 * or the repository's `origin` names, else a placeholder.
 */
function setupGuide(apiUrl: string, origin: string | undefined): GuideRow[] {
  const hosts = [apiHost(apiUrl), ...(origin && !isGithubCom(origin) ? [origin] : [])];
  const ghe = hosts.find((h) => h.endsWith('.ghe.com')) ?? '<name>.ghe.com';
  const ghes = hosts.find((h) => h !== 'github.com' && !h.endsWith('.ghe.com')) ?? '<host>';
  const token = (h?: string) => `GH_TOKEN, else \`gh auth login${h ? ` --hostname ${h}` : ''}\``;
  return [
    { github: 'github.com', api: 'GITHUB_API_URL not set', token: token() },
    { github: 'GitHub Enterprise Server', api: `GITHUB_API_URL=${apiOf(ghes)}`, token: token(ghes) },
    { github: 'GHE.com', api: `GITHUB_API_URL=${apiOf(ghe)}`, token: token(ghe) },
  ];
}
