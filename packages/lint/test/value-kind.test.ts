/** What an expression can yield, followed through inputs, env and outputs to where each value is set. */
import type { ExprSite, UnitDecl } from '@ciatlas/core';
import { describe, expect, it } from 'vitest';
import { describeKind, kindOf, producersOf, readsReason, type ValueKind } from '../src/value-kind';
import { lint, WF, yaml } from './helpers';

/** A workflow's analysis and the sites of its first job's last step, by their key (or field). */
function analyzed(files: Record<string, string>, path = `${WF}/w.yml`) {
  const { index } = lint(files);
  const unit = index.unit(path)!;
  const site = (key: string) => unit.sites.find((s) => (s.key ?? s.field) === key)!;
  return { index, unit, site };
}

/** The classes of a site's whole expression, with the reasons and references they carry. */
function classes(index: ReturnType<typeof lint>['index'], unit: UnitDecl, site: ExprSite): string[] {
  const seg = site.segments[0]!;
  return show(kindOf(index, unit, site, seg, seg.expr.ast!));
}

const show = (kind: ValueKind) =>
  kind.map((p) => [p.cls, p.why && `${p.why.kind}:${p.why.label}`, p.from].filter(Boolean).join(' '));

/** The classes of each `env:` value of one step, which reads them as they are written. */
function kinds(values: Record<string, string>, extra = ''): Record<string, string[]> {
  const env = Object.entries(values)
    .map(([k, v]) => `          ${k}: \${{ ${v} }}`)
    .join('\n');
  const files = {
    [`${WF}/w.yml`]: `on:
  workflow_call:
    inputs:
      text: { type: string, required: false }
      given: { type: string, required: false, default: x }
      blank: { type: string, required: false, default: '' }
      needed: { type: string, required: true }
      flag: { type: boolean, required: false }
      count: { type: number, required: false }
      yes-no: { type: choice, required: true, options: ['true', 'false'] }
  workflow_dispatch:
    inputs:
      picked: { type: boolean, required: false }
      named: { type: string, required: false }
${extra}jobs:
  j:
    runs-on: x
    steps:
      - run: echo
        env:
${env}
`,
  };
  const { index, unit, site } = analyzed(files);
  return Object.fromEntries(Object.keys(values).map((k) => [k, classes(index, unit, site(k))]));
}

describe('kindOf: literals, operators and functions', () => {
  it('reads literals by their kind, and strings by their text', () => {
    expect(
      kinds({ a: "'x'", b: "''", c: 'null', d: 'true', e: 'false', f: '1', g: "'TRUE'", h: "'false'" }),
    ).toEqual({
      a: ['text'],
      b: ['empty'],
      c: ['empty'],
      d: ['true'],
      e: ['false'],
      f: ['number'],
      g: ['text-true'],
      h: ['text-false'],
    });
  });

  it('gives booleans for `!`, comparisons and tests, text for format(), join(), toJSON() and hashFiles()', () => {
    expect(
      kinds({
        a: '!inputs.text',
        b: "inputs.text == 'x'",
        c: "contains(inputs.text, 'x')",
        d: 'success()',
        e: "format('{0}', inputs.text)",
        f: "join(fromJSON('[]'))",
        g: 'toJSON(inputs)',
        h: "hashFiles('x')",
        i: 'unknownFunction()',
      }),
    ).toEqual({
      a: ['true', 'false'],
      b: ['true', 'false'],
      c: ['true', 'false'],
      d: ['true', 'false'],
      e: ['text', 'empty'],
      f: ['text', 'empty'],
      g: ['text'],
      h: ['text', 'empty'],
      i: ['unknown'],
    });
  });

  it("parses fromJSON(): a literal's JSON, 'true' and 'false' as booleans, nothing for ''", () => {
    expect(
      kinds({
        a: "fromJSON('true')",
        b: "fromJSON('{}')",
        c: 'fromJSON(\'"x"\')',
        d: "fromJSON('not json')",
        e: 'fromJSON(inputs.yes-no)',
        f: 'fromJSON(inputs.count)',
        g: 'fromJSON(inputs.needed)',
        h: "fromJSON('')",
        i: 'fromJSON(inputs.text)',
        j: "fromJSON('null')",
      }),
    ).toEqual({
      a: ['true'],
      b: ['json'],
      c: ['text'],
      d: [],
      e: ['true', 'false'],
      f: ['number'],
      g: ['unknown'],
      h: [],
      i: ['unknown'],
      j: ['empty'],
    });
  });

  it('gives what `||` and `&&` can return: an operand as it is', () => {
    expect(
      kinds({
        or: "inputs.needed == 'x' || inputs.needed",
        and: "contains(inputs.needed, 'x') && inputs.needed",
        ternary: "inputs.flag && 'yes' || 'no'",
        fallback: "inputs.text || 'none'",
        booleans: 'inputs.flag || inputs.flag',
        grouped: "(inputs.text || '') && 1",
      }),
    ).toEqual({
      or: ['true', 'text inputs.needed'],
      and: ['false', 'text inputs.needed'],
      ternary: ['text'],
      fallback: ['text inputs.text', 'text'],
      booleans: ['true', 'false'],
      // The optional input's '' is replaced by the fallback's.
      grouped: ['empty', 'number'],
    });
  });

  it('gives the values of case()', () => {
    expect(kinds({ a: "case(inputs.flag, 'x', inputs.count == 1, true, inputs.needed)" })).toEqual({
      a: ['text', 'true', 'text inputs.needed'],
    });
  });
});

