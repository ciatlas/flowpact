import { data, Evaluator, Lexer, Parser } from '@actions/expressions';
import { truthy } from '@actions/expressions/result';
import { describe, expect, it } from 'vitest';
import { at, byCode, codes, lint, WF, withEdits, yaml } from '../helpers';

describe('FP501 undefined-env-ref', () => {
  it('resolves env through step, job and workflow scope and earlier $GITHUB_ENV writes', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        env:
          W: 1
        jobs:
          j:
            runs-on: x
            env:
              J: 2
            steps:
              - run: echo "E=3" >> $GITHUB_ENV
              - env:
                  S: 4
                run: echo \${{ env.W }} \${{ env.J }} \${{ env.S }} \${{ env.E }} \${{ env.NOPE }}
      `,
    });
    expect(byCode(r, 'FP501').map((f) => f.message)).toEqual(['env.NOPE is not defined in this scope']);
  });

  it('points runner variables to the matching context', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ env.GITHUB_SHA }}\n',
    });
    const [f] = byCode(r, 'FP501');
    expect(f?.message).toContain('use github.sha');
    expect(f?.fix).toBe('Replace `env.GITHUB_SHA` with `github.sha`.');
  });

  it('gives up after steps that may export variables invisibly', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: some/action@v1\n      - run: echo ${{ env.FROM_ACTION }}\n',
    });
    expect(byCode(r, 'FP501')).toEqual([]);
  });
});

describe('FP502 expression-parse-error', () => {
  it('reports syntax errors at the offending token', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        "on: push\njobs:\n  j:\n    if: ${{ github.ref = 'main' }}\n    runs-on: x\n    steps: [{ run: x }]\n",
    });
    const [f] = byCode(r, 'FP502');
    expect(f?.message).toBe("Invalid expression \"github.ref = 'main'\": Unexpected symbol: '='");
    expect(at(f!)).toBe(`${WF}/w.yml:4:24`);
  });
});

describe('FP502 / FP503: an invalid expression is reported once', () => {
  const report = (files: Record<string, string>) =>
    lint(files, { schema: true })
      .findings.filter((f) => ['FP502', 'FP503', 'FP505'].includes(f.code))
      .map((f) => `${f.code} ${at(f)} ${f.message}`);

  it('reports a workflow’s invalid expressions as FP502 only, in every field', () => {
    expect(
      report({
        [`${WF}/w.yml`]: yaml`
          on: push
          env:
            A: \${{ a + b }}
          jobs:
            j:
              runs-on: \${{ contains(github.ref) }}
              name: \${{ fromJSON(1, 2) }}
              if: \${{ contains(github.event.pull_request.labels, 1, 2) }}
              env:
                B: \${{ foo(1) }}
              steps:
                - if: \${{ contains(github.event.pull_request.labels, 1, 2) }}
                  run: echo \${{ startsWith(github.ref) }} \${{ (github.ref }}
                - if: contains(github.ref, 1, 2)
                  uses: some/action@v1
                  with:
                    x: \${{ format() }}
                  env:
                    C: \${{ hashFiles() }}
                - run: echo \${{ github.ref
        `,
      }),
    ).toEqual([
      `FP502 ${WF}/w.yml:3:12 Invalid expression "a + b": Unexpected symbol: '+'`,
      `FP502 ${WF}/w.yml:6:18 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:7:15 Invalid expression "fromJSON(1, 2)": Too many parameters supplied: 'fromJSON'`,
      `FP502 ${WF}/w.yml:8:13 Invalid expression "contains(github.event.pull_request.labels, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:10:14 Invalid expression "foo(1)": Unrecognized function: 'foo'`,
      `FP502 ${WF}/w.yml:12:17 Invalid expression "contains(github.event.pull_request.labels, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:13:23 Invalid expression "startsWith(github.ref)": Too few parameters supplied: 'startsWith'`,
      `FP502 ${WF}/w.yml:13:61 Invalid expression "(github.ref": Unexpected end of expression: 'ref'`,
      `FP502 ${WF}/w.yml:14:13 Invalid expression "contains(github.ref, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:17:18 Invalid expression "format()": Too few parameters supplied: 'format'`,
      `FP502 ${WF}/w.yml:19:18 Invalid expression "hashFiles()": Too few parameters supplied: 'hashFiles'`,
      `FP502 ${WF}/w.yml:20:23 Invalid expression "github.ref": Unterminated expression: missing closing '}}'`,
    ]);
  });

  it('reports an action’s invalid expressions as FP502 only', () => {
    expect(
      report({
        '.github/actions/a/action.yml': yaml`
          name: a
          description: d
          outputs:
            o:
              value: \${{ contains(steps.s.outputs.o) }}
          runs:
            using: composite
            steps:
              - id: s
                if: \${{ contains(github.ref, 1, 2) }}
                run: echo \${{ a + b }} \${{ foo(1) }}
                shell: bash
              - uses: some/action@v1
                with:
                  x: \${{ join() }}
                env:
                  Y: \${{ (github.ref }}
        `,
      }),
    ).toEqual([
      `FP502 .github/actions/a/action.yml:5:16 Invalid expression "contains(steps.s.outputs.o)": Too few parameters supplied: 'contains'`,
      `FP502 .github/actions/a/action.yml:10:15 Invalid expression "contains(github.ref, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP502 .github/actions/a/action.yml:11:23 Invalid expression "a + b": Unexpected symbol: '+'`,
      `FP502 .github/actions/a/action.yml:11:34 Invalid expression "foo(1)": Unrecognized function: 'foo'`,
      `FP502 .github/actions/a/action.yml:15:16 Invalid expression "join()": Too few parameters supplied: 'join'`,
      `FP502 .github/actions/a/action.yml:17:24 Invalid expression "(github.ref": Unexpected end of expression: 'ref'`,
    ]);
  });

  it('reports invalid expressions in multi-line scalars once, and not those the parser misreads there', () => {
    expect(
      report({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - run: |
                    echo \${{ contains(github.ref, 1, 2) }}
                - run: >
                    echo
                    \${{ format() }}
                - run: "echo
                    \${{ contains(github.ref) }}"
                - if: '\${{ github.ref == ''refs/heads/main''
                    && github.event_name == ''push'' }}'
                  run: x
                - if: >-
                    \${{ secrets.TOKEN != '' }}
                  run: x
        `,
      }),
    ).toEqual([
      `FP502 ${WF}/w.yml:7:20 Invalid expression "contains(github.ref, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:10:15 Invalid expression "format()": Too few parameters supplied: 'format'`,
      `FP502 ${WF}/w.yml:12:15 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
      `FP505 ${WF}/w.yml:17:15 \`secrets\` is not available here — GitHub rejects the workflow ("Unrecognized named-value: 'secrets'")`,
    ]);
  });

  it('keeps schema errors that FP502 does not report, next to the expressions it does', () => {
    expect(
      report({
        [`${WF}/w.yml`]: yaml`
          on: push
          env:
            X: 1
          jobs:
            j:
              runs-on: x
              steps:
                - run: echo \${{ }} \${{ contains(github.ref, 1, 2) }}
                  env:
                    \${{ a + b }}: x
                  runz: x
            k:
              uses: ./.github/workflows/r.yml
              with:
                t: \${{ env.X }} \${{ contains(github.ref) }}
        `,
        [`${WF}/r.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                t: { type: string }
          jobs:
            r:
              runs-on: x
              steps: [{ run: x }]
        `,
      }),
    ).toEqual([
      // An empty expression, and an expression in a key, which FP502 does not check.
      `FP503 ${WF}/w.yml:8:19 An expression was expected`,
      `FP502 ${WF}/w.yml:8:30 Invalid expression "contains(github.ref, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP503 ${WF}/w.yml:10:11 Unexpected symbol: '+'`,
      `FP503 ${WF}/w.yml:11:9 Unexpected value 'runz'`,
      `FP505 ${WF}/w.yml:15:14 \`env\` is not available here — GitHub rejects the workflow ("Unrecognized named-value: 'env'")`,
      `FP502 ${WF}/w.yml:15:27 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
    ]);
  });

  it('reports an invalid expression in a boolean, number or matrix field once, without the type error that follows', () => {
    expect(
      report({
        [`${WF}/w.yml`]: yaml`
          on: push
          concurrency:
            group: g
            cancel-in-progress: \${{ contains(github.ref) }}
          jobs:
            j:
              runs-on: x
              timeout-minutes: \${{ a + b }}
              continue-on-error: \${{ fromJSON(1, 2) }}
              strategy:
                fail-fast: \${{ startsWith(github.ref) }}
                matrix:
                  n: \${{ contains(github.ref) }}
              steps:
                - run: echo
                  timeout-minutes: \${{ format() }}
        `,
      }),
    ).toEqual([
      `FP502 ${WF}/w.yml:4:27 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:8:28 Invalid expression "a + b": Unexpected symbol: '+'`,
      `FP502 ${WF}/w.yml:9:28 Invalid expression "fromJSON(1, 2)": Too many parameters supplied: 'fromJSON'`,
      `FP502 ${WF}/w.yml:11:22 Invalid expression "startsWith(github.ref)": Too few parameters supplied: 'startsWith'`,
      `FP502 ${WF}/w.yml:13:16 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:16:30 Invalid expression "format()": Too few parameters supplied: 'format'`,
    ]);
  });

  it('accepts a valid multi-line expression in a boolean field that the parser misreads', () => {
    expect(
      report({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              continue-on-error: '\${{ github.ref ==
                ''refs/heads/main'' }}'
              steps: [{ run: echo }]
        `,
      }),
    ).toEqual([]);
  });

  it('reports invalid expressions as FP503 when FP502 does not run, once each', () => {
    const files = {
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            timeout-minutes: \${{ fromJSON(1, 2) }}
            steps:
              - run: echo \${{ contains(github.ref) }}
      `,
    };
    const fp503 = (opts: Parameters<typeof lint>[1]) =>
      lint(files, { schema: true, ...opts })
        .findings.filter((f) => ['FP502', 'FP503'].includes(f.code))
        .map((f) => `${f.code} ${at(f)} ${f.message}`);
    const expected = [
      `FP503 ${WF}/w.yml:5:22 Too many parameters supplied: 'fromJSON'`,
      `FP503 ${WF}/w.yml:7:19 Too few parameters supplied: 'contains'`,
    ];
    expect(fp503({ config: { rules: { FP502: 'off' } } })).toEqual(expected);
    expect(fp503({ only: ['FP503'] })).toEqual(expected);
  });

  it('reports an invalid expression once in a file whose path contains a colon', () => {
    expect(
      report({
        [`${WF}/deploy:prod.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - run: echo \${{ contains(github.ref) }} \${{ a + b }}
        `,
      }),
    ).toEqual([
      `FP502 ${WF}/deploy:prod.yml:6:23 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
      `FP502 ${WF}/deploy:prod.yml:6:53 Invalid expression "a + b": Unexpected symbol: '+'`,
    ]);
  });
});

