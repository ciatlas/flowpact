import { jsonSafe } from '@ciatlas/core';
import { type ArgsDef, defineCommand } from 'citty';
import pc from 'picocolors';
import { NoSymbolMatchError } from '../lib/errors';
import { traceSymbol } from '../lib/inspect';
import { traceText } from '../lib/text';
import { commonArgs, createContext, EXIT, guard, pluginArgs, printBanner, UsageError } from '../shared';

export const traceCommand = defineCommand({
  meta: {
    name: 'trace',
    description: 'Show where an input, secret or output flows to (or, with --up, where its value comes from)',
  },
  args: {
    symbol: {
      type: 'positional',
      required: true,
      description:
        'e.g. pipeline.yml#inputs.config, pipeline.yml:config, or pipeline.yml for its whole interface',
    },
    ...commonArgs,
    ...pluginArgs,
    up: { type: 'boolean', description: 'Trace upstream: who provides the value' },
    depth: { type: 'string', default: '12', description: 'Maximum depth', valueHint: 'n' },
    format: { type: 'enum', options: ['pretty', 'json'], default: 'pretty', description: 'Output format' },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      printBanner(ctx);
      const depth = Number(args.depth);
      if (!Number.isInteger(depth) || depth < 1)
        throw new UsageError(`--depth must be a positive integer (got ${args.depth})`);
      let result: Awaited<ReturnType<typeof traceSymbol>>;
      try {
        result = await traceSymbol(ctx.session, { symbol: args.symbol, up: Boolean(args.up), depth });
      } catch (err) {
        // No match: the API lists the files that have an interface to trace; suggest commands for them.
        if (!(err instanceof NoSymbolMatchError && err.traceable.length)) throw err;
        const c = pc.createColors(ctx.render.color);
        throw new UsageError(
          `No symbol matches "${args.symbol}".\n${c.dim('Try a workflow file (to list its interface) such as:')}\n${err.traceable
            .slice(0, 8)
            .map((f) => `  flowpact trace ${f}`)
            .join('\n')}`,
        );
      }
      // JSON is always the same shape, however many symbols matched.
      if (args.format === 'json') ctx.stdout(jsonSafe(JSON.stringify(result, null, 2)));
      else ctx.stdout(traceText(result, ctx.render));
      return EXIT.ok;
    }),
});
