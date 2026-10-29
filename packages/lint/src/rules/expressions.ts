import type { Binary, Expr } from '@actions/expressions/ast';
import {
  type Binding,
  type Diagnostic,
  type ExprSegment,
  type ExprSite,
  type JobDecl,
  type Loc,
  type LocatedRef,
  lookup,
  type StepDecl,
  siteAt,
  sym,
  type UnitDecl,
  type WorkflowDecl,
} from '@ciatlas/core';
import {
  applyEdits,
  conditionRoot,
  exprSpan,
  isEmptyString,
  nodeOf,
  type SourceEdit,
  type Span,
  segmentEdits,
  segmentLoc,
  type TruthinessNode,
  tokenSpan,
  truthinessNodes,
} from '../expr-ast';
import { sourceOf } from '../suggestions';
import { declaredInputs, emptyWhenOmitted } from './inputs';
import { defineRule, type RuleContext, type RuleDefinition } from './types';
import { maybeWrittenEarlier, namesKey, quote } from './util';

const GITHUB_ENV_HINTS: Record<string, string> = {
  GITHUB_SHA: 'github.sha',
  GITHUB_REF: 'github.ref',
  GITHUB_REF_NAME: 'github.ref_name',
  GITHUB_REPOSITORY: 'github.repository',
  GITHUB_RUN_ID: 'github.run_id',
  GITHUB_RUN_NUMBER: 'github.run_number',
  GITHUB_ACTOR: 'github.actor',
  GITHUB_WORKSPACE: 'github.workspace',
  GITHUB_EVENT_NAME: 'github.event_name',
  GITHUB_HEAD_REF: 'github.head_ref',
  GITHUB_BASE_REF: 'github.base_ref',
  RUNNER_OS: 'runner.os',
  RUNNER_TEMP: 'runner.temp',
  RUNNER_ARCH: 'runner.arch',
};

const undefinedEnvRef = defineRule({
  code: 'FP501',
  name: 'undefined-env-ref',
  category: 'expressions',
  defaultSeverity: 'warning',
  docs: {
    summary:
      '`${{ env.NAME }}` reads a variable that is not defined at workflow, job or step level, nor written to `$GITHUB_ENV` earlier.',
    why:
      'The `env` context only contains variables set by the workflow itself — not runner defaults like `GITHUB_SHA`. ' +
      'Reads of anything else evaluate to an empty string.',
    fix: 'Define the variable under `env:`, write it to `$GITHUB_ENV` in an earlier step, or use the matching context (e.g. `github.sha`).',
    examples: {
      bad: `run: echo \${{ env.GITHUB_SHA }}`,
      good: `run: echo \${{ github.sha }}   # or "$GITHUB_SHA" in the shell`,
    },
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      for (const site of wf.sites) {
        if (site.field === 'workflow.env' || site.field === 'input.default') continue;
        checkEnvReads(ctx, wf, site);
      }
    }
  },
});

/** The job and step a site is in, if any. */
function siteScope(
  wf: WorkflowDecl,
  site: ExprSite,
): { job: JobDecl | undefined; step: StepDecl | undefined } {
  const job = site.job ? wf.jobs[site.job] : undefined;
  const step = job && site.step !== undefined ? job.steps[site.step] : undefined;
  return { job, step };
}

/** FP501 for the `env.<name>` reads of a site. */
function checkEnvReads(ctx: RuleContext, wf: WorkflowDecl, site: ExprSite): void {
  const { job, step } = siteScope(wf, site);
  for (const seg of site.segments) {
    for (const ref of seg.refs) {
      const name = ref.path[0];
      if (ref.context !== 'env' || !namesKey(name)) continue;
      if (envEntry(wf, job, step, name) || maybeWrittenEarlier(job?.steps, site, name)) continue;
      reportUndefinedEnv(ctx, wf, site, ref, name);
    }
  }
}

/** The entry under `env:` of the workflow, the job or the step that defines a variable, if any. */
function envEntry(
  wf: WorkflowDecl,
  job: JobDecl | undefined,
  step: StepDecl | undefined,
  name: string,
): Binding | undefined {
  return lookup(wf.env, name) || (job && lookup(job.env, name)) || (step && lookup(step.env, name));
}

