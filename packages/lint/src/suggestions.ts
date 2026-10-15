import type { Loc, ProjectIndex, SourceFile } from '@ciatlas/core';

/** A change to a file: the text at `loc` replaced by `newText`. An empty range inserts it. */
export interface SuggestedEdit {
  loc: Loc;
  newText: string;
}

/**
 * A fix flowpact can apply to a finding: what it does, and its edits, which apply together. The editor offers it as a
 * quick fix; a rule attaches one only when the change is certain, never a guess at a value.
 */
export interface Suggestion {
  title: string;
  edits: SuggestedEdit[];
}

const sources = new WeakMap<ProjectIndex, Map<string, SourceFile>>();

/** The source of a repository file the analysis read, by its repo-relative path. */
export function sourceOf(index: ProjectIndex, file: string): SourceFile | undefined {
  let byFile = sources.get(index);
  if (!byFile) {
    byFile = new Map(index.units().map((u) => [u.source.path, u.source]));
    sources.set(index, byFile);
  }
  return byFile.get(file);
}

/** The text at `loc`, when it is on one line. */
function textAt(source: SourceFile, loc: Loc): string | undefined {
  if (loc.line !== loc.endLine) return undefined;
  return source.lines[loc.line - 1]?.slice(loc.column - 1, loc.endColumn - 1);
}

const quoted = (q: string) => (q === "'" ? "'" : '"');

/**
 * Renames the key or name written at `loc` from `from` to `to`, keeping its quotes; none when the text there is not
 * `from` (a key GitHub matched case-insensitively is renamed too).
 */
export function renameAt(index: ProjectIndex, loc: Loc, from: string, to: string): Suggestion | undefined {
  const source = sourceOf(index, loc.file);
  const text = source && textAt(source, loc);
  if (text === undefined) return undefined;
  const q = /^(["'])(.*)\1$/.exec(text);
  const bare = q ? q[2] : text;
  if (bare?.toLowerCase() !== from.toLowerCase()) return undefined;
  const newText = q ? `${quoted(q[1]!)}${to}${quoted(q[1]!)}` : to;
  return { title: `Rename ${JSON.stringify(from)} to ${JSON.stringify(to)}`, edits: [{ loc, newText }] };
}

/**
 * Renames one segment of the expression reference at `loc` (such as `needs.build.outputs.url`): segment 0 is the
 * context, 1 its first property, and so on. None for a reference written with brackets, or when the segment there is
 * not `from`.
 */
export function renameSegment(
  index: ProjectIndex,
  loc: Loc,
  segment: number,
  from: string,
  to: string,
): Suggestion | undefined {
  const source = sourceOf(index, loc.file);
  const text = source && textAt(source, loc);
  if (text === undefined || !/^[\w.-]+$/.test(text)) return undefined;
  const parts = text.split('.');
  if (parts[segment]?.toLowerCase() !== from.toLowerCase()) return undefined;
  const column = loc.column + parts.slice(0, segment).reduce((n, p) => n + p.length + 1, 0);
  const at: Loc = { ...loc, column, endColumn: column + parts[segment]!.length };
  return {
    title: `Rename ${JSON.stringify(from)} to ${JSON.stringify(to)}`,
    edits: [{ loc: at, newText: to }],
  };
}
