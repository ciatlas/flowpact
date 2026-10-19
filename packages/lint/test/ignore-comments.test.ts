import { memoryFileSystem } from '@ciatlas/core';
import {
  addIgnoreComment,
  analyze,
  coversLine,
  parseConfigText,
  readIgnoreComments,
  reportSchema,
  toJsonReport,
} from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { byCode, codes, lint, WF, yaml } from './helpers';

const FILE = `${WF}/ci.yml`;
const SHA = '0123456789abcdef0123456789abcdef01234567';

/** The comments of `text`, as the rules, the line each accepts and the reason or the problem. */
const comments = (text: string) =>
  readIgnoreComments(FILE, text).comments.map((c) => ({
    line: c.line,
    rules: c.rules.map((r) => r.key),
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.malformed ? { malformed: c.malformed } : {}),
  }));

describe('readIgnoreComments', () => {
  it('finds the directive after a version comment, with its rules, their columns and the reason', () => {
    const text = `      - uses: acme/deploy@${SHA} # v3.1.1 # flowpact: ignore[FP301, undefined-env-ref] read by the caller\n`;
    const [c] = readIgnoreComments(FILE, text).comments;
    expect(c).toMatchObject({ line: 1, reason: 'read by the caller' });
    expect(c!.rules.map((r) => [r.key, r.loc.column, r.loc.endColumn])).toEqual([
      ['FP301', text.indexOf('FP301') + 1, text.indexOf('FP301') + 6],
      ['undefined-env-ref', text.indexOf('undefined') + 1, text.indexOf('undefined') + 18],
    ]);
    expect(c!.loc).toMatchObject({ line: 1, column: text.indexOf('# flowpact') + 1, endColumn: text.length });
  });

  it('reads several directives on a line, and rules separated by spaces or commas', () => {
    expect(comments('x: 1 # flowpact: ignore[FP101 FP102] # flowpact: ignore[FP103,FP104] -- why\n')).toEqual(
      [
        { line: 1, rules: ['FP101', 'FP102'] },
        { line: 1, rules: ['FP103', 'FP104'], reason: 'why' },
      ],
    );
  });

  it('a comment alone on its line accepts the next line of YAML, past blank lines and other comments', () => {
    const text = yaml`
      steps:
        # flowpact: ignore[FP301]
        # pinned for the migration

        - uses: acme/deploy@v1
      # flowpact: ignore[FP302]
    `;
    expect(comments(text)).toEqual([
      { line: 5, rules: ['FP301'] },
      { line: 0, rules: ['FP302'] },
    ]);
  });

  it('only reads YAML comments: not a `#` in a quoted string or in a block scalar’s text', () => {
    const text = yaml`
      a: "x # flowpact: ignore[FP101]"
      b: 'y # flowpact: ignore[FP102]'
      c: |
        # flowpact: ignore[FP103]
        echo "# flowpact: ignore[FP104]"
      d: plain#flowpact: ignore[FP105]
    `;
    expect(comments(text)).toEqual([]);
  });

  it('reports what is wrong with a directive that is not ignore[<rules>]', () => {
    expect(
      comments('a: 1 # flowpact: ignore FP101\nb: 2 # flowpact: ignore[ ]\nc: 3 # flowpact: skip[FP101]\n'),
    ).toEqual([
      { line: 1, rules: [], malformed: 'lists no rules in brackets, as in `# flowpact: ignore[FP301]`' },
      { line: 2, rules: [], malformed: 'lists no rules in brackets, as in `# flowpact: ignore[FP301]`' },
      { line: 3, rules: [], malformed: 'is not `# flowpact: ignore[<rules>]`' },
    ]);
  });

  it('leaves other comments that mention flowpact alone', () => {
    expect(comments('a: 1 # checked by flowpact: see the docs\nb: 2 # flowpact:\n')).toEqual([
      { line: 2, rules: [], malformed: 'is not `# flowpact: ignore[<rules>]`' },
    ]);
  });

  it('reads files with CRLF line endings', () => {
    expect(comments('a: 1\r\n# flowpact: ignore[FP101] why\r\nb: 2 # flowpact: ignore[FP102]\r\n')).toEqual([
      { line: 3, rules: ['FP101'], reason: 'why' },
      { line: 3, rules: ['FP102'] },
    ]);
  });
});

describe('coversLine', () => {
  const text = yaml`
    - run: | # flowpact: ignore[FP501]
        echo one
        echo two
    - if: \${{ a &&
        b }} # flowpact: ignore[FP108]
      run: echo three
  `;
  const ignores = readIgnoreComments(FILE, text);

  it('a comment on a block scalar’s line accepts the findings in its text', () => {
    expect([1, 2, 3, 4].map((l) => coversLine(ignores, 1, l))).toEqual([true, true, true, false]);
  });

  it('a comment after a scalar over several lines accepts the findings on all its lines', () => {
    expect([3, 4, 5, 6].map((l) => coversLine(ignores, 5, l))).toEqual([false, true, true, false]);
  });

  it('a comment that accepts no line accepts nothing', () => {
    expect(coversLine(ignores, 0, 0)).toBe(false);
  });
});

