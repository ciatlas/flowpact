/**
 * Grading a version change of remote reusable workflows and actions against this repository's calls: the same rules
 * that check a call against the lockfile's interface run twice, once with the interface before the change and once
 * with the interface after it. A finding only the second run has is what the change breaks; the interface diff
 * explains it but never decides it, so the verdict cannot drift from what `flowpact check` reports.
 */
import {
  type ActionUse,
  type Binding,
  type CallSite,
  escapeControl,
  evaluateTemplate,
  type FileSystem,
  type JobDecl,
  type Json,
  type Loc,
  type LocatedRef,
  lookup,
  nodeFileSystem,
  overlayFileSystem,
  type ProjectIndex,
  refsOf,
  remoteKey,
  type StepDecl,
  UNKNOWN,
  type UnitDecl,
  type WorkflowDecl,
} from '@ciatlas/core';
import { type AnalysisResult, type AnalyzeOptions, analyze } from './analyze';
import { defaultConfig, type FlowpactConfig } from './config';
import { type Contract, type ContractChange, type ContractInput, diffContracts } from './contracts';
import { LEVEL_NAMES, levelsOf, type ShortScope } from './permissions';
import {
  commitOf,
  interfaceCalls,
  interfaceUses,
  parseRemoteRef,
  REMOTES_LOCK_FILES,
  type RemoteEntry,
  type RemotesLock,
  readRemotesLock,
  serializeRemotesLock,
} from './remotes';
import type { JsonFinding } from './report';
import { createRegistry } from './rules/index';
import type { Finding } from './rules/types';
import { isProperty } from './rules/util';
import { SCHEMA_VERSIONS } from './version';

/**
 * The rules that check a call against the interface it calls: inputs passed and missing (FP101–FP103), secrets
 * (FP201, FP202, FP205), outputs read (FP301) and permissions granted (FP613). Only their findings can differ between
 * the two runs.
 */
export const GRADE_CODES = ['FP101', 'FP102', 'FP103', 'FP201', 'FP202', 'FP205', 'FP301', 'FP613'] as const;

/** A version change of one remote reference: its lockfile entry before (none when it had none) and after. */
export interface RemoteChange {
  /** The `uses:` reference the calls name, as the lockfile keys it. */
  ref: string;
  before?: RemoteEntry;
  after: RemoteEntry;
}

/**
 * - `breaks`: a check fails on the call with the new interface that passed with the old one.
 * - `unchecked`: no check fails, but part of what changed is out of the checks' reach for this call (`unchecked`).
 * - `fits`: every check passes as before.
 */
export type RemoteVerdict = 'breaks' | 'unchecked' | 'fits';

/** One call of the reference: a job that calls the reusable workflow, or a step that uses the action. */
export interface RemoteCallSite {
  /** The file of the workflow or action that makes the call. */
  file: string;
  job?: string;
  /** The step's id, or `#<n>` (1-based) without one. */
  step?: string;
  /** Where the call's `uses:` is. */
  loc: Loc;
}

export interface RemoteCallGrade {
  call: RemoteCallSite;
  verdict: RemoteVerdict;
  /** Findings with the new interface the old one did not give: why it breaks. */
  added: JsonFinding[];
  /** Findings the old interface gave that the new one does not. */
  removed: JsonFinding[];
  /** What the checks cannot tell about this call after the change: why the verdict is `unchecked` (kept with `breaks`). */
  unchecked: string[];
  /** Changes in behaviour the call gets without a check failing: a default it relies on changed. */
  notes: string[];
}

export interface RemoteChangeGrade {
  ref: string;
  /** The commits the entries record: before (none without an entry) and after. */
  commits: { before?: string; after: string };
  /** The worst verdict of its calls; `fits` when nothing here calls it. */
  verdict: RemoteVerdict;
  /** The interface diff, which explains the verdict; empty without an earlier entry to compare with. */
  changes: ContractChange[];
  calls: RemoteCallGrade[];
}

const VERDICT_ORDER: Record<RemoteVerdict, number> = { breaks: 0, unchecked: 1, fits: 2 };
const worstVerdict = (verdicts: RemoteVerdict[]): RemoteVerdict =>
  verdicts.reduce<RemoteVerdict>((w, v) => (VERDICT_ORDER[v] < VERDICT_ORDER[w] ? v : w), 'fits');

