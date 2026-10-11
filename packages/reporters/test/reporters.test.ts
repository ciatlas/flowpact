import { fileURLToPath } from 'node:url';
import { memoryFileSystem, sym } from '@flowpact/core';
import { analyze, createRegistry, reportSchema, toolMeta, trace } from '@flowpact/lint';
import {
  codeFrame,
  createTheme,
  type RenderOptions,
  renderBanner,
  renderExplain,
  renderJson,
  renderPretty,
  renderRuleList,
  renderTrace,
  wrap,
} from '@flowpact/reporters';
import { describe, expect, it } from 'vitest';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const plain: RenderOptions = { color: false, width: 100, hyperlinks: false };
const result = (name: string) => {
  const r = analyze({ root: `${FIXTURES}${name}`, repository: 'acme/fixtures' });
  r.durationMs = 7; // keep snapshots deterministic
  r.meta.node = 'v24.0.0';
  return r;
};

describe('renderPretty', () => {
  it('renders the incident with code frame, matrix, context, why, fix and docs', () => {
    const out = renderPretty(result('incident-matrix'), plain);
    expect(out).toMatchSnapshot();
    expect(out).toContain('23 │       config: ${{ matrix.config }}');
    expect(out).toContain('━━━━━━━━━━━━━');
    expect(out).toContain('docs    https://ciatlas.github.io/flowpact/docs/rules/fp401');
  });

  it('renders every fixture without throwing and keeps lines within width', () => {
    for (const name of ['deep-nesting', 'composite-actions', 'cycles', 'dynamic-matrix', 'broken']) {
      const out = renderPretty(result(name), { ...plain, width: 80 });
      const tooWide = out
        .split('\n')
        .filter((l) => !l.includes('│') && !l.includes('├─') && !l.includes('└─') && l.length > 80);
      expect(tooWide).toEqual([]);
    }
  });

  it('reports a clean run', () => {
    expect(renderPretty(result('clean'), plain)).toContain('✔ No problems found');
    expect(renderPretty(result('clean'), plain)).not.toContain('generated files');
  });

  it('notes how many findings it left out in generated files', () => {
    const r = analyze({
      root: '/virtual/repo',
      fs: memoryFileSystem({
        '.github/workflows/triage.lock.yml':
          'on: push\njobs:\n  j:\n    runs-on: x\n    outputs:\n      a: x\n      b: y\n    steps: [{ run: echo }]\n',
      }),
      validateSchema: false,
    });
    expect(r.summary.skippedInGenerated).toBe(2);
    expect(renderPretty(r, plain)).toContain(
      '2 findings not reported in generated files (-v lists the files)',
    );
  });

  it('can hide info findings but still counts them', () => {
    const out = renderPretty(result('cycles'), { ...plain, hideInfo: true });
    expect(out).not.toContain('FP603 remote-unverified\n');
    expect(out).toContain('1 info (hidden)');
  });

  it('emits ANSI colors and OSC 8 hyperlinks only when asked', () => {
    const colored = renderPretty(result('incident-matrix'), { color: true, width: 100, hyperlinks: true });
    expect(colored).toMatch(/\u001B\[31m/);
    expect(colored).toContain('\u001B]8;;https://ciatlas.github.io/flowpact/docs/rules/fp401\u0007');
    expect(renderPretty(result('incident-matrix'), plain)).not.toMatch(/\u001B/);
  });

  it('marks a code in the summary with its most severe finding', () => {
    const r = result('incident-matrix');
    const [f] = r.findings;
    const later = { ...f!, severity: 'warning' as const, loc: { ...f!.loc, line: f!.loc.line + 1 } };
    r.findings = [f!, later];
    r.summary.byCode = { [f!.code]: 2 };
    expect(renderPretty(r, plain)).toContain(`✖ ${f!.code}  `);
  });

  it('supports ASCII-only output', () => {
    const out = renderPretty(result('incident-matrix'), { ...plain, ascii: true });
    expect(out).toMatch(/^[\x20-\x7E\n]*$/);
  });
});

describe('banner', () => {
  it('shows tool version and every schema version', () => {
    const b = renderBanner(toolMeta(), plain, 'root /x');
    expect(b).toMatch(
      /^ flowpact {2}v\d+\.\d+\.\d+ {2}config schema v1 · contract schema v1 · report schema v1 · node v/,
    );
    expect(b).toContain('root /x');
  });
});

describe('renderJson', () => {
  it('produces schema-valid JSON', () => {
    const json = JSON.parse(renderJson(result('deep-nesting'), { includeGraph: true }));
    expect(reportSchema.safeParse(json).success).toBe(true);
  });
});

describe('renderTrace', () => {
  it('draws the flow tree downward and upward', () => {
    const r = result('incident-matrix');
    const down = renderTrace(
      trace(r.index, sym.input('.github/workflows/tests.yml', 'suite')),
      'down',
      plain,
    );
    expect(down).toMatchSnapshot();
    const up = renderTrace(
      trace(r.index, sym.input('.github/workflows/run-suite.yml', 'config'), { direction: 'up' }),
      'up',
      plain,
    );
    expect(up).toContain('missing in { name: windows }');
    expect(up).toContain("(undefined → '')");
  });

  it('says when nothing reads a symbol', () => {
    const r = result('deep-nesting');
    expect(
      renderTrace(trace(r.index, sym.input('.github/workflows/pipeline.yml', 'legacy-flag')), 'down', plain),
    ).toContain('not read anywhere');
  });
});

describe('rules and explain', () => {
  const registry = createRegistry();
  it('lists every rule grouped by category', () => {
    const out = renderRuleList(registry, undefined, plain);
    for (const r of registry.all()) expect(out).toContain(r.code);
    expect(out).toContain('Inputs');
    expect(out).toContain('Graph structure');
  });
  it('explains a rule with examples and docs link', () => {
    const rule = registry.get('FP401')!;
    const out = renderExplain(rule, registry.docsUrl(rule), 'warning', plain);
    expect(out).toContain('configured: warning');
    expect(out).toContain('✗ problem');
    expect(out).toContain('✓ fixed');
    expect(out).toContain('https://ciatlas.github.io/flowpact/docs/rules/fp401');
    expect(out).not.toContain('scope');
  });
  it('explains what a rule leaves out', () => {
    const rule = registry.get('FP303')!;
    const out = renderExplain(rule, registry.docsUrl(rule), 'warning', plain).replace(/\s+/g, ' ');
    expect(out).toContain('scope Job outputs are always judged');
    expect(out).toContain('Not reported in generated files, which are not edited by hand.');
  });
});

describe('helpers', () => {
  it('wraps text and keeps indentation', () => {
    expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
    expect(wrap('  x y', 4)).toEqual(['  x', '  y']);
    expect(wrap('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });
  it('draws a code frame for multi-line locations', () => {
    const r = result('incident-matrix');
    const src = r.project.workflows.get('.github/workflows/tests.yml')!.source;
    const frame = codeFrame(
      createTheme(plain),
      src,
      { file: 'x', line: 2, column: 1, endLine: 3, endColumn: 1 },
      { label: 'here' },
    );
    expect(frame.join('\n')).toContain('here');
  });
});
