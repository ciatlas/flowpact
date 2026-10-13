/**
 * Whole and computed reads (`toJSON(inputs)`, `inputs[x]`, `toJSON(matrix)`, `secrets[x]`, `toJSON(env)`) read every
 * member of the object (`Usage.whole`). They name none of them, so the rules about how one input is read in a
 * condition (FP105, FP401) must not take them for a read of that input: these probes give the findings they gave
 * before the graph read whole objects, no more and no fewer.
 */
import { describe, expect, it } from 'vitest';
import { at, byCode, lint, WF, yaml } from './helpers';

const lines = (r: ReturnType<typeof lint>) =>
  r.findings.map((f) => `${f.code} ${f.severity} ${at(f)} ${f.message}`);

describe('whole reads in conditions (FP105, FP401)', () => {
  it('adds no findings for whole and computed reads of inputs, matrix, secrets and env in conditions', () => {
    const r = lint(
      {
        '.github/actions/act/action.yml': yaml`
        name: act
        description: d
        inputs:
          v: { description: v, required: false }
          w: { description: w, required: false }
          u: { description: u, required: false }
        runs:
          using: composite
          steps:
            - if: toJSON(inputs) && inputs[inputs.v]
              shell: bash
              run: echo '\${{ toJSON(env) }}'
              env:
                E: \${{ inputs.u }}
      `,
        [`${WF}/callee.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              flag: { type: string, required: false }
              config: { type: string, required: false }
              dflt: { type: string, required: false, default: 'x' }
              req: { type: string, required: true }
            secrets:
              S1: {}
              S2: { required: false }
            outputs:
              o:
                value: \${{ jobs.a.outputs.o }}
          workflow_dispatch:
            inputs:
              flag: { type: string, required: false }
              d2: { type: boolean }
        env:
          W: x
        jobs:
          a:
            if: \${{ inputs[github.event_name] && github.event.inputs[github.actor] }}
            runs-on: ubuntu-latest
            outputs:
              o: \${{ toJSON(inputs) }}
            env:
              J: \${{ toJSON(secrets) }}
            strategy:
              matrix:
                os: [linux]
                include:
                  - os: linux
                    extra: y
            steps:
              - if: toJSON(inputs) != '{}' && toJSON(matrix) && toJSON(env) && toJSON(secrets) && secrets[inputs.flag] && matrix[inputs.flag] && env[inputs.flag]
                run: echo '\${{ toJSON(inputs) }}'
              - uses: ./.github/actions/act
                with:
                  v: \${{ toJSON(inputs) }}
                  w: \${{ inputs[matrix.os] }}
          b:
            uses: ./.github/workflows/sub.yml
            with:
              need: \${{ toJSON(inputs) }}
              opt: \${{ inputs[matrix.os] }}
      `,
        [`${WF}/caller.yml`]: yaml`
        on: push
        permissions: {}
        jobs:
          m:
            strategy:
              matrix:
                include:
                  - name: linux
                    config: a.json
                    flag: f
                  - name: windows
            uses: ./.github/workflows/callee.yml
            secrets:
              S1: \${{ secrets.X }}
            with:
              config: \${{ matrix.config }}
              flag: \${{ matrix.flag }}
              dflt: \${{ matrix.config }}
              req: \${{ matrix.config }}
      `,
        [`${WF}/sub.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              need: { type: string, required: true }
              opt: { type: string, required: false }
        jobs:
          s:
            if: inputs.need && inputs.opt
            runs-on: x
            steps:
              - run: echo
      `,
      },
      { schema: true },
    );
    expect(lines(r)).toEqual([
      "FP505 error .github/workflows/callee.yml:35:79 `secrets` is not available in a step's `if:` — GitHub rejects the workflow (\"Unrecognized named-value: 'secrets'\")",
      "FP505 error .github/workflows/callee.yml:35:91 `secrets` is not available in a step's `if:` — GitHub rejects the workflow (\"Unrecognized named-value: 'secrets'\")",
      `FP105 warning .github/workflows/callee.yml:35:99 Condition reads optional input "flag", which has no default and is '' when omitted`,
      `FP105 warning .github/workflows/callee.yml:35:122 Condition reads optional input "flag", which has no default and is '' when omitted`,
      `FP105 warning .github/workflows/callee.yml:35:142 Condition reads optional input "flag", which has no default and is '' when omitted`,
      'FP404 error .github/workflows/callee.yml:45:23 jobs.b has no matrix, so matrix.os is always empty',
      'FP401 error .github/workflows/caller.yml:17:17 Input "flag" for .github/workflows/callee.yml is empty in 1 of 2 matrix combinations — matrix.flag is not defined there',
      `FP401 warning .github/workflows/caller.yml:18:17 Input "dflt" for .github/workflows/callee.yml is empty in 1 of 2 matrix combinations — matrix.config is not defined there, which replaces the input's default "x"`,
      'FP401 error .github/workflows/caller.yml:19:16 Input "req" for .github/workflows/callee.yml is empty in 1 of 2 matrix combinations — matrix.config is not defined there',
      `FP105 warning .github/workflows/sub.yml:8:24 Condition reads optional input "opt", which has no default and is '' when omitted`,
    ]);
  });

  it('still reports a named read when the same condition compares a whole read', () => {
    const r = lint(
      {
        [`${WF}/callee.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              flag: { type: string, required: false }
        jobs:
          a:
            runs-on: ubuntu-latest
            steps:
              - if: toJSON(inputs) != '{}' && inputs.flag
                run: echo hi
      `,
      },
      { schema: true },
    );
    expect(lines(r)).toEqual([
      'FP607 info .github/workflows/callee.yml:2:3 .github/workflows/callee.yml is only triggered by workflow_call and has no callers in this repository',
      `FP105 warning .github/workflows/callee.yml:9:39 Condition reads optional input "flag", which has no default and is '' when omitted`,
    ]);
  });

  it('does not take a computed key or a whole read in a condition for a read of each input', () => {
    const r = lint(
      {
        [`${WF}/callee.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              flag: { type: string, required: false }
              config: { type: string, required: false }
        jobs:
          a:
            if: \${{ inputs[github.event_name] }}
            runs-on: ubuntu-latest
            steps:
              - run: echo hi
          b:
            runs-on: ubuntu-latest
            steps:
              - if: toJSON(inputs) != '{}'
                run: echo '\${{ toJSON(inputs) }}'
      `,
        [`${WF}/caller.yml`]: yaml`
        on: push
        permissions: {}
        jobs:
          m:
            strategy:
              matrix:
                include:
                  - name: linux
                    config: a.json
                  - name: windows
            uses: ./.github/workflows/callee.yml
            with:
              config: \${{ matrix.config }}
      `,
      },
      { schema: true },
    );
    expect(lines(r)).toEqual([]);
  });
});

describe('whole reads are reads (FP104, FP106, FP203)', () => {
  it('counts a `.*` filter as a read of every input and secret', () => {
    // `inputs.*` names no member, yet is not a computed key: such units used to be reported as never reading them.
    const r = lint(
      {
        [`${WF}/callee.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                a: { type: string, required: false }
                b: { type: string, required: false }
              secrets:
                S1: { required: false }
            workflow_dispatch:
              inputs:
                d: { type: string, required: false }
          jobs:
            j:
              runs-on: ubuntu-latest
              steps:
                - uses: ./.github/actions/act
                - run: echo '\${{ toJSON(inputs.*) }} \${{ toJSON(secrets.*) }} \${{ toJSON(github.event.inputs.*) }}'
        `,
        [`${WF}/caller.yml`]: yaml`
          on: push
          permissions: {}
          jobs:
            c:
              uses: ./.github/workflows/callee.yml
              with:
                a: x
                b: y
              secrets:
                S1: \${{ secrets.X }}
        `,
        '.github/actions/act/action.yml': yaml`
          name: act
          description: d
          inputs:
            i: { description: i, required: false }
          runs:
            using: composite
            steps:
              - shell: bash
                run: echo '\${{ toJSON(inputs.*) }}'
        `,
      },
      { schema: true },
    );
    for (const code of ['FP104', 'FP106', 'FP203']) expect(byCode(r, code)).toEqual([]);
  });
});

describe('github.event.inputs in a called workflow (FP106)', () => {
  // GitHub gives a called workflow its caller's `github` context, so `github.event.inputs` there is the caller's event:
  // a callee that reads an input only that way drops the value the call passes, named or as a whole.
  const callee = (reads: string) => yaml`
    on:
      workflow_call:
        inputs:
          target: { type: string, required: false }
      workflow_dispatch:
        inputs:
          target: { type: string, required: false }
    jobs:
      j:
        runs-on: x
        steps:
          - run: echo "${reads}"
  `;
  const caller = yaml`
    on: push
    jobs:
      c:
        uses: ./.github/workflows/callee.yml
        with:
          target: prod
  `;
  const fp106 = (reads: string) =>
    byCode(lint({ [`${WF}/callee.yml`]: callee(reads), [`${WF}/caller.yml`]: caller }), 'FP106').map(
      (f) => f.message,
    );

  it('reports a value the callee reads only through github.event.inputs', () => {
    const only = `jobs.c passes "target" to ${WF}/callee.yml, which reads it only through github.event.inputs, the caller’s event when it is called`;
    expect(fp106('${{ github.event.inputs.target }}')).toEqual([only]);
    expect(fp106('${{ github.event.inputs.* }}')).toEqual([only]);
  });

  it('does not report a value the callee also reads through inputs', () => {
    expect(fp106('${{ github.event.inputs.target }} ${{ inputs.target }}')).toEqual([]);
    expect(fp106('${{ inputs.target }}')).toEqual([]);
  });
});
