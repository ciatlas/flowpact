import { formatLoc, type Loc, type SourceFile } from '@flowpact/core';
import {
  type AnalysisResult,
  CATEGORIES,
  type Finding,
  type ImpactResult,
  type RuleDefinition,
  type RuleRegistry,
  type Severity,
  type ToolMeta,
} from '@flowpact/lint';
import { describeDeclared, listedChanges, shortCommit } from './impact';
import {
  box,
  createTheme,
  finalize,
  padEnd,
  type RenderOptions,
  safe,
  type Theme,
  visibleWidth,
  wrap,
} from './theme';

const LABEL_WIDTH = 8;

export function renderBanner(meta: ToolMeta, opts: RenderOptions, extra?: string): string {
  const t = createTheme(opts);
  const { c } = t;
  const s = meta.schemas;
  const head = `${c.bgCyan(c.black(c.bold(` ${meta.tool} `)))} ${c.bold(`v${meta.version}`)}`;
  const schemas = c.dim(
    `config schema v${s.config} ${t.sym.dot} contract schema v${s.contract} ${t.sym.dot} report schema v${s.report} ${t.sym.dot} node ${meta.node}`,
  );
  return finalize([`${head}  ${schemas}`, ...(extra ? [c.dim(safe(extra))] : [])].join('\n'), opts);
}

function sourceMap(result: AnalysisResult): Map<string, SourceFile> {
  const m = new Map<string, SourceFile>();
  for (const u of [...result.project.workflows.values(), ...result.project.actions.values()])
    m.set(u.file, u.source);
  if (result.configSource) m.set(result.configSource.path, result.configSource);
  return m;
}

/** A code frame with line numbers and a caret underline under `loc`. */
export function codeFrame(
  t: Theme,
  source: SourceFile,
  loc: Loc,
  opts: { context?: number; label?: string } = {},
): string[] {
  const { c, sym } = t;
  const context = opts.context ?? 2;
  const first = Math.max(1, loc.line - context);
  let last = Math.min(source.lines.length, loc.line + Math.min(1, context));
  while (last > loc.line && (source.lines[last - 1] ?? '').trim() === '') last--;
  const gutter = String(last).length;
  const out: string[] = [];
  for (let n = first; n <= last; n++) {
    const raw = source.lines[n - 1] ?? '';
    const visual = (x: string) => safe(x.replace(/\t/g, '  '));
    const text = visual(raw);
    const isTarget = n === loc.line;
    const num = String(n).padStart(gutter);
    out.push(`${isTarget ? c.bold(num) : c.dim(num)} ${c.dim(sym.bar)} ${isTarget ? text : c.dim(text)}`);
    if (isTarget) {
      // Columns count characters; tabs and wide characters take more cells on screen.
      const startCol = Math.max(1, loc.column);
      const endCol = loc.endLine === loc.line ? Math.max(startCol + 1, loc.endColumn) : raw.length + 1;
      const pad = visibleWidth(visual(raw.slice(0, startCol - 1)));
      const width = Math.max(1, visibleWidth(visual(raw.slice(startCol - 1, endCol - 1))));
      out.push(
        `${' '.repeat(gutter)} ${c.dim(sym.bar)} ${' '.repeat(pad)}${c.red(c.bold(sym.caret.repeat(width)))}${opts.label ? ` ${c.red(opts.label)}` : ''}`,
      );
    }
  }
  return out;
}

function severityTag(t: Theme, s: Severity): string {
  const label = { error: 'ERROR', warning: 'WARN', info: 'INFO' }[s];
  return `${t.severity[s](t.sym[s])} ${t.badge[s](` ${label} `)}`;
}

function labeled(
  t: Theme,
  label: string,
  text: string,
  width: number,
  color?: (s: string) => string,
): string[] {
  const lines = wrap(text, Math.max(30, width - LABEL_WIDTH - 6));
  return lines.map(
    (l, i) =>
      `${i === 0 ? t.c.dim(label.padEnd(LABEL_WIDTH)) : ' '.repeat(LABEL_WIDTH)}${color ? color(l) : l}`,
  );
}