/** FP501's report, with the matching context when the name is a runner variable (`env.GITHUB_SHA`). */
function reportUndefinedEnv(
  ctx: RuleContext,
  wf: WorkflowDecl,
  site: ExprSite,
  ref: LocatedRef,
  name: string,
): void {
  const hint = GITHUB_ENV_HINTS[name.toUpperCase()];
  ctx.report({
    message: `env.${name} is not defined in this scope${hint ? ` — runner variables are not in the env context; use ${hint}` : ''}`,
    loc: ref.loc,
    symbol: sym.env(wf.path, site.job, name),
    ...(hint ? { fix: `Replace \`env.${name}\` with \`${hint}\`.` } : {}),
  });
}

const expressionParseError = defineRule({
  code: 'FP502',
  name: 'expression-parse-error',
  category: 'expressions',
  defaultSeverity: 'error',
  docs: {
    summary: 'A `${{ }}` expression (or an `if:` condition) cannot be parsed.',
    why: 'GitHub rejects the workflow when it is triggered, or fails the step that contains the expression.',
    fix: 'Fix the syntax: strings use single quotes, `==` for equality, and every `${{` needs a closing `}}`.',
    examples: {
      bad: `if: \${{ inputs.mode = "release" }}`,
      good: `if: \${{ inputs.mode == 'release' }}`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      for (const site of unit.sites) {
        for (const seg of site.segments) if (seg.expr.error) reportParseError(ctx, seg, seg.expr.error);
      }
    }
  },
});

/** FP502 for a segment whose expression does not parse: on one line, it points at the error's offset. */
function reportParseError(
  ctx: RuleContext,
  seg: ExprSegment,
  error: { offset: number; message: string },
): void {
  const loc = { ...seg.loc };
  if (seg.loc.line === seg.loc.endLine) {
    loc.column = seg.loc.column + error.offset;
    loc.endColumn = Math.max(loc.column + 1, seg.loc.endColumn);
  }
  ctx.report({
    message: `Invalid expression ${quote(seg.expr.source.length > 60 ? `${seg.expr.source.slice(0, 57)}...` : seg.expr.source)}: ${error.message}`,
    loc,
  });
}

const schemaViolation = defineRule({
  code: 'FP503',
  name: 'schema-violation',
  category: 'expressions',
  defaultSeverity: 'error',
  docs: {
    summary:
      'The file does not match GitHub’s workflow / action schema (validated with GitHub’s own parser).',
    why:
      'GitHub refuses to run a workflow or action with schema errors, often only when the trigger fires. Some keys it ' +
      'accepts and ignores instead, such as a top-level `env:` in action.yml, a filter the event does not support or a ' +
      'YAML merge key under an event. Those are reported as warnings: the file runs, but without the setting. ' +
      'The configured severity caps both kinds, so `FP503: warning` also reports schema errors as warnings, and ' +
      'ignored keys are never reported above warning.',
    fix:
      'Correct the key or value reported. Most messages come from @actions/workflow-parser, the parser GitHub’s ' +
      'tooling uses; for a key GitHub ignores, the warning says what is lost and how to fix it.',
    examples: {
      bad: `# action.yml
env:
  UV_VERSION: 0.9.0   # ignored: actions have no top-level env
runs:
  using: composite
  steps:
    - uses: astral-sh/setup-uv@v7
      with:
        version: \${{ env.UV_VERSION }}`,
      good: `# action.yml
inputs:
  uv-version:
    default: 0.9.0
runs:
  using: composite
  steps:
    - uses: astral-sh/setup-uv@v7
      with:
        version: \${{ inputs.uv-version }}`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      // Invalid expressions the site's own parse finds too are FP502's, which shows the expression and the position
      // in it; they are reported here only when FP502 does not run.
      const fp502 = ctx.runs('FP502');
      for (const e of unit.schemaErrors) {
        if (e.kind === 'context' || (e.kind === 'expression' && e.siteError && fp502)) continue;
        ctx.report({
          message: e.message,
          loc: e.loc,
          ...(e.fix ? { fix: e.fix } : {}),
          // GitHub runs the file without the key: worth fixing, but not a failed run.
          ...(e.kind === 'ignored' ? { severity: 'warning' as const } : {}),
        });
      }
    }
  },
});

