/**
 * Fetching remote interfaces: each remote reference resolved to a commit through the GitHub API, and the interface
 * read from its workflow file or `action.yml` at that commit. Only `flowpact remotes update` and, opted in, a CI run
 * fetch; every other run reads the committed lockfile.
 */
import {
  createParseContext,
  type FileSystem,
  ProjectIndex as Index,
  loadProject,
  type ProjectIndex,
  parseActionFile,
  parseWorkflowFile,
  remoteKey,
  trimChar,
} from '@ciatlas/core';
import { lockedCommit, readActionsLock } from './actions-lock';
import {
  commitOf,
  lockEntryOf,
  lockedRemote,
  type RemoteEntry,
  type RemoteRef,
  type RemotesLock,
  remoteRefsOf,
  targetedUnits,
} from './remotes';
import {
  cachedSource,
  cachedSourcePath,
  cacheSource,
  commitKey,
  sourceFiles,
  touchCommit,
} from './remotes-cache';
import { undeclaredSecretsRead } from './rules/secrets';

export interface FetchRemotesOptions {
  /** Sent only to `apiUrl`, never logged. Public repositories can be read without one, at a low rate limit. */
  token?: string;
  /** The GitHub API (`GITHUB_API_URL` on GHES); `https://api.github.com` by default. */
  apiUrl?: string;
  /** For tests. */
  fetch?: typeof fetch;
  /** Requests at a time. */
  concurrency?: number;
  /** Called before the first request with how many references there are, for a progress display. */
  onStart?: (total: number) => void;
  /** Called as each reference is done, for a progress display or a log line. */
  onProgress?: (p: FetchProgress) => void;
  /** Called before a request that failed in a way that passes is sent again (see `retryWait`), to say why it waits. */
  onRetry?: (r: FetchRetry) => void;
  /**
   * Where to look for a reference the API does not have, as GitHub Enterprise Server's runner does through GitHub
   * Connect: github.com's API, with its own token (never `token`). Opt-in: it sends the names of the references the
   * enterprise server lacks to github.com.
   */
  fallback?: { apiUrl: string; token?: string };
  /** Called with each workflow file or `action.yml` fetched, for the sources cache (see `cacheSource`). */
  onSource?: (source: FetchedSource) => void;
  /**
   * The commit a reference runs when something pins it, such as GitHub's `actions.lock` (see `lockedCommit`): it is
   * read at that commit, without asking what its ref points at now.
   */
  lockedCommit?: (r: RemoteRef) => string | undefined;
  /**
   * The first wait before sending a request again (see `retryWait`): after a 404 for a commit or file, which GitHub's
   * API now and then answers for one it has, and, growing exponentially, after a failure that passes. Default: 300 ms.
   */
  retryDelayMs?: number;
}

/** A file fetched to read a remote reference's interface: the reference, the commit, the file's path and its text. */
export interface FetchedSource {
  ref: RemoteRef;
  sha: string;
  file: string;
  text: string;
}

/** One reference done: how many of how many, and what came of it (its commit, or why it could not be fetched). */
export interface FetchProgress {
  done: number;
  total: number;
  ref: string;
  /** `cached` and `skipped` are for `downloadRemoteSources`: the cache had the source, or it was not downloaded. */
  outcome: 'fetched' | 'unreadable' | 'failed' | 'cached' | 'skipped';
  /** The commit it resolved to, or why it could not be fetched (or downloaded). */
  detail: string;
}

/** A request sent again: to which host, the attempt about to be made (of how many at most), why, and after how long. */
export interface FetchRetry {
  host: string;
  attempt: number;
  attempts: number;
  /** Short: `503 Service Unavailable`, `no answer within 30 s`, `could not connect (ECONNREFUSED)`. */
  why: string;
  waitMs: number;
}

/**
 * Why a reference could not be fetched, for what to check: `unreachable` (no connection to the API), `timeout` (no
 * answer), `token` (401: the API refused the token, or wants one), `access` (403: the token may not read it),
 * `rate-limit`, `server` (5xx), `not-found` (it does not exist, or the token cannot read it), or `other`.
 */