/** A reusable workflow with an unused input (FP104, line 4) and a reference to an undeclared one (FP108, line 9). */
const workflow = (lines: Record<string, string> = {}) => yaml`
  on:
    workflow_call:
      inputs:
        dead: { type: string }${lines.dead ?? ''}
  jobs:
    j:
      runs-on: ubuntu-latest
      steps:
${lines.above ?? ''}        - run: echo \${{ inputs.missing }}${lines.run ?? ''}
`;

const ci = (lines: Record<string, string>, opts?: Parameters<typeof lint>[1]) =>
  lint({ [FILE]: workflow(lines) }, { config: { rules: { FP607: 'off' } }, ...opts });

describe('ignore comments in an analysis', () => {
  it('without comments, both findings are reported', () => {
    expect(codes(ci({}))).toEqual(['FP104', 'FP108']);
  });

  it('a trailing comment accepts its line’s finding: listed apart with the reason, not counted', () => {
    const r = ci({ run: ' # flowpact: ignore[FP108] the caller passes it via vars' });
    expect(codes(r)).toEqual(['FP104']);
    expect(r.ignoredByComment.map((f) => [f.code, f.loc.line, f.comment.loc.line, f.comment.reason])).toEqual(
      [['FP108', 9, 9, 'the caller passes it via vars']],
    );
    expect(r.summary).toMatchObject({ errors: 0, warnings: 1, suppressed: 0, ignoredByComment: 1 });
    expect(r.suppressed).toEqual([]);
  });

  it('names a rule by its name, several at once, and alone on the line above', () => {
    const r = ci({ above: '        # flowpact: ignore[missing-required-input, undefined-input-ref]\n' });
    expect(codes(r)).toEqual(['FP104', 'FP905']);
    expect(byCode(r, 'FP905')[0]!.message).toBe('Ignore comment for FP101 matches no finding on line 10');
    expect(r.ignoredByComment.map((f) => f.code)).toEqual(['FP108']);
  });

  it('accepts only the rules it names', () => {
    const r = ci({ dead: ' # flowpact: ignore[FP108]' });
    expect(codes(r)).toEqual(['FP104', 'FP905', 'FP108']);
  });

  it('reports an unknown rule, a malformed comment and a rule no comment can ignore (FP904)', () => {
    const r = ci({ dead: ' # flowpact: ignore[FP1O4, FP902]', run: ' # flowpact: ignore FP108' });
    expect(byCode(r, 'FP904').map((f) => [f.loc.line, f.message])).toEqual([
      [4, 'Ignore comment names an unknown rule "FP1O4" (did you mean FP104?)'],
      [
        4,
        'Ignore comment names FP902 override-unused, which runs once overrides and ignore comments are applied: no comment can ignore it',
      ],
      [9, 'Ignore comment lists no rules in brackets, as in `# flowpact: ignore[FP301]`'],
    ]);
    expect(codes(r)).toEqual(['FP104', 'FP904', 'FP904', 'FP108', 'FP904']);
  });

  it('logs a rule that is not loaded, such as a plugin’s, and does not report it', () => {
    const r = ci({ run: ' # flowpact: ignore[ACME101, FP108]' });
    expect(codes(r)).toEqual(['FP104']);
    expect(r.logs.map((l) => l.message)).toContain(
      `ignore comments name rules that are not loaded: ${FILE}:9 "ACME101"`,
    );
  });

  it('does not report a comment as unused when its rule does not run', () => {
    expect(
      codes(
        ci({ dead: ' # flowpact: ignore[FP108]' }, { config: { rules: { FP607: 'off', FP108: 'off' } } }),
      ),
    ).toEqual(['FP104']);
    expect(codes(ci({ dead: ' # flowpact: ignore[FP108]' }, { only: ['FP104', 'FP905'] }))).toEqual([
      'FP104',
    ]);
    // Contract rules only run in `check`.
    expect(codes(ci({ dead: ' # flowpact: ignore[FP801]' }))).toEqual(['FP104', 'FP108']);
  });

  it('reports FP904 and FP905 only for files in scope', () => {
    const files = {
      [FILE]: workflow({ dead: ' # flowpact: ignore[FP108, FP1O8]' }),
      [`${WF}/other.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo hi\n',
    };
    const config = { rules: { FP607: 'off' } };
    expect(codes(lint(files, { config }))).toEqual(['FP104', 'FP905', 'FP904', 'FP108']);
    expect(codes(lint(files, { config, paths: [`${WF}/other.yml`] }))).toEqual([]);
    expect(codes(lint(files, { config: { ...config, ignore: [FILE] } }))).toEqual([]);
  });

  it('does not report comments in generated files, where rules about a file’s internals stay quiet', () => {
    const text = `# DO NOT EDIT\n${workflow({ dead: ' # flowpact: ignore[FP101, FP1O1]' })}`;
    expect(codes(lint({ [FILE]: text }, { config: { rules: { FP607: 'off' } } }))).toEqual(['FP108']);
  });

  it('a finding that an override and a comment both accept is listed under the override; neither is unused', () => {
    const configText = yaml`
      overrides:
        - rule: FP108
          file: ${FILE}
          reason: The caller passes it through vars
    `;
    const { config, overrideLocs } = parseConfigText(configText, '.github/flowpact/flowpact.config.yml');
    const r = analyze({
      root: '/virtual/repo',
      fs: memoryFileSystem({ [FILE]: workflow({ run: ' # flowpact: ignore[FP108]' }) }),
      config: { ...config, rules: { FP607: 'off' } },
      overrideLocs,
      configText,
      configFile: '.github/flowpact/flowpact.config.yml',
      validateSchema: false,
      repository: 'acme/repo',
    });
    expect(codes(r)).toEqual(['FP104']);
    expect(r.suppressed.map((f) => f.code)).toEqual(['FP108']);
    expect(r.ignoredByComment).toEqual([]);
  });

  it('accepts a finding whose override expired, which FP901 still reports', () => {
    const configText = yaml`
      overrides:
        - rule: FP108
          file: ${FILE}
          reason: The caller passes it through vars
          expires: 2026-01-01
    `;
    const { config, overrideLocs } = parseConfigText(configText, '.github/flowpact/flowpact.config.yml');
    const r = analyze({
      root: '/virtual/repo',
      fs: memoryFileSystem({ [FILE]: workflow({ run: ' # flowpact: ignore[FP108]' }) }),
      config: { ...config, rules: { FP607: 'off' } },
      overrideLocs,
      configText,
      configFile: '.github/flowpact/flowpact.config.yml',
      now: new Date('2026-06-01T00:00:00Z'),
      validateSchema: false,
      repository: 'acme/repo',
    });
    expect(codes(r)).toEqual(['FP901', 'FP104']);
    expect(r.ignoredByComment.map((f) => f.code)).toEqual(['FP108']);
  });

  it('the JSON report lists them under ignoredByComment and validates', () => {
    const report = toJsonReport(ci({ run: ' # flowpact: ignore[FP108] why' }));
    expect(report.summary.ignoredByComment).toBe(1);
    expect(report.ignoredByComment?.map((f) => [f.code, f.comment.reason])).toEqual([['FP108', 'why']]);
    expect(reportSchema.safeParse(report).success).toBe(true);
  });
});

describe('addIgnoreComment', () => {
  const insert = (text: string, code: string, line: number) => {
    const at = addIgnoreComment(text, code, line);
    if (!at) return undefined;
    const lines = text.split('\n');
    const target = lines[at.line - 1]!;
    lines[at.line - 1] = target.slice(0, at.column - 1) + at.newText + target.slice(at.column - 1);
    return lines.join('\n');
  };

  it('adds a comment on its own line above the finding’s, at its indentation', () => {
    const text = `steps:\n  - uses: acme/deploy@${SHA} # v3.1.1\n`;
    expect(insert(text, 'FP301', 2)).toBe(
      `steps:\n  # flowpact: ignore[FP301]\n  - uses: acme/deploy@${SHA} # v3.1.1\n`,
    );
  });

  it('puts it above the line a scalar over several lines starts on, out of a block scalar’s text', () => {
    const text = 'steps:\n  - run: |\n      echo one\n      echo ${{ env.X }}\n';
    expect(insert(text, 'FP501', 4)).toBe(
      'steps:\n  # flowpact: ignore[FP501]\n  - run: |\n      echo one\n      echo ${{ env.X }}\n',
    );
  });

  it('adds the rule to a comment that accepts the line already', () => {
    expect(insert('a: 1 # v1 # flowpact: ignore[FP101] why\n', 'FP102', 1)).toBe(
      'a: 1 # v1 # flowpact: ignore[FP101, FP102] why\n',
    );
    expect(insert('# flowpact: ignore[FP101]\na: 1\n', 'FP102', 2)).toBe(
      '# flowpact: ignore[FP101, FP102]\na: 1\n',
    );
  });

  it('keeps CRLF line endings', () => {
    expect(insert('a:\r\n  b: 1\r\n', 'FP101', 2)).toBe('a:\r\n  # flowpact: ignore[FP101]\r\n  b: 1\r\n');
  });

  it('the result is a comment that accepts the finding', () => {
    const text = 'steps:\n  - if: ${{ a &&\n      b }}\n    run: echo\n';
    const out = insert(text, 'FP108', 3)!;
    const ignores = readIgnoreComments(FILE, out);
    expect(coversLine(ignores, ignores.comments[0]!.line, 4)).toBe(true);
  });

  it('nothing for a line the file does not have', () => {
    expect(addIgnoreComment('a: 1\n', 'FP101', 5)).toBeUndefined();
  });
});
