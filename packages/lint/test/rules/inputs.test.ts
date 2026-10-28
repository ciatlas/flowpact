import { describe, expect, it } from 'vitest';
import { at, byCode, codes, lint, WF, yaml } from '../helpers';

const callee = yaml`
  on:
    workflow_call:
      inputs:
        name: { type: string, required: true }
        flag: { type: boolean, default: false }
        count: { type: number, required: false }
        optional: { type: string, required: false }
  jobs:
    j:
      runs-on: x
      if: inputs.flag && inputs.count > 0
      steps:
        - run: echo \${{ inputs.name }} \${{ inputs.optional }}
`;

describe('FP101 missing-required-input', () => {
  it('flags a reusable call without a required input, at the uses: line', () => {
    const r = lint({
      [`${WF}/caller.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/callee.yml
            with:
              flag: true
      `,
      [`${WF}/callee.yml`]: callee,
    });
    const [f] = byCode(r, 'FP101');
    expect(f?.message).toContain('without required input "name"');
    expect(at(f!)).toBe(`${WF}/caller.yml:4:11`);
    expect(f?.related.at(-1)?.loc.file).toBe(`${WF}/callee.yml`);
    expect(f?.symbol).toBe(`${WF}/callee.yml#inputs.name`);
  });

  it('does not flag required inputs that have a default, or that are passed', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      Name: x\n',
      [`${WF}/callee.yml`]: callee.replace('required: true }', 'required: true, default: d }'),
    });
    expect(byCode(r, 'FP101')).toEqual([]);
  });

  it('flags required action inputs (which GitHub does not enforce)', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/a\n',
      '.github/actions/a/action.yml':
        'inputs:\n  must: { required: true }\nruns:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.must }}\n      shell: bash\n',
    });
    expect(byCode(r, 'FP101')[0]?.message).toMatch(/empty value/);
  });
});

describe('FP102 unknown-input', () => {
  it('flags undeclared inputs and suggests the closest name', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: x\n      nmae: y\n      zzz: 1\n',
      [`${WF}/callee.yml`]: callee,
    });
    const msgs = byCode(r, 'FP102').map((f) => f.message);
    expect(msgs).toEqual([
      '.github/workflows/callee.yml has no input "nmae" — did you mean "name"?',
      '.github/workflows/callee.yml has no input "zzz"',
    ]);
    expect(byCode(r, 'FP102')[0]!.fix).toBe('Rename "nmae" to "name".');
  });

  it('treats - and _ as equivalent when suggesting', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/a\n        with:\n          cache_dir: x\n',
      '.github/actions/a/action.yml':
        'inputs:\n  cache-dir: {}\nruns:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.cache-dir }}\n      shell: bash\n',
    });
    expect(byCode(r, 'FP102')[0]?.message).toContain('did you mean "cache-dir"');
  });
});

describe('FP103 input-type-mismatch', () => {
  it('flags quoted booleans and non-numeric literals for typed inputs', () => {
    const r = lint({
      [`${WF}/caller.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/callee.yml
            with:
              name: n
              flag: "true"
              count: many
      `,
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'FP103').map((f) => f.message)).toEqual([
      'Input "flag" of .github/workflows/callee.yml is a boolean, but jobs.call passes a string ("true")',
      'Input "count" of .github/workflows/callee.yml is a number, but jobs.call passes a string ("many")',
    ]);
  });

  it('accepts correct literals and statically unknown expressions', () => {
    const r = lint({
      [`${WF}/caller.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/callee.yml
            with:
              name: n
              flag: \${{ github.event_name == 'push' }}
              count: 3
      `,
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'FP103')).toEqual([]);
  });

  it('evaluates constant expressions', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        "on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n      flag: ${{ 'yes' }}\n",
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'FP103')).toHaveLength(1);
  });
});

