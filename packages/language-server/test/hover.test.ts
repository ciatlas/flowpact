import { memoryFileSystem, SymbolLocator } from '@ciatlas/core';
import { analyze, parseConfig } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { hoverMarkdown } from '../src/hover';

const ROOT = '.github/workflows/root.yml';
const MID = '.github/workflows/mid.yml';
const BUILD = '.github/actions/build/action.yml';
const ACTION = 'action.yml';

const LONG = 'The configuration file the build reads. '.repeat(6).trim();

const files: Record<string, string> = {
  [ROOT]: `on:
  workflow_dispatch:
    inputs:
      level:
        type: choice
        options: [low, high, a, b, c, d, e]
        default: low
        description: Use *care* [here]
jobs:
  mid:
    uses: ./.github/workflows/mid.yml
    with:
      cfg: x
    secrets:
      TOKEN: \${{ secrets.DEPLOY_TOKEN }}
  other:
    uses: ./.github/workflows/mid.yml
    with:
      cfg: \${{ inputs.level }}
    secrets: inherit
  after:
    needs: [mid]
    name: After \${{ inputs.level }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
    env:
      MODE: fast
    steps:
      - id: co
        uses: actions/checkout@v4
      - id: build
        uses: ./.github/actions/build
      - id: sh
        run: echo "v=1" >> "$GITHUB_OUTPUT"
      - uses: ./
        with:
          arm: ''
      - run: echo \${{ needs.mid.outputs.result }} \${{ steps.sh.outputs.v }} \${{ steps.co.outputs.ref }} \${{ env.MODE }} \${{ vars.REGION }} \${{ matrix.n }} \${{ steps.build.outputs.artifact }} \${{ secrets.GITHUB_TOKEN }} \${{ secrets.NPM }}
  dyn:
    runs-on: x
    strategy:
      matrix: \${{ fromJSON('{"k":[1]}') }}
    steps:
      - run: echo \${{ needs.mid.result }}
  remote:
    uses: acme/shared/.github/workflows/deploy.yml@v1
`,
  [MID]: `on:
  workflow_call:
    inputs:
      cfg: { type: string, required: true, description: "${LONG}" }
    secrets:
      TOKEN: { required: true, description: Deploys }
    outputs:
      result:
        description: The result
        value: \${{ jobs.leaf.outputs.r }}
jobs:
  leaf:
    runs-on: x
    outputs:
      r: \${{ steps.s.outputs.r }}
    steps:
      - id: s
        run: echo "r=\${{ inputs.cfg }}\${{ secrets.TOKEN }}\${{ secrets.UNDECLARED }}" >> $GITHUB_OUTPUT
`,
  [BUILD]: `name: build
outputs:
  artifact:
    value: x
runs:
  using: composite
  steps: []
`,
  [ACTION]: `name: root action
inputs:
  arm: { required: false, default: '' }
runs:
  using: composite
  steps:
    - run: echo \${{ inputs.arm }}
      shell: bash
`,
};

const locator = new SymbolLocator(
  analyze({
    root: '/virtual/repo',
    fs: memoryFileSystem(files),
    config: parseConfig({}),
    validateSchema: false,
    repository: 'acme/repo',
  }).index,
);

/** Hover text at the nth occurrence of `needle` (moved right by `offset`). */
function hover(file: string, needle: string, offset = 0, nth = 0): string {
  const text = files[file]!;
  let i = -1;
  for (let n = 0; n <= nth; n++) {
    i = text.indexOf(needle, i + 1);
    if (i < 0) throw new Error(`${needle} not found`);
  }
  const before = text.slice(0, i + offset).split('\n');
  const at = locator.at(file, before.length, before.at(-1)!.length + 1);
  if (!at) throw new Error(`no symbol at ${needle}`);
  return hoverMarkdown(locator, at);
}

const header = (s: string) => s.split('\n')[0];

