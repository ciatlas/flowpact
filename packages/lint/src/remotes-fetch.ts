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
import {
  lockEntryOf,
  type RemoteEntry,
  type RemoteRef,
  type RemotesLock,
  remoteRefsOf,
  targetedUnits,
} from './remotes';

export interface FetchRemotesOptions {
  /** Sent only to `apiUrl`, never logged. Public repositories can be read without one, at a low rate limit. */
  token?: string;
  /** The GitHub API (`GITHUB_API_URL` on GHES); `https://api.github.com` by default. */
  apiUrl?: string;
  /** For tests. */
  fetch?: typeof fetch;
  /** Requests at a time. */
  concurrency?: number;
  /** Called as each reference is done, for a progress display or a log line. */
  onProgress?: (p: FetchProgress) => void;
}

/** One reference done: how many of how many, and what came of it (its commit, or why it could not be fetched). */
export interface FetchProgress {
  done: number;
  total: number;
  ref: string;
  outcome: 'fetched' | 'unreadable' | 'failed';
  /** The commit it resolved to, or why it could not be fetched. */
  detail: string;
}

export interface RemotesUpdate {
  lock: RemotesLock;
  /** References whose entry is new, changed (another commit or interface), or gone because nothing uses them. */
  added: string[];
  changed: string[];
  removed: string[];
  /** References that could not be fetched (the network, the API or the file), with why; previous entries are kept. */
  failed: { ref: string; error: string }[];
  /**
   * References that do not exist or the token cannot read, with why. One without a previous entry is recorded under
   * the lockfile's `unreadable`, so it is accounted for.
   */
  unreadable: { ref: string; error: string }[];
}

/** Why a reference could not be fetched: `unreadable` when it does not exist or the token cannot read it. */
class FetchError extends Error {
  constructor(
    message: string,
    readonly unreadable = false,
  ) {
    super(message);
  }
}

/** A GET on the GitHub API, as text: `accept` picks the media type (a commit's SHA, a file's raw content). */
async function get(url: string, accept: string, opts: FetchRemotesOptions): Promise<string | undefined> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
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
  // 422: a SHA that is no commit of the repository.
  if (res.status === 404 || res.status === 422) return undefined;
  if (!res.ok) throw httpError(res, opts);
  return bodyOf(res);
}

const TIMEOUT_MS = 30_000;

/** Why a request did not get an answer, and what to check: Node's fetch only says `fetch failed`. */
function networkError(url: string, e: unknown): FetchError {
  const host = new URL(url).origin;
  if ((e as Error).name === 'TimeoutError')
    return new FetchError(
      `no answer from ${host} within ${TIMEOUT_MS / 1000} s: check the network, or try again`,
    );
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const why = cause?.code ?? cause?.message ?? (e as Error).message;
  return new FetchError(
    `could not reach ${host} (${why}): check the network and GITHUB_API_URL; behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1`,
  );
}

/** Why the GitHub API refused a request, and what to do about it. */
function httpError(res: Response, opts: FetchRemotesOptions): FetchError {
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  if (res.status === 401)
    return new FetchError(
      `the GitHub API rejected the token (${status}): check GH_TOKEN or GITHUB_TOKEN, or run \`gh auth status\``,
    );
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0')
    return new FetchError(
      `the GitHub API rate limit is used up (${status})${opts.token ? '; try again later' : ': without a token it allows 60 requests an hour; set GH_TOKEN or GITHUB_TOKEN, or sign in with `gh auth login`'}`,
    );
  if (res.status === 403)
    return new FetchError(
      `the GitHub API refused the request (${status}): the token needs read access to the repository's contents`,
    );
  return new FetchError(`${status} from the GitHub API`);
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
async function shaOf(r: RemoteRef, opts: FetchRemotesOptions): Promise<string> {
  const sha = await get(
    `${repoUrl(r, opts)}/commits/${encodeURIComponent(r.ref)}`,
    'application/vnd.github.sha',
    opts,
  );
  if (!sha || !/^[0-9a-f]{40}$/.test(sha.trim()))
    throw new FetchError(`${r.owner}/${r.repo}@${r.ref} not found, or not readable with this token`, true);
  return sha.trim();
}

/** A file of the repository at `sha`, or undefined when it has none there. */
const fileAt = (r: RemoteRef, path: string, sha: string, opts: FetchRemotesOptions) =>
  get(`${repoUrl(r, opts)}/contents/${contentsPath(path)}?ref=${sha}`, 'application/vnd.github.raw', opts);

/** The lockfile entry of a remote reference, fetched. */
export async function fetchRemoteEntry(r: RemoteRef, opts: FetchRemotesOptions = {}): Promise<RemoteEntry> {
  const sha = await shaOf(r, opts);
  const ctx = createParseContext(`${r.owner}/${r.repo}`);
  if (r.kind === 'workflow') {
    const text = await fileAt(r, r.path, sha, opts);
    if (text === undefined) throw new FetchError(`${r.path} not found at ${sha.slice(0, 7)}`, true);
    return lockEntryOf(parseWorkflowFile(r.raw, text, ctx), sha);
  }
  for (const name of ['action.yml', 'action.yaml']) {
    const file = r.path ? `${r.path}/${name}` : name;
    const text = await fileAt(r, file, sha, opts);
    if (text !== undefined) return lockEntryOf(parseActionFile(r.raw, file, text, ctx), sha);
  }
  throw new FetchError(`no action.yml in ${r.path || 'the repository root'} at ${sha.slice(0, 7)}`, true);
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
    if (!(e instanceof FetchError) && !(e instanceof TypeError) && (e as Error).name !== 'TimeoutError')
      throw e;
    const problem = { ref: r.raw, error: (e as Error).message };
    if (e instanceof FetchError && e.unreadable) out.unreadable.push(problem);
    else out.failed.push(problem);
    return undefined;
  }
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
  failed: { ref: string; error: string }[];
  unreadable: { ref: string; error: string }[];
}

/**
 * The interfaces of the remote references a repository uses that its lockfile lacks, fetched for one run (`--fetch-remotes`,
 * the action's `remotes: fetch`); nothing is written. Entries the lockfile has are not fetched, so its pins stand.
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
  const out: FetchedRemotes = { remotes: {}, failed: [], unreadable: [] };
  const count = { done: 0, total: missing.length };
  await eachLimited(missing, opts.concurrency ?? 8, async (r) => {
    const entry = await fetchCounted(r, opts, out, count);
    if (entry) out.remotes[r.raw] = entry;
  });
  out.failed.sort(byRef);
  out.unreadable.sort(byRef);
  return out;
}
