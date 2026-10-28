import {
  type ActionUse,
  type Binding,
  type CallSite,
  type ContextResolver,
  chainTo,
  definitelyFalsy,
  definitelyTruthy,
  didYouMean,
  type ExprSite,
  evaluateTemplate,
  fallbacksOf,
  type InputDecl,
  isEmptyValue,
  type Json,
  known,
  type Loc,
  type LocatedRef,
  lookup,
  type ProjectIndex,
  readsContextDynamically,
  refsOf,
  sym,
  UNKNOWN,
  type UnitDecl,
  type Usage,
  usageReadsCallerEvent,
} from '@ciatlas/core';
import { booleanTermOf } from '../expr-ast';
import { isPublished } from '../impact';
import { interfaceCalls, interfaceUses, isExternal } from '../remotes';
import {
  addKeys,
  removeKey,
  renameAt,
  renameSegment,
  type SuggestedEdit,
  type Suggestion,
  stepWithPath,
  suggestion,
} from '../suggestions';
import { defineRule, type RelatedLocation, type RuleContext, type RuleDefinition } from './types';
import {
  chainRelated,
  didYouMeanNote,
  fallsBack,
  isProperty,
  isWholeExpression,
  listNames,
  namesKey,
  quote,
  stepsInScope,
  useInCondition,
} from './util';

/**
 * For every workflow with `workflow_dispatch`: its inputs read through `github.event.inputs` in it and in the workflows
 * and actions it calls. In a called workflow or an action, `github.event` is the triggering (top-level) workflow's
 * event: "the event payload in the called workflow is the same event payload from the calling workflow" (GitHub's docs).
 */
function eventInputReadsByRoot(index: ProjectIndex): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const root of index.project.workflows.values()) {
    if (!root.dispatch) continue;
    const every = Object.values(root.dispatch.inputs).map((input) => input.name.toLowerCase());
    out.set(root.path, eventInputReadsFrom(index, root, every));
  }
  return out;
}

/**
 * The dispatch inputs (lowercased) read through `github.event.inputs` in `root` and every workflow and action it
 * reaches: `every` input of `root` for a read that names none.
 */
function eventInputReadsFrom(index: ProjectIndex, root: UnitDecl, every: string[]): Set<string> {
  const names = new Set<string>();
  const seen = new Set<UnitDecl>();
  const queue: UnitDecl[] = [root];
  while (queue.length) {
    const unit = queue.shift()!;
    if (seen.has(unit)) continue;
    seen.add(unit);
    addEventInputReads(unit, names, every, unit === root);
    for (const call of index.callSites) if (call.caller === unit) queue.push(call.callee);
    for (const use of index.actionUses) if (use.unit === unit) queue.push(use.action);
  }
  return names;
}

/**
 * Adds the dispatch inputs a unit reads through `github.event.inputs`, lowercased (see `eventInputsRead`). The
 * dispatched workflow's own input defaults and `workflow_call` outputs are left out: GitHub evaluates them only when it
 * is called, with its caller's event. Those of a workflow it calls are evaluated with its event.
 */
function addEventInputReads(unit: UnitDecl, names: Set<string>, every: string[], dispatched: boolean): void {
  for (const { site, ref } of refsOf(unit)) {
    if (dispatched && onlyWhenCalled(site)) continue;
    for (const name of eventInputsRead(ref, every)) names.add(name);
  }
}

/** Whether GitHub evaluates a workflow's site only when the workflow is called. */
const onlyWhenCalled = (site: ExprSite) => site.field === 'input.default' || site.field === 'workflow.output';

/**
 * The dispatch inputs (lowercased) a reference reads through `github.event.inputs`: the one it names
 * (`github.event.inputs.target`), none (`github.event_name`), or `every` one when it reads them without naming one. It
 * does when it stops at an object that holds them (`toJSON(github)`, `toJSON(github.event)`,
 * `toJSON(github.event.inputs)`), or has a `*` filter or a computed key that may stand for `event`, `inputs` or the
 * input (`github.event.inputs.*`, `github.event.inputs[matrix.key]`, `github[matrix.key].inputs`). A name that is not
 * in `every` reads none: the dispatched workflow's event holds no such input, even when the workflow declares it for
 * `workflow_call`. GitHub looks properties up regardless of case.
 */
function eventInputsRead(ref: LocatedRef, every: string[]): string[] {
  if (ref.context !== 'github') return [];
  for (const [i, key] of ['event', 'inputs'].entries()) {
    const segment = ref.path[i];
    if (segment === undefined) return every;
    if (namesKey(segment) && segment.toLowerCase() !== key) return [];
  }
  const name = ref.path[2];
  if (!namesKey(name)) return every;
  const input = name.toLowerCase();
  return every.includes(input) ? [input] : [];
}

export function declaredInputs(unit: UnitDecl): Record<string, InputDecl> {
  if (unit.kind === 'action') return unit.inputs;
  return { ...(unit.dispatch?.inputs ?? {}), ...(unit.call?.inputs ?? {}) };
}

/**
 * Whether an omitted input is '': it is optional, and has no default or an empty one (see `emptyDefault`). GitHub
 * substitutes false for booleans and 0 for numbers; only strings become ''.
 */
export function emptyWhenOmitted(input: InputDecl): boolean {
  if (input.required || input.type === 'boolean' || input.type === 'number') return false;
  return !input.hasDefault || emptyDefault(input);
}

/**
 * Whether an input's default is '' (`default: ''`), or an expression that is '' or null whatever it reads
 * (`default: ${{ '' }}`): what GitHub passes for an omitted input anyway, so it changes nothing.
 */
function emptyDefault(input: InputDecl): boolean {
  if (input.default === '') return true;
  return !!input.defaultSite && isEmptyValue(evaluateTemplate(input.defaultSite.text, () => undefined));
}