export type FetchFailureKind =
  | 'unreachable'
  | 'timeout'
  | 'token'
  | 'access'
  | 'rate-limit'
  | 'server'
  | 'not-found'
  | 'other';

/** A reference that could not be fetched, why, and what kind of failure that is. */
export interface FetchProblem {
  ref: string;
  error: string;
  kind: FetchFailureKind;
}

export interface RemotesUpdate {
  lock: RemotesLock;
  /** References whose entry is new, changed (another commit or interface), or gone because nothing uses them. */
  added: string[];
  changed: string[];
  removed: string[];
  /** References that could not be fetched (the network, the API or the file), with why; previous entries are kept. */
  failed: FetchProblem[];
  /**
   * References that do not exist or the token cannot read, with why. One without a previous entry is recorded under
   * the lockfile's `unreadable`, so it is accounted for.
   */
  unreadable: FetchProblem[];
}

/**
 * Why a reference could not be fetched, its kind (`not-found`: it does not exist or the token cannot read it), and for
 * a retry's notice, a short `brief` of it.
 */
class FetchError extends Error {
  constructor(
    message: string,
    readonly kind: FetchFailureKind = 'other',
    readonly brief = message,
  ) {
    super(message);
  }

  get unreadable(): boolean {
    return this.kind === 'not-found';
  }
}

/**
 * A GET on the GitHub API, as text: `accept` picks the media type (a commit's SHA, a file's raw content). A failure
 * that passes is retried (see `retryWait`).
 */
async function get(url: string, accept: string, opts: FetchRemotesOptions): Promise<string | undefined> {
  const res = await withRetries(url, accept, opts);
  // 422: a SHA that is no commit of the repository.
  if (res.status === 404 || res.status === 422) return undefined;
  if (!res.ok) throw httpError(res, opts);
  return bodyOf(res);
}

