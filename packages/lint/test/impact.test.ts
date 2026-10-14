/** Impact mode: grading changes to published units, the declared impact and the verdict. */
import { memoryFileSystem, type ProjectIndex } from '@ciatlas/core';
import {
  analyze,
  DEFAULT_IMPACT_POLICY,
  type DeclaredInput,
  type ImpactChange,
  impactChanges,
  impactVerdict,
  levelFromTitle,
  levelFromVersions,
  parseConfig,
} from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { codes, WF } from './helpers';

const index = (files: Record<string, string>, publish?: string[]): ProjectIndex =>
  analyze({
    root: '/v',
    fs: memoryFileSystem(files),
    validateSchema: false,
    only: [],
    repository: 'a/b',
    ...(publish ? { config: parseConfig({ impact: { publish } }) } : {}),
  }).index;

const reusable = (body: string, inputs = '') =>
  `on:\n  workflow_call:\n${inputs || '    inputs: {}\n'}jobs:\n${body}`;
const job = (id: string, extra = '') =>
  `  ${id}:\n${extra}    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n`;

/** The graded changes, without the patch for changed jobs or steps that most changes come with (see its own tests). */
function changes(
  before: Record<string, string>,
  after: Record<string, string>,
  publish?: string[],
): ImpactChange[] {
  return withImplementation(before, after, publish).filter((c) => c.kind !== 'implementation');
}
const withImplementation = (
  before: Record<string, string>,
  after: Record<string, string>,
  publish?: string[],
) => impactChanges(index(before, publish), index(after, publish), publish ? { publish } : {});
const summary = (cs: ImpactChange[]) => cs.map((c) => `${c.level}${c.certain ? '' : '?'} ${c.message}`);

describe('check names of published reusable workflows', () => {
  it('a renamed job is major, reported as a rename at the job', () => {
    const cs = changes(
      { [`${WF}/r.yml`]: reusable(job('test', '    name: Test\n')) },
      { [`${WF}/r.yml`]: reusable(job('test', '    name: Unit tests\n')) },
    );
    expect(summary(cs)).toEqual([
      'major check "… / Test" is now "… / Unit tests"; consumers that require the old name wait forever',
    ]);
    expect(cs[0]!.loc.line).toBe(6);
  });

  it('removing a matrix value is major, adding one is minor', () => {
    const mx = (values: string) => job('t', `    strategy:\n      matrix:\n        node: [${values}]\n`);
    expect(
      summary(
        changes({ [`${WF}/r.yml`]: reusable(mx('20, 22')) }, { [`${WF}/r.yml`]: reusable(mx('22, 24')) }),
      ),
    ).toEqual([
      'major check "… / t (20)" no longer reported; consumers that require it wait forever',
      'minor new check "… / t (24)"',
    ]);
    expect(
      summary(changes({ [`${WF}/r.yml`]: reusable(mx('22')) }, { [`${WF}/r.yml`]: reusable(mx('22, 24')) })),
    ).toEqual(['minor new check "… / t (24)"']);
  });

  it('a renamed literal part is certain even when the rest of the name is not', () => {
    const cs = changes(
      { [`${WF}/r.yml`]: reusable(job('t', '    name: T ${{ vars.X }}\n')) },
      { [`${WF}/r.yml`]: reusable(job('t', '    name: U ${{ vars.X }}\n')) },
    );
    expect(cs.map((c) => [c.level, c.certain])).toEqual([['major', true]]);
  });

  it('ignores workflows that are not published', () => {
    expect(
      changes(
        { [`${WF}/ci.yml`]: `on: push\njobs:\n${job('test', '    name: Test\n')}` },
        { [`${WF}/ci.yml`]: `on: push\njobs:\n${job('test', '    name: Unit tests\n')}` },
      ),
    ).toEqual([]);
  });
});

describe('interfaces, units, permissions and runtimes', () => {
  const inputs = (s: string) => `    inputs:\n${s}`;
  it('grades workflow_call interface changes', () => {
    const before = {
      [`${WF}/r.yml`]: reusable(
        job('t'),
        inputs("      a: { type: string, default: 'x' }\n      b: { type: string }\n"),
      ),
    };
    const after = {
      [`${WF}/r.yml`]: reusable(
        job('t'),
        inputs(
          "      a: { type: string, default: 'y' }\n      c: { type: string }\n      d: { type: string, required: true }\n",
        ),
      ),
    };
    expect(summary(changes(before, after)).sort()).toEqual(
      [
        'major input "b" was removed — callers that pass it will fail',
        'major input "d" was added and must be passed — existing callers do not pass it',
        'minor input "a" default changed from "x" to "y"',
        'minor input "c" was added',
      ].sort(),
    );
  });

  it('a removed or no longer callable unit is major, a new one minor', () => {
    expect(summary(changes({ [`${WF}/r.yml`]: reusable(job('t')) }, {}))).toEqual([
      'major reusable workflow .github/workflows/r.yml was removed or moved; consumers that reference it fail',
    ]);
    expect(
      summary(
        changes({ [`${WF}/r.yml`]: reusable(job('t')) }, { [`${WF}/r.yml`]: `on: push\njobs:\n${job('t')}` }),
      ),
    ).toEqual(['major .github/workflows/r.yml can no longer be called (no workflow_call)']);
    expect(summary(changes({}, { [`${WF}/r.yml`]: reusable(job('t')) }))).toEqual([
      'minor new reusable workflow .github/workflows/r.yml',
    ]);
  });

  it('widened permissions are major; narrowed ones are not graded', () => {
    const perms = (p: string) => reusable(job('t', `    permissions: ${p}\n`));
    expect(
      summary(
        changes(
          { [`${WF}/r.yml`]: perms('{ contents: read }') },
          { [`${WF}/r.yml`]: perms('{ contents: write }') },
        ),
      ),
    ).toEqual([
      'major jobs.t now requests contents: write; callers that grant less fail when the run starts',
    ]);
    expect(
      changes(
        { [`${WF}/r.yml`]: perms('{ contents: write }') },
        { [`${WF}/r.yml`]: perms('{ contents: read }') },
      ),
    ).toEqual([]);
    expect(
      summary(
        changes({ [`${WF}/r.yml`]: reusable(job('t')) }, { [`${WF}/r.yml`]: perms('{ id-token: write }') }),
      ),
    ).toEqual([
      'major? jobs.t now requests id-token: write; callers that grant less fail when the run starts',
    ]);
  });

  it('grades published actions: runtime and new third-party actions; internal actions are ignored', () => {
    const action = (using: string, steps = '') =>
      `name: a\ndescription: d\nruns:\n  using: ${using}\n${using === 'composite' ? `  steps:\n${steps || '    - run: x\n      shell: bash\n'}` : '  main: index.js\n'}`;
    expect(summary(changes({ 'action.yml': action('node20') }, { 'action.yml': action('node24') }))).toEqual([
      'major runs.using changed from node20 to node24; runners or GHES versions without it cannot run the action',
    ]);
    expect(
      summary(
        changes(
          { 'tools/a/action.yml': action('composite') },
          { 'tools/a/action.yml': action('composite', '    - uses: some/thing@v1\n') },
          ['tools/*'],
        ),
      ),
    ).toEqual([
      'minor now uses some/thing; consumers whose organization only allows listed actions (or requires SHA pinning) must allow it',
    ]);
    expect(
      changes(
        { '.github/actions/a/action.yml': action('node20') },
        { '.github/actions/a/action.yml': action('node24') },
      ),
    ).toEqual([]);
    expect(
      changes(
        { '.github/actions/a/action.yml': action('node20') },
        { '.github/actions/a/action.yml': action('node24') },
        ['.github/actions/**'],
      ),
    ).toHaveLength(1);
  });
});

