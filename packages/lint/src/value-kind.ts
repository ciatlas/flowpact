/**
 * What an expression can yield, as classes of values: a boolean, the text 'true' or 'false', other text, '' and why it
 * may be '', a number, an object, or a value known only at run time. Under `env:`, `with:` and `outputs:` a value is
 * passed on as text (`true` becomes 'true'), and only an `if:` reads it as true or false; `||` and `&&` give one of
 * their operands as it is. So `a == 'b' || inputs.file` yields `true`, `false` or a file name.
 *
 * References are followed to where their value is set: an input by its declared type, `env` through the step's, the
 * job's and the workflow's `env:`, step, job and workflow outputs through their values, across reusable workflow calls
 * and local actions. What flowpact cannot see (a script's outputs, `github.event`, the matrix) is `unknown`, which never
 * makes a value mixed or ''.
 */
import type { Expr, FunctionCall, Literal, Logical } from '@actions/expressions/ast';
import {
  type Binding,
  type ExprSegment,
  type ExprSite,
  type InputDecl,
  type Json,
  type Loc,
  type LocatedRef,
  lookup,
  type ProjectIndex,
  type StepDecl,
  type UnitDecl,
} from '@ciatlas/core';
import { exprSpan, nodeOf } from './expr-ast';
import { declaredInputs, emptyWhenOmitted } from './rules/inputs';
import {
  guardOf,
  isProperty,
  isWholeExpression,
  maybeWrittenEarlier,
  namesKey,
  stepsInScope,
} from './rules/util';

/**
 * A class of values: `true`/`false` booleans; `text-true`/`text-false` the strings 'true' and 'false'; `text` any other
 * string but ''; `empty` '' or null; `json` an object or array.
 */
export type ValueClass =
  | 'true'
  | 'false'
  | 'empty'
  | 'text-true'
  | 'text-false'
  | 'text'
  | 'number'
  | 'json'
  | 'unknown';

/** Why a value may be '' that flowpact can point at: an optional input omitted, or a step its `if:` skipped. */
export interface EmptyReason {
  kind: 'optional-input' | 'guarded-step';
  /** The input's declaration, or the step's `if:` (the step for `if: false`). */
  loc: Loc;
  /** `inputs.<name>` or `steps.<id>`. */
  label: string;
  /**
   * The symbols the '' passes through, from the input or step output on, and for a step those its `if:` reads; with
   * `keys`, the `github` properties that `if:` reads (`github.event_name`). A guard that reads one of them decides it.
   */
  symbols: string[];
  keys: string[];
}

export interface Possible {
  cls: ValueClass;
  /** For `empty`: why it may be '', when flowpact can point at it. */
  why?: EmptyReason;
  /** For `text`: the reference whose value it is (`inputs.file`), when there is one. */
  from?: string;
}

/** The values an expression can yield (each class once per reason or reference). */
export type ValueKind = Possible[];

const BOOLEAN: ValueKind = [{ cls: 'true' }, { cls: 'false' }];
const UNKNOWN: ValueKind = [{ cls: 'unknown' }];
/** How many values a reference is followed through. */
const MAX_DEPTH = 8;

const ALWAYS_TRUE = new Set<ValueClass>(['true', 'text-true', 'text-false', 'text', 'json']);
const ALWAYS_FALSE = new Set<ValueClass>(['false', 'empty']);

/** The values of a kind that are true in a condition: `||` gives those of each operand but its last. */
export const whenTruthy = (kind: ValueKind) => kind.filter((p) => !ALWAYS_FALSE.has(p.cls));
/** The values of a kind that are false in a condition: `&&` gives those of each operand but its last. */
const whenFalsy = (kind: ValueKind) => kind.filter((p) => !ALWAYS_TRUE.has(p.cls));

/** A boolean, or the text 'true' or 'false'. */
export const isBooleanClass = (cls: ValueClass) =>
  cls === 'true' || cls === 'false' || cls === 'text-true' || cls === 'text-false';

/** Whether a value can be a boolean (or 'true'/'false') and other text: read as a boolean, the text is wrong. */
export const isMixed = (kind: ValueKind) =>
  kind.some((p) => isBooleanClass(p.cls)) && kind.some((p) => p.cls === 'text');

