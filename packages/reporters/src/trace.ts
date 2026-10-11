import { formatLoc, type TraceDirection, type TraceNode } from '@flowpact/core';
import { createTheme, finalize, type RenderOptions, safe, type Theme } from './theme';

const KIND_COLOR: Record<string, 'green' | 'yellow' | 'magenta' | 'cyan' | 'blue'> = {
  input: 'green',
  secret: 'yellow',
  output: 'magenta',
  'job-output': 'magenta',
  'step-output': 'magenta',
  env: 'cyan',
  matrix: 'blue',
};

function nodeLabel(t: Theme, n: TraceNode): string {
  const { c } = t;
  const color = KIND_COLOR[n.kind] ?? 'cyan';
  const unit = n.unit ? `${c.dim(n.unit)}${c.dim('#')}` : '';
  const label = safe(n.symbol.includes('#') ? n.symbol.slice(n.symbol.indexOf('#') + 1) : n.label);
  // The unit is already shown before `#`; only repeat the position (or the full location for another file).
  const loc = n.loc
    ? c.dim(n.loc.file === n.unit ? `:${n.loc.line}:${n.loc.column}` : `  ${formatLoc(n.loc)}`)
    : '';
  const stop =
    n.stop === 'cycle'
      ? c.yellow('  ↻ cycle')
      : n.stop === 'depth'
        ? c.yellow('  … max depth')
        : n.stop === 'seen'
          ? c.dim('  ↑ shown above')
          : '';
  return `${unit}${c[color](c.bold(label))}${loc} ${c.dim(`(${n.kind})`)}${stop}`;
}

/** Renders a trace as an indented tree. */
export function renderTrace(root: TraceNode, direction: TraceDirection, opts: RenderOptions): string {
  const t = createTheme(opts);
  const { c } = t;
  const a = opts.ascii ?? false;
  const g = a
    ? { tee: '|-- ', elbow: '`-- ', pipe: '|   ', space: '    ' }
    : { tee: '├── ', elbow: '└── ', pipe: '│   ', space: '    ' };
  const arrow = direction === 'down' ? (a ? '-> ' : '▶ ') : a ? '<- ' : '◀ ';
  const out: string[] = [nodeLabel(t, root)];

  const walk = (n: TraceNode, prefix: string) => {
    const items: (
      | { kind: 'child'; node: TraceNode }
      | { kind: 'leaf'; leaf: TraceNode['leaves'][number] }
    )[] = [
      ...n.children.map((node) => ({ kind: 'child' as const, node })),
      ...n.leaves.map((leaf) => ({ kind: 'leaf' as const, leaf })),
    ];
    items.forEach((item, i) => {
      const last = i === items.length - 1;
      const branch = c.dim(last ? g.elbow : g.tee);
      const nextPrefix = prefix + c.dim(last ? g.space : g.pipe);
      if (item.kind === 'child') {
        out.push(`${prefix}${branch}${c.cyan(arrow)}${nodeLabel(t, item.node)}`);
        if (item.node.via) {
          out.push(
            `${nextPrefix}${c.dim(`via ${item.node.via.text}`)}${c.dim(`  @ ${formatLoc(item.node.via.loc)}`)}`,
          );
        }
        walk(item.node, nextPrefix);
      } else {
        const l = item.leaf;
        const role =
          l.role === 'omitted' || l.role === 'missing'
            ? c.red(c.bold(l.role))
            : l.role === 'literal' || l.role === 'value'
              ? c.green(l.role)
              : c.bold(l.role);
        out.push(`${prefix}${branch}${role} ${c.dim('in')} ${l.where}  ${c.dim(formatLoc(l.loc))}`);
        out.push(`${nextPrefix}${c.dim(l.text)}`);
      }
    });
  };
  walk(root, '');
  if (root.children.length === 0 && root.leaves.length === 0 && !root.stop) {
    out.push(c.yellow(`  ${direction === 'down' ? 'not read anywhere' : 'no known sources'}`));
  }
  return finalize(out.join('\n'), opts);
}
