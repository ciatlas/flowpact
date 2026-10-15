/**
 * What a version change of a remote reference does to the repository's calls (`RemoteChangeGrade`), in words: the
 * phrases `flowpact remotes update` prints, and the job summary's section of the action.
 */
import type { RemoteCallGrade, RemoteCallSite, RemoteChangeGrade, RemoteVerdict } from '@flowpact/lint';
import { type MarkdownLinkTarget, markdownCode, markdownLocation, markdownText } from './kit/markdown';

const calls = (k: number) => `${k} call${k === 1 ? '' : 's'}`;

/** A grade in a few words: how many of its calls the change breaks or leaves unchecked, or that it fits them. */
export function verdictLine(g: RemoteChangeGrade): string {
  const total = g.calls.length;
  if (!total) return 'nothing here calls it';
  const n = g.calls.filter((k) => k.verdict === g.verdict).length;
  if (g.verdict === 'breaks') return `breaks ${n} of ${calls(total)}`;
  if (g.verdict === 'unchecked') return `not fully checked for ${n} of ${calls(total)}`;
  return total === 1 ? 'fits its call' : `fits its ${total} calls`;
}

/** The commits an entry moved between, or the one it stays at (its interface as read changed). */
export function commitMove(g: RemoteChangeGrade, arrow: string): string {
  const { before, after } = g.commits;
  return before && before !== after
    ? `${before.slice(0, 7)} ${arrow} ${after.slice(0, 7)}`
    : `at ${after.slice(0, 7)}`;
}

export const VERDICT_LABEL: Record<RemoteVerdict, string> = {
  breaks: 'breaks',
  unchecked: 'not fully checked',
  fits: 'fits',
};

/** A call's job and step: `jobs.build step #2`, `jobs.deploy`, or `step setup` in an action. */
export const callJobStep = (call: RemoteCallSite): string =>
  [call.job && `jobs.${call.job}`, call.step && `step ${call.step}`].filter(Boolean).join(' ');

/** The calls a report lists: those that do not simply fit; and how many others fit. */
export function listedCalls(g: RemoteChangeGrade): { listed: RemoteCallGrade[]; others: string | undefined } {
  const listed = g.calls.filter((k) => k.verdict !== 'fits' || k.notes.length);
  const n = g.calls.length - listed.length;
  const others = n && listed.length ? (n === 1 ? '1 other call fits' : `${n} other calls fit`) : undefined;
  return { listed, others };
}

/** A call in Markdown: its verdict and place, then why (the findings, the parts not checked) and the notes. */
function callMarkdown(k: RemoteCallGrade, links: MarkdownLinkTarget): string[] {
  const where = `${markdownLocation(k.call.loc, links, false)} ${markdownText(callJobStep(k.call))}`;
  return [
    `- **${VERDICT_LABEL[k.verdict]}** ${where}`,
    ...k.added.map((f) => `  - ${markdownCode(f.code)} ${markdownText(f.message)}`),
    ...k.unchecked.map((u) => `  - ${markdownText(u)}`),
    ...k.notes.map((n) => `  - note: ${markdownText(n)}`),
  ];
}

/** One version change in Markdown: the reference, its commits and verdict, the interface diff, then the calls. */
function gradeMarkdown(g: RemoteChangeGrade, from: string | undefined, links: MarkdownLinkTarget): string {
  const { listed, others } = listedCalls(g);
  const was = from ? `from ${markdownCode(from)}, ` : '';
  return [
    `**${markdownCode(g.ref)}** (${was}${markdownText(commitMove(g, '→'))}): ${verdictLine(g)}`,
    '',
    ...g.changes.map((c) => `- ${c.breaking ? '**breaking:** ' : ''}${markdownText(c.message)}`),
    ...listed.flatMap((k) => callMarkdown(k, links)),
    ...(others ? [`- ${others}`] : []),
  ].join('\n');
}

export interface VersionChangesMarkdown {
  grades: RemoteChangeGrade[];
  /** The reference each graded one replaced, by graded reference. */
  from?: Record<string, string>;
  /** References that could not be fetched, so their changes are not graded. */
  failed?: { ref: string; error: string }[];
}

/** The job summary's section on the remote references a pull request moved to another version. */
export function renderVersionChanges(v: VersionChangesMarkdown, links: MarkdownLinkTarget = {}): string {
  const failed = (v.failed ?? []).map(
    (f) => `- not graded: ${markdownCode(f.ref)} could not be fetched: ${markdownText(f.error)}`,
  );
  return [
    '### Version changes',
    '',
    ...v.grades.map((g) => `${gradeMarkdown(g, v.from?.[g.ref], links)}\n`),
    ...(failed.length ? [failed.join('\n'), ''] : []),
  ].join('\n');
}
