import { type ArgsDef, defineCommand } from 'citty';
import {
  type RemotesDownloadOptions,
  type RemotesUpdateOptions,
  runRemotesDownload,
  runRemotesUpdate,
} from '../lib/remotes';
import { remotesDownloadText, remotesText } from '../lib/text';
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
        '`update`: fetch the remote references and write the lockfile; `download`: download the sources of the commits the lockfile pins into the cache, for go to definition in the editor (the lockfile does not change)',
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
    'dry-run': {
      type: 'boolean',
      description: '`update` only: show what would change without writing the lockfile or the cache',
    },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const action = actionOf(args.action);
      const dryRun = Boolean(args['dry-run']);
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      printBanner(ctx, `root ${displayPath(ctx.root)}`);
      const counter = counterFor(ctx.level, action === 'update' ? 'remote interfaces' : 'remote sources');
      const options = {
        paths: pathArgs(remotesPaths(args._, action), 'remotes', ctx.root),
        githubCom: Boolean(args['github-com']),
        ...(counter ? { onProgress: counter.update } : {}),
      };
      try {
        return action === 'download'
          ? await download(ctx, options, dryRun)
          : await update(ctx, { ...options, dryRun });
      } finally {
        counter?.clear();
      }
    }),
});

/** The action asked for; another one is refused. */
function actionOf(action: string): 'update' | 'download' {
  if (action === 'update' || action === 'download') return action;
  throw new UsageError(
    `unknown action "${action}": use \`flowpact remotes update\` or \`flowpact remotes download\``,
  );
}

async function update(ctx: CliContext, options: RemotesUpdateOptions): Promise<number> {
  const r = await runRemotesUpdate(ctx.session, options);
  ctx.stdout(remotesText(r, ctx.render));
  return r.failed.length ? EXIT.findings : EXIT.ok;
}

async function download(ctx: CliContext, options: RemotesDownloadOptions, dryRun: boolean): Promise<number> {
  if (dryRun) throw new UsageError('--dry-run is for `flowpact remotes update`');
  const r = await runRemotesDownload(ctx.session, options);
  ctx.stdout(remotesDownloadText(r, ctx.render));
  return r.failed.length ? EXIT.findings : EXIT.ok;
}

/** The paths after `remotes update` (or `download`). */
const remotesPaths = (positionals: string[], action: string) =>
  positionals.filter((p, i) => !(i === 0 && p === action) && p !== 'remotes');

/** A live count in a terminal at the default level; -v and -d log a line per reference instead, -q nothing. */
const counterFor = (level: string, what: string) =>
  level === 'warn' && process.stderr.isTTY ? progressCounter(what) : undefined;

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
