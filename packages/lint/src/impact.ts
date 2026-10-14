/**
 * Impact mode: grade what changed between a baseline (the base of a pull request, or the last release) and the working
 * tree for **published** units — reusable workflows and actions other repositories use — and compare it with the
 * release impact the pull request declares.
 */
import {
  type ActionDecl,
  type CheckName,
  type ContextResolver,
  calledFunctions,
  definitelyTruthy,
  type EnvironmentDecl,
  type ExprSite,
  type JobDecl,
  type Loc,
  type LocatedRef,
  matchesPattern,
  type PermissionsDecl,
  type ProjectIndex,
  type RunsOnDecl,
  refsOf,
  type StepDecl,
  UNKNOWN,
  type UnitDecl,
  type WorkflowDecl,
  workflowChecks,
} from '@ciatlas/core';
import { buildContract, diffContracts, pathHolds } from './contracts';

export const IMPACT_LEVELS = ['none', 'patch', 'minor', 'major'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];
export const levelRank = (l: ImpactLevel) => IMPACT_LEVELS.indexOf(l);
export const maxLevel = (levels: ImpactLevel[]): ImpactLevel =>
  levels.reduce<ImpactLevel>((a, b) => (levelRank(b) > levelRank(a) ? b : a), 'none');

export interface ImpactChange {
  /** The published unit (workflow path or action directory). */
  unit: string;
  kind:
    | 'check-name'
    | 'environment'
    | 'interface'
    | 'output'
    | 'unit'
    | 'permissions'
    | 'runner'
    | 'runtime'
    | 'uses';
  level: ImpactLevel;
  /** False when the change involves something flowpact cannot evaluate (event data, dynamic matrices, …). */
  certain: boolean;
  message: string;
  /** Where to report it: the head location, or the unit's file. */
  loc: Loc;
}

export interface ImpactPolicy {
  /**
   * Globs of published units. Default: `workflow_call` workflows (except files starting with `_`, the usual mark of an
   * internal one) and the repository's root `action.yml`.
   */
  publish?: string[];
  /** Which declared source decides; the others are advisory. Default: `explicit` when given, else `title`. */
  declaredBy?: 'explicit' | 'title' | 'labels';
  labels: Record<ImpactLevel, string>;
  /** Conventional Commits type → level; types not listed declare `none`. */
  types: Record<string, ImpactLevel>;
  /** Count changes flowpact cannot fully resolve towards the required impact (`fail`) or only warn (`warn`). */
  uncertain: 'warn' | 'fail';
}

export const DEFAULT_IMPACT_POLICY: ImpactPolicy = {
  labels: { major: 'semver:major', minor: 'semver:minor', patch: 'semver:patch', none: 'semver:none' },
  types: { feat: 'minor', fix: 'patch', perf: 'patch' },
  uncertain: 'warn',
};

/** Whether other repositories may use the unit. */
export function isPublished(unit: UnitDecl, policy: Pick<ImpactPolicy, 'publish'>): boolean {
  if (policy.publish)
    return policy.publish.some((p) => matchesPattern(unit.file, p) || matchesPattern(unit.path, p));
  if (unit.kind === 'workflow')
    return unit.triggers.includes('workflow_call') && !unit.path.split('/').pop()!.startsWith('_');
  return unit.path === '.';
}

const fileStart = (file: string): Loc => ({ file, line: 1, column: 1, endLine: 1, endColumn: 1 });

// ---------------------------------------------------------------------------
// Check names
// ---------------------------------------------------------------------------

/** One job's checks (a job of the workflow, or a job of a workflow it calls), keyed by the chain of job ids. */
interface JobChecks {
  chain: string;
  stem: string;
  names: CheckName[];
  certain: boolean;
}

function jobChecks(index: ProjectIndex, wf: WorkflowDecl): Map<string, JobChecks> {
  const out = new Map<string, JobChecks>();
  // A published workflow's inputs come from its consumers, so names that read them are not known statically.
  for (const c of workflowChecks(index, wf, 'consumer')) {
    const chain = c.jobs.map((j) => j.split('#')[1]).join(' > ');
    const cur = out.get(chain);
    if (cur) {
      cur.names.push(c);
      cur.certain &&= c.certain;
    } else out.set(chain, { chain, stem: c.stem, names: [c], certain: c.certain });
  }
  return out;
}

const quoteName = (n: string) => `"… / ${n}"`;

/** What comparing the checks of a workflow's jobs needs. */
interface NameDiff {
  /** Every name the head reports. */
  headNames: Set<string>;
  /** Every name the base reported. */
  baseNames: Set<string>;
  /** Records a change to the head workflow's checks. */
  add: (level: ImpactLevel, certain: boolean, message: string, loc: Loc) => void;
  /** Where to report a change to a head job: its name, the job, or the file start. */
  jobLoc: (chain: string) => Loc;
}

/** A base job without a counterpart in the head: the checks it reported that nothing reports any more. */
function goneJob(d: NameDiff, bj: JobChecks, file: string): void {
  const gone = bj.names.filter((n) => !d.headNames.has(n.name));
  if (!gone.length) return;
  d.add(
    'major',
    true,
    `${bj.names.length > 1 ? `checks ${quoteName(bj.stem)}` : `check ${quoteName(bj.names[0]!.name)}`} no longer reported; consumers that require ${bj.names.length > 1 ? 'them' : 'it'} wait forever`,
    fileStart(file),
  );
}

