import {
  type ActionDecl,
  didYouMean,
  type ExprSite,
  type JobDecl,
  type LocatedRef,
  lookup,
  readsContextDynamically,
  refsOf,
  type StepDecl,
  sym,
  type UnitDecl,
  type WorkflowDecl,
} from '@ciatlas/core';
import { isPublished } from '../impact';
import { isExternal } from '../remotes';
import { renameSegment } from '../suggestions';
import { defineRule, type RelatedLocation, type RuleContext, type RuleDefinition } from './types';
import { didYouMeanNote, isProperty, listNames, namesKey, quote, stepsInScope } from './util';

/** FP303's fix for an output of a unit that other repositories might use: published units are not judged. */
function publishedFix(kind: 'workflow' | 'action', file: string, publish: string[] | undefined): string {
  const remove = `Remove the output, or make a ${kind === 'workflow' ? 'caller' : 'user'} read it.`;
  return publish
    ? `${remove} If other repositories use this ${kind}, add ${quote(file)} to \`impact.publish\`.`
    : `${remove} If other repositories use this ${kind}, set \`impact.publish\` to the units they use, ${quote(file)} included; it replaces the default (reusable workflows and the root action.yml).`;
}

/** The symbol of an output read from step `id` at `site` (the steps of an action belong to no job). */
function stepOutputSymbol(unit: UnitDecl, site: ExprSite, id: string, output: string | undefined): string {
  return sym.stepOutput(unit.path, unit.kind === 'workflow' ? site.job : undefined, id, output ?? '');
}

const undefinedOutputRef = defineRule({
  code: 'FP301',
  name: 'undefined-output-ref',
  category: 'outputs',
  defaultSeverity: 'error',
  docs: {
    summary: 'An expression reads an output (`needs.*`, `jobs.*`, `steps.*`) that is never defined.',
    why: 'Undefined outputs evaluate to an empty string. Downstream jobs then run with missing versions, tags or flags.',
    fix:
      'Fix the output name, declare the output on the job/workflow/action, or reference the right job or step. In a ' +
      "composite action, a step writing to `$GITHUB_OUTPUT` sets its own output, not the action's: give the step an " +
      "`id` and map the output under the action's `outputs:` (`value: ${{ steps.<id>.outputs.<name> }}`).",
    examples: {
      bad: `jobs:
  build:
    outputs:
      version: \${{ steps.meta.outputs.version }}
  deploy:
    needs: build
    run: deploy \${{ needs.build.outputs.vesion }}`,
      good: `    run: deploy \${{ needs.build.outputs.version }}`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      for (const { site, ref } of refsOf(unit)) {
        const a = ref.path[0];
        if (!namesKey(a)) continue;
        if ((ref.context === 'needs' || ref.context === 'jobs') && unit.kind === 'workflow')
          checkJobOutputRef(ctx, unit, site, ref, a);
        else if (ref.context === 'steps') checkStepOutputRef(ctx, unit, site, ref, a);
      }
    }
  },
});

/**
 * The output a job output read names: `needs.<job>.outputs.<name>`, or `jobs.<job>.outputs.<name>` in a workflow
 * output (the only place `jobs` holds them), `outputs` in any case. Undefined for other reads and for computed names.
 */
function jobOutputRead(site: ExprSite, ref: LocatedRef): string | undefined {
  if (ref.context === 'jobs' && site.field !== 'workflow.output') return undefined;
  const output = ref.path[2];
  return isProperty(ref.path[1], 'outputs') && namesKey(output) ? output : undefined;
}

/**
 * Where a job's outputs are declared: in the reusable workflow it calls, or on the job itself. A remote workflow's
 * declaration is in another repository, so the job's `uses:` stands for it.
 */
function jobOutputsDeclared(ctx: RuleContext, job: JobDecl, names: string[]): RelatedLocation {
  const callee = ctx.index.interfaceOf(job);
  const loc = callee && !isExternal(callee) ? callee.call?.loc : job.uses?.loc;
  return {
    loc: loc ?? job.loc,
    message: `${callee ? `${callee.path} declares` : 'declared'} outputs: ${listNames(names)}`,
  };
}

