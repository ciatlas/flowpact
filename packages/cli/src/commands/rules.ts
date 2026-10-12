import { jsonSafe } from '@ciatlas/core';
import { type ArgsDef, defineCommand } from 'citty';
import { listRules } from '../lib/inspect';
import { rulesText } from '../lib/text';
import { commonArgs, createContext, EXIT, guard, pluginArgs } from '../shared';

export const rulesCommand = defineCommand({
  meta: { name: 'rules', description: 'List every rule with its code, effective severity and summary' },
  args: {
    ...commonArgs,
    ...pluginArgs,
    format: { type: 'enum', options: ['pretty', 'json'], default: 'pretty', description: 'Output format' },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      const rules = await listRules(ctx.session);
      if (args.format === 'json') ctx.stdout(jsonSafe(JSON.stringify(rules, null, 2)));
      else ctx.stdout(rulesText(rules, ctx.render));
      return EXIT.ok;
    }),
});