describe('kindOf: inputs', () => {
  it('reads an input by its type, and its omitted value', () => {
    expect(
      kinds({
        text: 'inputs.text',
        given: 'inputs.given',
        blank: 'inputs.blank',
        needed: 'inputs.needed',
        flag: 'inputs.flag',
        count: 'inputs.count',
        yesNo: 'inputs.yes-no',
        picked: 'inputs.picked',
      }),
    ).toEqual({
      text: ['text inputs.text', 'empty optional-input:inputs.text'],
      given: ['text inputs.given'],
      blank: ['text inputs.blank', 'empty optional-input:inputs.blank'],
      needed: ['text inputs.needed'],
      flag: ['true', 'false'],
      count: ['number'],
      yesNo: ['text-true', 'text-false'],
      picked: ['true', 'false'],
    });
  });

  it('reads `github.event.inputs` of a dispatch input as text', () => {
    expect(
      kinds({
        picked: 'github.event.inputs.picked',
        named: 'github.event.inputs.named',
        other: 'github.event.inputs.text',
        deeper: 'inputs.needed.x',
        event: 'github.event_name',
      }),
    ).toEqual({
      picked: ['text-true', 'text-false'],
      named: ['text github.event.inputs.named', 'empty optional-input:inputs.named'],
      other: ['unknown'],
      deeper: ['unknown'],
      event: ['unknown'],
    });
  });

  it("reads an action's inputs as text", () => {
    const { index } = lint({
      '.github/actions/a/action.yml': yaml`
        name: a
        inputs:
          optional: { description: x }
          given: { description: x, default: 'false' }
        runs:
          using: composite
          steps:
            - run: echo
              shell: bash
              env:
                OPTIONAL: \${{ inputs.optional }}
                GIVEN: \${{ inputs.given }}
      `,
    });
    const unit = index.unit('.github/actions/a')!;
    const site = (key: string) => unit.sites.find((s) => s.key === key)!;
    expect(classes(index, unit, site('OPTIONAL'))).toEqual([
      'text inputs.optional',
      'empty optional-input:inputs.optional',
    ]);
    expect(classes(index, unit, site('GIVEN'))).toEqual(['text inputs.given']);
  });

  it("reads vars and secrets as text or '', and other contexts as unknown", () => {
    expect(kinds({ a: 'vars.X', b: 'secrets.Y', c: 'matrix.os', d: 'steps.none.outputs.x' })).toEqual({
      a: ['text vars.X', 'empty'],
      b: ['text secrets.Y', 'empty'],
      c: ['unknown'],
      d: ['unknown'],
    });
  });
});

