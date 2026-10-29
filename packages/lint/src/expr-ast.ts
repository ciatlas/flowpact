/**
 * Reading the AST of an expression, as `@actions/expressions` parses it for core (`ParsedExpression.ast`): what kind
 * each node is, where it is written in the expression's source, which nodes decide a condition by their truthiness,
 * and where an edit to a segment's source goes in the file.
 *
 * Nodes are told apart through their `accept()` visitor, not `instanceof`: this module needs the package's types only,
 * so a copy of `@actions/expressions` other than core's cannot make a check silently match nothing.
 */
import type {
  Binary,
  ContextAccess,
  Expr,
  ExprVisitor,
  FunctionCall,
  Grouping,
  IndexAccess,
  Literal,
  Logical,
  Unary,
} from '@actions/expressions/ast';
import type { Pos, Token } from '@actions/expressions/lexer';
import type { ExprSegment, ExprSite, Loc, ParsedExpression, ProjectIndex } from '@ciatlas/core';
import { isWholeExpression } from './rules/util';
import { type SuggestedEdit, sourceOf } from './suggestions';

/** An expression node and its kind. `star` is the `*` of `a.*` or `a[*]`, which has no token. */
export type AstNode =
  | { kind: 'literal'; node: Literal }
  | { kind: 'unary'; node: Unary }
  | { kind: 'binary'; node: Binary }
  | { kind: 'logical'; node: Logical }
  | { kind: 'grouping'; node: Grouping }
  | { kind: 'context'; node: ContextAccess }
  | { kind: 'index'; node: IndexAccess }
  | { kind: 'call'; node: FunctionCall }
  | { kind: 'star' };

const KINDS: ExprVisitor<AstNode> = {
  visitLiteral: (node) => ({ kind: 'literal', node }),
  visitUnary: (node) => ({ kind: 'unary', node }),
  visitBinary: (node) => ({ kind: 'binary', node }),
  visitLogical: (node) => ({ kind: 'logical', node }),
  visitGrouping: (node) => ({ kind: 'grouping', node }),
  visitContextAccess: (node) => ({ kind: 'context', node }),
  visitIndexAccess: (node) => ({ kind: 'index', node }),
  visitFunctionCall: (node) => ({ kind: 'call', node }),
};

/** The kind of a node. A `*` index is the one node whose `accept()` throws. */
export function nodeOf(e: Expr): AstNode {
  try {
    return e.accept(KINDS);
  } catch {
    return { kind: 'star' };
  }
}

/** Whether a node is the string literal `''`: not `null`, `0` or `false`, which compare differently. */
export const isEmptyString = (e: Expr): boolean => {
  const n = nodeOf(e);
  return n.kind === 'literal' && n.node.token.lexeme === "''";
};

/**
 * The offset in an expression's source of a position the lexer gives a token (a copy of core's private `offsetOf`).
 * Its `line` counts every newline before the token's end, those inside string literals included, but its `column`
 * counts from the last newline outside a string: so the column is added to the offset after the last newline outside a
 * string among the first `line`. A quote toggles the string: a `''` escape toggles it twice.
 */
