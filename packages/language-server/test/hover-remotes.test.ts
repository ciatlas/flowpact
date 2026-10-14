import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryFileSystem, SymbolLocator } from '@ciatlas/core';
import { analyze, cacheSource, parseConfig } from '@flowpact/lint';
import { afterAll, describe, expect, it } from 'vitest';
import { hoverMarkdown, remoteBindingMarkdown } from '../src/hover';
import { RemoteBindings } from '../src/remotes';
import { hostOfGitUrl, originHost, RemoteSources, remoteTarget, sourceLink, webHostOf } from '../src/sources';

const CI = '.github/workflows/ci.yml';
const LOCK = '.github/flowpact/remotes.lock.yaml';
const SHA = `abcdef1${'0'.repeat(33)}`;
const DEPLOY = 'octo/ship/.github/workflows/deploy.yml@v1';

const ci = `on: push
jobs:
  deploy:
    uses: ${DEPLOY}
    with:
      env: prod
      dry-run: true
    secrets:
      token: \${{ secrets.DEPLOY }}
  again:
    uses: ${DEPLOY}
    with:
      env: staging
  after:
    needs: [deploy]
    runs-on: x
    steps:
      - id: s
        uses: Octo/Setup@v2
        with:
          version: 22
      - run: echo \${{ needs.deploy.outputs.url }} \${{ needs.deploy.outputs.nope }} \${{ steps.s.outputs.path }}
  gone:
    uses: octo/private/.github/workflows/x.yml@v1
  new:
    uses: octo/new/.github/workflows/x.yml@v1
`;

const lock = `version: 1
remotes:
  ${DEPLOY}:
    sha: ${SHA}
    kind: workflow
    inputs:
      env: { type: string, required: true }
      dry-run: { type: boolean, default: false }
    secrets:
      token: { required: true }
    outputs: [url]
    undeclaredSecrets: [NPM_TOKEN]
  octo/setup@v2:
    sha: ${SHA}
    kind: action
    host: github.com
    inputs:
      version: { required: true }
    outputs: [path]
unreadable:
  octo/private/.github/workflows/x.yml@v1: not found, or not readable with this token
`;

function setup(files: Record<string, string>, ctx: { sources?: RemoteSources; webHost?: string } = {}) {
  const result = analyze({
    root: '/virtual/repo',
    fs: memoryFileSystem(files),
    config: parseConfig({}),
    validateSchema: false,
  });
  const locator = new SymbolLocator(result.index);
  const remotes = new RemoteBindings(result.index);
  /** The position (1-based) of the nth `needle` in ci.yml, moved right by `offset`. */
  const pos = (needle: string, offset = 0, nth = 0) => {
    let i = -1;
    for (let n = 0; n <= nth; n++) i = ci.indexOf(needle, i + 1);
    if (i < 0) throw new Error(`${needle} not found`);
    const lines = ci.slice(0, i + offset).split('\n');
    return [lines.length, lines.at(-1)!.length + 1] as const;
  };
  const hover = (needle: string, offset = 0, nth = 0) => {
    const at = locator.at(CI, ...pos(needle, offset, nth));
    if (!at) throw new Error(`no symbol at ${needle}`);
    return hoverMarkdown(locator, at, { ...(result.remotes ? { lock: result.remotes } : {}), ...ctx });
  };
  const key = (needle: string, nth = 0) => {
    const found = remotes.at(CI, ...pos(needle, 0, nth));
    if (!found) throw new Error(`no remote key at ${needle}`);
    const cached = ctx.sources?.of(result.remotes?.lock, found.ref);
    return {
      found,
      markdown: remoteBindingMarkdown(found, remotes.occurrences(found.at.symbol).length, cached),
    };
  };
  /** Where Go to Definition goes from the nth `needle` (moved right by `offset`), in the cache. */
  const target = (needle: string, offset = 0, nth = 0) => {
    const where = pos(needle, offset, nth);
    const at = locator.at(CI, ...where);
    const binding = at ? undefined : remotes.at(CI, ...where);
    const occurrence = at ?? binding?.at;
    if (!occurrence || !ctx.sources) throw new Error(`no symbol at ${needle}`);
    return remoteTarget(locator, result.remotes?.lock, ctx.sources, occurrence, binding);
  };
  /** The hover at `needle` in another file, given its text. */
  const hoverIn = (file: string, text: string, needle: string) => {
    const lines = text.slice(0, text.indexOf(needle)).split('\n');
    const at = locator.at(file, lines.length, lines.at(-1)!.length + 1);
    if (!at) throw new Error(`no symbol at ${needle}`);
    return hoverMarkdown(locator, at, { ...(result.remotes ? { lock: result.remotes } : {}), ...ctx });
  };
  /** Where Go to Definition goes from `needle` in another file. */
  const targetIn = (file: string, needle: string) => {
    const text = files[file]!;
    const lines = text.slice(0, text.indexOf(needle)).split('\n');
    const at = locator.at(file, lines.length, lines.at(-1)!.length + 1);
    if (!at || !ctx.sources) throw new Error(`no symbol at ${needle}`);
    return remoteTarget(locator, result.remotes?.lock, ctx.sources, at);
  };
  return { hover, hoverIn, key, target, targetIn, remotes, locator };
}

