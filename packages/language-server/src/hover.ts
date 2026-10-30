import {
  type Binding,
  type Declaration,
  type ExprSegment,
  type ExprSite,
  expandMatrix,
  type GraphNode,
  type Json,
  type Loc,
  lookup,
  type Occurrence,
  type ProjectIndex,
  parseRemoteRef,
  type SymbolLocator,
  type TraceNode,
  trace,
  type UnitDecl,
} from '@ciatlas/core';
import {
  commitOf,
  DOCS_BASE_URL,
  describeKind,
  type ExprPosition,
  interpolated,
  lockedRemote,
  positionOf,
  type RemoteEntry,
  type RemotesLockRead,
  rootOperator,
  skipGuard,
  kindOf as valueKindOf,
} from '@flowpact/lint';
import type { RemoteBinding } from './remotes';
import { type CachedUnit, declarationIn, type RemoteSources, sourceLink } from './sources';

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
  step: 'step',
  var: 'configuration variable',
  remote: 'remote reference',
  workflow: 'workflow',
  action: 'action',
  symbol: 'reference',
};

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Inline code, on one line and cut to size; YAML text may hold backticks and newlines. */
export const code = (s: string) =>
  `\`${cut(s.replace(/`/g, "'").replace(/\s+/g, ' ').trim(), MAX_CODE) || ' '}\``;

/** Free text from a repository (descriptions) shown as text, not markdown. */
export const text = (s: string) =>
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
  [/^(jobs\.[^.]+\.)?(steps\[\d+\]\.)?env\./, 'env'],
  [/(^|\.)steps\.[^.]+$/, 'step'],
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

/** What this call passes, and how many other callers pass the same key. */
function callLines(binding: Binding | undefined, others: number): string[] {
  const passed = passedValue(binding);
  const call = [
    passed !== undefined ? `this call passes ${passed === '' ? 'an empty value' : code(passed)}` : undefined,
    others > 0 ? plural(others, 'other caller') : undefined,
  ].filter(Boolean);
  return call.length ? ['', call.join(' · ')] : [];
}

/**
 * A caller's `with:`/`secrets:` key: what this call passes, then where the value goes in the callee. Other callers'
 * values are not this call's business; they are counted.
 */
