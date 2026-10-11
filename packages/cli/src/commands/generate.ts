import { type ArgsDef, defineCommand } from 'citty';
import { runGenerate } from '../lib/generate';
import { generationText } from '../lib/text';
import {
  commonArgs,
  createContext,
  displayPath,
  EXIT,
  guard,
  pathArgs,
  pluginArgs,
  printBanner,
  writeOutput,
} from '../shared';

export const generateCommand = defineCommand({
  meta: {
    name: 'generate',
    description:
      'Write (or preview) the contracts of every workflow and local action, or of the given ones, into .github/flowpact/',
  },
  args: {
    paths: {
      type: 'positional',
      description:
        'Workflow/action files or directories whose contracts to write (default: all); contracts that list them as a consumer are updated too',
      required: false,
    },
    ...commonArgs,
    ...pluginArgs,
    'dry-run': {
      type: 'boolean',
      description: 'Show what would change (with a diff) without writing anything',
    },
    patch: {
      type: 'string',
      description: 'Write the changes as a `git apply`-able patch instead of applying them',
      valueHint: 'file',
    },
    out: {
      type: 'string',
      description: 'Write all contracts under this directory instead of the repository',
      valueHint: 'dir',
    },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      printBanner(ctx, `root ${displayPath(ctx.root)}`);
      const paths = pathArgs(args._, 'generate', ctx.root);
      const dryRun = Boolean(args['dry-run']);
      // Written before anything is printed, so the summary never claims files that were refused.
      const generated = await runGenerate(ctx.session, {
        paths,
        dryRun: dryRun || Boolean(args.patch),
        ...(args.out ? { out: args.out } : {}),
      });
      // --dry-run and --patch write nothing (the text says what would be); --dry-run adds the diff.
      ctx.stdout(generationText(generated, ctx.render, dryRun));
      if (dryRun) return EXIT.ok;
      if (args.patch) {
        writeOutput(args.patch, generated.patch() ?? '', ctx, 'data');
        return EXIT.ok;
      }
      ctx.logger.info(`wrote ${generated.written.length} contract file(s)`, { files: generated.written });
      if (generated.skipped.length) {
        // Their locked contracts were kept; regenerating from a broken file would erase the interface.
        ctx.stderr(
          `Not regenerated (YAML syntax errors — run \`flowpact lint\`): ${generated.skipped.join(', ')}`,
        );
        return EXIT.findings;
      }
      return EXIT.ok;
    }),
});