/** A job in both: a changed stem renames every check, else the names (matrix values) are compared. */
function compareJob(d: NameDiff, bj: JobChecks, hj: JobChecks): void {
  if (bj.stem !== hj.stem) {
    // The static part changed: every name the job reports changed, whatever the unknown values are.
    d.add(
      'major',
      true,
      `check ${quoteName(bj.stem)} is now ${quoteName(hj.stem)}; consumers that require the old name wait forever`,
      d.jobLoc(hj.chain),
    );
    return;
  }
  // Same stem: compare the names (matrix values). Unknown values cannot be compared.
  const removed = bj.names.filter((n) => n.certain && !d.headNames.has(n.name));
  const added = hj.names.filter((n) => n.certain && !d.baseNames.has(n.name));
  for (const n of removed)
    d.add(
      'major',
      true,
      `check ${quoteName(n.name)} no longer reported; consumers that require it wait forever`,
      d.jobLoc(hj.chain),
    );
  for (const n of added) d.add('minor', true, `new check ${quoteName(n.name)}`, d.jobLoc(hj.chain));
  const unsure = bj.names.some((n) => !n.certain) || hj.names.some((n) => !n.certain);
  if (unsure && JSON.stringify(bj.names.map((n) => n.name)) !== JSON.stringify(hj.names.map((n) => n.name)))
    d.add('major', false, `checks ${quoteName(bj.stem)} may report different names`, d.jobLoc(hj.chain));
}

/** A head job without a counterpart in the base: the checks it reports that the base did not. */
function newJob(d: NameDiff, hj: JobChecks): void {
  const fresh = hj.names.filter((n) => !d.baseNames.has(n.name));
  if (fresh.length)
    d.add(
      'minor',
      true,
      `new check${hj.names.length > 1 ? 's' : ''} ${quoteName(hj.names.length > 1 ? hj.stem : hj.names[0]!.name)}`,
      d.jobLoc(hj.chain),
    );
}

function checkNameChanges(
  base: ProjectIndex,
  head: ProjectIndex,
  b: WorkflowDecl,
  h: WorkflowDecl,
): ImpactChange[] {
  const before = jobChecks(base, b);
  const after = jobChecks(head, h);
  const out: ImpactChange[] = [];
  const d: NameDiff = {
    headNames: new Set([...after.values()].flatMap((j) => j.names.map((n) => n.name))),
    baseNames: new Set([...before.values()].flatMap((j) => j.names.map((n) => n.name))),
    add: (level, certain, message, loc) =>
      out.push({ unit: h.path, kind: 'check-name', level, certain, message, loc }),
    jobLoc: (chain) => {
      const id = chain.split(' > ')[0]!;
      const job: JobDecl | undefined = h.jobs[id];
      return job?.nameLoc ?? job?.loc ?? fileStart(h.file);
    },
  };
  const matchedHead = new Set<string>();

  for (const bj of before.values()) {
    // A job renamed by id but reporting the same names (or the same stem) is the same job to consumers.
    const hj =
      after.get(bj.chain) ?? [...after.values()].find((x) => !before.has(x.chain) && x.stem === bj.stem);
    if (!hj) {
      goneJob(d, bj, h.file);
      continue;
    }
    matchedHead.add(hj.chain);
    compareJob(d, bj, hj);
  }
  for (const hj of after.values()) {
    if (matchedHead.has(hj.chain) || before.has(hj.chain)) continue;
    newJob(d, hj);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interfaces, permissions, runtimes, uses
// ---------------------------------------------------------------------------

function contractLevel(path: string, breaking: boolean, message: string): ImpactLevel {
  const root = path.split('.')[0]!;
  // workflow_dispatch inputs belong to the publishing repository's manual runs; consumers call workflow_call.
  if (!['inputs', 'secrets', 'outputs'].includes(root)) return 'none';
  if (breaking) return 'major';
  if (/was added|now optional/.test(message)) return 'minor';
  if (/default/.test(message)) return 'minor';
  if (/description changed/.test(message)) return 'none';
  return 'patch';
}

/** The head declaration a contract change path (`inputs.<name>`, …) names; the file start when it was removed. */
function interfaceLoc(h: UnitDecl, path: string): Loc {
  const dot = path.indexOf('.');
  const kind = path.slice(0, dot);
  const name = path.slice(dot + 1);
  const decls = interfaceDecls(h, kind);
  return (dot > 0 && decls && Object.hasOwn(decls, name) ? decls[name]?.loc : undefined) ?? fileStart(h.file);
}

/** A unit's interface declarations of one kind (`inputs`, `secrets` of a workflow, `outputs`); none for others. */
function interfaceDecls(h: UnitDecl, kind: string): Record<string, { loc: Loc }> | undefined {
  if (h.kind === 'workflow')
    return kind === 'inputs' || kind === 'secrets' || kind === 'outputs' ? h.call?.[kind] : undefined;
  return kind === 'inputs' || kind === 'outputs' ? h[kind] : undefined;
}

function interfaceChanges(base: ProjectIndex, head: ProjectIndex, b: UnitDecl, h: UnitDecl): ImpactChange[] {
  const out: ImpactChange[] = [];
  for (const c of diffContracts(buildContract(base, b), buildContract(head, h))) {
    const level = contractLevel(c.path, c.breaking, c.message);
    if (level === 'none') continue;
    out.push({
      unit: h.path,
      kind: 'interface',
      level,
      certain: true,
      message: c.message,
      loc: interfaceLoc(h, c.path),
    });
  }
  return out;
}

type Scopes = Record<string, number> | 'inherit';
const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
const LEVEL_NAMES = ['none', 'read', 'write'];
const SCOPES = [
  'actions',
  'attestations',
  'checks',
  'contents',
  'deployments',
  'discussions',
  'id-token',
  'issues',
  'models',
  'packages',
  'pages',
  'pull-requests',
  'security-events',
  'statuses',
];

function scopesOf(p: PermissionsDecl | undefined): Scopes {
  if (p === undefined) return 'inherit';
  if (p === 'read-all' || p === 'write-all') {
    const level = p === 'read-all' ? 1 : 2;
    return Object.fromEntries(SCOPES.map((s) => [s, s === 'id-token' && level === 1 ? 0 : level]));
  }
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, RANK[v] ?? 0]));
}