describe('runners', () => {
  const on = (runsOn: string) =>
    `on:\n  workflow_call:\n    inputs:\n      runner: { type: string, required: false }\njobs:\n  t:\n    runs-on: ${runsOn}\n    steps: [{ run: 'true' }]\n`;
  const grade = (before: string, after: string) =>
    summary(changes({ [`${WF}/r.yml`]: on(before) }, { [`${WF}/r.yml`]: on(after) }));

  it('grades a runner label or group callers may not have as major', () => {
    expect(grade('ubuntu-latest', '[self-hosted, gpu]')).toEqual([
      'major jobs.t now needs a runner with [self-hosted, gpu]; callers without one never start it',
    ]);
    expect(grade('[self-hosted, linux]', '[self-hosted, linux, gpu]')).toEqual([
      'major jobs.t now needs a runner with [self-hosted, linux, gpu]; callers without one never start it',
    ]);
    expect(grade('ubuntu-latest', '{ group: builders }')).toEqual([
      'major jobs.t now needs a runner with runner group "builders"; callers without one never start it',
    ]);
  });

  it('grades another GitHub-hosted image, or fewer needs, as a patch', () => {
    expect(grade('ubuntu-22.04', 'ubuntu-24.04')).toEqual([
      'patch jobs.t now runs on [ubuntu-24.04] instead of [ubuntu-22.04]',
    ]);
    expect(grade('[self-hosted, linux, gpu]', '[self-hosted, linux]')).toEqual([
      'patch jobs.t now runs on [self-hosted, linux]',
    ]);
    expect(grade('[self-hosted, gpu]', 'ubuntu-latest')).toEqual([
      'patch jobs.t now runs on [ubuntu-latest] instead of [self-hosted, gpu]',
    ]);
    expect(grade('[Self-Hosted, GPU]', '[gpu, self-hosted]')).toEqual([]);
  });

  it('grades runners chosen at run time as an uncertain major', () => {
    expect(grade('ubuntu-latest', '${{ inputs.runner }}')).toEqual([
      'major? jobs.t now runs on [${{ inputs.runner }}], chosen at run time; callers without such a runner never start it',
    ]);
    expect(grade('${{ inputs.runner }}', '${{ inputs.runner }}')).toEqual([]);
  });

  it('grades a new job, and the jobs of a called workflow, the same way', () => {
    const two = `${on('ubuntu-latest')}  gpu:\n    runs-on: [self-hosted, gpu]\n    steps: [{ run: 'true' }]\n`;
    expect(summary(changes({ [`${WF}/r.yml`]: on('ubuntu-latest') }, { [`${WF}/r.yml`]: two }))).toContain(
      'major jobs.gpu now needs a runner with [self-hosted, gpu]; callers without one never start it',
    );
    const caller = (inner: string) => ({
      [`${WF}/r.yml`]: 'on:\n  workflow_call:\njobs:\n  c:\n    uses: ./.github/workflows/_inner.yml\n',
      [`${WF}/_inner.yml`]: inner,
    });
    expect(summary(changes(caller(on('ubuntu-latest')), caller(on('[self-hosted]'))))).toEqual([
      'major jobs.c › t now needs a runner with [self-hosted]; callers without one never start it',
    ]);
  });
});

describe('environments', () => {
  const wf = (env: string) =>
    `on:\n  workflow_call:\n    inputs:\n      env: { type: string, required: false }\njobs:\n  deploy:\n${env ? `    environment: ${env}\n` : ''}    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n`;
  const grade = (before: string, after: string) =>
    summary(changes({ [`${WF}/r.yml`]: wf(before) }, { [`${WF}/r.yml`]: wf(after) }));
  const applies = `callers' environment of that name, its protection rules and secrets now apply (GitHub creates it when missing)`;

  it('grades a job that gains, changes or loses its environment as minor', () => {
    expect(grade('', 'production')).toEqual([
      `minor jobs.deploy now uses environment "production"; ${applies}`,
    ]);
    expect(grade('staging', '{ name: production, url: https://x }')).toEqual([
      `minor jobs.deploy now uses environment "production" instead of "staging"; ${applies}`,
    ]);
    expect(grade('production', '')).toEqual([
      `minor jobs.deploy no longer uses environment "production"; its protection rules and secrets no longer apply to callers' runs`,
    ]);
  });

  it('is uncertain for a name chosen at run time, and ignores the url or the letter case', () => {
    expect(grade('production', '${{ inputs.env }}')).toEqual([
      `minor? jobs.deploy now uses environment "\${{ inputs.env }}" instead of "production"; ${applies}`,
    ]);
    expect(grade('production', '{ name: Production, url: https://y }')).toEqual([]);
  });
});

