/**
 * The text the commands print, for both the CLI and the API's format functions, so the two are the same by
 * construction. Every text is safe to print in a CI log: no line of it can be read as a GitHub workflow command (it
 * embeds names from the analyzed YAML), which is what the CLI's stdout also guarantees.
 */
import { escapeControl, neutralizeWorkflowCommands } from '@ciatlas/core';
import type { RemoteCallGrade, RemoteChangeGrade } from '@flowpact/lint';
import {
  type CallGraph,
  callJobStep,
  commitMove,
  finalize,
  listedCalls,
  type RenderOptions,
  renderContractPlan,
  renderDot,
  renderExplain,
  renderGraphTree,
  renderMermaid,
  renderPatch,
  renderRules,
  renderTrace,
  VERDICT_LABEL,
  verdictLine,
} from '@flowpact/reporters';
import pc from 'picocolors';
import { usage } from './errors';
import type { ContractGeneration } from './generate';
import type { RuleDocs, RuleInfo, TraceResult } from './inspect';
import {
  describeToken,
  type RemotesCleanResult,
  type RemotesDownloadResult,
  type RemotesUpdateResult,
  type SourcesKept,
} from './remotes';
import type { VersionChanges } from './report';
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

/**
 * A reference, or a reason built from the lockfile, as printed: a pull request writes both, so control characters
 * (an escape sequence that would rewrite the terminal) are shown, not sent.
 */
const shown = (s: string) => escapeControl(s);

/**
 * `remotes update`: what the lockfile gained, lost or changed (with what each change does to the repository's calls),
 * and what could not be fetched.
 */
export function remotesText(r: RemotesUpdateResult, opts: RenderOptions): string {
  const c = opts.color ? pc : { bold: (s: string) => s, red: (s: string) => s, dim: (s: string) => s };
  const lines = [...entryLines(r, c, opts.ascii ? '->' : '→'), ...problemLines(r, c)];
  return safe(`${[...updateHead(r, c), ...lines].join('\n')}\n`);
}

/** The entries `remotes update` added, changed (each with its grade) and removed. */
function entryLines(r: RemotesUpdateResult, c: Paint, arrow: string): string[] {
  const list = (label: string, refs: string[]) => refs.map((ref) => `  ${label} ${shown(ref)}`);
  const graded = new Map(r.grades.map((g) => [g.ref, g]));
  const changed = r.changed.flatMap((ref) => {
    const g = graded.get(ref);
    return g ? gradeLines(g, c, arrow) : [`  changed ${shown(ref)}`];
  });
  return [...list('new    ', r.added), ...changed, ...list('removed', r.removed)];
}

/** The references `remotes update` could not read or fetch, with why, and what to do without a token. */
function problemLines(r: RemotesUpdateResult, c: Paint): string[] {
  return [
    ...r.unreadable.map((u) => `  ${c.dim('unread ')} ${shown(u.ref)}: ${shown(u.error)}`),
    ...r.failed.map((f) => `  ${c.red('failed ')} ${shown(f.ref)}: ${shown(f.error)}`),
    ...((r.failed.length || r.unreadable.length) && !r.tokenSource ? [c.dim(NO_TOKEN)] : []),
  ];
}

type Paint = { red: (s: string) => string; dim: (s: string) => string };

/** A call: its verdict and where it is, then why (the findings, the parts not checked) and the notes. */
function callLines(g: RemoteCallGrade, c: Paint): string[] {
  const label = g.verdict === 'breaks' ? c.red(VERDICT_LABEL.breaks) : VERDICT_LABEL[g.verdict];
  return [
    `    ${label} ${shown(`${g.call.loc.file}:${g.call.loc.line} ${callJobStep(g.call)}`)}`,
    ...g.added.map((f) => `      ${f.code} ${shown(f.message)}`),
    ...g.unchecked.map((u) => `      ${shown(u)}`),
    ...g.notes.map((n) => c.dim(`      note: ${shown(n)}`)),
  ];
}

/**
 * A changed entry (`head`): its commits and verdict, the interface diff (what breaks in red), then each call that does
 * not simply fit, and how many others do.
 */
function gradeLines(
  g: RemoteChangeGrade,
  c: Paint,
  arrow: string,
  head = `changed ${shown(g.ref)}`,
): string[] {
  const { listed, others } = listedCalls(g);
  return [
    `  ${head}: ${commitMove(g, arrow)}, ${verdictLine(g)}`,
    ...g.changes.map((ch) => `    ${(ch.breaking ? c.red : c.dim)(shown(ch.message))}`),
    ...listed.flatMap((k) => callLines(k, c)),
    ...(others ? [c.dim(`    ${others}`)] : []),
  ];
}

/**
 * `lint` and `check` with `--fetch-remotes`: the remote references the change moves to another version, each graded as
 * `remotes update` prints a changed entry, then those that could not be fetched. Empty when nothing was graded or failed.
 */
