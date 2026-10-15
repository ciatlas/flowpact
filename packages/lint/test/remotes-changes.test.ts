/** A pull request's version changes of remote references (remotes-changes.ts): paired with what they replaced, graded. */
import { memoryFileSystem } from '@ciatlas/core';
import {
  gradeVersionChanges,
  parseConfig,
  parseRemoteRef,
  type RemoteRef,
  versionChanges,
} from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { WF, yaml } from './helpers';

const LOCK = '.github/flowpact/remotes.lock.yaml';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const action = (raw: string) => parseRemoteRef(raw, 'action')!;
const workflow = (raw: string) => parseRemoteRef(raw, 'workflow')!;
const pairs = (base: RemoteRef[], head: RemoteRef[]) =>
  versionChanges(base, head).map((c) => [c.from.raw, c.ref.raw]);

describe('versionChanges', () => {
  it('pairs each new reference with the one it replaced: the same workflow or action at another ref', () => {
    expect(
      pairs(
        [action('octo/setup@v1'), action('octo/cache@v4')],
        [action('octo/setup@v2'), action('octo/cache@v4')],
      ),
    ).toEqual([['octo/setup@v1', 'octo/setup@v2']]);
  });

  it('matches owner and repository in any case, and nothing else', () => {
    expect(pairs([action('Octo/Setup@v1')], [action('octo/setup@v2')])).toEqual([
      ['Octo/Setup@v1', 'octo/setup@v2'],
    ]);
    // Another path, another kind, another repository: new references, not version changes.
    const ship = 'octo/ship/.github/workflows/deploy.yml';
    expect(pairs([workflow(`${ship}@v1`)], [workflow('octo/ship/.github/workflows/test.yml@v2')])).toEqual(
      [],
    );
    expect(pairs([action('octo/ship/sub@v1')], [workflow(`${ship}@v2`)])).toEqual([]);
    expect(pairs([action('octo/setup@v1')], [action('acme/setup@v2')])).toEqual([]);
  });

  it('prefers the reference the head no longer uses', () => {
    expect(
      pairs(
        [action('octo/setup@v2'), action('octo/setup@v1')],
        [action('octo/setup@v2'), action('octo/setup@v3')],
      ),
    ).toEqual([['octo/setup@v1', 'octo/setup@v3']]);
  });
});

/** A stand-in for the GitHub API: `<owner>/<repo>@<ref>` resolves to a commit with this action.yml. */
function api(actions: Record<string, { sha: string; yml: string }>) {
  const asked: string[] = [];
  const fake = (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push(`${url.pathname}${url.search}`);
    for (const [ref, { sha, yml }] of Object.entries(actions)) {
      const [repo, tag] = ref.split('@');
      if (url.pathname === `/repos/${repo}/commits/${tag}`) return new Response(sha);
      if (url.pathname === `/repos/${repo}/contents/action.yml` && url.search === `?ref=${sha}`)
        return new Response(yml);
    }
    return new Response('', { status: 404 });
  }) as typeof globalThis.fetch;
  return { asked, options: { apiUrl: 'https://api.test', fetch: fake } };
}

const setup = (inputs: string) =>
  `name: s\ndescription: d\ninputs:\n${inputs}\nruns:\n  using: composite\n  steps: []\n`;

const caller = (ref: string) => yaml`
  on: push
  jobs:
    build:
      runs-on: x
      steps:
        - uses: ${ref}
          with: { version: 1, cache: x }
`;

const lockWith = (ref: string, sha: string, inputs: string) =>
  `version: 1\nremotes:\n  ${ref}:\n    sha: ${sha}\n    kind: action\n    using: composite\n    inputs: ${inputs}\n`;

const grade = (base: Record<string, string>, head: Record<string, string>, fetch: ReturnType<typeof api>) =>
  gradeVersionChanges(
    {
      root: '/virtual/repo',
      fs: memoryFileSystem(head),
      config: parseConfig({}),
      validateSchema: false,
      repository: 'acme/repo',
    },
    memoryFileSystem(base),
    fetch.options,
  );

describe('gradeVersionChanges', () => {
  const v2 = { sha: B, yml: setup('  version: { description: v }') };

  it("grades the head's interface fetched, whatever the pull request's lockfile says, from the base's entry", async () => {
    const github = api({ 'octo/setup@v2': v2 });
    const r = await grade(
      {
        [`${WF}/ci.yml`]: caller('octo/setup@v1'),
        [LOCK]: lockWith('octo/setup@v1', A, '{ version: {}, cache: {} }'),
      },
      // The pull request's lockfile says @v2 still takes `cache`: it is not read.
      {
        [`${WF}/ci.yml`]: caller('octo/setup@v2'),
        [LOCK]: lockWith('octo/setup@v2', B, '{ version: {}, cache: {} }'),
      },
      github,
    );
    expect(r.changes.map((c) => [c.from.raw, c.ref.raw])).toEqual([['octo/setup@v1', 'octo/setup@v2']]);
    expect(r.grades).toHaveLength(1);
    expect(r.grades[0]).toMatchObject({
      ref: 'octo/setup@v2',
      verdict: 'breaks',
      commits: { before: A, after: B },
    });
    expect(r.grades[0]!.calls[0]!.added.map((f) => f.message)).toEqual([
      'octo/setup@v2 has no input "cache"',
    ]);
    // The base's entry stands for @v1: only @v2 is fetched.
    expect(github.asked.some((u) => u.includes('/commits/v1'))).toBe(false);
    expect(r.failed).toEqual([]);
  });

  it('fetches the replaced reference when the base has no entry for it', async () => {
    const github = api({
      'octo/setup@v1': { sha: A, yml: setup('  version: {}\n  cache: {}') },
      'octo/setup@v2': v2,
    });
    const r = await grade(
      { [`${WF}/ci.yml`]: caller('octo/setup@v1') },
      { [`${WF}/ci.yml`]: caller('octo/setup@v2') },
      github,
    );
    expect(r.grades.map((g) => g.verdict)).toEqual(['breaks']);
    expect(github.asked).toContain('/repos/octo/setup/commits/v1');
  });

  it('lists a reference it cannot fetch, and grades nothing for its change', async () => {
    const r = await grade(
      { [`${WF}/ci.yml`]: caller('octo/setup@v1'), [LOCK]: lockWith('octo/setup@v1', A, '{ version: {} }') },
      { [`${WF}/ci.yml`]: caller('octo/setup@v2') },
      api({}),
    );
    expect(r.grades).toEqual([]);
    expect(r.failed.map((f) => f.ref)).toEqual(['octo/setup@v2']);
  });

  it('fetches nothing when no reference moved', async () => {
    const github = api({});
    const files = { [`${WF}/ci.yml`]: caller('octo/setup@v1') };
    expect(await grade(files, files, github)).toEqual({ changes: [], grades: [], failed: [] });
    expect(github.asked).toEqual([]);
  });
});
