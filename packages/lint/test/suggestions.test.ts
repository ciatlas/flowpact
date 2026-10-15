/** The fixes findings suggest: applying one makes its finding go away, and nothing is suggested that is not certain. */
import { type Finding, reportSchema, type SuggestedEdit, toJsonReport } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { lint, yaml } from './helpers';

const WF = '.github/workflows';

/**
 * The files with a finding's first suggestion applied (edits in one file apply from the last to the first). With
 * `fill`, a value is typed into the empty `key: ` lines the suggestion adds, as a user would.
 */
function apply(files: Record<string, string>, f: Finding, fill?: string): Record<string, string> {
  const edits = (f.suggestions?.[0]?.edits ?? []).map((e) =>
    fill ? { ...e, newText: e.newText.replace(/: (?=\n|$)/g, `: ${fill}`) } : e,
  );
  const out = { ...files };
  for (const file of new Set(edits.map((e) => e.loc.file))) {
    const lines = out[file]!.split('\n');
    const offset = (line: number, column: number) =>
      lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
    const mine = edits.filter((e) => e.loc.file === file);
    mine.sort((a, b) => offset(b.loc.line, b.loc.column) - offset(a.loc.line, a.loc.column));
    let text = out[file]!;
    for (const e of mine as SuggestedEdit[])
      text =
        text.slice(0, offset(e.loc.line, e.loc.column)) +
        e.newText +
        text.slice(offset(e.loc.endLine, e.loc.endColumn));
    out[file] = text;
  }
  return out;
}

/** The only finding of `code`, its first suggestion's title, and whether applying it leaves no finding of `code`. */
function fixes(files: Record<string, string>, code: string, fill?: string) {
  const [f, ...more] = lint(files).findings.filter((x) => x.code === code);
  expect(more).toEqual([]);
  expect(f).toBeDefined();
  const fixed = apply(files, f!, fill);
  const after = lint(fixed).findings;
  return {
    title: f!.suggestions?.[0]?.title,
    edits: f!.suggestions?.[0]?.edits,
    gone: !after.some((x) => x.code === code),
    // No other error appears: the edit leaves valid YAML and well-formed calls.
    errors: after.filter((x) => x.severity === 'error' && x.code !== code).map((x) => x.code),
    files: fixed,
  };
}

const callee = yaml`
  on:
    workflow_call:
      inputs:
        config: { type: string }
      secrets:
        token: { required: false }
      outputs:
        url: { value: '\${{ jobs.build.outputs.url }}' }
  jobs:
    build:
      runs-on: ubuntu-latest
      outputs:
        url: \${{ steps.ship.outputs.url }}
      steps:
        - id: ship
          run: echo "url=x" >> "$GITHUB_OUTPUT"
`;

