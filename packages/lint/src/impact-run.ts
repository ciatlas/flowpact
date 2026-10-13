/**
 * Everything impact mode needs before `analyze()`: the declared impact (flags or the GitHub event), the baseline
 * (the pull request's base, the commit before a push, or the last release for a release pull request) analysed from
 * git, and the policy from the baseline's config.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
   * Where the base config was read from. A file of the checked-out commit, or one within a submodule, is the pull
   * request's own version of it, so the baseline's impact settings leave it out: a pull request cannot relax its own
   * check through it. For the baseline's `ignore`, its version in the baseline is read from git (within a submodule,
   * at the baseline's commit of it). A file outside the repository, or one of the working tree that the checked-out
   * commit does not track (say, an organization's config checked out into an ignored directory), is the same on both
   * sides: no commit of the pull request can change it.
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

type TreeEntries = Map<string, { mode: string; object: string }>;

/**
 * The entries of `commit`'s tree along `path` (relative to the top of the repository at `dir`): the file and each
 * directory above it that the tree has, by path. Undefined when git cannot list them (say, no commit checked out).
 */
function entriesAlong(dir: string, commit: string, path: string): TreeEntries | undefined {
  const parts = path.split('/');
  const along = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  const out = gitOutput(dir, ['ls-tree', '-z', '--full-tree', commit, '--', ...along]);
  if (out === undefined) return undefined;
  const entries: TreeEntries = new Map();
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode = '', , object = ''] = entry.slice(0, tab).split(' ');
    entries.set(entry.slice(tab + 1), { mode, object });
  }
  return entries;
}

/** The submodule a tree holds `path` in (see `entriesAlong`): its path and its commit. */
function submoduleHolding(entries: TreeEntries, path: string): { path: string; commit: string } | undefined {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    const entry = entries.get(dir);
    if (entry?.mode === '160000') return { path: dir, commit: entry.object };
  }
  return undefined;
}

/**
 * The real top directory of the git work tree `root` is in. `.native` gives the case the file system stores, so a path
 * written in another case on a case-insensitive file system still names the file git tracks.
 */
const realTop = (root: string) => realpathSync.native(gitTopLevel(root)!);

/**
 * The base config's path in the repository when the pull request's commits can change it: a file of the checked-out
 * commit, or one within a submodule, whose commit they may move. Undefined for one outside the repository, and for one
 * of the working tree that the checked-out commit does not track, which is the same on both sides.
 */
function baseConfigOfRepository(root: string, req: ImpactRequest): string | undefined {
  const file = req.baseConfig ? req.baseConfigFile : undefined;
  const top = file ? gitTopLevel(root) : undefined;
  if (!file || top === undefined || !pathInside(top, file)) return undefined;
  const path = relative(realTop(root), realpathSync.native(file)).split(sep).join('/');
  const entries = entriesAlong(realTop(root), 'HEAD', path);
  // Without a commit to tell, it is the pull request's own.
  if (!entries || entries.has(path) || submoduleHolding(entries, path)) return path;
  return undefined;
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

/**
 * `path` as `commit` of the repository at `dir` has it, through the submodules that hold it, each at its commit there:
 * `text` (undefined when the commit lacks the file), or `unread`, the submodule (`shown` before its path) whose commit
 * this clone lacks.
 */
function textAt(
  dir: string,
  commit: string,
  path: string,
  shown = '',
): { text: string | undefined } | { unread: string } {
  const sub = submoduleHolding(entriesAlong(dir, commit, path) ?? new Map(), path);
  if (!sub) return { text: baselineFiles(dir, commit).read(path) };
  const subDir = join(dir, sub.path);
  if (!isCheckout(subDir) || !hasCommit(subDir, sub.commit))
    return { unread: `${shown}${sub.path} at ${sub.commit.slice(0, 7)}` };
  return textAt(subDir, sub.commit, path.slice(sub.path.length + 1), `${shown}${sub.path}/`);
}

/**
 * The baseline's version of a base config of the repository: `config`, absent when the baseline lacks it or has an
 * invalid one (noted), whose `ignore` then does not count; `unread` when a submodule's commit it is in is not in the
 * clone (noted).
 */
function baseConfigAt(
  root: string,
  commit: string,
  path: string,
  notes: string[],
): { config?: FlowpactConfig; unread?: true } {
  const read = textAt(realTop(root), commit, path);
  if ('unread' in read) {
    notes.push(
      `the baseline's version of the base config ${path} is in the submodule ${read.unread}, which this clone lacks, so impact mode reads no ignore from it for the baseline`,
    );
    return { unread: true };
  }
  if (read.text === undefined) return {};
  try {
    return { config: parseConfig(parseBaseConfig(read.text, path), path) };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    notes.push(`the baseline's ${path} is invalid (${err.message}); impact mode reads no ignore from it`);
    return {};
  }
}

/**
 * The baseline's `ignore`, which impact mode pairs with the pull request's own: its config's, on top of the base
 * config's. A base config the pull request cannot change is the same on both sides; one of the repository counts as the
 * baseline has it, so a base config the pull request leaves alone ignores the same on both sides. `unread` names one
 * whose baseline version cannot be read.
 */
function baselineIgnore(
  root: string,
  commit: string,
  repositoryBaseConfig: string | undefined,
  config: FlowpactConfig | undefined,
  notes: string[],
): { patterns: readonly string[]; unread?: string } {
  const own = (config ?? defaultConfig()).ignore;
  if (!repositoryBaseConfig) return { patterns: own };
  const base = baseConfigAt(root, commit, repositoryBaseConfig, notes);
  if (base.unread) return { patterns: own, unread: repositoryBaseConfig };
  return { patterns: base.config ? [...new Set([...base.config.ignore, ...own])] : own };
}

/** The baseline's config, the impact policy it sets, and its `ignore`. */
function baselinePolicy(
  root: string,
  baseline: { fs: FileSystem; commit: string },
  req: ImpactRequest,
  headConfig: FlowpactConfig,
  notes: string[],
): {
  config: FlowpactConfig | undefined;
  policy: ImpactPolicy;
  ignore: ReturnType<typeof baselineIgnore>;
} {
  const configPath = req.configPath
    ? relative(root, join(root, req.configPath)).split('\\').join('/')
    : undefined;
  const repositoryBaseConfig = baseConfigOfRepository(root, req);
  const baseInRepository = repositoryBaseConfig !== undefined;
  if (baseInRepository) {
    notes.push(
      "the base config is a file of this repository, so the baseline's impact settings leave it out",
    );
  }
  const config = baselineConfig(
    baseline.fs,
    configPath,
    baseInRepository ? undefined : req.baseConfig,
    notes,
  );
  // Policy comes from the baseline (or the defaults), never from the pull request, so it cannot relax its own check.
  const policy: ImpactPolicy = { ...(config ?? defaultConfig()).impact };
  if (!baseInRepository && JSON.stringify(policy) !== JSON.stringify(headConfig.impact)) {
    notes.push('this pull request changes impact settings; they apply after it is merged');
  }
  const ignore = baselineIgnore(root, baseline.commit, repositoryBaseConfig, config, notes);
  return { config, policy, ignore };
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
      ignore: ignore.patterns,
      ...(ignore.unread ? { ignoreUnread: ignore.unread } : {}),
    },
    notes,
  };
}
