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
  type TraceNode,
  trace,
  type UnitDecl,
} from '@ciatlas/core';
import { DOCS_BASE_URL } from '@flowpact/lint';

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

/** Kinds of symbols nothing declares, by the part of the symbol after `#`, tried in order. */
const UNDECLARED_KINDS: [RegExp, string][] = [
  [/^secrets\./, 'secret'],
  [/^inputs\./, 'input'],
  [/(^|\.)steps\.[^.]+\.outputs\./, 'step-output'],
  [/^jobs\.[^.]+\.outputs\./, 'job-output'],
  [/^jobs\.[^.]+\.matrix\./, 'matrix'],
  [/^(jobs\.[^.]+\.)?env\./, 'env'],
];

/** The kind of a symbol, also for symbols nothing declares (the graph marks those unresolved). */
function kindOf(symbol: string, node: GraphNode | undefined): string {
  if (symbol.startsWith('remote:')) return 'remote';
  if (node && node.kind !== 'unresolved') return node.kind;
  const tail = symbol.slice(symbol.indexOf('#') + 1);
  return UNDECLARED_KINDS.find(([pattern]) => pattern.test(tail))?.[1] ?? 'symbol';
}

const sameStart = (a: Loc, b: Loc) => a.file === b.file && a.line === b.line && a.column === b.column;

/** The `with:` and `secrets:` maps of a unit: its jobs' (in a workflow), then its steps'. */
function bindingMaps(unit: UnitDecl): Record<string, Binding>[] {
  const steps = unit.kind === 'workflow' ? Object.values(unit.jobs).flatMap((j) => j.steps) : unit.steps;
  const maps = unit.kind === 'workflow' ? Object.values(unit.jobs).flatMap((j) => [j.with, j.secrets]) : [];
  return [...maps, ...steps.map((s) => s.with)];
}

/** The `with:` or `secrets:` entry a binding occurrence stands on. */
function bindingAt(index: ProjectIndex, loc: Loc): Binding | undefined {
  for (const unit of index.units()) {
    if (unit.file !== loc.file) continue;
    const binding = bindingMaps(unit)
      .flatMap((m) => Object.values(m))
      .find((b) => sameStart(b.loc, loc));
    if (binding) return binding;
  }
  return undefined;
}

/** How a symbol is named in its hover: a remote reference as written, a key by its path, a unit by its file. */
function labelOf(symbol: string, kind: string, node: GraphNode | undefined): string {
  if (symbol.startsWith('remote:')) return symbol.slice('remote:'.length);
  if (symbol.includes('#')) return symbol.slice(symbol.indexOf('#') + 1);
  if (kind === 'workflow' || kind === 'action') return unitName(symbol);
  return node?.label ?? symbol;
}

/** The symbol's own unit; a calling job's outputs are declared by the callee, a step's by its action. */
function ownerOf(node: GraphNode | undefined, decl: Declaration | undefined): string | undefined {
  return node?.unit ?? (decl && decl.kind !== 'unit' ? decl.unit : undefined);
}

/** ` in <unit>` after the label, unless the symbol is a unit, has none, or lives outside the repository's files. */
function whereOf(kind: string, owner: string | undefined, symbol: string): string {
  return kind === 'var' || kind === 'remote' || !owner || owner === symbol
    ? ''
    : ` in ${code(unitName(owner))}`;
}

/** `from <unit>` when the declaration described is in another unit than the symbol's own. */
function declaredElsewhere(decl: Declaration | undefined, owner: string | undefined): string | undefined {
  return decl && decl.kind !== 'unit' && owner && decl.unit !== owner
    ? `from ${code(unitName(decl.unit))}`
    : undefined;
}

/** What a binding passes: its expression as written, or its value. */
function passedValue(binding: Binding | undefined): string | undefined {
  return binding ? (binding.site ? binding.site.text : json(binding.value)) : undefined;
}

/**
 * A caller's `with:`/`secrets:` key: what this call passes, then where the value goes in the callee. Other callers'
 * values are not this call's business; they are counted.
 */
function bindingLines(locator: SymbolLocator, at: Occurrence, facts: Facts): string[] {
  const index = locator.index;
  const passed = passedValue(bindingAt(index, at.loc));
  const others = locator.occurrences(at.symbol).filter((o) => o.role === 'binding').length - 1;
  const out: string[] = [];
  const call = [
    passed !== undefined ? `this call passes ${passed === '' ? 'an empty value' : code(passed)}` : undefined,
    others > 0 ? plural(others, 'other caller') : undefined,
  ].filter(Boolean);
  if (call.length) out.push('', call.join(' · '));
  if (facts.description) out.push('', facts.description);
  const to = flowLine(trace(index, at.symbol, { direction: 'down', maxDepth: 2 }));
  if (to) out.push('', '---', '', `**To** ${to}`);
  return out;
}

