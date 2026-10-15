/** The options `flowpact remotes` takes for each action, and the ones it refuses. */

import type { RemoteChangeGrade } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';
import { failsOn, type RemotesArgs, remotesAction, remotesFlags, remotesPaths } from '../src/lib/remotes';

const args = (more: Partial<RemotesArgs> = {}): RemotesArgs => ({ _: [], ...more });

describe('flowpact remotes options', () => {
  it('takes update, download and clean', () => {
    expect(['update', 'download', 'clean'].map(remotesAction)).toEqual(['update', 'download', 'clean']);
    expect(() => remotesAction('check')).toThrow('use `flowpact remotes update`, `download` or `clean`');
  });

  it('reads the flags each action takes', () => {
    expect(remotesFlags(args({ 'dry-run': true, cache: false, 'fail-on': 'breaks' }), 'update')).toEqual({
      dryRun: true,
      noCache: true,
      keep: 0,
      failOn: 'breaks',
    });
    expect(remotesFlags(args({ keep: '2' }), 'clean')).toEqual({
      dryRun: false,
      noCache: false,
      keep: 2,
      failOn: 'never',
    });
    expect(remotesFlags(args({ _: ['download', 'a.yml'] }), 'download').keep).toBe(0);
  });

  it('refuses an option given to an action that does not take it', () => {
    const refused: [Partial<RemotesArgs>, 'update' | 'download' | 'clean', string][] = [
      [{ 'dry-run': true }, 'download', '--dry-run is for `flowpact remotes update`'],
      [{ cache: false }, 'download', '--no-cache is for `flowpact remotes update`'],
      [{ 'dry-run': true }, 'clean', '--dry-run is for `flowpact remotes update`'],
      [{ keep: '2' }, 'update', '--keep is for `flowpact remotes clean`'],
      [
        { _: ['clean', 'a.yml'] },
        'clean',
        'paths are for `flowpact remotes update` and `flowpact remotes download`',
      ],
      [{ cache: false, 'cache-dir': '/c' }, 'update', 'give --no-cache or --cache-dir, not both'],
      [{ keep: 'two' }, 'clean', '--keep takes a whole number, not "two"'],
      [{ keep: '-1' }, 'clean', '--keep takes a whole number, not "-1"'],
      [{ 'fail-on': 'breaks' }, 'download', '--fail-on is for `flowpact remotes update`'],
      [{ 'fail-on': 'error' }, 'update', '--fail-on takes breaks, unchecked or never, not "error"'],
      [
        { 'fail-on': 'constructor' },
        'update',
        '--fail-on takes breaks, unchecked or never, not "constructor"',
      ],
    ];
    for (const [more, action, message] of refused)
      expect(() => remotesFlags(args(more), action)).toThrow(message);
  });

  it('fails on the grades --fail-on names', () => {
    const grades = (...verdicts: RemoteChangeGrade['verdict'][]) =>
      verdicts.map((verdict) => ({ verdict }) as RemoteChangeGrade);
    expect(failsOn('breaks', grades('fits', 'breaks'))).toBe(true);
    expect(failsOn('breaks', grades('unchecked', 'fits'))).toBe(false);
    expect(failsOn('unchecked', grades('unchecked'))).toBe(true);
    expect(failsOn('unchecked', grades('breaks'))).toBe(true);
    expect(failsOn('never', grades('breaks'))).toBe(false);
    expect(failsOn('breaks', [])).toBe(false);
  });

  it('reads the paths after the action', () => {
    expect(remotesPaths(['update', 'a.yml', 'b'], 'update')).toEqual(['a.yml', 'b']);
    expect(remotesPaths(['download'], 'download')).toEqual([]);
  });
});
