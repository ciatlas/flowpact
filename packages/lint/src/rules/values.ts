import type { Binary, Expr, FunctionCall } from '@actions/expressions/ast';
import {
  type Binding,
  type ExprSegment,
  type ExprSite,
  type Loc,
  type LocatedRef,
  lookup,
  type ProjectIndex,
  type UnitDecl,
} from '@ciatlas/core';
import {
  conditionRoot,
  everyNode,
  exprSpan,
  nodeOf,
  type SourceEdit,
  type Span,
  segmentEdits,
  segmentLoc,
  type TruthinessNode,
  truthinessNodes,
} from '../expr-ast';
import { type Suggestion, sourceOf } from '../suggestions';
import {
  describeKind,
  type EmptyReason,
  emptyReasons,
  isBooleanClass,
  isMixed,
  kindOf,
  type Producer,
  producersOf,
  readsReason,
  refAt,
  refLabel,
  type ValueKind,
  whenTruthy,
} from '../value-kind';
import { callersOf, omittable } from './inputs';
import { defineRule, type RelatedLocation, type RuleContext, type RuleDefinition } from './types';
import { isWholeExpression } from './util';

const valueNotBoolean = defineRule({
  code: 'FP506',
  name: 'value-not-boolean',
  category: 'expressions',
  defaultSeverity: 'error',
  docs: {
    summary:
      "A value read as a boolean can be another string: `fromJSON()` of a value that may be '', a comparison with " +
      "'true' of a value that may be other text, or an `env:`, `with:` or `outputs:` value that gives a boolean or text.",
    why:
      'Only an `if:` reads a value as true or false. Under `env:`, `with:` and `outputs:` a value is passed on as text: ' +
      "a comparison gives 'true' or 'false', but `a || b` gives the operand itself, and an optional input is '' when " +
      "omitted. `fromJSON('')` fails the job (`continue-on-error: ${{ fromJSON(env.X) }}` is the usual reader), and so " +
      "does `fromJSON()` of a file name. A reader that compares the value with 'true' takes the false branch for any " +
      'other text, and the run stays green. Reported as an error for `fromJSON()`, as a warning otherwise.',
    fix:
      "Compare explicitly where the value is set, so that it is 'true' or 'false': `inputs.x != ''` (or " +
      "`inputs.x == 'yes'`). A literal fallback (`inputs.x || 'false'`) only fixes the empty case. The editor offers " +
      "`!= ''` as a quick fix where it is certain.",
    scope:
      "`fromJSON()` is reported only for a '' flowpact can point at: an optional input without a default (or with " +
      "`default: ''`) that a caller can omit (as for FP105, not one every local caller passes, unless the workflow can " +
      "be dispatched or the unit is published), or the output of a step whose `if:` can skip it; not when the reader's " +
      'own job or step `if:`, or an earlier operand of its `&&`, `||` or `case()`, reads the same input, output or ' +
      '`github` property. In a field that takes a boolean (`continue-on-error:`, a `type: boolean` input) such an ' +
      "input is reported even when every local caller passes it, since other text than 'true' or 'false' fails " +
      "there too, unless each passes 'true' or 'false' as it is, or one expression that gives a boolean in the caller " +
      '(`${{ inputs.dry }}` of an input every trigger of the caller declares `type: boolean`, a comparison, `!`, ' +
      '`contains()`). The `||` is reported when ' +
      'one of its operands is a boolean (a comparison, `!`, `contains()`, a boolean input, or ' +
      "'true'/'false') and another is text; not `c && 'yes' || 'no'`, which is always text, nor an `&&` alone. " +
      'Values known only at run time (a script’s outputs, `github.event`, the matrix) are never reported. Not ' +
      'reported either: comparisons in a `run:` script (`[[ "$X" == "true" ]]`), the fall-through of ' +
      "`c && a || b` when `a` is '', a value that is always 'true' or 'false' read by an `if:` (where 'false' is " +
      'true), and text passed in `with:` to a `type: boolean` input. The quick fix is offered for a value written on ' +
      "one line, where each text operand is a reference that is text or '', and for `fromJSON()` only where it " +
      'must give a boolean: `continue-on-error:`, a condition, or a `type: boolean` input.',
    examples: {
      bad: `- env:
    CONTINUE_ON_ERROR: \${{ inputs.report-file }}
  continue-on-error: \${{ fromJSON(env.CONTINUE_ON_ERROR) }}
  run: ./test.sh
outputs:
  is-report: \${{ steps.changed.outputs.any == 'true' || inputs.report-file }}`,
      good: `- env:
    CONTINUE_ON_ERROR: \${{ inputs.report-file != '' }}
  continue-on-error: \${{ fromJSON(env.CONTINUE_ON_ERROR) }}
  run: ./test.sh
outputs:
  is-report: \${{ steps.changed.outputs.any == 'true' || inputs.report-file != '' }}`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) for (const site of unit.sites) checkSite(ctx, unit, site);
  },
});