describe('implementation', () => {
  const PATCH = "patch jobs or steps changed; what callers' runs do may differ";
  const wf = (steps: string, extra = '') =>
    `on:\n  workflow_call:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps}${extra}`;
  const grade = (before: Record<string, string>, after: Record<string, string>) =>
    summary(withImplementation(before, after));

  it('grades changed jobs or steps as a patch when nothing else is graded', () => {
    expect(
      grade(
        { [`${WF}/r.yml`]: wf('      - run: make\n') },
        { [`${WF}/r.yml`]: wf('      - run: make test\n') },
      ),
    ).toEqual([PATCH]);
    expect(
      grade(
        { [`${WF}/r.yml`]: wf('      - run: make\n      - run: test\n') },
        { [`${WF}/r.yml`]: wf('      - run: make\n') },
      ),
    ).toEqual([PATCH]);
  });

  it('counts the local actions and internal workflows a unit runs', () => {
    const viaAction = (run: string) => ({
      [`${WF}/r.yml`]: wf('      - uses: ./.github/actions/pack\n'),
      '.github/actions/pack/action.yml': `name: p\ndescription: d\nruns:\n  using: composite\n  steps:\n    - run: ${run}\n      shell: bash\n`,
    });
    expect(grade(viaAction('make'), viaAction('make dist'))).toEqual([PATCH]);
  });

  it('ignores comments, formatting, key order and the interface, and gives way to other graded changes', () => {
    const before = wf('      - run: make\n        shell: bash\n');
    expect(
      grade(
        { [`${WF}/r.yml`]: before },
        { [`${WF}/r.yml`]: `# build\n${wf('      - { shell: bash, run: make }   # same step\n')}` },
      ),
    ).toEqual([]);
    expect(
      summary(
        withImplementation(
          { [`${WF}/r.yml`]: before },
          {
            [`${WF}/r.yml`]: wf(
              '      - run: make\n        shell: bash\n',
              '  gpu:\n    runs-on: [self-hosted]\n    steps: [{ run: x }]\n',
            ),
          },
        ),
      ),
    ).not.toContain(PATCH);
  });
});

describe('artifacts', () => {
  const upload = (name?: string) =>
    `      - uses: actions/upload-artifact@v4\n        with:\n${name === undefined ? '' : `          name: ${name}\n`}          path: dist\n`;
  const wf = (...steps: string[]) =>
    `on:\n  workflow_call:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n${steps.join('')}`;
  const grade = (before: string, after: string) =>
    summary(changes({ [`${WF}/r.yml`]: before }, { [`${WF}/r.yml`]: after }));

  it('grades an artifact no longer uploaded as major', () => {
    expect(grade(wf(upload('dist'), upload('docs')), wf(upload('docs')))).toEqual([
      `major no longer uploads artifact "dist"; callers' jobs that download it fail`,
    ]);
    expect(grade(wf(upload('dist')), wf(upload('build-output')))).toEqual([
      `major no longer uploads artifact "dist"; callers' jobs that download it fail`,
    ]);
    // Without name:, upload-artifact uploads "artifact".
    expect(grade(wf(upload()), wf(upload('dist')))).toEqual([
      `major no longer uploads artifact "artifact"; callers' jobs that download it fail`,
    ]);
  });

  it('points at the unit’s own upload step', () => {
    const [c] = changes({ [`${WF}/r.yml`]: wf(upload('dist')) }, { [`${WF}/r.yml`]: wf(upload('pkg')) });
    expect(c?.loc).toMatchObject({ file: `${WF}/r.yml`, line: 8 });
  });

  it('is uncertain where a name is now chosen at run time, and does not grade new artifacts', () => {
    expect(grade(wf(upload('dist')), wf(upload('dist-${{ inputs.os }}')))).toEqual([
      `major? no longer uploads artifact "dist"; callers' jobs that download it fail`,
    ]);
    expect(grade(wf(upload('dist')), wf(upload('dist'), upload('docs')))).toEqual([]);
  });

  it('counts the uploads of the local actions and workflows a unit runs', () => {
    const viaAction = (name: string) => ({
      [`${WF}/r.yml`]: wf('      - uses: ./.github/actions/pack\n'),
      '.github/actions/pack/action.yml': `name: p\ndescription: d\nruns:\n  using: composite\n  steps:\n${upload(name).replaceAll('      ', '    ')}`,
    });
    expect(summary(changes(viaAction('dist'), viaAction('pkg')))).toEqual([
      `major no longer uploads artifact "dist"; callers' jobs that download it fail`,
    ]);
    const viaCall = (inner: string) => ({
      [`${WF}/r.yml`]: 'on:\n  workflow_call:\njobs:\n  c:\n    uses: ./.github/workflows/_build.yml\n',
      [`${WF}/_build.yml`]: inner,
    });
    expect(summary(changes(viaCall(wf(upload('dist'))), viaCall(wf())))).toEqual([
      `major no longer uploads artifact "dist"; callers' jobs that download it fail`,
    ]);
  });
});

describe('output reliability', () => {
  /** A reusable workflow whose output `v` comes from step `m` of job `build`, with `jobIf` and `stepIf` on them. */
  const wf = (jobIf = '', stepIf = '', extraJobs = '', needs = '') =>
    `on:\n  workflow_call:\n    outputs:\n      v: { value: '\${{ jobs.build.outputs.v }}' }\njobs:\n${extraJobs}  build:\n${needs}${jobIf}    runs-on: ubuntu-latest\n    outputs:\n      v: \${{ steps.m.outputs.v }}\n    steps:\n      - id: m\n${stepIf}        run: echo "v=1" >> "$GITHUB_OUTPUT"\n`;
  const grade = (before: string, after: string) =>
    summary(changes({ [`${WF}/r.yml`]: before }, { [`${WF}/r.yml`]: after }));

  it('grades an output set on every run that becomes conditional as a possible major', () => {
    expect(grade(wf(), wf('', "        if: github.event_name == 'push'\n"))).toEqual([
      `major? output "v" is now set only when jobs.build.steps.m runs (if: github.event_name == 'push'); callers that read it on other runs get ''`,
    ]);
    expect(grade(wf(), wf('    if: ${{ inputs.deploy }}\n'))).toEqual([
      `major? output "v" is now set only when jobs.build runs (if: \${{ inputs.deploy }}); callers that read it on other runs get ''`,
    ]);
  });

  it('follows the jobs a job needs, unless its if: calls a status function', () => {
    const gate =
      "  gate:\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n";
    const needs = '    needs: gate\n';
    expect(grade(wf('', '', gate), wf('', '', gate, needs))).toEqual([
      `major? output "v" is now set only when jobs.gate runs (if: github.ref == 'refs/heads/main'); callers that read it on other runs get ''`,
    ]);
    expect(grade(wf('', '', gate), wf('    if: always()\n', '', gate, needs))).toEqual([]);
  });

  it('does not grade conditions that hold on every run, or outputs that were already conditional', () => {
    for (const cond of ['always()', 'success()', "${{ true || github.ref == 'x' }}", '${{ !cancelled() }}'])
      expect(grade(wf(), wf('', `        if: ${cond}\n`))).toEqual([]);
    const pushOnly = wf('', "        if: github.event_name == 'push'\n");
    expect(grade(pushOnly, wf('', "        if: github.event_name != 'pull_request'\n"))).toEqual([]);
    // Back to every run is not a break.
    expect(grade(pushOnly, wf())).toEqual([]);
  });

  it('follows a called reusable workflow, and a published action', () => {
    const caller = (inner: string) => ({
      [`${WF}/r.yml`]:
        "on:\n  workflow_call:\n    outputs:\n      v: { value: '${{ jobs.c.outputs.v }}' }\njobs:\n  c:\n    uses: ./.github/workflows/_inner.yml\n",
      [`${WF}/_inner.yml`]: inner,
    });
    expect(summary(changes(caller(wf()), caller(wf('', '        if: inputs.x\n'))))).toEqual([
      `major? output "v" is now set only when jobs.c › jobs.build.steps.m runs (if: inputs.x); callers that read it on other runs get ''`,
    ]);
    const action = (stepIf: string) =>
      `name: a\ndescription: d\noutputs:\n  v: { description: d, value: '\${{ steps.m.outputs.v }}' }\nruns:\n  using: composite\n  steps:\n    - id: m\n${stepIf}      run: echo "v=1" >> "$GITHUB_OUTPUT"\n      shell: bash\n`;
    expect(
      summary(changes({ 'action.yml': action('') }, { 'action.yml': action('      if: inputs.on\n') })),
    ).toEqual([
      `major? output "v" is now set only when steps.m runs (if: inputs.on); callers that read it on other runs get ''`,
    ]);
  });
});

