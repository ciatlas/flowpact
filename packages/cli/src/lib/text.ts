/**
 * The text the commands print, for both the CLI and the API's format functions, so the two are the same by
 * construction. Every text is safe to print in a CI log: no line of it can be read as a GitHub workflow command (it
 * embeds names from the analyzed YAML), which is what the CLI's stdout also guarantees.
 */
import { neutralizeWorkflowCommands } from '@ciatlas/core';
import {
  type CallGraph,
  finalize,
  type RenderOptions,
  renderContractPlan,
  renderDot,
  renderExplain,
  renderGraphTree,
  renderMermaid,
  renderPatch,
  renderRules,
  renderTrace,
} from '@flowpact/reporters';
import pc from 'picocolors';
import { usage } from './errors';
import type { ContractGeneration } from './generate';
import type { RuleDocs, RuleInfo, TraceResult } from './inspect';
import type { RemotesUpdateResult } from './remotes';
import { oneOf } from './session';

/** How text is rendered: what `--no-color`, `--ascii` and the terminal decide in the CLI. */
export interface TextOptions {
  /** ANSI colors. Default: false. */
  color?: boolean;
  /** Columns to wrap at. Default: 100. */
  width?: number;
  /** ASCII instead of box-drawing characters and symbols. */
  ascii?: boolean;
  /** OSC 8 hyperlinks for docs links, for terminals that support them. */
  hyperlinks?: boolean;
}

/** The render options for API options, which are checked: the CLI's come from its flags and the terminal. */
export function renderOptions(o: TextOptions = {}): RenderOptions {
  if (o.width !== undefined && !(Number.isInteger(o.width) && o.width > 0))
    throw usage(`width must be a positive integer (got ${JSON.stringify(o.width)})`);
  return {
    color: Boolean(o.color),
    width: o.width ?? 100,
    hyperlinks: Boolean(o.hyperlinks),
    ascii: Boolean(o.ascii),
  };
}

/** One color decision for all CLI output: --no-color, NO_COLOR, FORCE_COLOR (0/false = off), then TTY detection. */
export function colorEnabled(
  flagColor: boolean | undefined = true,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  const forceOff = env.FORCE_COLOR === '0' || env.FORCE_COLOR === 'false';
  const forceOn = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && !forceOff;
  return flagColor !== false && !noColor && !forceOff && (forceOn || pc.isColorSupported);
}

/**
 * How the CLI renders for its standard output (the API's `terminalOptions()`): color as `colorEnabled` decides, the
 * terminal's width (40 to 140 columns; 100 when unknown), and hyperlinks in a color terminal unless
 * FLOWPACT_NO_HYPERLINKS is set.
 */
export function terminalRender(
  flags: { color?: boolean | undefined; ascii?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): RenderOptions {
  const color = colorEnabled(flags.color, env);
  const isTTY = Boolean(process.stdout.isTTY);
  const columns = process.stdout.columns ?? Number(env.COLUMNS ?? 100);
  return {
    color,
    // Whole columns: COLUMNS set by hand can be anything (80.5), and the width must be an integer.
    width: Math.max(40, Math.min(140, Math.floor(columns) || 100)),
    hyperlinks: color && isTTY && env.FLOWPACT_NO_HYPERLINKS === undefined,
    ascii: Boolean(flags.ascii),
  };
}

const safe = neutralizeWorkflowCommands;

const GRAPH_FORMATS = ['tree', 'mermaid', 'dot'] as const;
export type GraphFormat = (typeof GRAPH_FORMATS)[number];

/** `flowpact graph`: a tree for the terminal, a Mermaid flowchart (without code fences) or Graphviz DOT. */
export function graphText(graph: CallGraph, format: GraphFormat | undefined, opts: RenderOptions): string {
  switch (oneOf('format', format, GRAPH_FORMATS) ?? 'tree') {
    case 'mermaid':
      return safe(renderMermaid(graph));
    case 'dot':
      return safe(renderDot(graph, { name: 'flowpact' }));
    default:
      return safe(renderGraphTree(graph, opts));
  }
}

/** `flowpact trace`: one tree per matching symbol, or why there is nothing to trace. */
export function traceText(result: TraceResult, opts: RenderOptions): string {
  if (result.traces.length === 0)
    return safe(
      finalize(
        `${result.unit ?? result.query} declares no inputs, secrets or outputs — nothing to trace.`,
        opts,
      ),
    );
  return safe(result.traces.map((t) => renderTrace(t, result.direction, opts)).join('\n\n'));
}

/** `flowpact rules`: every rule by category, with its effective severity. */
export function rulesText(rules: RuleInfo[], opts: RenderOptions): string {
  return safe(renderRules(rules, opts));
}

/** `flowpact explain`: a rule's documentation. */
export function explainText(rule: RuleDocs, opts: RenderOptions): string {
  const { summary, why, fix, scope, examples } = rule;
  return safe(
    renderExplain(
      {
        code: rule.code,
        name: rule.name,
        category: rule.category,
        defaultSeverity: rule.defaultSeverity,
        generatedFiles: rule.generatedFiles,
        docs: {
          summary,
          why,
          fix,
          ...(scope !== undefined ? { scope } : {}),
          ...(examples ? { examples } : {}),
        },
      },
      rule.docsUrl,
      rule.severity,
      opts,
    ),
  );
}

/**
 * `flowpact generate`: each contract file with its changes, and what was written, or after a dry run what would be.
 * `diff` adds the changes as a diff, as `--dry-run` prints them.
 */
export function generationText(generation: ContractGeneration, opts: RenderOptions, diff = false): string {
  const plan = renderContractPlan(generation, opts, { applied: !generation.dryRun });
  const patch = diff ? generation.patch() : undefined;
  if (patch === undefined) return safe(plan);
  return safe(`${plan.endsWith('\n') ? plan : `${plan}\n`}${renderPatch(patch, opts)}`);
}

/** `remotes update`: what the lockfile gained, lost or changed, and what could not be fetched. */
export function remotesText(r: RemotesUpdateResult, opts: RenderOptions): string {
  const c = opts.color ? pc : { bold: (s: string) => s, red: (s: string) => s, dim: (s: string) => s };
  const lines: string[] = [];
  const list = (label: string, refs: string[]) => {
    for (const ref of refs) lines.push(`  ${label} ${ref}`);
  };
  list('new    ', r.added);
  list('changed', r.changed);
  list('removed', r.removed);
  for (const f of r.failed) lines.push(`  ${c.red('failed ')} ${f.ref}: ${f.error}`);
  const verb = r.dryRun ? 'would write' : 'wrote';
  const head = r.changes ? `${verb} ${r.file}` : `${r.file} is up to date`;
  lines.unshift(c.bold(head));
  if (r.failed.length && !r.authenticated)
    lines.push(
      c.dim(
        '  No token was used: set GH_TOKEN or GITHUB_TOKEN (or sign in with `gh auth login`) to read private repositories.',
      ),
    );
  return safe(`${lines.join('\n')}\n`);
}