/** FP506 for a site: its `fromJSON()` calls and comparisons, and its value when it passes one on. */
function checkSite(ctx: RuleContext, unit: UnitDecl, site: ExprSite): void {
  for (const seg of site.segments) if (seg.expr.ast) checkReads(ctx, { unit, site, seg }, seg.expr.ast);
  if (PRODUCERS[site.field] && isWholeExpression(site)) checkProducer(ctx, unit, site);
}

/** Where an expression is: its unit, site and segment. */
interface At {
  unit: UnitDecl;
  site: ExprSite;
  seg: ExprSegment;
}

/** The fields that pass a value on as text, by the context it is read through. */
const PRODUCERS: Partial<Record<ExprSite['field'], string>> = {
  'workflow.env': 'env',
  'job.env': 'env',
  'step.env': 'env',
  'job.output': 'outputs',
  'workflow.output': 'outputs',
  'action.output': 'outputs',
  'step.with': 'with',
};

/** The `fromJSON()` calls and the comparisons with 'true' or 'false' of a segment. */
function checkReads(ctx: RuleContext, at: At, root: Expr): void {
  for (const node of everyNode(root)) {
    const n = nodeOf(node.expr);
    if (
      n.kind === 'call' &&
      n.node.functionName.lexeme.toLowerCase() === 'fromjson' &&
      n.node.args.length === 1
    )
      checkFromJson(ctx, at, node, n.node);
    else if (n.kind === 'binary') checkComparison(ctx, at, n.node);
  }
}