/**
 * Grades version changes of remote references against every call in the repository. Two analyses whatever the number
 * of changes: each call's checks depend on its own reference's entry only. The config's severities do not switch the
 * grading rules off (a rule set to `off` would hide a break); its overrides of them still accept findings.
 */
export function gradeRemoteChanges(opts: AnalyzeOptions, graded: RemoteChange[]): RemoteChangeGrade[] {
  if (!graded.length) return [];
  const changes = graded.map(samePermissions);
  const fs = opts.fs ?? nodeFileSystem(opts.root);
  const before = gradingRun(opts, fs, changes, (c) => c.before);
  const after = gradingRun(opts, fs, changes, (c) => c.after);
  return changes.map((change) => gradeOne(change, before, after));
}

/** An entry's record of what a workflow's jobs request (see `lockedPermissions`). */
const permissionsOf = (e: RemoteEntry): Pick<RemoteEntry, 'permissions' | 'jobPermissions'> => ({
  ...(e.permissions ? { permissions: e.permissions } : {}),
  ...(e.jobPermissions ? { jobPermissions: e.jobPermissions } : {}),
});

/**
 * A change at the commit the entry already recorded: the code is the same, so what its jobs request is too, and the
 * entry before gets the new one's record of it. An entry written before flowpact recorded permissions has none, which
 * would otherwise read as new requests.
 */
function samePermissions(change: RemoteChange): RemoteChange {
  const { before, after } = change;
  if (!before || before.sha !== after.sha) return change;
  const { permissions: _p, jobPermissions: _j, ...rest } = before;
  return { ...change, before: { ...rest, ...permissionsOf(after) } };
}

/** One analysis with each changed reference's entry replaced (or removed), the grading rules on. */
function gradingRun(
  opts: AnalyzeOptions,
  fs: FileSystem,
  changes: RemoteChange[],
  pick: (c: RemoteChange) => RemoteEntry | undefined,
): AnalysisResult {
  const read = readRemotesLock(fs);
  const lock: RemotesLock = read.lock
    ? { ...read.lock, remotes: { ...read.lock.remotes } }
    : { version: 1, remotes: {} };
  for (const change of changes) setEntry(lock, change.ref, pick(change));
  const file = read.file ?? REMOTES_LOCK_FILES[0];
  // What only the full run uses goes: paths, modes, and where overrides are in the config (they are filtered here).
  const {
    paths: _paths,
    impact: _impact,
    checkContracts: _check,
    only: _only,
    overrideLocs: _locs,
    ...rest
  } = opts;
  return analyze({
    ...rest,
    config: gradingConfig(opts),
    fs: overlayFileSystem(fs, new Map([[file, serializeRemotesLock(lock)]])),
    only: [...GRADE_CODES],
  });
}

/**
 * The config of a grading run: the grading rules on, and of the overrides only theirs, so no setting for another rule
 * (a plugin's, which a run of `flowpact remotes` does not load) is warned about.
 */
function gradingConfig(opts: AnalyzeOptions): FlowpactConfig {
  const config = opts.config ?? defaultConfig();
  const registry = opts.registry ?? createRegistry();
  const grading = new Set<string>(GRADE_CODES);
  return {
    ...config,
    rules: Object.fromEntries(GRADE_CODES.map((c) => [c, 'error' as const])),
    overrides: config.overrides.filter((o) => grading.has(registry.get(o.rule)?.code ?? '')),
  };
}

/**
 * Puts a reference's entry in a lockfile, in place of any key `remoteKey` matches (owner and repository in any case).
 * A reference that pins a full commit SHA gets that commit, so its entry is not left out as describing another commit
 * (`pinMismatch`): what it describes is the point here.
 */
function setEntry(lock: RemotesLock, ref: string, entry: RemoteEntry | undefined): void {
  const key = remoteKey(ref);
  for (const k of Object.keys(lock.remotes)) if (remoteKey(k) === key) delete lock.remotes[k];
  if (!entry) return;
  const r = parseRemoteRef(ref, entry.kind);
  lock.remotes[ref] = r ? { ...entry, sha: commitOf(r, entry) } : entry;
}