/** The reasons a value may be '' that flowpact can point at, each once. */
export function emptyReasons(kind: ValueKind): EmptyReason[] {
  const out = new Map<string, EmptyReason>();
  for (const p of kind) if (p.why) out.set(reasonKey(p.why), out.get(reasonKey(p.why)) ?? p.why);
  return [...out.values()];
}

const reasonKey = (r: EmptyReason) => `${r.kind}:${r.loc.file}:${r.loc.line}:${r.loc.column}`;

/** Each class once per reason and reference. */
function unique(kind: ValueKind): ValueKind {
  const out = new Map<string, Possible>();
  for (const p of kind) {
    const key = `${p.cls}|${p.why ? reasonKey(p.why) : ''}|${p.from ?? ''}`;
    if (!out.has(key)) out.set(key, p);
  }
  return [...out.values()];
}

const PASSED_ON: Partial<Record<ValueClass, ValueClass>> = {
  true: 'text-true',
  false: 'text-false',
  number: 'text',
  json: 'unknown',
};

/** A kind as `env:`, `with:` and `outputs:` pass it on: as text (`true` becomes 'true'). */
export const interpolated = (kind: ValueKind): ValueKind =>
  unique(kind.map((p) => (PASSED_ON[p.cls] ? { cls: PASSED_ON[p.cls]! } : p)));

function textKind(text: string): ValueKind {
  const lower = text.toLowerCase();
  if (text === '') return [{ cls: 'empty' }];
  return [{ cls: lower === 'true' ? 'text-true' : lower === 'false' ? 'text-false' : 'text' }];
}

function jsonKind(value: Json): ValueKind {
  if (value === null) return [{ cls: 'empty' }];
  if (typeof value === 'boolean') return [{ cls: value ? 'true' : 'false' }];
  if (typeof value === 'number') return [{ cls: 'number' }];
  if (typeof value === 'string') return textKind(value);
  return [{ cls: 'json' }];
}

/** Where an expression is read, and how many values were followed to get there. */
interface Scope {
  index: ProjectIndex;
  unit: UnitDecl;
  site: ExprSite;
  seg: ExprSegment;
  depth: number;
}

/** What an expression of a segment of `site` can yield (see the module's doc). */
export function kindOf(
  index: ProjectIndex,
  unit: UnitDecl,
  site: ExprSite,
  seg: ExprSegment,
  expr: Expr,
): ValueKind {
  return exprKind({ index, unit, site, seg, depth: 0 }, expr);
}

function exprKind(s: Scope, e: Expr): ValueKind {
  const n = nodeOf(e);
  switch (n.kind) {
    case 'literal':
      return literalKind(n.node);
    case 'unary':
    case 'binary':
      return BOOLEAN;
    case 'grouping':
      return exprKind(s, n.node.group);
    case 'logical':
      return logicalKind(s, n.node);
    case 'call':
      return callKind(s, n.node);
    case 'context':
    case 'index':
      return refKind(s, e);
    default:
      return UNKNOWN;
  }
}

function literalKind(lit: Literal): ValueKind {
  const { lexeme } = lit.token;
  if (lexeme === 'true' || lexeme === 'false') return [{ cls: lexeme }];
  if (lexeme === 'null') return [{ cls: 'empty' }];
  if (lexeme.startsWith("'")) return textKind(lit.literal.coerceString());
  return [{ cls: 'number' }];
}

/** `a || b || c`: what is true of `a` and `b`, and all of `c`; `&&` the same with what is false. */
function logicalKind(s: Scope, l: Logical): ValueKind {
  const or = l.operator.lexeme === '||';
  const kinds = l.args.map((a) => exprKind(s, a));
  const last = kinds.pop() ?? [];
  return unique([...kinds.flatMap((k) => (or ? whenTruthy(k) : whenFalsy(k))), ...last]);
}

const BOOLEAN_FUNCTIONS = new Set([
  'contains',
  'startswith',
  'endswith',
  'success',
  'failure',
  'cancelled',
  'always',
]);
/** Functions that give text, '' included (`format('{0}', '')`, `join([])`, `hashFiles` matching no file). */
const TEXT_FUNCTIONS = new Set(['format', 'join', 'hashfiles']);