describe('kindOf: env', () => {
  const files = {
    [`${WF}/w.yml`]: yaml`
      on:
        workflow_call:
          inputs:
            file: { type: string, required: false }
            flag: { type: boolean, required: false }
      env:
        TOP: \${{ inputs.flag }}
        PLAIN: 'true'
      jobs:
        j:
          runs-on: x
          env:
            JOB: \${{ inputs.file }}
            CYCLE_A: \${{ env.CYCLE_B }}
            CYCLE_B: \${{ env.CYCLE_A }}
          steps:
            - env:
                OWN: \${{ inputs.flag && 'x' }}
                OUTER: \${{ env.JOB }}
                JOB: shadowed
              run: echo
              with:
                own: \${{ env.OWN }}
                job: \${{ env.JOB }}
                top: \${{ env.TOP }}
                plain: \${{ env.PLAIN }}
                outer: \${{ env.OUTER }}
                cycle: \${{ env.CYCLE_A }}
            - run: echo "TOP=1" >> "$GITHUB_ENV"
            - with:
                top: \${{ env.TOP }}
              run: echo
    `,
  };
  const { index, unit } = analyzed(files);
  const withOf = (step: number, key: string) =>
    classes(
      index,
      unit,
      unit.sites.find((s) => s.field === 'step.with' && s.step === step && s.key === key)!,
    );

  it("follows a step's own env, then the job's and the workflow's, passed on as text", () => {
    expect(withOf(0, 'own')).toEqual(['text-false', 'text']);
    expect(withOf(0, 'job')).toEqual(['text']);
    expect(withOf(0, 'top')).toEqual(['text-true', 'text-false']);
    expect(withOf(0, 'plain')).toEqual(['text-true']);
    // A step's own env value reads the outer env: the job's JOB, not the step's.
    expect(withOf(0, 'outer')).toEqual(['text inputs.file', 'empty optional-input:inputs.file']);
  });

  it('gives unknown for a cycle, and after a step that may write $GITHUB_ENV', () => {
    expect(withOf(0, 'cycle')).toEqual(['unknown']);
    expect(withOf(2, 'top')).toEqual(['unknown']);
  });
});

