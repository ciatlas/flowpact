import {
  type CallSite,
  escapeControl,
  type JobDecl,
  type PermissionsDecl,
  type ProjectIndex,
  type WorkflowDecl,
} from '@ciatlas/core';
import { byJobChain } from '../job-chains';
import { LEVEL_NAMES, levelsOf, type ShortScope, shortScopes } from '../permissions';
import { addPairs, keyLoc, replaceValue, type Suggestion, suggestion, type YamlPath } from '../suggestions';
import { defineRule, type RelatedLocation, type RuleContext, type RuleDefinition } from './types';

const ungrantedPermissions = defineRule({
  code: 'FP613',
  name: 'ungranted-permissions',
  category: 'structure',
  defaultSeverity: 'error',
  docs: {
    summary: 'A job of a called workflow requests a permission the call does not grant.',
    why:
      "A called workflow's jobs run with the caller's `GITHUB_TOKEN` and can only keep or lower its permissions. " +
      "GitHub refuses the whole run when it starts (\"The nested job … is requesting 'contents: write', but is only " +
      "allowed 'contents: read'\").",
    fix:
      "Grant the permission in the calling job's `permissions:`; a job's `permissions:` replaces the workflow's for " +
      'that job only. If the called job does not need it, lower its `permissions:` instead.',
    scope:
      "What a call grants is the calling job's `permissions:`, else its workflow's. With neither, it gets the " +
      "repository's or organization's default, which flowpact cannot see, so the call is not checked; when the calling " +
      'workflow is itself called, the workflows it calls are checked against what its callers grant instead. What a called ' +
      "job requests is its `permissions:`, else its workflow's (reported once for every job that uses them); a job " +
      'with neither gets what the call grants. A called job that calls another workflow requests its permissions for ' +
      'all of it, and the jobs of that workflow are checked against them at that call. Jobs are checked whatever ' +
      'their `if:`, as GitHub checks them before any job starts. A remote reusable workflow is not checked: the remote ' +
      'interfaces lockfile does not record what its jobs request. Whether a job requests more than it needs is not ' +
      'checked.',
    examples: {
      bad: `permissions:
  contents: read
jobs:
  release:
    uses: ./.github/workflows/release.yml   # its job publish requests contents: write`,
      good: `jobs:
  release:
    uses: ./.github/workflows/release.yml
    permissions:
      contents: write`,
    },
  },
  check(ctx) {
    for (const call of ctx.index.callSites) {
      const grant = grantOf(call);
      if (!grant) continue;
      for (const r of requestsOf(ctx.index, call.callee)) {
        const short = shortScopes(grant.permissions, r.scopes);
        if (short.length) reportShort(ctx, call, grant, r, short);
      }
    }
  },
});

/** What a call grants, and where: the calling job's `permissions:`, else its workflow's; none with neither. */
interface Grant {
  permissions: PermissionsDecl;
  path: YamlPath;
}

function grantOf(call: CallSite): Grant | undefined {
  if (call.job.permissions)
    return { permissions: call.job.permissions, path: ['jobs', call.job.id, 'permissions'] };
  if (call.caller.permissions) return { permissions: call.caller.permissions, path: ['permissions'] };
  return undefined;
}

/** What a job asks for: its own `permissions:`, else its workflow's (`own` false); nothing with neither. */
interface Asked {
  own: boolean;
  scopes: Record<string, number>;
}

const askedBy = (job: JobDecl, wf: WorkflowDecl): Asked | null =>
  job.permissions
    ? { own: true, scopes: levelsOf(job.permissions) }
    : wf.permissions
      ? { own: false, scopes: levelsOf(wf.permissions) }
      : null;

/**
 * What a called workflow requests: the `permissions:` of the job `job`, or of the workflow itself without one, reached
 * through the calling jobs `via` (each in the workflow the one before calls).
 */
interface Request {
  via: string[];
  job?: string;
  scopes: Record<string, number>;
}

/**
 * Every request of a called workflow (see `byJobChain`): each job's own `permissions:`, and its workflow's once for
 * the jobs that have none (GitHub says "The workflow is requesting …"). A job that calls another workflow requests
 * them for all of it, and GitHub checks the jobs of that workflow against them at that call; with neither, it hands on
 * what it is granted, so they are followed. A job with neither requests nothing: it gets what it is granted.
 */
function requestsOf(index: ProjectIndex, wf: WorkflowDecl): Request[] {
  const out = new Map<string, Request>();
  for (const [chain, asked] of byJobChain(index, wf, askedBy, (job, w) => askedBy(job, w) ?? undefined)) {
    if (!asked) continue;
    const via = chain.split(' > ');
    const job = via.pop()!;
    const r: Request = asked.own ? { via, job, scopes: asked.scopes } : { via, scopes: asked.scopes };
    out.set(JSON.stringify([r.via, r.job]), r);
  }
  return [...out.values()];
}