/** Where a traced value comes from and goes, below a rule; nothing when it flows nowhere known. */
function flowLines(index: ProjectIndex, symbol: string, kind: string): string[] {
  // A matrix key's sources are its values, already listed above.
  const from = kind === 'matrix' ? '' : flowLine(trace(index, symbol, { direction: 'up', maxDepth: 2 }));
  const to = flowLine(trace(index, symbol, { direction: 'down', maxDepth: 2 }));
  if (!from && !to) return [];
  const out = ['', '---', ''];
  if (from) out.push(`**From** ${from}${to ? '  ' : ''}`);
  if (to) out.push(`**To** ${to}`);
  return out;
}

/** Any other occurrence: the description, how many places declare the symbol, and its data flow. */
function symbolLines(
  index: ProjectIndex,
  symbol: string,
  kind: string,
  facts: Facts,
  declared: number,
): string[] {
  const out: string[] = [];
  if (facts.description) out.push('', facts.description);
  if (declared > 1) out.push('', `Declared in ${declared} places.`);
  if (TRACED.has(kind)) out.push(...flowLines(index, symbol, kind));
  return out;
}

/** Markdown for hovering a symbol: who says so, what it is, and where its value comes from and goes. */
export function hoverMarkdown(locator: SymbolLocator, at: Occurrence): string {
  const index = locator.index;
  const node = index.nodes.get(at.symbol);
  const kind = kindOf(at.symbol, node);
  const decls = locator.declarations(at.symbol);
  // On a declaration, describe that one (an input can be declared for workflow_call and workflow_dispatch).
  const decl = decls.find((d) => sameStart(d.loc, at.loc)) ?? decls[0];
  const label = labelOf(at.symbol, kind, node);

  const out = [`**flowpact** · ${KIND[kind] ?? 'reference'} · [docs](${DOCS})`, ''];
  const facts = decl ? describe(locator, decl) : undeclared(index, kind, at.symbol, node);
  const owner = ownerOf(node, decl);
  const from = declaredElsewhere(decl, owner);
  if (from) facts.line = [from, facts.line].filter(Boolean).join(' · ');
  out.push(`${code(label)}${whereOf(kind, owner, at.symbol)}${facts.line ? ` · ${facts.line}` : ''}`);
  out.push(
    ...(at.role === 'binding'
      ? bindingLines(locator, at, facts)
      : symbolLines(index, at.symbol, kind, facts, decls.length)),
  );
  return out.join('\n');
}

interface Facts {
  /** Short facts joined on the identity line. */
  line: string;
  description?: string;
}

