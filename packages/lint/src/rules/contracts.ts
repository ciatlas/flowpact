import type { ActionDecl, Loc, UnitDecl, WorkflowDecl } from '@ciatlas/core';
import type { ContractChange, ContractPlanEntry } from '../contracts';
import { defineRule, type RuleContext, type RuleDefinition } from './types';
import { listNames } from './util';

const fileStart = (file: string): Loc => ({ file, line: 1, column: 1, endLine: 1, endColumn: 1 });

/** Best location in the current workflow/action for a changed contract path such as `inputs.config`. */
function locFor(unit: UnitDecl | undefined, path: string, fallback: Loc): Loc {
  if (!unit) return fallback;
  const [kind = '', name] = path.split('.');
  const loc = unit.kind === 'workflow' ? workflowLocFor(unit, kind, name) : actionLocFor(unit, kind, name);
  return loc ?? fallback;
}

/**
 * Per section of a workflow's contract, where the workflow declares an entry (`inputs.<name>`), else the section
 * itself. A Map, so a path such as `constructor.x` finds no section.
 */
const WORKFLOW_ENTRY_LOCS = new Map<string, (wf: WorkflowDecl, name: string) => Loc | undefined>([
  ['inputs', (wf, name) => wf.call?.inputs[name]?.loc ?? wf.call?.loc],
  ['dispatchInputs', (wf, name) => wf.dispatch?.inputs[name]?.loc ?? wf.dispatch?.loc],
  ['secrets', (wf, name) => wf.call?.secrets[name]?.loc ?? wf.call?.loc],
  ['outputs', (wf, name) => wf.call?.outputs[name]?.loc ?? wf.call?.loc],
  ['calls', (wf, name) => wf.jobs[name]?.uses?.loc ?? wf.jobs[name]?.loc],
]);

/** `locFor` in a workflow: the entry the path names, else the `workflow_call` or `workflow_dispatch` trigger. */
function workflowLocFor(wf: WorkflowDecl, kind: string, name: string | undefined): Loc | undefined {
  const entryLoc = name ? WORKFLOW_ENTRY_LOCS.get(kind) : undefined;
  if (name && entryLoc) return entryLoc(wf, name);
  return wf.call?.loc ?? wf.dispatch?.loc;
}

/** `locFor` in an action: the input or output the path names, if any. */
function actionLocFor(action: ActionDecl, kind: string, name: string | undefined): Loc | undefined {
  if (!name) return undefined;
  if (kind === 'inputs') return action.inputs[name]?.loc;
  if (kind === 'outputs') return action.outputs[name]?.loc;
  return undefined;
}

function* entries(
  ctx: RuleContext,
  status: ContractPlanEntry['status'][],
): Generator<{ entry: ContractPlanEntry; unit?: UnitDecl }> {
  for (const entry of ctx.contracts?.entries ?? []) {
    if (!status.includes(entry.status)) continue;
    const unit = entry.unit ? ctx.index.unit(entry.unit) : undefined;
    yield { entry, ...(unit ? { unit } : {}) };
  }
}

const GENERATE =
  'Run `flowpact generate` and commit the updated contracts. In CI, the flowpact action (check mode) attaches the regenerated contracts and a `git apply`-able patch to the run — see its job summary.';

const contractMissing = defineRule({
  code: 'FP801',
  name: 'contract-missing',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary: 'A workflow or local action has no contract in `.github/flowpact/` (check mode).',
    why: 'Without a locked contract, changes to its interface and wiring are not visible in review and cannot be checked.',
    fix: GENERATE,
    examples: {
      bad: `# .github/workflows/deploy.yml is new, and .github/flowpact/contracts/ has no contract for it
on:
  workflow_call:
    inputs:
      environment: { type: string, required: true }`,
      good: `# \`flowpact generate\` writes .github/flowpact/contracts/workflows/deploy.contract.yaml: commit it
kind: workflow
path: .github/workflows/deploy.yml
interface:
  inputs:
    environment:
      type: string
      required: true`,
    },
  },
  check(ctx) {
    for (const { entry, unit } of entries(ctx, ['create'])) {
      ctx.report({
        message: `${entry.unit} has no contract (expected ${entry.file})`,
        loc: unit ? fileStart(unit.file) : fileStart(entry.file),
        ...(entry.unit ? { symbol: entry.unit } : {}),
      });
    }
  },
});

const contractOutdated = defineRule({
  code: 'FP802',
  name: 'contract-outdated',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary:
      'The locked contract no longer matches the workflow — non-breaking changes to its interface or wiring.',
    why:
      'The contract is the reviewed record of what flows in and out. When it drifts silently, the next reviewer compares ' +
      'against stale information.',
    fix: GENERATE,
    examples: {
      bad: `# .github/actions/notify/action.yml gained an input that its contract does not list yet
inputs:
  emoji:
    description: Emoji prefix for the message
    default: ':rocket:'`,
      good: `# \`flowpact generate\` updates .github/flowpact/contracts/actions/notify.contract.yaml
interface:
  inputs:
    emoji:
      required: false
      default: ':rocket:'
      description: Emoji prefix for the message`,
    },
  },
  check(ctx) {
    for (const { entry, unit } of entries(ctx, ['update'])) {
      if (entry.invalid) continue; // FP805
      const changes = entry.changes.filter((c) => !c.breaking);
      if (changes.length === 0 && entry.changes.length > 0) continue; // only breaking changes → FP803
      ctx.report({
        message: `Contract ${entry.file} is outdated: ${outdatedSummary(changes)}`,
        loc: unit ? locFor(unit, changes[0]?.path ?? '', fileStart(unit.file)) : fileStart(entry.file),
        related: [{ loc: fileStart(entry.file), message: 'locked contract' }],
        ...(entry.unit ? { symbol: entry.unit } : {}),
      });
    }
  },
});