describe('hover on remote references, from the lockfile', () => {
  const { hover, key, remotes, locator } = setup({ [CI]: ci, [LOCK]: lock });

  it('shows the commit and the interface the lockfile records for a remote reference', () => {
    const text = hover(DEPLOY).split('\n');
    expect(text[0]).toContain('· remote reference ·');
    expect(text.slice(2)).toEqual([
      `\`${DEPLOY}\` · reusable workflow at \`abcdef1\`, recorded in \`remotes.lock.yaml\``,
      '',
      '**Inputs** `env` (required), `dry-run`  ',
      '**Secrets** `token` (required)  ',
      '**Outputs** `url`  ',
      '**Reads without declaring** `NPM_TOKEN`, passed only by `secrets: inherit`',
      '',
      'Its source is not cached: `flowpact remotes download` caches it for Go to Definition.',
    ]);
  });

  it('names the host an entry was read from, and matches a reference in any case', () => {
    const text = hover('Octo/Setup@v2');
    expect(text).toContain(
      '`Octo/Setup@v2` · action at `abcdef1` on github\\.com, recorded in `remotes.lock.yaml`',
    );
    expect(text).toContain('**Inputs** `version` (required)  \n**Outputs** `path`');
    // Read on github.com, from an enterprise server: downloading it needs --github-com.
    expect(text).toContain('`flowpact remotes download --github-com` caches it for Go to Definition.');
  });

  it('links an uncached source on the host it is read from', () => {
    const linked = setup({ [CI]: ci, [LOCK]: lock }, { webHost: 'github.com' });
    expect(linked.hover(DEPLOY).split('\n').at(-1)).toBe(
      `[Source](https://github.com/octo/ship/blob/${SHA}/.github/workflows/deploy.yml) · ` +
        '`flowpact remotes download` caches it for Go to Definition.',
    );
  });

  it('says why a reference has no interface: unreadable, or not recorded yet', () => {
    expect(hover('octo/private')).toContain(
      '`remotes.lock.yaml` records it as not readable: not found, or not readable with this token',
    );
    expect(hover('octo/new')).toContain('in another repository; its interface is not verified');
    expect(hover('octo/new')).toContain('`flowpact remotes update` records it in `remotes.lock.yaml`.');
  });

  it('describes a with: or secrets: key of a remote call as the lockfile records it', () => {
    const env = key('env: prod');
    expect(env.found.at.symbol).toBe(`remote:${DEPLOY}#inputs.env`);
    expect(env.markdown.split('\n').slice(2)).toEqual([
      `\`inputs.env\` in \`${DEPLOY}\` · \`string\` · required`,
      '',
      'this call passes `prod` · 1 other caller',
    ]);
    expect(key('dry-run').markdown).toContain('`inputs.dry-run` in');
    expect(key('dry-run').markdown).toContain('· `boolean` · optional · default `false`');
    expect(key('token:').markdown).toContain(`\`secrets.token\` in \`${DEPLOY}\` · required`);
    expect(key('token:').markdown).toContain('this call passes `${{ secrets.DEPLOY }}`');
  });

  it('describes a remote action step input with the reference as the lockfile writes it', () => {
    expect(key('version:').markdown).toContain('`inputs.version` in `octo/setup@v2` · required');
  });

  it('finds every caller passing the same remote input, which the locator does not know', () => {
    const env = key('env: prod').found;
    expect(locator.at(CI, env.at.loc.line, env.at.loc.column)).toBeUndefined();
    expect(remotes.occurrences(env.at.symbol).map((o) => o.loc.line)).toEqual([6, 13]);
  });

  it('says whether an output read from a remote call or step is declared there', () => {
    expect(hover('outputs.url')).toContain(`· declared by \`${DEPLOY}\``);
    expect(hover('outputs.nope')).toContain(`· not declared by \`${DEPLOY}\``);
    expect(hover('outputs.path')).toContain('· declared by `Octo/Setup@v2`');
  });
});

