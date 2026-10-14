/** The remote sources cache: where it is, which paths it refuses, and how it writes. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cachedSource,
  cachedSourcePath,
  cacheSource,
  commitKey,
  envCacheDir,
  inCi,
  pruneCache,
  remotesCacheDir,
  remotesCacheIn,
  sourceFiles,
  touchCommit,
} from '@flowpact/lint';
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
  const at = () => home;

  it('uses the platform per-user cache, under flowpact/remotes', () => {
    expect(remotesCacheDir({}, 'linux', at)).toBe(join(home, '.cache', 'flowpact', 'remotes'));
    expect(remotesCacheDir({ XDG_CACHE_HOME: '/x/cache' }, 'linux', at)).toBe(
      join('/x/cache', 'flowpact', 'remotes'),
    );
    expect(remotesCacheDir({}, 'darwin', at)).toBe(join(home, 'Library', 'Caches', 'flowpact', 'remotes'));
    expect(remotesCacheDir({ LOCALAPPDATA: '/c/AppData/Local' }, 'win32', at)).toBe(
      join('/c/AppData/Local', 'flowpact', 'Cache', 'remotes'),
    );
    expect(remotesCacheDir({}, 'win32', at)).toBe(
      join(home, 'AppData', 'Local', 'flowpact', 'Cache', 'remotes'),
    );
  });

  it('prefers FLOWPACT_CACHE_DIR, and ignores relative paths, which would depend on where flowpact runs', () => {
    expect(remotesCacheDir({ FLOWPACT_CACHE_DIR: '/tmp/fp' }, 'linux', at)).toBe(join('/tmp/fp', 'remotes'));
    expect(remotesCacheDir({ FLOWPACT_CACHE_DIR: 'rel', XDG_CACHE_HOME: 'rel2' }, 'linux', at)).toBe(
      join(home, '.cache', 'flowpact', 'remotes'),
    );
  });
});

describe('remotesCacheDir without a home directory', () => {
  const throws = () => {
    throw new Error('uv_os_homedir returned ENOENT');
  };

  it('looks for the home directory only when no variable gives a path, and never throws', () => {
    expect(remotesCacheDir({ FLOWPACT_CACHE_DIR: '/abs' }, 'linux', throws)).toBe(join('/abs', 'remotes'));
    expect(remotesCacheDir({ XDG_CACHE_HOME: '/x' }, 'linux', throws)).toBe(
      join('/x', 'flowpact', 'remotes'),
    );
    expect(remotesCacheDir({ LOCALAPPDATA: '/l' }, 'win32', throws)).toBe(
      join('/l', 'flowpact', 'Cache', 'remotes'),
    );
    expect(() => remotesCacheDir({}, 'linux', throws)).not.toThrow();
  });

  it('gives none rather than a relative one, which would put the cache wherever flowpact runs', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(remotesCacheDir({}, platform, () => '')).toBeUndefined();
      expect(remotesCacheDir({}, platform, () => 'relative')).toBeUndefined();
      expect(remotesCacheDir({}, platform, () => undefined)).toBeUndefined();
    }
  });
});

describe('the cache directory given, and CI', () => {
  it('puts the sources in the remotes directory of a --cache-dir, relative to where flowpact runs', () => {
    expect(remotesCacheIn('/x/cache')).toBe(join('/x/cache', 'remotes'));
    expect(remotesCacheIn('rel')).toBe(join(process.cwd(), 'rel', 'remotes'));
  });

  it('reads FLOWPACT_CACHE_DIR only when it is absolute', () => {
    expect(envCacheDir({ FLOWPACT_CACHE_DIR: '/x' })).toBe('/x');
    expect(envCacheDir({ FLOWPACT_CACHE_DIR: 'x' })).toBeUndefined();
    expect(envCacheDir({})).toBeUndefined();
  });

  it('knows CI by CI, TF_BUILD or JENKINS_URL', () => {
    for (const env of [
      { CI: 'true' },
      { CI: '1' },
      { CI: 'True' },
      { TF_BUILD: 'True' },
      { JENKINS_URL: 'https://j' },
    ])
      expect(inCi(env), JSON.stringify(env)).toBe(true);
    for (const env of [{}, { CI: '' }, { CI: 'false' }, { CI: '0' }])
      expect(inCi(env), JSON.stringify(env)).toBe(false);
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
    if (process.platform !== 'win32') {
      // Read-only, and for your user alone: private repositories' files land here too.
      expect(statSync(found.path).mode & 0o777).toBe(0o400);
      expect(statSync(join(dir, 'octo')).mode & 0o077).toBe(0);
    }
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

describe('pruneCache', () => {
  const sha = (c: string) => c.repeat(40);
  /** A cache with octo/ship at commits 1–4 used in that order (4 last), and octo/setup at 5. */
  function seeded() {
    const dir = tempDir();
    let t = 1_700_000_000;
    for (const c of ['1', '2', '3', '4']) {
      cacheSource(dir, { owner: 'octo', repo: 'ship' }, sha(c), 'action.yml', c);
      const at = new Date(++t * 1000);
      utimesSync(join(dir, 'octo', 'ship', sha(c)), at, at);
    }
    cacheSource(dir, { owner: 'octo', repo: 'setup' }, sha('5'), 'action.yml', '5');
    return dir;
  }
  const left = (dir: string, repo = 'ship') => readdirSync(join(dir, 'octo', repo)).sort();

  it('keeps the most recently used commits of each repository', () => {
    const dir = seeded();
    expect(pruneCache(dir, 2)).toEqual({ removed: 2 });
    expect(left(dir)).toEqual([sha('3'), sha('4')]);
    expect(left(dir, 'setup')).toEqual([sha('5')]);
  });

  it('never removes a commit the run uses, and prunes only the repositories it names', () => {
    const dir = seeded();
    const used = new Set([commitKey({ owner: 'Octo', repo: 'Ship' }, sha('1'))]);
    expect(pruneCache(dir, 2, { repos: ['Octo/Ship'], keep: used })).toEqual({ removed: 1 });
    expect(left(dir)).toEqual([sha('1'), sha('3'), sha('4')]);
    expect(pruneCache(dir, 0, { repos: ['octo/other'] })).toEqual({ removed: 0 });
  });

  it('marks a commit as used, so it outlives the ones not used since', () => {
    const dir = seeded();
    touchCommit(dir, { owner: 'OCTO', repo: 'ship' }, sha('1'));
    pruneCache(dir, 1);
    expect(left(dir)).toEqual([sha('1')]);
  });

  it('empties the cache with 0, removing empty directories, and leaves what flowpact did not put there', () => {
    const dir = seeded();
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    mkdirSync(join(dir, 'octo', 'ship', 'not-a-commit'));
    const outside = tempDir();
    mkdirSync(join(outside, sha('9')));
    writeFileSync(join(outside, sha('9'), 'keep.txt'), 'keep');
    symlinkSync(join(outside, sha('9')), join(dir, 'octo', 'setup', sha('9')));
    expect(pruneCache(dir, 0)).toEqual({ removed: 5 });
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(readdirSync(join(dir, 'octo', 'ship'))).toEqual(['not-a-commit']);
    // The link is not a cached commit: neither it nor what it points at is touched.
    expect(readFileSync(join(outside, sha('9'), 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(dir, 'octo', 'setup', sha('9')))).toBe(true);
    expect(pruneCache(join(dir, 'missing'), 0)).toEqual({ removed: 0 });
  });
});
