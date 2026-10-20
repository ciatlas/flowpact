/**
 * Remote interfaces: the inputs, outputs and secrets of reusable workflows and actions in other repositories, pinned in
 * `.github/flowpact/remotes.lock.yaml`. Each entry becomes an external unit of core (see `LoadProjectOptions.remotes`),
 * so the checks of what a caller passes and reads cover remote calls too.
 */
import {
  type ActionUse,
  type CallSite,
  type FileSystem,
  type InputDecl,
  type JobDecl,
  type ProjectIndex,
  type RemoteInterface,
  remoteKey,
  type StepDecl,
  type UnitDecl,
  type WorkflowDecl,
} from '@ciatlas/core';
import { parse as parseYaml, stringify } from 'yaml';
import * as z from 'zod/mini';
import type { ActionsLockRead } from './actions-lock';
import { CONFIG_DIR } from './config';
import './zod';

/** The lockfile's names, the first one preferred. */
export const REMOTES_LOCK_FILES = [
  `${CONFIG_DIR}/remotes.lock.yaml`,
  `${CONFIG_DIR}/remotes.lock.yml`,
] as const;

// Loose objects: a key a later flowpact adds is ignored here rather than making the whole lockfile unusable (FP611).
const inputSchema = z.looseObject({
  type: z.optional(z.string()),
  /** Written only when true. */
  required: z.optional(z.boolean()),
  default: z.optional(z.json()),
  options: z.optional(z.array(z.string())),
});

/** `permissions:` as written: a shorthand, or a scope → level map. */
const permissionsSchema = z.union([
  z.literal('read-all'),
  z.literal('write-all'),
  z.record(z.string(), z.enum(['read', 'write', 'none'])),
]);

const entrySchema = z.looseObject({
  /** The commit the reference resolved to when the entry was written. */
  sha: z.string().check(z.regex(/^[0-9a-f]{40}$/)),
  kind: z.enum(['workflow', 'action']),
  inputs: z.optional(z.record(z.string(), inputSchema)),
  secrets: z.optional(z.record(z.string(), z.looseObject({ required: z.optional(z.boolean()) }))),
  outputs: z.optional(z.array(z.string())),
  /** An action's `runs.using`: only a composite action's outputs are all declared. */
  using: z.optional(z.string()),
  /** Where it was read when not from the API the run used: `github.com`, through GitHub Connect. */
  host: z.optional(z.string()),
  /**
   * A workflow's secrets it reads without declaring them, which only `secrets: inherit` gives it (see FP205); only
   * reads no caller's inputs can switch off.
   */
  undeclaredSecrets: z.optional(z.array(z.string())),
  /**
   * A workflow's `permissions:`, when one of its jobs has none of its own and so requests them (see FP613). A job that
   * calls a workflow of its own repository with neither is not followed.
   */
  permissions: z.optional(permissionsSchema),
  /** The `permissions:` of each job of a workflow that has its own, by job id (see FP613). */
  jobPermissions: z.optional(z.record(z.string(), permissionsSchema)),
});

const remotesLockSchema = z.looseObject({
  version: z.literal(1),
  /** By `uses:` reference: `owner/repo/.github/workflows/<file>@<ref>` or `owner/repo[/path]@<ref>`. */
  remotes: z.record(z.string(), entrySchema),
  /**
   * References `flowpact remotes update` could not read (they do not exist, or its token cannot read them), with why:
   * accounted for, though not checked.
   */
  unreadable: z.optional(z.record(z.string(), z.string())),
});

export type RemotesLock = z.infer<typeof remotesLockSchema>;
export type RemoteEntry = RemotesLock['remotes'][string];

