/**
 * Everything impact mode needs before `analyze()`: the declared impact (flags or the GitHub event), the baseline
 * (the pull request's base, the commit before a push, or the last release for a release pull request) analysed from
 * git, and the policy from the baseline's config.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  type FileSystem,
  type GitError,
  gitFileSystem,
  gitTopLevel,
  type Logger,
  resolveCommit,
} from '@ciatlas/core';
import { type AnalyzeOptions, analyze } from './analyze';
import {
  CONFIG_DIR,
  CONFIG_FILES,
  ConfigError,
  defaultConfig,
  type FlowpactConfig,
  parseBaseConfig,
  parseConfig,
  parseConfigText,
} from './config';
import { pathInside } from './contracts';
import { type DeclaredInput, type ImpactLevel, type ImpactPolicy, isPublished } from './impact';

export class ImpactSetupError extends Error {}

export interface ImpactRequest {
  /** Explicit baseline ref; default: the pull request base, the commit before a push, or the remote's default branch. */
  base?: string;
  expect?: ImpactLevel;
  title?: string;
  labels?: string[];
  /** The GitHub event (`GITHUB_EVENT_NAME` and the parsed `GITHUB_EVENT_PATH`), when running in Actions. */
  event?: { name?: string; payload?: GitHubEventPayload };
  repository?: string;
  /** The config file the head uses, relative to the root (`--config`); the same path is read from the baseline. */
  configPath?: string;
  /** The base config the head uses (`--base-config`, from `loadBaseConfig`); the baseline's config goes on top of it too. */
  baseConfig?: Record<string, unknown>;
  /**
   * Where the base config was read from. A file of the checked-out commit, one within a submodule, or one reached
   * through a symbolic link either has, is the pull request's own version of it, so the baseline's impact settings
   * leave it out: a pull request cannot relax its own check through it. For the baseline's `ignore`, its version in the
   * baseline is read from git, following each link and submodule on the way as the baseline has it (a submodule at the
   * baseline's commit of it). A file outside the repository, or one of the working tree that no commit tracks (say, an
   * organization's config checked out into an ignored directory, or one generated within a submodule), is the same on
   * both sides: no commit of the pull request can change it.
   */
  baseConfigFile?: string;
  /** Called with refs (commits, `refs/tags/…`) the clone lacks, so a shallow checkout can fetch them. */
  fetch?: (refs: string[]) => void;
  /**
   * The paths the run is given: the baseline loads the workflows and actions within them too, so a path naming one
   * the change removed is known even when nothing used it.
   */
  paths?: string[];
}

export interface GitHubEventPayload {
  pull_request?: { title?: string; labels?: { name?: string }[]; base?: { sha?: string; ref?: string } };
  before?: string;
}

export type PreparedImpact =
  | { skip: string }
  | { options: NonNullable<AnalyzeOptions['impact']>; notes: string[] };

/**
 * Whether a run on this GitHub event usually follows the run of a pull request, which has the baseline: `merge_group`
 * and `push`. Only there may a path that names no workflow or action of the working tree go unrefused while impact mode
 * is skipped, as the change may have removed what it named and that run, when there was one, has refused a mistake. Not
 * every push follows one (a new branch's first push comes before any pull request); a workflow that runs only on push
 * refuses a mistake with `impact: on`, which compares a later push with the commit before it. Elsewhere
 * (`pull_request_target`, `schedule`, `workflow_dispatch`, a run outside GitHub Actions) no such run comes first.
 */
export const followsPullRequest = (event: string | undefined): boolean =>
  event === 'merge_group' || event === 'push';

/** Reads `GITHUB_EVENT_NAME` / `GITHUB_EVENT_PATH` (a missing or unreadable payload is treated as none). */
export function githubEvent(env: NodeJS.ProcessEnv = process.env): ImpactRequest['event'] {
  if (!env.GITHUB_EVENT_NAME) return undefined;
  let payload: GitHubEventPayload | undefined;
  try {
    if (env.GITHUB_EVENT_PATH) payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    payload = undefined;
  }
  return { name: env.GITHUB_EVENT_NAME, ...(payload ? { payload } : {}) };
}