/** The text of a node, for messages: its source when it is short and on one line. */
function written(source: string, span: Span, otherwise: string): string {
  const text = source.slice(span.start, span.end);
  return text.length <= 60 && !/[\r\n`]/.test(text) ? `\`${text}\`` : otherwise;
}

/**
 * FP506 for `fromJSON(x)` where `x` may be '' for a reason flowpact can point at, which no guard decides. In a field
 * that takes a boolean, other text than 'true' or 'false' fails too: there an optional input that every caller passes
 * is reported as well, unless each passes 'true' or 'false' (see `passesBoolean`).
 */
function checkFromJson(ctx: RuleContext, at: At, node: TruthinessNode, call: FunctionCall): void {
  const { index } = ctx;
  const arg = call.args[0]!;
  const kind = kindOf(index, at.unit, at.site, at.seg, arg);
  const undecided = emptyReasons(kind).filter((why) => !decided(index, at, node, why));
  const reasons = undecided.filter((why) => canBeEmpty(ctx, why));
  const passed = undecided.filter((why) => !reasons.includes(why));
  const text = failsOnText(ctx, at, node, kind, passed);
  if (reasons.length === 0 && !(text && passed.length > 0)) return;
  const source = at.seg.expr.source;
  const called = written(source, exprSpan(source, call), '`fromJSON()`');
  const value = written(source, exprSpan(source, arg), 'its argument');
  const producers = producersOf(index, at.unit, at.site, at.seg, arg);
  ctx.report({
    message:
      reasons.length === 0
        ? `${called} fails unless ${value} is 'true' or 'false', and it can be other text, such as a file name`
        : `${called} fails when ${reasons.map(whenEmpty).join(' or ')}: ${value} is then '', which is not JSON${
            text ? "; other text than 'true' or 'false', such as a file name, fails here too" : ''
          }`,
    loc: segmentLoc(index, at.seg, exprSpan(source, call)) ?? at.seg.loc,
    symbol: (reasons[0] ?? passed[0])!.symbols[0]!,
    related: [...producers.map(setHere), ...reasons.map(reasonNote)],
    suggestions: [wantsBoolean(index, at, node) ? producerFix(index, at.unit, producers) : undefined],
  });
}

/**
 * Whether a `fromJSON()` is all of a field that takes a boolean (see `typedBoolean`) and its value can be other text,
 * which fails there too: not the text of an input in `passed` (whose callers all pass it) that each passes as 'true'
 * or 'false'.
 */
function failsOnText(
  ctx: RuleContext,
  at: At,
  node: TruthinessNode,
  kind: ValueKind,
  passed: EmptyReason[],
): boolean {
  return (
    typedBoolean(ctx.index, at, node) &&
    kind.some((p) => p.cls === 'text' && !passed.some((why) => passedAsBoolean(ctx, why, p.from)))
  );
}

/**
 * Whether a reason can make the value '': an optional input only where a caller can omit it, as FP105 sees it (not
 * when every local caller passes it and the unit is neither dispatchable nor published).
 */
function canBeEmpty(ctx: RuleContext, why: EmptyReason): boolean {
  if (why.kind !== 'optional-input') return true;
  const unit = ctx.index.unit(why.symbols[0]!.split('#')[0]!);
  return !unit || omittable(ctx.index, unit, why.label.slice('inputs.'.length), ctx.config.impact);
}

/**
 * Whether text read from `from` (`inputs.flag`, in any case) is the input of `why`, which every caller passes as 'true'
 * or 'false'.
 */
function passedAsBoolean(ctx: RuleContext, why: EmptyReason, from: string | undefined): boolean {
  const unit = ctx.index.unit(why.symbols[0]!.split('#')[0]!);
  return (
    !!unit &&
    why.label.toLowerCase() === from?.toLowerCase() &&
    passesBoolean(ctx.index, unit, why.label.slice('inputs.'.length))
  );
}

/**
 * Whether every local caller of `unit` passes `input` as 'true' or 'false': written as it is (`true`, `'false'`), or as
 * one expression that gives a boolean in the caller (`${{ inputs.dry }}` of an input `type: boolean` on every trigger,
 * `${{ github.ref == 'refs/heads/main' }}`, `${{ !inputs.x }}`), which `with:` passes on as 'true' or 'false'.
 */
function passesBoolean(index: ProjectIndex, unit: UnitDecl, input: string): boolean {
  const callers = callersOf(index, unit);
  return (
    callers.length > 0 &&
    callers.every((c) => {
      const passed = lookup(c.with, input);
      return !!passed && passedBoolean(index, c.unit, passed);
    })
  );
}

/** Whether a `with:` entry of `unit` is 'true' or 'false' (see `passesBoolean`). */
function passedBoolean(index: ProjectIndex, unit: UnitDecl, passed: Binding): boolean {
  const { value, site } = passed;
  if (typeof value === 'boolean' || value === 'true' || value === 'false') return true;
  const seg = site?.segments[0];
  if (!site || !seg?.expr.ast || !isWholeExpression(site) || !inputsBooleanOnEveryTrigger(unit, seg))
    return false;
  const kind = kindOf(index, unit, site, seg, seg.expr.ast);
  return kind.length > 0 && kind.every((p) => p.cls === 'true' || p.cls === 'false');
}

/**
 * Whether every input whose value a caller passes on (`${{ inputs.dry }}`, an operand of `&&` or `||`) is a boolean
 * however the caller runs: a value kind takes an input's type from one declaration, but a dispatch may declare it as
 * text, and another trigger (`push`) passes no inputs at all. A comparison or `!` gives a boolean whatever it reads.
 */
function inputsBooleanOnEveryTrigger(unit: UnitDecl, seg: ExprSegment): boolean {
  const names = passedOn(seg, seg.expr.ast!).flatMap((r) => (r.context === 'inputs' ? [r.path[0]] : []));
  if (names.length === 0 || unit.kind !== 'workflow') return true;
  const declarations = unit.triggers.map((t) =>
    t === 'workflow_call' ? unit.call?.inputs : t === 'workflow_dispatch' ? unit.dispatch?.inputs : undefined,
  );
  return names.every(
    (name) => !!name && declarations.every((inputs) => !!inputs && lookup(inputs, name)?.type === 'boolean'),
  );
}

/** The references an expression gives as its value: itself, or the operands of `&&`, `||` and parentheses. */
function passedOn(seg: ExprSegment, e: Expr): LocatedRef[] {
  const n = nodeOf(e);
  if (n.kind === 'grouping') return passedOn(seg, n.node.group);
  if (n.kind === 'logical') return n.node.args.flatMap((a) => passedOn(seg, a));
  const ref = refAt(seg, e);
  return ref ? [ref] : [];
}

const whenEmpty = (why: EmptyReason) =>
  why.kind === 'optional-input'
    ? `optional input \`${why.label.slice('inputs.'.length)}\` is omitted`
    : `step \`${why.label.slice('steps.'.length)}\` is skipped by its \`if:\``;

const setHere = (p: Producer): RelatedLocation => ({ loc: p.loc, message: `${p.label} is set here` });

const reasonNote = (why: EmptyReason): RelatedLocation => ({
  loc: why.loc,
  message:
    why.kind === 'optional-input'
      ? `${why.label} is optional, and '' when omitted`
      : `${why.label} runs only when this holds; its outputs are '' otherwise`,
});

/**
 * Whether a guard decides a '' before `fromJSON()` reads it: the reader's job or step does not run (`if: false`), or
 * its `if:` reads what the '' comes from (a step's outputs: any `if:` of the reader's step), or an earlier operand of
 * an `&&`, `||` or `case()` around the call does. Proving that one condition implies another is left out.
 */
function decided(index: ProjectIndex, at: At, node: TruthinessNode, why: EmptyReason): boolean {
  return guardDecides(index, at, why) || earlierOperandDecides(index, at, node, why);
}

/** Whether the reader's job or step `if:` decides a '' (see `decided`). */
function guardDecides(index: ProjectIndex, { unit, site }: At, why: EmptyReason): boolean {
  const { step, job } = readerOf(index, unit, site);
  if (neverRuns(step) || neverRuns(job)) return true;
  // A step's outputs are '' when it was skipped: a reader's own `if:` is taken to test that.
  const ownIf = step?.ifSite === site ? undefined : step?.ifSite;
  if (why.kind === 'guarded-step' && ownIf) return true;
  const guards = [ownIf, job?.ifSite].filter((g): g is ExprSite => !!g && g !== site);
  return guards.some((g) =>
    readsReason(
      index,
      unit,
      g,
      g.segments.flatMap((x) => x.refs),
      why,
    ),
  );
}

/** Whether a job or step is written `if: false`. */
const neverRuns = (decl: { ifValue?: boolean } | undefined) => decl?.ifValue === false;

/** The step and job a site is in, if any. */
function readerOf(index: ProjectIndex, unit: UnitDecl, site: ExprSite) {
  const job = unit.kind === 'workflow' && site.job ? unit.jobs[site.job] : undefined;
  return { step: index.stepOf(unit, site), job };
}

/** Whether an operand evaluated before the call decides a '' (see `decided`). */
function earlierOperandDecides(
  index: ProjectIndex,
  { unit, site, seg }: At,
  node: TruthinessNode,
  why: EmptyReason,
) {
  return earlierOperands(seg.expr.source, node).some((span) => {
    const refs = seg.refs.filter((r) => r.start >= span.start && r.start < span.end);
    return readsReason(index, unit, site, refs, why);
  });
}

/** The operands evaluated before a node: those before it of each `&&`, `||` and `case()` around it. */
function earlierOperands(source: string, node: TruthinessNode): Span[] {
  const chain = [...node.ancestors, node.expr];
  const out: Span[] = [];
  for (const [i, parent] of node.ancestors.entries()) {
    const n = nodeOf(parent);
    const args =
      n.kind === 'logical' || (n.kind === 'call' && n.node.functionName.lexeme.toLowerCase() === 'case')
        ? n.node.args
        : [];
    const at = args.indexOf(chain[i + 1]!);
    for (const arg of args.slice(0, Math.max(at, 0))) out.push(exprSpan(source, arg));
  }
  return out;
}

/**
 * Whether a `fromJSON()` must give a boolean, so that comparing its value where it is set is the fix: it is all of
 * `continue-on-error:` or of a `with:` to a `type: boolean` input, or decides a condition by its truthiness. Not
 * `fromJSON(env.MATRIX)`, which a comparison would break.
 */
function wantsBoolean(index: ProjectIndex, at: At, node: TruthinessNode): boolean {
  const cond = conditionRoot(at.site);
  return cond ? truthinessNodes(cond).some((t) => t.expr === node.expr) : typedBoolean(index, at, node);
}

/**
 * Whether a `fromJSON()` is all of a field that takes a boolean and nothing else: `continue-on-error:`, or a `with:` to
 * a `type: boolean` input.
 */
function typedBoolean(index: ProjectIndex, { unit, site }: At, node: TruthinessNode): boolean {
  if (!isWholeExpression(site) || node.ancestors.some((a) => nodeOf(a).kind !== 'grouping')) return false;
  return site.yamlPath.at(-1) === 'continue-on-error' || toBooleanInput(index, unit, site);
}

/** Whether a site is a reusable workflow call's `with:` to a `type: boolean` input. */
function toBooleanInput(index: ProjectIndex, unit: UnitDecl, site: ExprSite): boolean {
  if (site.field !== 'job.with' || unit.kind !== 'workflow' || !site.job || !site.key) return false;
  const job = unit.jobs[site.job];
  const callee = job && index.calleeOf(job);
  return !!callee?.call && lookup(callee.call.inputs, site.key)?.type === 'boolean';
}

/**
 * The fix where the one expression that sets a value is (see `compareFix`), when it is in the reader's own unit: a
 * reusable workflow's or an action's output may have other readers, elsewhere.
 */
function producerFix(index: ProjectIndex, unit: UnitDecl, producers: Producer[]): Suggestion | undefined {
  const [p] = producers;
  if (
    producers.length !== 1 ||
    p?.unit !== unit ||
    !p.site ||
    !PRODUCERS[p.site.field] ||
    !isWholeExpression(p.site)
  )
    return undefined;
  return compareFix(index, p.unit, p.site);
}

/**
 * `!= ''` written after each operand of a value (the value itself, or each operand of its `||`) that may be text or '',
 * so that it is 'true' or 'false'. Only when each such operand is a reference that is nothing but text or '' (a
 * comparison binds tighter than `||`, so `a || x != ''` reads as meant); none when one is anything else, or is a boolean
 * too, which `!= ''` would turn into `true` whatever it was, nor in a single-quoted scalar.
 */
function compareFix(index: ProjectIndex, unit: UnitDecl, site: ExprSite): Suggestion | undefined {
  const seg = site.segments[0]!;
  const root = unwrap(seg.expr.ast!);
  const n = nodeOf(root);
  const operands = n.kind === 'logical' && n.node.operator.lexeme === '||' ? n.node.args : [root];
  const fixes = operands.map((op) => operandFix(index, { unit, site, seg }, op));
  if (fixes.includes(undefined)) return undefined;
  const edits = fixes.filter((f) => f !== null) as { edit: SourceEdit; name: string }[];
  const fileEdits =
    edits.length && !singleQuoted(index, site)
      ? segmentEdits(
          index,
          seg,
          edits.map((f) => f.edit),
        )
      : undefined;
  return (
    fileEdits && { title: `Compare ${edits.map((f) => f.name).join(' and ')} with ''`, edits: fileEdits }
  );
}

/**
 * The `!= ''` after an operand of a value (see `compareFix`): `null` for an operand that cannot be text or '', which
 * stays as it is, and `undefined` for one that cannot be fixed.
 */
function operandFix(
  index: ProjectIndex,
  at: At,
  op: Expr,
): { edit: SourceEdit; name: string } | null | undefined {
  const kind = kindOf(index, at.unit, at.site, at.seg, op);
  const textual = (p: { cls: string }) => p.cls === 'text' || p.cls === 'empty';
  if (!kind.some(textual)) return null;
  const ref = refAt(at.seg, op);
  if (!ref || !kind.every(textual)) return undefined;
  const end = exprSpan(at.seg.expr.source, op).end;
  return { edit: { span: { start: end, end }, newText: " != ''" }, name: `\`${refLabel(ref)}\`` };
}

/** Whether a site is a single-quoted YAML scalar, which would read the `''` a fix writes as one quote. */
const singleQuoted = (index: ProjectIndex, site: ExprSite) =>
  sourceOf(index, site.file)?.lines[site.loc.line - 1]?.[site.loc.column - 1] === "'";

/** An expression without the parentheses around it. */
function unwrap(e: Expr): Expr {
  const n = nodeOf(e);
  return n.kind === 'grouping' ? unwrap(n.node.group) : e;
}

/** Whether a node is the string 'true' or 'false', in any case (GitHub compares strings ignoring case). */
function isBooleanText(e: Expr): boolean {
  const n = nodeOf(e);
  if (n.kind !== 'literal' || !n.node.token.lexeme.startsWith("'")) return false;
  const text = n.node.literal.coerceString().toLowerCase();
  return text === 'true' || text === 'false';
}

/** The reference a comparison with 'true' or 'false' (`==`, `!=`) compares, and the literal. */
function comparedRef(at: At, { left, right, operator }: Binary) {
  if (operator.lexeme !== '==' && operator.lexeme !== '!=') return undefined;
  const [literal, value] = isBooleanText(right) ? [right, left] : isBooleanText(left) ? [left, right] : [];
  const ref = value && refAt(at.seg, value);
  return literal && value && ref ? { literal, value, ref } : undefined;
}

/** FP506 for a reference compared with 'true' or 'false' that can hold a boolean and other text. */
function checkComparison(ctx: RuleContext, at: At, binary: Binary): void {
  const compared = comparedRef(at, binary);
  const kind = compared && kindOf(ctx.index, at.unit, at.site, at.seg, compared.value);
  if (!compared || !kind || !isMixed(kind)) return;
  const { literal, value, ref } = compared;
  const source = at.seg.expr.source;
  const then = binary.operator.lexeme === '==' ? 'false' : 'true';
  ctx.report({
    message:
      `\`${refLabel(ref)}\` is compared with ${written(source, exprSpan(source, literal), 'a boolean')}, but it can ` +
      `hold other text, and the comparison is then ${then}: it is ${describeKind(kind)}`,
    loc: segmentLoc(ctx.index, at.seg, exprSpan(source, binary)) ?? at.seg.loc,
    severity: 'warning',
    symbol: ctx.index.resolveRef(at.unit, at.site, ref) ?? refLabel(ref),
    related: producersOf(ctx.index, at.unit, at.site, at.seg, value).map((p) => ({
      loc: p.loc,
      message: `${p.label} is set here, to 'true', 'false' or other text`,
    })),
  });
}

/**
 * The text operands of a value's `||` that gives a boolean or text: when an operand is a boolean (or 'true'/'false')
 * when it is true, and another is other text. None for any other value.
 */
function mixedOperands(index: ProjectIndex, at: At): Expr[] {
  const n = at.seg.expr.ast && nodeOf(unwrap(at.seg.expr.ast));
  if (n?.kind !== 'logical' || n.node.operator.lexeme !== '||') return [];
  const { args } = n.node;
  const kinds = args.map((op, i) => {
    const kind = kindOf(index, at.unit, at.site, at.seg, op);
    return i < args.length - 1 ? whenTruthy(kind) : kind;
  });
  const texts = args.filter((_, i) => kinds[i]!.some((p) => p.cls === 'text'));
  return kinds.some((k) => k.some((p) => isBooleanClass(p.cls))) ? texts : [];
}

/** FP506 for a value under `env:`, `with:` or `outputs:` whose `||` gives a boolean or text (see `mixedOperands`). */
function checkProducer(ctx: RuleContext, unit: UnitDecl, site: ExprSite): void {
  const seg = site.segments[0]!;
  const texts = mixedOperands(ctx.index, { unit, site, seg });
  if (texts.length === 0) return;
  const source = seg.expr.source;
  const sink = ctx.index.sinkOf(unit, site);
  const textOf = texts.map((t) => written(source, exprSpan(source, t), 'other text')).join(', ');
  ctx.report({
    message: `\`${producedName(ctx.index, site, sink)}\` is a boolean or the text of ${textOf}: \`||\` gives the first operand that is true as it is, not true or false`,
    loc: segmentLoc(ctx.index, seg, exprSpan(source, texts[0]!)) ?? seg.loc,
    severity: 'warning',
    ...(sink ? { symbol: sink } : {}),
    related: readers(ctx.index, unit, site),
    suggestions: [compareFix(ctx.index, unit, site)],
  });
}

/** What a value sets, for messages: `jobs.build.outputs.ok`, `env.OK`, or `with.ok` for an action's input. */
function producedName(index: ProjectIndex, site: ExprSite, sink: string | undefined): string {
  return site.field !== 'step.with' && sink
    ? (index.nodes.get(sink)?.label ?? sink)
    : `${PRODUCERS[site.field]}.${site.key}`;
}

/** Where a value is read, for a finding's related locations: the reads of what it sets, or of a step's own env. */
function readers(index: ProjectIndex, unit: UnitDecl, site: ExprSite): RelatedLocation[] {
  const sink = index.sinkOf(unit, site);
  const reads = sink
    ? index.usagesOf(sink).map((u) => ({ site: u.site, loc: u.ref.loc }))
    : ownEnvReads(unit, site);
  return reads.slice(0, 3).map((r) => ({
    loc: r.loc,
    message: r.site.field === 'workflow.output' ? `published as outputs.${r.site.key}` : 'read here',
  }));
}

/** The reads of a step's own env variable, set by `site`, in the rest of the step. */
function ownEnvReads(unit: UnitDecl, site: ExprSite): { site: ExprSite; loc: Loc }[] {
  const name = site.key?.toLowerCase();
  const inStep = unit.sites.filter(
    (s) => s.field !== 'step.env' && s.job === site.job && s.step === site.step && s.step !== undefined,
  );
  return inStep.flatMap((s) =>
    s.segments.flatMap((g) =>
      g.refs
        .filter((r) => r.context === 'env' && r.path[0]?.toLowerCase() === name)
        .map((r) => ({ site: s, loc: r.loc })),
    ),
  );
}

export const valueRules: RuleDefinition[] = [valueNotBoolean];
