/** Remote interfaces (#152): the lockfile's interfaces of remote reusable workflows and actions. */
import { describe, expect, it } from 'vitest';
import { byCode, lint, WF, yaml } from './helpers';

const LOCK = '.github/flowpact/remotes.lock.yaml';
const SHA = 'a'.repeat(40);

const lock = yaml`
  version: 1
  remotes:
    octo/ship/.github/workflows/deploy.yml@v1:
      sha: ${SHA}
      kind: workflow
      inputs:
        env: { type: string, required: true }
        dry-run: { type: boolean, required: false, default: false }
      secrets:
        token: { required: true }
      outputs: [url]
    octo/setup@v2:
      sha: ${SHA}
      kind: action
      inputs:
        version: { required: true }
        cache: { required: false, default: 'true' }
      outputs: [path]
`;

const ci = yaml`
  on: push
  jobs:
    deploy:
      uses: octo/ship/.github/workflows/deploy.yml@v1
      with:
        envv: prod
        dry-run: 'yes'
    other:
      uses: octo/ship/.github/workflows/other.yml@v1
    build:
      runs-on: x
      steps:
        - uses: Octo/Setup@v2
          with: { cach: 'false' }
`;

const messages = (files: Record<string, string>, code: string) =>
  byCode(lint(files), code).map((f) => f.message);

describe('remote interfaces from the lockfile', () => {
  const files = { [`${WF}/ci.yml`]: ci, [LOCK]: lock };

  it('checks the inputs passed to a remote reusable workflow and action (FP101, FP102, FP103)', () => {
    expect(messages(files, 'FP101')).toEqual([
      'jobs.deploy calls octo/ship/.github/workflows/deploy.yml@v1 without required input "env"',
      'Step #1 uses octo/setup@v2 without required input "version" — GitHub will run it with an empty value',
    ]);
    expect(messages(files, 'FP102')).toEqual([
      'octo/ship/.github/workflows/deploy.yml@v1 has no input "envv" — did you mean "env"?',
      'octo/setup@v2 has no input "cach" — did you mean "cache"?',
    ]);
    expect(messages(files, 'FP103')).toEqual([
      'Input "dry-run" of octo/ship/.github/workflows/deploy.yml@v1 is a boolean, but jobs.deploy passes a string ("yes")',
    ]);
  });

  it('points findings at the caller only: the declaration is in another repository', () => {
    for (const f of lint(files).findings.filter((x) => ['FP101', 'FP102', 'FP103'].includes(x.code))) {
      expect(f.loc.file).toBe(`${WF}/ci.yml`);
      expect((f.related ?? []).every((r) => r.loc.file === `${WF}/ci.yml`)).toBe(true);
    }
  });

  it('reports FP603 only for a remote workflow the lockfile does not have', () => {
    expect(messages(files, 'FP603')).toEqual([
      'jobs.other calls remote workflow octo/ship/.github/workflows/other.yml@v1; its interface is not verified',
    ]);
  });

  it('checks nothing remote without a lockfile', () => {
    const none = { [`${WF}/ci.yml`]: ci };
    expect([...messages(none, 'FP101'), ...messages(none, 'FP102'), ...messages(none, 'FP103')]).toEqual([]);
    expect(messages(none, 'FP603')).toHaveLength(2);
  });

  it('reports a lockfile it cannot use (FP611), and then checks nothing remote', () => {
    const broken = { [`${WF}/ci.yml`]: ci, [LOCK]: lock.replace(`sha: ${SHA}`, 'sha: v1') };
    expect(messages(broken, 'FP611')).toEqual([
      expect.stringMatching(/^\.github\/flowpact\/remotes\.lock\.yaml cannot be used: remotes\..*sha: /),
    ]);
    expect(messages(broken, 'FP101')).toEqual([]);
    expect(messages({ [`${WF}/ci.yml`]: ci, [LOCK]: 'version: [' }, 'FP611')).toEqual([
      expect.stringMatching(/cannot be used: not valid YAML: /),
    ]);
  });

  it('reads remotes.lock.yml too', () => {
    const yml = { [`${WF}/ci.yml`]: ci, '.github/flowpact/remotes.lock.yml': lock };
    expect(messages(yml, 'FP101')).toHaveLength(2);
  });
});