/** release-please's release pull request title (`chore(main): release 0.3.0`, `chore: release main`). */
export const RELEASE_TITLE = /^chore(\([^)]*\))?: release\b/i;
const RELEASE_LABEL = 'autorelease: pending';

export function isReleasePullRequest(title: string | undefined, labels: string[]): boolean {
  return (title !== undefined && RELEASE_TITLE.test(title)) || labels.includes(RELEASE_LABEL);
}

function readJson(fs: FileSystem, path: string): Record<string, unknown> | undefined {
  const text = fs.read(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The project's version: release-please's manifest (root component), else the root package.json. */
function versionOf(fs: FileSystem): string | undefined {
  const manifest = readJson(fs, '.release-please-manifest.json');
  const v = manifest?.['.'];
  if (typeof v === 'string') return v;
  const pkg = readJson(fs, 'package.json');
  return typeof pkg?.version === 'string' ? pkg.version : undefined;
}

/** release-please's settings for the root package; a package's own setting overrides the top level. */
function releaseSettings(fs: FileSystem) {
  const config = readJson(fs, 'release-please-config.json') ?? {};
  const pkg = ((config.packages as Record<string, Record<string, unknown>> | undefined)?.['.'] ??
    {}) as Record<string, unknown>;
  const get = (key: string) => (pkg[key] ?? config[key]) as unknown;
  const component = (get('component') ?? get('package-name')) as string | undefined;
  return {
    bumpMinorPreMajor: get('bump-minor-pre-major') === true,
    bumpPatchForMinorPreMajor: get('bump-patch-for-minor-pre-major') === true,
    includeV: get('include-v-in-tag') !== false,
    component:
      get('include-component-in-tag') === true && typeof component === 'string' ? component : undefined,
  };
}

/**
 * The baseline's config: from `configPath` or the default locations, on top of the base config when there is one.
 * Without a config (or with an invalid one), the base config alone, or undefined for the defaults.
 */
function baselineConfig(
  fs: FileSystem,
  configPath: string | undefined,
  base: Record<string, unknown> | undefined,
  notes: string[],
): FlowpactConfig | undefined {
  const fallback = () => (base ? parseConfig(base) : undefined);
  const candidates = configPath ? [configPath] : CONFIG_FILES.map((f) => `${CONFIG_DIR}/${f}`);
  for (const path of candidates) {
    const text = fs.read(path);
    if (text === undefined) continue;
    try {
      return parseConfigText(text, path, base).config;
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      notes.push(
        `the baseline's ${path} is invalid (${err.message}); using the ${base ? 'base config’s' : 'default'} impact settings`,
      );
      return fallback();
    }
  }
  return fallback();
}

const workingTree = (root: string): FileSystem => ({
  read: (p) => {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      return undefined;
    }
  },
  list: () => [],
  walk: () => [],
  isDir: () => false,
});

/** The commit `ref` points at, fetching it through `fetch` when the clone lacks it. */
function commitOf(root: string, ref: string, fetch: ImpactRequest['fetch']): string {
  try {
    return resolveCommit(root, ref);
  } catch (err) {
    if (!fetch) throw new ImpactSetupError((err as GitError).message);
    fetch([ref]);
    try {
      return resolveCommit(root, ref);
    } catch (again) {
      throw new ImpactSetupError((again as GitError).message);
    }
  }
}

function defaultBase(root: string): string {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    try {
      resolveCommit(root, ref);
      return ref;
    } catch {
      // try the next one
    }
  }
  throw new ImpactSetupError('No baseline: pass --base <ref> (for example --base origin/main).');
}

const ZERO_SHA = /^0+$/;