function bindingLines(locator: SymbolLocator, at: Occurrence, facts: Facts): string[] {
  const index = locator.index;
  const others = locator.occurrences(at.symbol).filter((o) => o.role === 'binding').length - 1;
  const out = callLines(bindingAt(index, at.loc), others);
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

/** What a hover knows of remote references: the lockfile, the sources cache, and the host to link sources on. */
export interface RemoteContext {
  lock?: RemotesLockRead;
  sources?: RemoteSources;
  /** The repository's own host (its `origin`), where the remote references without a `host` were read. */
  webHost?: string | undefined;
}

/** Markdown for hovering a symbol: who says so, what it is, and where its value comes from and goes. */
export function hoverMarkdown(locator: SymbolLocator, at: Occurrence, remote: RemoteContext = {}): string {
  const index = locator.index;
  const node = index.nodes.get(at.symbol);
  const kind = kindOf(at.symbol, node);
  const decls = locator.declarations(at.symbol);
  // On a declaration, describe that one (an input can be declared for workflow_call and workflow_dispatch).
  const decl = decls.find((d) => sameStart(d.loc, at.loc)) ?? decls[0];
  const label = labelOf(at.symbol, kind, node);

  const out = [`**flowpact** · ${KIND[kind] ?? 'reference'} · [docs](${DOCS})`, ''];
  const facts = decl
    ? describe(locator, decl, at.symbol)
    : kind === 'remote'
      ? remoteFacts(remote, label)
      : undeclared(index, kind, at.symbol, node);
  const owner = ownerOf(node, decl);
  const from = declaredElsewhere(decl, owner);
  if (from) facts.line = [from, facts.line].filter(Boolean).join(' · ');
  out.push(`${code(label)}${whereOf(kind, owner, at.symbol)}${facts.line ? ` · ${facts.line}` : ''}`);
  if (kind === 'step-output') out.push(...skippedLines(index, at.symbol));
  out.push(
    ...(at.role === 'binding'
      ? bindingLines(locator, at, facts)
      : symbolLines(index, at.symbol, kind, facts, decls.length)),
  );
  return out.join('\n');
}

/** The step a step output symbol belongs to: `<unit>#jobs.<job>.steps.<id>.outputs.<name>`, or an action's. */
function stepOfOutput(index: ProjectIndex, symbol: string) {
  const m = /^(.*)#(?:jobs\.([^.]+)\.)?steps\.([^.]+)\.outputs\./.exec(symbol);
  const unit = m ? index.unit(m[1]!) : undefined;
  if (!unit) return undefined;
  const steps = unit.kind === 'workflow' ? (m![2] ? unit.jobs[m![2]]?.steps : undefined) : unit.steps;
  return steps?.find((s) => s.id === m![3]);
}

/** When a step output may be '': its step has an `if:` that can skip it. */
function skippedLines(index: ProjectIndex, symbol: string): string[] {
  const step = stepOfOutput(index, symbol);
  const guard = step && skipGuard(step);
  if (guard === undefined) return [];
  return [
    '',
    guard
      ? `may be '' · the step runs only ${code(`if: ${guard.text}`)}`
      : `always '' · the step never runs (${code('if: false')})`,
  ];
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

/** A step, by its id: what it runs, and what its outcome and conclusion are. */
function stepIdFacts(step: DeclOf<'step'>['decl']): Facts {
  return {
    line: joinFacts([
      step.name ? `name ${code(step.name)}` : undefined,
      step.uses ? `uses ${code(step.uses.raw)}` : 'runs a script',
    ]),
    description: `${code('outcome')} is its result before ${code('continue-on-error')} applies, ${code('conclusion')} after.`,
  };
}

/**
 * A step by its id, or an output of a step: of its remote action, as the lockfile records it, or written by the step's
 * script.
 */
function stepFacts(index: ProjectIndex, step: DeclOf<'step'>['decl'], symbol: string): Facts {
  if (!symbol.includes('.outputs.')) return stepIdFacts(step);
  const action = step.uses?.kind === 'remote-action' ? index.actionInterfaceOf(step) : undefined;
  const name = symbol.slice(symbol.lastIndexOf('.outputs.') + '.outputs.'.length);
  if (action && lookup(action.outputs, name)) return { line: `declared by ${code(step.uses!.raw)}` };
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

function describe(locator: SymbolLocator, d: Declaration, symbol: string): Facts {
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
      return stepFacts(locator.index, d.decl, symbol);
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
    case 'job-output':
      return remoteCallOutput(index, symbol) ?? { line: 'not declared in any file flowpact analyzes' };
    case 'step-output':
      return { line: 'not declared, so not verified' };
    case 'secret':
      return undeclaredSecret(index, symbol, node);
    default:
      return { line: 'not declared in any file flowpact analyzes' };
  }
}

/** An output of a job that calls a remote workflow the lockfile has: declared by it, or not. */
function remoteCallOutput(index: ProjectIndex, symbol: string): Facts | undefined {
  const m = /^(.*)#jobs\.([^.]+)\.outputs\.(.+)$/.exec(symbol);
  const unit = m ? index.unit(m[1]!) : undefined;
  const job = unit?.kind === 'workflow' ? lookup(unit.jobs, m![2]!) : undefined;
  const callee = job?.uses?.kind === 'remote-workflow' ? index.interfaceOf(job) : undefined;
  if (!callee?.call) return undefined;
  const ref = code(job!.uses!.raw);
  return { line: lookup(callee.call.outputs, m![3]!) ? `declared by ${ref}` : `not declared by ${ref}` };
}

/** The lockfile's name, for hovers. */
const lockName = (remotes: RemotesLockRead | undefined) =>
  code((remotes?.file ?? 'remotes.lock.yaml').replace(/^.*\//, ''));

/**
 * A remote reference's interface as the lockfile records it, one line per part; then the secrets a reusable workflow
 * reads without declaring them, which only `secrets: inherit` passes.
 */
function interfaceLines(e: RemoteEntry): string {
  const named = (m: Record<string, { required?: boolean }> | undefined) =>
    Object.entries(m ?? {}).map(([n, d]) => `${code(n)}${d.required ? ' (required)' : ''}`);
  const parts = (
    [
      ['Inputs', named(e.inputs)],
      ['Secrets', named(e.secrets)],
      ['Outputs', (e.outputs ?? []).map(code)],
    ] as const
  )
    .filter(([, items]) => items.length)
    .map(([what, items]) => `**${what}** ${list(items)}`);
  const declared = parts.length ? parts.join('  \n') : 'Declares no inputs, secrets or outputs.';
  const undeclared = e.undeclaredSecrets ?? [];
  return undeclared.length
    ? `${declared}  \n**Reads without declaring** ${list(undeclared.map(code))}, passed only by ${code('secrets: inherit')}`
    : declared;
}

/**
 * A remote reference: what the lockfile records for it (with its source's name, and where its source is), or why its
 * interface is not verified.
 */
function remoteFacts(remote: RemoteContext, ref: string): Facts {
  const { entry, unreadable } = lockedRemote(remote.lock?.lock, ref);
  if (entry) return lockedFacts(remote, ref, entry);
  const lock = lockName(remote.lock);
  const line = 'in another repository; its interface is not verified';
  if (unreadable !== undefined)
    return { line, description: `${lock} records it as not readable: ${text(unreadable)}` };
  if (remote.lock?.error) return { line, description: `${lock} cannot be used.` };
  return { line, description: `${code('flowpact remotes update')} records it in ${lock}.` };
}

/**
 * A remote reference the lockfile has: the commit it runs, its source's name, its interface, and where its source is.
 * A `uses:` pinned to a full SHA runs that commit, whatever the lockfile says; a different one there is called out.
 */
function lockedFacts(remote: RemoteContext, ref: string, entry: RemoteEntry): Facts {
  const r = parseRemoteRef(ref, entry.kind);
  const sha = r ? commitOf(r, entry) : entry.sha;
  const where = `at ${code(sha.slice(0, 7))}${entry.host ? ` on ${text(entry.host)}` : ''}`;
  const kind = entry.kind === 'workflow' ? 'reusable workflow' : 'action';
  const cached = remote.sources?.of(remote.lock?.lock, ref);
  const name = cached?.unit.name;
  const mismatch =
    sha !== entry.sha
      ? `${lockName(remote.lock)} records commit ${code(entry.sha.slice(0, 7))} for it, not the one it pins: ${code('flowpact remotes update')} corrects it.`
      : undefined;
  const parts = [
    mismatch,
    interfaceLines(entry),
    sourceLine(ref, entry, cached !== undefined, remote.webHost),
  ];
  return {
    line: joinFacts([
      name ? `name ${code(name)}` : undefined,
      `${kind} ${where}, recorded in ${lockName(remote.lock)}`,
    ]),
    description: parts.filter(Boolean).join('\n\n'),
  };
}

/**
 * Where a remote reference's source is: in the cache, where Go to Definition opens it, else on its host (a link, when
 * the host is certain), with how to cache it (on github.com, from an enterprise server, with `--github-com`).
 */
function sourceLine(ref: string, entry: RemoteEntry, cached: boolean, webHost: string | undefined): string {
  if (cached) return 'Go to Definition opens its source.';
  const command = entry.host ? 'flowpact remotes download --github-com' : 'flowpact remotes download';
  const download = `${code(command)} caches it for Go to Definition.`;
  const link = sourceLink(ref, entry, webHost);
  return link ? `[Source](${link}) · ${download}` : `Its source is not cached: ${download}`;
}

/**
 * A `with:` or `secrets:` key of a remote call: the input or secret the lockfile records, its description in the cached
 * source, and what this call passes.
 */
export function remoteBindingMarkdown(b: RemoteBinding, callers: number, cached?: CachedUnit): string {
  const facts = b.decl.kind === 'input' ? inputFacts(b.decl.decl) : secretFacts(b.decl.decl);
  const label = code(`${b.decl.kind}s.${b.decl.decl.name}`);
  const description = cached && declarationIn(cached.unit, `${b.decl.kind}s`, b.decl.decl.name)?.description;
  return [
    `**flowpact** · ${b.decl.kind} · [docs](${DOCS})`,
    '',
    `${label} in ${code(b.ref)}${facts.line ? ` · ${facts.line}` : ''}`,
    ...callLines(b.binding, callers - 1),
    ...(description ? ['', text(description)] : []),
  ].join('\n');
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

/** An expression of a site, at a position of a file, and where it is written with its `${{ }}`. */
export interface ExpressionAt {
  unit: UnitDecl;
  site: ExprSite;
  seg: ExprSegment;
  loc: Loc;
}

const contains = (loc: Loc, line: number, column: number) =>
  (loc.line < line || (loc.line === line && loc.column <= column)) &&
  (loc.endLine > line || (loc.endLine === line && loc.endColumn >= column));

/**
 * Where a segment is written with its `${{ }}`: its location holds the expression only, without the delimiters or the
 * spaces inside them. A bare `if:` has none.
 */
function delimited(unit: UnitDecl, seg: ExprSegment): Loc {
  const { loc } = seg;
  const first = unit.source.lines[loc.line - 1] ?? '';
  const last = unit.source.lines[loc.endLine - 1] ?? '';
  const open = first.lastIndexOf('${{', loc.column - 1);
  const close = last.indexOf('}}', loc.endColumn - 1);
  const spaced = (text: string) => /^\s*$/.test(text);
  if (open < 0 || close < 0) return loc;
  if (!spaced(first.slice(open + 3, loc.column - 1)) || !spaced(last.slice(loc.endColumn - 1, close)))
    return loc;
  return { ...loc, column: open + 1, endColumn: close + 3 };
}

/** The expression written at a position (1-based) of a file: inside a `${{ }}`, or a bare `if:`. */
export function expressionAt(index: ProjectIndex, file: string, line: number, column: number) {
  for (const unit of index.units()) {
    if (unit.file !== file) continue;
    for (const site of unit.sites)
      for (const seg of site.segments) {
        const loc = delimited(unit, seg);
        if (seg.expr.ast && contains(loc, line, column)) return { unit, site, seg, loc } as ExpressionAt;
      }
  }
  return undefined;
}

/** What GitHub does with an expression in each position, for its hover. */
const POSITIONS: Record<ExprPosition, string> = {
  condition: "condition: '', 0, false and null are false, any other value true",
  template: 'an `if:` with text around its `${{ }}`: a string, which is always true',
  boolean: "takes true or false, not text (`fromJSON()` turns 'true' into true)",
  number: 'takes a number',
  script: 'written into the script as text',
  value: "a value, passed on as text: true becomes 'true'",
};

/** How a value field is named in its hover: `env.NAME`, `outputs.name`, `with.name`, or its key. */
function fieldName(site: ExprSite): string {
  const last = site.yamlPath.at(-1);
  if (!site.key) return code(typeof last === 'string' ? last : site.field);
  const ctx = site.field.endsWith('.env')
    ? 'env'
    : site.field.endsWith('.output')
      ? 'outputs'
      : site.field.split('.')[1];
  return code(`${ctx}.${site.key}`);
}

/** A note on `||` and `&&` outside a condition: they give an operand as it is. */
function operatorNote(e: ExpressionAt, position: ExprPosition): string | undefined {
  const op = position === 'condition' ? undefined : rootOperator(e.seg.expr.ast!);
  if (op === '||') return '`||` gives the first operand that is true as it is, not true or false';
  if (op === '&&') return '`&&` gives the first operand that is false as it is, not true or false';
  return undefined;
}

/**
 * Markdown for hovering an expression where no symbol is: how GitHub reads it there (a condition, a value passed on as
 * text, a field of a type), what it yields, and what `||` or `&&` gives outside a condition. A value is shown as it is
 * passed on, so `a == 'b'` under `env:` yields 'true' or 'false'.
 */
export function expressionMarkdown(index: ProjectIndex, e: ExpressionAt): string {
  const position = positionOf(e.site);
  const kind = valueKindOf(index, e.unit, e.site, e.seg, e.seg.expr.ast!);
  const passedOn = position === 'value' || position === 'script' || position === 'template';
  const where =
    position === 'value'
      ? `${fieldName(e.site)} is `
      : position === 'boolean' || position === 'number'
        ? `${fieldName(e.site)} `
        : '';
  const note = operatorNote(e, position);
  return [
    `**flowpact** · expression · [docs](${DOCS})`,
    '',
    `${where}${POSITIONS[position]}  `,
    `yields ${describeKind(passedOn ? interpolated(kind) : kind)}${note ? '  ' : ''}`,
    ...(note ? [note] : []),
  ].join('\n');
}
