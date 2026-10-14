import { type ArgsDef, defineCommand } from 'citty';
import {
  type RemotesAction,
  type RemotesDownloadOptions,
  type RemotesUpdateOptions,
  remotesAction,
  remotesFlags,
  remotesPaths,
  runRemotesClean,
  runRemotesDownload,
  runRemotesUpdate,
} from '../lib/remotes';
import { remotesCleanText, remotesDownloadText, remotesText } from '../lib/text';
import {
  type CliContext,
  commonArgs,
  createContext,
  displayPath,
  EXIT,
  guard,
  pathArgs,
  printBanner,
  UsageError,
} from '../shared';

export const remotesCommand = defineCommand({
  meta: {
    name: 'remotes',
    description:
      'Fetch the interfaces of the remote reusable workflows and actions this repository uses into .github/flowpact/remotes.lock.yaml, keeping the files read in a per-user cache for the editor (FLOWPACT_CACHE_DIR). Token: GH_TOKEN, else GITHUB_TOKEN, else `gh auth token` (sent only to the GitHub API, GITHUB_API_URL on GHES). Public repositories need none; private and internal ones need read access to their contents (fine-grained: Contents: read on them; classic: repo).',
  },
  args: {
    action: {
      type: 'positional',
      required: true,
      description:
        '`update`: fetch the remote references and write the lockfile; `download`: download the sources of the commits the lockfile pins into the cache, for go to definition in the editor (the lockfile does not change); `clean`: empty the sources cache (or keep the most recent with --keep)',
    },
    paths: {
      type: 'positional',
      required: false,
      description:
        'Workflow/action files or directories whose remote references to fetch (or download), with those of what they call (default: all); other entries are kept',
    },
    ...commonArgs,
    'github-com': {
      type: 'boolean',
      description:
        'On GitHub Enterprise Server or GHE.com (GITHUB_API_URL), also look on github.com for the remote references the enterprise server lacks, as GitHub Connect does; token: GITHUB_COM_TOKEN or none, never the enterprise token. Sends their names to github.com',
    },
    'cache-dir': {
      type: 'string',
      valueHint: 'dir',
      description:
        'flowpact’s cache directory: keep the sources (for go to definition in the editor) in its remotes directory. Default: FLOWPACT_CACHE_DIR, else the per-user cache; `update` keeps none in CI (CI is set) unless given',
    },
    cache: {
      type: 'boolean',
      default: true,
      description: '`update` only: keep the files read in the sources cache (--no-cache keeps none)',
    },
    'dry-run': {
      type: 'boolean',
      description: '`update` only: show what would change without writing the lockfile or the cache',
    },
    keep: {
      type: 'string',
      valueHint: 'n',
      description:
        '`clean` only: keep the n most recently used commits of each repository (update and download keep 3 of those they use)',
    },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const action = remotesAction(args.action);
      const flags = remotesFlags(args, action);
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      if (action === 'clean') return clean(ctx, flags.keep, args['cache-dir']);
      printBanner(ctx, `root ${displayPath(ctx.root)}`);
      const counter = counterFor(ctx.level, action);
      const options = optionsOf(args, action, ctx.root, counter?.update);
      try {
        return action === 'download' ? await download(ctx, options) : await update(ctx, options, flags);
      } finally {
        counter?.clear();
      }
    }),
});

/** The options both `update` and `download` take, from the command line. */
function optionsOf(
  args: { _: string[]; 'github-com'?: boolean; 'cache-dir'?: string },
  action: string,
  root: string,
  onProgress: ((p: { done: number; total: number }) => void) | undefined,
) {
  return {
    paths: pathArgs(remotesPaths(args._, action), 'remotes', root),
    githubCom: Boolean(args['github-com']),
    ...(args['cache-dir'] !== undefined ? { cacheDir: args['cache-dir'] } : {}),
    ...(onProgress ? { onProgress } : {}),
  };
}

function clean(ctx: CliContext, keep: number, cacheDir: string | undefined): number {
  const r = runRemotesClean({ keep, ...(cacheDir !== undefined ? { cacheDir } : {}) });
  ctx.stdout(remotesCleanText(r, ctx.render));
  return r.failed ? EXIT.findings : EXIT.ok;
}

async function update(
  ctx: CliContext,
  options: RemotesUpdateOptions,
  flags: { dryRun: boolean; noCache: boolean },
): Promise<number> {
  const r = await runRemotesUpdate(ctx.session, {
    ...options,
    dryRun: flags.dryRun,
    ...(flags.noCache ? { cacheDir: false } : {}),
  });
  ctx.stdout(remotesText(r, ctx.render));
  return r.failed.length ? EXIT.findings : EXIT.ok;
}

async function download(ctx: CliContext, options: RemotesDownloadOptions): Promise<number> {
  const r = await runRemotesDownload(ctx.session, options);
  ctx.stdout(remotesDownloadText(r, ctx.render));
  return r.failed.length ? EXIT.findings : EXIT.ok;
}

/** A live count in a terminal at the default level; -v and -d log a line per reference instead, -q nothing. */
const counterFor = (level: string, action: RemotesAction) =>
  level === 'warn' && process.stderr.isTTY
    ? progressCounter(action === 'update' ? 'remote interfaces' : 'remote sources')
    : undefined;

/** A one-line count of the references done so far, rewritten in place on stderr, and cleared when done. */
function progressCounter(what: string) {
  let shown = false;
  return {
    update: (p: { done: number; total: number }) => {
      process.stderr.write(`\r\x1b[2Kfetching ${what} ${p.done}/${p.total}`);
      shown = true;
    },
    clear: () => {
      if (shown) process.stderr.write('\r\x1b[2K');
    },
  };
}
