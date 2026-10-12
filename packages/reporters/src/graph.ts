import {
  expandMatrix,
  type JobDecl,
  type ProjectIndex,
  sym,
  trimChar,
  type UnitDecl,
  type UsesRef,
} from '@ciatlas/core';
import { createTheme, finalize, type RenderOptions, safe, type Theme } from './theme';

export type CallGraphNodeKind = 'workflow' | 'action' | 'remote' | 'missing' | 'invalid';

export interface CallGraphNode {
  /**
   * Unit path for local workflows/actions, `remote:<uses>` for remote workflows, the target path when missing or when
   * a job calls a file outside `.github/workflows` (`invalid`, FP606).
   */
  id: string;
  kind: CallGraphNodeKind;
  label: string;
  /** Events that trigger a workflow (`on:`). */
  triggers?: string[];
}

export interface CallGraphEdge {
  from: string;
  to: string;
  /** Where the call is made: `jobs.<id>`, `jobs.<id> › steps[<n>]` or (inside an action) `steps[<n>]`. */
  via: string;
  kind: 'calls' | 'uses';
  /** Number of matrix combinations when the calling job has a static matrix. */
  matrix?: number;
  /** The call passes every secret with `secrets: inherit`. */
  inherits?: boolean;
  /** The called workflow exists but has no `on.workflow_call` (FP609). */
  notReusable?: boolean;
}

/** Which workflow calls which, and which local action each job or action uses. */
export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

const KIND_ORDER: Record<CallGraphNodeKind, number> = {
  workflow: 0,
  action: 1,
  remote: 2,
  missing: 3,
  invalid: 4,
};

function staticMatrixSize(job: JobDecl): number | undefined {
  if (!job.matrix) return undefined;
  const exp = expandMatrix(job.matrix);
  return exp.exact && !exp.dynamic && !exp.truncated ? exp.combos.length : undefined;
}

/** Builds the call graph of the analyzed repository. Ordering is deterministic (by path, then declaration). */
export function buildCallGraph(index: ProjectIndex): CallGraph {
  const { project } = index;
  const nodes = new Map<string, CallGraphNode>();
  const edges: CallGraphEdge[] = [];
  // Paths that do not exist (an action in the repository but outside the workspace is still drawn as itself).
  const missingTargets = new Set<string>();
  for (const m of project.missing) {
    const target = m.target ?? m.uses.target;
    if (target !== undefined && !m.inRepository) missingTargets.add(target);
  }
  const invalidCalls = new Set((project.invalidTargets ?? []).map((m) => `${m.from}#${m.job ?? ''}`));

  const workflows = [...project.workflows.values()].sort((a, b) => a.path.localeCompare(b.path));
  const actions = [...project.actions.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const wf of workflows)
    nodes.set(wf.path, {
      id: wf.path,
      kind: 'workflow',
      label: wf.name ?? wf.path,
      triggers: [...wf.triggers],
    });
  for (const a of actions) nodes.set(a.path, { id: a.path, kind: 'action', label: a.name ?? a.path });

  const missingNode = (uses: UsesRef): string | undefined => {
    if (!uses.target || !missingTargets.has(uses.target)) return undefined;
    if (!nodes.has(uses.target))
      nodes.set(uses.target, { id: uses.target, kind: 'missing', label: uses.raw });
    return uses.target;
  };

  const stepEdges = (unit: UnitDecl, job: JobDecl | undefined, matrix: number | undefined) => {
    for (const step of job ? job.steps : unit.kind === 'action' ? unit.steps : []) {
      if (step.uses?.kind !== 'local-action') continue;
      const to = index.actionOf(step)?.path ?? missingNode(step.uses);
      if (!to) continue;
      const via = job ? `jobs.${job.id} › steps[${step.index}]` : `steps[${step.index}]`;
      edges.push({ from: unit.path, to, via, kind: 'uses', ...(matrix !== undefined ? { matrix } : {}) });
    }
  };

  for (const wf of workflows) {
    for (const job of Object.values(wf.jobs)) {
      const matrix = staticMatrixSize(job);
      const extra = {
        ...(matrix !== undefined ? { matrix } : {}),
        ...(job.secretsInherit ? { inherits: true } : {}),
      };
      if (job.uses) {
        let to: string | undefined;
        if (job.uses.kind === 'local-workflow' && invalidCalls.has(`${wf.path}#${job.id}`)) {
          // A job-level call to a file outside .github/workflows (FP606): drawn, so graph and findings agree.
          to = job.uses.target ?? job.uses.raw;
          if (!nodes.has(to) || nodes.get(to)!.kind === 'missing')
            nodes.set(to, { id: to, kind: 'invalid', label: job.uses.raw });
        } else if (job.uses.kind === 'local-workflow') {
          const callee = index.calleeOf(job);
          const target = callee ? undefined : index.targetOf(job);
          to = callee?.path ?? target?.path ?? missingNode(job.uses);
          if (target) {
            edges.push({
              from: wf.path,
              to: target.path,
              via: `jobs.${job.id}`,
              kind: 'calls',
              ...extra,
              notReusable: true,
            });
            to = undefined;
          }
        } else if (job.uses.kind === 'remote-workflow') {
          to = sym.remote(job.uses.raw);
          if (!nodes.has(to)) nodes.set(to, { id: to, kind: 'remote', label: job.uses.raw });
        }
        if (to) edges.push({ from: wf.path, to, via: `jobs.${job.id}`, kind: 'calls', ...extra });
      }
      stepEdges(wf, job, matrix);
    }
  }
  for (const a of actions) stepEdges(a, undefined, undefined);

  return {
    nodes: [...nodes.values()].sort(
      (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id),
    ),
    edges,
  };
}

