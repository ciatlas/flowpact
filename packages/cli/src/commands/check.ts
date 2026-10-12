import { type ArgsDef, defineCommand } from 'citty';
import { guard } from '../shared';
import { type ReportArgs, reportArgs, runReportCommand } from './lint';

export const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Lint and compare with the locked contracts in .github/flowpact/ (drift, breaking changes)',
  },
  args: {
    ...reportArgs,
    patch: {
      type: 'string',
      description: 'When contracts drifted, write a `git apply`-able patch with the regenerated contracts',
      valueHint: 'file',
    },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(() => runReportCommand(args as unknown as ReportArgs, rawArgs, 'check', cmd.args as ArgsDef)),
});
