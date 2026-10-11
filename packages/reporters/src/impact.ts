import type { ImpactLevel, ImpactResult } from '@flowpact/lint';

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
