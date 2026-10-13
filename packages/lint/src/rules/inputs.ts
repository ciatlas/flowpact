import {
  type ActionUse,
  type Binding,
  type CallSite,
  type ContextResolver,
  chainTo,
  didYouMean,
  type ExprSite,
  evaluateTemplate,
  type InputDecl,
  type Json,
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
import { isPublished } from '../impact';
import { defineRule, type RuleContext, type RuleDefinition } from './types';
import { chainRelated, didYouMeanNote, isProperty, listNames, namesKey, quote, useInCondition } from './util';

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

function declaredInputs(unit: UnitDecl): Record<string, InputDecl> {
  if (unit.kind === 'action') return unit.inputs;
  return { ...(unit.dispatch?.inputs ?? {}), ...(unit.call?.inputs ?? {}) };
}

/**
 * Whether an omitted input is '': it is optional and has no default. GitHub substitutes false for booleans and 0 for
 * numbers; only strings become ''.
 */
function emptyWhenOmitted(input: InputDecl): boolean {
  return !input.required && !input.hasDefault && input.type !== 'boolean' && input.type !== 'number';
}

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
    for (const call of ctx.index.callSites) reportMissingCallInputs(ctx, call);
    for (const use of ctx.index.actionUses) reportMissingActionInputs(ctx, use);
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
        { loc: input.loc, message: `${quote(input.name)} is declared required here` },
      ],
      fix: `Add \`${input.name}: <value>\` under \`with:\` of jobs.${call.job.id}.`,
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
      related: [{ loc: input.loc, message: `${quote(input.name)} is declared required here` }],
      fix: `Add \`${input.name}: <value>\` under the step's \`with:\`.`,
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
      target: string,
      declLoc: Binding['loc'] | undefined,
    ) => {
      const names = Object.keys(inputs);
      for (const b of Object.values(bindings)) {
        if (lookup(inputs, b.name)) continue;
        const guess = didYouMean(b.name, names);
        ctx.report({
          message: `${target} has no input ${quote(b.name)}${didYouMeanNote(guess)}`,
          loc: b.loc,
          symbol: sym.input(target, b.name),
          related: declLoc ? [{ loc: declLoc, message: `declared inputs: ${listNames(names)}` }] : [],
          fix: guess
            ? `Rename ${quote(b.name)} to ${quote(guess)}.`
            : `Declare ${quote(b.name)} in ${target}, or remove it from \`with:\`.`,
        });
      }
    };
    for (const call of ctx.index.callSites) {
      check(call.job.with, call.callee.call?.inputs ?? {}, call.callee.path, call.callee.call?.loc);
    }
    for (const use of ctx.index.actionUses) {
      const first = Object.values(use.action.inputs)[0];
      check(use.step.with, use.action.inputs, use.action.path, first?.loc);
    }
  },
});

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
    for (const call of ctx.index.callSites) {
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
    related: [{ loc: input.loc, message: `declared as type: ${expected}` }],
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
  });
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
    summary: 'An optional input without a default decides an `if:` condition by its truthiness.',
    why:
      'When a caller omits an optional input that has no default, GitHub substitutes an empty string. A condition such ' +
      'as `if: inputs.x` then takes the "false" branch silently, so jobs or steps are skipped and the run is still green.',
    fix:
      "Give the input an explicit `default`, make it `required: true`, or compare explicitly (`inputs.x != ''`, `inputs.x == 'yes'`). " +
      "Not reported: comparisons with a constant, `contains()`-style tests, fallbacks (`inputs.x || 'default'`), and inputs every local caller passes — unless the workflow can be dispatched or the unit is published (by default the root `action.yml` and reusable workflows whose file name does not start with `_`; see `impact.publish`), since callers in other repositories can still omit them.",
    examples: {
      bad: `inputs:
  variant: { type: string, required: false }
...
if: inputs.variant`,
      good: `inputs:
  variant: { type: string, required: false }
...
if: inputs.variant != ''`,
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
  return { flagged, passedBySite };
}

/**
 * The reads of an input that decide a condition by its value. Comparisons with a constant (`inputs.x != ''`,
 * `inputs.x == 'yes'`), tests such as `contains()` and fallbacks handle the omitted case explicitly. A condition that
 * does so for the input is trusted with its other reads too (`inputs.x != '' && inputs.x != steps.s.outputs.current`);
 * otherwise only a value that decides the condition as it is gets reported. A whole read (`toJSON(inputs)`,
 * `inputs[matrix.key]`, see `Usage.whole`) does not single the input out, so it neither decides nor handles it.
 */
function decidingReads(index: ProjectIndex, unit: UnitDecl, input: InputDecl): Usage[] {
  const inConditions = index
    .usagesOf(sym.input(unit.path, input.name))
    .filter((u) => u.site.isCondition && !u.whole)
    .map((u) => ({ u, use: useInCondition(u.site, u.ref) }));
  const handledSites = new Set(
    inConditions.filter((x) => x.use === 'compared' || x.use === 'fallback').map((x) => x.u.site.id),
  );
  return inConditions
    .filter((x) => (x.use === 'truthiness' || x.use === 'value') && !handledSites.has(x.u.site.id))
    .map((x) => x.u);
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
        `Condition reads optional input ${quote(input.name)}, which has no default and is '' when omitted` +
        (notes.length ? ` (${notes.join('; ')})` : ''),
      loc: usage.ref.loc,
      symbol: sym.input(unit.path, input.name),
      related: [
        {
          loc: input.loc,
          message:
            publishedWithCallers && omitting.length === 0
              ? 'declared optional without a default; every caller here passes it, but this unit is published (see `impact.publish`), so callers in other repositories can omit it'
              : 'declared optional without a default',
        },
        ...omitting.slice(0, 3).map((c) => ({ loc: c.loc, message: `${c.label} omits it` })),
      ],
    });
  }
}

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
    summary: 'A required input of a callee is fed from an optional input that has no default.',
    why:
      'The call looks complete, so GitHub never complains about the required input, but when the outer caller omits the ' +
      'optional value the callee receives an empty string. The "required" guarantee is lost one level up.',
    fix: "Make the outer input required too, give it a default, or add a fallback: `${{ inputs.x || 'value' }}`.",
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

/** FP107's report, at the caller's input the value is fed from. */
function reportForwarded(
  ctx: RuleContext,
  call: CallSite,
  outer: Record<string, InputDecl>,
  b: Binding,
  site: ExprSite,
  target: InputDecl,
): void {
  const srcRef = site.segments.flatMap((s) => s.refs).find((r) => r.context === 'inputs');
  const src = srcRef?.path[0] ? lookup(outer, srcRef.path[0]) : undefined;
  ctx.report({
    message: `Required input ${quote(target.name)} of ${call.callee.path} is fed from optional input ${quote(src?.name ?? '?')} without a default`,
    loc: srcRef?.loc ?? b.valueLoc,
    symbol: sym.input(call.callee.path, target.name),
    related: [
      ...(src ? [{ loc: src.loc, message: 'optional, no default' }] : []),
      { loc: target.loc, message: `required by ${call.callee.path}` },
    ],
  });
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
