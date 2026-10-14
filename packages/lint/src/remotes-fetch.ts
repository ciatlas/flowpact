/**
 * Fetching remote interfaces: each remote reference resolved to a commit through the GitHub API, and the interface
 * read from its workflow file or `action.yml` at that commit. Only `flowpact remotes update` and, opted in, a CI run
 * fetch; every other run reads the committed lockfile.
 */
import {
  createParseContext,
  type ProjectIndex,
  parseActionFile,
  parseWorkflowFile,
  remoteKey,
  trimChar,
} from '@ciatlas/core';
import { lockEntryOf, type RemoteEntry, type RemoteRef, type RemotesLock, remoteRefsOf } from './remotes';

export interface FetchRemotesOptions {
  /** Sent only to `apiUrl`, never logged. Public repositories can be read without one, at a low rate limit. */
  token?: string;
  /** The GitHub API (`GITHUB_API_URL` on GHES); `https://api.github.com` by default. */
  apiUrl?: string;
  /** For tests. */
  fetch?: typeof fetch;
  /** Requests at a time. */
  concurrency?: number;
}

export interface RemotesUpdate {
  lock: RemotesLock;
  /** References whose entry is new, changed (another commit or interface), or gone because nothing uses them. */
  added: string[];
  changed: string[];
  removed: string[];
  /** References that could not be fetched, with why; their previous entries are kept. */
  failed: { ref: string; error: string }[];
}

class FetchError extends Error {}

/** A GET on the GitHub API, as text: `accept` picks the media type (a commit's SHA, a file's raw content). */
async function get(url: string, accept: string, opts: FetchRemotesOptions): Promise<string | undefined> {
  const res = await (opts.fetch ?? fetch)(url, {
    headers: {
      accept,
      'user-agent': 'flowpact',
      'x-github-api-version': '2022-11-28',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new FetchError(`${res.status} ${res.statusText || 'error'} from the GitHub API`);
  return res.text();
}

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
    throw new FetchError(`${r.owner}/${r.repo}@${r.ref} not found, or not readable with this token`);
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
    if (text === undefined) throw new FetchError(`${r.path} not found at ${sha.slice(0, 7)}`);
    return lockEntryOf(parseWorkflowFile(r.raw, text, ctx), sha);
  }
  for (const name of ['action.yml', 'action.yaml']) {
    const file = r.path ? `${r.path}/${name}` : name;
    const text = await fileAt(r, file, sha, opts);
    if (text !== undefined) return lockEntryOf(parseActionFile(r.raw, file, text, ctx), sha);
  }
  throw new FetchError(`no action.yml in ${r.path || 'the repository root'} at ${sha.slice(0, 7)}`);
}

/** Runs `work` on each item, `limit` at a time. */
async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The lockfile for the remote references a project uses, fetched: one entry each, entries of references nothing uses
 * any more dropped. A reference that cannot be fetched keeps its previous entry and is listed as failed.
 */
export async function updateRemotesLock(
  index: ProjectIndex,
  previous: RemotesLock | undefined,
  opts: FetchRemotesOptions = {},
): Promise<RemotesUpdate> {
  const refs = remoteRefsOf(index);
  const before = new Map(Object.entries(previous?.remotes ?? {}).map(([ref, e]) => [remoteKey(ref), e]));
  const remotes: RemotesLock['remotes'] = {};
  const out: RemotesUpdate = {
    lock: { version: 1, remotes },
    added: [],
    changed: [],
    removed: [],
    failed: [],
  };
  await eachLimited(refs, opts.concurrency ?? 8, async (r) => {
    const old = before.get(remoteKey(r.raw));
    try {
      const entry = await fetchRemoteEntry(r, opts);
      remotes[r.raw] = entry;
      if (!old) out.added.push(r.raw);
      else if (!same(old, entry)) out.changed.push(r.raw);
    } catch (e) {
      if (!(e instanceof FetchError) && !(e instanceof TypeError) && (e as Error).name !== 'TimeoutError')
        throw e;
      out.failed.push({ ref: r.raw, error: (e as Error).message });
      if (old) remotes[r.raw] = old;
    }
  });
  const used = new Set(refs.map((r) => remoteKey(r.raw)));
  out.removed = Object.keys(previous?.remotes ?? {}).filter((ref) => !used.has(remoteKey(ref)));
  for (const list of [out.added, out.changed, out.removed]) list.sort();
  out.failed.sort((a, b) => (a.ref < b.ref ? -1 : 1));
  return out;
}