/**
 * Where a callee declares something, for a finding's related locations: none for a remote interface, whose
 * declaration is in another repository (the finding names it).
 */
const declaredAt = (callee: UnitDecl, loc: Loc, message: string) =>
  isExternal(callee) ? [] : [{ loc, message }];

const missingRequiredInput = defineRule({
  code: 'FP101',
  name: 'missing-required-input',
  category: 'inputs',
  defaultSeverity: 'error',
  docs: {
    summary: 'A reusable workflow or local action is called without one of its required inputs.',
    why:
      'For reusable workflows GitHub fails the run when a required input is missing — even if the input also has a ' +
      '`default`, which is then never used. For composite actions `required` is not enforced at all: the step silently ' +
      'runs with an empty string (or the default), which is how test variants get skipped unnoticed.',
    fix: 'Pass the input under `with:`, or mark it `required: false` with a `default` if it is truly optional.',
    examples: {
      bad: `jobs:
  test:
    uses: ./.github/workflows/test.yml
    with:
      suite: unit
      # "config" is required by test.yml but not passed`,
      good: `jobs:
  test:
    uses: ./.github/workflows/test.yml
    with:
      suite: unit
      config: release`,
    },
  },
  check(ctx) {
    for (const call of interfaceCalls(ctx.index)) reportMissingCallInputs(ctx, call);
    for (const use of interfaceUses(ctx.index)) reportMissingActionInputs(ctx, use);
  },
});

/** FP101 for a reusable workflow call. */
function reportMissingCallInputs(ctx: RuleContext, call: CallSite): void {
  const inputs = call.callee.call?.inputs ?? {};
  for (const input of Object.values(inputs)) {
    // GitHub's parser rejects the call whenever a required input is missing, default or not.
    if (!input.required || lookup(call.job.with, input.name)) continue;
    ctx.report({
      message: `jobs.${call.job.id} calls ${call.callee.path} without required input ${quote(input.name)}`,
      loc: call.job.uses?.loc ?? call.job.loc,
      symbol: sym.input(call.callee.path, input.name),
      related: [
        ...chainRelated(chainTo(ctx.index, call.caller.path)),
        ...declaredAt(call.callee, input.loc, `${quote(input.name)} is declared required here`),
      ],
      fix: `Add \`${input.name}: <value>\` under \`with:\` of jobs.${call.job.id}.`,
      suggestions: [
        suggestion(`Add input ${quote(input.name)} under with:`, [
          addKeys(ctx.index, call.caller.source.path, ['jobs', call.job.id, 'with'], [input.name], ['uses']),
        ]),
      ],
    });
  }
}

/** FP101 for a step that uses a local action: a required input with a default is never missing there. */
function reportMissingActionInputs(ctx: RuleContext, use: ActionUse): void {
  for (const input of Object.values(use.action.inputs)) {
    if (!input.required || input.hasDefault || lookup(use.step.with, input.name)) continue;
    ctx.report({
      message: `Step ${use.step.id ?? `#${use.step.index + 1}`} uses ${use.action.path} without required input ${quote(input.name)} — GitHub will run it with an empty value`,
      loc: use.step.uses?.loc ?? use.step.loc,
      symbol: sym.input(use.action.path, input.name),
      related: declaredAt(use.action, input.loc, `${quote(input.name)} is declared required here`),
      fix: `Add \`${input.name}: <value>\` under the step's \`with:\`.`,
      suggestions: [
        suggestion(`Add input ${quote(input.name)} under with:`, [
          addKeys(
            ctx.index,
            use.unit.source.path,
            stepWithPath(use.job?.id, use.step.index),
            [input.name],
            ['uses'],
          ),
        ]),
      ],
    });
  }
}

const unknownInput = defineRule({
  code: 'FP102',
  name: 'unknown-input',
  category: 'inputs',
  defaultSeverity: 'error',
  docs: {
    summary: 'A caller passes an input the reusable workflow or local action does not declare.',
    why:
      'GitHub rejects undeclared inputs to reusable workflows, and ignores them (with a warning in the log) for actions. ' +
      'Usually it is a typo or a leftover after an input was renamed, so the value you meant to pass never arrives.',
    fix: 'Rename the key to the declared input, declare the input in the callee, or remove the stale binding.',
    examples: {
      bad: `with:
  confg: release   # test.yml declares "config"`,
      good: `with:
  config: release`,
    },
  },
  check(ctx) {
    const check = (
      bindings: Record<string, Binding>,
      inputs: Record<string, InputDecl>,
      callee: UnitDecl,
      declLoc: Binding['loc'] | undefined,
    ) => {
      const target = callee.path;
      const names = Object.keys(inputs);
      for (const b of Object.values(bindings)) {
        if (lookup(inputs, b.name)) continue;
        const guess = didYouMean(b.name, names);
        ctx.report({
          message: `${target} has no input ${quote(b.name)}${didYouMeanNote(guess)}`,
          loc: b.loc,
          symbol: sym.input(target, b.name),
          related: declLoc ? declaredAt(callee, declLoc, `declared inputs: ${listNames(names)}`) : [],
          fix: unknownInputFix(b.name, guess, callee),
          suggestions: [guess ? renameAt(ctx.index, b.loc, b.name, guess) : undefined],
        });
      }
    };
    for (const call of interfaceCalls(ctx.index)) {
      check(call.job.with, call.callee.call?.inputs ?? {}, call.callee, call.callee.call?.loc);
    }
    for (const use of interfaceUses(ctx.index)) {
      const first = Object.values(use.action.inputs)[0];
      check(use.step.with, use.action.inputs, use.action, first?.loc);
    }
  },
});

/**
 * FP102's fix: the input it most likely meant, else declaring it in the callee, or removing it; the callee of a remote
 * call is in another repository, so only removing it is up to the caller.
 */