describe('suggestions', () => {
  it('renames an input a call passes to the one the callee declares', () => {
    const files = {
      [`${WF}/r.yml`]: callee,
      [`${WF}/ci.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/r.yml
            with:
              confg: release
      `,
    };
    expect(fixes(files, 'FP102')).toMatchObject({ title: 'Rename "confg" to "config"', gone: true });
  });

  it('keeps the quotes of a quoted key', () => {
    const files = {
      [`${WF}/r.yml`]: callee,
      [`${WF}/ci.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/r.yml
            with:
              'confg': release
      `,
    };
    const r = fixes(files, 'FP102');
    expect(r.edits?.[0]?.newText).toBe("'config'");
    expect(r.gone).toBe(true);
  });

  it('renames a secret a call passes', () => {
    const files = {
      [`${WF}/r.yml`]: callee,
      [`${WF}/ci.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/r.yml
            secrets:
              tokn: \${{ secrets.T }}
      `,
    };
    expect(fixes(files, 'FP202')).toMatchObject({ title: 'Rename "tokn" to "token"', gone: true });
  });

  it('renames a job output another job reads, and only that segment of the reference', () => {
    const files = {
      [`${WF}/ci.yml`]: yaml`
        on: push
        jobs:
          build:
            runs-on: ubuntu-latest
            outputs:
              url: \${{ steps.ship.outputs.url }}
            steps:
              - id: ship
                run: echo "url=x" >> "$GITHUB_OUTPUT"
          deploy:
            needs: build
            runs-on: ubuntu-latest
            steps:
              - run: echo "\${{ needs.build.outputs.urll }}"
      `,
    };
    const r = fixes(files, 'FP301');
    expect(r).toMatchObject({ title: 'Rename "urll" to "url"', gone: true });
    expect(r.edits?.[0]?.newText).toBe('url');
  });

  it('renames a step id and a step output a later step reads', () => {
    const job = (read: string) => ({
      [`${WF}/ci.yml`]: yaml`
        on: push
        jobs:
          build:
            runs-on: ubuntu-latest
            steps:
              - id: ship
                run: echo "url=x" >> "$GITHUB_OUTPUT"
              - run: echo "\${{ ${read} }}"
      `,
    });
    expect(fixes(job('steps.shp.outputs.url'), 'FP301')).toMatchObject({
      title: 'Rename "shp" to "ship"',
      gone: true,
    });
    expect(fixes(job('steps.ship.outputs.urll'), 'FP304')).toMatchObject({
      title: 'Rename "urll" to "url"',
      gone: true,
    });
  });

  it('renames an input a composite action reads to the one it declares', () => {
    const files = {
      [`${WF}/ci.yml`]: yaml`
        on: push
        jobs:
          build:
            runs-on: ubuntu-latest
            steps:
              - uses: actions/checkout@v4
              - uses: ./.github/actions/setup
                with:
                  version: 1
      `,
      '.github/actions/setup/action.yml': yaml`
        name: Setup
        description: d
        inputs:
          version: { description: v }
        runs:
          using: composite
          steps:
            - run: echo "\${{ inputs.verison }}"
              shell: bash
      `,
    };
    expect(fixes(files, 'FP108')).toMatchObject({ title: 'Rename "verison" to "version"', gone: true });
  });

  it('renames a dispatch input a workflow reads through github.event.inputs', () => {
    const files = {
      [`${WF}/ci.yml`]: yaml`
        on:
          workflow_dispatch:
            inputs:
              target: { type: string }
        jobs:
          build:
            runs-on: ubuntu-latest
            steps:
              - run: echo "\${{ github.event.inputs.taget }}"
      `,
    };
    expect(fixes(files, 'FP108')).toMatchObject({ title: 'Rename "taget" to "target"', gone: true });
  });

  it('suggests nothing without a likely name, or for a reference written with brackets', () => {
    const files = {
      [`${WF}/r.yml`]: callee,
      [`${WF}/ci.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/r.yml
            with:
              somethingelse: x
          other:
            needs: call
            runs-on: ubuntu-latest
            steps:
              - run: echo "\${{ needs.call.outputs['urll'] }}"
      `,
    };
    const findings = lint(files).findings.filter((f) => f.code === 'FP102' || f.code === 'FP301');
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) expect(f.suggestions).toBeUndefined();
  });

  it('are in the JSON report, which validates against its schema', () => {
    const files = {
      [`${WF}/r.yml`]: callee,
      [`${WF}/ci.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/r.yml
            with:
              confg: release
      `,
    };
    const report = toJsonReport(lint(files));
    expect(report.findings.find((f) => f.code === 'FP102')?.suggestions?.[0]?.edits).toHaveLength(1);
    expect(reportSchema.safeParse(report).success).toBe(true);
  });

  describe('to the structure of a file', () => {
    const required = yaml`
      on:
        workflow_call:
          inputs:
            config: { type: string, required: true }
            suite: { type: string }
          secrets:
            token: { required: true }
      jobs:
        t:
          runs-on: ubuntu-latest
          steps:
            - run: echo "\${{ inputs.config }} \${{ inputs.suite }} \${{ secrets.token }}"
    `;
    const caller = (job: string) => ({
      [`${WF}/r.yml`]: required,
      [`${WF}/ci.yml`]: `on: push\njobs:\n${job}`,
    });

    it('adds a required input under the with: a call has', () => {
      const files = caller(
        '  call:\n    uses: ./.github/workflows/r.yml\n    with:\n      suite: unit\n    secrets: inherit\n',
      );
      const r = fixes(files, 'FP101', 'release');
      expect(r).toMatchObject({ title: 'Add input "config" under with:', gone: true, errors: [] });
      expect(r.files[`${WF}/ci.yml`]).toContain('    with:\n      suite: unit\n      config: release\n');
    });

    it('creates the with: of a call that has none, under its uses:', () => {
      const files = caller('  call:\n    uses: ./.github/workflows/r.yml\n    secrets: inherit\n');
      const r = fixes(files, 'FP101', 'release');
      expect(r).toMatchObject({ gone: true, errors: [] });
      expect(r.files[`${WF}/ci.yml`]).toContain(
        '    uses: ./.github/workflows/r.yml\n    with:\n      config: release\n    secrets: inherit\n',
      );
    });

    it('adds a required secret after the with: of a call', () => {
      const files = caller('  call:\n    uses: ./.github/workflows/r.yml\n    with:\n      config: x\n');
      const r = fixes(files, 'FP201', '${{ secrets.TOKEN }}');
      expect(r).toMatchObject({ title: 'Add secret "token" under secrets:', gone: true, errors: [] });
      expect(r.files[`${WF}/ci.yml`]).toContain(
        '      config: x\n    secrets:\n      token: ${{ secrets.TOKEN }}\n',
      );
    });

    it("adds a required input to a step's with: in a workflow and in a composite action", () => {
      const action = yaml`
        name: Setup
        description: d
        inputs:
          version: { description: v, required: true }
        runs:
          using: composite
          steps:
            - run: echo "\${{ inputs.version }}"
              shell: bash
      `;
      const workflow = {
        '.github/actions/setup/action.yml': action,
        [`${WF}/ci.yml`]: yaml`
          on: push
          jobs:
            b:
              runs-on: ubuntu-latest
              steps:
                - uses: actions/checkout@v4
                - uses: ./.github/actions/setup
        `,
      };
      expect(fixes(workflow, 'FP101', '1')).toMatchObject({ gone: true, errors: [] });
      const composite = {
        ...workflow,
        [`${WF}/ci.yml`]: yaml`
          on: push
          jobs:
            b:
              runs-on: ubuntu-latest
              steps:
                - uses: actions/checkout@v4
                - uses: ./.github/actions/outer
        `,
        '.github/actions/outer/action.yml': yaml`
          name: Outer
          description: d
          runs:
            using: composite
            steps:
              - uses: ./.github/actions/setup
        `,
      };
      const r = fixes(composite, 'FP101', '1');
      expect(r).toMatchObject({ gone: true, errors: [] });
      expect(r.files['.github/actions/outer/action.yml']).toContain(
        '    - uses: ./.github/actions/setup\n      with:\n        version: 1',
      );
    });

    it('adds the missing key to the include entry that lacks it', () => {
      const files = {
        [`${WF}/r.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                config: { type: string, required: true }
          jobs:
            t:
              runs-on: ubuntu-latest
              steps:
                - run: echo "\${{ inputs.config }}"
        `,
        [`${WF}/ci.yml`]: yaml`
          on: push
          jobs:
            run:
              strategy:
                matrix:
                  include:
                    - name: linux
                      config: ci-linux.json
                    - name: windows
              uses: ./.github/workflows/r.yml
              with:
                config: \${{ matrix.config }}
        `,
      };
      const r = fixes(files, 'FP401', 'ci-windows.json');
      expect(r).toMatchObject({
        title: 'Add "config" to the include entry without it',
        gone: true,
        errors: [],
      });
      expect(r.files[`${WF}/ci.yml`]).toContain(
        '          - name: windows\n            config: ci-windows.json\n',
      );
    });

    it('removes an unused input of a workflow no other repository calls, and what its callers pass for it', () => {
      const files = {
        [`${WF}/_r.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                config: { type: string }
                legacy: { type: boolean }
          jobs:
            t:
              runs-on: ubuntu-latest
              steps:
                - run: echo "\${{ inputs.config }}"
        `,
        [`${WF}/ci.yml`]: yaml`
          on: push
          jobs:
            call:
              uses: ./.github/workflows/_r.yml
              with:
                config: x
                legacy: true
        `,
      };
      const r = fixes(files, 'FP104');
      expect(r).toMatchObject({
        title: 'Remove input "legacy", and what 1 caller passes for it',
        gone: true,
        errors: [],
      });
      expect(r.files[`${WF}/ci.yml`]).toContain('    with:\n      config: x\n');
      expect(r.files[`${WF}/_r.yml`]).not.toContain('legacy');
    });

    it("removes a with: whose only key goes, and an input's whole inputs: when it was the only one", () => {
      const files = {
        '.github/actions/setup/action.yml': yaml`
          name: Setup
          description: d
          inputs:
            legacy: { description: l }
          runs:
            using: composite
            steps:
              - run: echo hi
                shell: bash
        `,
        [`${WF}/ci.yml`]: yaml`
          on: push
          jobs:
            b:
              runs-on: ubuntu-latest
              steps:
                - uses: actions/checkout@v4
                - uses: ./.github/actions/setup
                  with:
                    legacy: x
        `,
      };
      const r = fixes(files, 'FP104');
      expect(r).toMatchObject({ gone: true, errors: [] });
      expect(r.files['.github/actions/setup/action.yml']).not.toContain('inputs:');
      expect(r.files[`${WF}/ci.yml`]).toContain('      - uses: ./.github/actions/setup\n');
      expect(r.files[`${WF}/ci.yml`]).not.toContain('with:');
    });

    it('suggests no structural change that is not certain', () => {
      const published = {
        [`${WF}/r.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                legacy: { type: boolean }
          jobs:
            t:
              runs-on: ubuntu-latest
              steps:
                - run: echo hi
        `,
      };
      const flow = caller(
        '  call:\n    uses: ./.github/workflows/r.yml\n    with: { suite: unit }\n    secrets: inherit\n',
      );
      const crlf = Object.fromEntries(
        Object.entries(caller('  call:\n    uses: ./.github/workflows/r.yml\n    secrets: inherit\n')).map(
          ([k, v]) => [k, v.replaceAll('\n', '\r\n')],
        ),
      );
      const dispatch = {
        [`${WF}/d.yml`]: yaml`
          on:
            workflow_dispatch:
              inputs:
                legacy: { type: string }
          jobs:
            t:
              runs-on: ubuntu-latest
              steps:
                - run: echo hi
        `,
      };
      // The step's with: comes first, on the line of its `- `: removing it would take the dash too.
      const dashed = {
        '.github/actions/setup/action.yml':
          'name: Setup\ndescription: d\ninputs:\n  legacy: { description: l }\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n',
        [`${WF}/ci.yml`]:
          'on: push\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - with:\n          legacy: x\n        uses: ./.github/actions/setup\n',
      };
      for (const [files, code] of [
        [published, 'FP104'],
        [flow, 'FP101'],
        [crlf, 'FP101'],
        [dispatch, 'FP104'],
        [dashed, 'FP104'],
      ] as const) {
        const f = lint(files).findings.find((x) => x.code === code);
        expect(f, code).toBeDefined();
        expect(f!.suggestions, code).toBeUndefined();
      }
    });
  });
});
