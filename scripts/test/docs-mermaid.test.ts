/** The checks that make `docs:build` fail on a diagram beautiful-mermaid would draw wrong (apps/docs/components). */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { accessibility, chartProblem } from '../../apps/docs/components/mermaid-check';

const DOCS = join(import.meta.dirname, '../../apps/docs');
// beautiful-mermaid is the docs app's dependency (an ES module only), loaded from there as the site loads it.
const { renderMermaidSVG } = (await import(
  pathToFileURL(join(DOCS, 'node_modules/beautiful-mermaid/dist/index.js')).href
)) as { renderMermaidSVG: (chart: string, options?: Record<string, unknown>) => string };
const draw = (chart: string) =>
  renderMermaidSVG(accessibility(chart).source).replace(/@import url\([^)]*\);?\s*/g, '');

describe('docs diagrams', () => {
  it('takes accTitle and accDescr out of the chart, for screen readers', () => {
    expect(
      accessibility('flowchart LR\n  accTitle: How it flows\n  accDescr: Two steps\n  A --> B\n'),
    ).toEqual({
      source: 'flowchart LR\n\n\n  A --> B\n',
      title: 'How it flows',
      description: 'Two steps',
    });
  });

  it('accepts a chart drawn as written', () => {
    const chart = 'flowchart LR\n  accTitle: T\n  A["Caller"]\n  B["Callee"]\n  A --> B\n  B -.-> A\n';
    expect(chartProblem(chart, draw(chart))).toBeUndefined();
  });

  it('refuses a chart without accTitle, an edge without spaces, and a font import', () => {
    const plain = 'flowchart LR\n  A["a"] --> B["b"]\n';
    expect(chartProblem(plain, draw(plain))).toMatch(/no accTitle/);
    const tight = 'flowchart LR\n  accTitle: T\n  A["a"]\n  B["b"]\n  A-->B\n';
    expect(chartProblem(tight, draw(tight))).toMatch(/without spaces/);
    const chart = 'flowchart LR\n  accTitle: T\n  A["a"] --> B["b"]\n';
    expect(chartProblem(chart, `${draw(chart)}<style>@import url(x)</style>`)).toMatch(/font/);
  });

  it('refuses a node drawn as its id: labelled after an edge used it', () => {
    const chart = 'flowchart LR\n  accTitle: T\n  A --> G\n  G["Data-flow graph"] --> B["b"]\n';
    expect(chartProblem(chart, draw(chart))).toMatch(/node G is drawn as its id/);
  });
});