/** For a push, the commit before it, or why there is none (a new branch or tag); undefined for other events. */
function pushBase(event: ImpactRequest['event']): string | { skip: string } | undefined {
  if (event?.name !== 'push') return undefined;
  const before = event.payload?.before;
  if (before && !ZERO_SHA.test(before)) return before;
  return { skip: 'push without a previous commit (new branch or tag)' };
}

/** The requested baseline: `--base`, the pull request's base, the commit before a push, or the remote's default branch. */
function requestedBase(root: string, req: ImpactRequest): string | { skip: string } {
  if (req.base) return req.base;
  const sha = req.event?.payload?.pull_request?.base?.sha;
  if (sha) return sha;
  return pushBase(req.event) ?? defaultBase(root);
}

/** The tag of the release `previous` (as release-please names it), fetched through `req.fetch` when the clone lacks it. */
function releaseTag(
  root: string,
  previous: string,
  settings: ReturnType<typeof releaseSettings>,
  req: ImpactRequest,
): string {
  const tags = [
    ...(settings.component
      ? [`${settings.component}-v${previous}`, `${settings.component}-${previous}`]
      : []),
    settings.includeV ? `v${previous}` : previous,
    settings.includeV ? previous : `v${previous}`,
  ];
  const found = () =>
    tags.find((t) => {
      try {
        resolveCommit(root, `refs/tags/${t}`);
        return true;
      } catch {
        return false;
      }
    });
  let tag = found();
  if (!tag && req.fetch) {
    req.fetch(tags.map((t) => `+refs/tags/${t}:refs/tags/${t}`));
    tag = found();
  }
  if (!tag)
    throw new ImpactSetupError(
      `No release tag for ${previous} (tried ${tags.join(', ')}); fetch tags first.`,
    );
  return tag;
}

/**
 * A release pull request changes only versions and the changelog; what matters is everything since the last release,
 * against the version it proposes. Its tag and versions, or undefined when the version does not change.
 */
function lastRelease(
  root: string,
  commit: string,
  req: ImpactRequest,
): { tag: string; release: NonNullable<DeclaredInput['release']> } | undefined {
  const previous = versionOf(gitFileSystem(root, commit));
  const next = versionOf(workingTree(root));
  if (!previous || !next || previous === next) return undefined;
  const settings = releaseSettings(workingTree(root));
  const tag = releaseTag(root, previous, settings, req);
  return {
    tag,
    release: {
      previous,
      version: next,
      bumpMinorPreMajor: settings.bumpMinorPreMajor,
      bumpPatchForMinorPreMajor: settings.bumpPatchForMinorPreMajor,
    },
  };
}

interface Baseline {
  kind: 'ref' | 'release';
  ref: string;
  commit: string;
  release?: NonNullable<DeclaredInput['release']>;
}

/** The commit of the requested ref, or for a release pull request, of the last release's tag. */
function baselineOf(
  root: string,
  ref: string,
  req: ImpactRequest,
  pr: { title: string | undefined; labels: string[] },
  notes: string[],
): Baseline {
  const commit = commitOf(root, ref, req.fetch);
  const last = isReleasePullRequest(pr.title, pr.labels) ? lastRelease(root, commit, req) : undefined;
  if (!last) return { kind: 'ref', ref, commit };
  const tagCommit = commitOf(root, `refs/tags/${last.tag}`, undefined);
  notes.push(
    `release pull request: ${last.release.previous} → ${last.release.version}, compared with ${last.tag}`,
  );
  return { kind: 'release', ref: last.tag, commit: tagCommit, release: last.release };
}

/** The checked-out commit, if there is one. */
function headCommit(root: string): string | undefined {
  try {
    return resolveCommit(root, 'HEAD');
  } catch {
    return undefined;
  }
}

/** The baseline's files, read from git. */
function baselineFiles(root: string, commit: string): FileSystem {
  try {
    return gitFileSystem(root, commit);
  } catch (err) {
    throw new ImpactSetupError((err as Error).message);
  }
}