describe('hoverMarkdown', () => {
  it('starts with a header naming flowpact, the kind and a docs link', () => {
    for (const h of [hover(ROOT, 'inputs.level', 7), hover(ROOT, '  after:', 2), hover(ROOT, 'vars.REGION')])
      expect(header(h)).toMatch(
        /^\*\*flowpact\*\* · [a-z ]+ · \[docs\]\(https:\/\/.+\/docs\/editors#hover\)$/,
      );
    expect(header(hover(ROOT, 'inputs.level', 7))).toContain('· input ·');
    expect(header(hover(ROOT, '  after:', 2))).toContain('· job ·');
  });

  it('describes inputs on one line, escaping and cutting descriptions and long lists', () => {
    const text = hover(ROOT, 'inputs.level', 7);
    expect(text).toContain(
      '`inputs.level` in `root.yml` · `choice` · optional · default `low` · one of `low`, `high`, `a`, `b`, `c` +2',
    );
    expect(text).toContain('Use \\*care\\* \\[here\\]');
    expect(text).toMatch(/\*\*To\*\* `mid\.yml#inputs\.cfg` · job name in `jobs\.after › name`/);
    const cut = hover(MID, 'inputs.cfg', 7);
    expect(cut).toMatch(/The configuration file .{100,}…/);
    expect(cut).not.toContain(LONG);
  });

  it('shows what this call passes on a with: key, and counts the other callers', () => {
    const text = hover(ROOT, 'cfg: x');
    expect(text).toContain('`inputs.cfg` in `mid.yml` · `string` · required');
    expect(text).toContain('this call passes `x` · 1 other caller');
    expect(text).toMatch(/\*\*To\*\* run script in `jobs\.leaf › steps\[0\] › run`/);
    // Other callers' values are not traced into this call's hover.
    expect(text).not.toContain('**From**');
    expect(text).not.toContain('inputs.level');
    expect(hover(ROOT, "arm: ''")).toContain('this call passes an empty value');
  });

  it('says where a job output and a step output come from', () => {
    const output = hover(ROOT, 'needs.mid.outputs.result', 20);
    expect(output).toContain(
      '`jobs.mid.outputs.result` in `root.yml` · from `mid.yml` · value `${{ jobs.leaf.outputs.r }}`',
    );
    expect(output).toMatch(/\*\*From\*\* `mid\.yml#outputs\.result`/);
    expect(hover(ROOT, 'steps.build.outputs.artifact')).toContain(
      '· from `.github/actions/build` · value `x`',
    );
    expect(hover(ROOT, 'steps.sh.outputs.v')).toContain('written by the step’s script');
    expect(hover(ROOT, 'steps.co.outputs.ref')).toContain('outputs of `actions/checkout@v4`, not declared');
  });

  it('describes jobs, env, matrix keys and units', () => {
    expect(hover(ROOT, '  after:', 2)).toContain(
      '`jobs.after` in `root.yml` · name `After ${{ inputs.level }}` · needs `mid` · 14 matrix combinations',
    );
    expect(hover(ROOT, '  dyn:', 2)).toContain('matrix computed at runtime');
    expect(hover(ROOT, 'needs.mid.result')).toContain('calls `./.github/workflows/mid.yml`');
    expect(hover(ROOT, 'env.MODE')).toContain('value `fast`');
    const matrix = hover(ROOT, 'matrix.n');
    expect(matrix).toContain('values `1`, `2`, `3`, `4`, `5` +9');
    // The values are the sources; they are not listed again under From.
    expect(matrix).not.toContain('**From**');
    expect(hover(ROOT, './.github/workflows/mid.yml')).toContain(
      '`mid.yml` · on `workflow_call` · called by 2 jobs',
    );
    expect(hover(ROOT, './.github/actions/build')).toContain(
      '`.github/actions/build` · name `build` · used by 1 step',
    );
    expect(hover(ROOT, 'uses: ./\n', 6)).toContain('`action.yml` · name `root action` · used by 1 step');
    expect(hover(ACTION, 'inputs.arm', 7)).toContain(
      '`inputs.arm` in `action.yml` · optional · default empty',
    );
  });

  it('caps the flow lines', () => {
    const text = hover(ROOT, 'env.MODE');
    for (const line of text.split('\n').filter((l) => /^\*\*(From|To)\*\*/.test(l)))
      expect(line.split(' · ').length).toBeLessThanOrEqual(3);
  });

  it('explains values declared outside the analyzed files', () => {
    const vars = hover(ROOT, 'vars.REGION');
    expect(vars).toContain('`vars.REGION` · set in the repository, environment or organization settings');
    expect(vars).not.toContain(' in `');
    expect(hover(ROOT, 'acme/shared')).toContain('in another repository; its interface is not verified');
    expect(hover(ROOT, 'secrets.GITHUB_TOKEN')).toContain('provided by GitHub in every run');
    expect(hover(ROOT, 'secrets.NPM')).toContain('a repository, environment or organization secret');
    expect(hover(MID, 'secrets.UNDECLARED')).toContain('not declared under `on.workflow_call.secrets`');
    expect(header(hover(ROOT, 'secrets.DEPLOY_TOKEN'))).toContain('· secret ·');
  });
});
