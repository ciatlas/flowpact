import { isMap, isScalar, isSeq, type Pair, parseDocument, type Scalar } from 'yaml';
import type { Finding } from './rules/types';

/** An override that accepts findings: by `target` (a symbol) or by `file`, with its reason and expiry. */
export interface OverrideEntry {
  rule: string;
  target?: string;
  file?: string;
  reason: string;
  /** `YYYY-MM-DD` */
  expires?: string;
}

/** The override that accepts one finding: by its symbol, else every finding of its rule in its file. */
export function overrideFor(f: Finding, reason: string, expires?: string): OverrideEntry {
  return {
    rule: f.code,
    ...(f.symbol ? { target: f.symbol } : { file: f.loc.file }),
    reason,
    ...(expires ? { expires } : {}),
  };
}

/** An override's lines, as an item of a sequence indented by `indent`; text values as double-quoted YAML. */
function entryLines(o: OverrideEntry, indent: string): string[] {
  const q = (s: string) => JSON.stringify(s);
  return [
    `${indent}- rule: ${o.rule}`,
    ...(o.target ? [`${indent}  target: ${q(o.target)}`] : []),
    ...(o.file ? [`${indent}  file: ${q(o.file)}`] : []),
    `${indent}  reason: ${q(o.reason)}`,
    ...(o.expires ? [`${indent}  expires: ${o.expires}`] : []),
  ];
}

/** Where to add text to a config file (1-based), and the text; `create` when there is no file yet. */
export interface ConfigInsertion {
  line: number;
  column: number;
  newText: string;
  create?: true;
}

/** The end of the line an offset is on (1-based), and that line's index. */
function lineEnd(text: string, offset: number): { line: number; column: number } {
  const lines = text.slice(0, offset).split('\n');
  const line = lines.length;
  return { line, column: (text.split('\n')[line - 1] ?? '').length + 1 };
}

/** A new `overrides` list at the end of a config without one. */
function appendList(text: string, o: OverrideEntry): ConfigInsertion {
  const end = lineEnd(text, text.length);
  const atStart = end.column === 1;
  return {
    ...(atStart && end.line > 1 ? { line: end.line, column: 1 } : end),
    newText: `${atStart ? '' : '\n'}overrides:\n${entryLines(o, '  ').join('\n')}\n`,
  };
}

/** The entry after the last one of a block sequence, at its indentation; none for a flow or empty one. */
function appendEntry(text: string, list: unknown, o: OverrideEntry): ConfigInsertion | undefined {
  if (!isSeq(list) || list.flow || list.items.length === 0 || !list.range) return undefined;
  const dash = list.range[0];
  const indent = ' '.repeat(dash - (text.lastIndexOf('\n', dash - 1) + 1));
  // A block value ends past its line break, at the start of the next line.
  const end = list.range[1];
  const at = lineEnd(text, end > 0 && text[end - 1] === '\n' ? end - 1 : end);
  return { ...at, newText: `\n${entryLines(o, indent).join('\n')}` };
}

const isEmpty = (v: unknown) => v === null || (isScalar(v) && v.value === null);

/**
 * Adds an override to a config file's text (`undefined`: there is no file yet): after the last entry of its
 * `overrides`, as a new `overrides` at its end, or as the whole file. None when `overrides` is not a block sequence
 * this can extend (a flow `[…]`), or the file has CRLF line endings.
 */
export function addOverride(text: string | undefined, o: OverrideEntry): ConfigInsertion | undefined {
  if (text === undefined)
    return {
      line: 1,
      column: 1,
      newText: ['overrides:', ...entryLines(o, '  '), ''].join('\n'),
      create: true,
    };
  if (text.includes('\r')) return undefined;
  const root = parseDocument(text).contents;
  if (root !== null && !isMap(root)) return undefined;
  const pair = root?.items.find((p) => isScalar(p.key) && p.key.value === 'overrides') as Pair | undefined;
  if (!pair) return appendList(text, o);
  if (!isEmpty(pair.value)) return appendEntry(text, pair.value, o);
  const at = lineEnd(text, (pair.key as Scalar).range![1]);
  return { ...at, newText: `\n${entryLines(o, '  ').join('\n')}` };
}