/** A git command's output in `dir`, with pathspecs taken literally; undefined when it fails. */
function gitOutput(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['--literal-pathspecs', '-C', dir, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch {
    return undefined;
  }
}

/** Whether `dir` is the top of a git work tree of its own (a submodule that is checked out). */
function isCheckout(dir: string): boolean {
  const top = existsSync(dir) ? gitTopLevel(dir) : undefined;
  return top !== undefined && realpathSync.native(top) === realpathSync.native(dir);
}

function hasCommit(dir: string, commit: string): boolean {
  try {
    resolveCommit(dir, commit);
    return true;
  } catch {
    return false;
  }
}

/** An entry of a git tree: its name, mode and object. */
interface TreeEntry {
  name: string;
  mode: string;
  object: string;
}

/** The entries `git ls-tree -z` printed; none when it failed. */
function treeEntries(out: string | undefined): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const line of (out ?? '').split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [mode = '', , object = ''] = line.slice(0, tab).split(' ');
    entries.push({ name: line.slice(tab + 1), mode, object });
  }
  return entries;
}

/** The entry named `name`, or in another letter case where the file system ignores case, as git checks out there. */
const entryNamed = (entries: TreeEntry[], name: string, ignoreCase: boolean) =>
  entries.find((e) => e.name === name) ??
  (ignoreCase ? entries.find((e) => e.name.toLowerCase() === name.toLowerCase()) : undefined);

/** Whether two paths are the same file. */
const sameFile = (a: string, b: string): boolean => {
  const [x, y] = [statSync(a, { throwIfNoEntry: false }), statSync(b, { throwIfNoEntry: false })];
  return x !== undefined && y !== undefined && x.ino === y.ino && x.dev === y.dev;
};

/**
 * Whether paths in the repository at `dir` (its top) reach a file in another letter case: where git says so, or the
 * file system ignores case (macOS and Windows by default), which `core.ignorecase=false` does not change.
 */
const ignoresCase = (dir: string) =>
  gitOutput(dir, ['config', '--bool', 'core.ignorecase'])?.trim() === 'true' ||
  sameFile(join(dir, '.git'), join(dir, '.GIT'));

const realpathOr = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

/**
 * `file` (absolute) as a path of the repository whose real top directory is `top`, or undefined outside it. It is
 * taken from the outermost directory above it that is the top, so the symbolic links on the way stay parts of it, a
 * link in the repository to its own top included.
 */
function repositoryPathOf(top: string, file: string): string | undefined {
  const dirs: string[] = [];
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) dirs.unshift(dir);
  for (const dir of dirs) if (realpathOr(dir) === top) return relative(dir, file).split(sep).join('/');
  const real = realpathOr(file);
  return real !== undefined && pathInside(top, real) ? relative(top, real).split(sep).join('/') : undefined;
}

/**
 * What a checkout of a commit has at a path (see `locate`): a file the commit tracks (`object` in the repository at
 * `dir`, which is a submodule's with `submodule`; `path` from the top), a file of the working tree that no commit
 * tracks or one outside the repository (`file`, its real path), none, or `unread`: the submodule whose commit there
 * this clone lacks.
 */
type Located =
  | { kind: 'tracked'; dir: string; object: string; path: string; submodule: boolean }
  | { kind: 'file'; file: string }
  | { kind: 'none' }
  | { kind: 'unread'; submodule: string; path: string };

const NONE: Located = { kind: 'none' };

/** Symbolic links followed before a path counts as none, so a loop ends (Linux's limit). */
const MAX_LINKS = 40;

/** A path being followed through a checkout of a commit (see `locate`). */
interface Walk {
  /** The real top directory of the repository, and the commit of it the walk follows the path in. */
  top: string;
  commit: string;
  /** The repository the walk is in (the top's, or a submodule's directory) and its commit there. */
  dir: string;
  tree: string;
  ignoreCase: boolean;
  /** The submodules the walk is in, as a path (`.org/`). */
  shown: string;
  /** The directories walked in `dir`, each with its tree (none for one the commit lacks). */
  at: { name: string; tree: string | undefined }[];
  /** The parts of the path left. */
  todo: string[];
  links: number;
}

