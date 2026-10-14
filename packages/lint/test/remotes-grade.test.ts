/** The grader of remote version changes (remotes-grade.ts): a verdict per call, explained by the interface diff. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryFileSystem } from '@ciatlas/core';
import {
  gradeRemoteChanges,
  parseConfig,
  type RemoteChange,
  type RemoteChangeGrade,
  type RemoteEntry,
} from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { WF, yaml } from './helpers';

const LOCK = '.github/flowpact/remotes.lock.yaml';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const SHIP = 'octo/ship/.github/workflows/deploy.yml@v1';
const SETUP = 'octo/setup@v2';

const workflow = (e: Partial<RemoteEntry> = {}): RemoteEntry => ({ sha: A, kind: 'workflow', ...e });
const action = (e: Partial<RemoteEntry> = {}): RemoteEntry => ({
  sha: A,
  kind: 'action',
  using: 'composite',
  ...e,
});

/** What a finding is about, as the interface diff names it: `inputs.<name>`, `secrets.<name>` or `outputs.<name>`. */
const aboutOf = (symbol: string | undefined) =>
  /(inputs|secrets|outputs)\.([^.#]+)$/
    .exec(symbol ?? '')
    ?.slice(1)
    .join('.')
    .toLowerCase();

/**
 * The verdict comes from the rules' findings only; the interface diff must explain each finding a change adds, by
 * calling breaking the input, secret or output the finding is about. Checked on every grade these tests make.
 */
function expectAgreement(g: RemoteChangeGrade): void {
  if (!g.changes.length) return; // no earlier entry: nothing to explain with
  const breaking = new Set(g.changes.filter((c) => c.breaking).map((c) => c.path.toLowerCase()));
  for (const call of g.calls)
    for (const f of call.added) expect([...breaking], `${f.code}: ${f.message}`).toContain(aboutOf(f.symbol));
}

function grade(
  files: Record<string, string>,
  changes: RemoteChange[],
  config: Record<string, unknown> = {},
): RemoteChangeGrade[] {
  const grades = gradeRemoteChanges(
    {
      root: '/virtual/repo',
      fs: memoryFileSystem(files),
      config: parseConfig(config),
      validateSchema: false,
      repository: 'acme/repo',
    },
    changes,
  );
  for (const g of grades) expectAgreement(g);
  return grades;
}

const gradeOne = (files: Record<string, string>, change: RemoteChange, config?: Record<string, unknown>) =>
  grade(files, [change], config)[0]!;

/** Each call's verdict, by its job (and step). */
const verdicts = (g: RemoteChangeGrade) =>
  Object.fromEntries(g.calls.map((c) => [[c.call.job, c.call.step].filter(Boolean).join(' '), c.verdict]));

/** A workflow `ci.yml` with these jobs (written without indentation). */
const ci = (jobs: string) => ({
  [`${WF}/ci.yml`]: `on: push\njobs:\n${jobs.replace(/^(?=.)/gm, '  ')}`,
});

describe('inputs', () => {
  it('an input removed breaks the calls that pass it, and only those', () => {
    const files = ci(yaml`
      a:
        uses: ${SHIP}
        with: { env: prod, region: eu }
      b:
        uses: ${SHIP}
        with: { region: eu }
      build:
        runs-on: x
        steps:
          - uses: ${SETUP}
            with: { cache: 'true' }
          - uses: ${SETUP}
    `);
    const wf = gradeOne(files, {
      ref: SHIP,
      before: workflow({ inputs: { env: {}, region: {} } }),
      after: workflow({ inputs: { region: {} } }),
    });
    expect(verdicts(wf)).toEqual({ a: 'breaks', b: 'fits' });
    expect(wf.verdict).toBe('breaks');
    expect(wf.calls[0]!.added.map((f) => [f.code, f.message])).toEqual([
      ['FP102', `${SHIP} has no input "env"`],
    ]);

    const act = gradeOne(files, {
      ref: SETUP,
      before: action({ inputs: { cache: {} } }),
      after: action(),
    });
    expect(verdicts(act)).toEqual({ 'build #1': 'breaks', 'build #2': 'fits' });
  });

  it('a new required input breaks a workflow call even with a default, an action call only without one', () => {
    const files = ci(yaml`
      deploy:
        uses: ${SHIP}
      build:
        runs-on: x
        steps:
          - uses: ${SETUP}
    `);
    const required = { region: { required: true, default: 'eu' } };
    expect(
      gradeOne(files, { ref: SHIP, before: workflow(), after: workflow({ inputs: required }) }).verdict,
    ).toBe('breaks');
    expect(
      gradeOne(files, { ref: SETUP, before: action(), after: action({ inputs: required }) }).verdict,
    ).toBe('fits');
    const noDefault = gradeOne(files, {
      ref: SETUP,
      before: action(),
      after: action({ inputs: { region: { required: true } } }),
    });
    expect(noDefault.verdict).toBe('breaks');
    expect(noDefault.calls[0]!.added.map((f) => f.code)).toEqual(['FP101']);
  });

  it('a type change: a value known before the run is checked, an expression is not', () => {
    const files = ci(yaml`
      literal:
        uses: ${SHIP}
        with: { dry-run: 'yes' }
      expression:
        uses: ${SHIP}
        with: { dry-run: '\${{ vars.DRY_RUN }}', count: '\${{ vars.COUNT }}' }
      typed:
        uses: ${SHIP}
        with: { dry-run: true }
      constant:
        uses: ${SHIP}
        with: { dry-run: '\${{ true }}' }
    `);
    const g = gradeOne(files, {
      ref: SHIP,
      before: workflow({ inputs: { 'dry-run': {}, count: { type: 'number' } } }),
      after: workflow({ inputs: { 'dry-run': { type: 'boolean' }, count: { type: 'number' } } }),
    });
    expect(verdicts(g)).toEqual({
      literal: 'breaks',
      expression: 'unchecked',
      typed: 'fits',
      constant: 'fits',
    });
    expect(g.calls[1]!.unchecked).toEqual([
      `passes dry-run as an expression, and ${SHIP} now takes a boolean: only literal values are checked`,
    ]);
  });

  it('input names that differ only in case are the same input', () => {
    const files = ci(yaml`
      deploy:
        uses: ${SHIP}
        with: { token: x }
    `);
    const g = gradeOne(files, {
      ref: SHIP,
      before: workflow({ inputs: { Token: {} } }),
      after: workflow({ inputs: { token: {} } }),
    });
    expect(g.verdict).toBe('fits');
    expect(g.changes).toEqual([]);
  });

  it('notes a default the call relies on', () => {
    const files = ci(yaml`
      build:
        runs-on: x
        steps:
          - uses: ${SETUP}
          - uses: ${SETUP}
            with: { cache: 'false' }
    `);
    const g = gradeOne(files, {
      ref: SETUP,
      before: action({ inputs: { cache: { default: 'false' } } }),
      after: action({ inputs: { cache: { default: 'true' } } }),
    });
    expect(g.calls.map((c) => c.notes)).toEqual([
      ['leaves out cache, whose default changed from "false" to "true"'],
      [],
    ]);
    expect(g.verdict).toBe('fits');
  });

  it('lists a finding the new version no longer gives', () => {
    const files = ci(yaml`
      build:
        runs-on: x
        steps:
          - uses: ${SETUP}
            with: { cache: 'true' }
    `);
    const g = gradeOne(files, { ref: SETUP, before: action(), after: action({ inputs: { cache: {} } }) });
    expect(g.verdict).toBe('fits');
    expect(g.calls[0]!.removed.map((f) => f.code)).toEqual(['FP102']);
  });
});

describe('secrets', () => {
  const callers = ci(yaml`
    inherit:
      uses: ${SHIP}
      secrets: inherit
    named:
      uses: ${SHIP}
      secrets: { token: '\${{ secrets.TOKEN }}' }
    none:
      uses: ${SHIP}
  `);

  it('a secret that becomes required: checked unless the call inherits secrets', () => {
    const g = gradeOne(callers, {
      ref: SHIP,
      before: workflow({ secrets: { token: {} } }),
      after: workflow({ secrets: { token: { required: true } } }),
    });
    expect(verdicts(g)).toEqual({ inherit: 'unchecked', named: 'fits', none: 'breaks' });
    expect(g.calls[0]!.unchecked).toEqual([
      `passes secrets: inherit, and ${SHIP} now needs secret token: whether this repository has it is not known`,
    ]);
    expect(g.calls[2]!.added.map((f) => f.code)).toEqual(['FP201']);
  });

  it('a secret the new version reads without declaring it', () => {
    const g = gradeOne(callers, {
      ref: SHIP,
      before: workflow({ secrets: { token: {} } }),
      after: workflow({ secrets: { token: {} }, undeclaredSecrets: ['NPM_TOKEN'] }),
    });
    expect(verdicts(g)).toEqual({ inherit: 'unchecked', named: 'breaks', none: 'breaks' });
    expect(g.calls[2]!.added.map((f) => f.code)).toEqual(['FP205']);
    expect(g.changes).toEqual([
      {
        breaking: true,
        path: 'secrets.NPM_TOKEN',
        message:
          'reads secret "NPM_TOKEN" without declaring it — calls without secrets: inherit pass it empty',
      },
    ]);
  });
});

describe('outputs', () => {
  const reads = (using: string) =>
    gradeOne(
      ci(yaml`
        build:
          runs-on: x
          steps:
            - id: setup
              uses: ${SETUP}
            - run: echo \${{ steps.setup.outputs.path }}
            - id: quiet
              uses: ${SETUP}
        other:
          runs-on: x
          steps:
            - id: quiet
              run: echo "path=x" >> "$GITHUB_OUTPUT"
            - run: echo \${{ steps.quiet.outputs.path }}
      `),
      {
        ref: SETUP,
        before: action({ using, outputs: ['path', 'dir'] }),
        after: action({ using, outputs: ['dir'] }),
      },
    );

  it('an output removed breaks a read of a composite action', () => {
    const g = reads('composite');
    expect(verdicts(g)).toEqual({ 'build setup': 'breaks', 'build quiet': 'fits' });
    expect(g.calls[0]!.added.map((f) => f.code)).toEqual(['FP301']);
    expect(g.calls[0]!.unchecked).toEqual([]);
  });

  it('is not fully checked for a JavaScript action, which can set outputs it does not declare', () => {
    const g = reads('node24');
    expect(verdicts(g)).toEqual({ 'build setup': 'unchecked', 'build quiet': 'fits' });
    expect(g.calls[0]!.unchecked).toEqual([
      `reads output path, which ${SETUP} no longer declares: a node24 action can still set it`,
    ]);
  });

  it('blames the step whose output is read, even when the read is in another call of the reference', () => {
    const g = gradeOne(
      ci(yaml`
        build:
          runs-on: x
          steps:
            - id: first
              uses: ${SETUP}
            - id: second
              uses: ${SETUP}
              with: { cache: '\${{ steps.first.outputs.path }}' }
      `),
      {
        ref: SETUP,
        before: action({ inputs: { cache: {} }, outputs: ['path'] }),
        after: action({ inputs: { cache: {} } }),
      },
    );
    expect(verdicts(g)).toEqual({ 'build first': 'breaks', 'build second': 'fits' });
  });

  it('an output of a reusable workflow removed breaks the call whose output is read', () => {
    const g = gradeOne(
      ci(yaml`
        deploy:
          uses: ${SHIP}
        notify:
          needs: deploy
          runs-on: x
          steps:
            - run: echo \${{ needs.deploy.outputs.url }}
      `),
      { ref: SHIP, before: workflow({ outputs: ['url'] }), after: workflow() },
    );
    expect(verdicts(g)).toEqual({ deploy: 'breaks' });
    expect(g.calls[0]!.added.map((f) => f.code)).toEqual(['FP301']);
  });
});

describe('what is graded', () => {
  it('notes a change of runtime without calling it a break', () => {
    const files = ci(yaml`
      build:
        runs-on: x
        steps:
          - uses: ${SETUP}
    `);
    const g = gradeOne(files, {
      ref: SETUP,
      before: action({ using: 'node20' }),
      after: action({ using: 'node24' }),
    });
    expect(g.verdict).toBe('fits');
    expect(g.changes).toEqual([
      {
        breaking: false,
        path: 'runs.using',
        message: 'runs on node24 instead of node20: a change of behaviour the checks do not see',
      },
    ]);
  });

  it('grades only the calls of the changed reference, not the same action at another ref', () => {
    const files = ci(yaml`
      build:
        runs-on: x
        steps:
          - uses: octo/setup@v1
            with: { cache: 'true' }
          - uses: Octo/Setup@v2
            with: { cache: 'true' }
    `);
    const g = gradeOne(files, { ref: SETUP, before: action({ inputs: { cache: {} } }), after: action() });
    expect(g.calls.map((c) => [c.call.step, c.verdict])).toEqual([['#2', 'breaks']]);
  });

  it('grades a remote action used inside a local composite action', () => {
    const files = {
      ...ci(yaml`
        build:
          runs-on: x
          steps:
            - uses: actions/checkout@v4
            - uses: ./.github/actions/build
      `),
      '.github/actions/build/action.yml': yaml`
        name: build
        runs:
          using: composite
          steps:
            - uses: ${SETUP}
              with: { cache: 'true' }
      `,
    };
    const g = gradeOne(files, { ref: SETUP, before: action({ inputs: { cache: {} } }), after: action() });
    expect(g.calls.map((c) => [c.call.file, c.call.job, c.call.step, c.verdict])).toEqual([
      ['.github/actions/build/action.yml', undefined, '#1', 'breaks'],
    ]);
  });

  it('counts only what the change adds, not a problem the call already had', () => {
    const files = {
      ...ci(yaml`
        build:
          runs-on: x
          steps:
            - uses: Octo/Setup@v2
              with: { bogus: x }
      `),
      [LOCK]: yaml`
        version: 1
        remotes:
          Octo/Setup@v2: { sha: ${A}, kind: action, using: composite }
      `,
    };
    const g = gradeOne(files, {
      ref: SETUP,
      before: action(),
      after: action({ sha: B, inputs: { cache: {} } }),
    });
    expect(g.verdict).toBe('fits');
    expect(g.commits).toEqual({ before: A, after: B });
  });

  it('grades a reference pinned to a commit by the interface, whatever commit the earlier entry records', () => {
    // A pull request moves `octo/setup@<A>` to `octo/setup@<B>`: the base's entry is graded as the interface before.
    const ref = `octo/setup@${B}`;
    const files = ci(yaml`
      build:
        runs-on: x
        steps:
          - uses: ${ref}
            with: { bogus: x }
    `);
    const g = gradeOne(files, { ref, before: action(), after: action({ sha: B, inputs: { cache: {} } }) });
    expect(g.verdict).toBe('fits');
    expect(g.commits).toEqual({ before: A, after: B });
  });

  it('without an earlier entry, every finding is the change’s', () => {
    const files = ci(yaml`
      build:
        runs-on: x
        steps:
          - uses: ${SETUP}
            with: { bogus: x }
    `);
    const g = gradeOne(files, { ref: SETUP, after: action() });
    expect(g.verdict).toBe('breaks');
    expect(g.changes).toEqual([]);
    expect(g.commits).toEqual({ after: A });
  });

  it('grades with the rules on whatever the config sets', () => {
    const files = ci(yaml`
      build:
        runs-on: x
        steps:
          - uses: ${SETUP}
            with: { cache: 'true' }
    `);
    const change = { ref: SETUP, before: action({ inputs: { cache: {} } }), after: action() };
    expect(gradeOne(files, change, { rules: { 'unknown-input': 'off' } }).verdict).toBe('breaks');
  });

  it('puts the entry in place of a lockfile key that differs in case', () => {
    const files = {
      ...ci(yaml`
        build:
          runs-on: x
          steps:
            - uses: Octo/Setup@v2
              with: { cache: 'true' }
      `),
      [LOCK]: yaml`
        version: 1
        remotes:
          octo/setup@v2: { sha: ${A}, kind: action, using: composite, inputs: { cache: {} } }
      `,
    };
    const ref = 'Octo/Setup@v2';
    expect(gradeOne(files, { ref, before: action({ inputs: { cache: {} } }), after: action() }).verdict).toBe(
      'breaks',
    );
  });

  it('grades several changes at once, each with its own calls', () => {
    const files = ci(yaml`
      deploy:
        uses: ${SHIP}
        with: { env: prod }
      build:
        runs-on: x
        steps:
          - uses: ${SETUP}
    `);
    const [ship, setup] = grade(files, [
      { ref: SHIP, before: workflow({ inputs: { env: {} } }), after: workflow() },
      { ref: SETUP, before: action(), after: action({ inputs: { cache: {} } }) },
    ]);
    expect(verdicts(ship!)).toEqual({ deploy: 'breaks' });
    expect(verdicts(setup!)).toEqual({ 'build #1': 'fits' });
  });

  it('a reference nothing calls fits', () => {
    const g = gradeOne(ci('build:\n  runs-on: x\n  steps: [{ run: echo }]\n'), {
      ref: SETUP,
      before: action({ inputs: { cache: {} } }),
      after: action(),
    });
    expect(g).toMatchObject({ verdict: 'fits', calls: [] });
  });
});

describe('real releases (recorded entries)', () => {
  const releases = parseYaml(
    readFileSync(join(import.meta.dirname, 'fixtures/remote-versions.yaml'), 'utf8'),
  ) as Record<string, Record<string, RemoteEntry>>;
  /** A moving tag whose commit moved from one release to the other, with a step passing `with`. */
  const moved = (repo: string, tag: string, from: string, to: string, inputs: Record<string, string>) =>
    gradeOne(
      ci(yaml`
        build:
          runs-on: x
          steps:
            - uses: ${repo}@${tag}
              with: ${JSON.stringify(inputs)}
            - uses: ${repo}@${tag}
      `),
      { ref: `${repo}@${tag}`, before: releases[repo]![from]!, after: releases[repo]![to]! },
    );

  it('setup-node 6.1.0 dropped always-auth', () => {
    const g = moved('actions/setup-node', 'v6', 'v6.0.0', 'v6.1.0', { 'always-auth': 'true' });
    expect(verdicts(g)).toEqual({ 'build #1': 'breaks', 'build #2': 'fits' });
    expect(g.calls[0]!.added.map((f) => f.message)).toEqual([
      'actions/setup-node@v6 has no input "always-auth"',
    ]);
  });

  it('create-github-app-token 3.3.0 dropped permission-team-discussions under @v3', () => {
    const g = moved('actions/create-github-app-token', 'v3', 'v3.2.0', 'v3.3.0', {
      'private-key': 'k',
      'permission-team-discussions': 'write',
    });
    expect(verdicts(g)).toEqual({ 'build #1': 'breaks', 'build #2': 'fits' });
    expect(g.calls[0]!.added.map((f) => f.code)).toEqual(['FP102']);
  });

  it('setup-python v7 dropped pip-install', () => {
    const g = moved('actions/setup-python', 'v7', 'v6', 'v7', { 'pip-install': '-r requirements.txt' });
    expect(g.calls[0]!.verdict).toBe('breaks');
  });

  it('checkout v4 moved past 4.3.1 adding an input: it fits', () => {
    const g = moved('actions/checkout', 'v4', 'v4.3.1', 'v4', { 'fetch-depth': '0' });
    expect(g.verdict).toBe('fits');
    expect(g.changes.map((c) => [c.breaking, c.path])).toEqual([[false, 'inputs.allow-unsafe-pr-checkout']]);
  });
});
