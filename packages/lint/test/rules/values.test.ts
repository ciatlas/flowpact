import type { Finding } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { at, byCode, lint, WF, withEdits, yaml } from '../helpers';

const fp506 = (files: Record<string, string>, config?: Record<string, unknown>) =>
  byCode(lint(files, config ? { config } : {}), 'FP506');
/** Each finding's severity, place and message. */
const brief = (findings: Finding[]) => findings.map((f) => `${f.severity} ${at(f)} ${f.message}`);
/** The line a finding's first suggestion edits, with the suggestion applied. */
const fixedLine = (files: Record<string, string>, f: Finding) => {
  const [edit] = f.suggestions![0]!.edits;
  return withEdits(files, f.suggestions![0]!.edits)[edit!.loc.file]!.split('\n')[edit!.loc.line - 1]!.trim();
};

/** A reusable workflow with optional, required and boolean inputs, and a job whose steps are `steps`. */
const callee = (steps: string, jobExtra = '') => ({
  [`${WF}/r.yml`]: `on:
  workflow_call:
    inputs:
      file: { type: string, required: false }
      other: { type: string, required: false }
      blank: { type: string, required: false, default: '' }
      given: { type: string, required: false, default: '[]' }
      config: { type: string, required: true }
      flag: { type: boolean, required: false }
      flag2: { type: boolean, required: false }
jobs:
  j:
    runs-on: x
${jobExtra}    steps:
${steps}
`,
});