const pre = (bumpMinorPreMajor: boolean, bumpPatchForMinorPreMajor = false) => ({
  bumpMinorPreMajor,
  bumpPatchForMinorPreMajor,
});

describe('declared impact', () => {
  it.each([
    ['feat!: drop the old input', 'major'],
    ['fix(ci)!: rename the check', 'major'],
    ['feat: add an input', 'minor'],
    ['fix: typo', 'patch'],
    ['perf: faster', 'patch'],
    ['chore: tidy', 'none'],
    ['Update ci.yml', undefined],
  ])('reads %j as %s', (title, level) => {
    expect(levelFromTitle(title, DEFAULT_IMPACT_POLICY.types)).toBe(level);
  });

  it('reads version bumps, honouring bump-minor-pre-major', () => {
    expect(levelFromVersions('0.2.0', '0.3.0', pre(true))).toBe('major');
    expect(levelFromVersions('0.2.0', '0.3.0', pre(false))).toBe('minor');
    expect(levelFromVersions('0.2.0', '0.2.1', pre(true))).toBe('patch');
    expect(levelFromVersions('0.2.0', '0.2.1', pre(true, true))).toBe('minor');
    expect(levelFromVersions('1.4.2', '2.0.0', pre(true))).toBe('major');
    expect(levelFromVersions('1.4.2', '1.4.3', pre(true))).toBe('patch');
  });

  const major: ImpactChange = {
    unit: 'u',
    kind: 'interface',
    level: 'major',
    certain: true,
    message: 'm',
    loc: { file: 'f', line: 1, column: 1, endLine: 1, endColumn: 1 },
  };
  const patch: ImpactChange = { ...major, level: 'patch' };
  const verdict = (cs: ImpactChange[], d: DeclaredInput, policy = DEFAULT_IMPACT_POLICY) =>
    impactVerdict(cs, d, policy);

  it('fails an under-declared change, not an over-declared one', () => {
    expect(verdict([major], { title: 'fix: x' }).ok).toBe(false);
    expect(verdict([major], { title: 'fix!: x' }).ok).toBe(true);
    expect(verdict([patch], { title: 'feat!: x' }).ok).toBe(true);
    // patch vs none: the change ships with the next release anyway
    expect(verdict([patch], { title: 'chore: x' }).ok).toBe(true);
  });

  it('uses one authoritative source and flags a higher advisory one', () => {
    const v = verdict([major], { title: 'fix: x', labels: ['semver:major'] });
    expect(v.declared?.kind).toBe('title');
    expect(v.conflict?.kind).toBe('labels');
    expect(v.ok).toBe(false);
    const byLabels = verdict(
      [major],
      { title: 'fix: x', labels: ['semver:major'] },
      { ...DEFAULT_IMPACT_POLICY, declaredBy: 'labels' },
    );
    expect(byLabels.declared?.kind).toBe('labels');
    expect(byLabels.ok).toBe(true);
    expect(verdict([major], { explicit: 'major', title: 'fix: x' }).declared?.kind).toBe('explicit');
  });

  it('treats a non-Conventional title as undeclared, and counts uncertain changes only on request', () => {
    expect(verdict([major], { title: 'Update ci.yml' }).declared).toBeUndefined();
    const uncertain = { ...major, certain: false };
    expect(verdict([uncertain], { title: 'fix: x' }).required).toBe('none');
    expect(
      verdict([uncertain], { title: 'fix: x' }, { ...DEFAULT_IMPACT_POLICY, uncertain: 'fail' }).ok,
    ).toBe(false);
  });
});

describe('impact rules', () => {
  const before = { [`${WF}/r.yml`]: reusable(job('test', '    name: Test\n')) };
  const after = { [`${WF}/r.yml`]: reusable(job('test', '    name: Unit tests\n')) };
  const run = (declared: DeclaredInput, files = after) =>
    analyze({
      root: '/v',
      fs: memoryFileSystem(files),
      validateSchema: false,
      repository: 'a/b',
      impact: {
        base: index(before),
        baseline: { kind: 'ref', ref: 'main', commit: 'abc' },
        declared,
        policy: DEFAULT_IMPACT_POLICY,
      },
    });

  it('reports FP810 for an under-declared change and FP813 when nothing is declared', () => {
    expect(codes(run({ title: 'fix: x' }))).toContain('FP810');
    expect(codes(run({}))).toContain('FP813');
    expect(codes(run({ title: 'fix!: x' })).filter((c) => /^FP81/.test(c))).toEqual([]);
    expect(codes(run({ title: 'fix: x', labels: ['semver:major'] }))).toEqual(
      expect.arrayContaining(['FP810', 'FP811']),
    );
    expect(codes(run({ title: 'fix!: x' }, before))).toContain('FP812');
  });

  it('has no impact findings without impact mode, and the result carries the verdict', () => {
    const r = analyze({ root: '/v', fs: memoryFileSystem(after), validateSchema: false, repository: 'a/b' });
    expect(codes(r).filter((c) => /^FP81/.test(c))).toEqual([]);
    expect(run({ title: 'fix: x' }).impact?.verdict).toMatchObject({ required: 'major', ok: false });
  });
});

