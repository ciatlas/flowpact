/**
 * Remote interfaces: the inputs, outputs and secrets of reusable workflows and actions in other repositories, pinned in
 * `.github/flowpact/remotes.lock.yaml`. Each entry becomes an external unit of core (see `LoadProjectOptions.remotes`),
 * so the checks of what a caller passes and reads cover remote calls too.
 */
import type {
  ActionUse,
  CallSite,
  FileSystem,
  JobDecl,
  ProjectIndex,
  RemoteInterface,
  StepDecl,
  UnitDecl,
  WorkflowDecl,
} from '@ciatlas/core';
import { parse as parseYaml, stringify } from 'yaml';
import * as z from 'zod/mini';
import { CONFIG_DIR } from './config';
import './zod';

/** The lockfile's names, the first one preferred. */
const REMOTES_LOCK_FILES = [`${CONFIG_DIR}/remotes.lock.yaml`, `${CONFIG_DIR}/remotes.lock.yml`] as const;

const inputSchema = z.strictObject({
  type: z.optional(z.string()),
  required: z.boolean(),
  default: z.optional(z.json()),
  options: z.optional(z.array(z.string())),
});

const entrySchema = z.strictObject({
  /** The commit the reference resolved to when the entry was written. */
  sha: z.string().check(z.regex(/^[0-9a-f]{40}$/)),
  kind: z.enum(['workflow', 'action']),
  inputs: z.optional(z.record(z.string(), inputSchema)),
  secrets: z.optional(z.record(z.string(), z.strictObject({ required: z.boolean() }))),
  outputs: z.optional(z.array(z.string())),
  /** An action's `runs.using`: only a composite action's outputs are all declared. */
  using: z.optional(z.string()),
});

const remotesLockSchema = z.strictObject({
  version: z.literal(1),
  /** By `uses:` reference: `owner/repo/.github/workflows/<file>@<ref>` or `owner/repo[/path]@<ref>`. */
  remotes: z.record(z.string(), entrySchema),
});

export type RemotesLock = z.infer<typeof remotesLockSchema>;
type RemoteEntry = RemotesLock['remotes'][string];

/** The lockfile as read: none, its entries, or why it cannot be used (then no remote interface is used). */
export interface RemotesLockRead {
  file?: string;
  lock?: RemotesLock;
  error?: string;
}

export function readRemotesLock(fs: FileSystem): RemotesLockRead {
  const file = REMOTES_LOCK_FILES.find((f) => fs.read(f) !== undefined);
  if (!file) return {};
  let data: unknown;
  try {
    data = parseYaml(fs.read(file)!);
  } catch (e) {
    return { file, error: `not valid YAML: ${(e as Error).message.split('\n')[0]}` };
  }
  const parsed = remotesLockSchema.safeParse(data);
  if (parsed.success) return { file, lock: parsed.data };
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return { file, error: issues };
}

/** An entry as the YAML of a workflow or `action.yml` that declares its interface, for core to parse. */
function interfaceYaml(e: RemoteEntry): string {
  const inputs = e.inputs ?? {};
  if (e.kind === 'workflow') {
    const outputs = Object.fromEntries((e.outputs ?? []).map((o) => [o, { value: '' }]));
    return stringify({ on: { workflow_call: { inputs, secrets: e.secrets ?? {}, outputs } }, jobs: {} });
  }
  const outputs = Object.fromEntries((e.outputs ?? []).map((o) => [o, { description: '' }]));
  const using = e.using ?? 'composite';
  const runs = using === 'composite' ? { using, steps: [] } : { using, main: '' };
  return stringify({ name: '', inputs, outputs, runs });
}

/** The remote interfaces of a lockfile, for `loadProject`. */
export const remoteInterfaces = (lock: RemotesLock | undefined): RemoteInterface[] =>
  Object.entries(lock?.remotes ?? {}).map(([ref, e]) => ({ ref, kind: e.kind, text: interfaceYaml(e) }));

/** Whether a unit is a remote interface, which has no file of this repository to point at. */
export const isExternal = (unit: UnitDecl) => unit.external === true;

/**
 * Every call of a reusable workflow whose interface is known: the local ones, and the remote ones the lockfile has.
 * For checks of what a caller passes; nothing here follows a call into the callee.
 */
export function interfaceCalls(index: ProjectIndex): CallSite[] {
  const remote: CallSite[] = [];
  for (const caller of index.project.workflows.values()) {
    for (const job of Object.values(caller.jobs)) {
      if (job.uses?.kind !== 'remote-workflow') continue;
      const callee: WorkflowDecl | undefined = index.interfaceOf(job);
      if (callee) remote.push({ caller, job, callee });
    }
  }
  return [...index.callSites, ...remote];
}

/** Every step of a unit, with the job it is in (none in an action). */
const stepsOf = (unit: UnitDecl): { job?: JobDecl; step: StepDecl }[] =>
  unit.kind === 'workflow'
    ? Object.values(unit.jobs).flatMap((job) => job.steps.map((step) => ({ job, step })))
    : unit.steps.map((step) => ({ step }));

/** Every step that uses an action whose interface is known: the local ones, and the remote ones the lockfile has. */
export function interfaceUses(index: ProjectIndex): ActionUse[] {
  const remote: ActionUse[] = [];
  for (const unit of index.units()) {
    for (const { job, step } of stepsOf(unit)) {
      const action = step.uses?.kind === 'remote-action' ? index.actionInterfaceOf(step) : undefined;
      if (action) remote.push({ unit, ...(job ? { job } : {}), step, action });
    }
  }
  return [...index.actionUses, ...remote];
}