const contextNotAvailable = defineRule({
  code: 'FP505',
  name: 'context-not-available',
  category: 'expressions',
  defaultSeverity: 'error',
  docs: {
    summary:
      'An expression uses a context or function that GitHub does not allow in that field (e.g. `env` in a reusable workflow call’s `with:`).',
    why:
      'GitHub only makes some contexts available per field. `env` is not passed to reusable workflows and cannot be used in ' +
      '`jobs.<id>.with` or `jobs.<id>.if`; `secrets` cannot be used in `if:`. GitHub rejects the whole workflow when it is ' +
      'triggered — often only on the branch or event that reaches it. Reported by GitHub’s own parser.',
    fix: 'Use a context that is available there: pass values through `inputs`/`vars`, compute them in an earlier job and read `needs.<job>.outputs`, or move the check into a step (`if: env.X == ...` works in steps).',
    examples: {
      bad: `env:
  TARGET: prod
jobs:
  deploy:
    uses: ./.github/workflows/deploy.yml
    with:
      target: \${{ env.TARGET }}   # env is not available here`,
      good: `jobs:
  deploy:
    uses: ./.github/workflows/deploy.yml
    with:
      target: \${{ vars.TARGET }}`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      // 1. What GitHub's own parser reports (expressions inside ${{ }}).
      for (const e of unit.schemaErrors) if (e.kind === 'context') reportParserContextError(ctx, unit, e);
      // 2. Bare `if:` conditions, which the parser does not validate, against GitHub's context-availability table.
      for (const site of unit.sites) checkBareCondition(ctx, unit, site);
    }
  },
});

/** What GitHub does when a unit uses a context or function where it is not available. */
const rejection = (unit: UnitDecl) =>
  unit.kind === 'workflow' ? 'GitHub rejects the workflow' : 'GitHub fails the step using the action';

/** FP505 for a context error of GitHub's parser, pointed at the reference it names. */
function reportParserContextError(ctx: RuleContext, unit: UnitDecl, e: Diagnostic): void {
  const name = /'([^']+)'/.exec(e.message)?.[1];
  ctx.report({
    message: `${name ? `\`${name}\`` : 'This context'} is not available here — ${rejection(unit)} ("${e.message}")`,
    loc: refLocFor(unit.sites, e, name) ?? e.loc,
  });
}

/** FP505 for a bare `if:` (no `${{ }}`): the contexts and functions it uses must be available in that field. */
function checkBareCondition(ctx: RuleContext, unit: UnitDecl, site: ExprSite): void {
  if (!site.isCondition || site.text.includes('${{')) return;
  const table = CONDITION_TABLES[`${unit.kind}:${site.field}`];
  if (!table) return;
  const rejects = rejection(unit);
  for (const seg of site.segments) {
    for (const ref of seg.refs) {
      if (table.contexts.has(ref.context)) continue;
      ctx.report({
        message: `\`${ref.context}\` is not available in ${table.label} — ${rejects} ("Unrecognized named-value: '${ref.context}'")`,
        loc: ref.loc,
      });
    }
    if (table.functions) checkConditionFunctions(ctx, seg, table.label, table.functions, rejects);
  }
}

/** FP505 for the functions a bare condition calls, other than the standard ones and those its field allows. */
function checkConditionFunctions(
  ctx: RuleContext,
  seg: ExprSegment,
  label: string,
  allowed: Set<string>,
  rejects: string,
): void {
  for (const fn of functionCalls(seg.expr.source)) {
    const name = fn.name.toLowerCase();
    if (STANDARD_FUNCTIONS.has(name) || allowed.has(name)) continue;
    ctx.report({
      message: `\`${fn.name}()\` is not available in ${label} — ${rejects} ("Unrecognized function: '${fn.name}'")`,
      loc: seg.expr.source.includes('\n')
        ? seg.loc
        : {
            ...seg.loc,
            column: seg.loc.column + fn.offset,
            endLine: seg.loc.line,
            endColumn: seg.loc.column + fn.offset + fn.name.length,
          },
    });
  }
}

/** Function names called in an expression (outside string literals), with their offset. */
function functionCalls(source: string): { name: string; offset: number }[] {
  const blanked = source.replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));
  return [...blanked.matchAll(/(?<![\w.-])([A-Za-z_]\w*)\s*\(/g)].map((m) => ({
    name: m[1]!,
    offset: m.index,
  }));
}

const STANDARD_FUNCTIONS = new Set([
  'case',
  'contains',
  'startswith',
  'endswith',
  'format',
  'join',
  'tojson',
  'fromjson',
]);
const STATUS_FUNCTIONS = ['always', 'success', 'failure', 'cancelled'];

/**
 * https://docs.github.com/actions/learn-github-actions/contexts#context-availability and GitHub's workflow and action
 * schemas: contexts (and, where they are restricted, functions) allowed in each bare condition.
 */