describe('FP104 unused-input', () => {
  it('flags declared inputs that are never read, noting callers that still pass them', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n      dead: 1\n',
      [`${WF}/callee.yml`]: callee.replace(
        'optional: { type: string, required: false }',
        'optional: { type: string, required: false }\n      dead: { type: string }',
      ),
    });
    const [f] = byCode(r, 'FP104');
    expect(f?.message).toBe(
      'Input "dead" of .github/workflows/callee.yml is never read (yet 1 caller passes it)',
    );
    expect(f?.related[0]?.message).toBe('passed here');
  });

  it('counts github.event.inputs reads and skips files that read inputs dynamically', () => {
    const r = lint({
      [`${WF}/a.yml`]:
        'on:\n  workflow_dispatch:\n    inputs:\n      x: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ github.event.inputs.x }}\n',
      [`${WF}/b.yml`]:
        "on:\n  workflow_dispatch:\n    inputs:\n      y: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo '${{ toJSON(inputs) }}'\n",
    });
    expect(byCode(r, 'FP104')).toEqual([]);
  });

  it('flags unused action inputs', () => {
    const r = lint({
      '.github/actions/a/action.yml':
        'inputs:\n  unused: {}\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n',
    });
    expect(byCode(r, 'FP104')[0]?.symbol).toBe('.github/actions/a#inputs.unused');
  });

  describe('github.event.inputs read as a whole by what a dispatched workflow runs (#126)', () => {
    // A called workflow or an action gets the `github` context of the run, so its `github.event` is the event of the
    // dispatched workflow, whose `inputs` hold that workflow's dispatch inputs. A read that names none reads them all.
    const root = yaml`
      on:
        workflow_dispatch:
          inputs:
            target: { type: string }
            level: { type: string }
      jobs:
        call:
          uses: ./.github/workflows/callee.yml
    `;
    const callee = (read: string) => yaml`
      on: { workflow_call: }
      jobs:
        a:
          runs-on: ubuntu-latest
          steps:
            - run: echo "${read}"
    `;
    const fp104 = (files: Record<string, string>) => byCode(lint(files), 'FP104').map((f) => f.message);
    const unread = (name: string, file = 'root.yml', note = '') =>
      `Input "${name}" of ${WF}/${file} is never read${note}`;

    it('counts the issue’s toJSON(github.event.inputs) in a called workflow as a read of both inputs', () => {
      const files = {
        [`${WF}/root.yml`]: root,
        [`${WF}/callee.yml`]: callee('${{ toJSON(github.event.inputs) }}'),
      };
      expect(fp104(files)).toEqual([]);
    });

    it.each([
      ['a * filter', '${{ toJSON(github.event.inputs.*) }}'],
      ['a computed key', '${{ github.event.inputs[env.KEY] }}'],
      ['the whole event', '${{ toJSON(github.event) }}'],
      ['the whole github context', '${{ toJSON(github) }}'],
      ['a * filter that may stand for event', '${{ toJSON(github.*) }}'],
      ['a * filter that may stand for inputs', '${{ toJSON(github.event.*) }}'],
      ['a computed key that may stand for inputs', '${{ github.event[env.K] }}'],
      ['a computed key that may stand for event', '${{ toJSON(github[env.K].inputs) }}'],
      ['a mixed-case path', '${{ toJSON(github.Event.Inputs) }}'],
    ])('counts %s in a called workflow as a read of every dispatch input', (_, read) => {
      expect(fp104({ [`${WF}/root.yml`]: root, [`${WF}/callee.yml`]: callee(read) })).toEqual([]);
    });

    const steps = (step: string) =>
      root.replace(
        'call:\n    uses: ./.github/workflows/callee.yml',
        `j:\n    runs-on: x\n    steps:\n      - ${step}`,
      );
    const action = yaml`
      runs:
        using: composite
        steps:
          - run: echo '\${{ toJSON(github.event.inputs) }}'
            shell: bash
    `;
    const middle = yaml`
      on: workflow_call
      jobs:
        m:
          uses: ./.github/workflows/leaf.yml
    `;
    it.each([
      [
        'a local action the dispatched workflow uses',
        { [`${WF}/root.yml`]: steps('uses: ./.github/actions/a'), '.github/actions/a/action.yml': action },
      ],
      ['the dispatched workflow itself', { [`${WF}/root.yml`]: steps("run: echo '${{ toJSON(github) }}'") }],
      [
        'a workflow two calls down',
        {
          [`${WF}/root.yml`]: root,
          [`${WF}/callee.yml`]: middle,
          [`${WF}/leaf.yml`]: callee('${{ toJSON(github.event) }}'),
        },
      ],
    ])('counts a whole read in %s', (_, files) => {
      expect(fp104(files)).toEqual([]);
    });

    it('still counts a named read as a read of that input only', () => {
      const named = {
        [`${WF}/root.yml`]: root,
        [`${WF}/callee.yml`]: callee('${{ github.event.inputs.target }}'),
      };
      expect(fp104(named)).toEqual([unread('level')]);
      // `github.event.inputs.TARGET.x`, `github.event.pull_request` and `github.event_name` read no other input.
      const others = callee(
        '${{ github.event.inputs.TARGET.x }} ${{ github.event.pull_request }} ${{ github.event_name }}',
      );
      expect(fp104({ [`${WF}/root.yml`]: root, [`${WF}/callee.yml`]: others })).toEqual([unread('level')]);
    });

    const whole = callee('${{ toJSON(github.event.inputs) }}');
    // Dispatched, root.yml's github.event.inputs holds target and level; called, it is the caller's event.
    const both = root.replace(
      'on:\n',
      'on:\n  workflow_call:\n    inputs:\n      only: { type: string, required: false }\n',
    );

    it('counts the dispatch inputs only, not the workflow_call inputs of a workflow that is also called', () => {
      expect(fp104({ [`${WF}/root.yml`]: both, [`${WF}/callee.yml`]: whole })).toEqual([unread('only')]);
    });

    // A named read counts only an input that the dispatched workflow's event holds: its workflow_dispatch inputs. These
    // read in a called workflow; the dispatched workflow's own read is the test after them.
    const noInputs = yaml`
      on:
        workflow_dispatch:
        workflow_call:
          inputs:
            x: { type: string, required: false }
      jobs:
        call:
          uses: ./.github/workflows/callee.yml
    `;
    it.each([
      [
        'a workflow_call input of the dispatched workflow',
        both,
        '${{ github.event.inputs.only }} ${{ github.event.inputs.target }} ${{ github.event.inputs.level }}',
        'only',
      ],
      ['an input of a workflow dispatched without inputs', noInputs, '${{ github.event.inputs.x }}', 'x'],
    ])('does not count a named read of %s in a called workflow', (_, wf, read, name) => {
      expect(fp104({ [`${WF}/root.yml`]: wf, [`${WF}/callee.yml`]: callee(read) })).toEqual([unread(name)]);
    });

    it('does not count the dispatched workflow’s own named read of an input only workflow_call declares', () => {
      // Dispatched, its github.event.inputs holds target and level; called, it is the caller's event. Core reads
      // github.event.inputs.<name> only as a workflow_dispatch input (ciatlas/core#23).
      const own = both.replace(
        'call:\n    uses: ./.github/workflows/callee.yml',
        'j:\n    runs-on: x\n    steps:\n      - run: echo "${{ github.event.inputs.only }} ${{ github.event.inputs.target }} ${{ github.event.inputs.level }}"',
      );
      expect(own).toContain('github.event.inputs.only');
      expect(fp104({ [`${WF}/root.yml`]: own })).toEqual([unread('only')]);
    });

    // A called workflow's github.event is its caller's, never its own inputs (ciatlas/core#22).
    it('reports a callee input read only through toJSON(github.event.inputs) in the callee', () => {
      const own = callee('${{ toJSON(github.event.inputs) }}').replace(
        'on: { workflow_call: }',
        'on:\n  workflow_call:\n    inputs:\n      own: { type: string, required: false }',
      );
      const files = {
        [`${WF}/root.yml`]: root.replace(
          'uses: ./.github/workflows/callee.yml',
          'uses: ./.github/workflows/callee.yml\n    with:\n      own: x',
        ),
        [`${WF}/callee.yml`]: own,
      };
      expect(fp104(files)).toEqual([unread('own', 'callee.yml', ' (yet 1 caller passes it)')]);
    });

    // GitHub evaluates a workflow's input defaults and workflow_call outputs only when it is called: with its caller's
    // event, so the dispatched workflow's own never read its dispatch inputs. A workflow it calls is evaluated with its
    // event, so the callee's do.
    it('does not count the dispatched workflow’s own input defaults and workflow_call outputs', () => {
      const own = yaml`
        on:
          workflow_call:
            inputs:
              only: { type: string, required: false, default: '\${{ github.event.inputs.target }}' }
            outputs:
              o: { value: '\${{ toJSON(github.event.inputs) }}' }
          workflow_dispatch:
            inputs:
              target: { type: string }
              level: { type: string }
        jobs:
          j:
            runs-on: x
            steps:
              - run: echo "\${{ inputs.only }} \${{ github.event.inputs.level }}"
      `;
      expect(fp104({ [`${WF}/root.yml`]: own })).toEqual([unread('target')]);
    });

    it('counts the input defaults and workflow_call outputs of a workflow it calls', () => {
      const defaults = yaml`
        on:
          workflow_call:
            inputs:
              t: { type: string, required: false, default: '\${{ github.event.inputs.target }}' }
            outputs:
              o: { value: '\${{ github.event.inputs.level }}' }
        jobs:
          a:
            runs-on: ubuntu-latest
            steps:
              - run: echo "\${{ inputs.t }}"
      `;
      expect(fp104({ [`${WF}/root.yml`]: root, [`${WF}/callee.yml`]: defaults })).toEqual([]);
    });

    it('counts the defaults of a called workflow that can be dispatched too, when another workflow is dispatched', () => {
      // Called by root.yml, callee.yml's default reads root.yml's event. Dispatched itself, it reads none of its own.
      const both = yaml`
        on:
          workflow_call:
            inputs:
              t: { type: string, required: false, default: '\${{ github.event.inputs.target }}' }
          workflow_dispatch:
            inputs:
              u: { type: string }
        jobs:
          a:
            runs-on: ubuntu-latest
            steps:
              - run: echo "\${{ inputs.t }} \${{ github.event.inputs.level }}"
      `;
      expect(fp104({ [`${WF}/root.yml`]: root, [`${WF}/callee.yml`]: both })).toEqual([
        unread('u', 'callee.yml'),
      ]);
    });

    it('leaves the inputs of workflows that do not run the reader when dispatched', () => {
      // Another dispatched workflow that does not run the reader, and one that cannot be dispatched, keep theirs.
      const other = yaml`
        on:
          workflow_dispatch:
            inputs:
              other: { type: string }
        jobs:
          j:
            runs-on: x
            steps:
              - run: echo hi
      `;
      const lib = yaml`
        on:
          workflow_call:
            inputs:
              a: { type: string, required: false }
        jobs:
          call:
            uses: ./.github/workflows/callee.yml
      `;
      const push = 'on: push\njobs:\n  c:\n    uses: ./.github/workflows/lib.yml\n    with:\n      a: x\n';
      expect(
        fp104({
          [`${WF}/root.yml`]: root,
          [`${WF}/callee.yml`]: whole,
          [`${WF}/other.yml`]: other,
          [`${WF}/lib.yml`]: lib,
          [`${WF}/push.yml`]: push,
        }),
      ).toEqual([unread('a', 'lib.yml', ' (yet 1 caller passes it)'), unread('other', 'other.yml')]);
    });
  });
});