export function renderFinding(t: Theme, f: Finding, sources: Map<string, SourceFile>): string {
  const { c, sym, opts } = t;
  const width = opts.width;
  const lines: string[] = [];
  lines.push(`${severityTag(t, f.severity)} ${c.bold(f.code)} ${c.dim(f.name)}`);
  for (const l of wrap(f.message, width - 4)) lines.push(`  ${c.bold(l)}`);
  lines.push('');
  lines.push(`  ${c.cyan(sym.pointer)} ${c.cyan(formatLoc(f.loc))}`);
  const src = sources.get(f.loc.file);
  if (src) for (const l of codeFrame(t, src, f.loc)) lines.push(`    ${l}`);
  lines.push('');
  const body: string[] = [];
  if (f.combos?.length) {
    const shown = f.combos.slice(0, 5);
    body.push(
      ...labeled(
        t,
        'matrix',
        shown.join('\n') + (f.combos.length > 5 ? `\n… +${f.combos.length - 5} more` : ''),
        width,
        c.magenta,
      ),
    );
  }
  if (f.related.length) {
    const locW = Math.min(48, Math.max(...f.related.map((r) => visibleWidth(formatLoc(r.loc)))));
    f.related.forEach((r, i) => {
      const branch = i === f.related.length - 1 ? sym.elbow : sym.tee;
      const text = `${c.dim(branch)} ${c.cyan(padEnd(formatLoc(r.loc), locW))}  ${r.message}`;
      body.push(`${i === 0 ? c.dim('context'.padEnd(LABEL_WIDTH)) : ' '.repeat(LABEL_WIDTH)}${text}`);
    });
  }
  body.push(...labeled(t, 'why', f.why, width));
  body.push(...labeled(t, 'fix', f.fix, width, c.green));
  body.push(`${c.dim('docs'.padEnd(LABEL_WIDTH))}${t.link(c.underline(c.blue(f.docsUrl)), f.docsUrl)}`);
  for (const l of body) lines.push(`  ${l}`);
  return lines.join('\n');
}

export interface PrettyOptions extends RenderOptions {
  /** Hide info-level findings from the detailed list (still counted in the summary). */
  hideInfo?: boolean;
}

export function renderPretty(result: AnalysisResult, opts: PrettyOptions): string {
  const t = createTheme(opts);
  const { c, sym } = t;
  const sources = sourceMap(result);
  const out: string[] = [];
  const shown = result.findings.filter((f) => !(opts.hideInfo && f.severity === 'info'));

  const byFile = new Map<string, Finding[]>();
  for (const f of shown) byFile.set(f.loc.file, [...(byFile.get(f.loc.file) ?? []), f]);

  for (const [file, findings] of byFile) {
    const counts = countBySeverity(findings);
    const right = [
      counts.error ? t.severity.error(`${counts.error} error${counts.error > 1 ? 's' : ''}`) : '',
      counts.warning ? t.severity.warning(`${counts.warning} warning${counts.warning > 1 ? 's' : ''}`) : '',
      counts.info ? t.severity.info(`${counts.info} info`) : '',
    ]
      .filter(Boolean)
      .join(c.dim(', '));
    const head = `${c.dim(sym.h.repeat(2))} ${c.bold(c.underline(file))} `;
    const fill = Math.max(2, opts.width - visibleWidth(head) - visibleWidth(right) - 2);
    out.push('');
    out.push(`${head}${c.dim(sym.h.repeat(fill))} ${right}`);
    for (const f of findings) {
      out.push('');
      out.push(renderFinding(t, f, sources));
    }
  }
  if (result.impact) {
    out.push('');
    out.push(renderImpact(t, result.impact));
  }
  out.push('');
  out.push(renderSummary(result, opts, shown.length !== result.findings.length));
  return finalize(out.join('\n'), opts);
}

