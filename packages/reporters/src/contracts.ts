import type { ContractPlan } from '@flowpact/lint';
import { createTheme, finalize, padEnd, type RenderOptions, visibleWidth } from './theme';

const STATUS = {
  create: { label: 'new', color: 'green' },
  update: { label: 'changed', color: 'yellow' },
  delete: { label: 'removed', color: 'red' },
  unchanged: { label: 'unchanged', color: 'dim' },
} as const;

/** A table of contract files with their status and the semantic changes, breaking ones first. */
export function renderContractPlan(
  plan: Pick<ContractPlan, 'entries' | 'drift' | 'counts' | 'breaking'>,
  opts: RenderOptions,
  extra: { applied?: boolean } = {},
): string {
  const t = createTheme(opts);
  const { c, sym } = t;
  const out: string[] = [];
  const fileW = Math.min(64, Math.max(...plan.entries.map((e) => visibleWidth(e.file)), 10));
  out.push(
    c.bold(`Contracts ${c.dim(`(${plan.entries.length} file${plan.entries.length === 1 ? '' : 's'})`)}`),
  );
  for (const e of plan.entries) {
    const s = STATUS[e.status];
    const label = c[s.color](s.label.padEnd(9));
    const breaking = e.changes.filter((x) => x.breaking).length;
    const tag = breaking
      ? `  ${t.badge.error(` ${breaking} BREAKING `)}`
      : e.invalid
        ? `  ${t.badge.warning(' INVALID ')}`
        : '';
    out.push(
      `  ${label} ${e.status === 'unchanged' ? c.dim(padEnd(e.file, fileW)) : padEnd(e.file, fileW)}${tag}`,
    );
    for (const ch of [...e.changes].sort((a, b) => Number(b.breaking) - Number(a.breaking))) {
      out.push(
        `  ${' '.repeat(9)}   ${ch.breaking ? c.red(`${sym.error} ${ch.message}`) : c.dim(`${sym.dot} ${ch.message}`)}`,
      );
    }
    if (e.invalid) out.push(`  ${' '.repeat(9)}   ${c.yellow(e.invalid)}`);
  }
  const k = plan.counts;
  out.push('');
  if (!plan.drift) {
    out.push(c.green(`${sym.ok} Contracts are up to date`));
  } else {
    const verb = extra.applied ? 'Wrote' : 'Would write';
    out.push(
      `${verb}: ${c.green(`${k.create} new`)}, ${c.yellow(`${k.update} changed`)}, ${c.red(`${k.delete} removed`)}, ${c.dim(`${k.unchanged} unchanged`)}${plan.breaking ? `  ${c.red(c.bold(`${plan.breaking} breaking change${plan.breaking === 1 ? '' : 's'}`))}` : ''}`,
    );
  }
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