export function tokenOffset(source: string, pos: Pos): number {
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

/** Offsets in an expression's source: `start` inclusive, `end` exclusive. */
export interface Span {
  start: number;
  end: number;
}

/** Where a token is written in an expression's source. */
export const tokenSpan = (source: string, tok: Token): Span => ({
  start: tokenOffset(source, tok.range.start),
  end: tokenOffset(source, tok.range.end),
});

/** The whitespace the lexer skips between tokens. */
const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

/** The offset of the first character at or after `i` that is not whitespace. */
function skipSpace(source: string, i: number): number {
  while (i < source.length && isSpace(source[i])) i++;
  return i;
}

/** The offset just past the last character before `i` that is not whitespace. */
function skipSpaceBack(source: string, i: number): number {
  while (i > 0 && isSpace(source[i - 1])) i--;
  return i;
}

/**
 * Where a node is written in an expression's source, from its first token through its last, closing `)` and `]`
 * included. Groupings, the end of a call and a `*` have no token: they are found past the whitespace around their
 * contents, which is all the grammar allows there (a call may end its arguments with a `,`).
 */
export function exprSpan(source: string, e: Expr): Span {
  const n = nodeOf(e);
  switch (n.kind) {
    case 'literal':
      return tokenSpan(source, n.node.token);
    case 'context':
      return tokenSpan(source, n.node.name);
    case 'unary':
      return {
        start: tokenOffset(source, n.node.operator.range.start),
        end: exprSpan(source, n.node.expr).end,
      };
    case 'binary':
      return { start: exprSpan(source, n.node.left).start, end: exprSpan(source, n.node.right).end };
    case 'logical':
      return {
        start: exprSpan(source, n.node.args[0]!).start,
        end: exprSpan(source, n.node.args.at(-1)!).end,
      };
    case 'grouping': {
      const inner = exprSpan(source, n.node.group);
      return { start: skipSpaceBack(source, inner.start) - 1, end: skipSpace(source, inner.end) + 1 };
    }
    case 'call':
      return callSpan(source, n.node);
    case 'index':
      return indexSpan(source, n.node);
    case 'star':
      throw new Error('a `*` index has no span of its own');
  }
}

/** A call, from its name through its `)`. */
function callSpan(source: string, call: FunctionCall): Span {
  const name = tokenSpan(source, call.functionName);
  const last = call.args.at(-1);
  let close: number;
  if (last) {
    close = skipSpace(source, exprSpan(source, last).end);
    if (source[close] === ',') close = skipSpace(source, close + 1);
  } else close = skipSpace(source, skipSpace(source, name.end) + 1);
  return { start: name.start, end: close + 1 };
}

/** An index, from its base through its property name (`.name`, `.*`) or its `]`. */
function indexSpan(source: string, access: IndexAccess): Span {
  const base = exprSpan(source, access.expr);
  const open = skipSpace(source, base.end);
  const star = nodeOf(access.index).kind === 'star';
  if (source[open] === '.')
    return {
      start: base.start,
      end: star ? skipSpace(source, open + 1) + 1 : exprSpan(source, access.index).end,
    };
  const inner = star ? skipSpace(source, open + 1) + 1 : exprSpan(source, access.index).end;
  return { start: base.start, end: skipSpace(source, inner) + 1 };
}

/** A node that decides a condition by its truthiness, with its ancestors from the root, each of them such a node too. */
export interface TruthinessNode {
  expr: Expr;
  ancestors: Expr[];
}

/**
 * The root of a condition GitHub decides by truthiness ('', 0, false and null are false, every other value true): an
 * `if:` that is one expression, bare or a single `${{ }}`. A string with text around its `${{ }}` is not one: it is
 * always true. Value positions (`env:`, `with:`, `outputs:`) and strictly typed fields (`continue-on-error:`) are not
 * conditions.
 */
export function conditionRoot(site: ExprSite): Expr | undefined {
  return site.isCondition && isWholeExpression(site) ? site.segments[0]?.expr.ast : undefined;
}

/**
 * The nodes of a condition that decide it by truthiness: the root, and through groupings, the operand of `!` and every
 * operand of `&&` and `||` (which return an operand: replacing one by another of the same truthiness leaves the
 * condition's unchanged). Not the operands of comparisons, the arguments of functions (`case()` requires real
 * booleans) or indexes, whose values count as they are.
 */
export function truthinessNodes(root: Expr): TruthinessNode[] {
  const out: TruthinessNode[] = [];
  const visit = (expr: Expr, ancestors: Expr[]) => {
    out.push({ expr, ancestors });
    const n = nodeOf(expr);
    const inner =
      n.kind === 'grouping'
        ? [n.node.group]
        : n.kind === 'logical'
          ? n.node.args
          : n.kind === 'unary' && n.node.operator.lexeme === '!'
            ? [n.node.expr]
            : [];
    for (const child of inner) visit(child, [...ancestors, expr]);
  };
  visit(root, []);
  return out;
}

/** The expressions directly inside a node: its operands, arguments, group, or base and computed index. */
function childrenOf(e: Expr): Expr[] {
  const n = nodeOf(e);
  switch (n.kind) {
    case 'unary':
      return [n.node.expr];
    case 'binary':
      return [n.node.left, n.node.right];
    case 'logical':
    case 'call':
      return n.node.args;
    case 'grouping':
      return [n.node.group];
    case 'index':
      return nodeOf(n.node.index).kind === 'star' ? [n.node.expr] : [n.node.expr, n.node.index];
    default:
      return [];
  }
}

/** Every node of an expression, each with its ancestors from the root, parents before their children. */
export function everyNode(root: Expr): TruthinessNode[] {
  const out: TruthinessNode[] = [];
  const visit = (expr: Expr, ancestors: Expr[]) => {
    out.push({ expr, ancestors });
    for (const child of childrenOf(expr)) visit(child, [...ancestors, expr]);
  };
  visit(root, []);
  return out;
}

/** A boolean term of a condition, and whether an odd number of `!` is around it (see `booleanTermOf`). */
export interface BooleanTerm {
  term: Expr;
  negated: boolean;
}

/**
 * The boolean term of a condition that the reference starting at `start` (`ExprRef.start`) is in: the operand of the
 * nearest `&&` or `||` around it (`steps.t.outputs.x == ''` in `steps.t.outputs.x == '' && inputs.y`), or the whole
 * condition when there is none; and whether the `!`s between that term and the root invert it
 * (`steps.t.outputs.x == 'true'` in `!(steps.t.outputs.x == 'true' || inputs.y)`). It is one of the condition's
 * `truthinessNodes`, so a comparison, function call or index around the reference is part of it
 * (`(steps.t.outputs.x || 'a') == 'a'` is one term).
 */
export function booleanTermOf(expr: ParsedExpression, start: number): BooleanTerm | undefined {
  if (!expr.ast) return undefined;
  const around = truthinessNodes(expr.ast).filter(({ expr: e }) => {
    const span = exprSpan(expr.source, e);
    return span.start <= start && start < span.end;
  });
  const found = around.findLast(({ ancestors }) => {
    const parent = ancestors.at(-1);
    return !parent || nodeOf(parent).kind === 'logical';
  });
  if (!found) return undefined;
  const nots = found.ancestors.filter((a) => nodeOf(a).kind === 'unary').length;
  return { term: found.expr, negated: nots % 2 === 1 };
}

/**
 * Where a span of a segment's expression source is written in the file: only when the segment is on one line and is
 * written as its source reads. A single-quoted scalar doubles each `'` and a double-quoted one may spell characters
 * with escapes, so the offsets of the source would not be those of the file there.
 */
export function segmentLoc(index: ProjectIndex, seg: ExprSegment, span: Span): Loc | undefined {
  const { loc } = seg;
  const line = loc.line === loc.endLine ? sourceOf(index, loc.file)?.lines[loc.line - 1] : undefined;
  if (line?.slice(loc.column - 1, loc.endColumn - 1) !== seg.expr.source) return undefined;
  return { ...loc, column: loc.column + span.start, endColumn: loc.column + span.end };
}

/** A change to a segment's expression source: the text at `span` replaced by `newText`. */
export interface SourceEdit {
  span: Span;
  newText: string;
}

/** An expression's source with edits made; they must not overlap. */
export function applyEdits(source: string, edits: SourceEdit[]): string {
  return [...edits]
    .sort((a, b) => b.span.start - a.span.start)
    .reduce((s, e) => s.slice(0, e.span.start) + e.newText + s.slice(e.span.end), source);
}

/**
 * The file edits for edits to a segment's expression source (see `segmentLoc`), or none unless each can be made: also
 * none in a file with CRLF line endings, or for a text over several lines.
 */
export function segmentEdits(
  index: ProjectIndex,
  seg: ExprSegment,
  edits: SourceEdit[],
): SuggestedEdit[] | undefined {
  if (sourceOf(index, seg.loc.file)?.text.includes('\r') || edits.some((e) => /[\r\n]/.test(e.newText)))
    return undefined;
  const out: SuggestedEdit[] = [];
  for (const e of edits) {
    const loc = segmentLoc(index, seg, e.span);
    if (!loc) return undefined;
    out.push({ loc, newText: e.newText });
  }
  return out;
}