/**
 * `pick` of each job that runs steps, by chain of job ids, including the jobs of called workflows: they run in the
 * caller's run, so GitHub checks their permissions against what the caller grants, and on the caller's runners.
 */
function byJobChain<T>(
  index: ProjectIndex,
  wf: WorkflowDecl,
  pick: (job: JobDecl, wf: WorkflowDecl) => T,
  depth = 0,
  seen = new Set<string>(),
): Map<string, T> {
  const out = new Map<string, T>();
  for (const job of Object.values(wf.jobs)) {
    const callee = job.uses ? index.calleeOf(job) : undefined;
    if (callee) {
      if (depth >= 10 || seen.has(callee.path)) continue;
      for (const [chain, v] of byJobChain(index, callee, pick, depth + 1, new Set([...seen, wf.path])))
        out.set(`${job.id} > ${chain}`, v);
      continue;
    }
    if (!job.uses) out.set(job.id, pick(job, wf));
  }
  return out;
}

/** What each job requests (see `byJobChain`). */
const requestedByJob = (index: ProjectIndex, wf: WorkflowDecl) =>
  byJobChain(index, wf, (job, w) => scopesOf(job.permissions ?? w.permissions));

function permissionChanges(
  base: ProjectIndex,
  head: ProjectIndex,
  b: WorkflowDecl,
  h: WorkflowDecl,
): ImpactChange[] {
  const before = requestedByJob(base, b);
  const after = requestedByJob(head, h);
  const workflowLevel = scopesOf(b.permissions);
  const out: ImpactChange[] = [];
  for (const [chain, hs] of after) {
    if (hs === 'inherit') continue;
    const bs = before.get(chain) ?? workflowLevel;
    const widened = Object.entries(hs).filter(([k, v]) =>
      bs === 'inherit' ? v >= 2 || (k === 'id-token' && v > 0) : v > (bs[k] ?? 0),
    );
    if (!widened.length) continue;
    const job = h.jobs[chain.split(' > ')[0]!];
    out.push({
      unit: h.path,
      kind: 'permissions',
      level: 'major',
      // From an explicit set we know it widened; from inherited permissions it depends on what callers grant.
      certain: bs !== 'inherit',
      message: `jobs.${chain.replaceAll(' > ', ' › ')} now requests ${widened.map(([k, v]) => `${k}: ${LEVEL_NAMES[v]}`).join(', ')}; callers that grant less fail when the run starts`,
      loc: job?.loc ?? fileStart(h.file),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/** A standard GitHub-hosted runner label, which every repository on github.com can run on. */
const HOSTED_LABEL = /^(ubuntu|windows|macos)-(latest|[\d.]+)(-arm|-intel)?$/i;

/** What a job needs of a runner: each label and the runner group, as one set. */
const requirements = (r: RunsOnDecl) =>
  new Set([...r.labels.map((l) => l.toLowerCase()), ...(r.group ? [`group ${r.group.toLowerCase()}`] : [])]);

/** Whether a job runs on one standard GitHub-hosted runner image. */
const isHosted = (r: RunsOnDecl) =>
  !r.dynamic && !r.group && r.labels.length === 1 && HOSTED_LABEL.test(r.labels[0]!);

const describeRunners = (r: RunsOnDecl) =>
  [r.labels.length ? `[${r.labels.join(', ')}]` : '', r.group ? `runner group "${r.group}"` : '']
    .filter(Boolean)
    .join(' in ');

const sameRunners = (a: RunsOnDecl, b: RunsOnDecl) =>
  JSON.stringify([...requirements(a)].sort()) === JSON.stringify([...requirements(b)].sort());

type RunnerChange = Omit<ImpactChange, 'unit' | 'kind'>;

/** Runners chosen at run time on one side: callers may not have them. */
const runtimeRunners = (at: string, h: RunsOnDecl): RunnerChange => ({
  level: 'major',
  certain: false,
  message: `${at} now runs on ${describeRunners(h)}, chosen at run time; callers without such a runner never start it`,
  loc: h.loc,
});

/** Another GitHub-hosted image: every caller has it. */
const hostedRunners = (at: string, b: RunsOnDecl | undefined, h: RunsOnDecl): RunnerChange | undefined =>
  b && {
    level: 'patch',
    certain: true,
    message: `${at} now runs on ${describeRunners(h)} instead of ${describeRunners(b)}`,
    loc: h.loc,
  };

/** Self-hosted or custom runners: major when they need a label or group the job did not need. */
function customRunners(at: string, b: RunsOnDecl | undefined, h: RunsOnDecl): RunnerChange {
  const before = b && !isHosted(b) ? requirements(b) : new Set<string>();
  if (![...requirements(h)].some((r) => !before.has(r)))
    return { level: 'patch', certain: true, message: `${at} now runs on ${describeRunners(h)}`, loc: h.loc };
  return {
    level: 'major',
    certain: true,
    message: `${at} now needs a runner with ${describeRunners(h)}; callers without one never start it`,
    loc: h.loc,
  };
}

/**
 * How a job's runners changed, or undefined when callers see no difference. A job runs on the caller's runners:
 * needing a label or group it did not need before is major (callers without such a runner never start it), a runner
 * chosen at run time is major but uncertain, and another GitHub-hosted image or fewer needs is a patch.
 */
function runnerChange(chain: string, b: RunsOnDecl | undefined, h: RunsOnDecl): RunnerChange | undefined {
  if (b && sameRunners(b, h)) return undefined;
  const at = `jobs.${chain.replaceAll(' > ', ' › ')}`;
  if (h.dynamic || b?.dynamic) return runtimeRunners(at, h);
  return isHosted(h) ? hostedRunners(at, b, h) : customRunners(at, b, h);
}

function runnerChanges(
  base: ProjectIndex,
  head: ProjectIndex,
  b: WorkflowDecl,
  h: WorkflowDecl,
): ImpactChange[] {
  const before = byJobChain(base, b, (job) => job.runsOn);
  const out: ImpactChange[] = [];
  for (const [chain, hr] of byJobChain(head, h, (job) => job.runsOn)) {
    const change = hr && runnerChange(chain, before.get(chain), hr);
    if (change) out.push({ unit: h.path, kind: 'runner', ...change });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

const envName = (e: EnvironmentDecl | undefined) => e?.name.toLowerCase();

/**
 * How a job's environment changed. A called workflow's job deploys to the caller's environment of that name, which
 * GitHub creates when it is missing, so nothing fails; but its protection rules (required reviewers, wait timers,
 * branch rules) and its secrets now apply, or no longer do. Minor either way, uncertain for a name chosen at run time.
 */
function environmentChange(
  at: string,
  b: EnvironmentDecl | undefined,
  h: EnvironmentDecl | undefined,
  fallback: Loc,
) {
  if (envName(b) === envName(h)) return undefined;
  const certain = !b?.dynamic && !h?.dynamic;
  if (!h)
    return {
      certain,
      message: `${at} no longer uses environment "${b!.name}"; its protection rules and secrets no longer apply to callers' runs`,
      loc: fallback,
    };
  return {
    certain,
    message: `${at} now uses environment "${h.name}"${b ? ` instead of "${b.name}"` : ''}; callers' environment of that name, its protection rules and secrets now apply (GitHub creates it when missing)`,
    loc: h.loc,
  };
}

function environmentChanges(
  base: ProjectIndex,
  head: ProjectIndex,
  b: WorkflowDecl,
  h: WorkflowDecl,
): ImpactChange[] {
  const before = byJobChain(base, b, (job) => job.environment);
  const loc = byJobChain(head, h, (job) => job.loc);
  const out: ImpactChange[] = [];
  for (const [chain, he] of byJobChain(head, h, (job) => job.environment)) {
    if (!before.has(chain) && !he) continue;
    const at = `jobs.${chain.replaceAll(' > ', ' › ')}`;
    const change = environmentChange(at, before.get(chain), he, loc.get(chain)!);
    if (change) out.push({ unit: h.path, kind: 'environment', level: 'minor', ...change });
  }
  return out;
}

function remoteUses(unit: UnitDecl): Set<string> {
  const out = new Set<string>();
  const steps = unit.kind === 'workflow' ? Object.values(unit.jobs).flatMap((j) => j.steps) : unit.steps;
  for (const s of steps) if (s.uses?.kind === 'remote-action') out.add(s.uses.raw.split('@')[0]!);
  if (unit.kind === 'workflow')
    for (const j of Object.values(unit.jobs))
      if (j.uses?.kind === 'remote-workflow') out.add(j.uses.raw.split('@')[0]!);
  return out;
}

function usesChanges(b: UnitDecl, h: UnitDecl): ImpactChange[] {
  const before = remoteUses(b);
  return [...remoteUses(h)]
    .filter((u) => !before.has(u))
    .sort()
    .map((u) => ({
      unit: h.path,
      kind: 'uses' as const,
      level: 'minor' as const,
      certain: true,
      message: `now uses ${u}; consumers whose organization only allows listed actions (or requires SHA pinning) must allow it`,
      loc: fileStart(h.file),
    }));
}

function runtimeChanges(b: ActionDecl, h: ActionDecl): ImpactChange[] {
  if ((b.using ?? '') === (h.using ?? '')) return [];
  return [
    {
      unit: h.path,
      kind: 'runtime',
      level: 'major',
      certain: true,
      message: `runs.using changed from ${b.using ?? '(none)'} to ${h.using ?? '(none)'}; runners or GHES versions without it cannot run the action`,
      loc: fileStart(h.file),
    },
  ];
}

// ---------------------------------------------------------------------------
// Output reliability
// ---------------------------------------------------------------------------

/** A condition an output's source runs under: the job or step that has it, and its `if:` as written. */
interface SourceCondition {
  where: string;
  text: string;
}

/** Every context unknown: what holds whatever the run's event, inputs and earlier results are. */
const ANY_RUN: ContextResolver = () => UNKNOWN;

/** Status functions: with one, a job runs although a job it needs did not succeed. */
const STATUS_FUNCTIONS = new Set(['always', 'cancelled', 'failure', 'success']);

/**
 * The condition an `if:` puts on its job or step, or undefined where it holds on every run as far as the files tell:
 * there is none, it reads no context (`success()`, `always()`), or it is true whatever the contexts hold.
 */
function realCondition(ifValue: boolean | undefined, site: ExprSite | undefined): string | undefined {
  if (ifValue === false) return 'false';
  if (!site?.segments.some((seg) => seg.refs.length)) return undefined;
  const [only] = site.segments;
  if (site.segments.length === 1 && only?.expr.ast && definitelyTruthy(only.expr.ast, ANY_RUN))
    return undefined;
  return site.text.trim();
}

/** Whether a job's `if:` calls a status function, so it runs whatever the jobs it needs did. */
const runsDespiteNeeds = (site: ExprSite | undefined) =>
  !!site?.segments.some((seg) =>
    calledFunctions(seg.expr).some((f) => STATUS_FUNCTIONS.has(f.toLowerCase())),
  );

/** The conditions a job runs under: its own, and, unless its `if:` calls a status function, those of the jobs it needs. */
function jobConditions(wf: WorkflowDecl, id: string, seen = new Set<string>()): SourceCondition[] {
  const job = wf.jobs[id];
  if (!job || seen.has(id)) return [];
  seen.add(id);
  const own = realCondition(job.ifValue, job.ifSite);
  const out = own ? [{ where: `jobs.${id}`, text: own }] : [];
  if (!runsDespiteNeeds(job.ifSite)) for (const n of job.needs) out.push(...jobConditions(wf, n.id, seen));
  return out;
}

const sameName = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

/** Whether a site is the value of output `key` (of job `job`, when given) in `field`. */
const isOutputSite = (site: ExprSite, field: ExprSite['field'], key: string, job?: string) =>
  site.field === field && sameName(site.key, key) && (job === undefined || site.job === job);

/** The owner and name of `<owner>.outputs.<name>` of `context`, or undefined for any other reference. */
function outputRef(ref: LocatedRef, context: string): { owner: string; name: string } | undefined {
  const [owner, outputs, name] = ref.path;
  return ref.context === context && owner && name && sameName(outputs, 'outputs')
    ? { owner, name }
    : undefined;
}

/** The `outputs` named as a source in an output's value: `<owner>.outputs.<name>` of `context`, by owner. */
function sourcesIn(unit: UnitDecl, field: ExprSite['field'], key: string, context: string, job?: string) {
  return [...refsOf(unit)].flatMap(({ site, ref }) => {
    const src = isOutputSite(site, field, key, job) ? outputRef(ref, context) : undefined;
    return src ? [src] : [];
  });
}

const stepNamed = (steps: StepDecl[], id: string) => steps.find((s) => sameName(s.id, id));

/** The condition a step puts on the outputs it sets, at `where`. */
function stepConditions(steps: StepDecl[], id: string, where: string): SourceCondition[] {
  const step = stepNamed(steps, id);
  const own = step && realCondition(step.ifValue, step.ifSite);
  return own ? [{ where: `${where}.steps.${id}`, text: own }] : [];
}

/**
 * The conditions each source of a job output runs under, one list per source: the job's, and the step's that sets
 * it; for a job that calls a reusable workflow, the conditions of that workflow's output.
 */
function jobOutputSources(
  index: ProjectIndex,
  wf: WorkflowDecl,
  id: string,
  name: string,
  depth: number,
): SourceCondition[][] {
  const job = wf.jobs[id];
  if (!job) return [];
  const own = jobConditions(wf, id);
  const callee = job.uses ? index.calleeOf(job) : undefined;
  if (callee)
    return workflowOutputSources(index, callee, name, depth + 1).map((c) => [
      ...own,
      ...c.map((x) => ({ ...x, where: `jobs.${id} › ${x.where}` })),
    ]);
  return sourcesIn(wf, 'job.output', name, 'steps', id).map((s) => [
    ...own,
    ...stepConditions(job.steps, s.owner, `jobs.${id}`),
  ]);
}

/** One list of conditions per source of a reusable workflow's `workflow_call` output. */
function workflowOutputSources(
  index: ProjectIndex,
  wf: WorkflowDecl,
  name: string,
  depth = 0,
): SourceCondition[][] {
  if (depth > 10) return [];
  return sourcesIn(wf, 'workflow.output', name, 'jobs').flatMap((s) =>
    jobOutputSources(index, wf, s.owner, s.name, depth),
  );
}

/**
 * The conditions each output of a published unit is set under: none when it is set on every run that reaches it (a
 * source without conditions, or no source to judge), else those of every source.
 */
function outputConditions(index: ProjectIndex, unit: UnitDecl): Map<string, SourceCondition[]> {
  const out = new Map<string, SourceCondition[]>();
  const outputs = unit.kind === 'workflow' ? unit.call?.outputs : unit.outputs;
  for (const name of Object.keys(outputs ?? {})) {
    const sources =
      unit.kind === 'workflow'
        ? workflowOutputSources(index, unit, name)
        : sourcesIn(unit, 'action.output', name, 'steps').map((s) => stepConditions(unit.steps, s.owner, ''));
    const always = !sources.length || sources.some((c) => !c.length);
    out.set(name.toLowerCase(), always ? [] : sources.flat());
  }
  return out;
}

const describeCondition = (c: SourceCondition) => `${c.where.replace(/^\./, '')} runs (if: ${c.text})`;

/** Outputs set on every run before that are now set only under a condition: callers on other runs read `''`. */
function outputReliabilityChanges(
  base: ProjectIndex,
  head: ProjectIndex,
  b: UnitDecl,
  h: UnitDecl,
): ImpactChange[] {
  const before = outputConditions(base, b);
  const decls = (h.kind === 'workflow' ? h.call?.outputs : h.outputs) ?? {};
  const out: ImpactChange[] = [];
  for (const [key, conditions] of outputConditions(head, h)) {
    if (!conditions.length || before.get(key)?.length !== 0) continue;
    const [name, decl] = Object.entries(decls).find(([n]) => n.toLowerCase() === key)!;
    const when = [...new Map(conditions.map((c) => [describeCondition(c), c])).keys()].join(' and ');
    out.push({
      unit: h.path,
      kind: 'output',
      level: 'major',
      certain: false,
      message: `output "${name}" is now set only when ${when}; callers that read it on other runs get ''`,
      loc: decl.loc,
    });
  }
  return out;
}

const describeUnit = (u: UnitDecl) =>
  u.kind === 'workflow' ? `reusable workflow ${u.path}` : `action ${u.path}`;

/** A published base unit whose path the head does not have, or has for another kind of unit. */
const removedUnit = (path: string, b: UnitDecl): ImpactChange => ({
  unit: path,
  kind: 'unit',
  level: 'major',
  certain: true,
  message: `${describeUnit(b)} was removed or moved; consumers that reference it fail`,
  loc: fileStart(b.file),
});

/** The change that stops comparing a published unit: the head no longer publishes it, or a side has YAML errors. */
function blockingChange(
  path: string,
  b: UnitDecl,
  h: UnitDecl,
  policy: Pick<ImpactPolicy, 'publish'>,
): ImpactChange | undefined {
  if (!isPublished(h, policy)) {
    return {
      unit: path,
      kind: 'unit',
      level: 'major',
      certain: true,
      message:
        h.kind === 'workflow'
          ? `${path} can no longer be called (no workflow_call)`
          : `${path} is no longer published`,
      loc: fileStart(h.file),
    };
  }
  if (h.parseErrors.length) {
    return {
      unit: path,
      kind: 'unit',
      level: 'major',
      certain: !b.parseErrors.length,
      message: `${describeUnit(h)} has YAML errors (${h.parseErrors[0]!.message}); consumers' runs fail`,
      loc: h.parseErrors[0]!.loc,
    };
  }
  if (b.parseErrors.length) {
    return {
      unit: path,
      kind: 'unit',
      level: 'patch',
      certain: false,
      message: `${describeUnit(h)} could not be compared: the baseline has YAML errors`,
      loc: fileStart(h.file),
    };
  }
  return undefined;
}

/** The graded changes between the base and head versions of a published unit that both parse. */
function comparedChanges(base: ProjectIndex, head: ProjectIndex, b: UnitDecl, h: UnitDecl): ImpactChange[] {
  const out = [
    ...interfaceChanges(base, head, b, h),
    ...outputReliabilityChanges(base, head, b, h),
    ...usesChanges(b, h),
  ];
  if (b.kind === 'workflow' && h.kind === 'workflow')
    out.push(
      ...checkNameChanges(base, head, b, h),
      ...permissionChanges(base, head, b, h),
      ...runnerChanges(base, head, b, h),
      ...environmentChanges(base, head, b, h),
    );
  if (b.kind === 'action' && h.kind === 'action') out.push(...runtimeChanges(b, h));
  return out;
}

/** Adds to `out` the units the head publishes that the base did not (or did not publish). */
function newUnits(
  out: ImpactChange[],
  baseUnits: Map<string, UnitDecl>,
  headUnits: Map<string, UnitDecl>,
  policy: Pick<ImpactPolicy, 'publish'>,
): void {
  for (const [path, h] of headUnits) {
    if (!isPublished(h, policy)) continue;
    const b = baseUnits.get(path);
    if (b && isPublished(b, policy)) continue;
    out.push({
      unit: path,
      kind: 'unit',
      level: 'minor',
      certain: true,
      message: `new ${describeUnit(h)}`,
      loc: fileStart(h.file),
    });
  }
}

/**
 * Every graded change to a published unit between `base` and `head`. `headExists` tells whether a unit's file is still
 * in the working tree (a unit can exist without being loaded, e.g. an action nothing here uses any more). With `units`,
 * only the units of those paths are graded.
 */
export function impactChanges(
  base: ProjectIndex,
  head: ProjectIndex,
  policy: Pick<ImpactPolicy, 'publish'>,
  headExists: (file: string) => boolean = () => false,
  units?: ReadonlySet<string>,
): ImpactChange[] {
  const out: ImpactChange[] = [];
  const graded = (u: UnitDecl) => !units || units.has(u.path);
  const baseUnits = new Map(
    base
      .units()
      .filter(graded)
      .map((u) => [u.path, u]),
  );
  const headUnits = new Map(
    head
      .units()
      .filter(graded)
      .map((u) => [u.path, u]),
  );
  for (const [path, b] of baseUnits) {
    if (!isPublished(b, policy)) continue;
    const h = headUnits.get(path);
    if (!h || h.kind !== b.kind) {
      if (!h && headExists(b.file)) continue;
      out.push(removedUnit(path, b));
      continue;
    }
    const blocking = blockingChange(path, b, h, policy);
    if (blocking) out.push(blocking);
    else out.push(...comparedChanges(base, head, b, h));
  }
  newUnits(out, baseUnits, headUnits, policy);
  return out;
}

// ---------------------------------------------------------------------------
// Declared impact and verdict
// ---------------------------------------------------------------------------

export interface DeclaredSource {
  kind: 'explicit' | 'title' | 'labels' | 'version';
  /** What was read, e.g. the title or the label. */
  value: string;
  level: ImpactLevel;
}

/** `feat!: …` → major, `feat: …` → minor, `fix: …` → patch, other types → none; not Conventional → undefined. */
export function levelFromTitle(title: string, types: Record<string, ImpactLevel>): ImpactLevel | undefined {
  const m = /^([a-z]+)(\([^)]*\))?(!)?: \S/i.exec(title.trim());
  if (!m) return undefined;
  if (m[3]) return 'major';
  return types[m[1]!.toLowerCase()] ?? 'none';
}

export function levelFromLabels(labels: string[], map: Record<ImpactLevel, string>): ImpactLevel | undefined {
  const found = IMPACT_LEVELS.filter((l) => labels.some((x) => x.toLowerCase() === map[l].toLowerCase()));
  return found.length ? maxLevel([...found]) : undefined;
}

/** release-please's pre-1.0 settings (`bump-minor-pre-major`, `bump-patch-for-minor-pre-major`). */
export interface PreMajorBumps {
  bumpMinorPreMajor: boolean;
  bumpPatchForMinorPreMajor: boolean;
}

export interface DeclaredInput {
  explicit?: ImpactLevel;
  title?: string;
  labels?: string[];
  /** A release pull request: the proposed version and the version of the baseline release. */
  release?: { version: string; previous: string } & PreMajorBumps;
}

/**
 * The level a version bump declares. Before 1.0, release-please bumps the minor for breaking changes with
 * `bump-minor-pre-major`, and the patch for features with `bump-patch-for-minor-pre-major`.
 */
export function levelFromVersions(previous: string, next: string, bumps: PreMajorBumps): ImpactLevel {
  const parse = (v: string) =>
    v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number) as [number, number, number];
  const [pa, pb, pc] = parse(previous);
  const [na, nb, nc] = parse(next);
  if (na > pa) return 'major';
  if (nb > pb) return na === 0 && bumps.bumpMinorPreMajor ? 'major' : 'minor';
  if (nc > pc) return na === 0 && bumps.bumpPatchForMinorPreMajor ? 'minor' : 'patch';
  return 'none';
}

export interface ImpactVerdict {
  required: ImpactLevel;
  declared?: DeclaredSource;
  /** Sources that are not authoritative; one declaring more than the authoritative source is a conflict. */
  advisory: DeclaredSource[];
  conflict?: DeclaredSource;
  /** Required impact is covered by the declared one (or nothing is declared). */
  ok: boolean;
}

/** The changes that count towards the required impact. */
export const countedChanges = (changes: ImpactChange[], policy: Pick<ImpactPolicy, 'uncertain'>) =>
  changes.filter((c) => c.certain || policy.uncertain === 'fail');

/** Every source that declares a level: the explicit level, the release version (else the title), and the labels. */
function declaredSources(input: DeclaredInput, policy: ImpactPolicy): DeclaredSource[] {
  const sources: DeclaredSource[] = [];
  if (input.explicit) sources.push({ kind: 'explicit', value: input.explicit, level: input.explicit });
  if (input.release) {
    const level = levelFromVersions(input.release.previous, input.release.version, input.release);
    sources.push({ kind: 'version', value: `${input.release.previous} → ${input.release.version}`, level });
  } else if (input.title !== undefined) {
    const level = levelFromTitle(input.title, policy.types);
    if (level) sources.push({ kind: 'title', value: input.title, level });
  }
  if (input.labels?.length) {
    const level = levelFromLabels(input.labels, policy.labels);
    if (level) sources.push({ kind: 'labels', value: input.labels.join(', '), level });
  }
  return sources;
}

/**
 * Exactly one authoritative source: an explicit level, the release version, or the configured one (title by default).
 * Falling back to another source would declare something the release tool never reads.
 */
const authorityOf = (input: DeclaredInput, policy: ImpactPolicy): DeclaredSource['kind'] =>
  input.explicit ? 'explicit' : input.release ? 'version' : (policy.declaredBy ?? 'title');

export function impactVerdict(
  changes: ImpactChange[],
  input: DeclaredInput,
  policy: ImpactPolicy,
): ImpactVerdict {
  const required = maxLevel(countedChanges(changes, policy).map((c) => c.level));
  const sources = declaredSources(input, policy);
  const authority = authorityOf(input, policy);
  const declared = sources.find((s) => s.kind === authority);
  const advisory = sources.filter((s) => s !== declared);
  const conflict = declared
    ? advisory.find((s) => levelRank(s.level) > levelRank(declared.level))
    : undefined;
  // `patch` against `none` is not worth failing for: the change reaches users with the next release either way.
  const under =
    declared && levelRank(required) > levelRank(declared.level) && levelRank(required) >= levelRank('minor');
  return {
    required,
    ...(declared ? { declared } : {}),
    advisory,
    ...(conflict ? { conflict } : {}),
    ok: !under && !conflict,
  };
}

/**
 * Paths that narrow impact mode to the published units within them, as `lint`, `check` and `impact` were given them.
 */
export interface ImpactPaths {
  /** Each path as given, and relative to the root with `/` separators. */
  paths: { given: string; relative: string }[];
  /** The workflow and action files of the working tree the paths name (the project's targets). */
  targets: ReadonlySet<string>;
}

/** What paths narrowed impact mode to. */
export interface ImpactScope {
  /** The paths, relative to the root. */
  paths: string[];
  /** The published units within them, in the baseline or the working tree: the only units graded. */
  units: string[];
}

/** What paths or `ignore` left out of impact mode, when they leave out anything. */
export interface ImpactNarrowed {
  /**
   * The published units (within the paths) that `ignore` leaves out, so they are not graded: both the baseline's and the
   * pull request's match each file of them within the paths.
   */
  ignored: string[];
  /**
   * Where findings about the verdict go when no change is there to place them on: the first published file graded in
   * the working tree, else the first workflow or action file of the working tree (within the paths) that `ignore` does
   * not leave out. Absent when there is neither, say paths that hold only what the change removed, none of it
   * published, or an `ignore` that matches every workflow and action: there is nothing to report on.
   */
  anchor?: string;
}

/** What impact mode looks at: every unit, or with paths those within them; never one that `ignore` leaves out. */
export interface ImpactLookAt {
  /** Paths that narrow impact mode to the units within them. */
  within?: ImpactPaths;
  /**
   * The `ignore` patterns of the baseline's config and of the pull request's (the working tree's). A unit whose file
   * both match is not graded, so neither adding a published unit to `ignore` nor taking it out in the pull request lets
   * its change through. Without them, every unit is graded. `afterMerge` is the pull request's as its commits have it,
   * where that differs from the working tree's (a base config in a submodule checked out at another commit than the
   * pull request records): it must match the file too, and it is what applies once the pull request is merged.
   */
  ignore?: { baseline: readonly string[]; head: readonly string[]; afterMerge?: readonly string[] };
}

const matchesAny = (patterns: readonly string[], file: string) =>
  patterns.some((p) => matchesPattern(file, p));

/** Whether a file is within the paths; every file is without them. */
const coveredBy = (within: ImpactPaths | undefined) => (file: string) =>
  !within || within.targets.has(file) || within.paths.some((p) => pathHolds(p.relative, file));

/** Whether impact mode leaves a file out: both the baseline's and the pull request's `ignore` match it. */
const leftOutBy = (ignore: ImpactLookAt['ignore']) => (file: string) =>
  ignore !== undefined &&
  matchesAny(ignore.baseline, file) &&
  matchesAny(ignore.head, file) &&
  (!ignore.afterMerge || matchesAny(ignore.afterMerge, file));

/**
 * The units of either side impact mode looks at, by path; undefined when it looks at every unit (no paths, and an
 * `ignore` that leaves out none).
 */
function unitsLookedAt(base: ProjectIndex, head: ProjectIndex, { within, ignore }: ImpactLookAt) {
  if (!within && !ignore) return undefined;
  const covered = coveredBy(within);
  const leftOut = leftOutBy(ignore);
  const units = [...base.units(), ...head.units()];
  const looked = units.filter((u) => covered(u.file) && !leftOut(u.file));
  return within || looked.length < units.length ? new Set(looked.map((u) => u.path)) : undefined;
}

/**
 * The published units (within the paths) that the pull request's own `ignore` leaves out once it is merged and the
 * baseline's does not: graded until then. Each is a unit whose every file once merged (the working tree's, or the
 * baseline's for a unit the pull request removes, within the paths) the pull request's matches, and one of whose files
 * on either side the baseline's does not, so a move that `ignore` does not follow leaves no unit out, and an `ignore`
 * that follows it does.
 */
function ignoreAddedOf(
  base: ProjectIndex,
  head: ProjectIndex,
  policy: Pick<ImpactPolicy, 'publish'>,
  { within, ignore }: ImpactLookAt,
): string[] {
  if (!ignore) return [];
  const covered = coveredBy(within);
  const files = new Map<string, { base: string[]; head: string[] }>();
  const add = (side: 'base' | 'head') => (u: UnitDecl) => {
    if (!isPublished(u, policy) || !covered(u.file)) return;
    const of = files.get(u.path) ?? { base: [], head: [] };
    of[side].push(u.file);
    files.set(u.path, of);
  };
  base.units().forEach(add('base'));
  head.units().forEach(add('head'));
  const merged = ignore.afterMerge ?? ignore.head;
  const leavesOut = (patterns: readonly string[], of: string[]) => of.every((f) => matchesAny(patterns, f));
  return [...files]
    .filter(
      ([, of]) =>
        leavesOut(merged, of.head.length ? of.head : of.base) &&
        !leavesOut(ignore.baseline, [...of.base, ...of.head]),
    )
    .map(([path]) => path)
    .sort();
}

/** The file of the working tree to place findings about the verdict on, when no change is there (see `anchor`). */
function anchorOf(head: ProjectIndex, { within, ignore }: ImpactLookAt, published: UnitDecl[]) {
  const headFiles = head.units().map((u) => u.file);
  const graded = published.map((u) => u.file).filter((f) => headFiles.includes(f));
  const leftOut = leftOutBy(ignore);
  const others = (within ? [...within.targets] : headFiles).filter((f) => !leftOut(f));
  return graded.sort()[0] ?? others.sort()[0];
}

/**
 * What paths or `ignore` left out, given the units impact mode looks at (`units`, by path) and the published ones among
 * them. A unit with a file `ignore` leaves out is graded all the same when another file of it is looked at (after a move
 * `ignore` does not follow, from `action.yml` to `action.yaml`), so it is not named as left out.
 */
function narrowedOf(
  base: ProjectIndex,
  head: ProjectIndex,
  policy: Pick<ImpactPolicy, 'publish'>,
  lookAt: ImpactLookAt,
  graded: { units: ReadonlySet<string>; published: UnitDecl[] },
): ImpactNarrowed {
  const covered = coveredBy(lookAt.within);
  const leftOut = leftOutBy(lookAt.ignore);
  const ignored = [...base.units(), ...head.units()].filter(
    (u) => isPublished(u, policy) && covered(u.file) && leftOut(u.file) && !graded.units.has(u.path),
  );
  const anchor = anchorOf(head, lookAt, graded.published);
  return { ignored: [...new Set(ignored.map((u) => u.path))].sort(), ...(anchor ? { anchor } : {}) };
}

/** What the paths narrowed impact mode to, given the published units within them. */
function scopeOf(within: ImpactPaths, published: UnitDecl[]): ImpactScope {
  return {
    paths: [...new Set(within.paths.map((p) => p.relative))],
    units: [...new Set(published.map((u) => u.path))].sort(),
  };
}

/** Impact mode's result: where the baseline came from, every graded change and the verdict. */
export interface ImpactResult {
  baseline: { kind: 'ref' | 'release'; ref: string; commit: string };
  changes: ImpactChange[];
  verdict: ImpactVerdict;
  policy: ImpactPolicy;
  /**
   * Files of the published units (base and head) that were graded, e.g. to place findings that are not about one
   * change.
   */
  publishedFiles: string[];
  /** With paths: what they narrowed impact mode to. Without, every published unit is graded. */
  scope?: ImpactScope;
  /** When paths or `ignore` leave out units: which published ones `ignore` does, and where to report the verdict. */
  narrowed?: ImpactNarrowed;
  /**
   * The published units that the pull request's own `ignore` leaves out once it is merged and the baseline's does not
   * (see `ImpactLookAt.ignore`): graded until it is merged, left out after.
   */
  ignoreAdded?: string[];
}

/**
 * Grades the changes and judges the declaration in one step. Only the published units impact mode looks at count (with
 * paths, those within them; never one that `ignore` leaves out), so the verdict is about those units alone.
 */
export function computeImpact(
  base: ProjectIndex,
  head: ProjectIndex,
  baseline: ImpactResult['baseline'],
  declared: DeclaredInput,
  policy: ImpactPolicy,
  lookAt: ImpactLookAt = {},
): ImpactResult {
  const { within } = lookAt;
  const units = unitsLookedAt(base, head, lookAt);
  const changes = impactChanges(base, head, policy, undefined, units);
  const published = [...head.units(), ...base.units()].filter(
    (u) => isPublished(u, policy) && (!units || units.has(u.path)),
  );
  const ignoreAdded = ignoreAddedOf(base, head, policy, lookAt);
  return {
    baseline,
    changes,
    verdict: impactVerdict(changes, declared, policy),
    policy,
    publishedFiles: [...new Set(published.map((u) => u.file))].sort(),
    ...(within ? { scope: scopeOf(within, published) } : {}),
    ...(units ? { narrowed: narrowedOf(base, head, policy, lookAt, { units, published }) } : {}),
    ...(ignoreAdded.length ? { ignoreAdded } : {}),
  };
}