const CONDITION_TABLES: Record<string, { label: string; contexts: Set<string>; functions?: Set<string> }> = {
  'workflow:job.if': {
    label: "a job's `if:`",
    contexts: new Set(['github', 'needs', 'vars', 'inputs']),
    functions: new Set(STATUS_FUNCTIONS),
  },
  'workflow:step.if': {
    label: "a step's `if:`",
    contexts: new Set([
      'github',
      'needs',
      'strategy',
      'matrix',
      'job',
      'runner',
      'env',
      'vars',
      'steps',
      'inputs',
    ]),
  },
  'action:step.if': {
    label: "a composite action step's `if:`",
    contexts: new Set(['github', 'inputs', 'strategy', 'matrix', 'steps', 'job', 'runner', 'env']),
  },
  'action:action.runs-if': {
    label: "an action's `pre-if:`/`post-if:`",
    contexts: new Set(['runner', 'github', 'job', 'strategy', 'matrix', 'env', 'inputs']),
  },
};

/** Maps a parser error to the offending reference: the parser's own range is off for multi-line scalars. */
function refLocFor(sites: ExprSite[], e: Diagnostic, name: string | undefined): Loc | undefined {
  if (!e.at || !name) return undefined;
  const site = siteAt(sites, e.at);
  for (const seg of site?.segments ?? [])
    for (const r of seg.refs) if (r.context === name.toLowerCase()) return r.loc;
  return site?.loc;
}

const yamlSyntaxError = defineRule({
  code: 'FP504',
  name: 'yaml-syntax-error',
  category: 'expressions',
  defaultSeverity: 'error',
  docs: {
    summary: 'The file is not valid YAML.',
    why: 'Nothing in the file can run, and every analysis of it is incomplete.',
    fix: 'Fix the YAML syntax at the reported position (indentation, a `: ` inside an unquoted value, duplicate keys).',
    examples: {
      bad: `steps:
  - run: echo Deploying to: production   # a second ": " in an unquoted value`,
      good: `steps:
  - run: 'echo Deploying to: production'`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      for (const e of unit.parseErrors) ctx.report({ message: e.message, loc: e.loc });
    }
  },
});

const redundantEmptyComparison = defineRule({
  code: 'FP507',
  name: 'redundant-empty-comparison',
  category: 'expressions',
  defaultSeverity: 'off',
  generatedFiles: 'skip',
  docs: {
    summary: "A condition compares a value with `''` (`!= ''`, `== ''`), which `if:` already does by itself.",
    why:
      "An `if:` treats `''`, `null`, `0` and `false` as false and every other value as true, so `x != ''` decides it " +
      "the same way as `x`, and `x == ''` as `!x`. Outside a condition the comparison matters: under `env:`, `with:` " +
      'or `outputs:` it turns the value into `true` or `false`, and `continue-on-error:` accepts only a boolean.',
    fix: "Remove the comparison: `x != ''` becomes `x`, and `x == ''` becomes `!x`. The editor offers it as a quick fix where the change is certain.",
    scope:
      "Only a comparison with the string `''` that decides the condition: the whole `if:`, or an operand of `!`, `&&` " +
      "or `||` in it. Not `!= null`, `!= 0` or `!= false`, which differ for `'0'`; not inside a comparison, a function's " +
      'arguments (`case()` requires real booleans) or an `if:` with text around its `${{ }}`, which is always true; ' +
      'not under `env:`, `with:`, `outputs:` or `continue-on-error:`. While FP105 runs, not for an optional input ' +
      "without a default: FP105 reports one decided by its truthiness, and counts `!= ''` as handling the omitted case. " +
      'Nor a condition that a YAML alias shares with another key (`if: *flag`), whose text may be a value. Off by ' +
      'default: the comparison is harmless, and some prefer it written out; turn it on with `FP507: info`. The quick ' +
      'fix is offered for a condition written on one line, not in a single-quoted YAML string, in a file with LF line ' +
      "endings; not for a value in parentheses (`(a || b) != ''`) or a matrix value (YAML's `.nan` compares " +
      'otherwise), nor when the condition would then start with `!` without `${{ }}`, which YAML reads as a tag.',
    examples: {
      bad: "if: ${{ steps.patch.outputs.file != '' && steps.check.outputs.skip == '' }}",
      good: 'if: ${{ steps.patch.outputs.file && !steps.check.outputs.skip }}',
    },
  },
  check(ctx) {
    const shared = sharedText(ctx);
    for (const unit of ctx.index.units()) {
      const found = unit.sites.flatMap(emptyComparisons).filter((f) => !shared.has(locKey(f.site.loc)));
      if (found.length === 0) continue;
      const skipped = fp105Reads(ctx, unit);
      for (const f of found) if (!readsAny(f.site, f.other, skipped)) reportEmptyComparison(ctx, f);
    }
  },
});