describe('FP506 value-not-boolean: fromJSON() of a value that may be empty', () => {
  const caseA = callee(`      - env:
          CONTINUE_ON_ERROR: \${{ inputs.file }}
        continue-on-error: \${{ fromJSON(env.CONTINUE_ON_ERROR) }}
        run: ./test.sh`);

  it('reports an env value from an optional input read by fromJSON(), with a fix where it is set', () => {
    const [f] = fp506(caseA);
    expect(f).toMatchObject({
      severity: 'error',
      message:
        "`fromJSON(env.CONTINUE_ON_ERROR)` fails when optional input `file` is omitted: `env.CONTINUE_ON_ERROR` is then '', which is not JSON; other text than 'true' or 'false', such as a file name, fails here too",
      loc: { file: `${WF}/r.yml`, line: 17, column: 32, endColumn: 63 },
      symbol: `${WF}/r.yml#inputs.file`,
      related: [
        { loc: { line: 16, column: 30 }, message: 'env.CONTINUE_ON_ERROR is set here' },
        { loc: { line: 4, column: 7 }, message: "inputs.file is optional, and '' when omitted" },
      ],
      suggestions: [{ title: "Compare `inputs.file` with ''" }],
    });
    expect(fixedLine(caseA, f!)).toBe("CONTINUE_ON_ERROR: ${{ inputs.file != '' }}");
    // Fixed, it is reported no more.
    expect(fp506(withEdits(caseA, f!.suggestions![0]!.edits))).toEqual([]);
  });

  it("reports an input whose default is '', read directly, without a fix where fromJSON() gives no boolean", () => {
    const files = callee(
      '      - run: echo',
      '    strategy:\n      matrix:\n        a: ${{ fromJSON(inputs.blank) }}\n        b: ${{ fromJSON(inputs.file).x }}\n',
    );
    expect(fp506(files).map((f) => [at(f), f.suggestions])).toEqual([
      [`${WF}/r.yml:16:16`, undefined],
      [`${WF}/r.yml:17:16`, undefined],
    ]);
    // Other text may be JSON here: only a field that takes a boolean fails on it.
    expect(fp506(files)[0]!.message).toBe(
      "`fromJSON(inputs.blank)` fails when optional input `blank` is omitted: `inputs.blank` is then '', which is not JSON",
    );
  });

  it("leaves out inputs that are never '', and values flowpact cannot see", () => {
    const files = callee(`      - run: echo
        env:
          A: \${{ fromJSON(inputs.config) }}
          B: \${{ fromJSON(inputs.given) }}
          C: \${{ fromJSON(inputs.flag) }}
          D: \${{ fromJSON(inputs.file || '{}') }}
          E: \${{ fromJSON(matrix.x) }}
          F: \${{ fromJSON(github.event.inputs.x) }}
          G: \${{ fromJSON(steps.s.outputs.x) }}
          H: \${{ fromJSON(format('{0}', inputs.file)) }}`);
    expect(fp506(files)).toEqual([]);
  });

  it('asks the local callers whether an optional input can be omitted, as FP105 does', () => {
    const reusable = callee('      - run: echo\n        env:\n          A: ${{ fromJSON(inputs.file) }}')[
      `${WF}/r.yml`
    ]!;
    /** r.yml (with `trigger` too), called by main.yml with `config` and `callerWith`. */
    const files = (callerWith: string, trigger = '') => ({
      [`${WF}/r.yml`]: reusable.replace('on:\n', `on:\n${trigger}`),
      [`${WF}/main.yml`]: `on: push\njobs:\n  c:\n    uses: ./${WF}/r.yml\n    with:\n      config: x\n${callerWith}`,
    });
    const internal = { impact: { publish: [] } };
    const passing = files('      file: a.json\n');
    expect(fp506(passing, internal)).toEqual([]);
    // Omitted by a caller here, or by callers elsewhere: published, or dispatched without it
    expect(fp506(files(''), internal)).toHaveLength(1);
    expect(fp506(passing)).toHaveLength(1);
    expect(fp506(files('      file: a.json\n', '  workflow_dispatch:\n'), internal)).toHaveLength(1);
  });

  it("still reports a field that takes a boolean when every caller passes the input, unless as 'true' or 'false'", () => {
    /** r.yml's Case A, called by main.yml with `file: <file>`. */
    const files = (file: string) => ({
      ...caseA,
      [`${WF}/main.yml`]: `on: push\njobs:\n  c:\n    uses: ./${WF}/r.yml\n    with:\n      config: x\n      file: ${file}\n`,
    });
    const internal = { impact: { publish: [] } };
    const [f, ...rest] = fp506(files('x.md'), internal);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      severity: 'error',
      message:
        "`fromJSON(env.CONTINUE_ON_ERROR)` fails unless `env.CONTINUE_ON_ERROR` is 'true' or 'false', and it can be other text, such as a file name",
      loc: { file: `${WF}/r.yml`, line: 17, column: 32 },
      symbol: `${WF}/r.yml#inputs.file`,
      related: [{ loc: { line: 16, column: 30 }, message: 'env.CONTINUE_ON_ERROR is set here' }],
    });
    expect(fp506(files("'true'"), internal)).toEqual([]);
    expect(fp506(files('false'), internal)).toEqual([]);
  });

  it('takes a caller passing an expression that gives a boolean as passing a boolean', () => {
    /** r.yml's Case A, called by main.yml (dispatched with a boolean `dry` and a text `name`) with `file: <file>`. */
    const files = (file: string) => ({
      ...caseA,
      [`${WF}/main.yml`]: `on:\n  workflow_dispatch:\n    inputs:\n      dry: { type: boolean }\n      name: { type: string }\njobs:\n  c:\n    uses: ./${WF}/r.yml\n    with:\n      config: x\n      file: ${file}\n`,
    });
    const internal = { impact: { publish: [] } };
    for (const file of [
      '${{ inputs.dry }}',
      "${{ github.ref == 'refs/heads/main' }}",
      '${{ !inputs.name }}',
      "${{ startsWith(inputs.name, 'v') }}",
      '${{ true }}',
    ])
      expect(fp506(files(file), internal), file).toEqual([]);
    // Text, or a boolean or text
    expect(fp506(files('${{ inputs.name }}'), internal)).toHaveLength(1);
    expect(fp506(files('${{ inputs.dry || inputs.name }}'), internal)).toHaveLength(1);
    expect(fp506(files('${{ inputs.dry }}-x'), internal)).toHaveLength(1);
  });

  it('takes a forwarded input as a boolean only when every trigger of the caller declares it one', () => {
    /** r.yml's Case A, called by main.yml (run `on:` the given triggers) with `file: ${{ inputs.dry }}`. */
    const files = (on: string) => ({
      ...caseA,
      [`${WF}/main.yml`]: `on:\n${on}jobs:\n  c:\n    uses: ./${WF}/r.yml\n    with:\n      config: x\n      file: \${{ inputs.dry }}\n`,
    });
    const internal = { impact: { publish: [] } };
    const call = '  workflow_call:\n    inputs:\n      dry: { type: boolean }\n';
    const dispatch = (type: string) => `  workflow_dispatch:\n    inputs:\n      dry: { type: ${type} }\n`;
    expect(fp506(files(call + dispatch('boolean')), internal)).toEqual([]);
    // A dispatch that passes text, or no inputs; a push that passes none
    expect(fp506(files(call + dispatch('string')), internal)).toHaveLength(1);
    expect(fp506(files(`${call}  workflow_dispatch:\n`), internal)).toHaveLength(1);
    expect(fp506(files(`  push:\n${dispatch('boolean')}`), internal)).toHaveLength(1);
  });

  it("leaves out a read the reader's condition decides", () => {
    const files = callee(
      `      - if: inputs.file
        continue-on-error: \${{ fromJSON(inputs.file) }}
        run: echo
      - if: env.X != ''
        env:
          X: \${{ inputs.file }}
        continue-on-error: \${{ fromJSON(env.X) }}
        run: echo
      - if: false
        continue-on-error: \${{ fromJSON(inputs.file) }}
        run: echo
      - run: echo
        env:
          A: \${{ inputs.file && fromJSON(inputs.file) }}
          B: \${{ !inputs.file || fromJSON(inputs.file) }}
          C: \${{ case(inputs.file == '', 1, fromJSON(inputs.file)) }}
          D: \${{ inputs.other && fromJSON(inputs.file) }}
          E: \${{ fromJSON(inputs.file) && inputs.file }}`,
      '    if: inputs.blank\n    strategy:\n      matrix:\n        x: ${{ fromJSON(inputs.blank) }}\n',
    );
    // Only the `&&` that tests another input, and an operand evaluated after the call.
    expect(fp506(files).map((f) => f.loc.line)).toEqual([35, 36]);
  });

  it('reports a step output its `if:` can skip, unless the reader is guarded too', () => {
    const files = {
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          plan:
            runs-on: x
            outputs:
              targets: \${{ steps.list.outputs.targets }}
              always: \${{ steps.status.outputs.targets }}
            steps:
              - id: list
                if: github.event_name == 'push'
                run: echo 'targets=[]' >> "$GITHUB_OUTPUT"
              - id: status
                if: always()
                run: echo 'targets=[]' >> "$GITHUB_OUTPUT"
              - with:
                  a: \${{ fromJSON(steps.list.outputs.targets) }}
                run: echo
              - if: success()
                with:
                  b: \${{ fromJSON(steps.list.outputs.targets) }}
                run: echo
          deploy:
            needs: plan
            runs-on: x
            strategy:
              matrix:
                target: \${{ fromJSON(needs.plan.outputs.targets) }}
                always: \${{ fromJSON(needs.plan.outputs.always) }}
            steps: [{ run: echo }]
          same-event:
            needs: plan
            if: github.event_name == 'push'
            runs-on: x
            strategy:
              matrix:
                target: \${{ fromJSON(needs.plan.outputs.targets) }}
            steps: [{ run: echo }]
          same-output:
            needs: plan
            if: needs.plan.outputs.targets != '[]' && needs.plan.outputs.targets
            runs-on: x
            strategy:
              matrix:
                target: \${{ fromJSON(needs.plan.outputs.targets) }}
            steps: [{ run: echo }]
      `,
    };
    expect(brief(fp506(files))).toEqual([
      `error ${WF}/w.yml:16:18 \`fromJSON(steps.list.outputs.targets)\` fails when step \`list\` is skipped by its \`if:\`: \`steps.list.outputs.targets\` is then '', which is not JSON`,
      `error ${WF}/w.yml:27:21 \`fromJSON(needs.plan.outputs.targets)\` fails when step \`list\` is skipped by its \`if:\`: \`needs.plan.outputs.targets\` is then '', which is not JSON`,
    ]);
    expect(fp506(files)[1]!.related.map((r) => `${r.loc.line} ${r.message}`)).toEqual([
      '6 jobs.plan.outputs.targets is set here',
      "10 steps.list runs only when this holds; its outputs are '' otherwise",
    ]);
  });

  it('offers the fix only where fromJSON() must give a boolean, and the value is one reference or an `||` of them', () => {
    const files = callee(`      - env:
          ONE: \${{ inputs.file }}
          BOTH: \${{ (inputs.file || inputs.other) }}
        if: fromJSON(env.ONE) && fromJSON(env.BOTH)
        run: echo
      - run: echo \${{ fromJSON(env.ONE) }}
        env:
          ONE: \${{ inputs.file }}
      - continue-on-error: \${{ fromJSON(env.CALL) }}
        env:
          CALL: \${{ format('{0}', inputs.file) || inputs.file }}
        run: echo
      - continue-on-error: \${{ fromJSON(env.FOLDED) }}
        env:
          FOLDED: >-
            \${{ inputs.file }}
        run: echo
      - continue-on-error: \${{ fromJSON(env.MULTI) }}
        env:
          MULTI: >-
            \${{ inputs.file
            }}
        run: echo
      - continue-on-error: \${{ fromJSON(env.ONE).ok }}
        env:
          ONE: \${{ inputs.file }}
        run: echo`);
    const fixes = fp506(files).map((f) => [f.loc.line, f.suggestions ? fixedLine(files, f) : null]);
    expect(fixes).toEqual([
      [18, "ONE: ${{ inputs.file != '' }}"],
      [18, "BOTH: ${{ (inputs.file != '' || inputs.other != '') }}"],
      [20, null],
      [23, null],
      [27, "${{ inputs.file != '' }}"],
      // A folded scalar over two lines: the edit is on the line that holds the reference.
      [32, "${{ inputs.file != ''"],
      [38, null],
    ]);
  });

  it('offers no fix in a file with CRLF line endings, or where the value is not written as it reads', () => {
    const crlf = { [`${WF}/r.yml`]: caseA[`${WF}/r.yml`]!.replaceAll('\n', '\r\n') };
    expect(fp506(crlf).map((f) => [f.severity, f.suggestions])).toEqual([['error', undefined]]);
    // A single-quoted scalar would read the `''` written into it as one quote: no fix there.
    const quoted = callee(`      - env:
          X: '\${{ inputs.file }}'
        continue-on-error: \${{ fromJSON(env.X) }}
        run: echo
      - env:
          Y: "\${{ inputs.file }}"
        continue-on-error: \${{ fromJSON(env.Y) }}
        run: echo
      - env:
          Z: '\${{ inputs.file != ''x'' && inputs.flag || inputs.file }}'
        continue-on-error: \${{ fromJSON(env.Z) }}
        run: echo`);
    expect(fp506(quoted).map((f) => [f.loc.line, f.suggestions ? fixedLine(quoted, f) : null])).toEqual([
      [17, null],
      [21, `Y: "\${{ inputs.file != '' }}"`],
      [24, null],
      [25, null],
    ]);
  });

  it("offers the fix for a `with:` to a boolean input, only where the value is set in the caller's own workflow", () => {
    const files = {
      [`${WF}/r.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              file: { type: string, required: false }
            outputs:
              file:
                value: \${{ jobs.j.outputs.file }}
        jobs:
          j:
            runs-on: x
            outputs:
              file: \${{ inputs.file }}
            steps: [{ run: echo }]
      `,
      [`${WF}/w.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              name: { type: string, required: false }
        jobs:
          call:
            uses: ./.github/workflows/r.yml
          prep:
            runs-on: x
            outputs:
              name: \${{ inputs.name }}
            steps: [{ run: echo }]
          next:
            needs: [call, prep]
            uses: ./.github/workflows/b.yml
            with:
              flag: \${{ fromJSON(needs.call.outputs.file) }}
              other: \${{ fromJSON(needs.prep.outputs.name) }}
              text: \${{ fromJSON(needs.prep.outputs.name) }}
      `,
      [`${WF}/b.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              flag: { type: boolean }
              other: { type: boolean }
              text: { type: string }
        jobs:
          j: { runs-on: x, steps: [{ run: echo }] }
      `,
    };
    const found = fp506(files);
    expect(found.map((f) => [f.loc.line, f.suggestions ? fixedLine(files, f) : null])).toEqual([
      [17, null],
      [18, "name: ${{ inputs.name != '' }}"],
      [19, null],
    ]);
    expect(found[0]!.related.map((r) => `${r.loc.file}:${r.loc.line} ${r.message}`)).toEqual([
      `${WF}/r.yml:7 outputs.file is set here`,
      `${WF}/r.yml:4 inputs.file is optional, and '' when omitted`,
    ]);
  });
});

describe('FP506 value-not-boolean: an `||` that gives a boolean or text', () => {
  const caseB = {
    ...callee(
      `      - id: changed
        run: echo "any=true" >> "$GITHUB_OUTPUT"
      - uses: ./.github/actions/a
        with:
          on: \${{ github.ref == 'refs/heads/main' || inputs.file }}
      - env:
          IS_FILE: \${{ inputs.flag || inputs.file }}
        if: env.IS_FILE == 'true'
        run: '[ "$IS_FILE" = true ]'`,
      `    outputs:\n      is-file: \${{ steps.changed.outputs.any == 'true' || inputs.file }}\n`,
    ),
    '.github/actions/a/action.yml': yaml`
      name: a
      inputs:
        on: { description: x, required: true }
      runs:
        using: composite
        steps: [{ run: echo, shell: bash, if: fromJSON(inputs.on) }]
    `,
  };
  caseB[`${WF}/r.yml`] = caseB[`${WF}/r.yml`]!.replace(
    'jobs:',
    '    outputs:\n      is-file:\n        value: ${{ jobs.j.outputs.is-file }}\njobs:',
  );

  it('reports the text operand, with the reads and a fix that compares it', () => {
    const found = fp506(caseB).filter((f) => f.loc.file === `${WF}/r.yml`);
    expect(brief(found)).toEqual([
      `warning ${WF}/r.yml:18:59 \`jobs.j.outputs.is-file\` is a boolean or the text of \`inputs.file\`: \`||\` gives the first operand that is true as it is, not true or false`,
      `warning ${WF}/r.yml:24:54 \`with.on\` is a boolean or the text of \`inputs.file\`: \`||\` gives the first operand that is true as it is, not true or false`,
      `warning ${WF}/r.yml:26:39 \`env.IS_FILE\` is a boolean or the text of \`inputs.file\`: \`||\` gives the first operand that is true as it is, not true or false`,
      `warning ${WF}/r.yml:27:13 \`env.IS_FILE\` is compared with \`'true'\`, but it can hold other text, and the comparison is then false: it is 'true' | text of \`inputs.file\` | '' (\`inputs.file\` omitted)`,
    ]);
    expect(found.map((f) => f.related.map((r) => `${r.loc.file}:${r.loc.line} ${r.message}`))).toEqual([
      [`${WF}/r.yml:13 published as outputs.is-file`],
      ['.github/actions/a/action.yml:6 read here'],
      [`${WF}/r.yml:27 read here`],
      [`${WF}/r.yml:26 env.IS_FILE is set here, to 'true', 'false' or other text`],
    ]);
    expect(found.slice(0, 3).map((f) => fixedLine(caseB, f))).toEqual([
      "is-file: ${{ steps.changed.outputs.any == 'true' || inputs.file != '' }}",
      "on: ${{ github.ref == 'refs/heads/main' || inputs.file != '' }}",
      "IS_FILE: ${{ inputs.flag || inputs.file != '' }}",
    ]);
    expect(found[3]!.suggestions).toBeUndefined();
  });

  it("reports a caller comparing the published output with 'true' or 'false'", () => {
    const files = {
      ...caseB,
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/r.yml
            with:
              config: x
          a:
            needs: call
            if: needs.call.outputs.is-file == 'true'
            runs-on: x
            steps:
              - if: "'FALSE' != needs.call.outputs.is-file"
                run: echo
      `,
    };
    expect(
      fp506(files)
        .filter((f) => f.loc.file === `${WF}/w.yml`)
        .map((f) => [at(f), f.message.split(',')[0]]),
    ).toEqual([
      [`${WF}/w.yml:9:9`, "`needs.call.outputs.is-file` is compared with `'true'`"],
      [`${WF}/w.yml:12:14`, "`needs.call.outputs.is-file` is compared with `'FALSE'`"],
    ]);
  });

  it('leaves out booleans only, text only, an `&&` alone, values known at run time, and conditions', () => {
    const files = callee(
      `      - id: s
        run: echo
      - run: echo
        env:
          TERNARY: \${{ inputs.flag && 'yes' || 'no' }}
          AND: \${{ contains(inputs.config, 'x') && inputs.file }}
          BOOLEANS: \${{ inputs.flag || inputs.flag2 }}
          COMPARED: \${{ inputs.file != '' || inputs.flag }}
          UNKNOWN: \${{ steps.s.outputs.x || inputs.file }}
          FALLBACK: \${{ inputs.file || 'none' }}
          TEMPLATE: x-\${{ inputs.flag || inputs.file }}
        with:
          a: \${{ env.TERNARY == 'yes' }}
          b: \${{ env.BOOLEANS == 'true' }}
          c: \${{ env.FALLBACK == 'true' }}
          d: \${{ inputs.file == 'true' }}
          e: \${{ steps.s.outputs.x == 'true' }}
      - if: inputs.flag || inputs.file
        run: echo`,
    );
    expect(brief(fp506(files))).toEqual([]);
  });

  it("counts the text 'true' or 'false' of a dispatch input as a boolean", () => {
    const files = {
      [`${WF}/w.yml`]: yaml`
        on:
          workflow_dispatch:
            inputs:
              dry-run: { type: boolean }
              name: { type: string, required: true }
        jobs:
          j:
            runs-on: x
            env:
              DRY: \${{ github.event.inputs.dry-run || inputs.name }}
              FIXED: \${{ github.event.inputs.dry-run || format('{0}', inputs.name) }}
            steps: [{ run: echo }]
      `,
    };
    expect(fp506(files).map((f) => [at(f), f.suggestions?.[0]?.title])).toEqual([
      [`${WF}/w.yml:10:47`, "Compare `inputs.name` with ''"],
      [`${WF}/w.yml:11:49`, undefined],
    ]);
  });
});

describe('FP506 severities', () => {
  const files = callee(`      - env:
          A: \${{ inputs.file }}
          B: \${{ inputs.flag || inputs.file }}
        continue-on-error: \${{ fromJSON(env.A) }}
        run: echo`);

  it('reports fromJSON() as an error and the rest as warnings, below the configured severity', () => {
    expect(fp506(files).map((f) => f.severity)).toEqual(['warning', 'error']);
    expect(fp506(files, { rules: { FP506: 'warning' } }).map((f) => f.severity)).toEqual([
      'warning',
      'warning',
    ]);
    expect(fp506(files, { rules: { FP506: 'info' } }).map((f) => f.severity)).toEqual(['info', 'info']);
    expect(fp506(files, { rules: { FP506: 'off' } })).toEqual([]);
  });
});