/** The edge annotation shown in every format: `jobs.build ×3 (inherit)`. */
export function edgeLabel(e: CallGraphEdge, ascii = false): string {
  return `${e.via}${e.matrix !== undefined ? ` ${ascii ? 'x' : '×'}${e.matrix}` : ''}${e.inherits ? ' (inherit)' : ''}${e.notReusable ? ' (not reusable)' : ''}`;
}

/** Maps node ids to unique identifiers made of `[A-Za-z0-9_]`. */
function safeIds(graph: CallGraph): Map<string, string> {
  const prefix: Record<CallGraphNodeKind, string> = {
    workflow: 'wf',
    action: 'act',
    remote: 'remote',
    missing: 'missing',
    invalid: 'invalid',
  };
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const n of graph.nodes) {
    const slug = n.id
      .replace(/^remote:/, '')
      .replace(/^\.github\/(workflows|actions)\//, '')
      .replace(/[^A-Za-z0-9_]+/g, '_');
    const base = `${prefix[n.kind]}_${trimChar(slug, '_', { start: true })}`;
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
    taken.add(id);
    out.set(n.id, id);
  }
  return out;
}

const nodeText = (n: CallGraphNode) =>
  n.kind === 'missing' || n.kind === 'invalid'
    ? `${n.id} (${n.kind === 'missing' ? 'missing' : 'invalid location'})`
    : n.kind === 'remote' || n.label === n.id
      ? n.label
      : `${n.label}\n${n.id}`;

export interface MermaidOptions {
  direction?: 'LR' | 'TD';
}

/** A Mermaid `flowchart` of the call graph (without code fences). */
export function renderMermaid(graph: CallGraph, opts: MermaidOptions = {}): string {
  const ids = safeIds(graph);
  const quote = (s: string) => `"${s.replace(/"/g, '#quot;').replace(/\n/g, '<br/>')}"`;
  const lines = [`flowchart ${opts.direction ?? 'LR'}`];
  for (const n of graph.nodes) {
    const id = ids.get(n.id)!;
    const text = quote(nodeText(n));
    const shape = n.kind === 'workflow' ? `(${text})` : n.kind === 'action' ? `{{${text}}}` : `[${text}]`;
    lines.push(`  ${id}${shape}:::${n.kind}`);
  }
  for (const e of graph.edges) {
    const arrow = e.kind === 'uses' ? '-.->' : '-->';
    lines.push(`  ${ids.get(e.from)} ${arrow}|${quote(edgeLabel(e))}| ${ids.get(e.to)}`);
  }
  lines.push(
    '  classDef workflow fill:#e8f1ff,stroke:#3b82f6,color:#0f172a',
    '  classDef action fill:#f3e8ff,stroke:#8b5cf6,color:#0f172a',
    '  classDef remote fill:#f8fafc,stroke:#64748b,stroke-dasharray:5 5,color:#334155',
    '  classDef missing fill:#fee2e2,stroke:#dc2626,color:#991b1b',
    '  classDef invalid fill:#fee2e2,stroke:#dc2626,stroke-dasharray:5 5,color:#991b1b',
  );
  return `${lines.join('\n')}\n`;
}