describe('FP105 optional-input-no-default-in-condition', () => {
  const w = (callerWith: string, condition = 'inputs.optional', opts?: Parameters<typeof lint>[1]) =>
    lint(
      {
        [`${WF}/caller.yml`]: `on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n${callerWith}`,
        [`${WF}/callee.yml`]: callee.replace('if: inputs.flag && inputs.count > 0', `if: ${condition}`),
      },
      opts,
    );
  /** Nothing is published, so the local callers are all the callers there are. */
  const internal = { config: { impact: { publish: [] } } };

  it('flags the condition when some caller omits the input', () => {
    const [f] = byCode(w(''), 'FP105');
    expect(f?.message).toBe(
      `Condition reads optional input "optional", which has no default and is '' when omitted`,
    );
    expect(f?.related.map((r) => r.message)).toContain('.github/workflows/caller.yml › jobs.call omits it');
  });

  it('is quiet when every caller of an internal workflow passes the input', () => {
    expect(byCode(w('      optional: gpu\n', 'inputs.optional', internal), 'FP105')).toEqual([]);
    // `_`-prefixed reusable workflows are internal by default.
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/_callee.yml\n    with:\n      optional: gpu\n',
      [`${WF}/_callee.yml`]: callee.replace('if: inputs.flag && inputs.count > 0', 'if: inputs.optional'),
    });
    expect(byCode(r, 'FP105')).toEqual([]);
  });

  it('still flags a published workflow that every local caller passes the input to', () => {
    const [f] = byCode(w('      optional: gpu\n'), 'FP105');
    expect(f?.related.map((r) => r.message)).toEqual([
      'declared optional without a default; every caller here passes it, but this unit is published (see `impact.publish`), so callers in other repositories can omit it',
    ]);
  });

  it('flags the root action.yml even when its self-test passes the input (it is published)', () => {
    const files = (publish?: string[]) =>
      lint(
        {
          'action.yml': yaml`
            name: published
            inputs:
              token: { required: false }
            runs:
              using: composite
              steps:
                - if: inputs.token
                  run: echo has token
                  shell: bash
          `,
          [`${WF}/selftest.yml`]: yaml`
            on: push
            jobs:
              t:
                runs-on: x
                steps:
                  - uses: ./
                    with:
                      token: \${{ secrets.X }}
          `,
        },
        publish ? { config: { impact: { publish } } } : {},
      );
    expect(byCode(files(), 'FP105').map((f) => at(f))).toEqual(['action.yml:7:11']);
    expect(byCode(files([]), 'FP105')).toEqual([]);
  });

  it.each([
    "inputs.optional == 'yes'",
    "inputs.optional != 'true'",
    "'gpu' == inputs.optional",
    "inputs.optional != ''",
    'inputs.optional == null',
    "contains(inputs.optional, 'tootsuite')",
    `contains(fromJSON('["core","v1"]'), inputs.optional)`,
    "startsWith(inputs.optional, 'v')",
    "github.repository_owner == 'pytorch' && (inputs.optional == 'H100' || inputs.optional == 'A100')",
    // langchain _release.yml: a fallback inside a test
    "startsWith(inputs.optional || inputs.name, 'libs/core')",
    "format('{0}-x', inputs.optional) == '-x'",
    // terraform-provider-aws team_working_board: the explicit check guards the other read
    "inputs.optional != '' && inputs.optional != steps.get_status.outputs.current",
  ])('is quiet when the condition handles the omitted case: %s', (condition) => {
    const r = w('', `\${{ ${condition} }}`);
    expect(codes(r).filter((c) => ['FP105', 'FP502', 'FP504'].includes(c))).toEqual([]);
  });

  it.each([
    'inputs.optional',
    "${{ !inputs.optional && github.event_name == 'push' }}",
    "inputs.optional && github.event_name == 'push'",
    '${{ inputs.optional && always() }}',
    'inputs.optional == github.ref',
    "fromJSON(inputs.optional).enabled && github.event_name == 'push'",
    "${{ inputs.optional || github.event_name == 'push' }}",
  ])('flags a condition decided by the value as it is: %s', (condition) => {
    expect(byCode(w('', condition), 'FP105')).toHaveLength(1);
  });

  it.each([
    // The same test as `inputs.optional == ''`, which is accepted
    '${{ !inputs.optional }}',
    "inputs.optional || 'yes'",
    "${{ (inputs.optional || 'yes') && !inputs.optional }}",
  ])('is quiet when omitting the input cannot turn the condition false: %s', (condition) => {
    expect(byCode(w('', condition), 'FP105')).toEqual([]);
  });

  it('checks each input on its own: omitting a can turn the condition false, omitting b cannot', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              a: { type: string, required: false }
              b: { type: string, required: false }
        jobs:
          j:
            runs-on: x
            steps:
              - if: \${{ inputs.a || !inputs.b }}
                run: echo
      `,
    });
    expect(byCode(r, 'FP105').map((f) => f.symbol)).toEqual([`${WF}/w.yml#inputs.a`]);
  });

  it('is quiet on a condition with text around ${{ }}, which is always true', () => {
    expect(byCode(w('', 'run ${{ inputs.optional }}'), 'FP105')).toEqual([]);
    expect(byCode(w('', "${{ inputs.optional }} == 'x'"), 'FP105')).toEqual([]);
  });

  it('asks the users of a local action too (the identical workflow input was already quiet)', () => {
    const files = (stepWith: string) => ({
      [`${WF}/main.yml`]: `on: push\njobs:\n  s:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/a\n${stepWith}`,
      '.github/actions/a/action.yml': yaml`
        name: a
        inputs:
          mode: { required: false }
        runs:
          using: composite
          steps:
            - if: inputs.mode
              run: echo fast
              shell: bash
      `,
    });
    expect(byCode(lint(files('        with: { mode: fast }\n')), 'FP105')).toEqual([]);
    const [f] = byCode(lint(files('')), 'FP105');
    expect(f?.related.map((r) => r.message)).toEqual([
      'declared optional without a default',
      '.github/workflows/main.yml › jobs.s › step #1 omits it',
    ]);
  });

  describe('when a caller passes one of the inputs a condition reads (#38)', () => {
    const condition = 'if: ${{ inputs.app-id || inputs.client-id }}';
    const declared = '{ type: string, required: false }';

    it('reports both for a published workflow, since other repositories can omit either', () => {
      const r = lint({
        [`${WF}/caller.yml`]: `on: push\njobs:\n  c:\n    uses: ./.github/workflows/token.yml\n    with:\n      client-id: \${{ vars.CLIENT_ID }}\n`,
        [`${WF}/token.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                app-id: ${declared}
                client-id: ${declared}
          jobs:
            j:
              runs-on: x
              steps:
                - ${condition}
                  run: echo token
        `,
      });
      expect(byCode(r, 'FP105').map((f) => f.message)).toEqual([
        `Condition reads optional input "app-id", which has no default and is '' when omitted (so is "client-id", read by the same condition)`,
        `Condition reads optional input "client-id", which has no default and is '' when omitted (so is "app-id", read by the same condition)`,
      ]);
    });

    it('reports the omitted one for a local action, saying every caller passes the other', () => {
      const r = lint({
        [`${WF}/w.yml`]: `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/token\n        with:\n          client-id: \${{ vars.CLIENT_ID }}\n`,
        '.github/actions/token/action.yml': yaml`
          name: token
          inputs:
            app-id: { required: false }
            client-id: { required: false }
          runs:
            using: composite
            steps:
              - ${condition}
                run: echo token
                shell: bash
        `,
      });
      expect(byCode(r, 'FP105').map((f) => `${at(f)} ${f.message}`)).toEqual([
        `.github/actions/token/action.yml:8:15 Condition reads optional input "app-id", which has no default and is '' when omitted ("client-id", also read by this condition, is passed by every caller)`,
      ]);
    });
  });

  describe('when the workflow expects the step to be skipped (#251)', () => {
    const head = yaml`
      on:
        workflow_call:
          inputs:
            app-id: { type: string, required: false }
            client-id: { type: string, required: false }
      jobs:
        j:
          runs-on: x
          steps:
    `;
    /** Steps written at the left margin, indented into `jobs.j.steps`. */
    const steps = (text: string) => text.replace(/^(?=.)/gm, '      ');
    /** Job `j`: step `token`, guarded by `condition`, then the steps in `after` (and those in `before` first). */
    const guarded = (after: string, condition = 'inputs.app-id', before = '') =>
      lint({
        [`${WF}/w.yml`]: `${head}${steps(before)}${steps(
          `- id: token\n  if: ${condition}\n  uses: actions/create-github-app-token@v2\n`,
        )}${steps(after)}`,
      });
    const fp105 = (r: ReturnType<typeof lint>) => byCode(r, 'FP105').map((f) => at(f));
    const checkout = (token: string) => `- uses: actions/checkout@v5\n  with:\n    token: ${token}\n`;

    it("is quiet when the skipped step's outputs are only read through a fallback", () => {
      const r = guarded(
        checkout('${{ steps.token.outputs.token || github.token }}'),
        '${{ inputs.app-id || inputs.client-id }}',
      );
      expect(fp105(r)).toEqual([]);
    });

    it.each([
      ['a condition on its outcome', "- if: steps.token.outcome == 'success'\n  run: echo has a token\n"],
      [
        'a condition on its conclusion, in any case',
        "- if: steps.Token.Conclusion != 'skipped'\n  run: echo\n",
      ],
      [
        'a condition that still runs, in any case',
        '- if: ${{ !steps.Token.outputs.token }}\n  run: echo no token\n- if: always() || steps.token.outputs.token\n  run: echo\n',
      ],
      [
        'a term of the condition that is then true',
        "- if: steps.token.outputs.token == '' && github.event_name == 'push'\n  run: echo no token\n",
      ],
      [
        'a term that is then false under a !',
        "- if: ${{ !(steps.token.outputs.x == 'true' || github.event_name == 'push') }}\n  run: echo\n",
      ],
      // A comparison, function call or index ends the term: the fallback inside it is not a term of its own.
      [
        'a term with a fallback inside a comparison or function',
        "- if: (steps.token.outputs.x || 'true') == 'true' && github.event_name == 'push'\n  run: echo\n" +
          "- if: contains(steps.token.outputs.x || 'true', 'true') && github.event_name == 'push'\n  run: echo\n" +
          "- if: (!steps.token.outputs.x) == true && github.event_name == 'push'\n  run: echo\n",
      ],
      [
        'fallbacks, also inside a function',
        "- run: gh release create\n  env:\n    A: ${{ steps.token.outputs.token || github.token }}\n    B: ${{ format('{0}', steps.token.outputs.token || secrets.PAT) }}\n",
      ],
      [
        // Known limit: a fallback shows the skip was considered, not that the step's own effects are optional.
        'a summary with a fallback',
        `- run: echo "\${{ steps.token.outputs.url || 'nowhere' }}" >> "$GITHUB_STEP_SUMMARY"\n`,
      ],
    ])('is quiet when every read holds up when the step is skipped: %s', (_, after) => {
      expect(fp105(guarded(after))).toEqual([]);
    });

    it('does not count reads before the step, which cannot see it', () => {
      const r = guarded(
        checkout('${{ steps.token.outputs.token || github.token }}'),
        undefined,
        '- run: echo ${{ steps.token.outputs.token }} ${{ toJSON(steps) }}\n',
      );
      expect(fp105(r)).toEqual([]);
    });

    it.each([
      ['no read', '- run: echo done\n'],
      ['a plain read', checkout('${{ steps.token.outputs.token }}')],
      ['an empty fallback', checkout("${{ steps.token.outputs.token || '' }}")],
      [
        'a fallback and a plain read',
        `${checkout('${{ steps.token.outputs.token || github.token }}')}- run: gh release create\n  env:\n    GH_TOKEN: \${{ steps.token.outputs.token }}\n`,
      ],
      [
        'a read of every step',
        `${checkout('${{ steps.token.outputs.token || github.token }}')}- run: echo '\${{ toJSON(steps) }}'\n`,
      ],
      // The gate is '' == 'true' when the step is skipped: its step is skipped silently too.
      ['a gate on an output', "- if: steps.token.outputs.changed == 'true'\n  run: ./deploy.sh\n"],
      [
        'a gate on an output or another condition',
        "- if: steps.token.outputs.changed == 'true' || github.event_name == 'push'\n  run: ./deploy.sh\n",
      ],
      [
        'a gate on an output, read again inside it',
        '- if: steps.token.outputs.token\n  env:\n    GH_TOKEN: ${{ steps.token.outputs.token }}\n  run: gh release list\n',
      ],
      [
        'a fallback over the same step',
        checkout("${{ steps.token.outputs.a || steps.token.outputs.b || '' }}"),
      ],
      ['a fallback to the omitted input', checkout('${{ steps.token.outputs.token || inputs.app-id }}')],
      // A ! turns a term that is true when the step is skipped false: each of these is then false or a gate.
      ['a negated test for empty', "- if: ${{ !(steps.token.outputs.x == '') }}\n  run: ./deploy.sh\n"],
      [
        'a negated group',
        "- if: ${{ !(steps.token.outputs.x == '' || github.event_name == 'push') }}\n  run: ./deploy.sh\n",
      ],
      [
        'a negated term and another',
        "- if: ${{ !(steps.token.outputs.x != 'true') && github.event_name == 'push' }}\n  run: ./deploy.sh\n",
      ],
      [
        'a negated term after success()',
        "- if: success() && !(steps.token.outputs.x == '')\n  run: ./deploy.sh\n",
      ],
      [
        'a negated term or another',
        "- if: ${{ !(steps.token.outputs.x == '') || github.event_name == 'push' }}\n  run: ./deploy.sh\n",
      ],
      [
        'a read of a computed step',
        `${checkout('${{ steps.token.outputs.token || github.token }}')}- run: echo \${{ steps[matrix.step].outcome }}\n`,
      ],
    ])('still reports a step whose results are not read only that way: %s', (_, after) => {
      expect(fp105(guarded(after))).toEqual([`${WF}/w.yml:11:13`]);
    });

    it('still reports a gate on an output or a boolean input, false when it is not passed either', () => {
      const r = lint({
        [`${WF}/w.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                path: { type: string, required: false }
                force: { type: boolean, required: false }
          jobs:
            j:
              runs-on: x
              steps:
                - id: check
                  if: inputs.path
                  run: echo "changed=true" >> "$GITHUB_OUTPUT"
                - if: steps.check.outputs.changed == 'true' || inputs.force
                  run: ./deploy.sh
        `,
      });
      expect(fp105(r)).toEqual([`${WF}/w.yml:11:13`]);
    });

    it('takes every input flagged at the guard as omitted', () => {
      const condition = '${{ inputs.app-id || inputs.client-id }}';
      const fallback = (to: string) =>
        guarded(checkout(`\${{ steps.token.outputs.token || ${to} }}`), condition);
      expect(fp105(fallback('inputs.client-id'))).toEqual([`${WF}/w.yml:11:17`, `${WF}/w.yml:11:34`]);
      expect(fp105(fallback('secrets.PAT'))).toEqual([]);
    });

    it('still reports a step without an id', () => {
      const r = lint({
        [`${WF}/w.yml`]: `${head}${steps(
          `- if: inputs.app-id\n  uses: actions/create-github-app-token@v2\n${checkout('${{ steps.token.outputs.token || github.token }}')}`,
        )}`,
      });
      expect(fp105(r)).toEqual([`${WF}/w.yml:10:13`]);
    });

    /**
     * Job `j` sets output `token` to `value`; job `k` reads it as `read`, and sets its own `outputs`, which job `l`
     * reads through a fallback.
     */
    const viaJobOutput = (read: string, value = '${{ steps.token.outputs.token }}', outputs = '{}') =>
      lint({
        [`${WF}/w.yml`]: `${yaml`
          on:
            workflow_call:
              inputs:
                app-id: { type: string, required: false }
          jobs:
            j:
              runs-on: x
              outputs:
                token: ${value}
              steps:
                - id: token
                  if: inputs.app-id
                  uses: actions/create-github-app-token@v2
            k:
              needs: j
              runs-on: x
              outputs: ${outputs}
              steps:
                - uses: actions/checkout@v5
                  with:
                    token: ${read}
        `}  l:\n    needs: k\n    runs-on: x\n    steps:\n      - run: echo \${{ needs.k.outputs.token || 'none' }}\n`,
      });

    it('follows a job output to its readers', () => {
      expect(fp105(viaJobOutput('${{ needs.j.outputs.token || github.token }}'))).toEqual([]);
      expect(fp105(viaJobOutput('${{ needs.J.outputs.Token != 0 }}'))).toEqual([`${WF}/w.yml:12:13`]);
      expect(
        fp105(viaJobOutput('${{ needs.j.outputs.token }}', "${{ steps.token.outputs.token || 'none' }}")),
      ).toEqual([]);
    });

    it('follows a job output only when it is then empty', () => {
      const read = '${{ needs.j.outputs.token || github.token }}';
      expect(fp105(viaJobOutput(read, "${{ steps.token.outputs.token || '' }}"))).toEqual([]);
      // '/path' when the step is skipped: k never falls back
      expect(fp105(viaJobOutput(read, '${{ steps.token.outputs.token }}/path'))).toEqual([
        `${WF}/w.yml:12:13`,
      ]);
      expect(fp105(viaJobOutput('${{ needs.j.outputs.token || inputs.app-id }}'))).toEqual([
        `${WF}/w.yml:12:13`,
      ]);
    });

    it("judges a job's if: that reads the job output by its terms and the ! around them", () => {
      const gated = (condition: string) =>
        lint({
          [`${WF}/w.yml`]: yaml`
            on:
              workflow_call:
                inputs:
                  app-id: { type: string, required: false }
            jobs:
              j:
                runs-on: x
                outputs:
                  x: \${{ steps.token.outputs.x }}
                steps:
                  - id: token
                    if: inputs.app-id
                    uses: actions/create-github-app-token@v2
              k:
                needs: j
                if: ${condition}
                runs-on: x
                steps:
                  - run: ./deploy.sh
          `,
        });
      expect(fp105(gated("${{ needs.j.outputs.x == '' && github.event_name == 'push' }}"))).toEqual([]);
      expect(fp105(gated("${{ !(needs.j.outputs.x == '') }}"))).toEqual([`${WF}/w.yml:12:13`]);
    });

    it.each([
      ['a plain read', '${{ needs.j.outputs.token }}'],
      ['a whole read', "${{ toJSON(needs.j.outputs) || 'none' }}"],
      ['no read', '${{ github.token }}'],
    ])('still reports a job output with %s', (_, read) => {
      expect(fp105(viaJobOutput(read))).toEqual([`${WF}/w.yml:12:13`]);
    });

    it('follows one job output, not a second one', () => {
      const r = viaJobOutput(
        '${{ needs.j.outputs.token || github.token }}',
        undefined,
        '{ token: "${{ needs.j.outputs.token }}" }',
      );
      // k's output is read through a fallback, but that is a second hop.
      expect(fp105(r)).toEqual([`${WF}/w.yml:12:13`]);
    });

    it("still reports a job's if:", () => {
      const r = lint({
        [`${WF}/w.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                app-id: { type: string, required: false }
          jobs:
            j:
              runs-on: x
              if: inputs.app-id
              outputs:
                token: \${{ steps.token.outputs.token || github.token }}
              steps:
                - id: token
                  uses: actions/create-github-app-token@v2
        `,
      });
      expect(fp105(r)).toEqual([`${WF}/w.yml:8:9`]);
    });

    it('applies to the steps of a composite action', () => {
      const action = (value: string) =>
        lint({
          '.github/actions/token/action.yml': yaml`
            name: token
            inputs:
              app-id: { required: false }
            outputs:
              token: { value: '${value}' }
            runs:
              using: composite
              steps:
                - id: token
                  if: inputs.app-id
                  run: echo "token=t" >> "$GITHUB_OUTPUT"
                  shell: bash
                - run: gh api user
                  shell: bash
                  env:
                    GH_TOKEN: \${{ steps.token.outputs.token || github.token }}
          `,
        });
      expect(fp105(action('${{ steps.token.outputs.token || github.token }}'))).toEqual([]);
      expect(fp105(action('${{ steps.token.outputs.token }}'))).toEqual([
        '.github/actions/token/action.yml:10:11',
      ]);
    });
  });

  it('reports every optional input a condition depends on, each naming the others (#38)', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              app-id: { type: string, required: false }
              client-id: { type: string, required: false }
              private-key: { type: string, required: false }
        jobs:
          j:
            runs-on: x
            steps:
              - if: \${{ inputs.app-id || inputs.client-id }}
                run: echo token
              - if: \${{ inputs.private-key }}
                run: echo key
      `,
    });
    expect(byCode(r, 'FP105').map((f) => `${at(f)} ${f.message}`)).toEqual([
      `${WF}/w.yml:11:17 Condition reads optional input "app-id", which has no default and is '' when omitted (so is "client-id", read by the same condition)`,
      `${WF}/w.yml:11:34 Condition reads optional input "client-id", which has no default and is '' when omitted (so is "app-id", read by the same condition)`,
      `${WF}/w.yml:13:17 Condition reads optional input "private-key", which has no default and is '' when omitted`,
    ]);
    expect(byCode(r, 'FP105').map((f) => f.symbol)).toEqual([
      `${WF}/w.yml#inputs.app-id`,
      `${WF}/w.yml#inputs.client-id`,
      `${WF}/w.yml#inputs.private-key`,
    ]);
  });

  describe('an empty default, which GitHub passes for an omitted input anyway (#251)', () => {
    const files = (decl: string, callerWith = '') => ({
      [`${WF}/caller.yml`]: `on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n${callerWith}`,
      [`${WF}/callee.yml`]: callee
        .replace('optional: { type: string, required: false }', `optional: ${decl}`)
        .replace('if: inputs.flag && inputs.count > 0', 'if: inputs.optional'),
    });

    it.each([`''`, `""`, `"\${{ '' }}"`, `"\${{ null }}"`])(
      'reports default: %s, at the default',
      (value) => {
        const decl = `{ type: string, required: false, default: ${value} }`;
        const [f, ...rest] = byCode(lint(files(decl)), 'FP105');
        expect(rest).toEqual([]);
        expect(f?.message).toBe(
          `Condition reads optional input "optional", whose default '' is what GitHub passes when it is omitted`,
        );
        expect(f?.related.map((r) => `${r.loc.line}:${r.loc.column} ${r.message}`)).toEqual([
          `7:${`      optional: ${decl}`.indexOf(value) + 1} \`default: ''\` changes nothing: an omitted input is '' anyway`,
          '4:11 .github/workflows/caller.yml › jobs.call omits it',
        ]);
      },
    );

    it('says so for a published workflow that every local caller passes the input to', () => {
      const decl = "{ type: string, required: false, default: '' }";
      const [f] = byCode(lint(files(decl, '      optional: gpu\n')), 'FP105');
      expect(f?.related.map((r) => r.message)).toEqual([
        "`default: ''` changes nothing: an omitted input is '' anyway; every caller here passes it, but this unit is published (see `impact.publish`), so callers in other repositories can omit it",
      ]);
    });

    it.each([
      "{ type: string, required: false, default: 'x' }",
      '{ type: string, required: false, default: "${{ github.ref_name }}" }',
    ])('is quiet for a default that is not empty: %s', (decl) => {
      expect(byCode(lint(files(decl)), 'FP105')).toEqual([]);
    });

    it('treats a null default as none', () => {
      const [f] = byCode(lint(files('{ type: string, required: false, default: null }')), 'FP105');
      expect(f?.message).toBe(
        `Condition reads optional input "optional", which has no default and is '' when omitted`,
      );
      expect(f?.related[0]?.message).toBe('declared optional without a default');
    });
  });

  it('ignores booleans (false is a natural default)', () => {
    expect(
      byCode(lint({ [`${WF}/callee.yml`]: callee }), 'FP105')
        .map((f) => f.message)
        .join(),
    ).not.toContain('"flag"');
  });
});

