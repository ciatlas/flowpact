import type { JobDecl, ProjectIndex, WorkflowDecl } from '@ciatlas/core';

/**
 * `pick` of each job that runs steps, by chain of job ids (`call > build`), including the jobs of called workflows:
 * they run in the caller's run, so GitHub checks their permissions against what the caller grants, and on the caller's
 * runners. A job that calls a workflow is followed into it, unless `stopAt` picks a value for the calling job itself;
 * one whose callee is not here (a remote workflow) is left out then.
 */
export function byJobChain<T>(
  index: ProjectIndex,
  wf: WorkflowDecl,
  pick: (job: JobDecl, wf: WorkflowDecl) => T,
  stopAt?: (job: JobDecl, wf: WorkflowDecl) => T | undefined,
  depth = 0,
  seen = new Set<string>(),
): Map<string, T> {
  const out = new Map<string, T>();
  for (const job of Object.values(wf.jobs)) {
    if (!job.uses) {
      out.set(job.id, pick(job, wf));
      continue;
    }
    const stop = stopAt?.(job, wf);
    if (stop !== undefined) {
      out.set(job.id, stop);
      continue;
    }
    const callee = index.calleeOf(job);
    if (!callee || depth >= 10 || seen.has(callee.path)) continue;
    for (const [chain, v] of byJobChain(index, callee, pick, stopAt, depth + 1, new Set([...seen, wf.path])))
      out.set(`${job.id} > ${chain}`, v);
  }
  return out;
}
