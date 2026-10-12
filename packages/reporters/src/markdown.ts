import {
  type AnalysisResult,
  type ContractPlan,
  DOCS_BASE_URL,
  type Finding,
  type ImpactResult,
  type Severity,
} from '@flowpact/lint';
import { describeDeclared, listedChanges, shortCommit } from './impact';
import {
  buildCallGraph,
  markdownCell as cell,
  markdownCode as code,
  markdownLocation as locLink,
  markdownFence,
  renderMermaid,
  markdownTableCell as tableCell,
  markdownText as text,
} from './kit';

export interface MarkdownOptions {
  /** Heading of the report. Default: `flowpact report`. */
  title?: string;
  /**
   * Findings listed in full before the rest is summarized as "… N more". Default: 50. The same limit applies to
   * suppressed findings and to changed contract files, so the report stays within GitHub's 1 MiB summary limit.
   */
  maxFindings?: number;
  /** e.g. `https://github.com/acme/repo`. With `sha`, locations link to the file at that commit. */
  repoUrl?: string;
  sha?: string;
  /** Add the call graph as a Mermaid diagram in a collapsed section. */
  includeGraph?: boolean;
  /** The workflow artifact holding the regenerated contracts, for download instructions on drift. */
  artifact?: { name: string; runId?: string; patchFile?: string };
}

const SEVERITY: Record<Severity, { icon: string; title: string; noun: (n: number) => string }> = {
  error: { icon: '❌', title: 'Errors', noun: (n) => `error${n === 1 ? '' : 's'}` },
  warning: { icon: '⚠️', title: 'Warnings', noun: (n) => `warning${n === 1 ? '' : 's'}` },
  info: { icon: 'ℹ️', title: 'Info', noun: () => 'info' },
};

const STATUS_LABEL = { create: 'new', update: 'changed', delete: 'removed', unchanged: 'unchanged' } as const;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function statusLine(result: AnalysisResult): string {
  const s = result.summary;
  if (s.total === 0) return '✅ **No problems found**';
  const parts = [
    s.errors ? `${s.errors} ${SEVERITY.error.noun(s.errors)}` : '',
    s.warnings ? `${s.warnings} ${SEVERITY.warning.noun(s.warnings)}` : '',
    s.infos ? `${s.infos} info` : '',
  ].filter(Boolean);
  const icon = s.errors ? SEVERITY.error.icon : s.warnings ? SEVERITY.warning.icon : SEVERITY.info.icon;
  return `${icon} **${parts[0]}**${parts.length > 1 ? ` · ${parts.slice(1).join(' · ')}` : ''}`;
}

/** `**Label:** text`; lines after the first (suggested YAML) go into a code block. */
function labeled(label: string, value: string): string[] {
  const [first = '', ...rest] = value.split('\n');
  const out = [`**${label}:** ${text(first)}`];
  if (!rest.length) return out;
  // The fence is longer than any backtick run in the snippet, so nothing in it can close the block early.
  const fence = markdownFence(rest.join('\n'));
  out.push('', `${fence}yaml`, ...rest, fence);
  return out;
}

function renderFinding(f: Finding, opts: MarkdownOptions): string[] {
  const out: string[] = [];
  out.push(`**[${code(f.code)}](${f.docsUrl}) ${f.name}** · ${locLink(f.loc, opts)}`);
  out.push('');
  out.push(text(f.message));
  if (f.combos?.length) {
    const shown = f.combos.slice(0, 10).map(code).join(' · ');
    out.push('');
    out.push(`Matrix: ${shown}${f.combos.length > 10 ? ` · … ${f.combos.length - 10} more` : ''}`);
  }
  out.push('');
  out.push('<details><summary>Why / fix</summary>');
  out.push('');
  out.push(...labeled('Why', f.why));
  out.push('');
  out.push(...labeled('Fix', f.fix));
  if (f.related.length) {
    out.push('');
    out.push('**Related locations:**');
    out.push('');
    for (const r of f.related) out.push(`- ${locLink(r.loc, opts)} — ${text(r.message)}`);
  }
  out.push('');
  out.push('</details>');
  return out;
}

