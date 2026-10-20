import { describe, expect, it } from 'vitest';
import { at, byCode, lint, WF, yaml } from '../helpers';

/** A reusable workflow with one job that requests `permissions` (a YAML flow mapping or shorthand), if given. */
const callee = (permissions?: string, workflowLevel?: string) => yaml`
  on: workflow_call
  ${workflowLevel ? `permissions: ${workflowLevel}` : ''}
  jobs:
    release:
      runs-on: ubuntu-latest
      ${permissions ? `permissions: ${permissions}` : ''}
      steps: [{ run: x }]
`;

/** A caller of `r.yml`, granting `workflowLevel` to every job and `jobLevel` to the calling job, if given. */
const caller = (workflowLevel?: string, jobLevel?: string) => yaml`
  on: push
  ${workflowLevel ? `permissions: ${workflowLevel}` : ''}
  jobs:
    call:
      uses: ./.github/workflows/r.yml
      ${jobLevel ? `permissions: ${jobLevel}` : ''}
`;

const fp613 = (files: Record<string, string>) => byCode(lint(files), 'FP613');
const messages = (files: Record<string, string>) => fp613(files).map((f) => f.message);

describe('FP613 ungranted-permissions', () => {
  it('reports a called job that requests more than the workflow grants, at its permissions:', () => {
    const [f, ...more] = fp613({
      [`${WF}/ci.yml`]: caller('{ contents: read }'),
      [`${WF}/r.yml`]: callee('{ contents: write, packages: write }'),
    });
    expect(more).toEqual([]);
    expect(f?.message).toBe(
      '.github/workflows/r.yml › jobs.release requests contents: write, packages: write, but jobs.call grants contents: read, packages: none',
    );
    expect(f?.severity).toBe('error');
    expect(at(f!)).toBe('.github/workflows/ci.yml:2:1');
    expect(f?.symbol).toBe('.github/workflows/ci.yml#jobs.call.permissions');
    expect(f?.related.map((r) => `${at({ ...f!, loc: r.loc })} ${r.message}`)).toEqual([
      '.github/workflows/ci.yml:5:11 jobs.call calls .github/workflows/r.yml',
      '.github/workflows/r.yml:6:5 jobs.release requests contents: write, packages: write',
    ]);
  });

  it("takes the calling job's permissions over the workflow's", () => {
    const r = { [`${WF}/r.yml`]: callee('{ contents: write }') };
    expect(messages({ ...r, [`${WF}/ci.yml`]: caller('write-all', '{ contents: read }') })).toEqual([
      '.github/workflows/r.yml › jobs.release requests contents: write, but jobs.call grants contents: read',
    ]);
    expect(messages({ ...r, [`${WF}/ci.yml`]: caller('{ contents: read }', '{ contents: write }') })).toEqual(
      [],
    );
  });

  it('points at the calling job’s permissions: when they are the grant', () => {
    const [f] = fp613({
      [`${WF}/ci.yml`]: caller(undefined, '{ contents: read }'),
      [`${WF}/r.yml`]: callee('{ contents: write }'),
    });
    expect(at(f!)).toBe('.github/workflows/ci.yml:6:5');
  });

  it("says nothing when the caller grants nothing explicitly: the repository's default is not known", () => {
    expect(
      messages({
        [`${WF}/ci.yml`]: caller(),
        [`${WF}/r.yml`]: callee('{ contents: write, id-token: write }'),
      }),
    ).toEqual([]);
  });

  it('gives read-all every scope at read except id-token, and write-all every scope', () => {
    const r = { [`${WF}/r.yml`]: callee('{ contents: read, models: read, id-token: write }') };
    expect(messages({ ...r, [`${WF}/ci.yml`]: caller('read-all') })).toEqual([
      '.github/workflows/r.yml › jobs.release requests id-token: write, but jobs.call grants id-token: none',
    ]);
    const unknown = { [`${WF}/r.yml`]: callee('{ artifact-metadata: write, id-token: write }') };
    expect(messages({ ...unknown, [`${WF}/ci.yml`]: caller('write-all') })).toEqual([]);
  });

  it('grants nothing with {}, and a request of none or {} needs nothing', () => {
    expect(
      messages({ [`${WF}/ci.yml`]: caller('{}'), [`${WF}/r.yml`]: callee('{ contents: read }') }),
    ).toEqual([
      '.github/workflows/r.yml › jobs.release requests contents: read, but jobs.call grants contents: none',
    ]);
    expect(
      messages({ [`${WF}/ci.yml`]: caller('{}'), [`${WF}/r.yml`]: callee('{ contents: none }') }),
    ).toEqual([]);
    expect(messages({ [`${WF}/ci.yml`]: caller('{}'), [`${WF}/r.yml`]: callee('{}') })).toEqual([]);
  });

  it('expands a read-all request to every scope', () => {
    expect(
      messages({ [`${WF}/ci.yml`]: caller('{ contents: read }'), [`${WF}/r.yml`]: callee('read-all') }),
    ).toEqual([
      '.github/workflows/r.yml › jobs.release requests actions: read, attestations: read, checks: read, deployments: read, discussions: read, issues: read, models: read, packages: read, pages: read, pull-requests: read, security-events: read, statuses: read, but jobs.call grants actions: none, attestations: none, checks: none, deployments: none, discussions: none, issues: none, models: none, packages: none, pages: none, pull-requests: none, security-events: none, statuses: none',
    ]);
  });

  it('says nothing for a called job without permissions of its own: it gets what the call grants', () => {
    expect(messages({ [`${WF}/ci.yml`]: caller('{}'), [`${WF}/r.yml`]: callee() })).toEqual([]);
  });

  it("reports the called workflow's own permissions once for the jobs that have none, and a job's own apart", () => {
    const files = {
      [`${WF}/ci.yml`]: caller('{ contents: read }'),
      [`${WF}/r.yml`]: yaml`
        on: workflow_call
        permissions:
          contents: write
        jobs:
          a: { runs-on: x, steps: [{ run: x }] }
          b: { runs-on: x, steps: [{ run: x }] }
          c:
            runs-on: x
            permissions: { contents: read, issues: write }
            steps: [{ run: x }]
      `,
    };
    const found = fp613(files);
    expect(found.map((f) => f.message)).toEqual([
      '.github/workflows/r.yml requests contents: write, but jobs.call grants contents: read',
      '.github/workflows/r.yml › jobs.c requests issues: write, but jobs.call grants issues: none',
    ]);
    expect(found[0]?.related.at(-1)?.message).toBe('.github/workflows/r.yml requests contents: write');
    expect(at({ ...found[0]!, loc: found[0]!.related.at(-1)!.loc })).toBe('.github/workflows/r.yml:2:1');
  });

  describe('nested calls', () => {
    const inner = callee('{ contents: write }');
    const mid = (permissions = '') => yaml`
      on: workflow_call
      jobs:
        nested:
          uses: ./.github/workflows/inner.yml
          ${permissions}
    `;
    const top = yaml`
      on: push
      permissions: { contents: read }
      jobs:
        call:
          uses: ./.github/workflows/mid.yml
    `;

    it('follows a calling job without permissions down to the job that requests them', () => {
      const found = fp613({
        [`${WF}/ci.yml`]: top,
        [`${WF}/mid.yml`]: mid(),
        [`${WF}/inner.yml`]: inner,
      });
      expect(found.map((f) => f.message)).toEqual([
        '.github/workflows/mid.yml › jobs.nested › .github/workflows/inner.yml › jobs.release requests contents: write, but jobs.call grants contents: read',
      ]);
      expect(found[0]?.related.map((r) => r.message)).toEqual([
        'jobs.call calls .github/workflows/mid.yml',
        'jobs.nested calls .github/workflows/inner.yml',
        'jobs.release requests contents: write',
      ]);
    });

    it('checks a calling job with permissions against its caller, and its callee against it', () => {
      const files = {
        [`${WF}/ci.yml`]: top,
        [`${WF}/mid.yml`]: mid('permissions: { contents: write }'),
        [`${WF}/inner.yml`]: callee('{ contents: write, packages: write }'),
      };
      expect(messages(files)).toEqual([
        '.github/workflows/mid.yml › jobs.nested requests contents: write, but jobs.call grants contents: read',
        '.github/workflows/inner.yml › jobs.release requests packages: write, but jobs.nested grants packages: none',
      ]);
    });

    it('stops at a remote workflow, whose requests the lockfile does not record', () => {
      expect(
        messages({
          [`${WF}/ci.yml`]: top,
          [`${WF}/mid.yml`]: yaml`
            on: workflow_call
            jobs:
              remote:
                uses: acme/shared/.github/workflows/release.yml@v1
          `,
        }),
      ).toEqual([]);
    });
  });
});