describe('review fixes', () => {
  const wf = (body: string, inputs = '    inputs: {}\n') => `on:\n  workflow_call:\n${inputs}jobs:\n${body}`;

  it('resolves pass-through inputs and does not invent defaults for unknown values', () => {
    const inner = (def: string) =>
      wf(
        job('b', '    name: Build ${{ inputs.flavor }}\n'),
        `    inputs:\n      flavor: { type: string, default: ${def} }\n`,
      );
    const caller = (withValue: string, def = 'fast') =>
      wf(
        `  call:\n    uses: ./.github/workflows/inner.yml\n    with:\n      flavor: ${withValue}\n`,
        `    inputs:\n      flavor: { type: string, default: ${def} }\n`,
      );
    const publish = ['.github/workflows/reuse.yml'];
    // The caller always passes the event name: the inner default no longer matters.
    expect(
      changes(
        { [`${WF}/reuse.yml`]: caller('${{ github.event_name }}'), [`${WF}/inner.yml`]: inner('slow') },
        { [`${WF}/reuse.yml`]: caller('${{ github.event_name }}'), [`${WF}/inner.yml`]: inner('slower') },
        publish,
      ).filter((c) => c.certain),
    ).toEqual([]);
    // A pass-through of a consumer's input: the name depends on the consumer, not on the default.
    const cs = changes(
      { [`${WF}/reuse.yml`]: caller('${{ inputs.flavor }}', 'fast'), [`${WF}/inner.yml`]: inner('x') },
      { [`${WF}/reuse.yml`]: caller('${{ inputs.flavor }}', 'quick'), [`${WF}/inner.yml`]: inner('x') },
      publish,
    );
    expect(cs.filter((c) => c.kind === 'check-name' && c.certain)).toEqual([]);
  });

  it('a rename stays certain when the matrix is computed at runtime', () => {
    const t = (name: string) =>
      wf(
        job(
          't',
          `    name: ${name}\n    strategy:\n      matrix:\n        os: \${{ fromJSON(inputs.oses) }}\n`,
        ),
        `    inputs:\n      oses: { type: string, default: '["a"]' }\n`,
      );
    expect(summary(changes({ [`${WF}/r.yml`]: t('Test') }, { [`${WF}/r.yml`]: t('Tests') }))).toEqual([
      'major check "… / Test (…)" is now "… / Tests (…)"; consumers that require the old name wait forever',
    ]);
  });

  it('a job id rename that keeps the check name is not a change', () => {
    expect(
      changes(
        { [`${WF}/r.yml`]: wf(job('old', '    name: Test\n')) },
        { [`${WF}/r.yml`]: wf(job('new', '    name: Test\n')) },
      ),
    ).toEqual([]);
  });

  it('checks permissions per job, also when another job inherits, and in called workflows', () => {
    expect(
      summary(
        changes(
          { [`${WF}/r.yml`]: wf(job('test') + job('deploy')) },
          { [`${WF}/r.yml`]: wf(job('test') + job('deploy', '    permissions: { id-token: write }\n')) },
        ),
      ),
    ).toEqual([
      'major? jobs.deploy now requests id-token: write; callers that grant less fail when the run starts',
    ]);
    const reuse = `${wf('  call:\n    uses: ./.github/workflows/inner.yml\n')}`;
    const inner = (p: string) => `on: workflow_call\npermissions: ${p}\njobs:\n${job('j')}`;
    expect(
      summary(
        changes(
          { [`${WF}/reuse.yml`]: reuse, [`${WF}/inner.yml`]: inner('{ contents: read }') },
          { [`${WF}/reuse.yml`]: reuse, [`${WF}/inner.yml`]: inner('{ contents: read, id-token: write }') },
          ['.github/workflows/reuse.yml'],
        ),
      ),
    ).toEqual([
      'major jobs.call › j now requests id-token: write; callers that grant less fail when the run starts',
    ]);
  });

  it('follows $/ calls, and does not count $/ or workspace paths as third-party actions', () => {
    const reuse = `${wf('  call:\n    uses: $/.github/workflows/inner.yml\n')}`;
    const inner = (p: string) => `on: workflow_call\npermissions: ${p}\njobs:\n${job('j')}`;
    expect(
      summary(
        changes(
          { [`${WF}/reuse.yml`]: reuse, [`${WF}/inner.yml`]: inner('{ contents: read }') },
          { [`${WF}/reuse.yml`]: reuse, [`${WF}/inner.yml`]: inner('{ contents: read, id-token: write }') },
          ['.github/workflows/reuse.yml'],
        ),
      ),
    ).toEqual([
      'major jobs.call › j now requests id-token: write; callers that grant less fail when the run starts',
    ]);
    const action = (steps: string) =>
      `name: a\ndescription: d\nruns:\n  using: composite\n  steps:\n    - run: x\n      shell: bash\n${steps}`;
    const helper = 'name: h\ndescription: d\nruns:\n  using: composite\n  steps: []\n';
    expect(
      changes(
        { 'tools/a/action.yml': action(''), 'tools/h/action.yml': helper },
        {
          'tools/a/action.yml': action('    - uses: $/tools/h\n    - uses: ./../elsewhere/h\n'),
          'tools/h/action.yml': helper,
        },
        ['tools/a'],
      ),
    ).toEqual([]);
  });

  it('does not grade workflow_dispatch inputs, and reports a published unit that stops parsing', () => {
    const both = (opts: string) =>
      `on:\n  workflow_call:\n  workflow_dispatch:\n    inputs:\n      env: { type: choice, options: [${opts}] }\njobs:\n${job('t')}`;
    expect(
      changes({ [`${WF}/r.yml`]: both('dev, prod, staging') }, { [`${WF}/r.yml`]: both('dev, prod') }),
    ).toEqual([]);
    const broken = changes(
      { [`${WF}/r.yml`]: wf(job('t')) },
      { [`${WF}/r.yml`]: 'on: [workflow_call\njobs: {' },
    );
    expect(broken.map((c) => [c.level, c.certain, c.kind])).toEqual([['major', true, 'unit']]);
  });

  it('treats _-prefixed reusable workflows as internal and keeps a unit that still exists', () => {
    expect(
      changes(
        { [`${WF}/_build.yml`]: wf(job('t', '    name: Compile\n')) },
        { [`${WF}/_build.yml`]: wf(job('t', '    name: Build\n')) },
      ),
    ).toEqual([]);
    const action = 'name: a\ndescription: d\nruns:\n  using: node24\n  main: index.js\n';
    const base = index({ 'actions/setup/action.yml': action }, ['actions/*']);
    const head = index({ 'actions/setup/action.yml': action });
    expect(
      impactChanges(base, head, { publish: ['actions/*'] }, (f) => f === 'actions/setup/action.yml'),
    ).toEqual([]);
  });

  it('lets **/ match no directory, so the root action is published by **/action.yml', () => {
    const action = (using: string) => `name: a\ndescription: d\nruns:\n  using: ${using}\n  main: index.js\n`;
    expect(
      summary(
        changes({ 'action.yml': action('node20') }, { 'action.yml': action('node24') }, ['**/action.yml']),
      ),
    ).toHaveLength(1);
  });

  it('reports an interface change at the declaration it names', () => {
    const action = (extra: string) =>
      `name: a\ndescription: d\ninputs:\n  a: { description: x }\n${extra}runs:\n  using: node24\n  main: index.js\n`;
    const [added] = changes(
      { 'action.yml': action('') },
      { 'action.yml': action('  b: { description: y }\n') },
    );
    expect(added?.loc).toMatchObject({ file: 'action.yml', line: 5 });
  });

  it('keeps labels advisory when the title is not a Conventional Commit', () => {
    const major = changes(
      { [`${WF}/r.yml`]: wf(job('t', '    name: A\n')) },
      { [`${WF}/r.yml`]: wf(job('t', '    name: B\n')) },
    );
    const v = impactVerdict(
      major,
      { title: 'Update ci.yml', labels: ['semver:major'] },
      DEFAULT_IMPACT_POLICY,
    );
    expect(v.declared).toBeUndefined();
    expect(v.ok).toBe(true);
  });
});