function renderContracts(plan: ContractPlan, opts: MarkdownOptions): string[] {
  const out: string[] = ['### Contracts', ''];
  const k = plan.counts;
  if (!plan.drift) {
    out.push(`✅ Contracts are up to date (${plural(plan.entries.length, 'file')}).`);
    return out;
  }
  out.push(
    `${plan.breaking ? '❌' : '⚠️'} Contracts drifted: ${k.create} new · ${k.update} changed · ${k.delete} removed · ${k.unchanged} unchanged${plan.breaking ? ` — **${plural(plan.breaking, 'breaking change')}**` : ''}`,
  );
  out.push('');
  out.push('| File | Status | Breaking |');
  out.push('| --- | --- | ---: |');
  const limit = Math.max(1, opts.maxFindings ?? 50);
  const allChanged = plan.entries.filter((e) => e.status !== 'unchanged');
  const changed = allChanged.slice(0, limit);
  for (const e of changed) {
    const breaking = e.changes.filter((c) => c.breaking).length;
    const status = `${STATUS_LABEL[e.status]}${e.invalid ? ' (invalid)' : ''}`;
    out.push(`| ${tableCell(code(e.file))} | ${status} | ${breaking} |`);
  }
  const withChanges = changed.filter((e) => e.changes.length > 0 || e.invalid);
  if (withChanges.length) {
    out.push('');
    for (const e of withChanges) {
      out.push(`- ${code(e.file)}`);
      for (const c of [...e.changes].sort((a, b) => Number(b.breaking) - Number(a.breaking))) {
        out.push(c.breaking ? `  - **${text(c.message)}** (breaking)` : `  - ${text(c.message)}`);
      }
      if (e.invalid) out.push(`  - could not be read as a contract: ${text(e.invalid)}`);
    }
  }
  if (allChanged.length > changed.length) {
    out.push('');
    out.push(
      `_… ${allChanged.length - changed.length} more changed contract files not shown (see the JSON report)._`,
    );
  }
  if (opts.artifact) {
    const patch = opts.artifact.patchFile ?? 'flowpact-contracts.patch';
    out.push('');
    if (opts.artifact.runId) {
      out.push('To update the locked contracts, apply the regenerated ones from this run:');
      out.push('');
      out.push('```sh');
      out.push(`gh run download ${opts.artifact.runId} -n ${opts.artifact.name}`);
    } else {
      out.push(
        `To update the locked contracts, download the ${code(opts.artifact.name)} artifact from this run and apply it:`,
      );
      out.push('');
      out.push('```sh');
    }
    out.push(`git apply --index ${patch}`);
    out.push('```');
    out.push('');
    out.push(`Or run ${code('flowpact generate')} locally and commit the result.`);
  } else {
    out.push('');
    out.push(`Run ${code('flowpact generate')} and commit the result to update the locked contracts.`);
  }
  return out;
}

function renderImpactMarkdown(impact: ImpactResult, opts: MarkdownOptions): string[] {
  const v = impact.verdict;
  const icon = v.ok ? '✅' : '❌';
  const out = [
    '### Impact',
    '',
    `${icon} Declared **${text(describeDeclared(impact))}** · required **${v.required}**`,
  ];
  const changes = listedChanges(impact);
  if (changes.length) {
    out.push('', '| Impact | Unit | Change |', '| --- | --- | --- |');
    const limit = Math.max(1, opts.maxFindings ?? 50);
    for (const c of changes.slice(0, limit)) {
      out.push(
        `| ${c.level === 'major' ? '**major**' : c.level}${c.certain ? '' : ' (uncertain)'} | ${tableCell(code(c.unit))} | ${cell(c.message)} |`,
      );
    }
    if (changes.length > limit)
      out.push('', `_… ${changes.length - limit} more changes (see the JSON report)._`);
  } else {
    out.push('', 'No changes to published workflows or actions.');
  }
  out.push(
    '',
    `<sub>Baseline: ${impact.baseline.kind === 'release' ? 'last release ' : ''}${code(impact.baseline.ref)} (${shortCommit(impact.baseline.commit)})</sub>`,
  );
  return out;
}

