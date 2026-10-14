import { type ArgsDef, defineCommand } from 'citty';
import { runRemotesUpdate } from '../lib/remotes';
import { remotesText } from '../lib/text';
import {
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
      'Fetch the interfaces of the remote reusable workflows and actions this repository uses into .github/flowpact/remotes.lock.yaml. Token: GH_TOKEN, else GITHUB_TOKEN, else `gh auth token` (sent only to the GitHub API, GITHUB_API_URL on GHES). Public repositories need none; private and internal ones need read access to their contents (fine-grained: Contents: read on them; classic: repo).',
  },
  args: {
    action: {
      type: 'positional',
      required: true,
      description: '`update`: fetch the remote references and write the lockfile',
    },
    paths: {
      type: 'positional',
      required: false,
      description:
        'Workflow/action files or directories whose remote references to fetch, with those of what they call (default: all); other entries are kept',
    },
    ...commonArgs,
    'github-com': {
      type: 'boolean',
      description:
        'On GitHub Enterprise Server or GHE.com (GITHUB_API_URL), also look on github.com for the remote references the enterprise server lacks, as GitHub Connect does; token: GITHUB_COM_TOKEN or none, never the enterprise token. Sends their names to github.com',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show what would change without writing the lockfile',
    },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      if (args.action !== 'update')
        throw new UsageError(`unknown action "${args.action}": use \`flowpact remotes update\``);
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      printBanner(ctx, `root ${displayPath(ctx.root)}`);
      const paths = pathArgs(remotesPaths(args._), 'remotes', ctx.root);
      const counter = counterFor(ctx.level);
      const r = await runRemotesUpdate(ctx.session, {
        paths,
        dryRun: Boolean(args['dry-run']),
        githubCom: Boolean(args['github-com']),
        ...(counter ? { onProgress: counter.update } : {}),
      }).finally(() => counter?.clear());
      ctx.stdout(remotesText(r, ctx.render));
      return r.failed.length ? EXIT.findings : EXIT.ok;
    }),
});

/** The paths after `remotes update`. */
const remotesPaths = (positionals: string[]) =>
  positionals.filter((p, i) => !(i === 0 && p === 'update') && p !== 'remotes');

/** A live count in a terminal at the default level; -v and -d log a line per reference instead, -q nothing. */
const counterFor = (level: string) =>
  level === 'warn' && process.stderr.isTTY ? progressCounter() : undefined;

/** A one-line count of the references fetched so far, rewritten in place on stderr, and cleared when done. */
function progressCounter() {
  let shown = false;
  return {
    update: (p: { done: number; total: number }) => {
      process.stderr.write(`\r\x1b[2Kfetching remote interfaces ${p.done}/${p.total}`);
      shown = true;
    },
    clear: () => {
      if (shown) process.stderr.write('\r\x1b[2K');
    },
  };
}