/** The impact verdict: declared vs required, the changes behind it, and the baseline. */
export function renderImpact(t: Theme, impact: ImpactResult): string {
  const { c, sym } = t;
  const v = impact.verdict;
  const levelText = (l: string) =>
    l === 'major' ? c.red(c.bold(l.toUpperCase())) : l === 'minor' ? c.yellow(c.bold(l)) : c.bold(l);
  const mark = v.ok ? c.green(sym.ok) : c.red(sym.error);
  const lines = [
    `${c.bold('Impact')}  declared ${c.bold(safe(describeDeclared(impact)))}  ${c.dim(sym.dot)}  required ${levelText(v.required)}  ${mark}`,
  ];
  for (const ch of listedChanges(impact).slice(0, 30)) {
    const tag = (ch.level === 'major' ? c.red : ch.level === 'minor' ? c.yellow : c.dim)(ch.level.padEnd(5));
    lines.push(
      `  ${tag}  ${c.dim(safe(ch.unit))}  ${safe(ch.message)}${ch.certain ? '' : c.dim(' (uncertain)')}`,
    );
  }
  const more = listedChanges(impact).length - 30;
  if (more > 0) lines.push(c.dim(`  … ${more} more (see --format json)`));
  if (listedChanges(impact).length === 0) lines.push(c.dim('  no changes to published workflows or actions'));
  lines.push(
    c.dim(
      `  baseline: ${impact.baseline.kind === 'release' ? 'last release ' : ''}${safe(impact.baseline.ref)} (${shortCommit(impact.baseline.commit)})`,
    ),
  );
  return lines.join('\n');
}

