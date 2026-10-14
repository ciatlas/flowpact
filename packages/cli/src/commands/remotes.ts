import { type ArgsDef, defineCommand } from 'citty';
import { runRemotesUpdate } from '../lib/remotes';
import { remotesText } from '../lib/text';
import { commonArgs, createContext, displayPath, EXIT, guard, printBanner, UsageError } from '../shared';

export const remotesCommand = defineCommand({
  meta: {
    name: 'remotes',
    description:
      'Fetch the interfaces of the remote reusable workflows and actions this repository uses into .github/flowpact/remotes.lock.yaml',
  },
  args: {
    action: {
      type: 'positional',
      required: true,
      description: '`update`: fetch every remote reference and write the lockfile',
    },
    ...commonArgs,
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
      const r = await runRemotesUpdate(ctx.session, { dryRun: Boolean(args['dry-run']) });
      ctx.stdout(remotesText(r, ctx.render));
      return r.failed.length ? EXIT.findings : EXIT.ok;
    }),
});
