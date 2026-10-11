import { fileURLToPath } from 'node:url';
import { memoryFileSystem } from '@flowpact/core';
import { analyze, createRegistry, defineRule, type Severity } from '@flowpact/lint';
import { githubAnnotation, renderGithub, renderJson, renderSarif } from '@flowpact/reporters';
import { describe, expect, it } from 'vitest';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const fixture = (name: string) => analyze({ root: `${FIXTURES}${name}`, repository: 'acme/fixtures' });

/** A repository with one workflow and a plugin rule that reports `message` there with the given severity and lines. */
function reported(
  message: string,
  {
    severity = 'warning',
    file = 'ci.yml',
    endLine = 1,
  }: { severity?: Severity; file?: string; endLine?: number } = {},
) {
  const registry = createRegistry().register(
    defineRule({
      code: 'ACME601',
      name: 'acme-check',
      category: 'structure',
      defaultSeverity: severity,
      docsUrl: 'https://example.com/acme601',
      docs: { summary: 'Acme check', why: 'Because acme.', fix: 'Do the acme thing.' },
      check(ctx) {
        const wf = ctx.index.project.workflows.get(`.github/workflows/${file}`)!;
        ctx.report({ message, loc: { file: wf.path, line: 1, column: 1, endLine, endColumn: 4 } });
      },
    }),
  );
  return analyze({
    root: '/virtual/repo',
    fs: memoryFileSystem({
      [`.github/workflows/${file}`]: 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n',
    }),
    validateSchema: false,
    only: ['ACME601'],
    registry,
  });
}

describe('renderGithub', () => {
  it('prints one workflow command per finding, with the fix and the docs link', () => {
    expect(renderGithub(fixture('incident-matrix'))).toBe(
      '::error title=FP401 empty-binding-for-matrix-combo,file=.github/workflows/tests.yml,line=23,endLine=23,col=19,endColumn=32::' +
        'Input "config" for .github/workflows/run-suite.yml is empty in 1 of 3 matrix combinations — matrix.config is not defined there' +
        "%0ASet `config` in every combination, or use a fallback: `${{ matrix.config || '<default>' }}`." +
        '%0Ahttps://rumankazi.github.io/flowpact/docs/rules/fp401\n',
    );
  });

  it('escapes the message and the properties so nothing can end the command early', () => {
    const out = renderGithub(reported('100% :: done, really', { file: 'a,b:c.yml' }));
    expect(out).toBe(
      '::warning title=ACME601 acme-check,file=.github/workflows/a%2Cb%3Ac.yml,line=1,endLine=1,col=1,endColumn=4::' +
        '100%25 :: done, really%0ADo the acme thing.%0Ahttps://example.com/acme601\n',
    );
    expect(out.split('\n')).toHaveLength(2);
  });

  it('maps info to notice and leaves out columns on findings over several lines', () => {
    const [line] = renderGithub(reported('x', { severity: 'info', endLine: 3 })).split('\n');
    expect(line).toMatch(
      /^::notice title=ACME601 acme-check,file=\.github\/workflows\/ci\.yml,line=1,endLine=3::x%0A/,
    );
    expect(renderGithub(reported('x', { severity: 'error' }))).toMatch(/^::error /);
  });

  it('prints nothing without findings', () => {
    expect(renderGithub(fixture('clean'))).toBe('');
  });

  it('makes paths relative to the repository when the root is a subdirectory', () => {
    const r = fixture('incident-matrix');
    expect(githubAnnotation(r.findings[0]!, { pathPrefix: 'services/api' }).file).toBe(
      'services/api/.github/workflows/tests.yml',
    );
    expect(renderGithub(r, { pathPrefix: 'services/api' })).toContain(
      ',file=services/api/.github/workflows/tests.yml,',
    );
    const run = JSON.parse(renderSarif(r, { pathPrefix: 'services/api' })).runs[0];
    const uris = JSON.stringify(run.results).match(/"uri":"[^"]*"/g)!;
    expect(uris.length).toBeGreaterThan(1);
    for (const uri of uris) expect(uri).toMatch(/^"uri":"services\/api\/\.github\//);
  });
});

describe('JSON and SARIF reports', () => {
  it('cannot be read as workflow commands when a CI step prints them, and carry the same data', () => {
    const message = 'x ##[set-output name=a]1 \u2028::error::y \u2029z';
    const r = reported(message);
    for (const text of [renderJson(r), renderSarif(r)]) {
      expect(text).not.toMatch(/##\[|\u2028|\u2029/);
      expect(JSON.stringify(JSON.parse(text))).toContain(JSON.stringify(r.findings[0]!.message).slice(1, -1));
    }
    expect(r.findings[0]!.message).toContain('##[set-output');
  });
});
