/**
 * `GITHUB_TOKEN` permissions as levels. The jobs of a called workflow run with the caller's token and can only keep or
 * lower what the call grants: GitHub refuses the run when one requests more (FP613), and impact mode grades a published
 * workflow whose jobs request more as breaking for its callers.
 */
import type { PermissionsDecl } from '@ciatlas/core';

/** Each scope's level (`none` 0, `read` 1, `write` 2), or `inherit` without `permissions:`. */
export type Scopes = Record<string, number> | 'inherit';

const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
export const LEVEL_NAMES = ['none', 'read', 'write'];

/** The scopes `read-all` and `write-all` set. */
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

/** The level `permissions:` gives one scope: a scope a map leaves out gets none, and `read-all` no `id-token`. */
function levelOf(p: PermissionsDecl, scope: string): number {
  if (p === 'write-all') return 2;
  if (p === 'read-all') return scope === 'id-token' ? 0 : 1;
  return Object.hasOwn(p, scope) ? (RANK[p[scope]!] ?? 0) : 0;
}

/** Each scope's level `permissions:` sets: every scope for `read-all` and `write-all`, else the ones it lists. */
export function levelsOf(p: PermissionsDecl): Record<string, number> {
  if (p === 'read-all' || p === 'write-all') return Object.fromEntries(SCOPES.map((s) => [s, levelOf(p, s)]));
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, RANK[v] ?? 0]));
}

export const scopesOf = (p: PermissionsDecl | undefined): Scopes =>
  p === undefined ? 'inherit' : levelsOf(p);

/** A scope a job requests at a higher level than it is granted. */
export interface ShortScope {
  scope: string;
  requested: number;
  granted: number;
}

/** The scopes `requested` asks more of than `granted` gives. */
export function shortScopes(granted: PermissionsDecl, requested: Record<string, number>): ShortScope[] {
  return Object.entries(requested).flatMap(([scope, level]) => {
    const has = levelOf(granted, scope);
    return level > has ? [{ scope, requested: level, granted: has }] : [];
  });
}
