import { type Loc, trimChar } from '@ciatlas/core';

const PROSE_ESCAPES: Record<string, string> = {
  // A backslash would otherwise cancel the escape that follows it: `\[x\](url)` would become a link again.
  '\\': '\\\\',
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '[': '\\[',
  ']': '\\]',
  // GitHub finds mentions after decoding entities (`&#64;team` still pings); a zero-width space after `@` does not.
  '@': '@\u200b',
};

/** The length of the longest run of `ch` in `s`. */
function longestRun(s: string, ch: string): number {
  let longest = 0;
  let run = 0;
  for (const c of s) {
    run = c === ch ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/** Whether the line after the newline at `at` is blank (only spaces or tabs): the end of a paragraph. */
function blankLineAfter(s: string, at: number): boolean {
  let k = at + 1;
  while (s[k] === ' ' || s[k] === '\t') k++;
  return s[k] === '\n' || s[k] === '\r';
}

/**
 * Escapes text for Markdown prose. Messages embed names from the analyzed YAML, so nothing outside a genuine code
 * span may become HTML, a Markdown link, an image or an @mention (GitHub still autolinks bare URLs, as plain text).
 * Code spans follow CommonMark: a run of N backticks is closed only by a run of exactly N in the same paragraph; an
 * unmatched run is escaped so it cannot pair with a later one.
 */
export function markdownText(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch !== '`') {
      out += PROSE_ESCAPES[ch] ?? ch;
      i++;
      continue;
    }
    const n = runAt(s, i);
    const close = closingRun(s, i + n, n);
    out += close >= 0 ? s.slice(i, close + n) : '\\`'.repeat(n);
    i = close >= 0 ? close + n : i + n;
  }
  return out;
}

/** The length of the run of backticks that starts at `at`. */
function runAt(s: string, at: number): number {
  let n = 0;
  while (s[at + n] === '`') n++;
  return n;
}

/**
 * Where the run of exactly `n` backticks that closes a code span starts, looking from `from` on; -1 when the paragraph
 * ends first.
 */
function closingRun(s: string, from: number, n: number): number {
  for (let j = from; j < s.length; ) {
    if (s[j] === '\n' && blankLineAfter(s, j)) return -1; // a code span cannot cross paragraphs
    if (s[j] !== '`') {
      j++;
      continue;
    }
    const m = runAt(s, j);
    if (m === n) return j;
    j += m;
  }
  return -1;
}

/**
 * Fits Markdown that is already safe (escaped prose, code spans, links) into a table cell: pipes and line breaks.
 * GFM splits cells on a pipe after an even run of backslashes; prose has its backslashes doubled by `markdownText`, so the
 * added one always makes the run odd, and the table parser removes it again before the inline content is rendered.
 */
export function markdownTableCell(md: string): string {
  return md.split('|').join('\\|').replace(/\r?\n/g, '<br/>');
}

/** Escapes text for a table cell. */
export function markdownCell(s: string): string {
  return markdownTableCell(markdownText(s));
}

/** Inline code that survives backticks inside the value. */
export function markdownCode(s: string): string {
  // Longer than any backtick run in the value, so nothing in it can close the span early; the spaces keep a value
  // that starts or ends with a backtick apart from the fence (CommonMark strips one on each side).
  const longest = longestRun(s, '`');
  const fence = '`'.repeat(longest + 1);
  const pad = longest ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** A backtick fence for a code block around `content`: longer than any backtick run in it, and at least three. */
export function markdownFence(content: string): string {
  return '`'.repeat(Math.max(3, longestRun(content, '`') + 1));
}

/** Where Markdown links to files point: `<repoUrl>/blob/<sha>/<file>`. Without both, locations are plain code. */
export interface MarkdownLinkTarget {
  /** e.g. `https://github.com/acme/repo`. */
  repoUrl?: string | undefined;
  sha?: string | undefined;
}

/** A location as inline code, linked to the file at `sha` when there is one. */
export function markdownLocation(
  loc: Pick<Loc, 'file' | 'line' | 'column'>,
  opts: MarkdownLinkTarget,
  withColumn = true,
): string {
  const label = markdownCode(`${loc.file}:${loc.line}${withColumn ? `:${loc.column}` : ''}`);
  if (!opts.repoUrl || !opts.sha) return label;
  const base = trimChar(opts.repoUrl, '/');
  // encodeURIComponent leaves `(` and `)`, and an unbalanced one would end the link destination early.
  const path = loc.file
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/');
  return `[${label}](${base}/blob/${opts.sha}/${path}#L${loc.line})`;
}