/** GitHub-flavored Markdown for job summaries and pull request comments. */
export function renderMarkdown(result: AnalysisResult, opts: MarkdownOptions = {}): string {
  const s = result.summary;
  const m = result.meta;
  const out: string[] = [];
  out.push(`## ${opts.title ?? 'flowpact report'}`);
  out.push('');
  out.push(
    `<sub>${m.tool} v${m.version} · config schema v${m.schemas.config} · contract schema v${m.schemas.contract} · report schema v${m.schemas.report} · ${result.durationMs} ms</sub>`,
  );
  out.push('');
  out.push(statusLine(result));
  out.push('');
  out.push('| Errors | Warnings | Info | Suppressed | Workflows | Actions | Jobs | Matrix combinations |');
  out.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  out.push(
    `| ${s.errors} | ${s.warnings} | ${s.infos} | ${s.suppressed} | ${s.workflows} | ${s.actions} | ${s.jobs} | ${s.matrixCombinations} |`,
  );
  if (s.skippedInGenerated) {
    out.push('');
    out.push(
      `<sub>${plural(s.skippedInGenerated, 'finding')} about the internals of [generated files](${DOCS_BASE_URL}/docs/configuration#generated-files) ${s.skippedInGenerated === 1 ? 'is' : 'are'} not reported.</sub>`,
    );
  }

  const max = Math.max(0, opts.maxFindings ?? 50);
  let shown = 0;
  for (const severity of ['error', 'warning', 'info'] as const) {
    const findings = result.findings.filter((f) => f.severity === severity);
    if (!findings.length || shown >= max) continue;
    const meta = SEVERITY[severity];
    out.push('');
    out.push(`### ${meta.icon} ${meta.title} (${findings.length})`);
    for (const f of findings) {
      if (shown >= max) break;
      out.push('');
      out.push(...renderFinding(f, opts));
      shown++;
    }
  }
  if (result.findings.length > shown) {
    out.push('');
    out.push(
      `_… ${result.findings.length - shown} more ${result.findings.length - shown === 1 ? 'finding' : 'findings'} not shown — the JSON and SARIF reports (or \`flowpact lint\` locally) list them all._`,
    );
  }

  if (result.contracts) {
    out.push('');
    out.push(...renderContracts(result.contracts, opts));
  }

  if (result.impact) {
    out.push('');
    out.push(...renderImpactMarkdown(result.impact, opts));
  }

  if (result.suppressed.length) {
    out.push('');
    out.push(`<details><summary>${plural(result.suppressed.length, 'suppressed finding')}</summary>`);
    out.push('');
    out.push('| Code | Location | Reason | Expires | Owner |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const f of result.suppressed.slice(0, max)) {
      const o = f.override;
      out.push(
        `| [${code(f.code)}](${f.docsUrl}) | ${tableCell(locLink(f.loc, opts))} | ${cell(o.reason)} | ${o.expires ?? '—'} | ${o.owner ? cell(o.owner) : '—'} |`,
      );
    }
    if (result.suppressed.length > max) {
      out.push('');
      out.push(`_… ${result.suppressed.length - max} more suppressed findings (see the JSON report)._`);
    }
    out.push('');
    out.push('</details>');
  }

  if (opts.includeGraph) {
    out.push('');
    out.push('<details><summary>Call graph</summary>');
    out.push('');
    out.push('```mermaid');
    out.push(renderMermaid(buildCallGraph(result.index)).trimEnd());
    out.push('```');
    out.push('');
    out.push('</details>');
  }
  return `${out.join('\n')}\n`;
}