/** FP802's summary of the non-breaking changes; without any, only the file's formatting or order differs. */
function outdatedSummary(changes: ContractChange[]): string {
  return changes.length
    ? listNames(
        changes.map((c) => c.message),
        4,
      )
    : 'formatting or ordering changed';
}

const breakingInterfaceChange = defineRule({
  code: 'FP803',
  name: 'breaking-interface-change',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary:
      'A change breaks the locked contract: an input became required, an input/secret/output was removed, or a type changed.',
    why:
      'Callers written against the locked interface will fail (unknown or missing input) or silently read empty outputs. ' +
      'In large pipelines those callers may live in other repositories or rarely-run branches.',
    fix: 'Update every caller first (flowpact lists the known consumers), then regenerate the contract. If the change is intended, `flowpact generate` records it and the diff makes the break explicit in review.',
    examples: {
      bad: `# contract: input "channel" optional
on:
  workflow_call:
    inputs:
      channel: { type: string, required: true }   # now required`,
      good: `# keep it optional with a default (a required workflow_call input ignores its default),
# or update all callers first, then: flowpact generate
      channel: { type: string, required: false, default: stable }`,
    },
  },
  check(ctx) {
    for (const { entry, unit } of entries(ctx, ['update', 'delete'])) {
      if (entry.status === 'delete') continue; // FP804
      const consumers =
        unit?.kind === 'action'
          ? ctx.index.usersOf(unit.path).map((u) => ({
              loc: u.step.uses?.loc ?? u.step.loc,
              message: `consumer: ${u.unit.path}${u.job ? ` › jobs.${u.job.id}` : ''} › steps.${u.step.id ?? `#${u.step.index + 1}`}`,
            }))
          : ctx.index.callersOf(entry.unit ?? '').map((c) => ({
              loc: c.job.uses?.loc ?? c.job.loc,
              message: `consumer: ${c.caller.path} › jobs.${c.job.id}`,
            }));
      for (const change of entry.changes.filter((c) => c.breaking)) {
        ctx.report({
          message: `Breaking change to ${entry.unit}: ${change.message}`,
          loc: unit ? locFor(unit, change.path, fileStart(unit.file)) : fileStart(entry.file),
          symbol: `${entry.unit}#${change.path}`,
          related: [{ loc: fileStart(entry.file), message: 'locked contract' }, ...consumers.slice(0, 5)],
        });
      }
    }
  },
});

const orphanContract = defineRule({
  code: 'FP804',
  name: 'orphan-contract',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary: 'A contract file exists for a workflow or action that no longer exists.',
    why:
      'If the workflow was removed or renamed, anything still calling it (including other repositories) breaks — the stale ' +
      'contract is the last record of that interface.',
    fix: 'Confirm nothing depends on the removed workflow, then run `flowpact generate` to delete the contract.',
    examples: {
      bad: `# .github/workflows/nightly.yml was deleted; its contract is still there
# .github/flowpact/contracts/workflows/nightly.contract.yaml
kind: workflow
path: .github/workflows/nightly.yml`,
      good: `# nothing calls nightly.yml any more: \`flowpact generate\` deletes its contract`,
    },
  },
  check(ctx) {
    for (const { entry } of entries(ctx, ['delete'])) {
      if (entry.invalid) continue; // FP805 — an unreadable file does not say what it describes
      ctx.report({
        message: `Contract ${entry.file} describes ${entry.unit ?? 'a workflow'} which no longer exists`,
        loc: fileStart(entry.file),
        ...(entry.unit ? { symbol: entry.unit } : {}),
      });
    }
  },
});

const contractInvalid = defineRule({
  code: 'FP805',
  name: 'contract-invalid',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary:
      'A contract file cannot be read (invalid YAML or schema), usually because it was edited by hand or merged badly.',
    why: 'An unreadable contract cannot be compared, so drift and breaking changes go unnoticed.',
    fix: 'Contracts are generated: resolve the merge by running `flowpact generate` instead of editing the file.',
    examples: {
      bad: `# .github/flowpact/contracts/workflows/deploy.contract.yaml after a merge
interface:
  inputs:
<<<<<<< HEAD
    environment:
=======
    env:
>>>>>>> main`,
      good: `# resolve the conflict in deploy.yml, then \`flowpact generate\` writes the contract again
interface:
  inputs:
    environment:
      type: string
      required: true`,
    },
  },
  check(ctx) {
    for (const { entry } of entries(ctx, ['update', 'delete'])) {
      if (!entry.invalid) continue;
      ctx.report({
        message: `Contract ${entry.file} is invalid: ${entry.invalid}`,
        loc: fileStart(entry.file),
      });
    }
  },
});

export const contractRules: RuleDefinition[] = [
  contractMissing,
  contractOutdated,
  breakingInterfaceChange,
  orphanContract,
  contractInvalid,
];