/** One request, or the network's error (a timeout included). */
async function send(url: string, accept: string, opts: FetchRemotesOptions): Promise<Response> {
  try {
    return await (opts.fetch ?? fetch)(url, {
      headers: {
        accept,
        'user-agent': 'flowpact',
        'x-github-api-version': '2022-11-28',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw networkError(url, e);
  }
}

/** How many times a request is sent at most: once, and twice more after a failure that passes. */
const ATTEMPTS = 3;

/** The longest `Retry-After` flowpact waits for; after a longer one the reference fails, saying when to try again. */
const MAX_RETRY_AFTER_S = 60;

/** A request, sent again while it fails in a way that passes, at most `ATTEMPTS` times in all. */
async function withRetries(url: string, accept: string, opts: FetchRemotesOptions): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let answer: Response | FetchError;
    try {
      answer = await send(url, accept, opts);
    } catch (e) {
      answer = e as FetchError;
    }
    const wait = attempt < ATTEMPTS ? retryWait(answer, attempt, opts) : undefined;
    if (wait === undefined) {
      if (answer instanceof Response) return answer;
      throw answer;
    }
    opts.onRetry?.({
      host: new URL(url).host,
      attempt: attempt + 1,
      attempts: ATTEMPTS,
      why: answer instanceof Response ? statusOf(answer) : answer.brief,
      waitMs: Math.round(wait),
    });
    await pause(wait);
  }
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The secondary rate limit: GitHub asks to slow down, and says when to try again (`Retry-After`, in seconds). */
const retryAfterOf = (res: Response): number | undefined => {
  const header = res.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
};

/** The primary rate limit is used up: it resets within the hour, too long to wait. */
const rateLimitUsedUp = (res: Response) =>
  (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0';

/**
 * How long to wait before sending a request again, or undefined when another try would not help. Retried: no answer
 * (the network, a timeout), a server error (5xx), and the secondary rate limit (429, or 403 with `Retry-After`) for as
 * long as it asks, up to `MAX_RETRY_AFTER_S`. Not retried: what another try cannot change (401, 403 without
 * `Retry-After`, 404 and 422, which the lookups ask once more for themselves) and a used-up primary rate limit.
 * Waits grow exponentially, with jitter so that requests made together do not come back together.
 */
function retryWait(
  answer: Response | FetchError,
  attempt: number,
  opts: FetchRemotesOptions,
): number | undefined {
  if (answer instanceof Response && !passes(answer)) return undefined;
  const after = answer instanceof Response ? retryAfterOf(answer) : undefined;
  if (after === undefined) return backoffMs(attempt, opts);
  return after <= MAX_RETRY_AFTER_S ? after * 1000 : undefined;
}

/** Whether an answer reports a failure that passes: a server error, or the secondary rate limit. */
const passes = (res: Response) => res.status >= 500 || (slowDown(res) && !rateLimitUsedUp(res));

/** GitHub asks to slow down: 429, or 403 with `Retry-After` (its secondary rate limit). */
const slowDown = (res: Response) =>
  res.status === 429 || (res.status === 403 && retryAfterOf(res) !== undefined);

/** The wait before the next attempt: doubling from `retryDelayMs`, with as much again at random at most. */
function backoffMs(attempt: number, opts: FetchRemotesOptions): number {
  const base = opts.retryDelayMs ?? RETRY_DELAY_MS;
  return base * 2 ** (attempt - 1) + Math.random() * base;
}

const TIMEOUT_MS = 30_000;

/** Why a request did not get an answer, and what to check: Node's fetch only says `fetch failed`. */
function networkError(url: string, e: unknown): FetchError {
  const host = new URL(url).origin;
  if ((e as Error).name === 'TimeoutError')
    return new FetchError(
      `no answer from ${host} within ${TIMEOUT_MS / 1000} s: check the network, or try again`,
      'timeout',
      `no answer within ${TIMEOUT_MS / 1000} s`,
    );
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const why = cause?.code ?? cause?.message ?? (e as Error).message;
  return new FetchError(
    `could not reach ${host} (${why}): check the network and GITHUB_API_URL; behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1`,
    'unreachable',
    NETWORK_CODES[why] ?? `could not connect (${why})`,
  );
}

/** The network's error codes a retry's notice puts in words. */
const NETWORK_CODES: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  ETIMEDOUT: 'connection timed out',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'host name lookup failed',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
};

/** A response's status, as `503 Service Unavailable`. */
const statusOf = (res: Response) => `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;

/** Why the GitHub API refused a request, and what to do about it. */
function httpError(res: Response, opts: FetchRemotesOptions): FetchError {
  const status = statusOf(res);
  if (res.status === 401)
    return new FetchError(
      opts.token
        ? `the GitHub API rejected the token (${status}): check GH_TOKEN or GITHUB_TOKEN, or run \`gh auth status\``
        : `the GitHub API asks for a token (${status}): set GH_TOKEN or GITHUB_TOKEN, or sign in with \`gh auth login\``,
      'token',
    );
  if (rateLimitUsedUp(res)) return new FetchError(usedUpMessage(status, opts), 'rate-limit');
  if (slowDown(res)) return new FetchError(slowDownMessage(res, status), 'rate-limit');
  if (res.status === 403)
    return new FetchError(
      `the GitHub API refused the request (${status}): the token needs read access to the repository's contents`,
      'access',
    );
  return new FetchError(`${status} from the GitHub API`, res.status >= 500 ? 'server' : 'other');
}

/** The primary rate limit is used up: wait, or (without a token, at 60 requests an hour) set one. */
const usedUpMessage = (status: string, opts: FetchRemotesOptions) =>
  `the GitHub API rate limit is used up (${status})${opts.token ? '; try again later' : ': without a token it allows 60 requests an hour; set GH_TOKEN or GITHUB_TOKEN, or sign in with `gh auth login`'}`;