/** A call of the reference, with what it owns in its file: findings there are about it. */
interface Call {
  site: RemoteCallSite;
  /** Spans within its file: the step, or the job's `uses:` and the keys and values of its `with:` and `secrets:`. */
  owns: Loc[];
  uses: Loc;
  job?: JobDecl;
  step?: StepDecl;
  unit: UnitDecl;
}

const stepName = (s: StepDecl) => s.id ?? `#${s.index + 1}`;

/** The calls of a reference in an analysis: the jobs that call it and the steps that use it. */
function callsOf(index: ProjectIndex, ref: string): Call[] {
  const key = remoteKey(ref);
  const matches = (raw: string | undefined) => raw !== undefined && remoteKey(raw) === key;
  const jobs = interfaceCalls(index)
    .filter((c: CallSite) => matches(c.job.uses?.raw) && c.job.uses?.kind === 'remote-workflow')
    .map((c): Call => {
      const { job } = c;
      const bindings = [...Object.values(job.with), ...Object.values(job.secrets)];
      const uses = job.uses!.loc;
      return {
        site: { file: c.caller.file, job: job.id, loc: uses },
        owns: [
          uses,
          ...bindings.flatMap((b) => [b.loc, b.valueLoc]),
          ...(job.secretsLoc ? [job.secretsLoc] : []),
        ],
        uses,
        job,
        unit: c.caller,
      };
    });
  const steps = interfaceUses(index)
    .filter((u: ActionUse) => matches(u.step.uses?.raw) && u.step.uses?.kind === 'remote-action')
    .map((u): Call => {
      const uses = u.step.uses!.loc;
      return {
        site: { file: u.unit.file, ...(u.job ? { job: u.job.id } : {}), step: stepName(u.step), loc: uses },
        owns: [u.step.loc],
        uses,
        ...(u.job ? { job: u.job } : {}),
        step: u.step,
        unit: u.unit,
      };
    });
  return [...jobs, ...steps];
}

const notAfter = (a: { line: number; column: number }, b: { line: number; column: number }) =>
  a.line < b.line || (a.line === b.line && a.column <= b.column);

/** Whether a location starts within a span of the same file. */
const startsIn = (loc: Loc, span: Loc) =>
  loc.file === span.file &&
  notAfter({ line: span.line, column: span.column }, loc) &&
  notAfter(loc, { line: span.endLine, column: span.endColumn });

/**
 * The call a finding is about: the one whose `uses:` a related location points at (a read of an output names the call
 * that should declare it, wherever the read is, even in another call's step), else the one whose span holds it.
 */
function callOf(f: Finding, calls: Call[]): Call | undefined {
  return (
    calls.find((c) => (f.related ?? []).some((r) => startsIn(r.loc, c.uses))) ??
    calls.find((c) => c.owns.some((span) => startsIn(f.loc, span)))
  );
}

/** Compares findings across the two runs: the same rule about the same thing at the same place. */
const findingKey = (f: Finding) => `${f.code}|${f.symbol ?? ''}|${f.loc.file}:${f.loc.line}:${f.loc.column}`;

function gradeOne(
  change: RemoteChange,
  beforeRun: AnalysisResult,
  afterRun: AnalysisResult,
): RemoteChangeGrade {
  const calls = callsOf(afterRun.index, change.ref);
  const own = (r: AnalysisResult) => {
    const out = new Map<Call, Map<string, Finding>>(calls.map((c) => [c, new Map()]));
    for (const f of r.findings) {
      const c = callOf(f, calls);
      if (c) out.get(c)!.set(findingKey(f), f);
    }
    return out;
  };
  const was = own(beforeRun);
  const now = own(afterRun);
  const graded = calls.map((c) => {
    const old = was.get(c)!;
    const cur = now.get(c)!;
    const added = [...cur].filter(([k]) => !old.has(k)).map(([, f]) => f);
    const removed = [...old].filter(([k]) => !cur.has(k)).map(([, f]) => f);
    const unchecked = uncheckedParts(afterRun.index, c, change);
    const verdict: RemoteVerdict = added.length ? 'breaks' : unchecked.length ? 'unchecked' : 'fits';
    return { call: c.site, verdict, added, removed, unchecked, notes: defaultNotes(c, change) };
  });
  return {
    ref: change.ref,
    commits: { ...(change.before ? { before: change.before.sha } : {}), after: change.after.sha },
    verdict: worstVerdict(graded.map((g) => g.verdict)),
    changes: change.before ? interfaceChanges(change.ref, change.before, change.after) : [],
    calls: graded,
  };
}

