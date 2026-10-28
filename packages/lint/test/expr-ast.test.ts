/** Reading an expression's AST: node kinds, where each node is written, and the nodes that decide a condition. */
import { parseExpression } from '@ciatlas/core';
import { describe, expect, it } from 'vitest';
import { booleanTermOf, exprSpan, nodeOf, tokenOffset, truthinessNodes } from '../src/expr-ast';

const ast = (source: string) => parseExpression(source).ast!;
/** The text of the root node's span. */
const spanned = (source: string) => {
  const { start, end } = exprSpan(source, ast(source));
  return source.slice(start, end);
};

describe('tokenOffset', () => {
  it('counts a column from the last line break outside a string', () => {
    // The lexer's line counts the line break inside the string; its column does not start after it.
    const source = "format('a\nb', env.x) ==\n  env.y";
    const n = nodeOf(ast(source));
    if (n.kind !== 'binary') throw new Error(n.kind);
    const { start, end } = exprSpan(source, n.node.right);
    expect([start, end]).toEqual([source.length - 5, source.length]);
    expect(source.slice(tokenOffset(source, n.node.operator.range.start))).toMatch(/^==/);
  });
});

describe('exprSpan', () => {
  it.each([
    "'it''s'",
    'github.ref',
    "github.event['x'] [0]",
    'github.event.commits.*.id',
    'github.event.commits[ * ]',
    'github . event',
    '! github.ref',
    "github.ref == 'a'",
    'env.b && vars.c || inputs.d',
    '( ( github.ref ) )',
    "contains ( github.ref , 'a' , )",
    'always ( )',
    "fromJSON('[1]')[0]",
  ])('spans %s whole', (source) => {
    expect(spanned(source)).toBe(source);
  });

  it('spans a node inside the expression without the space around it', () => {
    const source = "!( github.ref == '' )";
    const n = nodeOf(ast(source));
    if (n.kind !== 'unary') throw new Error(n.kind);
    const inner = nodeOf(n.node.expr);
    if (inner.kind !== 'grouping') throw new Error(inner.kind);
    const { start, end } = exprSpan(source, inner.node.group);
    expect(source.slice(start, end)).toBe("github.ref == ''");
  });

  it('has no span for a `*` of its own', () => {
    const n = nodeOf(ast('env.*'));
    if (n.kind !== 'index') throw new Error(n.kind);
    expect(nodeOf(n.node.index)).toEqual({ kind: 'star' });
    expect(() => exprSpan('env.*', n.node.index)).toThrow();
  });
});

describe('truthinessNodes', () => {
  /** The text of each node that decides the condition, and how many ancestors it has. */
  const deciding = (source: string) =>
    truthinessNodes(ast(source)).map((t) => {
      const { start, end } = exprSpan(source, t.expr);
      return `${t.ancestors.length} ${source.slice(start, end)}`;
    });

  it('goes through groupings, `!` and every operand of `&&` and `||`', () => {
    expect(deciding("!(env.x == '') && (vars.y || inputs.z)")).toEqual([
      "0 !(env.x == '') && (vars.y || inputs.z)",
      "1 !(env.x == '')",
      "2 (env.x == '')",
      "3 env.x == ''",
      '1 (vars.y || inputs.z)',
      '2 vars.y || inputs.z',
      '3 vars.y',
      '3 inputs.z',
    ]);
  });

  it('stops at comparisons, calls and indexes', () => {
    expect(deciding("(env.x != '') == vars.y")).toEqual(["0 (env.x != '') == vars.y"]);
    expect(deciding("case(env.x != '', 1, 2)")).toEqual(["0 case(env.x != '', 1, 2)"]);
    expect(deciding("env[vars.x != '']")).toEqual(["0 env[vars.x != '']"]);
  });
});

describe('booleanTermOf', () => {
  /** The text of the term the first `steps.t` read in `source` is in, `!` first when it is negated. */
  const termAt = (source: string) => {
    const found = booleanTermOf(parseExpression(source), source.indexOf('steps.t'));
    if (!found) return undefined;
    const { start, end } = exprSpan(source, found.term);
    return `${found.negated ? '! ' : ''}${source.slice(start, end)}`;
  };

  it('is the operand of the nearest `&&` or `||`, or the whole condition', () => {
    expect(termAt("steps.t.outputs.x == '' && inputs.y")).toBe("steps.t.outputs.x == ''");
    expect(termAt("inputs.y || (steps.t.outputs.x == 'a' && vars.z)")).toBe("steps.t.outputs.x == 'a'");
    expect(termAt("steps.t.outputs.x == 'a'")).toBe("steps.t.outputs.x == 'a'");
  });

  it('counts the `!`s between the term and the root', () => {
    expect(termAt("!(steps.t.outputs.x == 'a' || inputs.y)")).toBe("! steps.t.outputs.x == 'a'");
    expect(termAt('!!(steps.t.outputs.x || inputs.y)')).toBe('steps.t.outputs.x');
    expect(termAt("!(steps.t.outputs.x == '') && inputs.y")).toBe("!(steps.t.outputs.x == '')");
    expect(termAt("!(steps.t.outputs.x == '')")).toBe("!(steps.t.outputs.x == '')");
  });

  it('keeps a comparison, call or index around the reference whole', () => {
    expect(termAt("(steps.t.outputs.x || 'a') == 'a' && inputs.y")).toBe("(steps.t.outputs.x || 'a') == 'a'");
    expect(termAt("contains(steps.t.outputs.x || 'a', 'a') || inputs.y")).toBe(
      "contains(steps.t.outputs.x || 'a', 'a')",
    );
    expect(termAt('(!steps.t.outputs.x) == true && inputs.y')).toBe('(!steps.t.outputs.x) == true');
  });

  it('is undefined outside the expression', () => {
    expect(termAt('inputs.y')).toBeUndefined();
  });
});