export function versionChangesText(v: VersionChanges | undefined, opts: RenderOptions): string {
  if (!v || (!v.grades.length && !v.failed.length)) return '';
  const c = opts.color ? pc : { bold: (s: string) => s, red: (s: string) => s, dim: (s: string) => s };
  const from = new Map(v.changes.map((ch) => [ch.ref, ch.from]));
  const head = (ref: string) => `${shown(ref)} (from ${shown(from.get(ref) ?? '?')})`;
  const broken = v.grades.reduce((n, g) => n + g.calls.filter((k) => k.verdict === 'breaks').length, 0);
  const verdict = broken ? `: ${c.red(`${broken} call${broken === 1 ? '' : 's'} broken`)}` : '';
  const lines = [
    `${c.bold(`version changes from ${v.base.slice(0, 7)}`)}${verdict}`,
    ...v.grades.flatMap((g) => gradeLines(g, c, opts.ascii ? '->' : '→', head(g.ref))),
    ...v.failed.map((f) => `  ${c.red('not graded')} ${shown(f.ref)}: ${shown(f.error)}`),
  ];
  return safe(`${lines.join('\n')}\n`);
}

/** What `remotes update` wrote (or would), the token it used, and where it kept the files it read. */
function updateHead(r: RemotesUpdateResult, c: { bold: (s: string) => string; dim: (s: string) => string }) {
  const verb = r.dryRun ? 'would write' : 'wrote';
  return [
    c.bold(r.changes ? `${verb} ${r.file}` : `${r.file} is up to date`),
    c.dim(`token: ${describeToken(r.tokenSource)}`),
    ...(r.sources ? [c.dim(sourcesLine(r.sources))] : []),
    ...(r.sourcesNotKept ? [c.dim(`sources: ${r.sourcesNotKept}`)] : []),
    ...(r.actionsLock ? [c.dim(actionsLockLine(r.actionsLock))] : []),
  ];
}

/** Whether `remotes update` read references at the commits GitHub's `actions.lock` pins, and how many; or why not. */
function actionsLockLine(a: NonNullable<RemotesUpdateResult['actionsLock']>): string {
  if (a.error) return `${a.file}: not used, ${shown(a.error)}`;
  const n = `${a.pinned} reference${a.pinned === 1 ? '' : 's'}`;
  return `${a.file}: ${n} read at the commit${a.pinned === 1 ? '' : 's'} it pins`;
}

const NO_TOKEN =
  '  No token was used: set GH_TOKEN or GITHUB_TOKEN, or sign in with `gh auth login`. It needs read access to the contents of the private repositories.';

/** Where `remotes update` kept the files it read, for the editor, and how many it could not keep, and why. */
function sourcesLine(s: SourcesKept): string {
  const counts = [
    s.written || s.failed ? `${s.written} new` : undefined,
    s.removed ? `${commits(s.removed)} removed` : undefined,
    s.failed ? `${s.notKept} not kept: ${s.failed}` : undefined,
  ].filter(Boolean);
  return `sources: ${s.dir}${counts.length ? ` (${counts.join(', ')})` : ''}`;
}

const commits = (k: number) => `${k} old commit${k === 1 ? '' : 's'}`;

const sources = (k: number) => `${k} source${k === 1 ? '' : 's'}`;

/** What `remotes download` did, in a line: downloaded (of how many tried), or nothing to do. */
function downloadHead(r: RemotesDownloadResult): string {
  const tried = r.downloaded.length + r.failed.length;
  if (r.failed.length) return `downloaded ${r.downloaded.length} of ${sources(tried)} to ${r.dir}`;
  return r.downloaded.length
    ? `downloaded ${sources(r.downloaded.length)} to ${r.dir}`
    : `nothing to download to ${r.dir}`;
}

/** `remotes download`: what the cache now has, then each reference not downloaded, and why. */
export function remotesDownloadText(r: RemotesDownloadResult, opts: RenderOptions): string {
  const c = opts.color ? pc : { bold: (s: string) => s, red: (s: string) => s, dim: (s: string) => s };
  const lines = [c.bold(downloadHead(r)), c.dim(`token: ${describeToken(r.tokenSource)}`)];
  if (r.cached.length) lines.push(c.dim(`  ${sources(r.cached.length)} already there`));
  if (r.removed) lines.push(c.dim(`  ${commits(r.removed)} removed`));
  for (const ref of r.notLocked)
    lines.push(`  ${c.dim('unlocked')} ${shown(ref)}: not in ${r.file}; \`flowpact remotes update\` adds it`);
  for (const s of r.skipped) lines.push(`  ${c.dim('skipped ')} ${shown(s.ref)}: ${shown(s.reason)}`);
  for (const f of r.failed) lines.push(`  ${c.red('failed  ')} ${shown(f.ref)}: ${shown(f.error)}`);
  // A failure to write the cache is local: no token would help.
  if (r.failed.some((f) => !f.cache) && !r.tokenSource) lines.push(c.dim(NO_TOKEN));
  return safe(`${lines.join('\n')}\n`);
}

/** `remotes clean`: how many cached commits went, and what was kept. */
export function remotesCleanText(r: RemotesCleanResult, opts: RenderOptions): string {
  const c = opts.color ? pc : { bold: (s: string) => s, dim: (s: string) => s };
  const n = `${r.removed} cached commit${r.removed === 1 ? '' : 's'}`;
  const lines = [c.bold(r.removed ? `removed ${n} from ${r.dir}` : `nothing to remove in ${r.dir}`)];
  if (r.keep) lines.push(c.dim(`kept the ${r.keep} most recently used of each repository`));
  if (r.failed) lines.push(c.dim(`some could not be removed: ${r.failed}`));
  return safe(`${lines.join('\n')}\n`);
}
