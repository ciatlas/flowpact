/** The remote sources cache: where it is, which paths it refuses, and how it writes. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedSource, cachedSourcePath, cacheSource, remotesCacheDir, sourceFiles } from '@flowpact/lint';
import { afterEach, describe, expect, it } from 'vitest';

const SHA = 'a'.repeat(40);
const SHIP = { owner: 'Octo', repo: 'Ship' };
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'flowpact-cache-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('remotesCacheDir', () => {
  const home = '/home/u';

  it('uses the platform per-user cache, under flowpact/remotes', () => {
    expect(remotesCacheDir({}, 'linux', home)).toBe(join(home, '.cache', 'flowpact', 'remotes'));
    expect(remotesCacheDir({ XDG_CACHE_HOME: '/x/cache' }, 'linux', home)).toBe(
      join('/x/cache', 'flowpact', 'remotes'),
    );
    expect(remotesCacheDir({}, 'darwin', home)).toBe(join(home, 'Library', 'Caches', 'flowpact', 'remotes'));
    expect(remotesCacheDir({ LOCALAPPDATA: '/c/AppData/Local' }, 'win32', home)).toBe(
      join('/c/AppData/Local', 'flowpact', 'Cache', 'remotes'),
    );
    expect(remotesCacheDir({}, 'win32', home)).toBe(
      join(home, 'AppData', 'Local', 'flowpact', 'Cache', 'remotes'),
    );
  });

  it('prefers FLOWPACT_CACHE_DIR, and ignores relative paths, which would depend on where flowpact runs', () => {
    expect(remotesCacheDir({ FLOWPACT_CACHE_DIR: '/tmp/fp' }, 'linux', home)).toBe(
      join('/tmp/fp', 'remotes'),
    );
    expect(remotesCacheDir({ FLOWPACT_CACHE_DIR: 'rel', XDG_CACHE_HOME: 'rel2' }, 'linux', home)).toBe(
      join(home, '.cache', 'flowpact', 'remotes'),
    );
  });
});

describe('cachedSourcePath', () => {
  const dir = join('/cache', 'remotes');

  it('keeps a file by owner and repository in lower case, commit and path', () => {
    expect(cachedSourcePath(dir, SHIP, SHA, '.github/workflows/deploy.yml')).toBe(
      join(dir, 'octo', 'ship', SHA, '.github', 'workflows', 'deploy.yml'),
    );
  });

  it('refuses what could leave the directory or is no file name on every platform', () => {
    for (const file of [
      '../../../etc/passwd',
      'a/../../b',
      './action.yml',
      'a//action.yml',
      'C:/x/action.yml',
      'a\\..\\b/action.yml',
      'con/action.yml',
      'LPT1.txt/action.yml',
      'dir./action.yml',
      'dir /action.yml',
      'a\u0001b/action.yml',
      'a|b/action.yml',
    ])
      expect(cachedSourcePath(dir, SHIP, SHA, file), file).toBeUndefined();
    expect(cachedSourcePath(dir, { owner: '..', repo: 'x' }, SHA, 'action.yml')).toBeUndefined();
    expect(cachedSourcePath(dir, { owner: 'octo', repo: '.' }, SHA, 'action.yml')).toBeUndefined();
    expect(cachedSourcePath(dir, SHIP, 'v1', 'action.yml')).toBeUndefined();
    expect(cachedSourcePath(dir, SHIP, SHA.toUpperCase(), 'action.yml')).toBeUndefined();
  });

  it('lists the files an interface is read from: the workflow file, or action.yml then action.yaml', () => {
    expect(sourceFiles({ kind: 'workflow', path: '.github/workflows/d.yml' })).toEqual([
      '.github/workflows/d.yml',
    ]);
    expect(sourceFiles({ kind: 'action', path: '' })).toEqual(['action.yml', 'action.yaml']);
    expect(sourceFiles({ kind: 'action', path: 'setup' })).toEqual(['setup/action.yml', 'setup/action.yaml']);
  });
});

describe('cacheSource and cachedSource', () => {
  it('writes a file once, read-only, and finds it again', () => {
    const dir = tempDir();
    const action = { kind: 'action' as const, ...SHIP, path: 'setup' };
    expect(cachedSource(dir, action, SHA)).toBeUndefined();
    expect(cacheSource(dir, SHIP, SHA, 'setup/action.yaml', 'name: x\n')).toBe('written');
    const found = cachedSource(dir, action, SHA)!;
    expect(found.file).toBe('setup/action.yaml');
    expect(readFileSync(found.path, 'utf8')).toBe('name: x\n');
    if (process.platform !== 'win32') expect(statSync(found.path).mode & 0o222).toBe(0);
    expect(cacheSource(dir, SHIP, SHA, 'setup/action.yaml', 'other')).toBe('present');
    expect(readFileSync(found.path, 'utf8')).toBe('name: x\n');
  });

  it('refuses an unsafe path, and says why it could not write without throwing', () => {
    const dir = tempDir();
    expect(cacheSource(dir, SHIP, SHA, '../x.yml', 'x')).toBe('unsafe');
    // A file where the owner's directory would go.
    writeFileSync(join(dir, 'octo'), '');
    expect(cacheSource(dir, SHIP, SHA, 'action.yml', 'x')).toEqual({ failed: expect.any(String) });
  });
});
