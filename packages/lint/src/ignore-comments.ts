import type { Loc } from '@ciatlas/core';
import { CST, Lexer } from 'yaml';
import type { Finding } from './rules/types';

/** A rule an ignore comment names, as written, and where. */
export interface IgnoredRule {
  key: string;
  loc: Loc;
}

/** A `# flowpact: ignore[<rules>] <reason>` comment in a workflow or action file. */
export interface IgnoreComment {
  /** The comment, from its `#` to the end of the line (or to the next `# flowpact:` on it). */
  loc: Loc;
  /**
   * The line whose findings it accepts: its own, or for a comment alone on its line, the next line with YAML on it
   * (0 when none follows).
   */
  line: number;
  rules: IgnoredRule[];
  reason?: string;
  /** Why the comment accepts nothing: it is not `ignore[<rules>]`. */
  malformed?: string;
}

/** A scalar over several lines; a block scalar's from the line of its header (`run: |`). */
interface Span {
  first: number;
  last: number;
}

/** The ignore comments of a file, and its scalars over several lines, which a comment on their line accepts whole. */
export interface FileIgnores {
  comments: IgnoreComment[];
  spans: Span[];
}

/** Where a directive starts: `# flowpact:` opening a comment, or after a space in one (`# v3.1.1 # flowpact:`). */
const DIRECTIVE = /(?<=^|\s)#\s*flowpact:/g;
/** The lexer's own tokens, which are not in the source: document start, the end of a flow error, a scalar's start. */
const MARKERS = new Set(['\x02', '\x18', '\x1f']);
const NOT_YAML = new Set(['space', 'newline', 'comment']);

/** 1-based lines and columns of offsets in a text. */
function positions(text: string) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const line = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return {
    line,
    loc: (file: string, start: number, end: number): Loc => {
      const a = line(start);
      const b = line(end);
      return {
        file,
        line: a,
        column: start - starts[a - 1]! + 1,
        endLine: b,
        endColumn: end - starts[b - 1]! + 1,
      };
    },
  };
}

interface Lexed {
  comments: { offset: number; text: string; alone: boolean }[];
  spans: Span[];
  /** The lines a token of YAML starts on, ascending. */
  yamlLines: number[];
}

/** The span of a scalar's text at `start`, when it covers several lines; a block scalar's from its header's line. */
function spanOf(
  token: string,
  start: number,
  line: (offset: number) => number,
  header?: number,
): Span | undefined {
  const text = token.trimEnd();
  const first = header ?? line(start);
  const last = text.trim() ? line(start + text.length - 1) : first;
  return last > first ? { first, last } : undefined;
}

/** Where the lexer is in a file: the offset, whether a scalar's text comes next, a block scalar's header line. */
interface LexState {
  offset: number;
  scalar: boolean;
  header?: number | undefined;
  lineHasYaml: boolean;
}

const QUOTED = new Set(['single-quoted-scalar', 'double-quoted-scalar']);

/** Ends a scalar's text, recording its span when it covers several lines. */
function closeScalar(out: Lexed, st: LexState, span: Span | undefined): void {
  if (span) out.spans.push(span);
  st.scalar = false;
  st.header = undefined;
}

/** Records a token of `type` at `start` by its line: a line break, a comment, or YAML on the line. */
function noteLine(
  out: Lexed,
  st: LexState,
  type: string,
  token: string,
  start: number,
  line: (offset: number) => number,
): void {
  if (type === 'newline') st.lineHasYaml = false;
  else if (type === 'comment') out.comments.push({ offset: start, text: token, alone: !st.lineHasYaml });
  else if (!NOT_YAML.has(type) && token.trim()) {
    const at = line(start + token.length - token.trimStart().length);
    if (out.yamlLines.at(-1) !== at) out.yamlLines.push(at);
    st.lineHasYaml = true;
  }
}

/** Records a token at `start`: a scalar's span, a block scalar's header, a comment, or a line with YAML on it. */
function record(
  out: Lexed,
  st: LexState,
  token: string,
  start: number,
  line: (offset: number) => number,
): void {
  const type = st.scalar ? 'scalar' : (CST.tokenType(token) ?? 'other');
  if (type === 'scalar' || QUOTED.has(type)) closeScalar(out, st, spanOf(token, start, line, st.header));
  else if (type === 'block-scalar-header') st.header = line(start);
  noteLine(out, st, type, token, start, line);
}

