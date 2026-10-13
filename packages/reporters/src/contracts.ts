import type { ContractPlan } from '@flowpact/lint';
import { createTheme, finalize, padEnd, type RenderOptions, type Theme, visibleWidth } from './kit';

const STATUS = {
  create: { label: 'new', color: 'green' },
  update: { label: 'changed', color: 'yellow' },
  delete: { label: 'removed', color: 'red' },
  unchanged: { label: 'unchanged', color: 'dim' },
} as const;

/** What renderContractPlan() reads of a plan. */
type Plan = Pick<ContractPlan, 'entries' | 'drift' | 'counts' | 'breaking'>;

/** The badge after a file: how many breaking changes it has, or that it could not be read. */
function entryTag(t: Theme, e: Plan['entries'][number]): string {
  const breaking = e.changes.filter((x) => x.breaking).length;
  if (breaking) return `  ${t.badge.error(` ${breaking} BREAKING `)}`;
  return e.invalid ? `  ${t.badge.warning(' INVALID ')}` : '';
}

/** A contract file's row, then its changes (breaking ones first) and why it could not be read. */
function entryLines(t: Theme, e: Plan['entries'][number], fileW: number): string[] {
  const { c, sym } = t;
  const s = STATUS[e.status];
  const label = c[s.color](s.label.padEnd(9));
  const out = [
    `  ${label} ${e.status === 'unchanged' ? c.dim(padEnd(e.file, fileW)) : padEnd(e.file, fileW)}${entryTag(t, e)}`,
  ];
  for (const ch of [...e.changes].sort((a, b) => Number(b.breaking) - Number(a.breaking))) {
    out.push(
      `  ${' '.repeat(9)}   ${ch.breaking ? c.red(`${sym.error} ${ch.message}`) : c.dim(`${sym.dot} ${ch.message}`)}`,
    );
  }
  if (e.invalid) out.push(`  ${' '.repeat(9)}   ${c.yellow(e.invalid)}`);
  return out;
}

/** The verdict: up to date, or what was (or would be) written. */
function planVerdict(t: Theme, plan: Plan, applied: boolean | undefined): string {
  const { c, sym } = t;
  const k = plan.counts;
  if (!plan.drift) return c.green(`${sym.ok} Contracts are up to date`);
  const verb = applied ? 'Wrote' : 'Would write';
  return `${verb}: ${c.green(`${k.create} new`)}, ${c.yellow(`${k.update} changed`)}, ${c.red(`${k.delete} removed`)}, ${c.dim(`${k.unchanged} unchanged`)}${plan.breaking ? `  ${c.red(c.bold(`${plan.breaking} breaking change${plan.breaking === 1 ? '' : 's'}`))}` : ''}`;
}

/** A table of contract files with their status and the semantic changes, breaking ones first. */
export function renderContractPlan(
  plan: Pick<ContractPlan, 'entries' | 'drift' | 'counts' | 'breaking'>,
  opts: RenderOptions,
  extra: { applied?: boolean } = {},
): string {
  const t = createTheme(opts);
  const { c } = t;
  const fileW = Math.min(64, Math.max(...plan.entries.map((e) => visibleWidth(e.file)), 10));
  const out = [
    c.bold(`Contracts ${c.dim(`(${plan.entries.length} file${plan.entries.length === 1 ? '' : 's'})`)}`),
    ...plan.entries.flatMap((e) => entryLines(t, e, fileW)),
    '',
    planVerdict(t, plan, extra.applied),
  ];
  return finalize(out.join('\n'), opts);
}

/** Colors a unified diff. */
export function renderPatch(patch: string, opts: RenderOptions): string {
  const { c } = createTheme(opts);
  return patch
    .split('\n')
    .map((l) => {
      if (l.startsWith('diff --git')) return c.bold(l);
      if (
        l.startsWith('+++') ||
        l.startsWith('---') ||
        l.startsWith('new file') ||
        l.startsWith('deleted file')
      )
        return c.bold(c.dim(l));
      if (l.startsWith('@@')) return c.cyan(l);
      if (l.startsWith('+')) return c.green(l);
      if (l.startsWith('-')) return c.red(l);
      return c.dim(l);
    })
    .join('\n');
}
