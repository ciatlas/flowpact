/**
 * Regression tests for the gaps found when re-verifying the round 2 fixes of the adversarial review: the cases that
 * render output (the rest are in packages/lint/test/review-round3.test.ts).
 */
import { memoryFileSystem } from '@ciatlas/core';
import { type AnalysisResult, analyze, type Finding, parseConfig } from '@flowpact/lint';
import { buildCallGraph, renderMarkdown } from '@flowpact/reporters';
import { describe, expect, it } from 'vitest';

const WF = '.github/workflows';
/** As lint's test helper analyzes in-memory files. */
const lint = (files: Record<string, string>): AnalysisResult =>
  analyze({
    root: '/virtual/repo',
    fs: memoryFileSystem(files),
    config: parseConfig({}),
    validateSchema: false,
    repository: 'acme/repo',
  });
const codes = (r: { findings: Finding[] }) => r.findings.map((f) => f.code);
const byCode = (r: { findings: Finding[] }, code: string) => r.findings.filter((f) => f.code === code);

describe('untrusted names in output (#9)', () => {
  const inheritCall = (name: string) => ({
    [`${WF}/c.yml`]: 'on: push\njobs:\n  call:\n    uses: ./.github/workflows/r.yml\n    secrets: inherit\n',
    [`${WF}/r.yml`]: `on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: |\n          echo "\${{ secrets['${name.replaceAll('\n', '\n          ')}'] }}"\n`,
  });

  it('escapes secret names inside the FP204 snippet', () => {
    const r = lint(
      inheritCall('A\n```\n</details><img src=https://e.vil/p.png> @octocat\n::error title=x::pwned\n'),
    );
    const fix = byCode(r, 'FP204')[0]!.fix;
    expect(fix.split('\n')).toHaveLength(3);
    expect(fix).toContain('\\n```\\n');
    const md = renderMarkdown(r);
    expect(md).not.toMatch(/^<\/details><img/m);
    expect(md).not.toMatch(/^\s*::error/m);
  });

  it('fences a snippet with a longer fence than any backtick run in it', () => {
    const r = lint(inheritCall('A````B'));
    const md = renderMarkdown(r);
    expect(md).toContain('`````yaml');
  });
});

describe('calls by path (#18, #23)', () => {
  it('draws calls to files outside .github/workflows in the graph', () => {
    const r = lint({
      [`${WF}/c.yml`]: 'on: push\njobs:\n  x:\n    uses: ./ci/r.yml\n',
      'ci/r.yml': 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    });
    expect(codes(r)).toContain('FP606');
    const g = buildCallGraph(r.index);
    expect(g.nodes.find((n) => n.id === 'ci/r.yml')?.kind).toBe('invalid');
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: `${WF}/c.yml`, to: 'ci/r.yml', via: 'jobs.x' }),
    );
  });
});
