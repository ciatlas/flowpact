import type { Loc, ProjectIndex, SourceFile } from '@ciatlas/core';
import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  parseDocument,
  type Scalar,
  type YAMLMap,
} from 'yaml';

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

// ---------------------------------------------------------------------------
// Edits to the YAML structure: adding keys to a block mapping, removing a key
// ---------------------------------------------------------------------------

/** A path from the document's root: keys of mappings, indexes of sequences. */
export type YamlPath = (string | number)[];

const documents = new WeakMap<SourceFile, Document.Parsed>();

/** The YAML document of a source, parsed once. */
function documentOf(source: SourceFile): Document.Parsed {
  let doc = documents.get(source);
  if (!doc) {
    doc = parseDocument(source.text);
    documents.set(source, doc);
  }
  return doc;
}

/** The pair of a mapping with `key`, matched exactly, else ignoring case (as GitHub matches most keys). */
function pairOf(map: YAMLMap, key: string): Pair | undefined {
  const pairs = map.items.filter((p) => isScalar(p.key));
  const name = (p: Pair) => String((p.key as Scalar).value);
  return pairs.find((p) => name(p) === key) ?? pairs.find((p) => name(p).toLowerCase() === key.toLowerCase());
}

/** The node at `path`, or undefined when a step on the way is not there. */
function nodeAt(doc: Document.Parsed, path: YamlPath): unknown {
  let node: unknown = doc.contents;
  for (const step of path) {
    if (typeof step === 'number') node = isSeq(node) ? node.items[step] : undefined;
    else node = isMap(node) ? pairOf(node, step)?.value : undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/** A block mapping with at least one pair: the only kind flowpact edits. */
const isBlockMap = (node: unknown): node is YAMLMap => isMap(node) && !node.flow && node.items.length > 0;

/** Where a pair's key starts. */
const keyStart = (source: SourceFile, pair: Pair) => source.loc((pair.key as Scalar).range![0]);

/** The first and the last line a pair spans: its key's, through the last line of its value. */
function pairLines(source: SourceFile, pair: Pair): [number, number] {
  const first = keyStart(source, pair).line;
  const end = (pair.value as Node | null)?.range?.[1] ?? (pair.key as Scalar).range![1];
  const at = source.loc(end);
  // A block value ends past its line break, at the start of the next line.
  return [first, at.column === 1 && at.line > first ? at.line - 1 : at.line];
}

/** An edit adding `lines` after line `line`. */
function insertAfter(source: SourceFile, line: number, lines: string[]): SuggestedEdit {
  const end = (source.lines[line - 1] ?? '').length + 1;
  return {
    loc: { file: source.path, line, column: end, endLine: line, endColumn: end },
    newText: lines.map((l) => `\n${l}`).join(''),
  };
}

/** An edit removing the lines a pair spans, or none when its first line holds more than the pair (a `- `). */
function removePair(source: SourceFile, pair: Pair): SuggestedEdit | undefined {
  const [first, last] = pairLines(source, pair);
  if (source.lines[first - 1]!.slice(0, keyStart(source, pair).column - 1).trim() !== '') return undefined;
  if (last < source.lines.length)
    return {
      loc: { file: source.path, line: first, column: 1, endLine: last + 1, endColumn: 1 },
      newText: '',
    };
  // The file's last lines, without a line break after them: take the one before them.
  const before = first > 1 ? source.lines[first - 2]!.length + 1 : 1;
  return {
    loc: {
      file: source.path,
      line: Math.max(1, first - 1),
      column: before,
      endLine: last,
      endColumn: source.lines[last - 1]!.length + 1,
    },
    newText: '',
  };
}

/** The source of `file` and its document, when flowpact can edit it: LF line endings only. */
function editable(
  index: ProjectIndex,
  file: string,
): { source: SourceFile; doc: Document.Parsed } | undefined {
  const source = sourceOf(index, file);
  if (!source || source.text.includes('\r')) return undefined;
  return { source, doc: documentOf(source) };
}

/**
 * Adds `<key>: ` lines for `keys` to the block mapping at `path`, after its last pair. When the mapping is not there,
 * it is created in its parent mapping, after the first of the keys `after` the parent has (else its last pair). None
 * for a flow mapping (`{ … }`), an empty or computed value, or a file with CRLF line endings.
 */
export const addKeys = (
  index: ProjectIndex,
  file: string,
  path: YamlPath,
  keys: string[],
  after: string[] = [],
) =>
  addPairs(
    index,
    file,
    path,
    keys.map((k) => `${k}: `),
    after,
  );

/** Adds `pairs`, each `<key>: <value>` as written, to the block mapping at `path`, the way `addKeys` adds keys. */
export function addPairs(
  index: ProjectIndex,
  file: string,
  path: YamlPath,
  pairs: string[],
  after: string[] = [],
): SuggestedEdit | undefined {
  const at = editable(index, file);
  if (!at || pairs.length === 0) return undefined;
  const { source, doc } = at;
  const map = nodeAt(doc, path);
  if (map !== undefined) {
    if (!isBlockMap(map)) return undefined;
    const indent = ' '.repeat(keyStart(source, map.items[0]!).column - 1);
    const [, last] = pairLines(source, map.items.at(-1)!);
    return insertAfter(
      source,
      last,
      pairs.map((p) => `${indent}${p}`),
    );
  }
  const own = path.at(-1);
  const parent = nodeAt(doc, path.slice(0, -1));
  if (typeof own !== 'string' || !isBlockMap(parent)) return undefined;
  const anchor = after.map((k) => pairOf(parent, k)).find((p) => p !== undefined) ?? parent.items.at(-1)!;
  const indent = ' '.repeat(keyStart(source, anchor).column - 1);
  const [, last] = pairLines(source, anchor);
  return insertAfter(source, last, [`${indent}${own}:`, ...pairs.map((p) => `${indent}  ${p}`)]);
}

/**
 * Replaces the value at `path`, a scalar or a flow collection on one line, with `newText`. None for a block value, a
 * value that is not there, or a file with CRLF line endings.
 */
export function replaceValue(
  index: ProjectIndex,
  file: string,
  path: YamlPath,
  newText: string,
): SuggestedEdit | undefined {
  const at = editable(index, file);
  const node = at && nodeAt(at.doc, path);
  if (!at || !(isScalar(node) || ((isMap(node) || isSeq(node)) && node.flow)) || !node.range)
    return undefined;
  const loc = at.source.loc(node.range[0], node.range[1]);
  return loc.line === loc.endLine ? { loc, newText } : undefined;
}

/** Where the key of the pair at `path` is written; none when it is not there. */
export function keyLoc(index: ProjectIndex, file: string, path: YamlPath): Loc | undefined {
  const source = sourceOf(index, file);
  const own = path.at(-1);
  const parent = source && nodeAt(documentOf(source), path.slice(0, -1));
  const pair = typeof own === 'string' && isMap(parent) ? pairOf(parent, own) : undefined;
  const range = (pair?.key as Scalar | undefined)?.range;
  return source && range ? source.loc(range[0], range[1]) : undefined;
}

/**
 * Removes the pair `key` of the block mapping at `path` (only when its key is on `line`, if given), or the whole
 * mapping, with its own key, when that is its only pair (an empty `with:` would read as null). None for a flow mapping
 * or a file with CRLF line endings.
 */
export function removeKey(
  index: ProjectIndex,
  file: string,
  path: YamlPath,
  key: string,
  line?: number,
): SuggestedEdit | undefined {
  const at = editable(index, file);
  if (!at) return undefined;
  const { source, doc } = at;
  const map = nodeAt(doc, path);
  if (!isBlockMap(map)) return undefined;
  const pair = pairOf(map, key);
  // With `line`, the pair must be the one the finding is about.
  if (!pair || (line !== undefined && keyStart(source, pair).line !== line)) return undefined;
  if (map.items.length > 1) return removePair(source, pair);
  const own = path.at(-1);
  const parent = nodeAt(doc, path.slice(0, -1));
  const holder = typeof own === 'string' && isBlockMap(parent) ? pairOf(parent, own) : undefined;
  return holder && removePair(source, holder);
}

/** The path of a step's `with:`: in a workflow's job, or in a composite action. */
export const stepWithPath = (job: string | undefined, step: number): YamlPath =>
  job === undefined ? ['runs', 'steps', step, 'with'] : ['jobs', job, 'steps', step, 'with'];

/** A suggestion of the edits, or none unless every one of them could be made. */
export function suggestion(title: string, edits: (SuggestedEdit | undefined)[]): Suggestion | undefined {
  if (edits.length === 0 || edits.some((e) => e === undefined)) return undefined;
  return { title, edits: edits as SuggestedEdit[] };
}