describe('FP505 context-not-available', () => {
  it('accepts case() in a bare job condition, as inside ${{ }}', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          a:
            if: case(github.event_name == 'push', true, false)
            runs-on: x
            steps: [{ run: x }]
          b:
            if: \${{ case(github.event_name == 'push', true, false) }}
            runs-on: x
            steps: [{ run: x }]
      `,
    });
    expect(byCode(r, 'FP505')).toEqual([]);
  });
});

describe('FP503 schema-violation / FP504 yaml-syntax-error', () => {
  it('validates against GitHub’s schema when enabled', () => {
    const r = lint(
      { [`${WF}/w.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    stepz: []\n' },
      { schema: true },
    );
    expect(byCode(r, 'FP503')[0]?.message).toBe("Unexpected value 'stepz'");
    expect(at(byCode(r, 'FP503')[0]!)).toBe(`${WF}/w.yml:5:5`);
  });

  it('validates action files', () => {
    const r = lint({ '.github/actions/a/action.yml': 'name: a\nrunz: {}\n' }, { schema: true });
    expect(byCode(r, 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`)).toEqual([
      'error .github/actions/a/action.yml:1:1 Required property is missing: runs',
      'warning .github/actions/a/action.yml:2:1 GitHub ignores this key: action metadata has no `runz` (did you mean `runs`?), so it has no effect',
    ]);
    expect(byCode(r, 'FP503')[1]?.fix).toBe('Rename it to `runs`.');
  });

  it('reports YAML errors once (no schema duplicate)', () => {
    const r = lint({ [`${WF}/w.yml`]: 'on: push\njobs: [a\n' }, { schema: true });
    expect(codes(r)).toContain('FP504');
    expect(codes(r)).not.toContain('FP503');
  });
});

describe('FP503 keys GitHub added after the parser’s schema', () => {
  const schema503 = (files: Record<string, string>) =>
    byCode(lint(files, { schema: true }), 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`);

  it('accepts background, wait, wait-all, cancel and parallel steps', () => {
    expect(
      schema503({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - id: server
                  background: true
                  run: npm start
                - id: build
                  background: true
                  uses: some/action@v1
                - wait: server
                - wait: [server, build]
                - cancel: server
                - wait-all:
                  continue-on-error: true
                - parallel:
                    - run: a
                    - uses: some/action@v1
        `,
      }),
    ).toEqual([]);
  });

  it('still rejects background steps inside a composite action', () => {
    expect(
      schema503({
        '.github/actions/a/action.yml': yaml`
          runs:
            using: composite
            steps:
              - run: npm start
                shell: bash
                background: true
        `,
      }),
    ).toEqual(["error .github/actions/a/action.yml:6:7 Unexpected value 'background'"]);
  });

  it('accepts cache-mode on the workflow, a job and a reusable-workflow call, and checks its value', () => {
    expect(
      schema503({
        [`${WF}/w.yml`]: yaml`
          on: push
          cache-mode: read
          jobs:
            a:
              runs-on: x
              cache-mode: write-only
              steps: [{ run: x }]
            b:
              uses: ./.github/workflows/r.yml
              cache-mode: none
            c:
              runs-on: x
              cache-mode: readonly
              steps: [{ run: x }]
        `,
        [`${WF}/r.yml`]:
          'on: workflow_call\njobs:\n  r:\n    runs-on: x\n    cache-mode: write\n    steps: [{ run: x }]\n',
      }),
    ).toEqual([`error ${WF}/w.yml:13:17 Unexpected value 'readonly'`]);
  });
});

describe('FP503 keys GitHub ignores', () => {
  it('warns about a composite action’s top-level env with what it costs', () => {
    const r = lint(
      {
        '.github/actions/a/action.yml': yaml`
          name: a
          description: d
          env:
            PINNED: 1.2.3
          runs:
            using: composite
            steps:
              - run: echo "\${{ env.PINNED }}"
                shell: bash
        `,
      },
      { schema: true },
    );
    const [f, ...rest] = byCode(r, 'FP503');
    expect(rest).toEqual([]);
    expect(f?.severity).toBe('warning');
    expect(at(f!)).toBe('.github/actions/a/action.yml:3:1');
    expect(f?.message).toBe(
      "GitHub ignores this key: actions have no top-level `env`, so the action's steps never see these values",
    );
    expect(f?.fix).toBe(
      'Set the variables in `env:` on the steps that read them, or declare them as inputs.',
    );
  });

  it('warns about event filters the event does not support, and suggests close names', () => {
    const r = lint(
      {
        [`${WF}/w.yml`]: yaml`
          on:
            release:
              types: [published]
              branches: [main]
            push:
              branch: main
            workflow_dispatch:
              input:
                x: { type: string }
          jobs:
            j:
              runs-on: x
              steps: [{ run: x }]
        `,
      },
      { schema: true },
    );
    expect(byCode(r, 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message} | ${f.fix}`)).toEqual([
      `warning ${WF}/w.yml:4:5 GitHub ignores this key: the \`release\` event does not support \`branches\`, so the workflow runs regardless of it | Remove it, or check the condition in a job's \`if:\` instead.`,
      `warning ${WF}/w.yml:6:5 GitHub ignores this key: the \`push\` event does not support \`branch\` (did you mean \`branches\`?), so the workflow runs regardless of it | Rename it to \`branches\`.`,
      `warning ${WF}/w.yml:8:5 GitHub ignores this key: the \`workflow_dispatch\` event does not support \`input\` (did you mean \`inputs\`?), so it has no effect | Rename it to \`inputs\`.`,
    ]);
  });

  it('keeps errors for what GitHub rejects: unknown events, activity types, workflow_call keys, job keys', () => {
    const r = lint(
      {
        [`${WF}/w.yml`]: yaml`
          on:
            pull-request:
            issues:
              types: [opend]
            workflow_call:
              input: {}
          jobs:
            j:
              runs-on: x
              stepz: []
        `,
      },
      { schema: true },
    );
    expect(byCode(r, 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`)).toEqual([
      `error ${WF}/w.yml:2:3 Unexpected value 'pull-request'`,
      `error ${WF}/w.yml:4:13 Unexpected value 'opend'`,
      `error ${WF}/w.yml:6:5 Unexpected value 'input'`,
      `error ${WF}/w.yml:10:5 Unexpected value 'stepz'`,
    ]);
  });

  it('warns that a YAML merge key under an event drops what it names, so the filters are not applied', () => {
    const r = lint(
      {
        [`${WF}/w.yml`]: yaml`
          on:
            push: &filters
              branches: [main]
            pull_request:
              <<: *filters
            pull_request_target:
              <<: *filters
              types: [opened]
            workflow_dispatch:
              <<:
                inputs:
                  x: { type: string }
          jobs:
            j:
              runs-on: x
              steps: [{ run: x }]
        `,
        '.github/actions/a/action.yml': yaml`
          name: a
          description: d
          runs:
            using: composite
            steps: []
          <<: { author: me }
        `,
      },
      { schema: true },
    );
    expect(byCode(r, 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message} | ${f.fix}`)).toEqual([
      'warning .github/actions/a/action.yml:6:1 GitHub ignores this key: YAML merge keys (`<<`) are not supported, so the keys merged here are not applied | GitHub does not support YAML merge keys (`<<`): repeat the keys at the top level.',
      `warning ${WF}/w.yml:5:5 GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so the filters in \`*filters\` are not applied to \`pull_request\` and the workflow runs regardless of them | GitHub does not support YAML merge keys (\`<<\`): repeat the keys under \`pull_request\`, or alias the whole event (\`pull_request: *filters\`) instead.`,
      `warning ${WF}/w.yml:7:5 GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so the filters in \`*filters\` are not applied to \`pull_request_target\` and the workflow runs regardless of them | GitHub does not support YAML merge keys (\`<<\`): repeat the keys under \`pull_request_target\`.`,
      `warning ${WF}/w.yml:10:5 GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so the keys merged here are not applied to \`workflow_dispatch\` | GitHub does not support YAML merge keys (\`<<\`): repeat the keys under \`workflow_dispatch\`.`,
    ]);
  });

  it('keeps a YAML merge key in a job or step an error, and says how to replace it', () => {
    const r = lint(
      {
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            a: &defaults
              runs-on: x
              steps: [{ run: x }]
            b:
              <<: *defaults
              steps: [{ run: y }]
        `,
      },
      { schema: true },
    );
    const findings = byCode(r, 'FP503');
    expect(findings.map((f) => `${f.severity} ${at(f)} ${f.message}`)).toEqual([
      `error ${WF}/w.yml:7:5 Unexpected value '<<'`,
      `error ${WF}/w.yml:7:5 Required property is missing: runs-on`,
    ]);
    expect(findings[0]?.fix).toBe('GitHub does not support YAML merge keys (`<<`): repeat the keys here.');
  });

  it('caps the warning at the configured severity and never raises it', () => {
    const files = {
      '.github/actions/a/action.yml': 'env: {}\nrunz: {}\n',
    };
    const sev = (rules: Record<string, string>) =>
      byCode(lint(files, { schema: true, config: { rules } }), 'FP503').map((f) => f.severity);
    expect(sev({})).toEqual(['error', 'warning', 'warning']);
    expect(sev({ FP503: 'error' })).toEqual(['error', 'warning', 'warning']);
    expect(sev({ FP503: 'warning' })).toEqual(['warning', 'warning', 'warning']);
    expect(sev({ FP503: 'info' })).toEqual(['info', 'info', 'info']);
    expect(sev({ FP503: 'off' })).toEqual([]);
  });
});

describe('FP503 steps and jobs that mix two shapes', () => {
  const schema503 = (files: Record<string, string>) =>
    byCode(lint(files, { schema: true }), 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`);

  it('reports one wrong key on a uses step once, at that key', () => {
    expect(
      schema503({
        '.github/actions/a/action.yml': yaml`
          runs:
            using: composite
            steps:
              - name: Install
                working-directory: \${{ inputs.dir }}
                uses: taiki-e/install-action@v2
                with:
                  tool: nextest
        `,
      }),
    ).toEqual([
      "error .github/actions/a/action.yml:5:7 Unexpected value 'working-directory' (not allowed together with `uses`)",
    ]);
  });

  it('reports a job that both runs steps and calls a workflow once', () => {
    expect(
      schema503({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              uses: ./.github/workflows/r.yml
              with:
                a: 1
        `,
        [`${WF}/r.yml`]:
          'on:\n  workflow_call:\n    inputs:\n      a: { type: number }\njobs:\n  r:\n    runs-on: x\n    steps: [{ run: x }]\n',
      }),
    ).toEqual([`error ${WF}/w.yml:4:5 Unexpected value 'runs-on' (not allowed together with \`uses\`)`]);
  });

  it('keeps the parser’s errors when it guessed the closest shape, saying which key a misplaced one conflicts with', () => {
    expect(
      schema503({
        '.github/actions/a/action.yml': yaml`
          runs:
            using: composite
            steps:
              - working-directory: x
                shell: bash
                with:
                  a: 1
        `,
      }),
    ).toEqual([
      'error .github/actions/a/action.yml:4:7 Required property is missing: run',
      "error .github/actions/a/action.yml:6:7 Unexpected value 'with' (not allowed together with `shell`)",
    ]);
  });

  it('reports each typo at its own key, without blaming a valid one', () => {
    expect(
      schema503({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            a:
              runs_on: ubuntu-latest
              steps:
                - run: echo
                  shel: bash
                  wth: x
                - uses: actions/checkout@v4
                  wth:
                    a: 1
                  evn:
                    A: 1
            b:
              runs-on: ubuntu-latest
              run-on: x
              step:
                - run: echo
            c:
              uses: ./.github/workflows/r.yml
              with: {}
              secret: inherit
              needz: [a]
        `,
        [`${WF}/r.yml`]: 'on: workflow_call\njobs:\n  r:\n    runs-on: x\n    steps: [{ run: x }]\n',
      }),
    ).toEqual([
      `error ${WF}/w.yml:4:5 Unexpected value 'runs_on'`,
      `error ${WF}/w.yml:4:5 Required property is missing: runs-on`,
      `error ${WF}/w.yml:7:9 Unexpected value 'shel'`,
      `error ${WF}/w.yml:8:9 Unexpected value 'wth'`,
      `error ${WF}/w.yml:10:9 Unexpected value 'wth'`,
      `error ${WF}/w.yml:12:9 Unexpected value 'evn'`,
      `error ${WF}/w.yml:16:5 Unexpected value 'run-on'`,
      `error ${WF}/w.yml:17:5 Unexpected value 'step'`,
      `error ${WF}/w.yml:22:5 Unexpected value 'secret'`,
      `error ${WF}/w.yml:23:5 Unexpected value 'needz'`,
    ]);
  });

  it('reports a misplaced key and a typo in a step the parser guessed wrong at their own keys', () => {
    expect(
      schema503({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - working-directory: x
                  uses: actions/checkout@v4
                  wth:
                    fetch-depth: 0
        `,
      }),
    ).toEqual([
      `error ${WF}/w.yml:6:9 Unexpected value 'working-directory' (not allowed together with \`uses\`)`,
      `error ${WF}/w.yml:8:9 Unexpected value 'wth'`,
    ]);
  });

  it('explains a misplaced key the same way whichever key comes first', () => {
    const step = (keys: string) =>
      schema503({
        [`${WF}/w.yml`]: `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - ${keys}\n`,
      }).map((f) => f.replace(/^.*?:\d+:\d+ /, ''));
    const misplaced = "Unexpected value 'working-directory' (not allowed together with `uses`)";
    expect(step('uses: a/b@v1\n        working-directory: x')).toEqual([misplaced]);
    expect(step('working-directory: x\n        uses: a/b@v1')).toEqual([misplaced]);
    // A tie (one key of each shape): the parser’s guess stands, and its error says what it conflicts with.
    expect(step('run: echo\n        uses: a/b@v1')).toEqual([
      "Unexpected value 'uses' (not allowed together with `run`)",
    ]);
  });

  it('keeps the parser’s errors when no shape fits better than another', () => {
    expect(
      schema503({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - name: nothing to run
                  bogus: 1
        `,
      }),
    ).toHaveLength(2);
  });
});

describe('FP507 redundant-empty-comparison', () => {
  const on = { config: { rules: { FP507: 'info' } } };
  const S = 'steps.s.outputs.o';
  const P = 'steps.s.outputs.p';
  /** A workflow whose second step runs `if:` the condition, written as it is after `if: `. */
  const step = (cond: string) => ({
    [`${WF}/w.yml`]: `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - id: s\n        run: echo\n      - if: ${cond}\n        run: echo\n`,
  });
  /** The condition on line 8 of `step`'s workflow. */
  const condition = (files: Record<string, string>) =>
    files[`${WF}/w.yml`]!.split('\n')[7]!.slice('      - if: '.length);
  const fp507 = (files: Record<string, string>) => byCode(lint(files, on), 'FP507');
  /** Each finding's column and message, and the condition with its suggestion applied (or `null` without one). */
  const report = (cond: string) =>
    fp507(step(cond)).map((f) => ({
      at: f.loc.column,
      message: f.message.slice(0, 8),
      fixed: f.suggestions ? condition(withEdits(step(cond), f.suggestions[0]!.edits)) : null,
    }));
  /** The condition with every finding's suggestion applied. */
  const fixedAll = (cond: string) =>
    condition(
      withEdits(
        step(cond),
        fp507(step(cond)).flatMap((f) => f.suggestions?.[0]?.edits ?? []),
      ),
    );

  it('is off by default', () => {
    expect(byCode(lint(step(`\${{ ${S} != '' }}`)), 'FP507')).toEqual([]);
  });

  it('leaves out a condition whose text a YAML alias shares with a value, in either direction', () => {
    const job = (env: string, ifs: string, envAgain = '') =>
      fp507({
        [`${WF}/w.yml`]: `on: push\njobs:\n  j:\n    runs-on: x\n    env:\n      IS_PR: ${env}\n    steps:\n      - if: ${ifs}\n        run: echo\n${envAgain}`,
      });
    expect(job(`&pr \${{ github.head_ref != '' }}`, '*pr')).toEqual([]);
    expect(
      job('x', `&pr \${{ github.head_ref != '' }}`, '      - env: { IS_PR: *pr }\n        run: echo\n'),
    ).toEqual([]);
    // An anchor nothing else reads is the condition's own text
    expect(job('x', `&pr \${{ github.head_ref != '' }}`)).toHaveLength(1);
  });

  it('offers no fix for a matrix value, which YAML can write as `.nan`', () => {
    const [f] = fp507({
      [`${WF}/w.yml`]: `on: push\njobs:\n  j:\n    runs-on: x\n    strategy:\n      matrix:\n        x: [a, .nan]\n    steps:\n      - if: \${{ matrix.x != '' }}\n        run: echo\n`,
    });
    expect(f).toBeDefined();
    expect(f!.suggestions).toBeUndefined();
  });

  it('removes `!= ` with its value first or last, and points at the operator and the empty string', () => {
    expect(report(`\${{ ${S} != '' }}`)).toEqual([{ at: 35, message: "`!= ''` ", fixed: `\${{ ${S} }}` }]);
    expect(report(`\${{ '' != ${S} }}`)).toEqual([{ at: 17, message: "`!= ''` ", fixed: `\${{ ${S} }}` }]);
    expect(report(`\${{ ${S}!='' }}`)).toEqual([{ at: 34, message: "`!= ''` ", fixed: `\${{ ${S} }}` }]);
    const [f] = fp507(step(`\${{ ${S} != '' }}`));
    expect(f).toMatchObject({
      severity: 'info',
      message: "`!= ''` is redundant in a condition, which already treats '' as false",
      loc: { line: 8, column: 35, endLine: 8, endColumn: 40 },
      suggestions: [{ title: "Remove `!= ''`" }],
    });
  });

  it('turns `== ` into a `!` before the value', () => {
    expect(report(`\${{ ${S} == '' }}`)).toEqual([{ at: 35, message: "`== ''` ", fixed: `\${{ !${S} }}` }]);
    expect(report(`\${{ ''  ==   ${S} }}`)).toEqual([
      { at: 17, message: "`== ''` ", fixed: `\${{ !${S} }}` },
    ]);
    expect(fp507(step(`\${{ ${S} == '' }}`))[0]).toMatchObject({
      message: "`== ''` is a negation in a condition, which already treats '' as false",
      suggestions: [{ title: "Replace `== ''` with `!`" }],
    });
  });

  it('removes a negated `== ` whole, rather than writing `!(!x)`', () => {
    expect(report(`\${{ !(${S} == '') }}`)[0]!.fixed).toBe(`\${{ ${S} }}`);
    expect(report(`\${{ ! ( '' == ${S} ) }}`)[0]!.fixed).toBe(`\${{ ${S} }}`);
    expect(report(`\${{ !((${S} == '')) }}`)[0]!.fixed).toBe(`\${{ ${S} }}`);
    expect(report(`\${{ !!(${S} == '') }}`)[0]!.fixed).toBe(`\${{ !${S} }}`);
    expect(fp507(step(`\${{ !(${S} == '') }}`))[0]!.suggestions![0]!.title).toBe("Remove `!(… == '')`");
    // A grouping without a `!` keeps its parentheses, and so does a negated `!=`.
    expect(report(`\${{ (${S} == '') }}`)[0]!.fixed).toBe(`\${{ (!${S}) }}`);
    expect(report(`\${{ !(${S} != '') }}`)[0]!.fixed).toBe(`\${{ !(${S}) }}`);
  });

  it('fixes every operand of `&&` and `||`, each on its own', () => {
    const cond = `${S} != '' && ${P} == '' || (${S} == '' && !(${P} == ''))`;
    expect(report(cond).map((r) => r.fixed)).toEqual([
      `${S} && ${P} == '' || (${S} == '' && !(${P} == ''))`,
      `${S} != '' && !${P} || (${S} == '' && !(${P} == ''))`,
      `${S} != '' && ${P} == '' || (!${S} && !(${P} == ''))`,
      `${S} != '' && ${P} == '' || (${S} == '' && ${P})`,
    ]);
    expect(fixedAll(cond)).toBe(`${S} && !${P} || (!${S} && ${P})`);
  });

  it('fixes comparisons of calls and indexes', () => {
    expect(fixedAll(`\${{ format('{0}', ${S}) != '' && toJSON(github.event) == '' }}`)).toBe(
      `\${{ format('{0}', ${S}) && !toJSON(github.event) }}`,
    );
    expect(fixedAll(`\${{ github.event.inputs['x'] != '' && fromJSON(${S})[0] == '' }}`)).toBe(
      `\${{ github.event.inputs['x'] && !fromJSON(${S})[0] }}`,
    );
    expect(fixedAll(`\${{ github.event.commits.*.id != '' && github.event.commits[*].id == '' }}`)).toBe(
      `\${{ github.event.commits.*.id && !github.event.commits[*].id }}`,
    );
    expect(fixedAll(`\${{ always ( ) != '' || hashFiles('a', ) == '' }}`)).toBe(
      `\${{ always ( ) || !hashFiles('a', ) }}`,
    );
  });

  it('reports a grouped value without a fix, and not one that may be NaN', () => {
    expect(report(`\${{ (${S} || ${P}) != '' }}`)).toEqual([{ at: 58, message: "`!= ''` ", fixed: null }]);
    expect(report(`\${{ (${S} || NaN) != '' }}`)).toEqual([]);
    expect(report(`\${{ (case(${S} == 'a', ${P}, 'b')) != '' }}`)).toEqual([]);
    expect(report(`\${{ (1 || ${P}) != '' }}`)).toHaveLength(1);
  });

  it('reports only a comparison with the string `` that decides the condition', () => {
    for (const cond of [
      `\${{ ${S} != null }}`,
      `\${{ ${S} != 0 }}`,
      `\${{ ${S} != false }}`,
      `\${{ ${S} != 'x' }}`,
      `\${{ ${S} > '' }}`,
      `\${{ '' != '' }}`,
      `\${{ !${S} != '' }}`,
      `\${{ case(${S} == 'a', ${P}, '') != '' }}`,
      `\${{ case(${S} != '', true, false) }}`,
      `\${{ contains(format('{0}', ${S} != ''), 'true') }}`,
      `\${{ (${S} != '') == true }}`,
      `\${{ fromJSON('[true]')[${S} != ''] }}`,
      `\${{ ${S} != '' }} and more`,
      `\${{ ${S} != '' }}\${{ ${P} }}`,
    ])
      expect(report(cond), cond).toEqual([]);
  });

  it('leaves value positions alone: env, with, outputs and continue-on-error', () => {
    const r = lint(
      {
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              outputs:
                ok: \${{ steps.s.outputs.o != '' }}
              steps:
                - id: s
                  run: echo
                - uses: some/action@v1
                  continue-on-error: \${{ steps.s.outputs.o != '' }}
                  env:
                    OK: \${{ steps.s.outputs.o != '' }}
                  with:
                    ok: \${{ steps.s.outputs.o != '' }}
        `,
      },
      on,
    );
    expect(byCode(r, 'FP507')).toEqual([]);
  });

  it('checks bare conditions, and fixes them unless a plain scalar would start with `!`', () => {
    expect(report(`${S} != '' && ${P}`)).toEqual([{ at: 31, message: "`!= ''` ", fixed: `${S} && ${P}` }]);
    expect(report(`${P} && ${S} == ''`)[0]!.fixed).toBe(`${P} && !${S}`);
    // YAML would read `!steps.s.outputs.o` as a tag.
    expect(report(`${S} == '' || ${P}`)).toEqual([{ at: 31, message: "`== ''` ", fixed: null }]);
    expect(report(`"${S} == '' || ${P}"`)[0]!.fixed).toBe(`"!${S} || ${P}"`);
    expect(report(`\${{ ${S} == '' || ${P} }}`)[0]!.fixed).toBe(`\${{ !${S} || ${P} }}`);
    // A negation removed whole leaves no `!` at the start.
    expect(report(`(!(${S} == ''))`)[0]!.fixed).toBe(`(${S})`);
    // A block scalar may start with `!`.
    const block = step(`>-\n          ${S} == ''`);
    const [f] = fp507(block);
    expect(withEdits(block, f!.suggestions![0]!.edits)[`${WF}/w.yml`]).toContain(`if: >-\n          !${S}\n`);
  });

  it('reports without a fix where the source is not written as the expression reads', () => {
    // A single-quoted scalar doubles each quote: reported at the expression.
    expect(report(`'\${{ ${S} != '''' }}'`)).toEqual([{ at: 18, message: "`!= ''` ", fixed: null }]);
    // Over several lines.
    const multi = {
      [`${WF}/w.yml`]: `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - id: s\n        run: echo\n      - if: >-\n          ${S} != ''\n          && ${P}\n        run: echo\n`,
    };
    expect(fp507(multi).map((f) => [f.loc.line, f.loc.endLine, f.suggestions])).toEqual([[9, 10, undefined]]);
    // CRLF line endings: pointed at, not fixed.
    const crlf = { [`${WF}/w.yml`]: step(`\${{ ${S} != '' }}`)[`${WF}/w.yml`]!.replaceAll('\n', '\r\n') };
    expect(fp507(crlf).map((f) => [f.loc.column, f.suggestions])).toEqual([[35, undefined]]);
  });

  it('leaves optional inputs without a default to FP105 while it runs', () => {
    const files = {
      [`${WF}/r.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              optional: { type: string, required: false }
              given: { type: string, required: false, default: x }
              required: { type: string, required: true }
              flag: { type: boolean, required: false }
          workflow_dispatch:
            inputs:
              picked: { type: string, required: false }
        jobs:
          j:
            if: inputs.optional != '' && inputs.given != '' && inputs.required != '' && inputs.flag != ''
            runs-on: x
            steps:
              - if: \${{ (inputs.optional || inputs.given) != '' && github.event.inputs.picked != '' }}
                run: echo
      `,
    };
    const messages = (r: ReturnType<typeof lint>) =>
      byCode(r, 'FP507').map((f) => `${f.loc.line}:${f.loc.column}`);
    expect(messages(lint(files, on))).toEqual(['13:47', '13:72', '13:93']);
    expect(messages(lint(files, { config: { rules: { FP507: 'info', FP105: 'off' } } }))).toEqual([
      '13:25',
      '13:47',
      '13:72',
      '13:93',
      '16:51',
      '16:87',
    ]);
  });

  it('skips generated files', () => {
    const files = step(`\${{ ${S} != '' }}`);
    const generated = {
      [`${WF}/w.yml`]: `# Code generated by a tool. DO NOT EDIT.\n${files[`${WF}/w.yml`]}`,
    };
    expect(fp507(generated)).toEqual([]);
  });
});

describe('FP507 fixes keep what the condition decides', () => {
  /** The value classes a context can hold, as GitHub's evaluator compares them (from the design's equiv.mjs). */
  const values = [
    new data.StringData(''),
    new data.StringData('0'),
    new data.StringData(' '),
    new data.StringData('false'),
    new data.StringData('x'),
    new data.Null(),
    new data.BooleanData(true),
    new data.BooleanData(false),
    new data.NumberData(0),
    new data.NumberData(1),
    new data.NumberData(-0),
    new data.Dictionary(),
    new data.Array(),
  ];
  /** The truthiness of an expression for `inputs.a` and `inputs.b`, or `throws`. */
  const decide = (source: string, a: data.ExpressionData, b: data.ExpressionData) => {
    const inputs = new data.Dictionary();
    inputs.add('a', a);
    inputs.add('b', b);
    const context = new data.Dictionary();
    context.add('inputs', inputs);
    try {
      const ast = new Parser(new Lexer(source).lex().tokens, ['inputs'], []).parse();
      return truthy(new Evaluator(ast, context).evaluate());
    } catch {
      return 'throws';
    }
  };
  const workflow = (cond: string) => ({
    [`${WF}/w.yml`]: `on:\n  workflow_call:\n    inputs:\n      a: { type: string, required: true }\n      b: { type: string, required: true }\njobs:\n  j:\n    if: \${{ ${cond} }}\n    runs-on: x\n    steps: [{ run: x }]\n`,
  });

  it.each([
    "inputs.a != ''",
    "'' != inputs.a",
    "inputs.a == ''",
    "'' == inputs.a",
    "!(inputs.a == '')",
    "!('' == inputs.a)",
    "!!(inputs.a == '')",
    "!(inputs.a != '')",
    "(inputs.a == '')",
    "inputs.a != '' && inputs.b == ''",
    "inputs.a == '' || inputs.b != ''",
    "!(inputs.a == '' || inputs.b != '') && (inputs.b == '')",
    "format('{0}', inputs.a) != '' || toJSON(inputs.b) == ''",
    "contains(inputs.a, 'x') == '' && startsWith(inputs.b, '0') != ''",
    "inputs.a != '' && inputs.a != inputs.b",
  ])('%s', (cond) => {
    const files = workflow(cond);
    const edits = byCode(lint(files, { config: { rules: { FP507: 'info' } } }), 'FP507').flatMap(
      (f) => f.suggestions![0]!.edits,
    );
    expect(edits.length).toBeGreaterThan(0);
    const fixed = /if: \$\{\{ (.*) \}\}/.exec(withEdits(files, edits)[`${WF}/w.yml`]!)![1]!;
    expect(fixed).not.toContain("''");
    for (const a of values)
      for (const b of values)
        expect(decide(fixed, a, b), `${fixed} for ${a.kind}, ${b.kind}`).toBe(decide(cond, a, b));
  });
});