/** Goes on in the repository at `dir`, at its `commit`, from its top. */
function enter(w: Walk, dir: string, commit: string, shown: string): void {
  Object.assign(w, { dir, tree: commit, shown, at: [], ignoreCase: ignoresCase(dir) });
}

/** The path from the top of the repository to `name` in the directory the walk is at. */
const walked = (w: Walk, name: string) => `${w.shown}${[...w.at.map((a) => a.name), name].join('/')}`;

/** A file of the working tree at `abs`, by its real path; none when there is no such file. */
const fileAt = (abs: string): Located => {
  const real = realpathOr(abs);
  return real !== undefined && statSync(real).isFile() ? { kind: 'file', file: real } : NONE;
};

/** The path continues at `abs` (absolute, the parts left included): from the top when it is in the repository. */
function leave(w: Walk, abs: string): Located | undefined {
  const path = repositoryPathOf(w.top, abs);
  if (path === undefined) return fileAt(abs);
  enter(w, w.top, w.commit, '');
  w.todo = path.split('/');
  return undefined;
}

/** Follows a symbolic link to `target`: the parts left go on from where it points. */
function follow(w: Walk, target: string | undefined): Located | undefined {
  if (target === undefined || ++w.links > MAX_LINKS) return NONE;
  if (isAbsolute(target)) return leave(w, join(target, ...w.todo));
  w.todo.unshift(...target.split('/'));
  return undefined;
}

/** Goes on in a submodule, at the commit the tree records for it, when the clone has that commit checked out. */
function submodule(w: Walk, entry: TreeEntry): Located | undefined {
  const path = [...w.at.map((a) => a.name), entry.name].join('/');
  const dir = join(w.dir, path);
  if (!isCheckout(dir) || !hasCommit(dir, entry.object)) {
    const at = `${w.shown}${path} at ${entry.object.slice(0, 7)}`;
    return { kind: 'unread', submodule: at, path: [`${w.shown}${path}`, ...w.todo].join('/') };
  }
  enter(w, dir, entry.object, `${w.shown}${path}/`);
  return undefined;
}

/** Goes on through an entry of the commit: a directory, a symbolic link, a submodule or, last, the file. */
function tracked(w: Walk, entry: TreeEntry): Located | undefined {
  switch (entry.mode) {
    case '040000':
      w.at.push({ name: entry.name, tree: entry.object });
      return undefined;
    case '120000':
      return follow(w, gitOutput(w.dir, ['cat-file', 'blob', entry.object]));
    case '160000':
      return submodule(w, entry);
    default:
      if (w.todo.length) return NONE;
      return {
        kind: 'tracked',
        dir: w.dir,
        object: entry.object,
        path: walked(w, entry.name),
        submodule: w.shown !== '',
      };
  }
}

/**
 * Whether the commit checked out in the repository the walk is in tracks a file, link or submodule along `parts`:
 * at the last of them, or in place of a directory before it (a pull request that turns a directory into a link or a
 * submodule controls what the path reaches); also when there is no commit to tell.
 */
function trackedAtHead(w: Walk, parts: string[]): boolean {
  if (!hasCommit(w.dir, 'HEAD')) return true;
  let tree = 'HEAD';
  for (const part of parts) {
    const entry = entryNamed(treeEntries(gitOutput(w.dir, ['ls-tree', '-z', tree])), part, w.ignoreCase);
    if (!entry) return false;
    if (entry.mode !== '040000') return true;
    tree = entry.object;
  }
  return false;
}

/**
 * Goes on through a part the commit lacks: none where the checked-out commit tracks it or something on the way to it
 * (the pull request added it), else as the working tree has it, the same on both sides: a symbolic link, a directory
 * or, last, the file.
 */
