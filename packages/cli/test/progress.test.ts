/** What the CLI shows while it fetches: the API and the token first, then a spinner in a terminal. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubAccess } from '../src/lib/github-access';
import { clearStatus, fetchDisplay } from '../src/progress';
import type { CliContext } from '../src/shared';

const ACCESS: GithubAccess = {
  apiUrl: 'https://api.github.com',
  apiFrom: 'default',
  token: 't',
  tokenSource: 'GH_TOKEN',
};
const RETRY = { host: 'api.github.com', attempt: 2, attempts: 3, why: 'connection timed out', waitMs: 300 };

/** A context at `level` whose stderr lines are kept. */
function context(level: CliContext['level']) {
  const lines: string[] = [];
  const ctx = {
    level,
    render: { color: false, width: 100, hyperlinks: false, ascii: false },
    stderr: (s: string) => lines.push(s),
  } as unknown as CliContext;
  return { ctx, lines };
}

let tty: boolean | undefined;
let columns: number | undefined;
let written: string[];

beforeEach(() => {
  tty = process.stderr.isTTY;
  columns = process.stderr.columns;
  written = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    written.push(String(s));
    return true;
  });
});

afterEach(() => {
  process.stderr.isTTY = tty as true;
  process.stderr.columns = columns as number;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchDisplay', () => {
  it('shows nothing with -q', () => {
    expect(fetchDisplay(context('error').ctx, 'fetching')).toBeUndefined();
  });

  it('says how the API is reached once, when there is something to fetch, and each new reason to retry', () => {
    process.stderr.isTTY = false as true;
    const { ctx, lines } = context('warn');
    const display = fetchDisplay(ctx, 'fetching remote interfaces')!;
    display.start(ACCESS, 0);
    expect(lines).toEqual([]);
    display.start(ACCESS, 2);
    display.start(ACCESS, 1);
    display.retry(RETRY);
    display.retry({ ...RETRY, attempt: 3 });
    display.stop();
    expect(lines).toEqual([
      'GitHub API: https://api.github.com (github.com: GITHUB_API_URL is not set)',
      'token: GH_TOKEN',
      'api.github.com: connection timed out; trying again (attempt 2 of 3)',
    ]);
    expect(written).toEqual([]);
  });

  it('draws a spinner in a terminal with the count, the time so far and the latest retry, and clears it', () => {
    vi.useFakeTimers();
    process.stderr.isTTY = true;
    process.stderr.columns = 200;
    const { ctx, lines } = context('warn');
    const display = fetchDisplay(ctx, 'fetching remote interfaces')!;
    display.start(ACCESS, 3);
    expect(lines).toHaveLength(2);
    display.progress({ done: 1, total: 3, ref: 'a', outcome: 'fetched', detail: 'x' });
    display.retry(RETRY);
    vi.advanceTimersByTime(1500);
    const last = written.at(-1)!;
    expect(last).toContain(
      'fetching remote interfaces 1/3 · 1 s · api.github.com: connection timed out, retrying (2/3)',
    );
    expect(last.startsWith('\r\x1b[2K')).toBe(true);
    // Cut to the terminal's width, so that it never wraps.
    process.stderr.columns = 40;
    vi.advanceTimersByTime(100);
    const cut = written.at(-1)!.slice('\r\x1b[2K'.length);
    expect(cut).toMatch(/^. fetching remote interfaces 1\/3.*\.\.\.$/);
    expect(cut.length).toBeLessThan(40);
    // A retry line is for logs; the spinner says it.
    expect(lines).toHaveLength(2);
    // Anything else written to stderr clears the line first.
    written.length = 0;
    clearStatus();
    expect(written).toEqual(['\r\x1b[2K']);
    display.stop();
    expect(written.at(-1)).toBe('\r\x1b[2K');
    written.length = 0;
    vi.advanceTimersByTime(1000);
    expect(written).toEqual([]);
  });

  it('logs at -d instead of drawing a spinner', () => {
    process.stderr.isTTY = true;
    const { ctx, lines } = context('debug');
    const display = fetchDisplay(ctx, 'fetching remote interfaces')!;
    display.start(ACCESS, 1);
    display.retry(RETRY);
    display.stop();
    expect(lines).toHaveLength(2);
    expect(written).toEqual([]);
  });
});