function callKind(s: Scope, call: FunctionCall): ValueKind {
  const name = call.functionName.lexeme.toLowerCase();
  if (BOOLEAN_FUNCTIONS.has(name)) return BOOLEAN;
  if (name === 'tojson') return [{ cls: 'text' }];
  if (TEXT_FUNCTIONS.has(name)) return [{ cls: 'text' }, { cls: 'empty' }];
  if (name === 'fromjson') return call.args[0] ? fromJsonKind(s, call.args[0]) : UNKNOWN;
  // `case(p1, v1, …, default)` gives one of its values.
  if (name === 'case')
    return unique(
      call.args.filter((_, i) => i % 2 === 1 || i === call.args.length - 1).flatMap((a) => exprKind(s, a)),
    );
  return UNKNOWN;
}

/** What `fromJSON()` parses: a literal's JSON, 'true' and 'false' as booleans; '' fails, and other text is unknown. */
function fromJsonKind(s: Scope, arg: Expr): ValueKind {
  const n = nodeOf(arg);
  if (n.kind === 'literal' && n.node.token.lexeme.startsWith("'")) {
    try {
      return jsonKind(JSON.parse(n.node.literal.coerceString()) as Json);
    } catch {
      return [];
    }
  }
  return unique(exprKind(s, arg).flatMap(parsedAs));
}

function parsedAs(p: Possible): ValueKind {
  switch (p.cls) {
    case 'true':
    case 'text-true':
      return [{ cls: 'true' }];
    case 'false':
    case 'text-false':
      return [{ cls: 'false' }];
    case 'number':
      return [{ cls: 'number' }];
    case 'empty':
      return [];
    default:
      return UNKNOWN;
  }
}

/** The reference an expression of a segment is: one that starts where it does. */
export function refAt(seg: ExprSegment, e: Expr): LocatedRef | undefined {
  const k = nodeOf(e).kind;
  if (k !== 'context' && k !== 'index') return undefined;
  const { start } = exprSpan(seg.expr.source, e);
  return seg.refs.find((r) => r.start === start);
}

/** How a reference is written, for messages: `inputs.file`. */
export const refLabel = (ref: { context: string; path: string[] }) => [ref.context, ...ref.path].join('.');

/** How each context's references are read (see `refKind`); any other context is unknown. */
const REF_KINDS: Record<string, (s: Scope, ref: LocatedRef) => ValueKind> = {
  inputs: (s, ref) => inputKind(s, ref, false),
  github: (s, ref) => inputKind(s, ref, true),
  env: (s, ref) => envKind(s, ref),
  steps: (s, ref) => stepOutputKind(s, ref),
  needs: (s, ref) => outputKind(s, ref),
  jobs: (s, ref) => outputKind(s, ref),
  vars: (_, ref) => [{ cls: 'text', from: refLabel(ref) }, { cls: 'empty' }],
  secrets: (_, ref) => [{ cls: 'text', from: refLabel(ref) }, { cls: 'empty' }],
};

function refKind(s: Scope, e: Expr): ValueKind {
  const ref = refAt(s.seg, e);
  const read = ref && Object.hasOwn(REF_KINDS, ref.context) ? REF_KINDS[ref.context] : undefined;
  return ref && read ? read(s, ref) : UNKNOWN;
}

/** `inputs.<name>`, or `github.event.inputs.<name>` (`viaEvent`) of a dispatch input, which is always text. */
function inputKind(s: Scope, ref: LocatedRef, viaEvent: boolean): ValueKind {
  const symbol = s.index.resolveRef(s.unit, s.site, ref);
  const input =
    symbol && ref.path.length === (viaEvent ? 3 : 1) ? inputRead(s.unit, ref, viaEvent) : undefined;
  if (!symbol || !input) return UNKNOWN;
  const from = refLabel(ref);
  const kind = typedKind(s.unit, input, viaEvent).map((p) => (p.cls === 'text' ? { ...p, from } : p));
  return emptyWhenOmitted(input) ? [...kind, { cls: 'empty', why: omitted(input, symbol) }] : kind;
}