describe('FP106 passthrough-dropped', () => {
  it('reports the caller binding of an input the callee never reads', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n      ignored: x\n',
      [`${WF}/callee.yml`]: callee.replace(
        'optional: { type: string, required: false }',
        'optional: { type: string, required: false }\n      ignored: { type: string }',
      ),
    });
    const [f] = byCode(r, 'FP106');
    expect(f?.severity).toBe('info');
    expect(at(f!)).toBe(`${WF}/caller.yml:7:7`);
  });
});

describe('FP107 optional-forwarded-to-required', () => {
  const caller = (decl: string) => yaml`
    on:
      workflow_call:
        inputs:
          outer: ${decl}
    jobs:
      call:
        uses: ./.github/workflows/callee.yml
        with:
          name: \${{ inputs.outer }}
  `;

  it('flags a required input fed from an optional input without a default', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('{ type: string, required: false }'),
      [`${WF}/callee.yml`]: callee,
    });
    const [f] = byCode(r, 'FP107');
    expect(f?.message).toBe(
      'Required input "name" of .github/workflows/callee.yml is empty when optional input "outer" is omitted',
    );
    expect(at(f!)).toBe(`${WF}/caller.yml:9:17`);
  });

  it('names the input that picks an empty fallback, not a source of the value (#232)', () => {
    const r = lint({
      [`${WF}/caller.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              sector: { type: string, required: false }
        jobs:
          setup:
            runs-on: x
            outputs:
              workspace-path: \${{ steps.s.outputs.path }}
            steps:
              - id: s
                run: echo "path=p" >> "$GITHUB_OUTPUT"
          call:
            needs: setup
            uses: ./.github/workflows/callee.yml
            with:
              name: \${{ inputs.sector == 'WLT' && needs.setup.outputs.workspace-path || '' }}
      `,
      [`${WF}/callee.yml`]: callee,
    });
    const [f] = byCode(r, 'FP107');
    expect(f?.message).toBe(
      'Required input "name" of .github/workflows/callee.yml is empty when optional input "sector" is omitted',
    );
    expect(at(f!)).toBe(`${WF}/caller.yml:17:17`);
    expect(f?.related.map((x) => x.message)).toEqual([
      'optional, no default',
      'required by .github/workflows/callee.yml',
    ]);
  });

  it('names every omitted input the value reads, and no required one', () => {
    const r = lint({
      [`${WF}/caller.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              mode: { type: string, required: true }
              first: { type: string, required: false }
              second: { type: string }
        jobs:
          call:
            uses: ./.github/workflows/callee.yml
            with:
              name: \${{ inputs.first && inputs.mode || inputs.second }}
      `,
      [`${WF}/callee.yml`]: callee,
    });
    const [f] = byCode(r, 'FP107');
    expect(f?.message).toBe(
      'Required input "name" of .github/workflows/callee.yml is empty when optional inputs "first", "second" are omitted',
    );
    expect(at(f!)).toBe(`${WF}/caller.yml:11:17`);
    expect(f?.related).toHaveLength(3);
  });

  it('says a value that reads no input is always empty', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('{ type: string }').replace('${{ inputs.outer }}', "${{ '' }}"),
      [`${WF}/callee.yml`]: callee,
    });
    const [f] = byCode(r, 'FP107');
    expect(f?.message).toBe('Required input "name" of .github/workflows/callee.yml is always empty');
    expect(f?.related).toHaveLength(1);
  });

  it("flags an optional input whose default is '', which the callee gets when it is omitted (#251)", () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller(`{ type: string, required: false, default: '' }`),
      [`${WF}/callee.yml`]: callee,
    });
    const [f] = byCode(r, 'FP107');
    expect(f?.message).toBe(
      'Required input "name" of .github/workflows/callee.yml is empty when optional input "outer" is omitted',
    );
    expect(f?.related.map((x) => x.message)).toEqual([
      "optional, default ''",
      'required by .github/workflows/callee.yml',
    ]);
  });

  it.each(['{ type: string, required: true }', '{ type: string, default: x }'])('is quiet for %s', (decl) => {
    expect(
      byCode(lint({ [`${WF}/caller.yml`]: caller(decl), [`${WF}/callee.yml`]: callee }), 'FP107'),
    ).toEqual([]);
  });

  it('is quiet when a fallback is provided', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('{ type: string }').replace(
        '${{ inputs.outer }}',
        "${{ inputs.outer || 'x' }}",
      ),
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'FP107')).toEqual([]);
  });
});

