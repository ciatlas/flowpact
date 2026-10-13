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

/** The first items of a list, each formatted by `quote` (such as Markdown code), and how many more there are. */
const listOf = (items: string[], quote: (s: string) => string) =>
  `${items.slice(0, MAX_LISTED).map(quote).join(', ')}${items.length > MAX_LISTED ? ` and ${items.length - MAX_LISTED} more` : ''}`;

/**
 * What paths narrowed impact mode to: `within a, b: graded a`, or `graded nothing published` when no published unit is
 * within them. `quote` formats each path, such as Markdown code.
 */
export function describeScope(scope: ImpactScope, quote: (s: string) => string): string {
  return `within ${listOf(scope.paths, quote)}: graded ${scope.units.length ? listOf(scope.units, quote) : 'nothing published'}`;
}

/** The published units (within the paths) that `ignore` left out, listed; undefined when it left out none. */
export const ignoredUnits = (impact: ImpactResult, quote: (s: string) => string): string | undefined =>
  impact.narrowed?.ignored.length ? listOf(impact.narrowed.ignored, quote) : undefined;

/**
 * What a run without graded changes found none in: published units, or with paths those within the paths, and those
 * that `ignore` leaves in when it left out any.
 */
export function ungraded(impact: ImpactResult): string {
  const ignored = Boolean(impact.narrowed?.ignored.length);
  if (!impact.scope && !ignored) return 'published workflows or actions';
  return `the published workflows or actions${impact.scope ? ' within the paths' : ''}${ignored ? ' that ignore leaves in' : ''}`;
}
