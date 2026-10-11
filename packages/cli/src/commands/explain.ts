import { type ArgsDef, defineCommand } from 'citty';
import { FlowpactError } from '../lib/errors';
import { explainRule } from '../lib/inspect';
import { explainText } from '../lib/text';
import { commonArgs, createContext, EXIT, guard, pluginArgs, UsageError } from '../shared';

export const explainCommand = defineCommand({
  meta: {
    name: 'explain',
    description: 'Explain a rule: why it matters, how to fix it, examples and docs link',
  },
  args: {
    code: {
      type: 'positional',
      required: true,
      description: 'Rule code or name, e.g. FP401 or empty-binding-for-matrix-combo',
    },
    ...commonArgs,
    ...pluginArgs,
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      let rule: Awaited<ReturnType<typeof explainRule>>;
      try {
        rule = await explainRule(ctx.session, args.code);
      } catch (err) {
        // An unknown rule: point at the list.
        if (err instanceof FlowpactError && err.kind === 'usage')
          throw new UsageError(`${err.message} Run \`flowpact rules\` for the list.`);
        throw err;
      }
      ctx.stdout(explainText(rule, ctx.render));
      return EXIT.ok;
    }),
});