describe('kindOf: outputs', () => {
  const files = {
    [`${WF}/callee.yml`]: yaml`
      on:
        workflow_call:
          inputs:
            file: { type: string, required: false }
          outputs:
            found:
              value: \${{ jobs.scan.outputs.found }}
            listed:
              value: \${{ jobs.scan.outputs.listed }}
      jobs:
        scan:
          runs-on: x
          outputs:
            found: \${{ steps.check.outputs.ok == 'true' || inputs.file }}
            listed: \${{ steps.list.outputs.items }}
            local: \${{ steps.act.outputs.out }}
            always: \${{ steps.status.outputs.x }}
          steps:
            - id: check
              run: echo "ok=true" >> "$GITHUB_OUTPUT"
            - id: list
              if: github.event_name == 'push' && inputs.file
              run: echo "items=[]" >> "$GITHUB_OUTPUT"
            - id: act
              uses: ./.github/actions/a
            - id: status
              if: always()
              run: echo
    `,
    [`${WF}/w.yml`]: yaml`
      on: push
      jobs:
        call:
          uses: ./.github/workflows/callee.yml
        after:
          needs: call
          runs-on: x
          steps:
            - run: echo
              env:
                FOUND: \${{ needs.call.outputs.found }}
                LISTED: \${{ needs.call.outputs.listed }}
    `,
    '.github/actions/a/action.yml': yaml`
      name: a
      outputs:
        out:
          value: \${{ 1 == 1 }}
      runs:
        using: composite
        steps: [{ run: echo, shell: bash }]
    `,
  };
  const { index, unit, site } = analyzed(files);

  it('follows job outputs across a reusable workflow call, passed on as text', () => {
    expect(classes(index, unit, site('FOUND'))).toEqual([
      'text-true',
      'text inputs.file',
      'empty optional-input:inputs.file',
    ]);
  });

  it("gives '' for a step its `if:` can skip, with what the guard reads", () => {
    expect(classes(index, unit, site('LISTED'))).toEqual(['unknown', 'empty guarded-step:steps.list']);
    const seg = site('LISTED').segments[0]!;
    const [, empty] = kindOf(index, unit, site('LISTED'), seg, seg.expr.ast!);
    expect(empty!.why!.symbols).toEqual([
      '.github/workflows/callee.yml#jobs.scan.steps.list.outputs.items',
      '.github/workflows/callee.yml#inputs.file',
      '.github/workflows/callee.yml#jobs.scan.outputs.listed',
      '.github/workflows/callee.yml#outputs.listed',
      '.github/workflows/w.yml#jobs.call.outputs.listed',
    ]);
    expect(empty!.why!.keys).toEqual(['github.event_name']);
  });

  it("follows a local action's output, and leaves a step that runs `if: always()` alone", () => {
    const callee = index.unit(`${WF}/callee.yml`)!;
    const output = (key: string) => callee.sites.find((s) => s.field === 'job.output' && s.key === key)!;
    expect(classes(index, callee, output('local'))).toEqual(['text-true', 'text-false']);
    expect(classes(index, callee, output('always'))).toEqual(['unknown']);
  });

  it('stops after a number of hops', () => {
    const jobs = Array.from(
      { length: 12 },
      (_, i) =>
        `  j${i}:\n    runs-on: x\n${i ? `    needs: j${i - 1}\n` : ''}    outputs:\n      o: \${{ ${i ? `needs.j${i - 1}.outputs.o` : "'x'"} }}\n    steps: [{ run: echo }]`,
    ).join('\n');
    const deep = analyzed({ [`${WF}/w.yml`]: `on: push\njobs:\n${jobs}\n` });
    const out = (i: number) => deep.unit.sites.find((s) => s.job === `j${i}` && s.field === 'job.output')!;
    expect(classes(deep.index, deep.unit, out(3))).toEqual(['text']);
    expect(classes(deep.index, deep.unit, out(11))).toEqual(['unknown']);
  });

  it('names where a value is set', () => {
    const seg = site('FOUND').segments[0]!;
    expect(
      producersOf(index, unit, site('FOUND'), seg, seg.expr.ast!).map(
        (p) => `${p.label} ${p.loc.file}:${p.loc.line}`,
      ),
    ).toEqual([`outputs.found ${WF}/callee.yml:7`]);
  });
});

describe('readsReason', () => {
  it('matches the symbols and `github` properties an empty value comes from', () => {
    const { index, unit, site } = analyzed({
      [`${WF}/w.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              file: { type: string, required: false }
        jobs:
          j:
            runs-on: x
            steps:
              - run: echo
                env:
                  A: \${{ inputs.file }}
                  B: \${{ github.event_name }}
                  C: \${{ github.ref }}
      `,
    });
    const why = {
      kind: 'optional-input' as const,
      loc: unit.sites[0]!.loc,
      label: 'inputs.file',
      symbols: [`${WF}/w.yml#inputs.file`],
      keys: ['github.event_name'],
    };
    const reads = (key: string) => readsReason(index, unit, site(key), site(key).segments[0]!.refs, why);
    expect([reads('A'), reads('B'), reads('C')]).toEqual([true, true, false]);
  });
});

describe('describeKind', () => {
  it('names each class once', () => {
    expect(
      describeKind([
        { cls: 'true' },
        { cls: 'text-false' },
        { cls: 'text', from: 'inputs.file' },
        { cls: 'text' },
        {
          cls: 'empty',
          why: {
            kind: 'guarded-step',
            loc: { file: 'f', line: 1, column: 1, endLine: 1, endColumn: 1 },
            label: 'steps.s',
            symbols: [],
            keys: [],
          },
        },
        { cls: 'empty' },
        { cls: 'number' },
        { cls: 'number' },
        { cls: 'json' },
        { cls: 'unknown' },
      ]),
    ).toBe(
      "true | 'false' | text of `inputs.file` | text | '' (`steps.s` skipped) | '' | a number | an object or array | a value known at run time",
    );
    expect(describeKind([])).toBe('nothing: it fails');
  });
});