/** The secondary rate limit, which said to wait longer than flowpact does (or did not say how long). */
function slowDownMessage(res: Response, status: string): string {
  const after = retryAfterOf(res);
  return `the GitHub API asks to slow down (${status}): try again${after === undefined ? ' later' : ` in ${after} s`}`;
}

/** A response's text, refused over `MAX_FILE_BYTES` by its length header or by what it holds. */
async function bodyOf(res: Response): Promise<string> {
  if (Number(res.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) throw tooLarge();
  const text = await res.text();
  if (text.length > MAX_FILE_BYTES) throw tooLarge();
  return text;
}

/** Workflow and action files are small; a larger response is refused rather than parsed. */
const MAX_FILE_BYTES = 1_000_000;
const tooLarge = () => new FetchError(`a response over ${MAX_FILE_BYTES} bytes`);

const repoUrl = (r: RemoteRef, opts: FetchRemotesOptions) =>
  `${trimChar(opts.apiUrl ?? 'https://api.github.com', '/')}/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;

const contentsPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** The commit a reference's ref resolves to. */
const RETRY_DELAY_MS = 300;

/**
 * `read`, and once more after a pause when it finds nothing: GitHub's API answers 404 now and then for a commit or a
 * file it has, and one such answer would record the reference as unreadable.
 */
async function onceMore<T>(
  read: () => Promise<T | undefined>,
  opts: FetchRemotesOptions,
): Promise<T | undefined> {
  const first = await read();
  if (first !== undefined) return first;
  await pause(opts.retryDelayMs ?? RETRY_DELAY_MS);
  return read();
}

async function shaOf(r: RemoteRef, opts: FetchRemotesOptions): Promise<string> {
  const locked = opts.lockedCommit?.(r);
  if (locked) return locked;
  const sha = await onceMore(
    () => get(`${repoUrl(r, opts)}/commits/${encodeURIComponent(r.ref)}`, 'application/vnd.github.sha', opts),
    opts,
  );
  if (!sha || !/^[0-9a-f]{40}$/.test(sha.trim()))
    throw new FetchError(
      `${r.owner}/${r.repo}@${r.ref} not found, or not readable with this token`,
      'not-found',
    );
  return sha.trim();
}

/** The first of a reference's possible files (`sourceFiles`) the repository has at `sha`, with its text. */
async function firstSource(
  r: RemoteRef,
  sha: string,
  opts: FetchRemotesOptions,
): Promise<{ file: string; text: string } | undefined> {
  for (const file of sourceFiles(r)) {
    const text = await fileAt(r, file, sha, opts);
    if (text !== undefined) return { file, text };
  }
  return undefined;
}

/** A file of the repository at `sha`, or undefined when it has none there. */
const fileAt = (r: RemoteRef, path: string, sha: string, opts: FetchRemotesOptions) =>
  get(`${repoUrl(r, opts)}/contents/${contentsPath(path)}?ref=${sha}`, 'application/vnd.github.raw', opts);

/**
 * A remote reference's file at a commit: its workflow file, or its `action.yml` (else `action.yaml`); handed to
 * `onSource` as it is read.
 */
async function sourceAt(
  r: RemoteRef,
  sha: string,
  opts: FetchRemotesOptions,
): Promise<{ file: string; text: string }> {
  const found = await onceMore(() => firstSource(r, sha, opts), opts);
  if (found) {
    opts.onSource?.({ ref: r, sha, ...found });
    return found;
  }
  const what =
    r.kind === 'workflow' ? `${r.path} not found` : `no action.yml in ${r.path || 'the repository root'}`;
  throw new FetchError(`${what} at ${sha.slice(0, 7)}`, 'not-found');
}

/** The lockfile entry of a remote reference, fetched. */
export async function fetchRemoteEntry(r: RemoteRef, opts: FetchRemotesOptions = {}): Promise<RemoteEntry> {
  const sha = await shaOf(r, opts);
  const ctx = createParseContext(`${r.owner}/${r.repo}`);
  const { file, text } = await sourceAt(r, sha, opts);
  if (r.kind === 'action') return lockEntryOf(parseActionFile(r.raw, file, text, ctx), sha);
  const wf = parseWorkflowFile(r.raw, text, ctx);
  const undeclared = undeclaredSecretsRead(wf);
  return { ...lockEntryOf(wf, sha), ...(undeclared.length ? { undeclaredSecrets: undeclared } : {}) };
}

/**
 * A reference's entry from the API, or, when it does not exist there or cannot be read and a fallback is set, from
 * the fallback (github.com through GitHub Connect), marked with that host. The fallback's own failure is reported when
 * the reference is on neither.
 */
async function fetchWithFallback(r: RemoteRef, opts: FetchRemotesOptions): Promise<RemoteEntry> {
  try {
    return await fetchRemoteEntry(r, opts);
  } catch (e) {
    if (!opts.fallback || !(e instanceof FetchError && e.unreadable)) throw e;
    const { apiUrl, token } = opts.fallback;
    const entry = await fetchRemoteEntry(r, {
      ...opts,
      apiUrl,
      ...(token ? { token } : { token: undefined }),
    });
    return { ...entry, host: hostOf(apiUrl) };
  }
}

/** The host a GitHub API serves: `github.com` for `api.github.com`, the server for `https://<host>/api/v3`. */
export function hostOf(apiUrl: string): string {
  const { hostname } = new URL(apiUrl);
  return hostname.startsWith('api.') ? hostname.slice(4) : hostname;
}

/** Runs `work` on each item, `limit` at a time. */
async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** A value as JSON with every map's keys sorted: an entry read back from the lockfile has its keys in schema order. */
function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

const same = (a: unknown, b: unknown) => sortedJson(a) === sortedJson(b);

type Problems = Pick<RemotesUpdate, 'failed' | 'unreadable'>;

/**
 * A reference's entry, or undefined when it cannot be fetched, which `out` then records: as unreadable (it does not
 * exist, or the token cannot read it) or failed (the network, a timeout, the API, the file); any other error is a bug
 * and is thrown.
 */
async function tryFetch(
  r: RemoteRef,
  opts: FetchRemotesOptions,
  out: Problems,
): Promise<RemoteEntry | undefined> {
  try {
    return await fetchWithFallback(r, opts);
  } catch (e) {
    if (!isFetchFailure(e)) throw e;
    const problem = { ref: r.raw, error: (e as Error).message, kind: kindOf(e) };
    if (problem.kind === 'not-found') out.unreadable.push(problem);
    else out.failed.push(problem);
    return undefined;
  }
}

/** An error fetching is expected to raise: the API's or the file's (`FetchError`), the network's, a timeout. */
const isFetchFailure = (e: unknown) =>
  e instanceof FetchError || e instanceof TypeError || (e as Error).name === 'TimeoutError';

/** The kind of an error fetching raised (see `isFetchFailure`): a `TypeError` is the network's, from reading a body. */
function kindOf(e: unknown): FetchFailureKind {
  if (e instanceof FetchError) return e.kind;
  return (e as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable';
}

/** `tryFetch`, then `onProgress` with the outcome; `count.done` counts the references finished so far. */
async function fetchCounted(
  r: RemoteRef,
  opts: FetchRemotesOptions,
  out: Problems,
  count: { done: number; total: number },
): Promise<RemoteEntry | undefined> {
  const entry = await tryFetch(r, opts, out);
  count.done++;
  if (opts.onProgress) opts.onProgress({ ...count, ref: r.raw, ...outcomeOf(r.raw, entry, out) });
  return entry;
}

/** What came of fetching a reference: its commit, or why it could not be fetched. */
function outcomeOf(
  ref: string,
  entry: RemoteEntry | undefined,
  out: Problems,
): Pick<FetchProgress, 'outcome' | 'detail'> {
  if (entry) return { outcome: 'fetched', detail: entry.sha };
  const unreadable = out.unreadable.find((p) => p.ref === ref);
  if (unreadable) return { outcome: 'unreadable', detail: unreadable.error };
  return { outcome: 'failed', detail: out.failed.find((p) => p.ref === ref)?.error ?? '' };
}

const byRef = (a: { ref: string }, b: { ref: string }) => (a.ref < b.ref ? -1 : 1);

/**
 * The lockfile for the remote references a project uses, fetched: one entry each, entries of references nothing uses
 * any more dropped. A reference that cannot be fetched keeps its previous entry and is listed as failed.
 */
export async function updateRemotesLock(
  index: ProjectIndex,
  previous: RemotesLock | undefined,
  opts: FetchRemotesOptions = {},
): Promise<RemotesUpdate> {
  const scope = targetedUnits(index);
  const refs = remoteRefsOf(index, scope);
  const before = new Map(Object.entries(previous?.remotes ?? {}).map(([ref, e]) => [remoteKey(ref), e]));
  const remotes: RemotesLock['remotes'] = {};
  const out: RemotesUpdate = {
    lock: { version: 1, remotes },
    added: [],
    changed: [],
    removed: [],
    failed: [],
    unreadable: [],
  };
  const count = { done: 0, total: refs.length };
  opts.onStart?.(refs.length);
  await eachLimited(refs, opts.concurrency ?? 8, async (r) => {
    const old = before.get(remoteKey(r.raw));
    const entry = await fetchCounted(r, opts, out, count);
    if (entry) remotes[r.raw] = entry;
    else if (old) remotes[r.raw] = old;
    if (entry && !old) out.added.push(r.raw);
    else if (entry && !same(old, entry)) out.changed.push(r.raw);
  });
  // An entry is dropped only when nothing in the repository uses it; with paths, the others are kept as they were.
  const used = new Set(remoteRefsOf(index).map((r) => remoteKey(r.raw)));
  if (scope) keepOutside(previous, used, new Set(refs.map((r) => remoteKey(r.raw))), out);
  out.removed = Object.keys(previous?.remotes ?? {}).filter((ref) => !used.has(remoteKey(ref)));
  for (const list of [out.added, out.changed, out.removed]) list.sort();
  out.failed.sort(byRef);
  out.unreadable.sort(byRef);
  // A reference without an entry that cannot be read is recorded, so the lockfile accounts for it (see FP612).
  const unreadable = out.unreadable.filter((u) => !remotes[u.ref]);
  if (unreadable.length)
    out.lock.unreadable = {
      ...out.lock.unreadable,
      ...Object.fromEntries(unreadable.map((u) => [u.ref, u.error])),
    };
  return out;
}

/** With paths: the previous entries (and unreadable references) of references used outside them, kept as they were. */
function keepOutside(
  previous: RemotesLock | undefined,
  used: Set<string>,
  fetched: Set<string>,
  out: RemotesUpdate,
): void {
  const outside = (ref: string) => used.has(remoteKey(ref)) && !fetched.has(remoteKey(ref));
  for (const [ref, e] of Object.entries(previous?.remotes ?? {})) if (outside(ref)) out.lock.remotes[ref] = e;
  const unreadable = Object.entries(previous?.unreadable ?? {}).filter(([ref]) => outside(ref));
  if (unreadable.length) out.lock.unreadable = Object.fromEntries(unreadable);
}

export interface FetchedRemotes {
  /** Entries for the references the lockfile lacks, by reference. */
  remotes: RemotesLock['remotes'];
  /** References that could not be fetched, and those that do not exist or the token cannot read, with why. */
  failed: FetchProblem[];
  unreadable: FetchProblem[];
}

/**
 * The interfaces of the remote references a repository uses that its lockfile lacks, fetched for one run (`--fetch-remotes`,
 * the action's `remotes: fetch`); nothing is written. Entries the lockfile has are not fetched, so its pins stand. A
 * reference GitHub's `actions.lock` pins is read at that commit.
 */
export async function fetchMissingRemotes(
  root: string,
  fs: FileSystem,
  lock: RemotesLock | undefined,
  opts: FetchRemotesOptions & { repository?: string } = {},
): Promise<FetchedRemotes> {
  const project = loadProject({
    root,
    fs,
    validateSchema: false,
    ...(opts.repository ? { repository: opts.repository } : {}),
  });
  const locked = new Set(Object.keys(lock?.remotes ?? {}).map(remoteKey));
  const missing = remoteRefsOf(new Index(project)).filter((r) => !locked.has(remoteKey(r.raw)));
  const actionsLock = readActionsLock(fs);
  return fetchRemoteEntries(missing, { lockedCommit: (r) => lockedCommit(actionsLock, r), ...opts });
}

/** The entries of these references, fetched, and those that could not be fetched (with why). */
export async function fetchRemoteEntries(
  refs: RemoteRef[],
  opts: FetchRemotesOptions = {},
): Promise<FetchedRemotes> {
  const out: FetchedRemotes = { remotes: {}, failed: [], unreadable: [] };
  const count = { done: 0, total: refs.length };
  opts.onStart?.(refs.length);
  await eachLimited(refs, opts.concurrency ?? 8, async (r) => {
    const entry = await fetchCounted(r, opts, out, count);
    if (entry) out.remotes[r.raw] = entry;
  });
  out.failed.sort(byRef);
  out.unreadable.sort(byRef);
  return out;
}

export interface RemotesDownload {
  /** References whose source was downloaded into the cache, and those whose source it had already. */
  downloaded: string[];
  cached: string[];
  /** References the repository uses that the lockfile has no entry for: `remotes update` adds them. */
  notLocked: string[];
  /** References not downloaded, with why: on a host this run does not read, or a path the cache cannot hold. */
  skipped: { ref: string; reason: string }[];
  /**
   * References whose source could not be downloaded or cached, with why: the kind of failure when it was fetching's
   * (see `FetchFailureKind`), `cache` when writing the cache failed.
   */
  failed: { ref: string; error: string; kind?: FetchFailureKind; cache?: true }[];
  /** The cached commits this run uses (`commitKey`), marked as just used: what a prune keeps. */
  commits: string[];
}

/**
 * Downloads the sources of the remote references a project uses (with paths, those they reach) into the cache, at the
 * commits the lockfile pins: nothing is resolved again and the lockfile does not change, so the editor opens what the
 * checks used. A source the cache has is not downloaded again.
 */
export async function downloadRemoteSources(
  index: ProjectIndex,
  lock: RemotesLock,
  dir: string,
  opts: FetchRemotesOptions = {},
): Promise<RemotesDownload> {
  const refs = remoteRefsOf(index, targetedUnits(index));
  const out: RemotesDownload = {
    downloaded: [],
    cached: [],
    notLocked: [],
    skipped: [],
    failed: [],
    commits: [],
  };
  const count = { done: 0, total: refs.length };
  opts.onStart?.(refs.length);
  await eachLimited(refs, opts.concurrency ?? 8, async (r) => {
    const done = await downloadOne(r, lock, dir, opts);
    if (done.list === 'downloaded' || done.list === 'cached') {
      touchCommit(dir, r, done.sha);
      out.commits.push(commitKey(r, done.sha));
    }
    const outcome = record(out, r.raw, done);
    count.done++;
    opts.onProgress?.({ ...count, ref: r.raw, ...outcome });
  });
  out.commits = [...new Set(out.commits)].sort();
  for (const list of [out.downloaded, out.cached, out.notLocked]) list.sort();
  out.skipped.sort(byRef);
  out.failed.sort(byRef);
  return out;
}

/** What came of one reference's source: the list of `RemotesDownload` it goes in, with its commit or why. */
type Downloaded =
  | { list: 'downloaded' | 'cached'; sha: string }
  | { list: 'notLocked' }
  | { list: 'skipped'; reason: string }
  | { list: 'failed'; error: string; kind?: FetchFailureKind; cache?: true };

/** One reference's source into the cache, unless the cache has it or this run cannot read it. */
async function downloadOne(
  r: RemoteRef,
  lock: RemotesLock,
  dir: string,
  opts: FetchRemotesOptions,
): Promise<Downloaded> {
  const { entry, unreadable } = lockedRemote(lock, r.raw);
  if (unreadable !== undefined)
    return { list: 'skipped', reason: `the lockfile records it as not readable (${unreadable})` };
  if (!entry) return { list: 'notLocked' };
  const sha = commitOf(r, entry);
  if (cachedSource(dir, r, sha)) return { list: 'cached', sha };
  // Before any request: a path the cache cannot hold would be downloaded on every run and never kept.
  if (!sourceFiles(r).some((f) => cachedSourcePath(dir, r, sha, f))) return UNSAFE;
  const api = apiFor(entry, opts);
  if (!api)
    return {
      list: 'skipped',
      reason: `on ${entry.host}, which this run does not read: look there with --github-com`,
    };
  const source = await sourceOrError(r, sha, api);
  return 'error' in source ? { list: 'failed', ...source } : keepSource(dir, r, sha, source);
}

/** A reference's file at a commit, or why it could not be read; any other error is a bug and is thrown. */
async function sourceOrError(
  r: RemoteRef,
  sha: string,
  api: FetchRemotesOptions,
): Promise<{ file: string; text: string } | { error: string; kind: FetchFailureKind }> {
  try {
    return await sourceAt(r, sha, { ...api, onSource: undefined });
  } catch (e) {
    if (!isFetchFailure(e)) throw e;
    const kind = kindOf(e);
    const { message } = e as Error;
    return { error: kind === 'not-found' ? `${message}, or not readable with this token` : message, kind };
  }
}

/** A downloaded file into the cache. */
function keepSource(
  dir: string,
  r: RemoteRef,
  sha: string,
  source: { file: string; text: string },
): Downloaded {
  const cached = cacheSource(dir, r, sha, source.file, source.text);
  if (cached === 'unsafe') return UNSAFE;
  if (typeof cached === 'object')
    return { list: 'failed', error: `could not write the cache: ${cached.failed}`, cache: true };
  return { list: cached === 'written' ? 'downloaded' : 'cached', sha };
}

const UNSAFE: Downloaded = { list: 'skipped', reason: 'its path cannot be a file name in the cache' };

/** Records what came of a reference's source in `out`, and returns the progress to report for it. */
function record(out: RemotesDownload, ref: string, d: Downloaded): Pick<FetchProgress, 'outcome' | 'detail'> {
  switch (d.list) {
    case 'downloaded':
    case 'cached':
      out[d.list].push(ref);
      return { outcome: d.list === 'downloaded' ? 'fetched' : 'cached', detail: d.sha };
    case 'notLocked':
      out.notLocked.push(ref);
      return { outcome: 'skipped', detail: 'not in the lockfile' };
    case 'skipped':
      out.skipped.push({ ref, reason: d.reason });
      return { outcome: 'skipped', detail: d.reason };
    case 'failed':
      out.failed.push({
        ref,
        error: d.error,
        ...(d.kind ? { kind: d.kind } : {}),
        ...(d.cache ? { cache: true as const } : {}),
      });
      return { outcome: 'failed', detail: d.error };
  }
}

/**
 * How to read an entry's source: from the API this run uses, or from the fallback when the entry was read there
 * (its `host`); undefined when this run reads neither.
 */
function apiFor(entry: RemoteEntry, opts: FetchRemotesOptions): FetchRemotesOptions | undefined {
  if (!entry.host || entry.host === hostOf(opts.apiUrl ?? 'https://api.github.com')) return opts;
  if (!opts.fallback || hostOf(opts.fallback.apiUrl) !== entry.host) return undefined;
  const { apiUrl, token } = opts.fallback;
  return { ...opts, apiUrl, ...(token ? { token } : { token: undefined }) };
}
