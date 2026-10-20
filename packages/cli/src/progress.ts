/**
 * What the CLI shows while it reads remote repositories, on stderr: before the first request, the GitHub API and the
 * token, and where each came from; then in a terminal, a spinner with the count, the time so far and the latest retry,
 * else a line for each new reason to retry. Nothing with -q; -d logs each request instead of the spinner.
 */
import { escapeControl } from '@ciatlas/core';
import type { FetchRetry } from '@flowpact/lint';
import pc from 'picocolors';
import { accessLines } from './lib/github-access';
import type { FetchDisplay } from './lib/remotes';
import type { CliContext } from './shared';

/** The spinner's line while it is shown, to clear before anything else is written to stderr. */
let shown: { clear: () => void } | undefined;

/** Clears the spinner's line, if one is shown, before a line is written to stderr; its next frame draws it again. */
export function clearStatus(): void {
  shown?.clear();
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['|', '/', '-', '\\'];
const FRAME_MS = 100;

/** `what` the spinner says it is doing: `fetching remote interfaces`, `downloading remote sources`. */
export function fetchDisplay(ctx: CliContext, what: string): FetchDisplay | undefined {
  if (ctx.level === 'error') return undefined;
  const c = pc.createColors(ctx.render.color);
  const quietLevel = ctx.level === 'warn' || ctx.level === 'info';
  const live = quietLevel && Boolean(process.stderr.isTTY);
  let described = false;
  let count = { done: 0, total: 0 };
  let retry: FetchRetry | undefined;
  const told = new Set<string>();
  let spinner: { stop: () => void } | undefined;
  const status = () =>
    [
      `${what} ${count.done}/${count.total}`,
      retry ? `${retry.host}: ${retry.why}, retrying (${retry.attempt}/${retry.attempts})` : '',
    ].filter(Boolean);
  return {
    start(access, total) {
      if (!total) return;
      count.total += total;
      if (!described) for (const line of accessLines(access)) ctx.stderr(c.dim(escapeControl(line)));
      described = true;
      if (live) spinner ??= startSpinner(status, ctx);
    },
    progress() {
      count.done++;
      retry = undefined;
    },
    retry(r) {
      retry = r;
      const said = `${r.host}: ${r.why}`;
      if (live || !quietLevel || told.has(said)) return;
      told.add(said);
      ctx.stderr(c.dim(escapeControl(`${said}; trying again (attempt ${r.attempt} of ${r.attempts})`)));
    },
    stop() {
      spinner?.stop();
      spinner = undefined;
      count = { done: 0, total: 0 };
      retry = undefined;
    },
  };
}

/**
 * A spinner on stderr, drawn every `FRAME_MS` until stopped: a frame, the status, and the seconds so far after the
 * first. The line is cut to the terminal's width, so that it never wraps and each frame replaces the last.
 */
function startSpinner(status: () => string[], ctx: CliContext): { stop: () => void } {
  const frames = ctx.render.ascii ? ASCII_FRAMES : FRAMES;
  const c = pc.createColors(ctx.render.color);
  const t0 = Date.now();
  let frame = 0;
  const draw = () => {
    const seconds = Math.floor((Date.now() - t0) / 1000);
    const [doing, ...rest] = status();
    const text = escapeControl([doing, ...(seconds ? [`${seconds} s`] : []), ...rest].join(' · '));
    const width = (process.stderr.columns || 80) - 3;
    const cut = text.length > width ? `${text.slice(0, width - 3)}...` : text;
    process.stderr.write(`\r\x1b[2K${c.cyan(frames[frame++ % frames.length]!)} ${cut}`);
  };
  const clear = () => process.stderr.write('\r\x1b[2K');
  draw();
  // Unref'd: a spinner never keeps the process alive.
  const timer = setInterval(draw, FRAME_MS).unref();
  shown = { clear };
  return {
    stop: () => {
      clearInterval(timer);
      clear();
      shown = undefined;
    },
  };
}