describe('paths narrow impact mode', () => {
  const action = (name: string, inputs = '') =>
    `name: ${name}\ndescription: d\n${inputs}runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo "${inputs ? '${{ inputs.token }}' : 'hi'}"\n`;
  const token = 'inputs:\n  token: { description: t, required: false }\n';
  const publish = ['*/action.yml'];
  const config = parseConfig({ impact: { publish } });
  /** Base: actions a and b, both with an input; the head removes b's input (a major change), or b itself. */
  const base = { 'a/action.yml': action('a', token), 'b/action.yml': action('b', token) };
  const changed = { 'a/action.yml': action('a', token), 'b/action.yml': action('b') };
  const run = (head: Record<string, string>, paths?: string[]) =>
    analyze({
      root: '/v',
      fs: memoryFileSystem(head),
      config,
      validateSchema: false,
      repository: 'a/b',
      ...(paths ? { paths } : {}),
      impact: {
        base: index(base, publish),
        baseline: { kind: 'ref', ref: 'main', commit: 'abc' },
        declared: { explicit: 'patch' },
        policy: { ...DEFAULT_IMPACT_POLICY, publish },
      },
    });

  it('grades only the published units within the paths, so the verdict and the findings agree', () => {
    const a = run(changed, ['a']);
    expect(a.impact?.changes).toEqual([]);
    expect(a.impact?.verdict).toMatchObject({ required: 'none', ok: true });
    expect(a.impact?.scope).toEqual({ paths: ['a'], units: ['a'] });
    expect(a.impact?.narrowed).toEqual({ anchor: 'a/action.yml', ignored: [] });
    expect(a.impact?.publishedFiles).toEqual(['a/action.yml']);
    expect(codes(a)).toEqual(['FP812']);

    const b = run(changed, ['b/action.yml']);
    expect(b.impact?.verdict).toMatchObject({ required: 'major', ok: false });
    expect(b.impact?.scope).toMatchObject({ paths: ['b/action.yml'], units: ['b'] });
    expect(codes(b)).toContain('FP810');
  });

  it('grades every published unit without paths, or with the whole repository', () => {
    for (const r of [run(changed), run(changed, ['.']), run(changed, ['/v'])]) {
      expect(r.impact?.scope).toBeUndefined();
      expect(r.impact?.verdict.required).toBe('major');
      expect(r.impact?.publishedFiles).toEqual(['a/action.yml', 'b/action.yml']);
    }
  });

  it('grades a unit the head removed when its baseline path is within the paths, and reports nothing else', () => {
    const removed = run({ 'a/action.yml': action('a', token) }, ['b']);
    expect(removed.impact?.changes.map((c) => [c.unit, c.kind, c.level])).toEqual([['b', 'unit', 'major']]);
    expect(removed.impact?.scope).toEqual({ paths: ['b'], units: ['b'] });
    expect(removed.removedPaths).toEqual(['b']);
    // The working tree has nothing at the path, so only impact mode reports: FP810, about b.
    expect(removed.findings.map((f) => [f.code, f.loc.file])).toEqual([['FP810', 'b/action.yml']]);
  });

  it('does not grade units within the paths that are not published', () => {
    const ci = `on: push\njobs:\n${job('t')}`;
    const r = run({ ...changed, [`${WF}/ci.yml`]: ci }, [`${WF}/ci.yml`]);
    expect(r.impact?.scope).toEqual({ paths: [`${WF}/ci.yml`], units: [] });
    expect(r.impact?.narrowed?.anchor).toBe(`${WF}/ci.yml`);
    expect(r.impact?.verdict).toMatchObject({ required: 'none', ok: true });
    expect(r.impact?.changes).toEqual([]);
  });

  it('reports the verdict on a file within the paths when none of them holds a published unit', () => {
    // 0.14 and the first cut placed FP811-FP813 on the root action.yml: outside the paths, and here missing.
    const ci = `on: push\njobs:\n${job('t')}`;
    const head = { ...changed, [`${WF}/ci.yml`]: ci, [`${WF}/docs.yml`]: ci };
    const r = run(head, [WF]);
    expect(r.impact?.verdict).toMatchObject({ required: 'none', ok: true });
    expect(r.findings.map((f) => `${f.code}@${f.loc.file}`)).toEqual([`FP812@${WF}/ci.yml`]);
    // Within the paths, a published unit graded in the working tree comes first.
    expect(run(head, [WF, 'a']).findings.map((f) => f.loc.file)).toEqual(['a/action.yml']);
  });

  it('does not run impact mode on paths that hold nothing to grade or report on', () => {
    // The paths name only an unpublished workflow the change removed: nothing within them is left to report on.
    const ci = `on: push\njobs:\n${job('t')}`;
    const base = { 'a/action.yml': action('a', token), [`${WF}/ci.yml`]: ci };
    const r = analyze({
      root: '/v',
      fs: memoryFileSystem({ 'a/action.yml': action('a', token) }),
      config,
      validateSchema: false,
      repository: 'a/b',
      paths: [`${WF}/ci.yml`],
      impact: {
        base: index(base, publish),
        baseline: { kind: 'ref', ref: 'main', commit: 'abc' },
        declared: { title: 'fix: x', labels: ['semver:major'] },
        policy: { ...DEFAULT_IMPACT_POLICY, publish },
      },
    });
    expect(r.impact).toBeUndefined();
    expect(r.impactSkipped).toBe('nothing within the paths to grade or to report on');
    expect(r.removedPaths).toEqual([`${WF}/ci.yml`]);
    expect(r.findings).toEqual([]);
  });

  it('knows a removed path also beside the whole repository', () => {
    const removed = run({ 'a/action.yml': action('a', token) }, ['.', 'b']);
    expect(removed.removedPaths).toEqual(['b']);
    expect(removed.impact?.scope).toBeUndefined();
    expect(removed.impact?.verdict.required).toBe('major');
  });

  it('reports on nothing else when every path is one the working tree lacks', () => {
    // Impact mode skipped (no baseline here): the paths still narrow the report, to nothing, instead of widening it to
    // the whole repository, where c has a finding (an empty `inputs:`).
    const fs = memoryFileSystem({ ...changed, 'c/action.yml': action('c', 'inputs:\n') });
    const lint = (paths?: string[]) =>
      analyze({
        root: '/v',
        fs,
        config,
        validateSchema: false,
        repository: 'a/b',
        ...(paths ? { paths } : {}),
      });
    expect(lint().findings.length).toBeGreaterThan(0);
    const gone = lint(['gone']);
    expect(gone.project.missingTargets).toEqual(['gone']);
    expect(gone.findings).toEqual([]);
  });

  it('grades only the given units in impactChanges', () => {
    const all = impactChanges(index(base, publish), index(changed, publish), { publish });
    expect(all.map((c) => c.unit)).toEqual(['b']);
    expect(
      impactChanges(index(base, publish), index(changed, publish), { publish }, undefined, new Set(['a'])),
    ).toEqual([]);
  });
});

