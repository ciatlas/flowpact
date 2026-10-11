import {
  type Binding,
  type Declaration,
  expandMatrix,
  type GraphNode,
  type Json,
  type Loc,
  lookup,
  type Occurrence,
  type ProjectIndex,
  type SymbolLocator,
} from '@flowpact/core';
import { DOCS_BASE_URL, type TraceNode, trace } from '@flowpact/lint';

/**
 * The hover sits above other extensions' hovers (GitHub Actions adds its own), so it stays short: a header naming
 * flowpact with a docs link, one line saying what the symbol is, an optional description, and the data flow in at most
 * one line per direction.
 */
const DOCS = `${DOCS_BASE_URL}/docs/editors#hover`;
/** Direct sources or destinations listed per direction before the rest are counted. */
const MAX_FLOW = 3;
/** Characters of a code span (an expression, a value) before it is cut. */
const MAX_CODE = 48;
/** Characters of a description before it is cut. */
const MAX_TEXT = 160;
/** Values listed (matrix values, options, needs) before the rest are counted. */
const MAX_LIST = 5;

const TRACED = new Set(['input', 'secret', 'output', 'job-output', 'step-output', 'env', 'matrix']);

const KIND: Record<string, string> = {
  input: 'input',
  secret: 'secret',
  output: 'output',
  'job-output': 'job output',
  'step-output': 'step output',
  env: 'env variable',
  matrix: 'matrix key',
  job: 'job',
  var: 'configuration variable',
  remote: 'remote reference',
  workflow: 'workflow',
  action: 'action',
  symbol: 'reference',
};

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Inline code, on one line and cut to size; YAML text may hold backticks and newlines. */
const code = (s: string) => `\`${cut(s.replace(/`/g, "'").replace(/\s+/g, ' ').trim(), MAX_CODE) || ' '}\``;

/** Free text from a repository (descriptions) shown as text, not markdown. */
const text = (s: string) =>
  cut(s.replace(/\s+/g, ' ').trim(), MAX_TEXT).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (c) => `\\${c}`);

const json = (v: Json | undefined) => (typeof v === 'string' ? v : JSON.stringify(v));