/**
 * The outputs a job has: its own, or those of the reusable workflow it calls, the local one or a remote one whose
 * interface the lockfile has; undefined for a call flowpact cannot see.
 */
function jobOutputs(ctx: RuleContext, job: JobDecl): string[] | undefined {
  if (!job.uses) return ctx.index.jobOutputNames(job);
  const callee = ctx.index.interfaceOf(job);
  return callee?.call ? Object.values(callee.call.outputs).map((o) => o.name) : undefined;
}

/** FP301 for a job output read: the job must exist and, unless it calls a workflow flowpact cannot see, declare it. */
function checkJobOutputRef(
  ctx: RuleContext,
  wf: WorkflowDecl,
  site: ExprSite,
  ref: LocatedRef,
  a: string,
): void {
  const c = jobOutputRead(site, ref);
  if (!c) return;
  const job = lookup(wf.jobs, a);
  if (!job) {
    if (ref.context === 'jobs') {
      ctx.report({ message: `${wf.path} has no job ${quote(a)}`, loc: ref.loc, symbol: sym.job(wf.path, a) });
    }
    return; // needs.<missing> is reported by FP302
  }
  const names = jobOutputs(ctx, job);
  if (!names) return;
  if (names.some((n) => n.toLowerCase() === c.toLowerCase())) return;
  const guess = didYouMean(c, names);
  ctx.report({
    message: `jobs.${job.id} has no output ${quote(c)}${didYouMeanNote(guess)}`,
    loc: ref.loc,
    symbol: sym.jobOutput(wf.path, job.id, c),
    related: [jobOutputsDeclared(ctx, job, names)],
    // `needs.<job>.outputs.<name>` or `jobs.<job>.outputs.<name>`
    suggestions: [guess ? renameSegment(ctx.index, ref.loc, 3, c, guess) : undefined],
  });
}

/** FP301 for `steps.<id>`: the step must exist in scope and run before the read. */
function checkStepOutputRef(
  ctx: RuleContext,
  unit: UnitDecl,
  site: ExprSite,
  ref: LocatedRef,
  a: string,
): void {
  const c = ref.path[2];
  const steps = stepsInScope(unit, site.job);
  const step = steps.find((s) => s.id?.toLowerCase() === a.toLowerCase());
  if (!step) {
    const guess = didYouMean(
      a,
      steps.flatMap((s) => (s.id ? [s.id] : [])),
    );
    ctx.report({
      message: `No step with id ${quote(a)} in ${site.job ? `jobs.${site.job}` : unit.path}${didYouMeanNote(guess)}`,
      loc: ref.loc,
      symbol: stepOutputSymbol(unit, site, a, c),
      suggestions: [guess ? renameSegment(ctx.index, ref.loc, 1, a, guess) : undefined],
    });
    return;
  }
  if (site.step !== undefined && step.index >= site.step) {
    ctx.report({
      message: `Step ${quote(a)} runs ${step.index === site.step ? 'as' : 'after'} this step, so its outputs are not available yet`,
      loc: ref.loc,
      symbol: stepOutputSymbol(unit, site, a, c),
      related: [{ loc: step.idLoc ?? step.loc, message: `step ${quote(a)} is defined here` }],
    });
    return;
  }
  checkActionOutputRef(ctx, step, ref);
}

/** FP301 for `steps.<id>.outputs.<name>` of a step that runs a composite action: the action must declare it. */
function checkActionOutputRef(ctx: RuleContext, step: StepDecl, ref: LocatedRef): void {
  const [, b, c] = ref.path;
  const action = ctx.index.actionInterfaceOf(step);
  if (!isProperty(b, 'outputs') || !namesKey(c) || !action) return;
  // JavaScript and Docker actions may set outputs they do not declare; only composite outputs are fixed.
  if (action.using !== 'composite') return;
  if (lookup(action.outputs, c)) return;
  const names = Object.keys(action.outputs);
  const guess = didYouMean(c, names);
  ctx.report({
    message: `${action.path} has no output ${quote(c)}${didYouMeanNote(guess)}`,
    loc: ref.loc,
    symbol: sym.output(action.path, c),
    suggestions: [guess ? renameSegment(ctx.index, ref.loc, 3, c, guess) : undefined],
    related: [{ loc: step.uses?.loc ?? step.loc, message: `declared outputs: ${listNames(names)}` }],
  });
}