function untracked(w: Walk, part: string): Located | undefined {
  const parent = w.at.map((a) => a.name);
  if (trackedAtHead(w, [...parent, part])) return NONE;
  const full = join(w.dir, ...parent, part);
  let stat: Stats;
  try {
    stat = lstatSync(full);
  } catch {
    return NONE;
  }
  if (stat.isSymbolicLink()) return follow(w, readlinkSync(full).split(sep).join('/'));
  if (!stat.isDirectory()) return w.todo.length ? NONE : fileAt(full);
  w.at.push({ name: part, tree: undefined });
  return undefined;
}

/** Goes on through one part of the path; what is there when the walk ends with it. */
function step(w: Walk, part: string): Located | undefined {
  if (part === '' || part === '.') return undefined;
  if (part === '..') return w.at.pop() ? undefined : leave(w, join(w.dir, '..', ...w.todo));
  const tree = w.at.length ? w.at[w.at.length - 1]!.tree : w.tree;
  const entries = tree === undefined ? [] : treeEntries(gitOutput(w.dir, ['ls-tree', '-z', tree]));
  const entry = entryNamed(entries, part, w.ignoreCase);
  return entry ? tracked(w, entry) : untracked(w, part);
}

/**
 * What a checkout of `commit` of the repository at `top` (its real path) has at `path`: each symbolic link and
 * submodule on the way followed as the commit has it (a submodule at the commit it records there), and the files no
 * commit tracks as the working tree has them.
 */
function locate(top: string, commit: string, path: string): Located {
  const w: Walk = {
    top,
    commit,
    dir: top,
    tree: commit,
    ignoreCase: false,
    shown: '',
    at: [],
    todo: [],
    links: 0,
  };
  enter(w, top, commit, '');
  w.todo = path.split('/');
  for (let part = w.todo.shift(); part !== undefined; part = w.todo.shift()) {
    const found = step(w, part);
    if (found) return found;
  }
  return NONE;
}

/** The text of a file `locate` found; undefined for none, or one that cannot be read. */
const textOf = (found: Located): string | undefined => {
  if (found.kind === 'tracked') return gitOutput(found.dir, ['cat-file', 'blob', found.object]);
  return found.kind === 'file' ? workingTree(dirname(found.file)).read(basename(found.file)) : undefined;
};

/** A base config the pull request's commits can change: its path from the top, and what the baseline has there. */
interface RepositoryBaseConfig {
  top: string;
  path: string;
  baseline: Located;
}

/**
 * The base config when the pull request's commits can change it: a file of the repository, or one reached through a
 * symbolic link or submodule of it, that the baseline does not read from the very file the working tree has. Undefined
 * for one outside the repository, and for one no commit tracks, which is the same on both sides.
 */
function repositoryBaseConfig(
  root: string,
  commit: string,
  req: ImpactRequest,
): RepositoryBaseConfig | undefined {
  const file = req.baseConfig ? req.baseConfigFile : undefined;
  const top = file ? gitTopLevel(root) : undefined;
  if (!file || top === undefined) return undefined;
  const realTop = realpathSync.native(top);
  const path = repositoryPathOf(realTop, file);
  if (path === undefined) return undefined;
  const baseline = locate(realTop, commit, path);
  if (baseline.kind === 'file' && baseline.file === realpathOr(file)) return undefined;
  return { top: realTop, path, baseline };
}

