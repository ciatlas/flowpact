import { isAbsolute, relative } from 'node:path';
import type { Project } from '@ciatlas/core';
import { usage } from './errors';

/** Shows paths relative to the working directory when they are inside it. */
export function displayPath(abs: string): string {
  const rel = relative(process.cwd(), abs);
  if (rel === '') return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
}

/**
 * Refuses paths that do not exist, or that name no workflow or action. `fromBaseline` are paths that name a workflow
 * or action of impact mode's baseline: they stand for what the change removed, so they are neither.
 */
export function checkTargets(
  project: Project,
  paths: string[],
  root: string,
  fromBaseline: string[] = [],
): void {
  const missing = (project.missingTargets ?? []).filter((p) => !fromBaseline.includes(p));
  if (missing.length) {
    throw usage(
      `Path${missing.length > 1 ? 's' : ''} not found under ${displayPath(root)}: ${missing.join(', ')}`,
    );
  }
  if (paths.length && project.targets.size === 0 && !project.wholeRepository && !fromBaseline.length) {
    throw usage(
      `None of the paths is a workflow (.github/workflows/*.yml) or an action (action.yml): ${(project.ignoredTargets ?? paths).join(', ')}`,
    );
  }
}

/** Refuses a root without workflows or actions: most likely not the repository that was meant. */
export function checkNotEmpty(summary: { workflows: number; actions: number }, root: string): void {
  if (summary.workflows === 0 && summary.actions === 0) {
    throw usage(
      `No workflows found under ${displayPath(root)}/.github/workflows. Use --root to point at a repository.`,
    );
  }
}

/** Where files are never written through a symlink a pull request could have committed: the repository, the workspace. */
export const protectedTrees = (root: string): string[] => [
  root,
  ...(process.env.GITHUB_WORKSPACE ? [process.env.GITHUB_WORKSPACE] : []),
];
