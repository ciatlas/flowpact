/** The remote sources cache: where it is, and how flowpact finds and prunes files in core's directory cache. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directoryRemoteCache, parseRemoteRef } from '@ciatlas/core';
import {
  cachedSource,
  commitKey,
  envCacheDir,
  inCi,
  pruneUsed,
  remotesCacheDir,
  remotesCacheIn,
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

describe('cachedSource', () => {
  const bytes = (t: string) => new TextEncoder().encode(t);

  it("finds a reference's file in core's cache, on the host it was read from", () => {
    const cache = directoryRemoteCache(tempDir());
    const action = { kind: 'action' as const, ...SHIP, path: 'setup' };
    expect(cachedSource(cache, 'github.com', action, SHA)).toBeUndefined();
    const key = { host: 'github.com', owner: 'octo', repo: 'ship', sha: SHA, file: 'setup/action.yaml' };
    expect(cache.write(key, bytes('name: x\n'))).toBe('written');
    const found = cachedSource(cache, 'GitHub.com', action, SHA)!;
    expect(found).toEqual({
      path: join(cache.dir, 'github.com', 'octo', 'ship', SHA, 'setup', 'action.yaml'),
      file: 'setup/action.yaml',
    });
    expect(readFileSync(found.path, 'utf8')).toBe('name: x\n');
    expect(cachedSource(cache, 'ghe.example.com', action, SHA)).toBeUndefined();
  });
});

describe('pruneUsed', () => {
  const sha = (c: string) => c.repeat(40);

  it('keeps the most recently used commits of each repository, and every one used on any host', () => {
    const dir = tempDir();
    const cache = directoryRemoteCache(dir);
    let t = 1_700_000_000;
    for (const c of ['1', '2', '3', '4', '5']) {
      cache.write(
        { host: 'github.com', owner: 'octo', repo: 'ship', sha: sha(c), file: 'action.yml' },
        new Uint8Array([1]),
      );
      const at = new Date(++t * 1000);
      utimesSync(join(dir, 'github.com', 'octo', 'ship', sha(c)), at, at);
    }
    const used = new Set([commitKey({ owner: 'Octo', repo: 'Ship' }, sha('1'))]);
    expect(pruneUsed(dir, used)).toMatchObject({ removed: 1 });
    expect(readdirSync(join(dir, 'github.com', 'octo', 'ship')).sort()).toEqual(
      [sha('1'), sha('3'), sha('4'), sha('5')].sort(),
    );
  });

  it("leaves the layout without a host alone: before core's cache, nothing reads it", () => {
    const dir = tempDir();
    const old = join(dir, 'octo', 'ship', SHA);
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'action.yml'), 'name: old\n');
    expect(pruneUsed(dir, new Set())).toMatchObject({ removed: 0 });
    expect(existsSync(join(old, 'action.yml'))).toBe(true);
    const action = parseRemoteRef('octo/ship@v1', 'action')!;
    expect(cachedSource(directoryRemoteCache(dir), 'github.com', action, SHA)).toBeUndefined();
  });
});