/** The input a reference reads: `github.event.inputs` holds a workflow's dispatch inputs only. */
function inputRead(unit: UnitDecl, ref: LocatedRef, viaEvent: boolean): InputDecl | undefined {
  const declared =
    viaEvent && unit.kind === 'workflow' ? (unit.dispatch?.inputs ?? {}) : declaredInputs(unit);
  return lookup(declared, ref.path.at(-1)!);
}

const omitted = (input: InputDecl, symbol: string): EmptyReason => ({
  kind: 'optional-input',
  loc: input.loc,
  label: `inputs.${input.name}`,
  symbols: [symbol],
  keys: [],
});

/** An input's values by its type: a workflow's booleans and numbers keep theirs in `inputs`; the rest is text. */
function typedKind(unit: UnitDecl, input: InputDecl, viaEvent: boolean): ValueKind {
  const typed = unit.kind === 'workflow' ? input.type : undefined;
  if (typed === 'boolean') return viaEvent ? [{ cls: 'text-true' }, { cls: 'text-false' }] : BOOLEAN;
  if (typed === 'number') return [{ cls: viaEvent ? 'text' : 'number' }];
  return optionsKind(input.options ?? []) ?? [{ cls: 'text' }];
}

/** The texts 'true' and 'false', for a choice of them only. */
function optionsKind(options: string[]): ValueKind | undefined {
  const lower = options.map((o) => o.toLowerCase());
  const booleans = lower.length > 0 && lower.every((o) => o === 'true' || o === 'false');
  return booleans ? unique(lower.flatMap(textKind)) : undefined;
}

/**
 * `env.<name>`: the step's own `env:` (whose values read the outer env), else the job's or the workflow's, unless an
 * earlier step may have written it to `$GITHUB_ENV`.
 */
function envKind(s: Scope, ref: LocatedRef): ValueKind {
  const name = ref.path[0];
  if (!namesKey(name) || ref.path.length !== 1) return UNKNOWN;
  const own = ownEnv(s.index, s.unit, s.site, name);
  if (own) return bindingKind(s, own);
  const symbol = s.index.resolveRef(s.unit, s.site, ref);
  const steps = s.site.step === undefined ? undefined : stepsInScope(s.unit, s.site.job);
  if (!symbol || maybeWrittenEarlier(steps, s.site, name)) return UNKNOWN;
  return symbolKind(s, symbol);
}

/** The step's own `env:` entry a site reads (not from the step's `env:` itself, which reads the outer env). */
function ownEnv(index: ProjectIndex, unit: UnitDecl, site: ExprSite, name: string): Binding | undefined {
  const step = site.field === 'step.env' ? undefined : index.stepOf(unit, site);
  return step && lookup(step.env, name);
}

function bindingKind(s: Scope, b: Binding): ValueKind {
  return b.site ? siteKind(s, s.unit, b.site) : interpolated(jsonKind(b.value));
}

/** `needs.<job>.outputs.<name>`, or `jobs.<job>.outputs.<name>` in a workflow output. */
function outputKind(s: Scope, ref: LocatedRef): ValueKind {
  const symbol = s.index.resolveRef(s.unit, s.site, ref);
  return symbol && ref.path.length === 3 ? symbolKind(s, symbol) : UNKNOWN;
}

/** `steps.<id>.outputs.<name>`: a local action's output, else unknown; '' too when the step has an `if:`. */
function stepOutputKind(s: Scope, ref: LocatedRef): ValueKind {
  const [id, outputs] = ref.path;
  const symbol = s.index.resolveRef(s.unit, s.site, ref);
  if (!symbol || !namesKey(id) || !isProperty(outputs, 'outputs') || ref.path.length !== 3) return UNKNOWN;
  const kind = symbolKind(s, symbol);
  const step = stepsInScope(s.unit, s.site.job).find((x) => x.id?.toLowerCase() === id.toLowerCase());
  const why = step && skippedStep(s.index, s.unit, step, symbol);
  return why ? unique([...kind, { cls: 'empty', why }]) : kind;
}

/**
 * The `if:` that can skip a step, whose outputs are then '': its condition, or `false` for `if: false`. None for an
 * `if:` that reads no context, such as `success()` or `always()`: the step then runs whenever the job goes on.
 */
export function skipGuard(step: StepDecl): ExprSite | false | undefined {
  const guard = guardOf(step);
  return guard && !guard.segments.some((g) => g.refs.length > 0) ? undefined : guard;
}