describe('hover on remote references without a usable lockfile', () => {
  it('keeps the unverified card, and says when the lockfile cannot be used', () => {
    expect(setup({ [CI]: ci }).hover(DEPLOY)).toContain('`flowpact remotes update` records it in');
    const broken = setup({ [CI]: ci, [LOCK]: 'version: 2\nremotes: {}\n' });
    expect(broken.hover(DEPLOY)).toContain('`remotes.lock.yaml` cannot be used.');
    expect(broken.remotes.occurrences(`remote:${DEPLOY}#inputs.env`)).toEqual([]);
  });
});

const DEPLOY_SOURCE = `name: Deploy
on:
  workflow_call:
    inputs:
      env: { type: string, required: true, description: Where to deploy }
      dry-run: { type: boolean, default: false }
    secrets:
      token: { required: true, description: The deploy token }
    outputs:
      url: { description: The URL, value: x }
jobs: {}
`;
const SETUP_SOURCE = `name: Setup
inputs:
  version: { required: true, description: The version }
outputs:
  path: { description: Where it is }
runs: { using: node24, main: index.js }
`;

describe('remote references with their sources cached', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowpact-sources-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  cacheSource(dir, { owner: 'octo', repo: 'ship' }, SHA, '.github/workflows/deploy.yml', DEPLOY_SOURCE);
  cacheSource(dir, { owner: 'octo', repo: 'setup' }, SHA, 'action.yml', SETUP_SOURCE);
  const sources = new RemoteSources(dir);
  const { hover, key, target } = setup({ [CI]: ci, [LOCK]: lock }, { sources });
  const deployFile = join(dir, 'octo', 'ship', SHA, '.github', 'workflows', 'deploy.yml');
  const setupFile = join(dir, 'octo', 'setup', SHA, 'action.yml');

  it('names the source in the hover and says Go to Definition opens it', () => {
    const text = hover(DEPLOY);
    expect(text).toContain(
      `\`${DEPLOY}\` · name \`Deploy\` · reusable workflow at \`abcdef1\`, recorded in \`remotes.lock.yaml\``,
    );
    expect(text.split('\n').at(-1)).toBe('Go to Definition opens its source.');
    expect(hover('octo/new')).toContain('`flowpact remotes update` records it in');
  });

  it('goes to the output of a remote action a local composite action uses', () => {
    const composite = setup(
      {
        [CI]: ci,
        [LOCK]: lock,
        '.github/actions/build/action.yml':
          'name: b\nruns:\n  using: composite\n  steps:\n    - id: s\n      uses: octo/setup@v2\n    - run: echo ${{ steps.s.outputs.path }}\n      shell: bash\n',
      },
      { sources },
    );
    expect(composite.targetIn('.github/actions/build/action.yml', 'outputs.path')).toEqual({
      path: setupFile,
      loc: expect.objectContaining({ line: 5 }),
    });
  });

  it('adds the description the source gives a key a remote call passes', () => {
    expect(key('env: prod').markdown.split('\n').at(-1)).toBe('Where to deploy');
    expect(key('token:').markdown.split('\n').at(-1)).toBe('The deploy token');
    expect(key('version:').markdown.split('\n').at(-1)).toBe('The version');
  });

  it('goes from a remote uses: to its source, and from a key or an output read to its declaration there', () => {
    expect(target(DEPLOY)).toEqual({ path: deployFile, loc: expect.objectContaining({ line: 3 }) });
    expect(target('Octo/Setup@v2')).toEqual({ path: setupFile });
    expect(target('env: prod')).toEqual({ path: deployFile, loc: expect.objectContaining({ line: 5 }) });
    expect(target('token:')).toEqual({ path: deployFile, loc: expect.objectContaining({ line: 8 }) });
    expect(target('version:')).toEqual({ path: setupFile, loc: expect.objectContaining({ line: 3 }) });
    expect(target('outputs.url')).toEqual({ path: deployFile, loc: expect.objectContaining({ line: 10 }) });
    expect(target('outputs.path')).toEqual({ path: setupFile, loc: expect.objectContaining({ line: 5 }) });
    expect(target('outputs.nope')).toBeUndefined();
    expect(target('octo/new')).toBeUndefined();
  });

  it('knows which files are in the cache, also through a link to it', () => {
    expect(sources.contains(deployFile)).toBe(true);
    expect(sources.contains(join(dir, '..', 'elsewhere.yml'))).toBe(false);
    expect(sources.contains(dir)).toBe(false);
    const link = `${dir}-link`;
    symlinkSync(dir, link);
    try {
      expect(sources.contains(join(link, 'octo', 'ship', SHA, '.github', 'workflows', 'deploy.yml'))).toBe(
        true,
      );
    } finally {
      rmSync(link);
    }
    expect(new RemoteSources(undefined).contains(deployFile)).toBe(false);
    expect(new RemoteSources(undefined).of(undefined, DEPLOY)).toBeUndefined();
  });

  it('reads a source again once it is back, after it could not be read', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'flowpact-reread-'));
    try {
      const own = new RemoteSources(fresh);
      const lockOf = analyze({
        root: '/r',
        fs: memoryFileSystem({ [CI]: ci, [LOCK]: lock }),
        config: parseConfig({}),
        validateSchema: false,
      }).remotes?.lock;
      // A directory where the file would be: found, but not readable as a file.
      const file = join(fresh, 'octo', 'setup', SHA, 'action.yml');
      mkdirSync(file, { recursive: true });
      expect(own.of(lockOf, 'octo/setup@v2')).toBeUndefined();
      rmSync(file, { recursive: true });
      cacheSource(fresh, { owner: 'octo', repo: 'setup' }, SHA, 'action.yml', SETUP_SOURCE);
      expect(own.of(lockOf, 'octo/setup@v2')?.unit.name).toBe('Setup');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('opens the commit a uses: pins in full, and says when the lockfile records another', () => {
    const pinned = 'd'.repeat(40);
    const pinnedCi = `on: push\njobs:\n  a:\n    uses: octo/ship/.github/workflows/deploy.yml@${pinned}\n`;
    const forged = `version: 1\nremotes:\n  octo/ship/.github/workflows/deploy.yml@${pinned}:\n    sha: ${SHA}\n    kind: workflow\n`;
    const files = { [CI]: pinnedCi, [LOCK]: forged };
    // The cache has the lockfile's commit, not the pinned one: nothing to open.
    expect(
      sources.of(
        analyze({ root: '/r', fs: memoryFileSystem(files), config: parseConfig({}), validateSchema: false })
          .remotes?.lock,
        `octo/ship/.github/workflows/deploy.yml@${pinned}`,
      ),
    ).toBeUndefined();
    const text = setup(files, { sources, webHost: 'github.com' }).hoverIn(CI, pinnedCi, 'octo/ship');
    expect(text).toContain('reusable workflow at `ddddddd`');
    expect(text).toContain('`remotes.lock.yaml` records commit `abcdef1` for it, not the one it pins');
    expect(text).toContain(`(https://github.com/octo/ship/blob/${pinned}/.github/workflows/deploy.yml)`);
  });
});

