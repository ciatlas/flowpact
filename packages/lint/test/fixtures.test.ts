import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyze, reportSchema, toJsonReport } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const run = (name: string) => analyze({ root: `${FIXTURES}${name}`, repository: 'acme/fixtures' });
const compact = (name: string) =>
  run(name).findings.map(
    (f) => `${f.severity} ${f.code} ${f.loc.file}:${f.loc.line}:${f.loc.column} ${f.message}`,
  );

describe('fixture repositories', () => {
  it('clean: no findings at any severity', () => {
    const r = run('clean');
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatchObject({ workflows: 2, actions: 1, matrixCombinations: 4 });
  });

  it('incident-matrix: exactly the missing-variant error, with the full chain', () => {
    const r = run('incident-matrix');
    expect(r.findings.map((f) => f.code)).toEqual(['FP401']);
    const [f] = r.findings;
    expect(f!.combos).toEqual(['{ name: windows }']);
    expect(f!.related.map((x) => x.loc.file)).toEqual([
      '.github/workflows/pipeline.yml',
      '.github/workflows/tests.yml',
      '.github/workflows/run-suite.yml',
      // `if: inputs.config != ''` in the callee: why an empty optional input is still an error here
      '.github/workflows/run-suite.yml',
    ]);
    expect(f!.severity).toBe('error');
  });

  it('ignore-comments: the comments accept a finding each, after a version comment too', () => {
    expect(
      run('ignore-comments').ignoredByComment.map((f) => `${f.code}:${f.loc.line} ${f.comment.reason}`),
    ).toEqual([
      'FP104:10 read by the release dispatcher until its migration (JIRA-123)',
      'FP501:20 set by scripts/setup-env.sh',
      'FP603:26 checked in acme/shared',
    ]);
  });

  for (const name of readdirSync(FIXTURES).filter((n) => !n.startsWith('.'))) {
    it(`${name}: findings snapshot`, () => {
      expect(compact(name)).toMatchSnapshot();
    });
    it(`${name}: report validates against the schema`, () => {
      expect(reportSchema.safeParse(toJsonReport(run(name), { includeGraph: true })).success).toBe(true);
    });
  }
});