// ---------------------------------------------------------------------------
// What the checks cannot tell, and the defaults a call relies on
// ---------------------------------------------------------------------------

const inputsOf = (e: RemoteEntry | undefined) => e?.inputs ?? {};

/** The names of `after` that `before` lacks, matched as GitHub matches names (ignoring case), as `after` writes them. */
function addedNames(before: string[] | undefined, after: string[] | undefined): string[] {
  const had = new Set((before ?? []).map((n) => n.toLowerCase()));
  return [...new Set(after ?? [])].filter((n) => !had.has(n.toLowerCase()));
}

/** The parts of a call the change touches where the checks cannot see. */
function uncheckedParts(index: ProjectIndex, c: Call, change: RemoteChange): string[] {
  return [
    ...typedExpressions(c, change),
    ...secretsInherited(c, change),
    ...outputsMaybeSet(c, change),
    ...permissionsDefault(index, c, change),
  ];
}

/** The type FP103 checks (boolean or number) an input takes after the change and did not before; else undefined. */
function newCheckedType(name: string, { before, after }: RemoteChange): string | undefined {
  const type = lookup(inputsOf(after), name)?.type;
  const checked = type === 'boolean' || type === 'number';
  return checked && lookup(inputsOf(before), name)?.type !== type ? type : undefined;
}

/** Whether a value is known only when the job runs: an expression that cannot be evaluated before. */
const onlyAtRunTime = (b: Binding) =>
  b.site !== undefined && !evaluateTemplate(b.site.text, () => UNKNOWN).known;

/**
 * A value passed as an expression to an input the change typed (or retyped) as a boolean or a number: FP103 checks
 * only values known before the run.
 */
function typedExpressions(c: Call, change: RemoteChange): string[] {
  if (!c.job || change.after.kind !== 'workflow') return [];
  return Object.values(c.job.with).flatMap((b) => {
    const type = newCheckedType(b.name, change);
    return type && onlyAtRunTime(b)
      ? [
          `passes ${b.name} as an expression, and ${change.ref} now takes a ${type}: only literal values are checked`,
        ]
      : [];
  });
}

/** The secrets an entry needs from a call: those it requires, and those it reads without declaring them. */
const secretsNeeded = (e: RemoteEntry | undefined): string[] => [
  ...Object.entries(e?.secrets ?? {})
    .filter(([, s]) => s.required)
    .map(([n]) => n),
  ...(e?.undeclaredSecrets ?? []),
];

/**
 * With `secrets: inherit`, a secret the new version needs arrives only if the repository or organization has it,
 * which flowpact cannot see.
 */
function secretsInherited(c: Call, { ref, before, after }: RemoteChange): string[] {
  if (!c.job?.secretsInherit) return [];
  return addedNames(secretsNeeded(before), secretsNeeded(after)).map(
    (n) =>
      `passes secrets: inherit, and ${ref} now needs secret ${n}: whether this repository has it is not known`,
  );
}

/**
 * Whether what a job grants the workflow it calls is known: its `permissions:` or its workflow's, else, in a workflow
 * this repository calls, what every caller grants. Without, it gets the repository's or organization's default.
 */
function grantKnown(index: ProjectIndex, wf: WorkflowDecl, job: JobDecl, seen = new Set<string>()): boolean {
  if (job.permissions || wf.permissions) return true;
  const callers = index.callersOf(wf.path);
  if (!callers.length || seen.has(wf.path)) return false;
  seen.add(wf.path);
  return callers.every((call) => grantKnown(index, call.caller, call.job, seen));
}

/**
 * A call whose grant is not known, of a version that requests more: FP613 cannot tell whether the default token
 * permissions allow it.
 */
function permissionsDefault(index: ProjectIndex, c: Call, { ref, before, after }: RemoteChange): string[] {
  if (!c.job || c.step || c.unit.kind !== 'workflow' || grantKnown(index, c.unit, c.job)) return [];
  const wider = widenedScopes(before, after);
  if (!wider.length) return [];
  return [
    `sets no permissions, and ${ref} now requests ${wider.map(scopeLevel).join(', ')}: whether the default token permissions allow it is not known`,
  ];
}

