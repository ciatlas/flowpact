import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  createParseContext,
  type Loc,
  lookup,
  type Occurrence,
  parseActionFile,
  parseWorkflowFile,
  type SymbolLocator,
  type UnitDecl,
} from '@ciatlas/core';
import {
  cachedSource,
  commitOf,
  hostOf,
  lockedRemote,
  parseRemoteRef,
  type RemoteEntry,
  type RemotesLock,
  remotesCacheDir,
} from '@flowpact/lint';
import type { RemoteBinding } from './remotes';

/** A remote reference's cached source: the file on disk, its path in its repository, and its unit, parsed from it. */
export interface CachedUnit {
  path: string;
  file: string;
  unit: UnitDecl;
}

/**
 * The remote sources cache as the editor reads it (see `remotesCacheDir`): the file of a remote reference at the commit
 * it runs (`commitOf`: its own full SHA, else the commit the lockfile pins). Each file is parsed once: a file at a
 * commit never changes. Without a directory (no home directory to keep one in), it has nothing.
 */
export class RemoteSources {
  /** Files parsed, by path. Only files read: one that could not be (pruned meanwhile) is read again next time. */
  private readonly parsed = new Map<string, UnitDecl>();
  private readonly realDir: string | undefined;

  constructor(readonly dir: string | undefined = remotesCacheDir()) {
    this.realDir = dir && real(dir);
  }

  /** The cached source of a remote reference the lockfile has; undefined without an entry, or a file in the cache. */
  of(lock: RemotesLock | undefined, ref: string): CachedUnit | undefined {
    const { entry } = lockedRemote(lock, ref);
    const r = entry && parseRemoteRef(ref, entry.kind);
    const found = r && this.dir && cachedSource(this.dir, r, commitOf(r, entry));
    if (!found) return undefined;
    const unit =
      this.parsed.get(found.path) ?? parseCached(found.path, found.file, entry, `${r.owner}/${r.repo}`);
    if (unit) this.parsed.set(found.path, unit);
    return unit ? { ...found, unit } : undefined;
  }

  /**
   * Whether a file (or directory) is in the cache: it is another repository's, at a commit, so it is not analyzed. Also
   * through another path to it: a link, or another case of a case-insensitive file system.
   */
  contains(path: string): boolean {
    if (!this.dir) return false;
    if (inside(this.dir, path)) return true;
    if (!this.realDir) return false;
    const file = real(path);
    return file !== undefined && inside(this.realDir, file);
  }
}

const inside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** A path as the file system has it (links resolved, case corrected), or undefined when it does not exist. */
function real(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/** A cached file, parsed as the kind the lockfile records; undefined when it cannot be read. */
function parseCached(
  path: string,
  file: string,
  entry: RemoteEntry,
  repository: string,
): UnitDecl | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const ctx = createParseContext(repository);
  return entry.kind === 'workflow'
    ? parseWorkflowFile(file, text, ctx)
    : parseActionFile(file, file, text, ctx);
}

/** A place in a cached source: the file, and the declaration there (none for the file itself). */
export interface SourceTarget {
  path: string;
  loc?: Loc;
}

/**
 * Where Go to Definition goes from a remote occurrence, in the cached source: a `uses:` value to the file (a reusable
 * workflow's `workflow_call:`), a key a remote call passes to its input or secret, a read of a remote call's or step's
 * output to that output. Undefined when the cache does not have the source.
 */
export function remoteTarget(
  locator: SymbolLocator,
  lock: RemotesLock | undefined,
  sources: RemoteSources,
  at: Occurrence,
  binding?: RemoteBinding,
): SourceTarget | undefined {
  if (binding) {
    const cached = sources.of(lock, binding.ref);
    return cached && declared(cached, `${binding.decl.kind}s`, binding.decl.decl.name);
  }
  if (at.symbol.startsWith('remote:') && !at.symbol.includes('#')) {
    const cached = sources.of(lock, at.symbol.slice('remote:'.length));
    if (!cached) return undefined;
    const call = cached.unit.kind === 'workflow' ? cached.unit.call : undefined;
    return { path: cached.path, ...(call ? { loc: call.loc } : {}) };
  }
  const output = remoteOutput(locator, at.symbol);
  const cached = output && sources.of(lock, output.ref);
  return cached && declared(cached, 'outputs', output.name);
}

/** An input, secret or output of a cached unit, where its source declares it. */
function declared(cached: CachedUnit, part: Part, name: string): SourceTarget | undefined {
  const decl = declarationIn(cached.unit, part, name);
  return decl ? { path: cached.path, loc: decl.loc } : undefined;
}

type Part = 'inputs' | 'secrets' | 'outputs';

/** An input, secret or output a unit declares (an action has no secrets), with its description. */
export function declarationIn(
  unit: UnitDecl,
  part: Part,
  name: string,
): { loc: Loc; description?: string } | undefined {
  const decls = unit.kind === 'workflow' ? unit.call?.[part] : part === 'secrets' ? undefined : unit[part];
  return decls && lookup<{ loc: Loc; description?: string }>(decls, name);
}

/**
 * The remote reference and output name a read of an output stands for: `needs.<job>.outputs.<name>` of a job that calls
 * a remote workflow, or `steps.<id>.outputs.<name>` of a step that uses a remote action.
 */
