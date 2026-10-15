/**
 * The remote references a pull request moves to another version (`octo/setup@v2` → `@v3`), graded against the
 * repository's calls (see `gradeRemoteChanges`), to gate a bot's version bump. The interface before is the base's: its
 * lockfile's entry for the reference the pull request replaced, else that reference fetched. The interface after is
 * always fetched: the pull request's own lockfile could record one that hides a break.
 */
import {
  detectRepository,
  type FileSystem,
  loadProject,
  nodeFileSystem,
  ProjectIndex,
  remoteKey,
} from '@ciatlas/core';
import type { AnalyzeOptions } from './analyze';
import { lockedRemote, type RemoteEntry, type RemoteRef, readRemotesLock, remoteRefsOf } from './remotes';
import { type FetchRemotesOptions, fetchRemoteEntries } from './remotes-fetch';
import { gradeRemoteChanges, type RemoteChange, type RemoteChangeGrade } from './remotes-grade';

/** A remote reference of the head that replaced one of the base: the same workflow or action at another `@ref`. */
export interface VersionChange {
  ref: RemoteRef;
  from: RemoteRef;
}

/** What a reference points at, without its version: its kind, repository (owner and name in any case) and path. */
const targetOf = (r: RemoteRef) => `${r.kind}:${r.owner.toLowerCase()}/${r.repo.toLowerCase()}/${r.path}`;

/**
 * The head's references the base did not use, each with a base reference to the same workflow or action that it
 * replaced: preferably one the head no longer uses. A reference to something the base did not use is new, not a version
 * change.
 */
export function versionChanges(base: RemoteRef[], head: RemoteRef[]): VersionChange[] {
  const inBase = new Set(base.map((r) => remoteKey(r.raw)));
  const inHead = new Set(head.map((r) => remoteKey(r.raw)));
  const replaced = (target: string) => {
    const same = base.filter((r) => targetOf(r) === target);
    return same.find((r) => !inHead.has(remoteKey(r.raw))) ?? same[0];
  };
  return head.flatMap((ref) => {
    const from = inBase.has(remoteKey(ref.raw)) ? undefined : replaced(targetOf(ref));
    return from ? [{ ref, from }] : [];
  });
}

/** The remote references the workflows and actions of a file system use. */
function refsIn(opts: AnalyzeOptions, fs: FileSystem): RemoteRef[] {
  const repository = opts.repository ?? opts.config?.repository ?? detectRepository(opts.root);
  const project = loadProject({
    root: opts.root,
    fs,
    validateSchema: false,
    ...(repository ? { repository } : {}),
  });
  return remoteRefsOf(new ProjectIndex(project));
}

export interface VersionGrading {
  changes: VersionChange[];
  /** One per change whose interfaces before and after could be read. */
  grades: RemoteChangeGrade[];
  /** References that could not be fetched, with why: their changes are not graded. */
  failed: { ref: string; error: string }[];
}

/**
 * Grades the version changes from the base's files (`base`, such as a pull request's base commit read from git) to the
 * analyzed ones (`opts.fs`, else the working tree). `fetch` says how to reach the GitHub API.
 */
export async function gradeVersionChanges(
  opts: AnalyzeOptions,
  base: FileSystem,
  fetch: FetchRemotesOptions = {},
): Promise<VersionGrading> {
  const changes = versionChanges(refsIn(opts, base), refsIn(opts, opts.fs ?? nodeFileSystem(opts.root)));
  if (!changes.length) return { changes, grades: [], failed: [] };
  const baseLock = readRemotesLock(base).lock;
  const locked = (r: RemoteRef) => lockedRemote(baseLock, r.raw).entry;
  const toFetch = [...changes.map((c) => c.ref), ...changes.map((c) => c.from).filter((r) => !locked(r))];
  const fetched = await fetchRemoteEntries(
    toFetch.filter((r, i) => toFetch.findIndex((o) => o.raw === r.raw) === i),
    fetch,
  );
  const entry = (r: RemoteRef): RemoteEntry | undefined => fetched.remotes[r.raw];
  const graded = changes.flatMap((c): RemoteChange[] => {
    const before = locked(c.from) ?? entry(c.from);
    const after = entry(c.ref);
    return before && after ? [{ ref: c.ref.raw, before, after }] : [];
  });
  return {
    changes,
    grades: graded.length ? gradeRemoteChanges(opts, graded) : [],
    failed: [...fetched.failed, ...fetched.unreadable],
  };
}
