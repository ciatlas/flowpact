/**
 * Fetching remote interfaces: each remote reference resolved to a commit through the GitHub API, and the interface
 * read from its workflow file or `action.yml` at that commit. The requests are core's (`resolveRemoteCommit`,
 * `fetchRemoteSourceAt`); what to do about a failure is flowpact's (see `adviceOf`). Only `flowpact remotes update` and,
 * opted in, a CI run fetch; every other run reads the committed lockfile.
 */
import {
  apiHost,
  createParseContext,
  type FetchLike,
  type FileSystem,
  fetchRemoteSourceAt,
  GITHUB_COM_API,
  type GitHubApi,
  loadProject,
  type ProjectIndex,
  parseActionFile,
  parseWorkflowFile,
  type RemoteFailureKind,
  RemoteFetchError,
  type RemoteFetchOptions,
  type RemoteRef,
  type RemoteSource,
  type RemoteSourceCache,
  remoteKey,
  remoteRefsOf,
  remoteSourceFiles,
  resolveRemoteCommit,
} from '@ciatlas/core';
import { lockedCommit, readActionsLock } from './actions-lock';
import {
  commitOf,
  lockEntryOf,
  lockedRemote,
  type RemoteEntry,
  type RemotesLock,
  targetedUnits,
} from './remotes';
import { cachedSource, cachedSourcePath, cacheSource, commitKey, touchCommit } from './remotes-cache';
import { undeclaredSecretsRead } from './rules/secrets';