const joinFacts = (parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');

/** Facts with the declaration's description, when it has one. */
const withDescription = (line: string, description: string | undefined): Facts => ({
  line,
  ...(description ? { description: text(description) } : {}),
});

type DeclOf<K extends Declaration['kind']> = Extract<Declaration, { kind: K }>;

function inputFacts(i: DeclOf<'input'>['decl']): Facts {
  const value = i.hasDefault ? json(i.default) : undefined;
  return withDescription(
    joinFacts([
      i.type ? code(i.type) : undefined,
      i.required ? 'required' : 'optional',
      value === undefined ? undefined : value === '' ? 'default empty' : `default ${code(value)}`,
      i.options?.length ? `one of ${list(i.options.map(code))}` : undefined,
    ]),
    i.description,
  );
}

function secretFacts(secret: DeclOf<'secret'>['decl']): Facts {
  return withDescription(secret.required ? 'required' : 'optional', secret.description);
}

function outputFacts(output: DeclOf<'output'>['decl']): Facts {
  return withDescription(
    output.value !== undefined ? `value ${code(json(output.value))}` : '',
    output.description,
  );
}

function jobFacts(j: DeclOf<'job'>['decl']): Facts {
  const combos = j.matrix ? expandMatrix(j.matrix).combos.length : 0;
  return {
    line: joinFacts([
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

/** A matrix key's values across the combinations: each value, `an expression`, or `unset`. */
function matrixFacts(d: DeclOf<'matrix'>): Facts {
  const exp = expandMatrix(d.job.matrix);
  if (exp.dynamic) return { line: 'computed at runtime' };
  const values = new Set<string>();
  for (const combo of exp.combos) {
    const cell = lookup(combo.values, d.key);
    values.add(cell ? (cell.known ? code(json(cell.value as Json)) : 'an expression') : 'unset');
  }
  return { line: `values ${list([...values])}` };
}

function stepFacts(step: DeclOf<'step'>['decl']): Facts {
  return {
    line: step.uses ? `outputs of ${code(step.uses.raw)}, not declared` : 'written by the step’s script',
  };
}

/** A workflow: its name, triggers and callers; an action: its name and the steps that use it. */
function unitFacts(locator: SymbolLocator, u: DeclOf<'unit'>['decl']): Facts {
  if (u.kind === 'workflow') {
    const callers = locator.index.callersOf(u.path).length;
    return {
      line: joinFacts([
        u.name ? `name ${code(u.name)}` : undefined,
        u.triggers.length ? `on ${list(u.triggers.map(code))}` : undefined,
        u.call ? `called by ${plural(callers, 'job')}` : undefined,
      ]),
    };
  }
  return {
    line: joinFacts([
      u.name ? `name ${code(u.name)}` : undefined,
      `used by ${plural(locator.index.usersOf(u.path).length, 'step')}`,
    ]),
  };
}

function describe(locator: SymbolLocator, d: Declaration): Facts {
  switch (d.kind) {
    case 'input':
      return inputFacts(d.decl);
    case 'secret':
      return secretFacts(d.decl);
    case 'output':
      return outputFacts(d.decl);
    case 'job':
      return jobFacts(d.decl);
    case 'env':
      return { line: `value ${code(json(d.decl.value))}` };
    case 'matrix':
      return matrixFacts(d);
    case 'step':
      return stepFacts(d.decl);
    case 'unit':
      return unitFacts(locator, d.decl);
  }
}

/** A secret nothing declares: GitHub's token, one a reusable workflow does not declare, or a repository secret. */
function undeclaredSecret(index: ProjectIndex, symbol: string, node: GraphNode | undefined): Facts {
  if (/#secrets\.github_token$/i.test(symbol)) return { line: 'provided by GitHub in every run' };
  const unit = node?.unit ? index.unit(node.unit) : undefined;
  return unit?.kind === 'workflow' && unit.call
    ? { line: `not declared under ${code('on.workflow_call.secrets')}` }
    : { line: 'a repository, environment or organization secret' };
}

function undeclared(index: ProjectIndex, kind: string, symbol: string, node: GraphNode | undefined): Facts {
  switch (kind) {
    case 'var':
      return { line: 'set in the repository, environment or organization settings' };
    case 'remote':
      return { line: 'in another repository; its interface is not verified' };
    case 'step-output':
      return { line: 'not declared, so not verified' };
    case 'secret':
      return undeclaredSecret(index, symbol, node);
    default:
      return { line: 'not declared in any file flowpact analyzes' };
  }
}

/**
 * Trace leaves whose text is the value itself (a literal, a matrix value, the context it is read from, an expression),
 * shown next to the role. The others (`omitted`, `missing`, a use downstream) say enough with the role and the place.
 */
const SHOWN_VALUES = new Set(['literal', 'value', 'context', 'expression', 'invalid']);

/**
 * A source or destination symbol, with the note that qualifies how the value gets there, in parentheses: `when
 * dispatched`, `the default of inputs.<name>`, `exposed to the caller`, or the job of a `secrets: inherit`.
 */
const flowSymbol = (child: TraceNode) =>
  `${code(short(child.symbol))}${child.via?.note ? ` (${text(child.via.note)})` : ''}`;

/** The direct sources or destinations of a value on one line: `a` · `b` · `c` +2. */
function flowLine(root: TraceNode): string {
  const entries: string[] = [];
  for (const child of root.children) entries.push(flowSymbol(child));
  for (const leaf of root.leaves) {
    const value = SHOWN_VALUES.has(leaf.role) ? ` ${code(leaf.text)}` : '';
    entries.push(`${leaf.role}${value} in ${code(short(leaf.where))}`);
  }
  const unique = [...new Set(entries)];
  if (unique.length === 0) return '';
  const more = unique.length > MAX_FLOW ? ` +${unique.length - MAX_FLOW} more` : '';
  return `${unique.slice(0, MAX_FLOW).join(' · ')}${more}`;
}
