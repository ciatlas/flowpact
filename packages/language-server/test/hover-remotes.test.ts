import { memoryFileSystem, SymbolLocator } from '@ciatlas/core';
import { analyze, parseConfig } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { hoverMarkdown, remoteBindingMarkdown } from '../src/hover';
import { RemoteBindings } from '../src/remotes';

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

function setup(files: Record<string, string>) {
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
    return hoverMarkdown(locator, at, result.remotes);
  };
  const key = (needle: string, nth = 0) => {
    const found = remotes.at(CI, ...pos(needle, 0, nth));
    if (!found) throw new Error(`no remote key at ${needle}`);
    return { found, markdown: remoteBindingMarkdown(found, remotes.occurrences(found.at.symbol).length) };
  };
  return { hover, key, remotes, locator };
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
    ]);
  });

  it('names the host an entry was read from, and matches a reference in any case', () => {
    const text = hover('Octo/Setup@v2');
    expect(text).toContain(
      '`Octo/Setup@v2` · action at `abcdef1` on github\\.com, recorded in `remotes.lock.yaml`',
    );
    expect(text).toContain('**Inputs** `version` (required)  \n**Outputs** `path`');
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