describe('secrets and outputs of remote interfaces', () => {
  const caller = yaml`
    on: push
    jobs:
      deploy:
        uses: octo/ship/.github/workflows/deploy.yml@v1
        with: { env: prod }
        secrets: { tokn: x }
      after:
        needs: deploy
        runs-on: x
        steps:
          - run: echo "\${{ needs.deploy.outputs.url }} \${{ needs.deploy.outputs.uri }}"
          - id: s
            uses: octo/setup@v2
            with: { version: 1 }
          - id: js
            uses: octo/node-tool@v1
          - run: echo "\${{ steps.s.outputs.path }} \${{ steps.s.outputs.pth }} \${{ steps.js.outputs.anything }}"
  `;
  const lockWithJs = `${lock}  octo/node-tool@v1:\n    sha: ${SHA}\n    kind: action\n    using: node24\n    outputs: [result]\n`;
  const files = { [`${WF}/ci.yml`]: caller, [LOCK]: lockWithJs };

  it('checks the secrets passed to a remote reusable workflow (FP201, FP202)', () => {
    expect(messages(files, 'FP201')).toEqual([
      'jobs.deploy calls octo/ship/.github/workflows/deploy.yml@v1 without required secret "token"',
    ]);
    expect(messages(files, 'FP202')).toEqual([
      'octo/ship/.github/workflows/deploy.yml@v1 has no secret "tokn" — did you mean "token"?',
    ]);
  });

  it('checks the outputs read from a remote workflow and a remote composite action (FP301)', () => {
    // A JavaScript action may set outputs it does not declare: its reads are not checked.
    expect(messages(files, 'FP301')).toEqual([
      'jobs.deploy has no output "uri" — did you mean "url"?',
      'octo/setup@v2 has no output "pth" — did you mean "path"?',
    ]);
  });

  it('points them at the caller only', () => {
    for (const f of lint(files).findings.filter((x) => ['FP201', 'FP202', 'FP301'].includes(x.code))) {
      expect(f.loc.file).toBe(`${WF}/ci.yml`);
      expect((f.related ?? []).every((r) => r.loc.file === `${WF}/ci.yml`)).toBe(true);
    }
  });

  it('does not check what a remote workflow reads: it has no body here (FP203, FP204)', () => {
    const inherit = caller.replace('secrets: { tokn: x }', 'secrets: inherit');
    const all = lint({ [`${WF}/ci.yml`]: inherit, [LOCK]: lockWithJs }).findings.map((f) => f.code);
    expect(all.filter((c) => c === 'FP203' || c === 'FP204')).toEqual([]);
  });
});

describe('fetched remote interfaces and an outdated lockfile', () => {
  const setup = { sha: SHA, kind: 'action' as const, inputs: { version: { required: true } }, outputs: [] };

  it('checks a reference the lockfile lacks with an interface fetched for the run; the lockfile’s own entries stand', () => {
    const only = { [`${WF}/ci.yml`]: ci };
    const fetched = { 'octo/setup@v2': setup };
    expect(messages(only, 'FP101')).toEqual([]);
    expect(byCode(lint(only, { fetchedRemotes: fetched }), 'FP101').map((f) => f.message)).toEqual([
      'Step #1 uses octo/setup@v2 without required input "version" — GitHub will run it with an empty value',
    ]);
    // With a lockfile that has it, its entry wins over a fetched one that declares nothing.
    const withLock = { [`${WF}/ci.yml`]: ci, [LOCK]: lock };
    const empty = { 'octo/setup@v2': { ...setup, inputs: {} } };
    expect(byCode(lint(withLock, { fetchedRemotes: empty }), 'FP101').map((f) => f.message)).toContain(
      'Step #1 uses octo/setup@v2 without required input "version" — GitHub will run it with an empty value',
    );
  });

  it('reports a lockfile that lacks a reference or has one nothing uses (FP612), also when the run fetched it', () => {
    const bumped = { [`${WF}/ci.yml`]: ci.replace('Octo/Setup@v2', 'octo/setup@v3'), [LOCK]: lock };
    const expected =
      '.github/flowpact/remotes.lock.yaml is out of date: it lacks octo/ship/.github/workflows/other.yml@v1, octo/setup@v3; it no longer needs octo/setup@v2. Run `flowpact remotes update`';
    expect(messages(bumped, 'FP612')).toEqual([expected]);
    const fetched = { 'octo/setup@v3': setup };
    expect(byCode(lint(bumped, { fetchedRemotes: fetched }), 'FP612').map((f) => f.message)).toEqual([
      expected,
    ]);
  });

  it('stays quiet without a lockfile, with an unusable one, and when it matches', () => {
    expect(messages({ [`${WF}/ci.yml`]: ci }, 'FP612')).toEqual([]);
    expect(messages({ [`${WF}/ci.yml`]: ci, [LOCK]: 'version: [' }, 'FP612')).toEqual([]);
    const exact = { [`${WF}/ci.yml`]: ci.replace(/\s+other:\n\s+uses: \S+\n/, '\n'), [LOCK]: lock };
    expect(messages(exact, 'FP612')).toEqual([]);
  });
});

describe('FP205 for remote reusable workflows', () => {
  const lockWith = `version: 1\nremotes:\n  octo/ship/.github/workflows/ship.yml@v1:\n    sha: ${SHA}\n    kind: workflow\n    undeclaredSecrets: [NPM_TOKEN, SLACK_WEBHOOK]\n`;
  const caller = (secrets: string) =>
    `on: push\njobs:\n  s:\n    uses: octo/ship/.github/workflows/ship.yml@v1\n${secrets}`;

  it('reports each secret a call without secrets: inherit leaves empty', () => {
    expect(messages({ [`${WF}/ci.yml`]: caller(''), [LOCK]: lockWith }, 'FP205')).toEqual([
      'jobs.s calls octo/ship/.github/workflows/ship.yml@v1, which reads secrets.NPM_TOKEN without declaring it — it is empty without `secrets: inherit`',
      'jobs.s calls octo/ship/.github/workflows/ship.yml@v1, which reads secrets.SLACK_WEBHOOK without declaring it — it is empty without `secrets: inherit`',
    ]);
    const f = byCode(lint({ [`${WF}/ci.yml`]: caller(''), [LOCK]: lockWith }), 'FP205')[0]!;
    expect(f.loc.file).toBe(`${WF}/ci.yml`);
  });

  it('stays quiet with secrets: inherit, and without the lockfile', () => {
    expect(
      messages({ [`${WF}/ci.yml`]: caller('    secrets: inherit\n'), [LOCK]: lockWith }, 'FP205'),
    ).toEqual([]);
    expect(messages({ [`${WF}/ci.yml`]: caller('') }, 'FP205')).toEqual([]);
  });
});
