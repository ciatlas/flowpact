/**
 * Minimal ANSI → SVG renderer for documentation screenshots. Supports the SGR codes flowpact emits
 * (bold, dim, underline, 8/16 foreground and background colors) and strips OSC 8 hyperlinks.
 */
const PALETTE: Record<number, string> = {
  30: '#3b4252',
  31: '#ff6b6b',
  32: '#69db7c',
  33: '#ffd43b',
  34: '#74c0fc',
  35: '#da77f2',
  36: '#66d9e8',
  37: '#e9ecef',
  90: '#868e96',
  91: '#ff8787',
  92: '#8ce99a',
  93: '#ffe066',
  94: '#a5d8ff',
  95: '#e599f7',
  96: '#99e9f2',
  97: '#ffffff',
};
const FG = '#d8dee9';
const BG = '#1e2128';

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
}

interface Span extends Style {
  text: string;
}

function parseAnsi(input: string): Span[][] {
  const clean = input.replace(/\u001B\]8;;[^\u0007]*\u0007/g, '');
  const lines: Span[][] = [];
  for (const raw of clean.split('\n')) {
    const spans: Span[] = [];
    let style: Style = {};
    const re = /\u001B\[([\d;]*)m/g;
    let last = 0;
    let m: RegExpExecArray | null = re.exec(raw);
    const push = (text: string) => text && spans.push({ ...style, text });
    while (m) {
      push(raw.slice(last, m.index));
      for (const code of (m[1] || '0').split(';').map(Number)) {
        if (code === 0) style = {};
        else if (code === 1) style.bold = true;
        else if (code === 2) style.dim = true;
        else if (code === 4) style.underline = true;
        else if (code === 22) style = { ...style, bold: false, dim: false };
        else if (code === 24) style.underline = false;
        else if (code === 39) delete style.fg;
        else if (code === 49) delete style.bg;
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) style.fg = PALETTE[code];
        else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) style.bg = PALETTE[code - 10];
      }
      last = re.lastIndex;
      m = re.exec(raw);
    }
    push(raw.slice(last));
    lines.push(spans);
  }
  while (lines.length && lines.at(-1)!.every((s) => !s.text.trim())) lines.pop();
  return lines;
}

/** Escapes text for SVG content and attribute values. */
const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function ansiToSvg(input: string, opts: { title?: string; prompt?: string } = {}): string {
  const lines = parseAnsi(opts.prompt ? `\u001B[32m$\u001B[0m ${opts.prompt}\n${input}` : input);
  const charW = 8.4;
  const lineH = 19;
  const padX = 20;
  const top = 48;
  const cols = Math.max(60, ...lines.map((l) => [...l.map((s) => s.text).join('')].length));
  const width = Math.ceil(cols * charW + padX * 2);
  const height = top + lines.length * lineH + 20;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.title ?? 'terminal output')}">`,
    `<rect width="100%" height="100%" rx="10" fill="${BG}"/>`,
    '<circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>',
    opts.title
      ? `<text x="${width / 2}" y="22" fill="#868e96" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" text-anchor="middle">${esc(opts.title)}</text>`
      : '',
    `<g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="14" xml:space="preserve">`,
  ];
  lines.forEach((spans, i) => {
    const y = top + i * lineH;
    let col = 0;
    const tspans: string[] = [];
    for (const s of spans) {
      const chars = [...s.text];
      if (s.bg)
        out.push(
          `<rect x="${padX + col * charW}" y="${y - 14}" width="${chars.length * charW}" height="${lineH}" fill="${s.bg}"/>`,
        );
      const attrs = [
        `fill="${s.fg ?? FG}"`,
        s.bold ? 'font-weight="700"' : '',
        s.dim ? 'fill-opacity="0.6"' : '',
        s.underline ? 'text-decoration="underline"' : '',
      ]
        .filter(Boolean)
        .join(' ');
      // Place every run of non-space characters at its exact column and pin its width, so alignment does not
      // depend on the viewer's monospace font metrics or on whitespace handling.
      for (const m of s.text.matchAll(/\S+/g)) {
        const start = [...s.text.slice(0, m.index)].length;
        const len = [...m[0]].length;
        const x = (padX + (col + start) * charW).toFixed(1);
        tspans.push(
          `<tspan x="${x}" textLength="${(len * charW).toFixed(1)}" lengthAdjust="spacingAndGlyphs" ${attrs}>${esc(m[0])}</tspan>`,
        );
      }
      col += chars.length;
    }
    out.push(`<text y="${y}">${tspans.join('')}</text>`);
  });
  out.push('</g></svg>');
  return `${out.filter(Boolean).join('\n')}\n`;
}