describe('the host to link sources on', () => {
  const withOrigin = (url: string) => {
    const repo = mkdtempSync(join(tmpdir(), 'flowpact-webhost-'));
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
    return repo;
  };

  it('is where remotes update reads: GITHUB_API_URL, or github.com and GHE.com origins, and nothing it would guess', () => {
    const cases: [string, string | undefined][] = [
      ['https://github.com/o/r.git', 'github.com'],
      ['git@github.com:o/r.git', 'github.com'],
      ['ssh://git@ssh.github.com:443/o/r.git', 'github.com'],
      ['git@github.com-work:o/r.git', 'github.com'],
      ['https://acme.ghe.com/o/r', 'acme.ghe.com'],
      ['git@work:o/r.git', undefined],
      ['https://ghes.example/o/r', undefined],
      ['https://gitlab.com/o/r', undefined],
    ];
    for (const [url, host] of cases) {
      const repo = withOrigin(url);
      try {
        expect(webHostOf(repo, {}), url).toBe(host);
        expect(webHostOf(repo, { GITHUB_API_URL: 'https://ghes.example/api/v3' }), url).toBe('ghes.example');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });
});

describe('links to remote sources', () => {
  const entry = { sha: SHA, kind: 'workflow' as const };

  it('links a workflow file, or an action directory, at the locked commit on the host it was read from', () => {
    expect(sourceLink(DEPLOY, entry, 'github.com')).toBe(
      `https://github.com/octo/ship/blob/${SHA}/.github/workflows/deploy.yml`,
    );
    expect(sourceLink('octo/setup/a#b@v2', { sha: SHA, kind: 'action' }, 'ghes.example')).toBe(
      `https://ghes.example/octo/setup/tree/${SHA}/a%23b`,
    );
    expect(
      sourceLink('octo/setup@v2', { sha: SHA, kind: 'action', host: 'github.com' }, 'ghes.example'),
    ).toBe(`https://github.com/octo/setup/tree/${SHA}`);
  });

  it('links nothing when the host is unknown, or a lockfile names a host flowpact never writes', () => {
    expect(sourceLink(DEPLOY, entry, undefined)).toBeUndefined();
    expect(sourceLink(DEPLOY, { ...entry, host: 'evil.example' }, 'github.com')).toBeUndefined();
  });

  it('reads the host of the origin remote, also of a worktree', () => {
    expect(hostOfGitUrl('https://github.com/o/r.git')).toBe('github.com');
    expect(hostOfGitUrl('git@GHES.example:o/r.git')).toBe('ghes.example');
    expect(hostOfGitUrl('ssh://git@ghes.example:2222/o/r')).toBe('ghes.example');
    expect(hostOfGitUrl('not a url')).toBeUndefined();
    const repo = mkdtempSync(join(tmpdir(), 'flowpact-origin-'));
    try {
      mkdirSync(join(repo, 'main', '.git', 'worktrees', 'wt'), { recursive: true });
      writeFileSync(
        join(repo, 'main', '.git', 'config'),
        '[remote "origin"]\n\tpushurl = https://push.example/o/r\n\turl = git@ghes.example:o/r.git\n',
      );
      writeFileSync(join(repo, 'main', '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
      mkdirSync(join(repo, 'wt'));
      writeFileSync(join(repo, 'wt', '.git'), `gitdir: ${join(repo, 'main', '.git', 'worktrees', 'wt')}\n`);
      expect(originHost(join(repo, 'main'))).toBe('ghes.example');
      expect(originHost(join(repo, 'wt'))).toBe('ghes.example');
      expect(originHost(repo)).toBeUndefined();
      // A directory below the top level, and a submodule, whose git directory (no commondir) is its own.
      mkdirSync(join(repo, 'main', 'nested'));
      expect(originHost(join(repo, 'main', 'nested'))).toBe('ghes.example');
      mkdirSync(join(repo, 'main', '.git', 'modules', 'sub'), { recursive: true });
      writeFileSync(
        join(repo, 'main', '.git', 'modules', 'sub', 'config'),
        '[remote "origin"]\n\turl = https://github.com/o/sub\n',
      );
      mkdirSync(join(repo, 'main', 'sub'));
      writeFileSync(join(repo, 'main', 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
      expect(originHost(join(repo, 'main', 'sub'))).toBe('github.com');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