const outputRefWithoutNeeds = defineRule({
  code: 'FP302',
  name: 'output-ref-without-needs',
  category: 'outputs',
  defaultSeverity: 'error',
  docs: {
    summary: '`needs.<job>` is read where the `needs` context does not contain `<job>`.',
    why:
      "The `needs` context contains the jobs listed under `needs:`. Only the job's own `if:` also sees the jobs it " +
      'depends on indirectly (through one of its needs); in steps, `env`, `with:`, `name` and the matrix their values ' +
      'are empty. A job that does not depend on `<job>` at all may also run before it.',
    fix: 'Add the job to `needs:` (it is fine to list transitive dependencies explicitly).',
    examples: {
      bad: `deploy:
  needs: test
  run: deploy \${{ needs.build.outputs.version }}`,
      good: `deploy:
  needs: [build, test]`,
    },
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      const ancestorsOf = ancestorsIn(wf);
      for (const { site, ref } of refsOf(wf)) {
        if (ref.context === 'needs') checkNeedsRef(ctx, wf, site, ref, ancestorsOf);
      }
    }
  },
});

/**
 * Every job a job of `wf` depends on, directly or through its needs (lowercased ids; cycles are FP601's business).
 * Computed on first use and remembered.
 */
function ancestorsIn(wf: WorkflowDecl): (id: string) => Set<string> {
  const ancestors = new Map<string, Set<string>>();
  const ancestorsOf = (id: string): Set<string> => {
    const known = ancestors.get(id);
    if (known) return known;
    const found = new Set<string>();
    ancestors.set(id, found);
    for (const n of wf.jobs[id]?.needs ?? []) {
      const dep = lookup(wf.jobs, n.id);
      if (!dep || found.has(dep.id.toLowerCase())) continue;
      found.add(dep.id.toLowerCase());
      for (const up of ancestorsOf(dep.id)) found.add(up);
    }
    return found;
  };
  return ancestorsOf;
}

/** FP302 for one `needs.<job>` read in a job: `<job>` must be under that job's `needs:`. */
function checkNeedsRef(
  ctx: RuleContext,
  wf: WorkflowDecl,
  site: ExprSite,
  ref: LocatedRef,
  ancestorsOf: (id: string) => Set<string>,
): void {
  const a = ref.path[0];
  if (!site.job || !namesKey(a)) return;
  const job = wf.jobs[site.job];
  if (!job || job.needs.some((n) => n.id.toLowerCase() === a.toLowerCase())) return;
  const exists = lookup(wf.jobs, a);
  // GitHub evaluates a job's own `if:` with every job it depends on, directly or not; everywhere else only the
  // jobs under `needs:` are in the context (checked against GitHub, see the rule docs).
  const indirect = exists !== undefined && ancestorsOf(job.id).has(exists.id.toLowerCase());
  if (indirect && site.field === 'job.if') return;
  ctx.report({
    message: needsMessage(wf, site.job, a, exists !== undefined, indirect),
    loc: ref.loc,
    symbol: sym.job(wf.path, a),
    related: [needsDeclared(job)],
    ...(exists ? { fix: `Add ${quote(a)} to jobs.${site.job}.needs.` } : {}),
  });
}

/** FP302's message: the job read does not exist, is a dependency only the job's `if:` sees, or is not under needs. */
function needsMessage(
  wf: WorkflowDecl,
  jobId: string,
  a: string,
  exists: boolean,
  indirect: boolean,
): string {
  if (!exists) return `jobs.${jobId} reads needs.${a}, but ${wf.path} has no job ${quote(a)}`;
  if (indirect)
    return `jobs.${jobId} reads needs.${a}, which is empty here: ${quote(a)} is not under needs, and only the job's \`if:\` sees jobs it depends on indirectly`;
  return `jobs.${jobId} reads needs.${a} but does not list ${quote(a)} under needs`;
}