function countBySeverity(findings: Finding[]) {
  return {
    error: findings.filter((f) => f.severity === 'error').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

export function renderSummary(result: AnalysisResult, opts: RenderOptions, infoHidden = false): string {
  const t = createTheme(opts);
  const { c, sym } = t;
  const s = result.summary;
  const lines: string[] = [];
  if (s.total === 0) {
    lines.push(`${c.green(sym.ok)} ${c.green(c.bold('No problems found'))}`);
  } else {
    lines.push(
      [
        t.severity.error(`${sym.error} ${s.errors} error${s.errors === 1 ? '' : 's'}`),
        t.severity.warning(`${sym.warning} ${s.warnings} warning${s.warnings === 1 ? '' : 's'}`),
        t.severity.info(`${sym.info} ${s.infos} info${infoHidden ? ' (hidden)' : ''}`),
      ].join('   '),
    );
  }
  lines.push(
    c.dim(
      `${s.workflows} workflow${s.workflows === 1 ? '' : 's'} ${sym.dot} ${s.actions} action${s.actions === 1 ? '' : 's'} ${sym.dot} ${s.jobs} jobs ${sym.dot} ${s.matrixCombinations} matrix combinations`,
    ),
  );
  lines.push(
    c.dim(`graph: ${s.graph.nodes} symbols, ${s.graph.edges} edges ${sym.dot} ${result.durationMs} ms`),
  );
  if (s.suppressed) {
    lines.push(
      c.dim(
        `${s.suppressed} finding${s.suppressed === 1 ? '' : 's'} accepted by overrides (listed under "suppressed" in --format json)`,
      ),
    );
  }
  if (s.skippedInGenerated) {
    lines.push(
      c.dim(
        `${s.skippedInGenerated} finding${s.skippedInGenerated === 1 ? '' : 's'} not reported in generated files (-v lists the files)`,
      ),
    );
  }
  if (result.contracts) {
    const k = result.contracts.counts;
    lines.push(
      result.contracts.drift
        ? `${c.yellow('contracts:')} ${k.update} outdated, ${k.create} missing, ${k.delete} orphaned${result.contracts.breaking ? c.red(` ${sym.dot} ${result.contracts.breaking} breaking`) : ''} ${c.dim(`${sym.arrow} flowpact generate`)}`
        : c.green(`contracts: ${k.unchanged} up to date`),
    );
  }
  const codes = Object.entries(s.byCode).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (codes.length) {
    lines.push('');
    // A rule can report some findings below its severity (FP503: keys GitHub ignores); show the most severe.
    const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
    const nameOf = new Map<string, { name: string; severity: Severity }>();
    for (const f of result.findings) {
      const seen = nameOf.get(f.code);
      if (!seen || rank[f.severity] < rank[seen.severity])
        nameOf.set(f.code, { name: f.name, severity: f.severity });
    }
    const nameW = Math.max(...codes.map(([code]) => visibleWidth(nameOf.get(code)?.name ?? '')));
    for (const [code, n] of codes.slice(0, 10)) {
      const info = nameOf.get(code)!;
      lines.push(
        `${t.severity[info.severity](sym[info.severity])} ${c.bold(code)}  ${padEnd(info.name, nameW)}  ${c.bold(String(n).padStart(3))}`,
      );
    }
    if (codes.length > 10) lines.push(c.dim(`… ${codes.length - 10} more codes`));
    lines.push('');
    lines.push(c.dim(`Explain any code: flowpact explain <code>`));
  }
  return box(t, 'Summary', lines, opts.width);
}

export function renderRuleList(
  registry: RuleRegistry,
  severities: Map<string, string> | undefined,
  opts: RenderOptions,
): string {
  return renderRules(
    registry.all().map((r) => ({
      code: r.code,
      name: r.name,
      category: r.category,
      severity: severities?.get(r.code) ?? r.defaultSeverity,
      summary: r.docs.summary,
    })),
    opts,
  );
}

/** A rule as `flowpact rules` lists it, with its effective severity. */
export interface RuleRow {
  code: string;
  name: string;
  category: string;
  severity: string;
  summary: string;
}

/** The `flowpact rules` table, grouped by category; `rules` sorted by code. */
export function renderRules(rules: RuleRow[], opts: RenderOptions): string {
  const t = createTheme(opts);
  const { c } = t;
  const out: string[] = [];
  const nameW = Math.max(...rules.map((r) => r.name.length));
  let lastCat = '';
  for (const r of rules) {
    const cat = Object.values(CATEGORIES).find((x) => x.id === r.category)!;
    if (cat.id !== lastCat) {
      out.push('');
      out.push(c.bold(c.underline(cat.title)));
      lastCat = cat.id;
    }
    const sev = r.severity;
    const sevText = sev === 'off' ? c.dim('off    ') : t.severity[sev as Severity](sev.padEnd(7));
    const room = opts.width - nameW - 22;
    const summary = r.summary.length > room ? `${r.summary.slice(0, Math.max(10, room - 1))}…` : r.summary;
    out.push(`  ${c.bold(r.code)}  ${sevText}  ${padEnd(r.name, nameW)}  ${c.dim(summary)}`);
  }
  out.push('');
  out.push(c.dim(`${rules.length} rules. Run \`flowpact explain <code>\` for details.`));
  return finalize(out.join('\n'), opts);
}

/** What `flowpact explain` shows of a rule. */
export type ExplainedRule = Pick<
  RuleDefinition,
  'code' | 'name' | 'category' | 'defaultSeverity' | 'docs' | 'generatedFiles'
>;

export function renderExplain(
  rule: ExplainedRule,
  docsUrl: string,
  severity: string,
  opts: RenderOptions,
): string {
  const t = createTheme(opts);
  const { c } = t;
  const w = opts.width;
  const out: string[] = [];
  out.push(
    `${c.bold(rule.code)} ${c.dim(rule.name)}  ${c.dim(`[${rule.category} ${t.sym.dot} default: ${rule.defaultSeverity}${severity !== rule.defaultSeverity ? ` ${t.sym.dot} configured: ${severity}` : ''}]`)}`,
  );
  out.push('');
  for (const l of wrap(rule.docs.summary, w)) out.push(c.bold(l));
  out.push('');
  out.push(...labeled(t, 'why', rule.docs.why, w));
  out.push('');
  out.push(...labeled(t, 'fix', rule.docs.fix, w, c.green));
  const scope = [
    rule.docs.scope,
    rule.generatedFiles === 'skip' ? 'Not reported in generated files, which are not edited by hand.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (scope) {
    out.push('');
    out.push(...labeled(t, 'scope', scope, w));
  }
  if (rule.docs.examples) {
    out.push('');
    out.push(c.red(c.bold('✗ problem')));
    for (const l of rule.docs.examples.bad.split('\n')) out.push(`  ${c.dim(t.sym.bar)} ${l}`);
    out.push(c.green(c.bold('✓ fixed')));
    for (const l of rule.docs.examples.good.split('\n')) out.push(`  ${c.dim(t.sym.bar)} ${l}`);
  }
  out.push('');
  out.push(`${c.dim('docs'.padEnd(LABEL_WIDTH))}${t.link(c.underline(c.blue(docsUrl)), docsUrl)}`);
  return finalize(out.join('\n'), opts);
}
