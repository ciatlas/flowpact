import { type ImpactLevel, jsonSafe } from '@flowpact/core';
import type { MarkdownOptions } from '@flowpact/reporters';
import { type ArgsDef, defineCommand } from 'citty';
import { type FailOn, runReport as runAnalysis } from '../lib/report';
import {
  commonArgs,
  createContext,
  displayPath,
  guard,
  pathArgs,
  pluginArgs,
  printBanner,
  repeatedFlag,
  UsageError,
  workspacePrefix,
  writeOutput,
  writeWorkflowCommands,
} from '../shared';

/** Flags shared by `lint` and `check`. */
export const reportArgs = {
  paths: {
    type: 'positional',
    description: 'Workflow/action files or directories to report on (default: all)',
    required: false,
  },
  ...commonArgs,
  ...pluginArgs,
  format: {
    type: 'enum',
    options: ['pretty', 'json', 'markdown', 'sarif', 'github'],
    default: 'pretty',
    description:
      'Output format on stdout: pretty, json, markdown (job summaries, PR comments), sarif (code scanning) or github (annotations in GitHub Actions)',
  },
  output: {
    type: 'string',
    alias: 'o',
    description:
      'Also write the report to a file (repeatable), format by extension: .sarif/.sarif.json → SARIF, .json → JSON, .md → Markdown, otherwise plain text; or name it: markdown:<file>',
    valueHint: 'file',
  },
  'fail-on': {
    type: 'enum',
    options: ['error', 'warning', 'never'],
    default: 'error',
    description: 'Exit 1 when findings at this level exist',
  },
  'hide-info': { type: 'boolean', description: 'Do not list info-level findings (still counted)' },
  only: {
    type: 'string',
    description: 'Comma-separated rule codes or names to run',
    valueHint: 'FP401,...',
  },
  'include-graph': {
    type: 'boolean',
    description: 'Include the data-flow graph in JSON output and the call graph (Mermaid) in Markdown output',
  },
  'dump-graph': {
    type: 'string',
    description: 'Write the data-flow graph as JSON (debugging)',
    valueHint: 'file',
  },
  schema: {
    type: 'boolean',
    default: true,
    description: 'Validate against GitHub’s workflow schema (--no-schema to skip)',
  },
  impact: {
    type: 'boolean',
    description:
      'Also check the release impact of changes to published workflows and actions against the declared impact',
  },
  ...impactArgs(),
} satisfies ArgsDef;

/** Flags of impact mode (`--impact` on lint/check, and `flowpact impact`). */
export function impactArgs() {
  return {
    base: {
      type: 'string',
      description:
        'Baseline ref to compare with (default: the pull request base in GitHub Actions, else origin/HEAD)',
      valueHint: 'ref',
    },
    expect: {
      type: 'enum',
      options: ['none', 'patch', 'minor', 'major'],
      description: 'The declared impact (default: read from --title, --labels or the pull request)',
    },
    title: {
      type: 'string',
      description: 'Pull request title to read the declared impact from (Conventional Commits)',
      valueHint: 'text',
    },
    labels: {
      type: 'string',
      description: 'Comma-separated pull request labels (semver:major, semver:minor, …)',
      valueHint: 'a,b',
    },
  } satisfies ArgsDef;
}

type ReportFlags = {
  _: string[];
  format: string;
  output?: string | undefined;
  'fail-on': string;
  'hide-info'?: boolean | undefined;
  only?: string | undefined;
  'include-graph'?: boolean | undefined;
  'dump-graph'?: string | undefined;
  schema?: boolean | undefined;
  patch?: string | undefined;
  impact?: boolean | undefined;
  base?: string | undefined;
  expect?: string | undefined;
  title?: string | undefined;
  labels?: string | undefined;
};

export type ReportArgs = ReportFlags & Parameters<typeof createContext>[0];

type Format = 'pretty' | 'json' | 'markdown' | 'sarif' | 'github';

/** The format `-o` writes, chosen by the file extension. */
export function formatForFile(file: string): Format {
  const f = file.toLowerCase();
  if (f.endsWith('.sarif') || f.endsWith('.sarif.json')) return 'sarif';
  if (f.endsWith('.json')) return 'json';
  if (f.endsWith('.md')) return 'markdown';
  return 'pretty';
}

/**
 * A `-o` value: `<file>`, format by extension, or `<format>:<file>` for files without a telling name, such as
 * `markdown:$GITHUB_STEP_SUMMARY`. A one-letter prefix is a Windows drive, not a format.
 */
export function parseOutput(spec: string): { format: Format; file: string } {
  const named = /^(pretty|json|markdown|sarif|github):(.+)$/.exec(spec);
  if (!named) return { format: formatForFile(spec), file: spec };
  if (named[1] === 'github')
    throw new UsageError(
      'The github format is for the job log: use --format github instead of -o github:<file>.',
    );
  return { format: named[1] as Format, file: named[2]! };
}