/** Why a step's outputs may be '': its `if:` can skip it (see `skipGuard`). */
function skippedStep(
  index: ProjectIndex,
  unit: UnitDecl,
  step: StepDecl,
  symbol: string,
): EmptyReason | undefined {
  const guard = skipGuard(step);
  if (guard === undefined) return undefined;
  const reads = guard ? guardReads(index, unit, guard) : { symbols: [], keys: [] };
  return {
    kind: 'guarded-step',
    loc: guard ? guard.loc : step.loc,
    label: `steps.${step.id}`,
    symbols: [symbol, ...reads.symbols],
    keys: reads.keys,
  };
}

/** The symbols a condition reads, and the `github` properties it reads, which are no symbols. */
function guardReads(
  index: ProjectIndex,
  unit: UnitDecl,
  site: ExprSite,
): { symbols: string[]; keys: string[] } {
  const refs = site.segments.flatMap((s) => s.refs);
  return {
    symbols: refs.flatMap((r) => index.readsOf(unit, site, r)),
    keys: refs.filter((r) => r.context === 'github').map(githubKey),
  };
}

const githubKey = (ref: { context: string; path: string[] }) => refLabel(ref).toLowerCase();

/** Whether references of `site` read what an empty value comes from (see `EmptyReason.symbols`). */
export function readsReason(
  index: ProjectIndex,
  unit: UnitDecl,
  site: ExprSite,
  refs: LocatedRef[],
  why: EmptyReason,
): boolean {
  return refs.some(
    (r) =>
      (r.context === 'github' && why.keys.includes(githubKey(r))) ||
      index.readsOf(unit, site, r).some((symbol) => why.symbols.includes(symbol)),
  );
}

const memos = new WeakMap<ProjectIndex, Map<string, ValueKind | null>>();

/** A kind computed once per analysis; `null` while it is computed, so a cycle gives unknown. */
function memoised(index: ProjectIndex, key: string, compute: () => ValueKind): ValueKind {
  let memo = memos.get(index);
  if (!memo) {
    memo = new Map();
    memos.set(index, memo);
  }
  const known = memo.get(key);
  if (known !== undefined) return known ?? UNKNOWN;
  memo.set(key, null);
  const kind = compute();
  memo.set(key, kind);
  return kind;
}

/** What a symbol holds: its definitions' values, or those of the output it gets (a callee's, a local action's). */
function symbolKind(s: Scope, symbol: string): ValueKind {
  if (s.depth >= MAX_DEPTH) return UNKNOWN;
  return memoised(s.index, symbol, () => through(symbol, definedKind({ ...s, depth: s.depth + 1 }, symbol)));
}

function definedKind(s: Scope, symbol: string): ValueKind {
  const defs = s.index.definitionsOf(symbol);
  if (defs.length)
    return unique(
      defs.flatMap((d) => ('site' in d ? siteKind(s, d.unit, d.site) : interpolated(jsonKind(d.value)))),
    );
  const outputs = s.index.incoming(symbol, 'flows').filter((e) => e.siteId === undefined);
  return outputs.length ? unique(outputs.flatMap((e) => symbolKind(s, e.from))) : UNKNOWN;
}

/** A kind passed through a symbol: a guard that reads the symbol decides its '' too. */
const through = (symbol: string, kind: ValueKind): ValueKind =>
  kind.map((p) => (p.why ? { ...p, why: { ...p.why, symbols: [...p.why.symbols, symbol] } } : p));

/** What a site under `env:`, `with:` or `outputs:` passes on: its expression's value as text, or a template's text. */
function siteKind(s: Scope, unit: UnitDecl, site: ExprSite): ValueKind {
  if (s.depth >= MAX_DEPTH) return UNKNOWN;
  return memoised(s.index, `site:${site.id}`, () => {
    const seg = site.segments[0];
    if (!seg?.expr.ast || site.segments.some((x) => !x.expr.ast)) return UNKNOWN;
    if (!isWholeExpression(site)) return [{ cls: 'text' }];
    return interpolated(exprKind({ index: s.index, unit, site, seg, depth: s.depth + 1 }, seg.expr.ast));
  });
}

