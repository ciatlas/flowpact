import type { Loc, SourceFile } from '@ciatlas/core';
import { safe, type Theme, visibleWidth } from './theme';

/** A source line as the terminal shows it: tabs as two spaces, control characters made visible. */
const visual = (line: string) => safe(line.replace(/\t/g, '  '));

/** The last line of the frame: up to one line after `loc`, without trailing blank lines. */
function frameEnd(source: SourceFile, loc: Loc, context: number): number {
  let last = Math.min(source.lines.length, loc.line + Math.min(1, context));
  while (last > loc.line && (source.lines[last - 1] ?? '').trim() === '') last--;
  return last;
}

/** The caret underline under `loc` on its first line, `raw`, with an optional label after it. */
function caretLine(t: Theme, raw: string, loc: Loc, gutter: number, label?: string): string {
  const { c, sym } = t;
  // Columns count characters; tabs and wide characters take more cells on screen.
  const startCol = Math.max(1, loc.column);
  const endCol = loc.endLine === loc.line ? Math.max(startCol + 1, loc.endColumn) : raw.length + 1;
  const pad = visibleWidth(visual(raw.slice(0, startCol - 1)));
  const width = Math.max(1, visibleWidth(visual(raw.slice(startCol - 1, endCol - 1))));
  return `${' '.repeat(gutter)} ${c.dim(sym.bar)} ${' '.repeat(pad)}${c.red(c.bold(sym.caret.repeat(width)))}${label ? ` ${c.red(label)}` : ''}`;
}

/** A code frame with line numbers and a caret underline under `loc`. */
export function codeFrame(
  t: Theme,
  source: SourceFile,
  loc: Loc,
  opts: { context?: number; label?: string } = {},
): string[] {
  const { c, sym } = t;
  const context = opts.context ?? 2;
  const first = Math.max(1, loc.line - context);
  const last = frameEnd(source, loc, context);
  const gutter = String(last).length;
  const out: string[] = [];
  for (let n = first; n <= last; n++) {
    const raw = source.lines[n - 1] ?? '';
    const text = visual(raw);
    const num = String(n).padStart(gutter);
    if (n !== loc.line) {
      out.push(`${c.dim(num)} ${c.dim(sym.bar)} ${c.dim(text)}`);
      continue;
    }
    out.push(`${c.bold(num)} ${c.dim(sym.bar)} ${text}`, caretLine(t, raw, loc, gutter, opts.label));
  }
  return out;
}