describe('ignore leaves units out of impact mode', () => {
  const action = (name: string, inputs = '') =>
    `name: ${name}\ndescription: d\n${inputs}runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo "${inputs ? '${{ inputs.token }}' : 'hi'}"\n`;
  const token = 'inputs:\n  token: { description: t, required: false }\n';
  const publish = ['*/action.yml'];
  /** Base: published actions a and b with an input; the head removes b's input, a major change. */
  const base = { 'a/action.yml': action('a', token), 'b/action.yml': action('b', token) };
  const head = { 'a/action.yml': action('a', token), 'b/action.yml': action('b') };
  const ci = `on: push\njobs:\n${job('t')}`;
  /**
   * `ignore` is the baseline config's, which impact mode reads; `own` the pull request's (the checked-out config), and
   * `ignoreAfterMerge` the pull request's as its commits have it, where that differs. The head may hold more files
   * (`extra`).
   */
  const run = (
    ignore: string[],
    declared: DeclaredInput,
    paths?: string[],
    own: string[] = ignore,
    extra: Record<string, string> = {},
    onlyIfPublished = false,
    ignoreAfterMerge?: string[],
  ) =>
    analyze({
      root: '/v',
      fs: memoryFileSystem({ ...head, ...extra }),
      config: parseConfig({ ignore: own, impact: { publish } }),
      validateSchema: false,
      repository: 'a/b',
      ...(paths ? { paths } : {}),
      impact: {
        base: index(base, publish),
        baseline: { kind: 'ref', ref: 'main', commit: 'abc' },
        declared,
        policy: { ...DEFAULT_IMPACT_POLICY, publish },
        ignore,
        ...(onlyIfPublished ? { onlyIfPublished } : {}),
        ...(ignoreAfterMerge ? { ignoreAfterMerge } : {}),
      },
    });
  const located = (r: ReturnType<typeof run>) => r.findings.map((f) => `${f.code}@${f.loc.file}`);
  const ADDED_B =
    'this pull request changes what ignore leaves out of impact mode (b); that applies after it is merged';

  it('does not grade a published unit whose file is ignored, so the verdict and the findings agree', () => {
    // 0.14 graded b anyway: "required major, ok: false" with the FP810 about b dropped by ignore, and exit 0.
    const r = run(['b/**'], { explicit: 'patch' });
    expect(r.impact?.changes).toEqual([]);
    expect(r.impact?.verdict).toMatchObject({ required: 'none', ok: true });
    expect(r.impact?.publishedFiles).toEqual(['a/action.yml']);
    expect(located(r)).toEqual(['FP812@a/action.yml']);
    // With paths too; paths that hold only ignored files leave nothing to report on.
    expect(run(['b/**'], { explicit: 'patch' }, ['a', 'b']).impact?.verdict).toMatchObject({
      required: 'none',
    });
    expect(run(['b/**'], { explicit: 'patch' }, ['b']).impactSkipped).toBeDefined();
    // Not ignored, b is graded as before.
    expect(run([], { explicit: 'patch' }).impact?.verdict).toMatchObject({ required: 'major', ok: false });
  });

  it("leaves a unit out only when both the baseline's and the pull request's ignore match it", () => {
    // A pull request that breaks b and adds b/** to ignore is still graded for b; the edit applies once merged.
    const added = run([], { explicit: 'patch' }, undefined, ['b/**']);
    expect(added.impact?.verdict).toMatchObject({ required: 'major', ok: false });
    expect(located(added)).toEqual(['FP810@b/action.yml']);
    expect(added.impactNotes).toEqual([ADDED_B]);
    // Before: a pull request that broke b and took it out of the baseline's ignore graded nothing and passed, where
    // 0.14 failed with FP810. Taken out of ignore, b is graded at once, so nothing waits for the merge to be noted.
    const removed = run(['b/**'], { explicit: 'patch' }, undefined, []);
    expect(removed.impact?.verdict).toMatchObject({ required: 'major', ok: false });
    expect(located(removed)).toEqual(['FP810@b/action.yml']);
    expect(removed.impact?.narrowed).toBeUndefined();
    expect(removed.impactNotes).toBeUndefined();
    // With paths that hold b too.
    expect(located(run(['b/**'], { explicit: 'patch' }, ['b'], []))).toEqual(['FP810@b/action.yml']);
    // Different patterns that both match b leave it out, and only it.
    const both = run(['*/action.yml'], { explicit: 'patch' }, undefined, ['b/**']);
    expect(both.impact?.verdict).toMatchObject({ required: 'none', ok: true });
    expect(both.impact?.narrowed).toEqual({ ignored: ['b'], anchor: 'a/action.yml' });
    expect(both.impactNotes).toBeUndefined();
    // Only an edit that adds a published unit within the paths is noted: here b is not within them.
    expect(run([], { explicit: 'patch' }, ['a'], ['x/**']).impactNotes).toBeUndefined();
    expect(run([], { explicit: 'patch' }, ['a'], ['b/**']).impactNotes).toBeUndefined();
  });

  /** b/action.yml becomes b/action.yaml and loses its input; the baseline ignores `ignore`, the pull request `own`. */
  const moved = (ignore: string[], own: string[]) => {
    const both = ['*/action.yml', '*/action.yaml'];
    return analyze({
      root: '/v',
      fs: memoryFileSystem({ 'a/action.yml': action('a', token), 'b/action.yaml': action('b') }),
      config: parseConfig({ ignore: own, impact: { publish: both } }),
      validateSchema: false,
      repository: 'a/b',
      impact: {
        base: index(base, both),
        baseline: { kind: 'ref', ref: 'main', commit: 'abc' },
        declared: { explicit: 'patch' },
        policy: { ...DEFAULT_IMPACT_POLICY, publish: both },
        ignore,
      },
    });
  };

  it('names a unit as left out by ignore only when no file of it is graded', () => {
    // Both sides ignore b/action.yml, which no longer matches.
    const r = moved(['b/action.yml'], ['b/action.yml']);
    expect(r.impact?.verdict).toMatchObject({ required: 'major', ok: false });
    expect(r.impact?.changes.map((c) => c.unit)).toContain('b');
    expect(located(r)).toEqual(['FP810@b/action.yaml']);
    // Before: ['b'] as well, so the report said both "major b" and "left out by ignore: b".
    expect(r.impact?.narrowed?.ignored).toEqual([]);
  });

  it('notes an ignore edit only for a unit it leaves out once merged, every file it has then', () => {
    // The pull request adds the old file to ignore, which matches no file of b once merged.
    const old = moved([], ['b/action.yml']);
    expect(located(old)).toEqual(['FP810@b/action.yaml']);
    // Before: "this pull request changes what ignore leaves out of impact mode (b); that applies after it is merged".
    expect(old.impactNotes).toBeUndefined();
    // Adding the new file leaves b out once merged; so does adding it where the baseline ignores the old one.
    expect(moved([], ['b/action.yml', 'b/action.yaml']).impactNotes).toEqual([ADDED_B]);
    expect(moved(['b/action.yml'], ['b/action.yml', 'b/action.yaml']).impactNotes).toEqual([ADDED_B]);
    // Adding only the new file does too, as the old one is gone once merged. Before: no note, as 0.15.0 had.
    const added = moved([], ['b/action.yaml']);
    expect(located(added)).toEqual(['FP810@b/action.yaml']);
    expect(added.impactNotes).toEqual([ADDED_B]);
    expect(moved([], ['**/*.yaml']).impactNotes).toEqual([ADDED_B]);
  });

  it("goes by the pull request's commits where their ignore differs from the working tree's", () => {
    // A base config in a submodule checked out at another commit than the pull request records: the working tree's
    // ignores b, the recorded one does not, so b is graded and nothing applies once merged. Before: the note.
    const local = run([], { explicit: 'patch' }, undefined, ['b/**'], {}, false, []);
    expect(local.impact?.verdict).toMatchObject({ required: 'major', ok: false });
    expect(local.impactNotes).toBeUndefined();
    // The baseline's and the working tree's ignore b, the recorded one does not: the pull request takes b out of
    // ignore, so b is graded. Before: left out, "required none, ok: true".
    const out = run(['b/**'], { explicit: 'patch' }, undefined, ['b/**'], {}, false, []);
    expect(out.impact?.verdict).toMatchObject({ required: 'major', ok: false });
    expect(out.impact?.narrowed).toBeUndefined();
    expect(out.impactNotes).toBeUndefined();
    // The recorded one ignores b, the working tree's does not: graded, and left out once merged.
    expect(run([], { explicit: 'patch' }, undefined, [], {}, false, ['b/**']).impactNotes).toEqual([ADDED_B]);
  });

  it('reports a failing verdict on a file ignore leaves in when it leaves out every published unit', () => {
    // Nothing graded: a conflict between the declarations still fails, and its finding must say so, on a file that
    // exists. Before: on the root action.yml, which this repository does not have.
    const conflict = { title: 'fix: x', labels: ['semver:major'] };
    const r = run(['*/action.yml'], conflict, undefined, undefined, { [`${WF}/ci.yml`]: ci });
    expect(r.impact?.verdict).toMatchObject({ required: 'none', ok: false });
    expect(located(r)).toEqual([`FP811@${WF}/ci.yml`, `FP812@${WF}/ci.yml`]);
    expect(r.impact?.narrowed).toEqual({ anchor: `${WF}/ci.yml`, ignored: ['a', 'b'] });
    expect(r.summary.errors).toBe(1);
    // A published unit that is graded comes first.
    expect(located(run(['b/**'], conflict, undefined, undefined, { [`${WF}/ci.yml`]: ci }))).toEqual([
      'FP811@a/action.yml',
      'FP812@a/action.yml',
    ]);
  });

  it('runs with paths that hold only ignored published units, on a file within them that ignore leaves in', () => {
    // impact: on and the CLI: nothing is graded, the required impact is none, and the declaration is still checked.
    const conflict = { title: 'fix: x', labels: ['semver:major'] };
    const r = run(['b/**'], conflict, ['b', `${WF}/ci.yml`], undefined, { [`${WF}/ci.yml`]: ci });
    expect(r.impact?.verdict).toMatchObject({ required: 'none', ok: false });
    expect(r.impact?.scope).toEqual({ paths: ['b', `${WF}/ci.yml`], units: [] });
    expect(r.impact?.narrowed).toEqual({ anchor: `${WF}/ci.yml`, ignored: ['b'] });
    expect(located(r)).toEqual([`FP811@${WF}/ci.yml`, `FP812@${WF}/ci.yml`]);
    // With no such file within the paths, it is skipped, and says that ignore left everything there out. Before:
    // "nothing within the paths to grade or to report on", which did not name ignore although b is there.
    const only = run(['b/**'], conflict, ['b'], undefined, { [`${WF}/ci.yml`]: ci });
    expect(only.impact).toBeUndefined();
    expect(only.impactSkipped).toBe(
      'every workflow and action within the paths is ignored: nothing to grade or to report on',
    );
    expect(only.findings).toEqual([]);
  });

  it('skips impact mode when ignore leaves out every workflow and action', () => {
    // Before: FP811 and FP812 on the root action.yml, which this repository does not have.
    const r = run(['**'], { title: 'fix: x', labels: ['semver:major'] });
    expect(r.impact).toBeUndefined();
    expect(r.impactSkipped).toBe('every workflow and action is ignored: nothing to grade or to report on');
    expect(r.findings).toEqual([]);
  });

  it('says ignore, not impact.publish, when it leaves out every published unit within the paths', () => {
    const skipped = (ignore: string[], paths: string[]) =>
      run(ignore, { explicit: 'patch' }, paths, undefined, { [`${WF}/ci.yml`]: ci }, true).impactSkipped;
    expect(skipped(['b/**'], ['b'])).toBe(
      'every published workflow or action within the paths is ignored; see ignore',
    );
    expect(skipped([], [`${WF}/ci.yml`])).toBe(
      'no published workflow or action within the paths; see impact.publish',
    );
    expect(skipped(['b/**'], ['a', 'b'])).toBeUndefined();
  });
});
