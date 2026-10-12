import pc from 'picocolors';
import stringWidth from 'string-width';

export interface RenderOptions {
  color: boolean;
  /** Terminal columns; output wraps to this width. */
  width: number;
  /** Emit OSC 8 hyperlinks for docs URLs. */
  hyperlinks: boolean;
  /** Use ASCII instead of box-drawing characters and symbols. */
  ascii?: boolean;
}

export const defaultRenderOptions = (): RenderOptions => ({ color: false, width: 100, hyperlinks: false });

export type Theme = ReturnType<typeof createTheme>;

export function createTheme(opts: RenderOptions) {
  const c = pc.createColors(opts.color);
  const a = opts.ascii ?? false;
  const sym = {
    error: a ? 'x' : '✖',
    warning: a ? '!' : '▲',
    info: a ? 'i' : '●',
    ok: a ? 'v' : '✔',
    bar: a ? '|' : '│',
    arrow: a ? '->' : '→',
    pointer: a ? '>' : '▶',
    corner: a ? '+' : '╭',
    cornerEnd: a ? '+' : '╰',
    h: a ? '-' : '─',
    caret: a ? '^' : '━',
    tee: a ? '|-' : '├─',
    elbow: a ? '`-' : '└─',
    dot: a ? '-' : '·',
    tl: a ? '+' : '╭',
    tr: a ? '+' : '╮',
    bl: a ? '+' : '╰',
    br: a ? '+' : '╯',
  };
  const severity = {
    error: (s: string) => c.red(s),
    warning: (s: string) => c.yellow(s),
    info: (s: string) => c.blue(s),
  };
  const badge = {
    error: (s: string) => c.bgRed(c.white(c.bold(s))),
    warning: (s: string) => c.bgYellow(c.black(c.bold(s))),
    info: (s: string) => c.bgBlue(c.white(c.bold(s))),
  };
  const link = (text: string, url: string) =>
    opts.hyperlinks ? `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007` : text;
  return { c, sym, severity, badge, link, opts };
}

export const visibleWidth = (s: string) => stringWidth(s);

export function padEnd(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visibleWidth(s)));
}

/** Word-wraps plain text to `width` columns. Long tokens (URLs, paths) are kept intact. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    // Keep indentation of code-like lines (e.g. suggested YAML).
    const indent = /^\s*/.exec(para)?.[0] ?? '';
    let line = indent;
    for (const word of para.trim().split(/\s+/)) {
      const candidate = line.trim() === '' ? `${indent}${word}` : `${line} ${word}`;
      if (visibleWidth(candidate) > width && line.trim() !== '') {
        out.push(line);
        line = `${indent}${word}`;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

/** Renders `content` lines inside a rounded box. */
export function box(t: Theme, title: string, content: string[], width: number): string {
  const inner = Math.max(
    visibleWidth(title) + 4,
    ...content.map((l) => visibleWidth(l) + 2),
    Math.min(width - 2, 60),
  );
  const { sym, c } = t;
  const top = `${c.dim(sym.tl + sym.h)} ${c.bold(title)} ${c.dim(sym.h.repeat(Math.max(0, inner - visibleWidth(title) - 3)) + sym.tr)}`;
  const body = content.map((l) => `${c.dim(sym.bar)} ${padEnd(l, inner - 2)} ${c.dim(sym.bar)}`);
  const bottom = c.dim(sym.bl + sym.h.repeat(inner) + sym.br);
  return [top, ...body, bottom].join('\n');
}

const ASCII_MAP: Record<string, string> = {
  '↻': '(cycle)',
  '↑': '^',
  '·': '-',
  '◀': '<',
  '▶': '>',
  '━': '^',
  '─': '-',
  '│': '|',
  '├': '|',
  '└': '`',
  '╭': '+',
  '╮': '+',
  '╰': '+',
  '╯': '+',
  '—': '-',
  '–': '-',
  '›': '>',
  '→': '->',
  '←': '<-',
  '…': '...',
  '✗': 'x',
  '✓': 'v',
  '“': '"',
  '”': '"',
  '’': "'",
};

/** Replaces typographic characters (from messages and docs) when ASCII-only output is requested. */
export function finalize(text: string, opts: RenderOptions): string {
  if (!opts.ascii) return text;
  return text.replace(/[—–›→←…✗✓“”’↻↑·◀▶━─│├└╭╮╰╯]/g, (ch) => ASCII_MAP[ch] ?? ch);
}

/** Makes control characters in untrusted text (YAML names, source lines) visible instead of interpreting them. */
export function safe(s: string): string {
  return s.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, (ch) =>
    ch === '\n' ? '\\n' : `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}
