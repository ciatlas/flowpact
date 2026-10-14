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
