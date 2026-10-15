import { fileURLToPath } from 'node:url';
import { memoryFileSystem, sym, type TraceNode, trace } from '@ciatlas/core';
import { analyze, createRegistry, reportSchema, toolMeta } from '@flowpact/lint';
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

  it('escapes control characters in leaf and via texts', () => {
    const loc = { file: 'a.yml', line: 1, column: 1, endLine: 1, endColumn: 2 };
    const node: TraceNode = {
      symbol: 'a.yml#inputs.x',
      label: 'inputs.x',
      kind: 'input',
      unit: 'a.yml',
      children: [
        {
          symbol: 'b.yml#inputs.y',
          label: 'inputs.y',
          kind: 'input',
          via: { loc, text: '\u001b[31mred' },
          children: [],
          leaves: [],
        },
      ],
      leaves: [{ role: 'context', where: 'b.yml \u001b[0m', loc, text: "github.event['\u001b[32mx']" }],
    };
    const out = renderTrace(node, 'up', plain);
    expect(out).not.toContain('\u001b');
    expect(out).toContain("github.event['\\x1b[32mx']");
    expect(out).toContain('via \\x1b[31mred');
    expect(out).toContain('in b.yml \\x1b[0m');
  });

  it('prints the note on how a value got there in parentheses after the via text, dimmed and escaped', () => {
    const loc = { file: 'b.yml', line: 3, column: 9, endLine: 3, endColumn: 12 };
    const node = (note: string): TraceNode => ({
      symbol: 'a.yml#inputs.x',
      label: 'inputs.x',
      kind: 'input',
      unit: 'a.yml',
      children: [
        {
          symbol: 'b.yml#inputs.y',
          label: 'inputs.y',
          kind: 'input',
          via: { loc, text: '${{ github.event.inputs.y }}', note },
          children: [],
          leaves: [],
        },
      ],
      leaves: [],
    });
    expect(renderTrace(node('when dispatched'), 'up', plain)).toContain(
      '    via ${{ github.event.inputs.y }} (when dispatched)  @ b.yml:3:9',
    );
    const colored = renderTrace(node('when dispatched'), 'up', { ...plain, color: true });
    expect(colored).toContain('\u001b[2mvia ${{ github.event.inputs.y }} (when dispatched)\u001b[22m');
    const hostile = renderTrace(node('jobs.\u001b[31mx'), 'up', plain);
    expect(hostile).not.toContain('\u001b');
    expect(hostile).toContain('(jobs.\\x1b[31mx)  @ b.yml:3:9');
  });

  it('notes a dispatch input, the default an input falls back to, a workflow output and secrets: inherit', () => {
    const files = {
      '.github/workflows/top.yml': `on: push
jobs:
  mid:
    uses: ./.github/workflows/mid.yml
    secrets:
      TOKEN: \${{ secrets.DEPLOY }}
  after:
    needs: mid
    runs-on: x
    steps:
      - run: echo "\${{ needs.mid.outputs.url }}"
`,
      '.github/workflows/mid.yml': `on:
  workflow_call:
    inputs:
      base: { type: string, default: main }
      target: { type: string, default: "\${{ inputs.base }}" }
    secrets:
      TOKEN: { required: true }
    outputs:
      url: { value: "\${{ jobs.leaf.outputs.url }}" }
  workflow_dispatch:
    inputs:
      target: { type: string }
jobs:
  leaf:
    uses: ./.github/workflows/leaf.yml
    secrets: inherit
  show:
    runs-on: x
    outputs:
      mode: \${{ github.event.inputs.target }}
    steps:
      - run: echo "\${{ inputs.target }}"
`,
      '.github/workflows/leaf.yml': `on:
  workflow_call:
    secrets:
      TOKEN: { required: true }
    outputs:
      url: { value: "\${{ jobs.j.outputs.url }}" }
jobs:
  j:
    runs-on: x
    outputs:
      url: \${{ steps.s.outputs.url }}
    steps:
      - id: s
        run: echo "url=\${{ secrets.TOKEN }}" >> "$GITHUB_OUTPUT"
`,
    };
    const r = analyze({ root: '/virtual/repo', fs: memoryFileSystem(files), validateSchema: false });
    const viaLines = (symbol: string, direction: 'down' | 'up') =>
      renderTrace(trace(r.index, symbol, { direction }), direction, plain)
        .split('\n')
        .filter((l) => l.includes('via '))
        .map((l) => l.replace(/^[│ ]+/, ''));
    const MID = '.github/workflows/mid.yml';
    expect(viaLines(sym.jobOutput(MID, 'show', 'mode'), 'up')).toEqual([
      `via \${{ github.event.inputs.target }} (when dispatched)  @ ${MID}:20:17`,
    ]);
    expect(viaLines(sym.input(MID, 'target'), 'up')).toEqual([
      `via \${{ inputs.base }} (the default of inputs.target)  @ ${MID}:5:45`,
    ]);
    expect(viaLines(sym.output(MID, 'url'), 'down')).toEqual([
      `via workflow output (exposed to the caller)  @ ${MID}:9:7`,
    ]);
    expect(viaLines(sym.secret(MID, 'TOKEN'), 'down')).toEqual([
      `via secrets: inherit (jobs.leaf)  @ ${MID}:16:5`,
    ]);
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
    const rule = registry.get('FP102')!;
    const out = renderExplain(rule, registry.docsUrl(rule), 'warning', plain);
    expect(out).toContain('configured: warning');
    expect(out).toContain('✗ problem');
    expect(out).toContain('✓ fixed');
    expect(out).toContain('https://ciatlas.github.io/flowpact/docs/rules/fp102');
    expect(out).not.toContain('scope');
  });
  it('explains what a rule reports and leaves out under scope, not with every finding', () => {
    const rule = registry.get('FP401')!;
    const out = renderExplain(rule, registry.docsUrl(rule), 'error', plain).replace(/\s+/g, ' ');
    expect(out).toContain('scope Reported as an error when the input is required');
    expect(rule.docs.fix).not.toContain('Not reported');
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