/** A base config's text as a config, or the error that refuses it. */
function asBaseConfig(text: string, path: string): FlowpactConfig | ConfigError {
  try {
    return parseConfig(parseBaseConfig(text, path), path);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
}

/**
 * The baseline's version of a base config of the repository: `config`, absent when the baseline lacks it or has an
 * invalid one (noted), whose `ignore` then does not count; `unread` when a submodule's commit it is in is not in the
 * clone (noted).
 */
function baseConfigAt(
  base: RepositoryBaseConfig,
  notes: string[],
): { config?: FlowpactConfig; unread?: true } {
  const found = base.baseline;
  if (found.kind === 'unread') {
    notes.push(
      `the baseline's version of the base config ${found.path} is in the submodule ${found.submodule}, which this clone lacks, so impact mode reads no ignore from it for the baseline`,
    );
    return { unread: true };
  }
  const text = textOf(found);
  if (text === undefined) return {};
  const path = found.kind === 'tracked' ? found.path : base.path;
  const config = asBaseConfig(text, path);
  if (config instanceof ConfigError) {
    notes.push(`the baseline's ${path} is invalid (${config.message}); impact mode reads no ignore from it`);
    return {};
  }
  return { config };
}

/** What impact mode pairs with the pull request's own `ignore` (see `AnalyzeOptions['impact']`). */
type BaselineIgnore = Pick<
  NonNullable<AnalyzeOptions['impact']>,
  'ignore' | 'ignoreUnread' | 'ignoreAfterMerge'
>;

/**
 * The baseline's `ignore`, which impact mode pairs with the pull request's own: its config's, on top of the base
 * config's. A base config the pull request cannot change is the same on both sides; one of the repository counts as the
 * baseline has it, so a base config the pull request leaves alone ignores the same on both sides. `ignoreUnread` names
 * one whose baseline version cannot be read.
 */
function baselineIgnore(
  base: RepositoryBaseConfig | undefined,
  config: FlowpactConfig | undefined,
  notes: string[],
): BaselineIgnore {
  const own = (config ?? defaultConfig()).ignore;
  if (!base) return { ignore: own };
  const at = baseConfigAt(base, notes);
  if (at.unread) return { ignore: own, ignoreUnread: base.path };
  return { ignore: at.config ? [...new Set([...at.config.ignore, ...own])] : own };
}

/**
 * The pull request's `ignore` as its commits have it, when the working tree may have another: for a base config of the
 * repository in a submodule, at the commit the checked-out commit records for it (`git submodule update --remote`
 * checks out another), under the config's own. When the clone lacks that commit, the config's own alone (noted), as
 * for the baseline. Undefined otherwise: the working tree's is the pull request's.
 */
function ignoreAfterMerge(
  root: string,
  base: RepositoryBaseConfig,
  configPath: string | undefined,
  notes: string[],
): readonly string[] | undefined {
  const head = locate(base.top, 'HEAD', base.path);
  if (head.kind !== 'unread' && (head.kind !== 'tracked' || !head.submodule)) return undefined;
  // The config's own `ignore`, without the base config's: read like the baseline's, from the working tree.
  const own = baselineConfig(workingTree(root), configPath, undefined, [])?.ignore ?? [];
  if (head.kind === 'unread') {
    notes.push(
      `the pull request's version of the base config ${head.path} is in the submodule ${head.submodule}, which this clone lacks, so impact mode reads no ignore from it for the pull request`,
    );
    return own;
  }
  const recorded = asBaseConfig(textOf(head) ?? '', head.path);
  return [...new Set([...(recorded instanceof ConfigError ? [] : recorded.ignore), ...own])];
}

/** The baseline's config, the impact policy it sets, and its `ignore`, beside the pull request's once merged. */
function baselinePolicy(
  root: string,
  baseline: { fs: FileSystem; commit: string },
  req: ImpactRequest,
  headConfig: FlowpactConfig,
  notes: string[],
): {
  config: FlowpactConfig | undefined;
  policy: ImpactPolicy;
  ignore: BaselineIgnore;
} {
  const configPath = req.configPath
    ? relative(root, join(root, req.configPath)).split('\\').join('/')
    : undefined;
  const repositoryBase = repositoryBaseConfig(root, baseline.commit, req);
  if (repositoryBase) {
    notes.push(
      "the base config is a file of this repository, so the baseline's impact settings leave it out",
    );
  }
  const config = baselineConfig(baseline.fs, configPath, repositoryBase ? undefined : req.baseConfig, notes);
  // Policy comes from the baseline (or the defaults), never from the pull request, so it cannot relax its own check.
  const policy: ImpactPolicy = { ...(config ?? defaultConfig()).impact };
  if (!repositoryBase && JSON.stringify(policy) !== JSON.stringify(headConfig.impact)) {
    notes.push('this pull request changes impact settings; they apply after it is merged');
  }
  const ignore = baselineIgnore(repositoryBase, config, notes);
  const afterMerge = repositoryBase && ignoreAfterMerge(root, repositoryBase, configPath, notes);
  return { config, policy, ignore: { ...ignore, ...(afterMerge ? { ignoreAfterMerge: afterMerge } : {}) } };
}

/** The pull request's title and labels: given in the request, else read from the pull request event. */
function titleAndLabels(req: ImpactRequest): { title: string | undefined; labels: string[] } {
  const pr = req.event?.payload?.pull_request;
  const title = req.title ?? pr?.title;
  const labels = req.labels ?? (pr?.labels ?? []).map((l) => l.name ?? '').filter(Boolean);
  return { title, labels };
}

/** What the pull request declares: the explicit level, the title (not for a release), the labels and the release. */
function declaredOf(
  req: ImpactRequest,
  title: string | undefined,
  labels: string[],
  release: DeclaredInput['release'],
): DeclaredInput {
  return {
    ...(req.expect ? { explicit: req.expect } : {}),
    ...(title !== undefined && !release ? { title } : {}),
    ...(labels.length ? { labels } : {}),
    ...(release ? { release } : {}),
  };
}

/** Resolves the baseline and the declaration, and analyses the baseline. */
export function prepareImpact(
  root: string,
  headConfig: FlowpactConfig,
  req: ImpactRequest,
  logger?: Logger,
): PreparedImpact {
  const eventName = req.event?.name;
  if (eventName === 'merge_group') return { skip: 'merge_group: impact was checked on the pull request' };
  if (eventName === 'pull_request_target' && !req.base) {
    throw new ImpactSetupError(
      'pull_request_target runs on the default branch, so it would compare the default branch with itself. Run impact mode on pull_request (or pass a base and check out the pull request head).',
    );
  }
  const { title, labels } = titleAndLabels(req);
  const notes: string[] = [];

  const requested = requestedBase(root, req);
  if (typeof requested !== 'string') return requested;
  const baseline = baselineOf(root, requested, req, { title, labels }, notes);
  const { kind, ref: baseRef, commit, release } = baseline;
  if (headCommit(root) === commit) return { skip: `the baseline ${baseRef} is the checked-out commit` };

  const fs = baselineFiles(root, commit);
  const { config: baseConfig, policy, ignore } = baselinePolicy(root, { fs, commit }, req, headConfig, notes);
  logger?.debug('impact baseline', { ref: baseRef, commit, kind });
  const config = baseConfig ?? defaultConfig();
  // No rules run on the baseline (only: []), so its rule settings cannot fail it.
  const base = analyze({
    root,
    fs,
    config,
    validateSchema: false,
    only: [],
    ...(req.repository ? { repository: req.repository } : {}),
    ...(req.paths?.length ? { paths: req.paths } : {}),
  });
  return {
    options: {
      base: base.index,
      baseline: { kind, ref: baseRef, commit },
      declared: declaredOf(req, title, labels, release),
      policy,
      // Load the head's copies of what the baseline published, so a unit that still exists is compared, not "removed".
      publishedFiles: base.index
        .units()
        .filter((u) => isPublished(u, policy))
        .map((u) => u.file),
      // Impact mode leaves out only the units both this and the pull request's own `ignore` match, so a pull request
      // can neither ignore a published unit to take it out of its own check, nor take one out of `ignore` unchecked.
      ...ignore,
    },
    notes,
  };
}