export interface FetchRemotesOptions {
  /** Sent only to `apiUrl`, never logged. Public repositories can be read without one, at a low rate limit. */
  token?: string;
  /** The GitHub API (`GITHUB_API_URL` on GHES); `https://api.github.com` by default. */
  apiUrl?: string;
  /** For tests. */
  fetch?: FetchLike;
  /** Requests at a time. */
  concurrency?: number;
  /** Called before the first request with how many references there are, for a progress display. */
  onStart?: (total: number) => void;
  /** Called as each reference is done, for a progress display or a log line. */
  onProgress?: (p: FetchProgress) => void;
  /** Called before a request that failed in a way that passes is sent again, to say why it waits. */
  onRetry?: (r: FetchRetry) => void;
  /**
   * Where to look for a reference the API does not have, as GitHub Enterprise Server's runner does through GitHub
   * Connect: github.com's API, with its own token (never `token`). Opt-in: it sends the names of the references the
   * enterprise server lacks to github.com.
   */
  fallback?: { apiUrl: string; token?: string };
  /**
   * Where each workflow file or `action.yml` read is written once its digest is checked, for the sources cache (see
   * `cacheSource`). Written through: what it returns for a read is used instead of asking the API.
   */
  cache?: RemoteSourceCache;
  /**
   * The commit a reference runs when something pins it, such as GitHub's `actions.lock` (see `lockedCommit`): it is
   * read at that commit, without asking what its ref points at now.
   */
  lockedCommit?: (r: RemoteRef) => string | undefined;
  /**
   * The hosts that did not answer, shared by every request made with these options: once a request found a host
   * unreachable (`unreachable` or `timeout`, after all its attempts), each later request to it fails the same way at
   * once, instead of waiting as long. Each fetching function makes its own unless given one, which several can share.
   */
  unreachableHosts?: Map<string, RemoteFetchError>;
  /**
   * The first wait before sending a request again: after a 404 for a commit or file, which GitHub's API now and then
   * answers for one it has, and, growing exponentially, after a failure that passes. Default: 300 ms.
   */
  retryDelayMs?: number;
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

/** A reference that could not be fetched, why, and what kind of failure that is (see `RemoteFailureKind`). */
export interface FetchProblem {
  ref: string;
  error: string;
  kind: RemoteFailureKind;
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

/** The API these options read from. */
const apiOf = (opts: FetchRemotesOptions): GitHubApi => ({
  apiUrl: opts.apiUrl ?? GITHUB_COM_API,
  ...(opts.token ? { token: opts.token } : {}),
});

/** Core's options for these: the API, the fallback, and the requests' settings. */
function requestOptions(opts: FetchRemotesOptions): RemoteFetchOptions {
  const { fallback, fetch, cache, unreachableHosts, retryDelayMs, onRetry } = opts;
  return {
    api: apiOf(opts),
    userAgent: 'flowpact',
    ...(fallback
      ? { fallback: { apiUrl: fallback.apiUrl, ...(fallback.token ? { token: fallback.token } : {}) } }
      : {}),
    ...(fetch ? { fetch } : {}),
    ...(cache ? { cache } : {}),
    ...(unreachableHosts ? { unreachableHosts } : {}),
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
    ...(onRetry ? { onRetry } : {}),
  };
}

/** The token sent to the host that answered: the fallback's own, or the API's. */
const tokenFor = (host: string, opts: FetchRemotesOptions) =>
  opts.fallback && host === apiHost(opts.fallback.apiUrl) ? opts.fallback.token : opts.token;

const USED_UP = 'the GitHub API rate limit is used up';

/** Core says what failed; this is what to do about it, by its kind and whether a token was sent. */
function adviceOf(e: RemoteFetchError, opts: FetchRemotesOptions): string {
  const token = tokenFor(e.host, opts);
  switch (e.kind) {
    case 'unreachable':
      return ': check the network and GITHUB_API_URL; behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1';
    case 'timeout':
      return ': check the network, or try again';
    case 'token':
      return token
        ? ': check GH_TOKEN or GITHUB_TOKEN, or run `gh auth status`'
        : ': set GH_TOKEN or GITHUB_TOKEN, or sign in with `gh auth login`';
    case 'rate-limit':
      if (!e.message.startsWith(USED_UP)) return '';
      return token
        ? '; try again later'
        : ': without a token it allows 60 requests an hour; set GH_TOKEN or GITHUB_TOKEN, or sign in with `gh auth login`';
    case 'access':
      return ": the token needs read access to the repository's contents";
    default:
      return '';
  }
}

/** The lockfile entry of a remote unit read from its file. */
function entryOf(r: RemoteRef, source: RemoteSource): RemoteEntry {
  const ctx = createParseContext(`${r.owner}/${r.repo}`);
  if (r.kind === 'action')
    return lockEntryOf(parseActionFile(r.raw, source.file, source.text, ctx), source.sha);
  const wf = parseWorkflowFile(r.raw, source.text, ctx);
  const undeclared = undeclaredSecretsRead(wf);
  return { ...lockEntryOf(wf, source.sha), ...(undeclared.length ? { undeclaredSecrets: undeclared } : {}) };
}

/**
 * The lockfile entry of a remote reference, fetched: at the commit something pins it to, else the one its ref points
 * at now. When the API does not have it and a fallback is set, from the fallback (github.com through GitHub Connect),
 * marked with that host.
 */
export async function fetchRemoteEntry(r: RemoteRef, opts: FetchRemotesOptions = {}): Promise<RemoteEntry> {
  const request = requestOptions(opts);
  const sha = opts.lockedCommit?.(r) ?? (await resolveRemoteCommit(r, request));
  const source = await fetchRemoteSourceAt(r, sha, request);
  const entry = entryOf(r, source);
  return source.host === apiHost(apiOf(opts).apiUrl) ? entry : { ...entry, host: source.host };
}

/** How many references of how many are done. */
type Count = { done: number; total: number };

/**
 * Runs `work` on each reference, `concurrency` at a time, after `onStart`, with the options of one run: with a map of
 * the hosts found unreachable, unless they have one. `count` counts the references done.
 */
async function eachRef(
  refs: RemoteRef[],
  opts: FetchRemotesOptions,
  work: (r: RemoteRef, run: FetchRemotesOptions, count: Count) => Promise<void>,
): Promise<void> {
  const count = { done: 0, total: refs.length };
  const run = opts.unreachableHosts ? opts : { ...opts, unreachableHosts: new Map() };
  opts.onStart?.(refs.length);
  await eachLimited(refs, opts.concurrency ?? 8, (r) => work(r, run, count));
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
    return await fetchRemoteEntry(r, opts);
  } catch (e) {
    if (!isFetchFailure(e)) throw e;
    const problem = { ref: r.raw, error: messageOf(e, opts), kind: kindOf(e) };
    if (problem.kind === 'not-found') out.unreadable.push(problem);
    else out.failed.push(problem);
    return undefined;
  }
}

/** An error fetching is expected to raise: the API's or the file's (`RemoteFetchError`), a bad API URL's, a timeout. */
const isFetchFailure = (e: unknown) =>
  e instanceof RemoteFetchError || e instanceof TypeError || (e as Error).name === 'TimeoutError';

/** An error fetching raised, in words, with what to do about it when core's message does not say. */
const messageOf = (e: unknown, opts: FetchRemotesOptions) =>
  e instanceof RemoteFetchError ? `${e.message}${adviceOf(e, opts)}` : (e as Error).message;

/** The kind of an error fetching raised (see `isFetchFailure`). */
function kindOf(e: unknown): RemoteFailureKind {
  if (e instanceof RemoteFetchError) return e.kind;
  return (e as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable';
}

/** `tryFetch`, then `onProgress` with the outcome; `count.done` counts the references finished so far. */
async function fetchCounted(
  r: RemoteRef,
  opts: FetchRemotesOptions,
  out: Problems,
  count: Count,
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
  const refs = remoteRefsOf(index.project, scope);
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
  await eachRef(refs, opts, async (r, run, count) => {
    const old = before.get(remoteKey(r.raw));
    const entry = await fetchCounted(r, run, out, count);
    if (entry) remotes[r.raw] = entry;
    else if (old) remotes[r.raw] = old;
    if (entry && !old) out.added.push(r.raw);
    else if (entry && !same(old, entry)) out.changed.push(r.raw);
  });
  // An entry is dropped only when nothing in the repository uses it; with paths, the others are kept as they were.
  const used = new Set(remoteRefsOf(index.project).map((r) => remoteKey(r.raw)));
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
  const missing = remoteRefsOf(project).filter((r) => !locked.has(remoteKey(r.raw)));
  const actionsLock = readActionsLock(fs);
  return fetchRemoteEntries(missing, { lockedCommit: (r) => lockedCommit(actionsLock, r), ...opts });
}

/** The entries of these references, fetched, and those that could not be fetched (with why). */
export async function fetchRemoteEntries(
  refs: RemoteRef[],
  opts: FetchRemotesOptions = {},
): Promise<FetchedRemotes> {
  const out: FetchedRemotes = { remotes: {}, failed: [], unreadable: [] };
  await eachRef(refs, opts, async (r, run, count) => {
    const entry = await fetchCounted(r, run, out, count);
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
   * (see `RemoteFailureKind`), `cache` when writing the cache failed.
   */
  failed: { ref: string; error: string; kind?: RemoteFailureKind; cache?: true }[];
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
  const refs = remoteRefsOf(index.project, targetedUnits(index));
  const out: RemotesDownload = {
    downloaded: [],
    cached: [],
    notLocked: [],
    skipped: [],
    failed: [],
    commits: [],
  };
  await eachRef(refs, opts, async (r, run, count) => {
    const done = await downloadOne(r, lock, dir, run);
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
  | { list: 'failed'; error: string; kind?: RemoteFailureKind; cache?: true };

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
  if (!remoteSourceFiles(r).some((f) => cachedSourcePath(dir, r, sha, f))) return UNSAFE;
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
): Promise<RemoteSource | { error: string; kind: RemoteFailureKind }> {
  try {
    // From this API alone, as the entry was read; the caller keeps the file (see `keepSource`).
    const { fallback: _fallback, cache: _cache, ...one } = api;
    return await fetchRemoteSourceAt(r, sha, requestOptions(one));
  } catch (e) {
    if (!isFetchFailure(e)) throw e;
    const kind = kindOf(e);
    const message = messageOf(e, api);
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
  if (!entry.host || entry.host === apiHost(apiOf(opts).apiUrl)) return opts;
  if (!opts.fallback || apiHost(opts.fallback.apiUrl) !== entry.host) return undefined;
  const { apiUrl, token } = opts.fallback;
  return { ...opts, apiUrl, ...(token ? { token } : { token: undefined }) };
}