function unknownInputFix(name: string, guess: string | undefined, callee: UnitDecl): string {
  if (guess) return `Rename ${quote(name)} to ${quote(guess)}.`;
  return isExternal(callee)
    ? `Remove ${quote(name)} from \`with:\`: ${callee.path} does not declare it. If a new version dropped it, its release notes may say what replaced it.`
    : `Declare ${quote(name)} in ${callee.path}, or remove it from \`with:\`.`;
}

function jsonKind(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

const inputTypeMismatch = defineRule({
  code: 'FP103',
  name: 'input-type-mismatch',
  category: 'inputs',
  defaultSeverity: 'error',
  docs: {
    summary: 'A literal value passed to a typed `workflow_call` input has the wrong type.',
    why:
      'Reusable workflow inputs are typed (`string`, `boolean`, `number`). Passing `"true"` (a string) to a boolean input ' +
      'fails the run when the call is evaluated, typically on a code path you did not test locally.',
    fix: 'Pass a value of the declared type (unquoted `true`/`false` for booleans, an unquoted number for numbers).',
    examples: {
      bad: `with:
  dry-run: "true"   # declared type: boolean`,
      good: `with:
  dry-run: true`,
    },
  },
  check(ctx) {
    for (const call of interfaceCalls(ctx.index)) {
      for (const b of Object.values(call.job.with)) checkLiteralType(ctx, call, b);
    }
  },
});

/** FP103 for one binding of a call: a value known before the run must have the type of a boolean or number input. */
function checkLiteralType(ctx: RuleContext, call: CallSite, b: Binding): void {
  const input = lookup(call.callee.call?.inputs ?? {}, b.name);
  const expected = input?.type;
  if (!input || !expected || !['boolean', 'number'].includes(expected)) return;
  const v = knownValue(b);
  if (!v.known) return;
  const actual = jsonKind(v.value);
  if (actual === expected) return;
  ctx.report({
    message: `Input ${quote(input.name)} of ${call.callee.path} is a ${expected}, but jobs.${call.job.id} passes a ${actual} (${JSON.stringify(v.value)})`,
    loc: b.valueLoc,
    symbol: sym.input(call.callee.path, input.name),
    related: declaredAt(call.callee, input.loc, `declared as type: ${expected}`),
    fix: literalTypeFix(expected, b.name, v.value),
  });
}

/** A binding's value as far as it is known before the run: the literal, or its expression evaluated without context. */
function knownValue(b: Binding): ReturnType<typeof evaluateTemplate> {
  return b.site
    ? evaluateTemplate(b.site.text, () => UNKNOWN)
    : { known: true as const, value: b.value, taint: [] };
}

/** FP103's fix: write a literal of the declared type. */
function literalTypeFix(expected: string, name: string, value: Json): string {
  return expected === 'boolean'
    ? `Use an unquoted boolean: \`${name}: ${String(value).toLowerCase() === 'true'}\`, or an expression that yields one.`
    : `Use an unquoted number for ${quote(name)}.`;
}

const unusedInput = defineRule({
  code: 'FP104',
  name: 'unused-input',
  category: 'inputs',
  defaultSeverity: 'warning',
  generatedFiles: 'skip',
  docs: {
    summary: 'An input is declared but never read anywhere in the workflow or action.',
    why:
      'Dead inputs accumulate in large interfaces: callers keep computing and passing values that go nowhere, and readers ' +
      'assume a knob works when it does not.',
    fix: 'Remove the input (and the callers’ bindings), or wire it to where it was meant to be used.',
    examples: {
      bad: `on:
  workflow_call:
    inputs:
      legacy-flag: { type: boolean }   # never referenced`,
      good: `# remove it, or use it:
if: inputs.legacy-flag`,
    },
  },
  check(ctx) {
    const dispatchReads = eventInputReadsByRoot(ctx.index);
    for (const unit of ctx.index.units()) {
      // JavaScript and Docker actions read inputs in code (`core.getInput`, INPUT_*), invisible to flowpact.
      if (unit.kind === 'action' && unit.using !== 'composite') continue;
      if (readsContextDynamically(unit, 'inputs')) continue;
      for (const input of Object.values(declaredInputs(unit))) {
        const symbol = sym.input(unit.path, input.name);
        if (ctx.index.usagesOf(symbol).length > 0) continue;
        if (dispatchReads.get(unit.path)?.has(input.name.toLowerCase())) continue;
        reportUnusedInput(ctx, unit, input, symbol);
      }
    }
  },
});

/** FP104's report, naming the local callers that still pass the input. */
function reportUnusedInput(ctx: RuleContext, unit: UnitDecl, input: InputDecl, symbol: string): void {
  const passed = (
    unit.kind === 'workflow'
      ? ctx.index.callersOf(unit.path).map((c) => lookup(c.job.with, input.name))
      : ctx.index.usersOf(unit.path).map((u) => lookup(u.step.with, input.name))
  ).filter((b): b is Binding => b !== undefined);
  const n = passed.length;
  ctx.report({
    message: `Input ${quote(input.name)} of ${unit.path} is never read${n ? ` (yet ${n} caller${n > 1 ? 's pass' : ' passes'} it)` : ''}`,
    loc: input.loc,
    symbol,
    related: passed.slice(0, 5).map((b) => ({ loc: b.loc, message: 'passed here' })),
    suggestions: [removeInputSuggestion(ctx, unit, input)],
  });
}

/**
 * FP104's fix: remove the input, and what local callers pass for it. None for a published workflow or action, or a
 * workflow's dispatch input: callers flowpact cannot see would then pass an input GitHub rejects.
 */
function removeInputSuggestion(ctx: RuleContext, unit: UnitDecl, input: InputDecl): Suggestion | undefined {
  if (isPublished(unit, ctx.config.impact)) return undefined;
  const declared = unit.kind === 'action' ? ['inputs'] : ['on', 'workflow_call', 'inputs'];
  const callers = callerBindingRemovals(ctx, unit, input.name);
  const n = callers.length;
  const title = n
    ? `Remove input ${quote(input.name)}, and what ${n} caller${n > 1 ? 's pass' : ' passes'} for it`
    : `Remove the unused input ${quote(input.name)}`;
  return suggestion(title, [
    removeKey(ctx.index, unit.source.path, declared, input.name, input.loc.line),
    ...callers,
  ]);
}

/** Edits removing what the local callers of a workflow or action pass for its input `name`. */
function callerBindingRemovals(
  ctx: RuleContext,
  unit: UnitDecl,
  name: string,
): (SuggestedEdit | undefined)[] {
  if (unit.kind === 'workflow')
    return ctx.index
      .callersOf(unit.path)
      .filter((c) => lookup(c.job.with, name))
      .map((c) => removeKey(ctx.index, c.caller.source.path, ['jobs', c.job.id, 'with'], name));
  return ctx.index
    .usersOf(unit.path)
    .filter((u) => lookup(u.step.with, name))
    .map((u) => removeKey(ctx.index, u.unit.source.path, stepWithPath(u.job?.id, u.step.index), name));
}

/** A local caller of a reusable workflow or action: the bindings it passes and where it calls. */
interface Caller {
  with: Record<string, Binding>;
  loc: Binding['loc'];
  label: string;
}

function callersOf(index: ProjectIndex, unit: UnitDecl): Caller[] {
  if (unit.kind === 'workflow')
    return index.callersOf(unit.path).map((c) => ({
      with: c.job.with,
      loc: c.job.uses?.loc ?? c.job.loc,
      label: `${c.caller.path} › jobs.${c.job.id}`,
    }));
  return index.usersOf(unit.path).map((u) => ({
    with: u.step.with,
    loc: u.step.uses?.loc ?? u.step.loc,
    label: `${u.unit.path} › ${u.job ? `jobs.${u.job.id} › ` : ''}step ${u.step.id ?? `#${u.step.index + 1}`}`,
  }));
}

const optionalInputInCondition = defineRule({
  code: 'FP105',
  name: 'optional-input-no-default-in-condition',
  category: 'inputs',
  defaultSeverity: 'warning',
  generatedFiles: 'skip',
  docs: {
    summary:
      "An optional input that is '' when omitted (no default, or `default: ''`) decides an `if:` by its truthiness.",
    why:
      'When a caller omits an optional input that has no default, GitHub passes an empty string. A condition such as ' +
      '`if: inputs.deploy` then takes the "false" branch: the job or step is skipped and the run is still green, so ' +
      'nothing tells the caller that the value they left out turned it off.',
    fix:
      'If it must run, make the input `required: true` or give it a non-empty `default`. If skipping is intended, say ' +
      "so where it is decided: `inputs.x != ''` (the same at run time, but explicit), or read the skipped step's " +
      "outputs through a fallback (`steps.token.outputs.token || github.token`). `default: ''` is not a fix: it is " +
      'what GitHub passes for an omitted input.',
    scope:
      "Not reported: comparisons with a constant, `contains()`-style tests, fallbacks inside a comparison or function argument (`startsWith(inputs.x || 'main', 'v')`), conditions that are true when the input is '' (`inputs.x || 'yes'`, `!inputs.x`), conditions with text around `${{ }}` (always true; actionlint reports them), and a step whose results are only read through a fallback that is not empty when the step is skipped (`steps.t.outputs.token || github.token`, not `|| ''` or the omitted input), in a condition that asks whether it ran (`if: steps.t.outcome == 'success'`) or that is true when it was skipped, as a whole (`!steps.t.outputs.token`, `always() || …`) or in the term that reads it (the operand of the nearest `&&` or `||` around the read, a comparison or function call around it included: `steps.t.outputs.x == ''` in `steps.t.outputs.x == '' && …`; false instead under an odd number of `!`: `steps.t.outputs.x == 'true'` in `!(steps.t.outputs.x == 'true' || …)`), or through a job output that is then '' and read one of those ways: the workflow then expects the step to be skipped. A step without an `id`, a job's `if:`, a condition that is false when the step was skipped (`!(steps.t.outputs.x == '')`), or a step whose outputs are also read as they are or gate another step (`if: steps.t.outputs.changed == 'true'`, also with `|| inputs.force`: skipped silently too) is still reported. Nor are inputs every local caller passes reported, unless the workflow can be dispatched or the unit is published (by default the root `action.yml` and reusable workflows whose file name does not start with `_`; see `impact.publish`), since callers in other repositories can still omit them. A `default` that is '' (`default: ''`, `default: ${{ '' }}`) counts as none. To accept the rule for one input in every workflow, use an override with `target: '**#inputs.<name>'`.",
    examples: {
      bad: `inputs:
  environment: { type: string, required: false }
...
- if: inputs.environment
  run: ./deploy.sh "\${{ inputs.environment }}"`,
      good: `inputs:
  environment: { type: string, required: false }
  app-id: { type: string, required: false }
...
# Skipping without an environment is intended: say so
- if: inputs.environment != ''
  run: ./deploy.sh "\${{ inputs.environment }}"
# Or let the consumers handle the skipped step
- id: app-token
  if: inputs.app-id
  uses: actions/create-github-app-token@v2
- uses: actions/checkout@v5
  with:
    token: \${{ steps.app-token.outputs.token || github.token }}`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      const callers = callersOf(ctx.index, unit);
      // Every local caller passing an input proves nothing for a unit other repositories use (the root action.yml, a
      // published reusable workflow: see `impact.publish`), nor for a workflow that can be dispatched without it.
      const published = isPublished(unit, ctx.config.impact);
      const callersDecide = callers.length > 0 && !(unit.kind === 'workflow' && unit.dispatch) && !published;
      const reads = optionalInputReads(ctx.index, unit, callers, callersDecide);
      reportOptionalInputReads(ctx, unit, reads, published && callers.length > 0);
    }
  },
});

/** A condition's read of an optional input, and the local callers that omit the input. */
interface OptionalRead {
  input: InputDecl;
  usage: Usage;
  omitting: Caller[];
}

/**
 * The condition reads FP105 reports in a unit, and per condition site the inputs it reads by value that every local
 * caller passes (so they are not flagged; `callersDecide` says whether the callers can prove that).
 */
function optionalInputReads(
  index: ProjectIndex,
  unit: UnitDecl,
  callers: Caller[],
  callersDecide: boolean,
): { flagged: OptionalRead[]; passedBySite: Map<number, string[]> } {
  const flagged: OptionalRead[] = [];
  const passedBySite = new Map<number, string[]>();
  for (const input of Object.values(declaredInputs(unit))) {
    if (!emptyWhenOmitted(input)) continue;
    const usages = decidingReads(index, unit, input);
    if (usages.length === 0) continue;
    const omitting = callers.filter((c) => !lookup(c.with, input.name));
    if (callersDecide && omitting.length === 0) {
      for (const usage of usages) addName(passedBySite, usage.site.id, input.name);
      continue;
    }
    for (const usage of usages) flagged.push({ input, usage, omitting });
  }
  return { flagged: unexpectedSkips(index, unit, decidedWhenOmitted(flagged)), passedBySite };
}

/**
 * The reads at conditions that leaving out their input can turn false. A condition that is true when the input is ''
 * (`inputs.x || 'yes'`, `!inputs.x`) skips nothing when a caller omits it. Each input is checked on its own: in
 * `inputs.a || !inputs.b`, omitting `a` while passing `b` skips the step, omitting `b` never does.
 */
function decidedWhenOmitted(flagged: OptionalRead[]): OptionalRead[] {
  return flagged.filter((r) => !trueWhenEmpty(r.usage.site, [r.usage.ref]));
}

/** Whether a whole-expression condition is true when `reads` are '', whatever the rest of it is. */
function trueWhenEmpty(site: ExprSite, reads: LocatedRef[]): boolean {
  const ast = site.segments[0]?.expr.ast;
  return !!ast && definitelyTruthy(ast, emptyAs(reads));
}

/** Resolves what any of `reads` reads (the same context and path, in any case) to '', and the rest to unknown. */
function emptyAs(reads: { context: string; path: string[] }[]): ContextResolver {
  const keys = new Set(reads.map(refKey));
  return (ref) => (keys.has(refKey(ref)) ? known('') : undefined);
}

const refKey = (ref: { context: string; path: string[] }) =>
  [ref.context, ...ref.path].join('.').toLowerCase();

/**
 * The reads of an input that decide a condition by its value. Comparisons with a constant (`inputs.x != ''`,
 * `inputs.x == 'yes'`), tests such as `contains()` and fallbacks handle the omitted case explicitly. A condition that
 * does so for the input is trusted with its other reads too (`inputs.x != '' && inputs.x != steps.s.outputs.current`);
 * otherwise only a value that decides the condition as it is gets reported. A whole read (`toJSON(inputs)`,
 * `inputs[matrix.key]`, see `Usage.whole`) does not single the input out, so it neither decides nor handles it. A
 * condition with text around its `${{ }}` is always true.
 */
function decidingReads(index: ProjectIndex, unit: UnitDecl, input: InputDecl): Usage[] {
  const inConditions = index
    .usagesOf(sym.input(unit.path, input.name))
    .filter((u) => u.site.isCondition && !u.whole && isWholeExpression(u.site))
    .map((u) => ({ u, use: useInCondition(u.site, u.ref) }));
  const handledSites = new Set(
    inConditions.filter((x) => x.use === 'compared' || x.use === 'fallback').map((x) => x.u.site.id),
  );
  return inConditions
    .filter((x) => (x.use === 'truthiness' || x.use === 'value') && !handledSites.has(x.u.site.id))
    .map((x) => x.u);
}

/**
 * The reads left once those at guards of skips the workflow expects are taken out (see `skipExpected`), each guard
 * judged with every input flagged at it '': a step skipped when they are omitted is not the silent skip FP105 is about.
 */
function unexpectedSkips(index: ProjectIndex, unit: UnitDecl, flagged: OptionalRead[]): OptionalRead[] {
  const inputsAt = new Map<number, string[]>();
  for (const { input, usage } of flagged) addName(inputsAt, usage.site.id, input.name);
  const expected = new Map<number, boolean>();
  return flagged.filter(({ usage: { site } }) => {
    if (!expected.has(site.id))
      expected.set(site.id, skipExpected(index, unit, site, inputsAt.get(site.id) ?? []));
    return !expected.get(site.id);
  });
}

/** A reference and the site it is in. */
type Read = { site: ExprSite; ref: LocatedRef };

/** What is known when a guarded step was skipped: step `id`'s results, and the reads in `empty` (`refKey`s) are ''. */
interface Skip {
  id?: string;
  empty: string[];
}

/**
 * Resolves a skipped step's outputs to '' and its `outcome` and `conclusion` to 'skipped' (ids in any case), the reads
 * in `empty` to '', and the rest to unknown.
 */
function skippedAs({ id, empty }: Skip): ContextResolver {
  const keys = new Set(empty);
  return (ref) => {
    if (keys.has(refKey(ref))) return known('');
    if (!id || ref.context !== 'steps' || ref.path[0]?.toLowerCase() !== id.toLowerCase()) return undefined;
    if (readsOutcome(ref)) return known('skipped');
    return ref.path[1]?.toLowerCase() === 'outputs' && namesKey(ref.path[2]) ? known('') : undefined;
  };
}

/** Whether a reference reads a step's `outcome` or `conclusion`: asks whether the step ran. */
const readsOutcome = (ref: { context: string; path: string[] }) =>
  ref.context === 'steps' && ['outcome', 'conclusion'].includes(ref.path[1]?.toLowerCase() ?? '');

/**
 * Whether a step's `if:` guards a step the workflow expects to be skipped: the step has an `id`, its results are read
 * after it, and every such read holds up when the step was skipped because `inputs` are '' (see `holdsWhenEmpty`).
 * Consumers written for the skipped step show that the skip was considered; they do not show that the step's own
 * effects are optional.
 */
function skipExpected(index: ProjectIndex, unit: UnitDecl, site: ExprSite, inputs: string[]): boolean {
  if (site.field !== 'step.if' || site.step === undefined) return false;
  const id = stepsInScope(unit, site.job)[site.step]?.id;
  const reads = id ? stepResultReads(unit, site.job, site.step, id) : undefined;
  const skip = { id, empty: inputs.map((name) => refKey({ context: 'inputs', path: [name] })) };
  return !!reads?.length && reads.every((r) => holdsWhenEmpty(index, unit, r, skip, 1));
}

/**
 * The reads of step `id`'s results (`steps.<id>.outputs.token`, `steps.<id>.outcome`) in the job or action of step
 * number `after`, in the steps after it and the job's outputs; earlier steps and the step itself cannot see them.
 * Undefined when one of those sites reads a step it does not name (`toJSON(steps)`, `steps[matrix.step]`).
 */
function stepResultReads(
  unit: UnitDecl,
  job: string | undefined,
  after: number,
  id: string,
): Read[] | undefined {
  const reads: Read[] = [];
  for (const read of refsOf(unit)) {
    const { site, ref } = read;
    if (ref.context !== 'steps' || site.job !== job || (site.step !== undefined && site.step <= after))
      continue;
    const step = ref.path[0];
    if (!namesKey(step)) return undefined;
    if (step.toLowerCase() === id.toLowerCase()) reads.push(read);
  }
  return reads;
}

/**
 * Whether a read of a skipped step's results holds up (`skip` says what is then known): in a condition, it asks
 * whether the step ran (`steps.t.outcome == 'success'`) or still runs its step then (see `conditionHolds`);
 * otherwise it is the subject of a fallback that is then not empty (`steps.t.outputs.token || github.token`, not
 * `|| ''`), or the value of a job output that holds up (see `jobOutputHolds`; `hops` job outputs are followed). Any
 * other read takes the value as it is.
 */
function holdsWhenEmpty(index: ProjectIndex, unit: UnitDecl, read: Read, skip: Skip, hops: number): boolean {
  const { site, ref } = read;
  const resolve = skippedAs(skip);
  if (site.isCondition) return readsOutcome(ref) || conditionHolds(site, ref, resolve);
  const seg = site.segments.find((s) => s.refs.includes(ref));
  if (seg && fallsBack(fallbacksOf(seg.expr), ref, [resolve])) return true;
  return hops > 0 && jobOutputHolds(index, unit, site, skip, hops);
}

/**
 * Whether a condition reading a skipped step's result (`ref`, not its `outcome`) still runs its step when `resolve` says
 * what is then known: the whole condition is true (`!steps.t.outputs.token`, `always() || …`), or the boolean term the
 * read is in (see `booleanTermOf`) takes the value that runs the step, so the read leaves the decision to the other
 * terms: true (`steps.t.outputs.x == ''` in `steps.t.outputs.x == '' && …`), or false under an odd number of `!`
 * (`steps.t.outputs.x == 'true'` in `!(steps.t.outputs.x == 'true' || …)`). Never when the whole condition is then
 * false (`!(steps.t.outputs.x == '')`). Not a gate such as `steps.t.outputs.changed == 'true' || inputs.force`, which
 * skips its step silently too when `force` is not passed. A condition with text around its `${{ }}` is always true.
 */
function conditionHolds(site: ExprSite, ref: LocatedRef, resolve: ContextResolver): boolean {
  const expr = site.segments[0]?.expr;
  if (!isWholeExpression(site) || !expr?.ast || definitelyTruthy(expr.ast, resolve)) return true;
  if (definitelyFalsy(expr.ast, resolve)) return false;
  const found = booleanTermOf(expr, ref.start);
  return !!found && (found.negated ? definitelyFalsy : definitelyTruthy)(found.term, resolve);
}

/** Whether `site` is a job output that is '' when the step is skipped, and every reader of it holds up then. */
function jobOutputHolds(
  index: ProjectIndex,
  unit: UnitDecl,
  site: ExprSite,
  skip: Skip,
  hops: number,
): boolean {
  if (site.field !== 'job.output' || !site.job || !site.key) return false;
  if (!isEmptyValue(evaluateTemplate(site.text, skippedAs(skip)))) return false;
  const output = { context: 'needs', path: [site.job, 'outputs', site.key] };
  const next = { empty: [...skip.empty, refKey(output)] };
  const readers = index.usagesOf(sym.jobOutput(unit.path, site.job, site.key));
  return (
    readers.length > 0 && readers.every((u) => !u.whole && holdsWhenEmpty(index, unit, u, next, hops - 1))
  );
}

/**
 * FP105's reports: one finding per input (each can be overridden on its own), naming the other inputs the same
 * condition reads: those reported too, and those every caller passes (why they are not reported).
 */
function reportOptionalInputReads(
  ctx: RuleContext,
  unit: UnitDecl,
  { flagged, passedBySite }: { flagged: OptionalRead[]; passedBySite: Map<number, string[]> },
  publishedWithCallers: boolean,
): void {
  const flaggedBySite = new Map<number, string[]>();
  for (const { input, usage } of flagged) addName(flaggedBySite, usage.site.id, input.name);
  for (const { input, usage, omitting } of flagged) {
    const others = (flaggedBySite.get(usage.site.id) ?? []).filter((n) => n !== input.name);
    const notes = conditionNotes(others, passedBySite.get(usage.site.id) ?? []);
    ctx.report({
      message:
        `Condition reads optional input ${quote(input.name)}, ${omittedValue(input)}` +
        (notes.length ? ` (${notes.join('; ')})` : ''),
      loc: usage.ref.loc,
      symbol: sym.input(unit.path, input.name),
      related: [
        declarationNote(input, publishedWithCallers && omitting.length === 0),
        ...omitting.slice(0, 3).map((c) => ({ loc: c.loc, message: `${c.label} omits it` })),
      ],
    });
  }
}

/** FP105's note at an input's empty default or declaration, saying why every caller passing it is not enough. */
function declarationNote(input: InputDecl, passedButPublished: boolean): RelatedLocation {
  const published = passedButPublished
    ? '; every caller here passes it, but this unit is published (see `impact.publish`), so callers in other repositories can omit it'
    : '';
  return input.hasDefault
    ? {
        loc: input.defaultLoc ?? input.loc,
        message: `\`default: ''\` changes nothing: an omitted input is '' anyway${published}`,
      }
    : { loc: input.loc, message: `declared optional without a default${published}` };
}

/** Why FP105 says an input is '' when omitted: it has no default, or an empty one. */
const omittedValue = (input: InputDecl) =>
  input.hasDefault
    ? "whose default '' is what GitHub passes when it is omitted"
    : "which has no default and is '' when omitted";

/** FP105's notes on the other inputs a condition reads: reported as well, or passed by every caller. */
function conditionNotes(others: string[], passed: string[]): string[] {
  return [
    ...(others.length
      ? [`so ${others.length > 1 ? 'are' : 'is'} ${others.map(quote).join(', ')}, read by the same condition`]
      : []),
    ...(passed.length
      ? [
          `${passed.map(quote).join(', ')}, also read by this condition, ${passed.length > 1 ? 'are' : 'is'} passed by every caller`,
        ]
      : []),
  ];
}

function addName(bySite: Map<number, string[]>, site: number, name: string): void {
  const names = bySite.get(site) ?? [];
  if (!names.includes(name)) names.push(name);
  bySite.set(site, names);
}

const passthroughDropped = defineRule({
  code: 'FP106',
  name: 'passthrough-dropped',
  category: 'inputs',
  defaultSeverity: 'info',
  docs: {
    summary: 'A caller passes a value to an input that the callee declares but never reads.',
    why:
      'In deep call chains values are often forwarded level by level. When one level stops using an input, every caller ' +
      'above it keeps passing data that is silently dropped.',
    fix: 'Stop passing the value here, or make the callee actually use (or forward) it.',
    examples: {
      bad: `jobs:
  build:
    uses: ./.github/workflows/build.yml
    with:
      target: linux
      verbose: true   # build.yml declares "verbose" but never reads it`,
      good: `jobs:
  build:
    uses: ./.github/workflows/build.yml
    with:
      target: linux`,
    },
  },
  check(ctx) {
    for (const call of ctx.index.callSites) {
      if (readsContextDynamically(call.callee, 'inputs')) continue;
      for (const b of Object.values(call.job.with)) {
        const input = lookup(call.callee.call?.inputs ?? {}, b.name);
        if (!input) continue;
        const reads = ctx.index.usagesOf(sym.input(call.callee.path, input.name));
        // A called workflow gets its caller's `github` context, event payload included, so reading the input only
        // through `github` (`github.event.inputs.<name>`, `toJSON(github)`, or the step's own env values that read
        // them) never takes in the value this call passes.
        if (reads.some((u) => !usageReadsCallerEvent(ctx.index, u))) continue;
        ctx.report({
          message: `jobs.${call.job.id} passes ${quote(b.name)} to ${call.callee.path}, which ${
            reads.length > 0
              ? 'reads it only through the github context, the caller’s when it is called'
              : 'never reads it'
          }`,
          loc: b.loc,
          symbol: sym.input(call.callee.path, input.name),
          related: [{ loc: input.loc, message: 'declared here, never read' }],
        });
      }
    }
  },
});

/** Whether a reference is `github.event.inputs…`, in any case (`github.Event.Inputs…`). */
function isEventInputs(ref: { context: string; path: string[] }): boolean {
  return ref.context === 'github' && isProperty(ref.path[0], 'event') && isProperty(ref.path[1], 'inputs');
}

const optionalForwardedToRequired = defineRule({
  code: 'FP107',
  name: 'optional-forwarded-to-required',
  category: 'inputs',
  defaultSeverity: 'warning',
  docs: {
    summary:
      "A required input of a callee is fed from an optional input that is '' when omitted (no default, or `default: ''`).",
    why:
      'The call looks complete, so GitHub never complains about the required input, but when the outer caller omits the ' +
      'optional value the callee receives an empty string. The "required" guarantee is lost one level up.',
    fix:
      "Make the outer input required too, give it a non-empty default, or add a non-empty fallback: `${{ inputs.x || 'value' }}`. " +
      'If the callee handles an empty value, make its input `required: false`. If the call is pointless without the ' +
      "value, skip it with `if: inputs.x != ''`.",
    examples: {
      bad: `# pipeline.yml
inputs:
  config: { type: string, required: false }
jobs:
  test:
    uses: ./.github/workflows/test.yml
    with:
      config: \${{ inputs.config }}   # test.yml: config is required`,
      good: `inputs:
  config: { type: string, required: true }`,
    },
  },
  check(ctx) {
    for (const call of ctx.index.callSites) {
      const outer = declaredInputs(call.caller);
      for (const b of Object.values(call.job.with)) checkForwarded(ctx, call, outer, b);
    }
  },
});

/** FP107 for one binding of a call: a required input must not be empty when the caller's own caller omits an input. */
function checkForwarded(
  ctx: RuleContext,
  call: CallSite,
  outer: Record<string, InputDecl>,
  b: Binding,
): void {
  const target = lookup(call.callee.call?.inputs ?? {}, b.name);
  if (!target?.required || !b.site) return;
  if (emptyWhenInputsOmitted(b.site, outer)) reportForwarded(ctx, call, outer, b, b.site, target);
}

/** Whether a `with:` value is '' (or null) when the inputs of the caller it reads are omitted. */
function emptyWhenInputsOmitted(site: ExprSite, outer: Record<string, InputDecl>): boolean {
  const v = evaluateTemplate(site.text, omittedInputs(outer));
  return v.known && (v.value === '' || v.value === null);
}

/**
 * FP107's report, at the first read of an omitted input. It names every input the value was evaluated without: an
 * input may only pick a branch (`inputs.x == 'a' && … || ''`), so the message says what was omitted, not where the
 * value comes from.
 */
function reportForwarded(
  ctx: RuleContext,
  call: CallSite,
  outer: Record<string, InputDecl>,
  b: Binding,
  site: ExprSite,
  target: InputDecl,
): void {
  const srcs = omittedReads(site, outer);
  ctx.report({
    message: `Required input ${quote(target.name)} of ${call.callee.path} is ${whenEmpty(srcs.map((s) => quote(s.decl.name)))}`,
    loc: srcs[0]?.loc ?? b.valueLoc,
    symbol: sym.input(call.callee.path, target.name),
    related: [
      ...srcs.map((s) => ({
        loc: s.decl.loc,
        message: s.decl.hasDefault ? "optional, default ''" : 'optional, no default',
      })),
      { loc: target.loc, message: `required by ${call.callee.path}` },
    ],
  });
}

/** The caller's inputs a value reads that are '' when omitted, in order, each with its first read. */
function omittedReads(site: ExprSite, outer: Record<string, InputDecl>): { decl: InputDecl; loc: Loc }[] {
  const omitted = new Map<string, { decl: InputDecl; loc: Loc }>();
  for (const ref of site.segments.flatMap((s) => s.refs)) {
    const decl = ref.context === 'inputs' && ref.path[0] ? lookup(outer, ref.path[0]) : undefined;
    if (!decl || !emptyWhenOmitted(decl) || omitted.has(decl.name)) continue;
    omitted.set(decl.name, { decl, loc: ref.loc });
  }
  return [...omitted.values()];
}

/** When FP107's value is empty, given the quoted names of the omitted inputs it reads. */
function whenEmpty(names: string[]): string {
  if (names.length === 0) return 'always empty';
  if (names.length === 1) return `empty when optional input ${names[0]} is omitted`;
  return `empty when optional inputs ${listNames(names)} are omitted`;
}

/** Resolves `inputs.<name>` to '' for the declared inputs that are '' when omitted; other references stay unknown. */
function omittedInputs(outer: Record<string, InputDecl>): ContextResolver {
  return ({ context, path }) => {
    if (context !== 'inputs' || !path[0]) return undefined;
    const src = lookup(outer, path[0]);
    if (src && emptyWhenOmitted(src)) return { known: true, value: '', taint: [] };
    return undefined;
  };
}

const undefinedInputRef = defineRule({
  code: 'FP108',
  name: 'undefined-input-ref',
  category: 'inputs',
  defaultSeverity: 'error',
  docs: {
    summary: 'An expression reads `inputs.<name>` that the workflow or action does not declare.',
    why: 'Undeclared inputs always evaluate to an empty value. This is usually a typo or a rename that missed a usage.',
    fix: 'Fix the name, or declare the input under `on.workflow_call.inputs` / `on.workflow_dispatch.inputs` / `inputs:`.',
    examples: {
      bad: `run: ./build.sh \${{ inputs.tagret }}`,
      good: `run: ./build.sh \${{ inputs.target }}`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      const inputs = declaredInputs(unit);
      const names = Object.keys(inputs);
      for (const { site, ref } of refsOf(unit)) {
        if (site.field !== 'input.default') checkInputRead(ctx, unit, inputs, names, ref);
      }
    }
  },
});

/** FP108 for one reference: the input it reads, if any, must be declared (`names` lists the declared ones). */
function checkInputRead(
  ctx: RuleContext,
  unit: UnitDecl,
  inputs: Record<string, InputDecl>,
  names: string[],
  ref: LocatedRef,
): void {
  const name = inputReadName(unit, ref);
  if (!namesKey(name) || lookup(inputs, name)) return;
  const guess = didYouMean(name, names);
  ctx.report({
    message: `${unit.path} has no input ${quote(name)}${didYouMeanNote(guess)}`,
    loc: ref.loc,
    symbol: sym.input(unit.path, name),
    ...(guess ? { fix: `Use \`inputs.${guess}\`.` } : {}),
    // `inputs.<name>`, or `github.event.inputs.<name>`: the name is the reference's last segment.
    suggestions: [guess ? renameSegment(ctx.index, ref.loc, ref.path.length, name, guess) : undefined],
  });
}

/**
 * The input a reference reads: `inputs.<name>`, or `github.event.inputs.<name>` (in any case) in a workflow that can be
 * dispatched.
 */
function inputReadName(unit: UnitDecl, ref: LocatedRef): string | undefined {
  if (ref.context === 'inputs') return ref.path[0];
  // Elsewhere `github.event` belongs to the triggering workflow, not to this unit.
  const dispatched = unit.kind === 'workflow' && unit.dispatch;
  return dispatched && isEventInputs(ref) ? ref.path[2] : undefined;
}

export const inputRules: RuleDefinition[] = [
  missingRequiredInput,
  unknownInput,
  inputTypeMismatch,
  unusedInput,
  optionalInputInCondition,
  passthroughDropped,
  optionalForwardedToRequired,
  undefinedInputRef,
];