/** The level each scope is requested at by the workflow or any of its jobs, the highest of them, as an entry records it. */
function requestedLevels(e: RemoteEntry | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of [e?.permissions, ...Object.values(e?.jobPermissions ?? {})])
    for (const [scope, level] of Object.entries(p ? levelsOf(p) : {}))
      out[scope] = Math.max(out[scope] ?? 0, level);
  return out;
}

/** The scopes `after` requests at a higher level than `before` did (`granted` is the level before). */
function widenedScopes(before: RemoteEntry | undefined, after: RemoteEntry): ShortScope[] {
  const was = requestedLevels(before);
  return Object.entries(requestedLevels(after)).flatMap(([scope, requested]) =>
    requested > (was[scope] ?? 0) ? [{ scope, requested, granted: was[scope] ?? 0 }] : [],
  );
}

const scopeLevel = (s: ShortScope) => `${escapeControl(s.scope)}: ${LEVEL_NAMES[s.requested]}`;

/** Whether an action can set outputs it does not declare: a JavaScript or Docker one, any but a composite action. */
const setsUndeclared = (e: RemoteEntry) => e.kind === 'action' && (e.using ?? 'composite') !== 'composite';

/** Whether a reference reads an output of the step with this id (`steps.<id>.outputs.<name>`). */
const readsStepOutput = (ref: LocatedRef, id: string) =>
  ref.context === 'steps' &&
  ref.path[0]?.toLowerCase() === id.toLowerCase() &&
  isProperty(ref.path[1], 'outputs');

/** Which of these outputs (in lower case) of a call's step its job, or its action, reads. */
function outputsRead(c: Call, id: string, names: Set<string>): string[] {
  const read = new Set<string>();
  for (const { site, ref } of refsOf(c.unit)) {
    const name = ref.path[2];
    if (site.job === c.job?.id && readsStepOutput(ref, id) && name && names.has(name.toLowerCase()))
      read.add(name);
  }
  return [...read];
}

/**
 * Outputs of the step the job or action reads that the new version no longer declares, when it is not a composite
 * action: JavaScript and Docker actions can set outputs they do not declare, so FP301 does not check them.
 */
function outputsMaybeSet(c: Call, { ref, before, after }: RemoteChange): string[] {
  const id = c.step?.id;
  if (!id || !setsUndeclared(after)) return [];
  const dropped = new Set(addedNames(after.outputs, before?.outputs).map((n) => n.toLowerCase()));
  return outputsRead(c, id, dropped).map(
    (n) => `reads output ${n}, which ${ref} no longer declares: a ${after.using} action can still set it`,
  );
}

/** The inputs both entries declare whose default moved, with the defaults before and after ('' for none). */
function movedDefaults(before: RemoteEntry, after: RemoteEntry): { name: string; from: Json; to: Json }[] {
  return Object.entries(inputsOf(after)).flatMap(([name, cur]) => {
    const old = lookup(inputsOf(before), name);
    const from = old?.default ?? '';
    const to = cur.default ?? '';
    return old && JSON.stringify(from) !== JSON.stringify(to) ? [{ name, from, to }] : [];
  });
}

/** The inputs a call leaves out whose default the change moved: the call now runs with another value. */
function defaultNotes(c: Call, { before, after }: RemoteChange): string[] {
  if (!before) return [];
  const passed = c.step?.with ?? c.job?.with ?? {};
  return movedDefaults(before, after)
    .filter((m) => !lookup(passed, m.name))
    .map(
      (m) =>
        `leaves out ${m.name}, whose default changed from ${JSON.stringify(m.from)} to ${JSON.stringify(m.to)}`,
    );
}

// ---------------------------------------------------------------------------
// The interface diff
// ---------------------------------------------------------------------------

/** A lockfile input as a contract input. */
const contractInput = (i: NonNullable<RemoteEntry['inputs']>[string]): ContractInput => ({
  ...(i.type ? { type: i.type } : {}),
  required: i.required === true,
  ...(i.default !== undefined ? { default: i.default } : {}),
  ...(i.options ? { options: i.options } : {}),
});

