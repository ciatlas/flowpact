import {
  type CallSite,
  type ConditionUse,
  type ContextResolver,
  conditionUses,
  type ExprSite,
  escapeControl,
  evaluate,
  type fallbacksOf,
  findTemplateSegments,
  isEmptyValue,
  type LocatedRef,
  type ParsedExpression,
  type StepDecl,
  type UnitDecl,
} from '@ciatlas/core';
import type { RelatedLocation } from './types';

/**
 * True when a condition site is one expression — bare, or a single `${{ }}` with nothing around it — rather than a
 * string with interpolations (which is always truthy when not empty).
 */
export function isWholeExpression(site: ExprSite): boolean {
  if (site.segments.length !== 1) return false;
  const templated = findTemplateSegments(site.text);
  return (
    templated.length === 0 ||
    (templated.length === 1 && site.text.trim() === site.text.slice(templated[0]!.start, templated[0]!.end))
  );
}

/** A job's or step's `if:` that decides whether a site is evaluated: its expression, or `false` for a literal `if: false`. */
export type Guard = ExprSite | false;

/** The guard a job's or step's `if:` sets, if any. A literal `if: false` (a YAML boolean) has no site but never runs. */
export function guardOf(decl: { ifValue?: boolean; ifSite?: ExprSite }): Guard | undefined {
  return decl.ifValue === false ? false : decl.ifSite;
}

/** How a condition site uses a reference: only the value of a whole-expression `if:` decides by truthiness. */
export function useInCondition(site: ExprSite, ref: LocatedRef): ConditionUse | undefined {
  const seg = site.segments.find((s) => s.refs.includes(ref));
  return seg ? conditionUses(seg.expr, isWholeExpression(site)).get(ref.start) : undefined;
}

/**
 * True when a reference is the subject of a fallback (`a || b`, keyed in `fallbacks` as `fallbacksOf` gives them) whose
 * value is not empty under any of `resolvers`: an empty value read there is replaced by something.
 */
export function fallsBack(
  fallbacks: ReturnType<typeof fallbacksOf>,
  ref: LocatedRef,
  resolvers: ContextResolver[],
): boolean {
  const fallback = fallbacks.get(ref.start);
  return !!fallback && !resolvers.some((resolve) => isEmptyValue(evaluate(fallback, resolve)));
}

/** A node of an expression's AST, as `@actions/expressions` parses it for core. */
type Expr = NonNullable<ParsedExpression['ast']>;

/**
 * How a node passes on the truthiness of what is inside it: `&&` and `||` (`logical`) return an operand, `!` (`not`, the
 * one unary operator) inverts its operand's and a grouping keeps it; any other node (`value`: a comparison, function
 * call or index) uses the values inside it as they are. `inner` are the nodes directly inside it, and `start`, for a
 * context name (`steps` in `steps.t.outputs.x`), is where it starts in the expression's source.
 */
interface Shape {
  kind: 'logical' | 'not' | 'grouping' | 'value';
  inner: Expr[];
  start?: number;
}

/** The shape of a node in `source`. A `*` index, whose `accept()` throws, has nothing inside it. */
function shapeOf(source: string, e: Expr): Shape {
  try {
    return e.accept<Shape>({
      visitLiteral: () => ({ kind: 'value', inner: [] }),
      visitUnary: (u) => ({ kind: 'not', inner: [u.expr] }),
      visitBinary: (b) => ({ kind: 'value', inner: [b.left, b.right] }),
      visitLogical: (l) => ({ kind: 'logical', inner: l.args }),
      visitGrouping: (g) => ({ kind: 'grouping', inner: [g.group] }),
      visitContextAccess: (c) => ({
        kind: 'value',
        inner: [],
        start: tokenOffset(source, c.name.range.start),
      }),
      visitIndexAccess: (i) => ({ kind: 'value', inner: [i.expr, i.index] }),
      visitFunctionCall: (f) => ({ kind: 'value', inner: f.args }),
    });
  } catch {
    return { kind: 'value', inner: [] };
  }
}