/** The comments, multi-line scalars and lines of YAML of a file, as YAML's lexer reads it. */
function lex(text: string, line: (offset: number) => number): Lexed {
  const out: Lexed = { comments: [], spans: [], yamlLines: [] };
  const st: LexState = { offset: 0, scalar: false, lineHasYaml: false };
  for (const token of new Lexer().lex(text)) {
    if (MARKERS.has(token)) {
      st.scalar ||= token === '\x1f';
      continue;
    }
    record(out, st, token, st.offset, line);
    st.offset += token.length;
  }
  return out;
}

/** The rules, the reason or what is wrong in a directive's text after `# flowpact:` (at `offset` in the file). */
function parseDirective(
  body: string,
  offset: number,
  locOf: (start: number, end: number) => Loc,
): Pick<IgnoreComment, 'rules' | 'reason' | 'malformed'> {
  const m = /^(\s*ignore\s*\[)([^\]]*)\](.*)$/s.exec(body);
  if (!m) {
    return {
      rules: [],
      malformed: /^\s*ignore\b/.test(body)
        ? 'lists no rules in brackets, as in `# flowpact: ignore[FP301]`'
        : 'is not `# flowpact: ignore[<rules>]`',
    };
  }
  const listAt = offset + m[1]!.length;
  const rules = [...m[2]!.matchAll(/[^\s,]+/g)].map((k) => ({
    key: k[0],
    loc: locOf(listAt + k.index, listAt + k.index + k[0].length),
  }));
  if (!rules.length)
    return { rules, malformed: 'lists no rules in brackets, as in `# flowpact: ignore[FP301]`' };
  const reason = m[3]!.trim().replace(/^(?:--|:)\s*/, '');
  return { rules, ...(reason ? { reason } : {}) };
}

/** The line a comment alone on its line accepts: the next one with YAML on it; 0 when there is none. */
function nextYamlLine(lines: number[], after: number): number {
  return lines.find((l) => l > after) ?? 0;
}

/**
 * The `# flowpact: ignore[…]` comments of a workflow or action file (`text`, at `file`), anywhere among the comments of
 * a line: `uses: org/action@<sha> # v3.1.1 # flowpact: ignore[FP301] why`. Only YAML comments count, not a `#` in a
 * string or in a block scalar's text.
 */
export function readIgnoreComments(file: string, text: string): FileIgnores {
  return text.includes('flowpact:') ? read(file, text) : { comments: [], spans: [] };
}

/** The ignore comments and multi-line scalars of a file. */
function read(file: string, text: string): FileIgnores {
  const pos = positions(text);
  const lexed = lex(text, pos.line);
  const comments: IgnoreComment[] = [];
  for (const c of lexed.comments) {
    const starts = [...c.text.matchAll(DIRECTIVE)];
    const line = pos.line(c.offset);
    const accepts = c.alone ? nextYamlLine(lexed.yamlLines, line) : line;
    starts.forEach((d, i) => {
      const from = c.offset + d.index;
      const to = c.offset + (starts[i + 1]?.index ?? c.text.length);
      const raw = text.slice(from, to).trimEnd();
      comments.push({
        loc: pos.loc(file, from, from + raw.length),
        line: accepts,
        ...parseDirective(raw.slice(d[0].length), from + d[0].length, (a, b) => pos.loc(file, a, b)),
      });
    });
  }
  return { comments, spans: lexed.spans };
}

/**
 * Whether a comment that accepts the findings of `line` accepts one that starts on `findingLine`: one on that line, or
 * in a scalar over several lines that starts on it (a block scalar's text, from `run: |`) or ends on it.
 */
export function coversLine(ignores: FileIgnores, line: number, findingLine: number): boolean {
  if (line === 0) return false;
  if (findingLine === line) return true;
  return ignores.spans.some(
    (s) => s.first <= findingLine && findingLine <= s.last && (s.first === line || s.last === line),
  );
}

/** A finding that a `# flowpact: ignore[…]` comment accepted. */
export interface IgnoredFinding extends Finding {
  comment: { loc: Loc; reason?: string };
}