describe('FP108 undefined-input-ref', () => {
  it('flags reads of undeclared inputs with a suggestion', () => {
    const r = lint({
      [`${WF}/callee.yml`]: callee.replace('${{ inputs.name }}', '${{ inputs.nam }}'),
    });
    const [f] = byCode(r, 'FP108');
    expect(f?.message).toBe('.github/workflows/callee.yml has no input "nam" — did you mean "name"?');
    expect(f?.fix).toBe('Use `inputs.name`.');
  });

  it('flags github.event.inputs reads too', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: workflow_dispatch\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ github.event.inputs.nope }}\n',
    });
    expect(codes(r)).toEqual(['FP108']);
  });

  describe('github.event.inputs written in any case (#128)', () => {
    // GitHub looks context properties up ignoring case (`@actions/expressions` lower-cases its Dictionary keys, the
    // runner's DictionaryContextData compares them with OrdinalIgnoreCase): github.Event.Inputs is github.event.inputs.
    const workflow = (on: string, read: string) => yaml`
      on:
        ${on}:
          inputs:
            target: { type: string, required: false }
      jobs:
        j:
          runs-on: x
          steps:
            - run: echo "\${{ ${read} }}"
    `;
    const fp108 = (on: string, read: string) =>
      byCode(lint({ [`${WF}/w.yml`]: workflow(on, read) }), 'FP108').map((f) => `${f.message} @${at(f)}`);

    it.each([
      'github.event.inputs.nope',
      'github.Event.Inputs.nope',
      'github.EVENT.inputs.nope',
      'github.event.INPUTS.nope',
      'GitHub.Event.Inputs.nope',
      "github['Event']['Inputs'].nope",
    ])('flags %s in a workflow that can be dispatched', (read) => {
      expect(fp108('workflow_dispatch', read)).toEqual([`${WF}/w.yml has no input "nope" @${WF}/w.yml:9:24`]);
    });

    it.each(['github.event.inputs.target', 'github.Event.Inputs.target', 'github.event.inputs.TARGET'])(
      'is quiet for %s, a declared input',
      (read) => {
        expect(fp108('workflow_dispatch', read)).toEqual([]);
      },
    );

    it.each(['github.event.inputs.nope', 'github.Event.Inputs.nope'])(
      'is quiet for %s in a workflow that can only be called, whose event is its caller’s',
      (read) => {
        expect(fp108('workflow_call', read)).toEqual([]);
      },
    );
  });
});