/**
 * The offset in `source` of a position the lexer gives a token (core's `offsetOf`, which is not exported). Its `line`
 * counts every newline before the token's end, those inside string literals included, but its `column` counts from the
 * last newline outside a string: so the column is added to the offset after the last newline outside a string among
 * the first `line`. A quote toggles the string: a `''` escape toggles it twice.
 */
function tokenOffset(source: string, pos: { line: number; column: number }): number {
  let lineStart = 0;
  let newlines = 0;
  let inString = false;
  for (let i = 0; i < source.length && newlines < pos.line; i++) {
    if (source[i] === "'") inString = !inString;
    else if (source[i] === '\n') {
      newlines++;
      if (!inString) lineStart = i + 1;
    }
  }
  return lineStart + pos.column;
}

/** A boolean term of a condition, and whether an odd number of `!` is around it (see `booleanTermOf`). */
export interface BooleanTerm {
  term: Expr;
  negated: boolean;
}

/**
 * The boolean term of a condition that the reference starting at `start` (`ExprRef.start`) is in: the operand of the
 * nearest `&&` or `||` above it (`steps.t.outputs.x == ''` in `steps.t.outputs.x == '' && inputs.y`), or the whole
 * condition when there is none; and whether the `!`s between that term and the root invert it
 * (`steps.t.outputs.x == 'true'` in `!(steps.t.outputs.x == 'true' || inputs.y)`). A comparison, function call or
 * index ends the walk: the values inside it count as they are (`(steps.t.outputs.x || 'a') == 'a'` is one term).
 * Undefined when no reference starts there.
 */
export function booleanTermOf(expr: ParsedExpression, start: number): BooleanTerm | undefined {
  /** `found` is the term so far, `negated` whether the `!`s above `e` invert it, `open` whether `e` is in no value. */
  const find = (e: Expr, found: BooleanTerm, negated: boolean, open: boolean): BooleanTerm | undefined => {
    const shape = shapeOf(expr.source, e);
    if (shape.start !== undefined) return shape.start === start ? found : undefined;
    const inverts = open && shape.kind === 'not';
    const stays = open && shape.kind !== 'value';
    for (const inner of shape.inner) {
      const term = open && shape.kind === 'logical' ? { term: inner, negated } : found;
      const result = find(inner, term, negated !== inverts, stays);
      if (result) return result;
    }
    return undefined;
  };
  return expr.ast && find(expr.ast, { term: expr.ast, negated: false }, false, true);
}

/** The steps a site's `steps` context names: an action's, or those of the site's job. */
export function stepsInScope(unit: UnitDecl, jobId: string | undefined): StepDecl[] {
  if (unit.kind === 'action') return unit.steps;
  return jobId ? (unit.jobs[jobId]?.steps ?? []) : [];
}

export function chainRelated(chain: CallSite[]): RelatedLocation[] {
  return chain.map((c) => ({
    loc: c.job.uses?.loc ?? c.job.loc,
    message: `jobs.${c.job.id} calls ${c.callee.path}`,
  }));
}

/** Quotes a name from the analyzed YAML, making control characters (incl. newlines) visible. */
export const quote = (s: string) => `"${escapeControl(s)}"`;

/** A message's ` — did you mean "x"?` suffix for a guess, or nothing without one. */
export const didYouMeanNote = (guess: string | undefined) =>
  guess ? ` — did you mean ${quote(guess)}?` : '';

/** True when a reference's path segment names a key: present, and neither a `*` filter nor a `?` computed index. */
export function namesKey(segment: string | undefined): segment is string {
  return !!segment && segment !== '*' && segment !== '?';
}

/**
 * True when a reference's path segment is the context property `name` (written in lower case), compared the way GitHub
 * looks properties up: ignoring case. `@actions/expressions` lower-cases the keys of its `Dictionary`, and the runner's
 * `DictionaryContextData` compares them with `OrdinalIgnoreCase`, so `github.Event.Inputs` is `github.event.inputs`.
 */
export function isProperty(segment: string | undefined, name: string): boolean {
  return segment?.toLowerCase() === name;
}

export function listNames(names: string[], max = 6): string {
  if (names.length === 0) return '(none)';
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown}, … (+${names.length - max})` : shown;
}