const locKey = (loc: Loc) => `${loc.file}:${loc.line}:${loc.column}`;

/**
 * Where a YAML alias shares a scalar with its anchor (`if: *flag`): the sites of both point at the anchored text, which
 * may be a value (`env: { FLAG: &flag ${{ x != '' }} }`). The comparison decides the value there, so it is not FP507's.
 */
function sharedText(ctx: RuleContext): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const unit of ctx.index.units())
    for (const site of unit.sites) {
      const key = locKey(site.loc);
      if (seen.has(key)) shared.add(key);
      seen.add(key);
    }
  return shared;
}

/** The comparisons with `''` that decide a site's condition. */
function emptyComparisons(site: ExprSite): EmptyComparison[] {
  const root = conditionRoot(site);
  if (!root) return [];
  return truthinessNodes(root).flatMap((node) => emptyComparison(site, node) ?? []);
}

/** A comparison with `''` that decides a condition: FP507's finding. */
interface EmptyComparison {
  /** A whole-expression condition. */
  site: ExprSite;
  /** Its expression's source. */
  source: string;
  node: TruthinessNode;
  binary: Binary;
  /** `!=` or `==`. */
  operator: string;
  /** The value compared: a reference, a call or a grouping. */
  other: Span;
  /** The operator and the `''`, where the finding points (the editor fades it). */
  comparison: Span;
  /** The value is a grouping, which has no suggestion. */
  grouped: boolean;
}

/**
 * A node that compares a value with `''` by `!=` or `==`, when the comparison has the value's truthiness: the value is
 * a reference, a call other than `case()`, or a grouping that cannot be `NaN`. Only `NaN` compares otherwise, which a
 * literal or `case()` can return, and a matrix written in YAML (`.nan`); other contexts are JSON.
 */
function emptyComparison(site: ExprSite, node: TruthinessNode): EmptyComparison | undefined {
  const source = site.segments[0]!.expr.source;
  const n = nodeOf(node.expr);
  if (n.kind !== 'binary' || !['!=', '=='].includes(n.node.operator.lexeme)) return undefined;
  const { left, right, operator } = n.node;
  const other = isEmptyString(right) ? left : isEmptyString(left) ? right : undefined;
  if (!other || !comparable(other)) return undefined;
  const op = tokenSpan(source, operator);
  const literal = exprSpan(source, other === left ? right : left);
  return {
    site,
    source,
    node,
    binary: n.node,
    operator: operator.lexeme,
    other: exprSpan(source, other),
    comparison:
      other === left ? { start: op.start, end: literal.end } : { start: literal.start, end: op.end },
    grouped: nodeOf(other).kind === 'grouping',
  };
}

/** Whether a value compares with `''` as its truthiness decides (see `emptyComparison`). */
function comparable(e: Expr): boolean {
  const n = nodeOf(e);
  switch (n.kind) {
    case 'context':
    case 'index':
      return true;
    case 'call':
      return n.node.functionName.lexeme.toLowerCase() !== 'case';
    case 'grouping':
      return !mayBeNaN(n.node.group);
    default:
      return false;
  }
}

/** Whether an expression may be `NaN`: only through a `NaN` literal or `case()`, which returns an operand as it is. */
function mayBeNaN(e: Expr): boolean {
  const n = nodeOf(e);
  if (n.kind === 'literal') return n.node.token.lexeme === 'NaN';
  if (n.kind === 'call') return n.node.functionName.lexeme.toLowerCase() === 'case';
  if (n.kind === 'grouping') return mayBeNaN(n.node.group);
  if (n.kind === 'logical') return n.node.args.some(mayBeNaN);
  return false;
}

/**
 * The reads, as `<site id>:<offset>`, of a unit's optional inputs without a default, while FP105 runs: FP105 counts
 * `inputs.x != ''` as handling the omitted case and reports `inputs.x` alone, so removing the comparison would trade
 * one finding for another.
 */
function fp105Reads(ctx: RuleContext, unit: UnitDecl): Set<string> {
  const reads = new Set<string>();
  if (!ctx.runs('FP105')) return reads;
  for (const input of Object.values(declaredInputs(unit))) {
    if (!emptyWhenOmitted(input)) continue;
    for (const u of ctx.index.usagesOf(sym.input(unit.path, input.name)))
      reads.add(`${u.site.id}:${u.ref.start}`);
  }
  return reads;
}