/** How one rule of an ignore comment was used in this run (available to post-phase rules). */
export interface IgnoreCommentUsage {
  comment: IgnoreComment;
  /** The rule as the comment names it; none for a malformed comment. */
  rule?: IgnoredRule;
  /** The code of the rule, when it is a loaded rule that the comment can ignore. */
  code?: string;
  /** Why it accepts nothing: the comment is malformed, or the rule unknown or one that cannot be ignored. */
  invalid?: string;
  matched: number;
  /** The rule does not run in this analysis (off, excluded by `--only`, not loaded), so its use cannot be judged. */
  inactive?: boolean;
}

/** What a rule an ignore comment names is: a loaded rule's code, why it cannot be ignored, or a rule not loaded. */
export type IgnoredRuleResolution = { code: string } | { invalid: string } | { unloaded: true };

/** The usage of each rule of a comment, or of the comment when it is malformed. */
function usageOf(
  comment: IgnoreComment,
  resolve: (key: string) => IgnoredRuleResolution,
): IgnoreCommentUsage[] {
  if (comment.malformed) return [{ comment, invalid: `Ignore comment ${comment.malformed}`, matched: 0 }];
  return comment.rules.map((rule) => {
    const r = resolve(rule.key);
    return {
      comment,
      rule,
      matched: 0,
      ...('code' in r ? { code: r.code } : 'invalid' in r ? { invalid: r.invalid } : { inactive: true }),
    };
  });
}

/**
 * Moves the findings that an ignore comment accepts out of `kept`, and records how each rule of each comment was used.
 * Findings an override accepted (`suppressed`) stay there, but count for the comments that accept them too, so neither
 * looks unused.
 */
export function applyIgnoreComments(
  findings: { kept: Finding[]; suppressed: Finding[] },
  files: Map<string, FileIgnores>,
  resolve: (key: string) => IgnoredRuleResolution,
): { kept: Finding[]; ignored: IgnoredFinding[]; usage: IgnoreCommentUsage[] } {
  const byFile = new Map<string, IgnoreCommentUsage[]>();
  for (const [file, ignores] of files)
    byFile.set(
      file,
      ignores.comments.flatMap((c) => usageOf(c, resolve)),
    );
  const matching = (f: Finding) => {
    const ignores = files.get(f.loc.file);
    return (byFile.get(f.loc.file) ?? []).filter(
      (u) => u.code === f.code && ignores !== undefined && coversLine(ignores, u.comment.line, f.loc.line),
    );
  };
  for (const f of findings.suppressed) for (const u of matching(f)) u.matched++;
  const kept: Finding[] = [];
  const ignored: IgnoredFinding[] = [];
  for (const f of findings.kept) {
    const by = matching(f);
    for (const u of by) u.matched++;
    const first = by[0]?.comment;
    if (!first) kept.push(f);
    else
      ignored.push({ ...f, comment: { loc: first.loc, ...(first.reason ? { reason: first.reason } : {}) } });
  }
  return { kept, ignored, usage: [...byFile.values()].flat() };
}

/** Text to insert into a file at a 1-based line and column. */
export interface TextInsertion {
  line: number;
  column: number;
  newText: string;
}

/**
 * The edit that ignores `code` on the line a finding starts on (`findingLine`) in a workflow or action file: the rule
 * added to a comment that accepts that line already, else a comment on a line of its own above it. Above the line its
 * scalar starts on, when the finding is in one over several lines, so a comment never lands in a block scalar's text.
 */
export function addIgnoreComment(text: string, code: string, findingLine: number): TextInsertion | undefined {
  const lines = text.split('\n');
  if (findingLine < 1 || findingLine > lines.length) return undefined;
  const ignores = read('', text);
  const existing = ignores.comments.find((c) => !c.malformed && coversLine(ignores, c.line, findingLine));
  if (existing) {
    const close = lines[existing.loc.line - 1]!.indexOf(']', existing.loc.column - 1);
    return { line: existing.loc.line, column: close + 1, newText: `, ${code}` };
  }
  const line = Math.min(
    findingLine,
    ...ignores.spans.filter((s) => s.first <= findingLine && findingLine <= s.last).map((s) => s.first),
  );
  const indent = /^[ \t]*/.exec(lines[line - 1]!)![0];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { line, column: 1, newText: `${indent}# flowpact: ignore[${code}]${eol}` };
}