/** The lockfile as read: none, its entries, or why it cannot be used (then no remote interface is used). */
export interface RemotesLockRead {
  file?: string;
  lock?: RemotesLock;
  error?: string;
  /** References whose entries were fetched for this run, not read from the file (see `fetchMissingRemotes`). */
  fetched?: string[];
  /** GitHub's `actions.lock`, when the repository has one: the commits it pins (see FP612). */
  actionsLock?: ActionsLockRead;
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
/**
 * The remote interfaces of a lockfile, for `loadProject`. An entry that records another commit than the one its
 * reference pins in full is left out: it describes other code than what runs, so its calls are not verified (FP612
 * reports it).
 */
export const remoteInterfaces = (lock: RemotesLock | undefined): RemoteInterface[] =>
  Object.entries(lock?.remotes ?? {})
    .filter(([ref, e]) => !pinMismatch(ref, e))
    .map(([ref, e]) => ({ ref, kind: e.kind, text: interfaceYaml(e) }));

/**
 * Whether a lockfile entry records another commit than the full commit SHA its reference pins (`octo/setup@<sha>`).
 * `flowpact remotes update` resolves such a reference to that commit, so only an edited entry differs.
 */
export function pinMismatch(ref: string, entry: Pick<RemoteEntry, 'sha' | 'kind'>): boolean {
  const r = parseRemoteRef(ref, entry.kind);
  return r !== undefined && commitOf(r, entry) !== entry.sha;
}

/**
 * What the lockfile says about a reference, matched as GitHub matches it (owner and repository in any case): its entry,
 * or why `flowpact remotes update` could not read it. Nothing when the lockfile does not list it.
 */
export function lockedRemote(
  lock: RemotesLock | undefined,
  ref: string,
): { entry?: RemoteEntry; unreadable?: string } {
  const key = remoteKey(ref);
  const find = <T>(m: Record<string, T> | undefined) =>
    Object.entries(m ?? {}).find(([r]) => remoteKey(r) === key)?.[1];
  const entry = find(lock?.remotes);
  if (entry) return { entry };
  const unreadable = find(lock?.unreadable);
  return unreadable === undefined ? {} : { unreadable };
}

/**
 * The commit a remote reference runs: its own ref when that is a full commit SHA (GitHub runs that commit, whatever the
 * lockfile says), else the commit the lockfile pins for it. The sources cache keeps, and the editor opens, this one.
 */
export const commitOf = (r: Pick<RemoteRef, 'ref'>, entry: Pick<RemoteEntry, 'sha'>): string =>
  /^[0-9a-f]{40}$/i.test(r.ref) ? r.ref.toLowerCase() : entry.sha;

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

// ---------------------------------------------------------------------------
// Writing the lockfile
// ---------------------------------------------------------------------------

/** A remote reference: `owner/repo/path@ref`, its path in that repository (none for a root action) and its ref. */
export interface RemoteRef {
  raw: string;
  kind: 'workflow' | 'action';
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

/** A `uses:` value of another repository, or undefined for one that is not (`docker://…`, a malformed one). */
export function parseRemoteRef(raw: string, kind: RemoteRef['kind']): RemoteRef | undefined {
  const m = /^([^/@\s]+)\/([^/@\s]+)((?:\/[^@\s]+)?)@([^@\s]+)$/.exec(raw.trim());
  if (!m) return undefined;
  return { raw: raw.trim(), kind, owner: m[1]!, repo: m[2]!, path: m[3]!.replace(/^\//, ''), ref: m[4]! };
}

/** The remote reusable workflows and actions a project uses, once each (by `remoteKey`), in the order they are met. */
export function remoteRefsOf(index: ProjectIndex, units: Iterable<UnitDecl> = index.units()): RemoteRef[] {
  const out = new Map<string, RemoteRef>();
  const add = (raw: string, kind: RemoteRef['kind']) => {
    const ref = parseRemoteRef(raw, kind);
    if (ref && !out.has(remoteKey(raw))) out.set(remoteKey(raw), ref);
  };
  for (const unit of units) {
    if (unit.kind === 'workflow')
      for (const job of Object.values(unit.jobs))
        if (job.uses?.kind === 'remote-workflow') add(job.uses.raw, 'workflow');
    for (const { step } of stepsOf(unit))
      if (step.uses?.kind === 'remote-action') add(step.uses.raw, 'action');
  }
  return [...out.values()];
}

/**
 * The units the requested paths name (`Project.targets`), and the local workflows and actions they reach; undefined
 * when no paths were given, which is every unit.
 */
export function targetedUnits(index: ProjectIndex): Set<UnitDecl> | undefined {
  const { targets } = index.project;
  if (!targets.size) return undefined;
  const out = new Set<UnitDecl>();
  const visit = (unit: UnitDecl) => {
    if (out.has(unit)) return;
    out.add(unit);
    for (const c of index.callSites) if (c.caller === unit) visit(c.callee);
    for (const u of index.actionUses) if (u.unit === unit) visit(u.action);
  };
  for (const unit of index.units()) if (targets.has(unit.file)) visit(unit);
  return out;
}

/** An input as the lockfile records it. */
const lockedInput = (i: InputDecl) => ({
  ...(i.type ? { type: i.type } : {}),
  ...(i.required ? { required: true } : {}),
  ...(i.hasDefault && i.default !== undefined ? { default: i.default } : {}),
  ...(i.options ? { options: i.options } : {}),
});

const lockedInputs = (decls: Record<string, InputDecl>) =>
  Object.fromEntries(Object.values(decls).map((i) => [i.name, lockedInput(i)]));

/** `key: value` when the value holds something, so the lockfile leaves out empty maps and lists. */
const ifAny = <K extends string, V extends object>(key: K, value: V): Partial<Record<K, V>> =>
  Object.keys(value).length ? ({ [key]: value } as Record<K, V>) : {};

/** What a workflow's jobs request: each one's own `permissions:`, and the workflow's when a job has none of its own. */
function lockedPermissions(wf: WorkflowDecl): Pick<RemoteEntry, 'permissions' | 'jobPermissions'> {
  const jobs = Object.values(wf.jobs);
  const inherits = jobs.some((j) => !j.permissions);
  return {
    ...(wf.permissions && inherits ? { permissions: wf.permissions } : {}),
    ...ifAny(
      'jobPermissions',
      Object.fromEntries(jobs.flatMap((j) => (j.permissions ? [[j.id, j.permissions]] : []))),
    ),
  };
}

/**
 * The lockfile entry of a remote unit, read from its file at commit `sha`. What is the default is left out: `required`
 * when false, and empty inputs, secrets and outputs.
 */
export function lockEntryOf(unit: UnitDecl, sha: string): RemoteEntry {
  if (unit.kind === 'workflow') {
    const call = unit.call;
    return {
      sha,
      kind: 'workflow',
      ...ifAny('inputs', lockedInputs(call?.inputs ?? {})),
      ...ifAny(
        'secrets',
        Object.fromEntries(
          Object.values(call?.secrets ?? {}).map((s) => [s.name, s.required ? { required: true } : {}]),
        ),
      ),
      ...ifAny(
        'outputs',
        Object.values(call?.outputs ?? {}).map((o) => o.name),
      ),
      ...lockedPermissions(unit),
    };
  }
  return {
    sha,
    kind: 'action',
    ...(unit.using ? { using: unit.using } : {}),
    ...ifAny('inputs', lockedInputs(unit.inputs)),
    ...ifAny(
      'outputs',
      Object.values(unit.outputs).map((o) => o.name),
    ),
  };
}

const LOCK_HEADER =
  '# Generated by flowpact — do not edit by hand. Run `flowpact remotes update` to update.\n' +
  '# The interfaces of the remote reusable workflows and actions this repository uses, at the commit each resolved to.\n';

/** The lockfile's text: its entries sorted by reference. */
export function serializeRemotesLock(lock: RemotesLock): string {
  const sorted = <T>(rec: Record<string, T>) =>
    Object.fromEntries(Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const unreadable = Object.keys(lock.unreadable ?? {}).length
    ? { unreadable: sorted(lock.unreadable!) }
    : {};
  const doc = { version: 1, remotes: sorted(lock.remotes), ...unreadable };
  return `${LOCK_HEADER}${stringify(doc, { lineWidth: 0, singleQuote: true })}`;
}
