import { memoryFileSystem, overlayFileSystem } from '@ciatlas/core';
import { analyze, parseConfig } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { codes, WF, yaml } from './helpers';

// The SymbolLocator and overlayFileSystem tests live in ciatlas/core (test/locate.test.ts).
describe('overlayFileSystem', () => {
  it('lets the analysis see unsaved edits', () => {
    const disk = {
      [`${WF}/caller.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/callee.yml
            with: { name: x }
      `,
      [`${WF}/callee.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              name: { type: string }
        jobs:
          j: { runs-on: x, steps: [{ run: 'echo \${{ inputs.name }}' }] }
      `,
    };
    const run = (fs = memoryFileSystem(disk)) =>
      analyze({
        root: '/virtual/repo',
        fs,
        config: parseConfig({}),
        validateSchema: false,
        repository: 'acme/repo',
      });
    expect(codes(run())).toEqual([]);
    const edited = disk[`${WF}/caller.yml`]!.replace('name: x', 'nmae: x');
    expect(
      codes(run(overlayFileSystem(memoryFileSystem(disk), new Map([[`${WF}/caller.yml`, edited]])))),
    ).toContain('FP102');
  });
});
