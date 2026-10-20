import { jsonSafe } from '@ciatlas/core';
import { type ArgsDef, defineCommand } from 'citty';
import {
  type FetchDisplay,
  failsOn,
  type RemotesDownloadOptions,
  type RemotesFailOn,
  type RemotesUpdateOptions,
  remotesAction,
  remotesFlags,
  remotesPaths,
  runRemotesClean,
  runRemotesDownload,
  runRemotesUpdate,
} from '../lib/remotes';
import { remotesCleanText, remotesDownloadText, remotesText } from '../lib/text';
import { fetchDisplay } from '../progress';
import {
  type CliContext,
  commonArgs,
  createContext,
  displayPath,
  EXIT,
  guard,
  pathArgs,
  printBanner,
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
    'fail-on': {
      type: 'string',
      valueHint: 'breaks|unchecked|never',
      description:
        '`update` only: also exit 1 when a changed entry breaks a call of this repository (breaks), or breaks one or leaves part of one unchecked (unchecked). Default: never',
    },
    format: {
      type: 'enum',
      options: ['pretty', 'json'],
      default: 'pretty',
      description: 'Output format: pretty, or json (the result as the API returns it)',
    },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const action = remotesAction(args.action);
      const flags = remotesFlags(args, action);
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      const out = output(ctx, args.format === 'json');
      if (action === 'clean') return clean(out, flags.keep, args['cache-dir']);
      printBanner(ctx, `root ${displayPath(ctx.root)}`);
      const display = fetchDisplay(
        ctx,
        action === 'update' ? 'fetching remote interfaces' : 'downloading remote sources',
      );
      const options = optionsOf(args, action, ctx.root, display);
      return action === 'download' ? await download(out, options) : await update(out, options, flags);
    }),
});

/** The options both `update` and `download` take, from the command line, with the display of the fetching. */
function optionsOf(
  args: { _: string[]; 'github-com'?: boolean; 'cache-dir'?: string },
  action: string,
  root: string,
  display: FetchDisplay | undefined,
) {
  return {
    paths: pathArgs(remotesPaths(args._, action), 'remotes', root),
    githubCom: Boolean(args['github-com']),
    ...(args['cache-dir'] !== undefined ? { cacheDir: args['cache-dir'] } : {}),
    ...(display ? { display } : {}),
  };
}

/** The context, and how to print a result: as JSON, or as its text. */
interface Output {
  ctx: CliContext;
  print: <T>(result: T, text: (r: T, opts: CliContext['render']) => string) => void;
}

const output = (ctx: CliContext, json: boolean): Output => ({
  ctx,
  print: (result, text) =>
    ctx.stdout(json ? jsonSafe(JSON.stringify(result, null, 2)) : text(result, ctx.render)),
});

function clean({ print }: Output, keep: number, cacheDir: string | undefined): number {
  const r = runRemotesClean({ keep, ...(cacheDir !== undefined ? { cacheDir } : {}) });
  print(r, remotesCleanText);
  return r.failed ? EXIT.findings : EXIT.ok;
}

async function update(
  { ctx, print }: Output,
  options: RemotesUpdateOptions,
  flags: { dryRun: boolean; noCache: boolean; failOn: RemotesFailOn },
): Promise<number> {
  const r = await runRemotesUpdate(ctx.session, {
    ...options,
    dryRun: flags.dryRun,
    ...(flags.noCache ? { cacheDir: false } : {}),
  });
  print(r, remotesText);
  return r.failed.length || failsOn(flags.failOn, r.grades) ? EXIT.findings : EXIT.ok;
}

async function download({ ctx, print }: Output, options: RemotesDownloadOptions): Promise<number> {
  const r = await runRemotesDownload(ctx.session, options);
  print(r, remotesDownloadText);
  return r.failed.length ? EXIT.findings : EXIT.ok;
}
