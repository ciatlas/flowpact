import { createHash } from 'node:crypto';
import { renderMermaidSVG } from 'beautiful-mermaid';
import { accessibility, chartProblem } from './mermaid-check';

/**
 * A Mermaid chart drawn at build time (a Server Component): no diagram code reaches the browser, and the colors follow
 * the site's theme variables, so it needs no redraw in dark mode. A chart it cannot draw as written fails the build.
 */
export function Mermaid({ chart }: { chart: string }) {
  const { source, title, description } = accessibility(chart);
  const prefix = `m${createHash('sha1').update(chart).digest('hex').slice(0, 8)}-`;
  const svg = renderMermaidSVG(source, {
    bg: 'var(--color-fd-background)',
    fg: 'var(--color-fd-foreground)',
    accent: 'var(--color-fd-primary)',
    transparent: true,
  })
    // No font request to Google: the page's font is used.
    .replace(/@import url\([^)]*\);?\s*/g, '')
    .replace(/font-family: 'Inter', /g, 'font-family: ')
    // Ids are fixed per diagram; two diagrams on a page would share them.
    .replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${prefix}${id})`);
  const problem = chartProblem(chart, svg);
  if (problem) throw new Error(`Mermaid chart "${title ?? source.trim().split('\n')[0]}": ${problem}`);
  return (
    <figure
      role="img"
      aria-label={[title, description].filter(Boolean).join('. ')}
      className="not-prose my-6"
    >
      <div
        className="overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the SVG is drawn at build time from the docs' own charts.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {title ? (
        <figcaption className="mt-2 text-center text-sm text-fd-muted-foreground">{title}</figcaption>
      ) : null}
    </figure>
  );
}
