/** The sources cache when another run renames the same file first, as two runs on Windows can: no error, no change. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedSourcePath, cacheSource } from '@flowpact/lint';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `renameSync` as Windows answers a rename onto a file another run has just written: that file is there, and EPERM.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const renameSync = (from: string, to: string) => {
    fs.writeFileSync(to, 'name: first\n', { mode: 0o400 });
    throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), {
      code: 'EPERM',
    });
  };
  return { ...fs, renameSync, default: { ...fs, renameSync } };
});

const SHA = 'a'.repeat(40);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('cacheSource racing another run', () => {
  it('finds the file the other run wrote, keeps it, and leaves no temporary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpact-race-'));
    dirs.push(dir);
    const r = { owner: 'octo', repo: 'setup' };
    expect(cacheSource(dir, r, SHA, 'action.yml', 'name: second\n')).toBe('present');
    const path = cachedSourcePath(dir, r, SHA, 'action.yml')!;
    expect(readFileSync(path, 'utf8')).toBe('name: first\n');
    expect(readdirSync(join(dir, 'octo', 'setup', SHA))).toEqual(['action.yml']);
  });
});
