/**
 * Checks of a Mermaid chart against the SVG beautiful-mermaid drew for it, so `docs:build` fails instead of showing a
 * wrong diagram. beautiful-mermaid drops an edge written without spaces (`A-->B`), keeps the first label it sees for a
 * node (one used in an edge before its label shows its bare id), and draws `accTitle:` lines as nodes.
 */

/** The `accTitle` and `accDescr` of a chart, taken out of its source, which beautiful-mermaid would draw. */
export function accessibility(chart: string): { source: string; title?: string; description?: string } {
  const found: Record<string, string> = {};
  const source = chart.replace(
    /^[ \t]*acc(Title|Descr)[ \t]*:[ \t]*(.*)$/gm,
    (_, key: string, value: string) => {
      found[key] = value.trim();
      return '';
    },
  );
  return {
    source,
    ...(found.Title ? { title: found.Title } : {}),
    ...(found.Descr ? { description: found.Descr } : {}),
  };
}

const ARROW = /\s(?:-->|-\.->|==>|---|-\.-|===)\s?/g;

/** Why the drawn SVG does not show the chart as written, or undefined when it does. */
export function chartProblem(chart: string, svg: string): string | undefined {
  if (!/^\s*accTitle\s*:/m.test(chart)) return 'no accTitle: give every diagram a title for screen readers';
  const { source } = accessibility(chart);
  if (/@import/.test(svg)) return 'the SVG still imports a font';
  if (/^\s*(flowchart|graph)\b/m.test(source)) {
    const arrows = source.split('\n').reduce((n, line) => n + (line.match(ARROW)?.length ?? 0), 0);
    const edges = svg.match(/class="edge"/g)?.length ?? 0;
    if (/\w(?:-->|-\.->|==>)\w/.test(source))
      return 'an edge written without spaces (A-->B) is dropped: write A --> B';
    if (edges !== arrows) return `${arrows} edges written, ${edges} drawn`;
  }
  const texts = new Set([...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!.trim()));
  for (const m of source.matchAll(/\b([A-Za-z]\w*)\s*[[({]+"?([^\]})"]+)/g)) {
    const [, id, label] = m;
    if (id !== label && texts.has(id!) && !texts.has(label!.trim()))
      return `node ${id} is drawn as its id: declare it with its label before an edge uses it`;
  }
  return undefined;
}