/** Where a job lists its needs, and what it lists. */
function needsDeclared(job: JobDecl): RelatedLocation {
  return { loc: job.needs[0]?.loc ?? job.loc, message: `needs: ${listNames(job.needs.map((n) => n.id))}` };
}

const unusedOutput = defineRule({
  code: 'FP303',
  name: 'unused-output',
  category: 'outputs',
  defaultSeverity: 'warning',
  generatedFiles: 'skip',
  docs: {
    summary:
      'A job output, or an output of an internal reusable workflow or action, is declared but nothing reads it.',
    why: 'Unused outputs suggest a broken hand-off: either the consumer reads a different name, or the output is dead code.',
    fix: 'Remove the output, or make the intended consumer read it.',
    scope:
      'Job outputs are always judged: only the jobs and workflow outputs of the same workflow can read them. Outputs of a ' +
      'reusable workflow or an action are judged only for an internal unit that this repository uses. Published ' +
      'units are not reported, because their consumers live in other repositories: reusable workflows (except files ' +
      'starting with `_`), the root `action.yml`, or exactly the units listed in `impact.publish` when it is set. ' +
      'Actions in subdirectories (`owner/repo/restore@v1`) count as internal unless `impact.publish` lists them. ' +
      'Reading the whole object (`toJSON(needs.build.outputs)`, `needs.build.outputs[matrix.key]`, `toJSON(steps)`) ' +
      'counts as reading every output.',
    examples: {
      bad: `build:
  outputs:
    version: \${{ steps.meta.outputs.version }}
    digest: \${{ steps.push.outputs.digest }}   # nothing reads needs.build.outputs.digest
deploy:
  needs: build
  steps:
    - run: deploy \${{ needs.build.outputs.version }}`,
      good: `build:
  outputs:
    version: \${{ steps.meta.outputs.version }}`,
    },
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      // Job outputs are internal to the workflow: only its own jobs and workflow outputs can read them.
      if (!readsContextDynamically(wf, 'needs') && !readsContextDynamically(wf, 'jobs'))
        reportUnusedJobOutputs(ctx, wf);
      reportUnusedWorkflowOutputs(ctx, wf);
    }
    for (const action of ctx.index.project.actions.values()) reportUnusedActionOutputs(ctx, action);
  },
});

/** FP303 for the job outputs of a workflow nothing in it reads. */
function reportUnusedJobOutputs(ctx: RuleContext, wf: WorkflowDecl): void {
  for (const job of Object.values(wf.jobs)) {
    for (const o of Object.values(job.outputs)) {
      if (ctx.index.usagesOf(sym.jobOutput(wf.path, job.id, o.name)).length > 0) continue;
      ctx.report({
        message: `Output ${quote(o.name)} of jobs.${job.id} is never read`,
        loc: o.loc,
        symbol: sym.jobOutput(wf.path, job.id, o.name),
      });
    }
  }
}

/** FP303 for workflow outputs: only judge an internal workflow (#40), and only when it has local callers. */
function reportUnusedWorkflowOutputs(ctx: RuleContext, wf: WorkflowDecl): void {
  const callers = ctx.index.callersOf(wf.path);
  if (!wf.call || callers.length === 0 || isPublished(wf, ctx.config.impact)) return;
  for (const o of Object.values(wf.call.outputs)) {
    const read = callers.some(
      (c) => ctx.index.usagesOf(sym.jobOutput(c.caller.path, c.job.id, o.name)).length > 0,
    );
    if (read) continue;
    ctx.report({
      message: `Workflow output ${quote(o.name)} of ${wf.path} is not read by any of its ${callers.length} caller${callers.length > 1 ? 's' : ''}`,
      loc: o.loc,
      symbol: sym.output(wf.path, o.name),
      // Without `impact.publish`, a workflow is internal here only because its name starts with `_`.
      ...(ctx.config.impact.publish
        ? { fix: publishedFix('workflow', wf.file, ctx.config.impact.publish) }
        : {}),
    });
  }
}