/** A Graphviz `digraph` of the call graph. */
export function renderDot(graph: CallGraph): string {
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  const style: Record<CallGraphNodeKind, string> = {
    workflow: 'shape=box, style="rounded,filled", fillcolor="#e8f1ff", color="#3b82f6"',
    action: 'shape=hexagon, style=filled, fillcolor="#f3e8ff", color="#8b5cf6"',
    remote: 'shape=box, style=dashed, color="#64748b"',
    missing: 'shape=box, style=filled, fillcolor="#fee2e2", color="#dc2626", fontcolor="#991b1b"',
    invalid: 'shape=box, style="filled,dashed", fillcolor="#fee2e2", color="#dc2626", fontcolor="#991b1b"',
  };
  const lines = [
    'digraph flowpact {',
    '  rankdir=LR;',
    '  node [fontname="Helvetica", fontsize=11];',
    '  edge [fontname="Helvetica", fontsize=9];',
  ];
  for (const n of graph.nodes) lines.push(`  ${q(n.id)} [label=${q(nodeText(n))}, ${style[n.kind]}];`);
  for (const e of graph.edges) {
    lines.push(
      `  ${q(e.from)} -> ${q(e.to)} [label=${q(edgeLabel(e))}${e.kind === 'uses' ? ', style=dashed' : ''}];`,
    );
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function treeLabel(t: Theme, raw: CallGraphNode, root: boolean): string {
  const { c } = t;
  // Workflow names come from YAML; never let them carry escape sequences to the terminal.
  const n = { ...raw, label: safe(raw.label), id: safe(raw.id) };
  switch (n.kind) {
    case 'workflow': {
      const path = n.label !== n.id ? ` ${c.dim(`(${n.id})`)}` : '';
      const on = root && n.triggers?.length ? ` ${c.dim(`${t.sym.dot} on: ${n.triggers.join(', ')}`)}` : '';
      return `${c.bold(c.cyan(n.label))}${path}${on}`;
    }
    case 'action':
      return `${c.bold(c.magenta(n.label))} ${c.dim(n.label !== n.id ? `(action ${n.id})` : '(action)')}`;
    case 'remote':
      return `${c.blue(n.label)} ${c.dim('(remote)')}`;
    case 'missing':
      return `${c.red(c.bold(n.id))} ${c.red('(missing)')}`;
    case 'invalid':
      return `${c.red(c.bold(n.id))} ${c.red('(invalid location)')}`;
  }
}

/** Renders the call graph as a tree from its entry points (nodes nothing calls). */
export function renderGraphTree(graph: CallGraph, opts: RenderOptions): string {
  const t = createTheme(opts);
  const { c } = t;
  const a = opts.ascii ?? false;
  const g = a
    ? { tee: '|-- ', elbow: '`-- ', pipe: '|   ', space: '    ' }
    : { tee: '├── ', elbow: '└── ', pipe: '│   ', space: '    ' };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, CallGraphEdge[]>();
  for (const e of graph.edges) outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
  const called = new Set(graph.edges.map((e) => e.to));
  const out: string[] = [];
  const expanded = new Set<string>();

  const walk = (id: string, prefix: string, path: string[]) => {
    expanded.add(id);
    const edges = outgoing.get(id) ?? [];
    edges.forEach((e, i) => {
      const last = i === edges.length - 1;
      const target = byId.get(e.to);
      if (!target) return;
      const via = e.kind === 'uses' ? c.dim(`${edgeLabel(e, a)} uses`) : c.dim(edgeLabel(e, a));
      let mark = '';
      if (path.includes(e.to)) mark = ` ${c.yellow(a ? '(cycle)' : '↻ cycle')}`;
      else if (expanded.has(e.to) && outgoing.has(e.to)) mark = ` ${c.dim('(see above)')}`;
      out.push(
        `${prefix}${c.dim(last ? g.elbow : g.tee)}${via} ${c.dim(t.sym.arrow)} ${treeLabel(t, target, false)}${mark}`,
      );
      if (!mark) walk(e.to, prefix + c.dim(last ? g.space : g.pipe), [...path, e.to]);
    });
  };

  const roots = graph.nodes.filter((n) => !called.has(n.id));
  for (const n of [...roots, ...graph.nodes]) {
    if (expanded.has(n.id)) continue;
    if (out.length) out.push('');
    out.push(treeLabel(t, n, true));
    walk(n.id, '', [n.id]);
  }
  if (graph.nodes.length === 0) out.push(c.yellow('No workflows or actions found'));
  return finalize(out.join('\n'), opts);
}