/** A list cut to MAX_LIST entries, with the rest counted. */
const list = (items: string[]) =>
  items.length > MAX_LIST
    ? `${items.slice(0, MAX_LIST).join(', ')} +${items.length - MAX_LIST}`
    : items.join(', ');

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** How a unit is named in a hover: workflows by file name, the repository's own action as action.yml. */
const unitName = (path: string) => (path === '.' ? 'action.yml' : path.replace(/^\.github\/workflows\//, ''));

/** `.github/workflows/ci.yml#inputs.x` → `ci.yml#inputs.x`; also inside "where" paths of the trace. */
const short = (s: string) => s.replace(/(^|\s)\.github\/workflows\//g, '$1').replace(/^\.#/, 'action.yml#');

/** The kind of a symbol, also for symbols nothing declares (the graph marks those unresolved). */
function kindOf(symbol: string, node: GraphNode | undefined): string {
  if (symbol.startsWith('remote:')) return 'remote';
  if (node && node.kind !== 'unresolved') return node.kind;
  const tail = symbol.slice(symbol.indexOf('#') + 1);
  if (tail.startsWith('secrets.')) return 'secret';
  if (tail.startsWith('inputs.')) return 'input';
  if (/(^|\.)steps\.[^.]+\.outputs\./.test(tail)) return 'step-output';
  if (/^jobs\.[^.]+\.outputs\./.test(tail)) return 'job-output';
  if (/^jobs\.[^.]+\.matrix\./.test(tail)) return 'matrix';
  if (/^(jobs\.[^.]+\.)?env\./.test(tail)) return 'env';
  return 'symbol';
}

const sameStart = (a: Loc, b: Loc) => a.file === b.file && a.line === b.line && a.column === b.column;

/** The `with:` or `secrets:` entry a binding occurrence stands on. */
function bindingAt(index: ProjectIndex, loc: Loc): Binding | undefined {
  for (const unit of index.units()) {
    if (unit.file !== loc.file) continue;
    const steps = unit.kind === 'workflow' ? Object.values(unit.jobs).flatMap((j) => j.steps) : unit.steps;
    const maps = unit.kind === 'workflow' ? Object.values(unit.jobs).flatMap((j) => [j.with, j.secrets]) : [];
    for (const m of [...maps, ...steps.map((s) => s.with)])
      for (const b of Object.values(m)) if (sameStart(b.loc, loc)) return b;
  }
  return undefined;
}

/** Markdown for hovering a symbol: who says so, what it is, and where its value comes from and goes. */
export function hoverMarkdown(locator: SymbolLocator, at: Occurrence): string {
  const index = locator.index;
  const node = index.nodes.get(at.symbol);
  const kind = kindOf(at.symbol, node);
  const decls = locator.declarations(at.symbol);
  // On a declaration, describe that one (an input can be declared for workflow_call and workflow_dispatch).
  const decl = decls.find((d) => sameStart(d.loc, at.loc)) ?? decls[0];
  const label = at.symbol.startsWith('remote:')
    ? at.symbol.slice('remote:'.length)
    : at.symbol.includes('#')
      ? at.symbol.slice(at.symbol.indexOf('#') + 1)
      : kind === 'workflow' || kind === 'action'
        ? unitName(at.symbol)
        : (node?.label ?? at.symbol);

  const out = [`**flowpact** · ${KIND[kind] ?? 'reference'} · [docs](${DOCS})`, ''];
  const facts = decl ? describe(locator, decl) : undeclared(index, kind, at.symbol, node);
  // The symbol's own unit; a calling job's outputs are declared by the callee, a step's by its action.
  const owner = node?.unit ?? (decl && decl.kind !== 'unit' ? decl.unit : undefined);
  const where =
    kind === 'var' || kind === 'remote' || !owner || owner === at.symbol
      ? ''
      : ` in ${code(unitName(owner))}`;
  if (decl && decl.kind !== 'unit' && owner && decl.unit !== owner)
    facts.line = [`from ${code(unitName(decl.unit))}`, facts.line].filter(Boolean).join(' · ');

  if (at.role === 'binding') {
    // A caller's `with:`/`secrets:` key: what this call passes, then where the value goes in the callee. Other
    // callers' values are not this call's business; they are counted.
    const binding = bindingAt(index, at.loc);
    const passed = binding ? (binding.site ? binding.site.text : json(binding.value)) : undefined;
    const others = locator.occurrences(at.symbol).filter((o) => o.role === 'binding').length - 1;
    out.push(`${code(label)}${where}${facts.line ? ` · ${facts.line}` : ''}`);
    const call = [
      passed !== undefined
        ? `this call passes ${passed === '' ? 'an empty value' : code(passed)}`
        : undefined,
      others > 0 ? plural(others, 'other caller') : undefined,
    ].filter(Boolean);
    if (call.length) out.push('', call.join(' · '));
    if (facts.description) out.push('', facts.description);
    const to = flowLine(trace(index, at.symbol, { direction: 'down', maxDepth: 2 }));
    if (to) out.push('', '---', '', `**To** ${to}`);
    return out.join('\n');
  }

  out.push(`${code(label)}${where}${facts.line ? ` · ${facts.line}` : ''}`);
  if (facts.description) out.push('', facts.description);
  if (decls.length > 1) out.push('', `Declared in ${decls.length} places.`);

  if (TRACED.has(kind)) {
    // A matrix key's sources are its values, already listed above.
    const from = kind === 'matrix' ? '' : flowLine(trace(index, at.symbol, { direction: 'up', maxDepth: 2 }));
    const to = flowLine(trace(index, at.symbol, { direction: 'down', maxDepth: 2 }));
    if (from || to) {
      out.push('', '---', '');
      if (from) out.push(`**From** ${from}${to ? '  ' : ''}`);
      if (to) out.push(`**To** ${to}`);
    }
  }
  return out.join('\n');
}

interface Facts {
  /** Short facts joined on the identity line. */
  line: string;
  description?: string;
}

function describe(locator: SymbolLocator, d: Declaration): Facts {
  const join = (parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');
  switch (d.kind) {
    case 'input': {
      const i = d.decl;
      const value = i.hasDefault ? json(i.default) : undefined;
      return {
        line: join([
          i.type ? code(i.type) : undefined,
          i.required ? 'required' : 'optional',
          value === undefined ? undefined : value === '' ? 'default empty' : `default ${code(value)}`,
          i.options?.length ? `one of ${list(i.options.map(code))}` : undefined,
        ]),
        ...(i.description ? { description: text(i.description) } : {}),
      };
    }
    case 'secret':
      return {
        line: d.decl.required ? 'required' : 'optional',
        ...(d.decl.description ? { description: text(d.decl.description) } : {}),
      };
    case 'output':
      return {
        line: d.decl.value !== undefined ? `value ${code(json(d.decl.value))}` : '',
        ...(d.decl.description ? { description: text(d.decl.description) } : {}),
      };
    case 'job': {
      const j = d.decl;
      const combos = j.matrix ? expandMatrix(j.matrix).combos.length : 0;
      return {
        line: join([
          j.name ? `name ${code(j.name)}` : undefined,
          j.uses ? `calls ${code(j.uses.raw)}` : undefined,
          j.needs.length ? `needs ${list(j.needs.map((n) => code(n.id)))}` : undefined,
          j.matrix
            ? j.matrix.dynamic
              ? 'matrix computed at runtime'
              : plural(combos, 'matrix combination')
            : undefined,
        ]),
      };
    }
    case 'env':
      return { line: `value ${code(json(d.decl.value))}` };
    case 'matrix': {
      const exp = expandMatrix(d.job.matrix);
      if (exp.dynamic) return { line: 'computed at runtime' };
      const values = new Set<string>();
      for (const combo of exp.combos) {
        const cell = lookup(combo.values, d.key);
        values.add(cell ? (cell.known ? code(json(cell.value as Json)) : 'an expression') : 'unset');
      }
      return { line: `values ${list([...values])}` };
    }
    case 'step':
      return {
        line: d.decl.uses
          ? `outputs of ${code(d.decl.uses.raw)}, not declared`
          : 'written by the step’s script',
      };
    case 'unit': {
      const u = d.decl;
      if (u.kind === 'workflow') {
        const callers = locator.index.callersOf(u.path).length;
        return {
          line: join([
            u.name ? `name ${code(u.name)}` : undefined,
            u.triggers.length ? `on ${list(u.triggers.map(code))}` : undefined,
            u.call ? `called by ${plural(callers, 'job')}` : undefined,
          ]),
        };
      }
      return {
        line: join([
          u.name ? `name ${code(u.name)}` : undefined,
          `used by ${plural(locator.index.usersOf(u.path).length, 'step')}`,
        ]),
      };
    }
  }
}

function undeclared(index: ProjectIndex, kind: string, symbol: string, node: GraphNode | undefined): Facts {
  switch (kind) {
    case 'var':
      return { line: 'set in the repository, environment or organization settings' };
    case 'remote':
      return { line: 'in another repository; its interface is not verified' };
    case 'step-output':
      return { line: 'not declared, so not verified' };
    case 'secret': {
      if (/#secrets\.github_token$/i.test(symbol)) return { line: 'provided by GitHub in every run' };
      const unit = node?.unit ? index.unit(node.unit) : undefined;
      return unit?.kind === 'workflow' && unit.call
        ? { line: `not declared under ${code('on.workflow_call.secrets')}` }
        : { line: 'a repository, environment or organization secret' };
    }
    default:
      return { line: 'not declared in any file flowpact analyzes' };
  }
}

/** The direct sources or destinations of a value on one line: `a` · `b` · `c` +2. */
function flowLine(root: TraceNode): string {
  const entries: string[] = [];
  for (const child of root.children) entries.push(code(short(child.symbol)));
  for (const leaf of root.leaves) {
    const value = leaf.role === 'literal' || leaf.role === 'value' ? ` ${code(leaf.text)}` : '';
    entries.push(`${leaf.role}${value} in ${code(short(leaf.where))}`);
  }
  const unique = [...new Set(entries)];
  if (unique.length === 0) return '';
  const more = unique.length > MAX_FLOW ? ` +${unique.length - MAX_FLOW} more` : '';
  return `${unique.slice(0, MAX_FLOW).join(' · ')}${more}`;
}
