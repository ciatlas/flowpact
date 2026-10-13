import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Project, ProjectIndex } from '@ciatlas/core';
import { pathHolds } from '@flowpact/lint';
import { usage } from './errors';

/** Shows paths relative to the working directory when they are inside it. */
export function displayPath(abs: string): string {
  const rel = relative(process.cwd(), abs);
  if (rel === '') return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
}

/**
 * Refuses paths that do not exist, or that name no workflow or action. `removed` are the paths that name a workflow or
 * action of impact mode's baseline only: they stand for what the change removed, so they are neither.
 */
export function checkTargets(project: Project, paths: string[], root: string, removed: string[] = []): void {
  const missing = (project.missingTargets ?? []).filter((p) => !removed.includes(p));
  if (missing.length) {
    throw usage(
      `Path${missing.length > 1 ? 's' : ''} not found under ${displayPath(root)}: ${missing.join(', ')}`,
    );
  }
  if (paths.length && project.targets.size === 0 && !project.wholeRepository && !removed.length) {
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

/**
 * Impact mode's paths: one the working tree lacks is taken from where `elsewhere` says (the CLI: relative to the
 * working directory, when --root is elsewhere) when the baseline has a workflow or action within it there and none
 * within it under the root. A removed path then counts wherever it was given from, as an existing one does.
 */
export function removedElsewhere(
  paths: string[],
  base: ProjectIndex | undefined,
  root: string,
  elsewhere: ((path: string) => string | undefined) | undefined,
): string[] {
  if (!base || !elsewhere) return paths;
  const files = base.units().map((u) => u.file);
  const holds = (p: string) => {
    const rel = relative(root, resolve(root, p)).split('\\').join('/');
    return files.some((f) => pathHolds(rel, f));
  };
  return paths.map((p) => {
    const there = elsewhere(p);
    return there && !existsSync(resolve(root, p)) && !holds(p) && holds(there) ? there : p;
  });
}