const level = (s: ShortScope, which: 'requested' | 'granted') =>
  `${escapeControl(s.scope)}: ${LEVEL_NAMES[s[which]]}`;
const levels = (short: ShortScope[], which: 'requested' | 'granted') =>
  short.map((s) => level(s, which)).join(', ');

function reportShort(ctx: RuleContext, call: CallSite, grant: Grant, r: Request, short: ShortScope[]): void {
  const file = call.caller.source.path;
  const callLoc = call.job.uses?.loc ?? call.job.loc;
  const wanted = levels(short, 'requested');
  const { where, related } = describeRequest(ctx.index, call.callee, r, wanted);
  ctx.report({
    message: `${where} requests ${wanted}, but jobs.${call.job.id} grants ${levels(short, 'granted')}`,
    loc: keyLoc(ctx.index, file, grant.path) ?? callLoc,
    symbol: `${call.caller.path}#jobs.${call.job.id}.permissions`,
    related: [{ loc: callLoc, message: `jobs.${call.job.id} calls ${call.callee.path}` }, ...related],
    suggestions: [raiseGrant(ctx.index, call, grant, short)],
  });
}

/**
 * Who makes a request, as `<workflow> › jobs.<id> › <workflow it calls> › jobs.<id>`, and where: the calls down its
 * calling jobs, then its `permissions:`.
 */
function describeRequest(
  index: ProjectIndex,
  callee: WorkflowDecl,
  r: Request,
  wanted: string,
): { where: string; related: RelatedLocation[] } {
  const parts = [callee.path];
  const related: RelatedLocation[] = [];
  let wf = callee;
  for (const id of r.via) {
    const job = wf.jobs[id]!;
    const next = index.calleeOf(job)!;
    related.push({ loc: job.uses?.loc ?? job.loc, message: `jobs.${id} calls ${next.path}` });
    parts.push(`jobs.${id}`, next.path);
    wf = next;
  }
  const job = r.job === undefined ? undefined : wf.jobs[r.job]!;
  if (job) parts.push(`jobs.${job.id}`);
  const loc = keyLoc(index, wf.source.path, job ? ['jobs', job.id, 'permissions'] : ['permissions']);
  if (loc) related.push({ loc, message: `${job ? `jobs.${job.id}` : wf.path} requests ${wanted}` });
  return { where: parts.join(' › '), related };
}

const SCOPE_NAME = /^[a-z][a-z-]*$/;

/**
 * Raises the grant to what the job requests: in the calling job's `permissions:` when it has a map, else in a new one
 * that copies the workflow's map. None for `read-all`, which no map of scopes can raise without listing every scope.
 */
function raiseGrant(
  index: ProjectIndex,
  call: CallSite,
  grant: Grant,
  short: ShortScope[],
): Suggestion | undefined {
  const map = grant.permissions;
  if (typeof map === 'string') return undefined;
  const raised = Object.fromEntries(short.map((s) => [s.scope, LEVEL_NAMES[s.requested]!]));
  const merged = Object.entries({ ...map, ...raised });
  // Scope names are written as they are: only plain ones, never a key that would need quoting.
  if (!merged.every(([k]) => SCOPE_NAME.test(k))) return undefined;
  const pairs = merged.map(([k, v]) => `${k}: ${v}`);
  const title = `Grant ${levels(short, 'requested')} to jobs.${call.job.id}`;
  const file = call.caller.source.path;
  // The workflow's: the job gets its own, so the workflow's other jobs keep theirs.
  if (!call.job.permissions)
    return suggestion(title, [addPairs(index, file, ['jobs', call.job.id, 'permissions'], pairs)]);
  const flow = replaceValue(index, file, grant.path, `{ ${pairs.join(', ')} }`);
  if (flow) return suggestion(title, [flow]);
  const listed = short.filter((s) => Object.hasOwn(map, s.scope));
  const missing = short.filter((s) => !listed.includes(s));
  return suggestion(title, [
    ...listed.map((s) => replaceValue(index, file, [...grant.path, s.scope], LEVEL_NAMES[s.requested]!)),
    ...(missing.length
      ? [
          addPairs(
            index,
            file,
            grant.path,
            missing.map((s) => level(s, 'requested')),
          ),
        ]
      : []),
  ]);
}

export const permissionRules: RuleDefinition[] = [ungrantedPermissions];
