import { jsonSafe } from '@ciatlas/core';
import { type ArgsDef, defineCommand } from 'citty';
import { callGraph } from '../lib/inspect';
import { graphText } from '../lib/text';
import { commonArgs, createContext, displayPath, EXIT, guard, pathArgs, printBanner } from '../shared';

export const graphCommand = defineCommand({
  meta: {
    name: 'graph',
    description: 'Show which workflows call which reusable workflows and local actions',
  },
  args: {
    paths: {
      type: 'positional',
      description: 'Workflow/action files or directories: draw only them and what they call (default: all)',
      required: false,
    },
    ...commonArgs,
    format: {
      type: 'enum',
      options: ['tree', 'mermaid', 'dot', 'json'],
      default: 'tree',
      description: 'tree (terminal), mermaid (Markdown diagrams), dot (Graphviz) or json',
    },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      printBanner(ctx, `root ${displayPath(ctx.root)}`);
      const graph = await callGraph(ctx.session, { paths: pathArgs(args._, 'graph', ctx.root) });
      if (args.format === 'json') ctx.stdout(jsonSafe(JSON.stringify(graph, null, 2)));
      else ctx.stdout(graphText(graph, args.format as 'tree' | 'mermaid' | 'dot', ctx.render));
      return EXIT.ok;
    }),
});