/** In GitHub Actions, link Markdown locations to the files at the commit being checked. */
function markdownOptionsFromEnv(pathPrefix: string, env: NodeJS.ProcessEnv = process.env): MarkdownOptions {
  const { GITHUB_ACTIONS, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA } = env;
  if (GITHUB_ACTIONS !== 'true' || !GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_SHA) return {};
  // Links are `<repo>/blob/<sha>/<file>` with root-relative files, so a root in a subdirectory joins the sha.
  return {
    repoUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`,
    sha: pathPrefix ? `${GITHUB_SHA}/${pathPrefix}` : GITHUB_SHA,
  };
}

/**
 * Shared implementation of `flowpact lint`, `flowpact check` and `flowpact impact`: the API's `lint`, `check` and
 * `impact`, with the banner, the `impact:` notes and the reports printed and written as the flags ask.
 */
export async function runReport(
  args: ReportArgs,
  rawArgs: string[],
  command: 'lint' | 'check' | 'impact',
  def: ArgsDef,
): Promise<number> {
  const ctx = createContext(args, rawArgs, def);
  printBanner(
    ctx,
    `root ${displayPath(ctx.root)}${ctx.loaded.file ? ` · config ${ctx.loaded.file}` : ''}${ctx.loaded.base ? ` · base ${ctx.loaded.base.file}` : ''}`,
  );
  const paths = pathArgs(args._, command, ctx.root);
  const only = args.only
    ? args.only
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  // Before the analysis, so a bad -o fails fast.
  const outputs = repeatedFlag(rawArgs, def, 'output').filter(Boolean);
  if (!outputs.length && args.output) outputs.push(args.output);
  const files = outputs.map(parseOutput);
  const analysis = await runAnalysis(
    ctx.session,
    command,
    {
      paths,
      ...(only ? { only } : {}),
      schema: args.schema !== false,
      impact: Boolean(args.impact),
      ...(args.base !== undefined ? { base: args.base } : {}),
      ...(args.expect ? { expect: args.expect as ImpactLevel } : {}),
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.labels !== undefined
        ? {
            labels: args.labels
              .split(',')
              .map((l) => l.trim())
              .filter(Boolean),
          }
        : {}),
      ...(process.env.FLOWPACT_NOW ? { now: new Date(process.env.FLOWPACT_NOW) } : {}),
    },
    {
      // `flowpact impact` has nothing to report when impact mode is skipped; `lint --impact` lints without it.
      impactSkipped: (reason) => {
        ctx.stderr(`impact: skipped (${reason})`);
        return command === 'impact';
      },
      analyzed: (notes) => {
        for (const note of notes) ctx.stderr(note);
      },
    },
  );
  if (!analysis) return 0;
  const includeGraph = Boolean(args['include-graph']);
  const pathPrefix = workspacePrefix(ctx.root);
  const render = (format: Format, toFile: boolean): string => {
    switch (format) {
      case 'json':
        return analysis.json({ includeGraph });
      case 'sarif':
        return analysis.sarif({ pathPrefix });
      case 'github':
        return analysis.github({ pathPrefix });
      case 'markdown':
        return analysis.markdown({ ...markdownOptionsFromEnv(pathPrefix), includeGraph });
      default:
        return toFile
          ? analysis.pretty({ ...ctx.plain, hideInfo: false })
          : analysis.pretty({ ...ctx.render, hideInfo: Boolean(args['hide-info']) });
    }
  };
  if (args.format === 'github') writeWorkflowCommands(render('github', false));
  else ctx.stdout(render(args.format as Format, false));
  for (const { format, file } of files)
    writeOutput(file, render(format, true), ctx, format === 'json' || format === 'sarif' ? 'data' : 'text');
  if (args['dump-graph']) {
    // The data-flow graph, as the JSON report includes it.
    const { graph } = JSON.parse(analysis.json({ includeGraph: true }));
    writeOutput(args['dump-graph'], jsonSafe(`${JSON.stringify(graph, null, 2)}\n`), ctx, 'data');
  }
  const patch = args.patch ? analysis.contracts?.patch() : undefined;
  if (args.patch && patch !== undefined) writeOutput(args.patch, patch, ctx, 'data');
  return analysis.exitCode(args['fail-on'] as FailOn);
}

export const lintCommand = defineCommand({
  meta: {
    name: 'lint',
    description: 'Analyze workflows and local actions: inputs, secrets, outputs, matrices and call structure',
  },
  args: reportArgs,
  run: ({ args, rawArgs, cmd }) =>
    guard(() => runReport(args as unknown as ReportArgs, rawArgs, 'lint', cmd.args as ArgsDef)),
});