/** Whether a span of a whole-expression site reads one of `reads` (see `fp105Reads`). */
const readsAny = (site: ExprSite, span: Span, reads: Set<string>) =>
  site.segments[0]!.refs.some(
    (r) => r.start >= span.start && r.start < span.end && reads.has(`${site.id}:${r.start}`),
  );

/** FP507's report, at the operator and the `''`, with the edits that remove them when the change is certain. */
function reportEmptyComparison(ctx: RuleContext, found: EmptyComparison): void {
  const { site } = found;
  const seg = site.segments[0]!;
  // YAML reads `.nan` as NaN, the one value that compares otherwise, and a matrix can list it.
  const readsMatrix = seg.refs.some(
    (r) => r.context === 'matrix' && r.start >= found.other.start && r.start < found.other.end,
  );
  const fix = found.grouped || readsMatrix ? undefined : emptyComparisonFix(found);
  const edits =
    fix && !startsTag(ctx, site, applyEdits(found.source, fix.edits))
      ? segmentEdits(ctx.index, seg, fix.edits)
      : undefined;
  ctx.report({
    message:
      found.operator === '=='
        ? "`== ''` is a negation in a condition, which already treats '' as false"
        : "`!= ''` is redundant in a condition, which already treats '' as false",
    loc: segmentLoc(ctx.index, seg, found.comparison) ?? seg.loc,
    ...(fix && edits ? { suggestions: [{ title: fix.title, edits }] } : {}),
  });
}

/**
 * The edits that remove a comparison with `''`: `x != ''` becomes `x`, `x == ''` becomes `!x`, and `!(x == '')`
 * becomes `x` rather than `!(!x)`. Each deletes text or writes `!`, never text from the file. Removing `!= ''` needs no
 * parentheses: the value binds at least as tightly as the comparison, and its parent is `&&`, `||`, `!` or a grouping;
 * nor does writing `!` before a reference or a call, which binds tighter than any operator.
 */
function emptyComparisonFix({ source, node, binary, operator, other }: EmptyComparison): {
  title: string;
  edits: SourceEdit[];
} {
  const whole = exprSpan(source, binary);
  const otherFirst = whole.start === other.start;
  // `x != ''`: from the end of `x`; `'' != x`: up to its start. The spaces around the operator go with it.
  const removed: Span = otherFirst
    ? { start: other.end, end: whole.end }
    : { start: whole.start, end: other.start };
  if (operator === '!=') return { title: "Remove `!= ''`", edits: [{ span: removed, newText: '' }] };
  const negation = negationOf(node);
  if (negation) {
    const outer = exprSpan(source, negation);
    return {
      title: "Remove `!(… == '')`",
      edits: [
        { span: { start: outer.start, end: other.start }, newText: '' },
        { span: { start: other.end, end: outer.end }, newText: '' },
      ],
    };
  }
  return {
    title: "Replace `== ''` with `!`",
    edits: otherFirst
      ? [
          { span: { start: other.start, end: other.start }, newText: '!' },
          { span: removed, newText: '' },
        ]
      : [{ span: removed, newText: '!' }],
  };
}

/** The `!` of `!(x == '')`: the ancestor `!` whose operand is the comparison, inside one grouping or more. */
function negationOf(node: TruthinessNode): Expr | undefined {
  const { ancestors } = node;
  let i = ancestors.length - 1;
  while (i >= 0 && nodeOf(ancestors[i]!).kind === 'grouping') i--;
  return i >= 0 && i < ancestors.length - 1 && nodeOf(ancestors[i]!).kind === 'unary'
    ? ancestors[i]
    : undefined;
}

/**
 * Whether an edited condition would start with `!` in a plain YAML scalar without `${{ }}`, which YAML reads as a tag
 * (GitHub's docs: use `${{ }}` "or escape with '', "", or () when the expression starts with `!`").
 */
function startsTag(ctx: RuleContext, site: ExprSite, edited: string): boolean {
  if (!edited.startsWith('!') || site.text.includes('${{')) return false;
  const first = sourceOf(ctx.index, site.file)?.lines[site.loc.line - 1]?.[site.loc.column - 1];
  return !['"', "'", '|', '>'].includes(first ?? '');
}

export const expressionRules: RuleDefinition[] = [
  contextNotAvailable,
  undefinedEnvRef,
  expressionParseError,
  schemaViolation,
  yamlSyntaxError,
  redundantEmptyComparison,
];
