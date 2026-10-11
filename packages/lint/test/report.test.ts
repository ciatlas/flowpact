import { type AnalysisResult, reportJsonSchema, reportSchema, toJsonReport } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { lint, WF } from './helpers';

describe('JSON report', () => {
  const r = lint({
    [`${WF}/a.yml`]:
      'on:\n  workflow_dispatch:\n    inputs:\n      dead: {}\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
  });

  it('validates against the published schema, with and without the graph', () => {
    expect(reportSchema.safeParse(toJsonReport(r)).success).toBe(true);
    const withGraph = toJsonReport(r, { includeGraph: true });
    expect(reportSchema.safeParse(withGraph).error).toBeUndefined();
    expect(withGraph.graph?.nodes.length).toBeGreaterThan(0);
  });

  it('keeps the graph to the fields the schema documents', () => {
    // A field the workflow model adds must not change the published report.
    const loc = { file: 'a.yml', line: 1, column: 2, endLine: 3, endColumn: 4 };
    const index = {
      toJSON: () => ({
        nodes: [
          { id: 'a', kind: 'job', label: 'jobs.a', unit: 'a.yml', loc: { ...loc, offset: 9 }, extra: 1 },
          { id: 'r', kind: 'remote', label: 'o/r/w.yml@v1' },
        ],
        edges: [{ from: 'a', to: 'r', kind: 'calls', loc, siteId: 0, extra: true }],
      }),
    };
    const { graph } = toJsonReport({ ...r, index } as unknown as AnalysisResult, { includeGraph: true });
    const documented = {
      nodes: [
        { id: 'a', kind: 'job', label: 'jobs.a', unit: 'a.yml', loc },
        { id: 'r', kind: 'remote', label: 'o/r/w.yml@v1' },
      ],
      edges: [{ from: 'a', to: 'r', kind: 'calls', loc, siteId: 0 }],
    };
    expect(graph).toStrictEqual(documented);
    // The order of the keys is part of the published bytes too.
    expect(JSON.stringify(graph)).toBe(JSON.stringify(documented));
  });

  it('round-trips through JSON', () => {
    const json = JSON.parse(JSON.stringify(toJsonReport(r)));
    expect(reportSchema.parse(json).findings[0]?.code).toBe('FP104');
    expect(json.meta.version).toBeDefined();
    expect(json.$schema).toBe('https://ciatlas.github.io/flowpact/schemas/report/v1.json');
  });

  it('exports a JSON schema', () => {
    expect(JSON.stringify(reportJsonSchema())).toContain('fingerprint');
  });
});