function remoteOutput(locator: SymbolLocator, symbol: string): { ref: string; name: string } | undefined {
  const job = /^(.*)#jobs\.([^.]+)\.outputs\.(.+)$/.exec(symbol);
  if (job) return remoteJobOutput(locator, job[1]!, job[2]!, job[3]!);
  // In a workflow's job (`#jobs.<job>.steps…`) or in a composite action (`#steps…`); ids hold no dots.
  const step = /#(?:jobs\.[^.]+\.)?steps\.[^.]+\.outputs\.(.+)$/.exec(symbol);
  return step ? remoteStepOutput(locator, symbol, step[1]!) : undefined;
}

/** An output of a job that calls a remote workflow. */
function remoteJobOutput(locator: SymbolLocator, unitPath: string, jobId: string, name: string) {
  const unit = locator.index.unit(unitPath);
  const job = unit?.kind === 'workflow' ? lookup(unit.jobs, jobId) : undefined;
  return job?.uses?.kind === 'remote-workflow' ? { ref: job.uses.raw, name } : undefined;
}

/** An output of a step that uses a remote action: the step is the read's declaration (its `id:`). */
function remoteStepOutput(locator: SymbolLocator, symbol: string, name: string) {
  const decl = locator.declarations(symbol).find((d) => d.kind === 'step');
  const uses = decl?.kind === 'step' ? decl.decl.uses : undefined;
  return uses?.kind === 'remote-action' ? { ref: uses.raw, name } : undefined;
}

/**
 * The host to link the sources of remote references on, when it is certain: where `flowpact remotes update` reads them
 * (`GITHUB_API_URL`, else github.com's API), told by `GITHUB_API_URL`, or by an `origin` on github.com (an SSH alias
 * such as `github.com-work` included) or GHE.com. Another origin host may be an SSH alias or another forge, so no
 * link is better than a wrong one.
 */
export function webHostOf(
  root: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.GITHUB_API_URL) {
    try {
      return plainHost(hostOf(env.GITHUB_API_URL));
    } catch {
      return undefined;
    }
  }
  const origin = originHost(root);
  if (!origin) return undefined;
  if (origin === 'github.com' || origin === 'ssh.github.com' || origin.startsWith('github.com-'))
    return 'github.com';
  return origin.endsWith('.ghe.com') ? origin : undefined;
}

/** The host of the `origin` remote of the repository a directory is in (or below), as its URL writes it. */
export function originHost(root: string): string | undefined {
  const config = gitConfigOf(root);
  let text: string;
  try {
    text = config ? readFileSync(config, 'utf8') : '';
  } catch {
    return undefined;
  }
  // `url` at the start of a line, not the end of `pushurl` (as core's `detectRepository` reads it).
  const url = /\[remote "origin"\][^[]*?^[ \t]*url\s*=\s*(\S+)/m.exec(text)?.[1];
  return url ? hostOfGitUrl(url) : undefined;
}

/**
 * The git config of the repository a directory is in: `.git/config`, found upwards. A `.git` file names the git
 * directory: a worktree's has a `commondir` naming the main repository's; a submodule's (or one made with
 * `--separate-git-dir`) is its own.
 */
function gitConfigOf(root: string): string | undefined {
  let top = root;
  while (!existsSync(join(top, '.git'))) {
    if (dirname(top) === top) return undefined;
    top = dirname(top);
  }
  const git = join(top, '.git');
  try {
    if (statSync(git).isDirectory()) return join(git, 'config');
    if (!statSync(git).isFile()) return undefined;
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, 'utf8'))?.[1]?.trim();
    if (!gitdir) return undefined;
    const dir = isAbsolute(gitdir) ? gitdir : join(top, gitdir);
    const common = join(dir, 'commondir');
    const base = existsSync(common) ? join(dir, readFileSync(common, 'utf8').trim()) : dir;
    return join(base, 'config');
  } catch {
    return undefined;
  }
}

/** The host of a git remote's URL: `https://host/…`, `ssh://git@host:22/…`, or `git@host:owner/repo`. */
export function hostOfGitUrl(url: string): string | undefined {
  const scp = /^[^@/:]+@([^:/]+):/.exec(url);
  let host = scp?.[1];
  if (!host) {
    try {
      host = new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
  return plainHost(host);
}

/** A host name as links may use it: letters, digits, dots and hyphens only, in lower case. */
const plainHost = (host: string) => (/^[a-z0-9.-]+$/i.test(host) ? host.toLowerCase() : undefined);

/**
 * A link to a remote reference's file (an action's directory) on its host at the commit it runs (`commitOf`): the host
 * an entry was read from (`github.com`, the only one flowpact writes), else where `remotes update` reads (`webHost`).
 */
export function sourceLink(ref: string, entry: RemoteEntry, webHost: string | undefined): string | undefined {
  const host = entry.host === 'github.com' ? entry.host : entry.host ? undefined : webHost;
  const r = parseRemoteRef(ref, entry.kind);
  if (!host || !r) return undefined;
  const path = r.path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const sha = commitOf(r, entry);
  const where = r.kind === 'workflow' ? `blob/${sha}/${path}` : `tree/${sha}${path ? `/${path}` : ''}`;
  return `https://${host}/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/${where}`;
}