/**
 * How GitHub reads a site's expression: a `condition` decides by truthiness, but an `if:` with text around its `${{ }}`
 * is a `template`, a string that is always true; `boolean` and `number` fields take a value of that type and nothing
 * else; a `script` and every other `value` get the expression as text.
 */
export type ExprPosition = 'condition' | 'template' | 'boolean' | 'number' | 'script' | 'value';

const TYPED_FIELDS: Record<string, ExprPosition> = {
  'continue-on-error': 'boolean',
  'fail-fast': 'boolean',
  'timeout-minutes': 'number',
  'max-parallel': 'number',
};

/** The `||` or `&&` an expression is, through parentheses: they give one of their operands as it is. */
export function rootOperator(e: Expr): '||' | '&&' | undefined {
  const n = nodeOf(e);
  if (n.kind === 'grouping') return rootOperator(n.node.group);
  return n.kind === 'logical' ? (n.node.operator.lexeme as '||' | '&&') : undefined;
}

/** How GitHub reads a site's expression (see `ExprPosition`). */
export function positionOf(site: ExprSite): ExprPosition {
  if (site.isCondition) return isWholeExpression(site) ? 'condition' : 'template';
  const last = site.yamlPath.at(-1);
  const typed =
    typeof last === 'string' && Object.hasOwn(TYPED_FIELDS, last) ? TYPED_FIELDS[last] : undefined;
  return typed ?? (site.field === 'step.run' ? 'script' : 'value');
}

/** Where a value a reference reads is set: the expression or plain value of an env variable or an output. */
export interface Producer {
  unit: UnitDecl;
  site?: ExprSite;
  loc: Loc;
  /** What it sets: `env.NAME`, `jobs.build.outputs.url`, `outputs.url`. */
  label: string;
}

/** Where the value of a reference is set: an env variable's or an output's definition, through outputs that pass it. */
export function producersOf(
  index: ProjectIndex,
  unit: UnitDecl,
  site: ExprSite,
  seg: ExprSegment,
  e: Expr,
): Producer[] {
  const ref = refAt(seg, e);
  if (!ref || !['env', 'steps', 'needs', 'jobs'].includes(ref.context)) return [];
  const name = ref.path[0];
  const own = ref.context === 'env' && namesKey(name) ? ownEnv(index, unit, site, name) : undefined;
  if (own)
    return [{ unit, ...(own.site ? { site: own.site } : {}), loc: own.valueLoc, label: `env.${own.name}` }];
  const symbol = index.resolveRef(unit, site, ref);
  return symbol ? definitionsOf(index, symbol, 3) : [];
}

function definitionsOf(index: ProjectIndex, symbol: string, hops: number): Producer[] {
  const label = index.nodes.get(symbol)?.label ?? symbol;
  const defs = index.definitionsOf(symbol);
  if (defs.length)
    return defs.map((d) =>
      'site' in d
        ? { unit: d.unit, site: d.site, loc: d.site.loc, label }
        : { unit: d.unit, loc: d.loc, label },
    );
  if (hops === 0) return [];
  return index
    .incoming(symbol, 'flows')
    .filter((e) => e.siteId === undefined)
    .flatMap((e) => definitionsOf(index, e.from, hops - 1));
}

const CLASS_TEXT: Record<ValueClass, string> = {
  true: 'true',
  false: 'false',
  'text-true': "'true'",
  'text-false': "'false'",
  text: 'text',
  empty: "''",
  number: 'a number',
  json: 'an object or array',
  unknown: 'a value known at run time',
};

/** A kind for people: `'true' | 'false' | text of inputs.file | '' (inputs.file omitted)`. */
export function describeKind(kind: ValueKind): string {
  if (kind.length === 0) return 'nothing: it fails';
  const order = Object.keys(CLASS_TEXT);
  const sorted = [...kind].sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls));
  const parts = sorted.map((p) => {
    if (p.cls === 'text' && p.from) return `text of \`${p.from}\``;
    if (p.why) return `'' (\`${p.why.label}\` ${p.why.kind === 'optional-input' ? 'omitted' : 'skipped'})`;
    return CLASS_TEXT[p.cls];
  });
  return [...new Set(parts)].join(' | ');
}