/** FP303 for the outputs of an internal action that none of its local users reads. */
function reportUnusedActionOutputs(ctx: RuleContext, action: ActionDecl): void {
  const users = ctx.index.usersOf(action.path);
  if (users.length === 0 || isPublished(action, ctx.config.impact)) return;
  for (const o of Object.values(action.outputs)) {
    const read = users.some(
      (u) =>
        u.step.id && ctx.index.usagesOf(sym.stepOutput(u.unit.path, u.job?.id, u.step.id, o.name)).length > 0,
    );
    if (read) continue;
    ctx.report({
      message: `Output ${quote(o.name)} of ${action.path} is not read by any of its ${users.length} user${users.length > 1 ? 's' : ''}`,
      loc: o.loc,
      symbol: sym.output(action.path, o.name),
      fix: publishedFix('action', action.file, ctx.config.impact.publish),
    });
  }
}

const stepOutputNeverWritten = defineRule({
  code: 'FP304',
  name: 'step-output-never-written',
  category: 'outputs',
  defaultSeverity: 'warning',
  generatedFiles: 'skip',
  docs: {
    summary:
      'An output is read from a step whose inline script (`run:` or `actions/github-script`) writes other outputs, but never this one.',
    why: 'The read evaluates to an empty string. This is typically a typo in the `echo "name=value" >> $GITHUB_OUTPUT` line.',
    fix: 'Write the output in the step (`echo "<name>=<value>" >> "$GITHUB_OUTPUT"`) or read the name it actually writes.',
    scope:
      'Only scripts whose writes flowpact can name are judged. A step is skipped when its writes cannot be seen: ' +
      '`cat file >> "$GITHUB_OUTPUT"`, a computed name (`core.setOutput(name, …)`), or an `actions/github-script` ' +
      'script that loads a module (`require()`, `import()`; Node built-ins like `fs` aside), runs a program ' +
      '(`exec.exec()`), hands `core` to other code (`run({ core })`), or takes code from an expression ' +
      '(`script: ${{ inputs.code }}`). Words in strings, comments and template text do not count. ' +
      'Steps of other actions are not judged, since an action may set outputs of its own.',
    examples: {
      bad: `- id: meta
  run: echo "ver=1.2.3" >> "$GITHUB_OUTPUT"
...
version: \${{ steps.meta.outputs.version }}`,
      good: `- id: meta
  run: echo "version=1.2.3" >> "$GITHUB_OUTPUT"`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      for (const { site, ref } of refsOf(unit)) {
        if (ref.context === 'steps') checkStepOutputWritten(ctx, unit, site, ref);
      }
    }
  },
});

/**
 * Whether FP304 can judge the outputs a step writes: its script names every write, and it is a `run:` step or an
 * `actions/github-script` one (other actions may set outputs of their own).
 */
function writesAreKnown(step: StepDecl): boolean {
  const w = step.writesOutputs;
  if (!w.mentions || w.dynamic) return false;
  return !(step.uses && !step.with.script);
}

/** FP304 for one `steps.<id>.outputs.<name>` read: a step whose writes are known must write `<name>`. */
function checkStepOutputWritten(ctx: RuleContext, unit: UnitDecl, site: ExprSite, ref: LocatedRef): void {
  const [a, b, c] = ref.path;
  if (!isProperty(b, 'outputs') || !a || !namesKey(c)) return;
  const step = stepsInScope(unit, site.job).find((s) => s.id?.toLowerCase() === a.toLowerCase());
  if (!step || !writesAreKnown(step)) return;
  const w = step.writesOutputs;
  if (w.names.some((n) => n.toLowerCase() === c.toLowerCase())) return;
  const guess = didYouMean(c, w.names);
  ctx.report({
    message: `Step ${quote(a)} never writes output ${quote(c)} (it writes ${listNames(w.names)})${didYouMeanNote(guess)}`,
    loc: ref.loc,
    symbol: stepOutputSymbol(unit, site, a, c),
    suggestions: [guess ? renameSegment(ctx.index, ref.loc, 3, c, guess) : undefined],
    related: [{ loc: step.runLoc ?? step.loc, message: 'outputs are written here' }],
  });
}

export const outputRules: RuleDefinition[] = [
  undefinedOutputRef,
  outputRefWithoutNeeds,
  unusedOutput,
  stepOutputNeverWritten,
];
