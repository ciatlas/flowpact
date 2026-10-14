import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codeOf,
  type ExtensionSettings,
  hidesOverlapInOpenedFiles,
  isInside,
  serverSettings,
  withoutOverlap,
} from '../src/settings';

const defaults: ExtensionSettings = {
  plugins: true,
  contracts: 'auto',
  overlappingRules: 'auto',
  hiddenRules: [],
};
const INFO = 3;

describe('serverSettings', () => {
  it('loads plugins only in trusted workspaces', () => {
    expect(serverSettings(defaults, { trusted: true, logLevel: INFO }).plugins).toBe(true);
    expect(serverSettings(defaults, { trusted: false, logLevel: INFO }).plugins).toBe(false);
    expect(serverSettings({ ...defaults, plugins: false }, { trusted: true, logLevel: INFO }).plugins).toBe(
      false,
    );
  });

  it('normalizes hidden rules and hides the overlapping ones everywhere only when asked', () => {
    const env = { trusted: true, logLevel: INFO };
    expect(serverSettings({ ...defaults, hiddenRules: [' fp604 ', '', 'FP604'] }, env).hiddenRules).toEqual([
      'FP604',
    ]);
    expect(serverSettings(defaults, env).hiddenRules).toEqual([]);
    expect(serverSettings({ ...defaults, overlappingRules: 'hide' }, env).hiddenRules).toEqual([
      'FP502',
      'FP503',
      'FP504',
      'FP505',
    ]);
  });

  it('follows the output channel’s log level', () => {
    const level = (logLevel: number) => serverSettings(defaults, { trusted: true, logLevel }).logLevel;
    expect([0, 1, 2, 3, 4, 5, 9].map(level)).toEqual([
      'silent',
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'info',
    ]);
  });
});

describe('overlap with the GitHub Actions extension', () => {
  it('hides FP502–FP505 in opened files only while that extension runs (trusted workspaces)', () => {
    expect(hidesOverlapInOpenedFiles(defaults, { trusted: true, githubActions: true })).toBe(true);
    expect(hidesOverlapInOpenedFiles(defaults, { trusted: false, githubActions: true })).toBe(false);
    expect(hidesOverlapInOpenedFiles(defaults, { trusted: true, githubActions: false })).toBe(false);
    expect(
      hidesOverlapInOpenedFiles({ overlappingRules: 'show' }, { trusted: true, githubActions: true }),
    ).toBe(false);
    // `hide` is handled by the server for every file, not by this filter.
    expect(
      hidesOverlapInOpenedFiles({ overlappingRules: 'hide' }, { trusted: true, githubActions: true }),
    ).toBe(false);
  });

  it('reads codes with or without a docs link', () => {
    expect(codeOf({ code: { value: 'FP503' } })).toBe('FP503');
    expect(codeOf({ code: 'FP101' })).toBe('FP101');
    expect(codeOf({})).toBe('');
    const kept = withoutOverlap([{ code: { value: 'FP503' } }, { code: 'FP504' }, { code: 'FP101' }, {}]);
    expect(kept).toEqual([{ code: 'FP101' }, {}]);
  });
});

describe('isInside', () => {
  it('tells the files of the remote sources cache from others, on POSIX and Windows paths', () => {
    const dir = '/home/u/.cache/flowpact/remotes';
    expect(isInside(dir, `${dir}/octo/ship/abc/action.yml`, posix.relative)).toBe(true);
    expect(isInside(dir, dir, posix.relative)).toBe(false);
    expect(isInside(dir, '/home/u/.cache/flowpact/remotes-other/x.yml', posix.relative)).toBe(false);
    expect(isInside(dir, '/home/u/repo/.github/workflows/ci.yml', posix.relative)).toBe(false);
    const win = 'C:\\Users\\u\\AppData\\Local\\flowpact\\Cache\\remotes';
    expect(
      isInside(
        win,
        'c:\\users\\u\\appdata\\local\\flowpact\\cache\\remotes\\o\\r\\action.yml',
        win32.relative,
      ),
    ).toBe(true);
    expect(isInside(win, 'D:\\repo\\action.yml', win32.relative)).toBe(false);
  });
});
