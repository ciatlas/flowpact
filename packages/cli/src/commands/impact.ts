import { type ArgsDef, defineCommand } from 'citty';
import { guard } from '../shared';
import { type ReportArgs, reportArgs, runReportCommand } from './lint';

const { paths: _paths, impact: _impact, ...rest } = reportArgs;

const args = {
  paths: {
    type: 'positional',
    description:
      'Workflow/action files or directories: judge only the published ones within them (default: every published one)',
    required: false,
  },
  ...rest,
} satisfies ArgsDef;

export const impactCommand = defineCommand({
  meta: {
    name: 'impact',
    description:
      'Check that the declared release impact (PR title, labels, --expect) covers the changes to published workflows and actions',
  },
  args,
  run: ({ args, rawArgs, cmd }) =>
    guard(() => runReportCommand(args as unknown as ReportArgs, rawArgs, 'impact', cmd.args as ArgsDef)),
});
