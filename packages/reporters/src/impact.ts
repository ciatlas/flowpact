import type { ImpactLevel, ImpactResult, ImpactScope } from '@flowpact/lint';

const ORDER: ImpactLevel[] = ['major', 'minor', 'patch', 'none'];

export function describeDeclared(impact: ImpactResult): string {
  const d = impact.verdict.declared;
  if (!d) return 'nothing declared';
  const from =
    d.kind === 'explicit'
      ? 'explicit'
      : d.kind === 'version'
        ? `release ${d.value}`
        : `${d.kind} "${d.value}"`;
  return `${d.level} (${from})`;
}

/** Changes worth listing, biggest first; `none` changes are left out. */
export function listedChanges(impact: ImpactResult) {
  return [...impact.changes]
    .filter((c) => c.level !== 'none')
    .sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level) || a.unit.localeCompare(b.unit));
}

export const shortCommit = (sha: string) => sha.slice(0, 7);

/** The most paths, and units, a report lists by name; the rest are counted. */
const MAX_LISTED = 10;

/**
 * What paths narrowed impact mode to: `within a, b: graded a`, or `graded nothing published` when no published unit is
 * within them. `quote` formats each path, such as Markdown code.
 */
export function describeScope(scope: ImpactScope, quote: (s: string) => string): string {
  const list = (items: string[]) =>
    `${items.slice(0, MAX_LISTED).map(quote).join(', ')}${items.length > MAX_LISTED ? ` and ${items.length - MAX_LISTED} more` : ''}`;
  return `within ${list(scope.paths)}: graded ${scope.units.length ? list(scope.units) : 'nothing published'}`;
}

/** What a run without graded changes found none in: published units, or with paths, those within the paths. */
export const ungraded = (impact: ImpactResult) =>
  impact.scope ? 'the published workflows or actions within the paths' : 'published workflows or actions';