/** A record with its keys written as in `names` where they differ only in case. */
function keyedLike<T>(rec: Record<string, T>, names: string[]): Record<string, T> {
  const spelled = new Map(names.map((n) => [n.toLowerCase(), n]));
  return Object.fromEntries(Object.entries(rec).map(([n, v]) => [spelled.get(n.toLowerCase()) ?? n, v]));
}

/**
 * An entry with its input, secret and output names written as `like` writes them where they differ only in case:
 * GitHub matches them ignoring case, so `Token` → `token` is no change.
 */
function namedLike(e: RemoteEntry, like: RemoteEntry): RemoteEntry {
  const outputs = keyedLike(Object.fromEntries((e.outputs ?? []).map((o) => [o, o])), like.outputs ?? []);
  return {
    ...e,
    inputs: keyedLike(e.inputs ?? {}, Object.keys(like.inputs ?? {})),
    secrets: keyedLike(e.secrets ?? {}, Object.keys(like.secrets ?? {})),
    outputs: Object.keys(outputs),
  };
}

/** A workflow's declared secrets as a contract has them; nothing without any. */
function contractSecrets(e: RemoteEntry): Pick<Contract['interface'], 'secrets'> {
  const secrets = Object.entries(e.secrets ?? {});
  if (!secrets.length) return {};
  return { secrets: Object.fromEntries(secrets.map(([n, s]) => [n, { required: s.required === true }])) };
}

/** A lockfile entry as a contract, for `diffContracts`. */
const entryContract = (ref: string, e: RemoteEntry): Contract => ({
  $schema: '',
  version: SCHEMA_VERSIONS.contract,
  kind: e.kind,
  path: ref,
  ...(e.kind === 'workflow' ? { triggers: ['workflow_call'] } : {}),
  interface: {
    inputs: Object.fromEntries(Object.entries(e.inputs ?? {}).map(([n, i]) => [n, contractInput(i)])),
    ...contractSecrets(e),
    outputs: Object.fromEntries((e.outputs ?? []).map((o) => [o, {}])),
  },
  consumers: [],
});

/** The secrets a workflow reads without declaring them, which a call without `secrets: inherit` passes empty (FP205). */
const undeclaredSecretChanges = (before: RemoteEntry, after: RemoteEntry): ContractChange[] => [
  ...addedNames(before.undeclaredSecrets, after.undeclaredSecrets).map((n) => ({
    breaking: true,
    path: `secrets.${n}`,
    message: `reads secret "${n}" without declaring it — calls without secrets: inherit pass it empty`,
  })),
  ...addedNames(after.undeclaredSecrets, before.undeclaredSecrets).map((n) => ({
    breaking: false,
    path: `secrets.${n}`,
    message: `no longer reads undeclared secret "${n}"`,
  })),
];

/** A workflow whose jobs request a scope at a higher level: calls that grant less fail when the run starts (FP613). */
const permissionChanges = (before: RemoteEntry, after: RemoteEntry): ContractChange[] =>
  widenedScopes(before, after).map((s) => ({
    breaking: true,
    path: `permissions.${s.scope}`,
    message: `requests ${scopeLevel(s)} (was ${LEVEL_NAMES[s.granted]}) — calls that grant less fail when the run starts`,
  }));

/** An action's `runs.using` changed: a change of behaviour, not of the interface. */
function runtimeChange(before: RemoteEntry, after: RemoteEntry): ContractChange[] {
  if (after.kind !== 'action' || before.using === after.using) return [];
  const runtime = (e: RemoteEntry) => e.using ?? 'an unknown runtime';
  return [
    {
      breaking: false,
      path: 'runs.using',
      message: `runs on ${runtime(after)} instead of ${runtime(before)}: a change of behaviour the checks do not see`,
    },
  ];
}

/**
 * What changed in the interface: the contract diff, and what only the lockfile records — the secrets a workflow reads
 * without declaring them, the permissions its jobs request and an action's `runs.using`.
 */
const interfaceChanges = (ref: string, before: RemoteEntry, after: RemoteEntry): ContractChange[] => [
  ...diffContracts(entryContract(ref, namedLike(before, after)), entryContract(ref, after)),
  ...undeclaredSecretChanges(before, after),
  ...permissionChanges(before, after),
  ...runtimeChange(before, after),
];
