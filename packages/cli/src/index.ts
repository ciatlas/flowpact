#!/usr/bin/env node
// The `flowpact` command. Its hashbang stays at the top of dist/index.js (the API's dist/api.js has none).
import { bannerText, DOCS_BASE_URL, neutralizeWorkflowCommands, VERSION } from '@flowpact/core';
import { type ArgsDef, type CommandDef, defineCommand, renderUsage, runCommand, runMain } from 'citty';
import pc from 'picocolors';
import { checkCommand } from './commands/check';
import { explainCommand } from './commands/explain';
import { generateCommand } from './commands/generate';
import { graphCommand } from './commands/graph';
import { impactCommand } from './commands/impact';
import { lintCommand } from './commands/lint';
import { lspCommand } from './commands/lsp';
import { rulesCommand } from './commands/rules';
import { traceCommand } from './commands/trace';
import { colorEnabled } from './lib/text';
import { normalizeArgv } from './shared';

const COMMANDS = {
  lint: lintCommand,
  check: checkCommand,
  generate: generateCommand,
  impact: impactCommand,
  trace: traceCommand,
  graph: graphCommand,
  explain: explainCommand,
  rules: rulesCommand,
  lsp: lspCommand,
};

// Before anything reads the arguments: values of string flags are attached to their flags, so that a value such as a
// pull request title is never read as `--`, `--no-plugins` or `--help` (see normalizeArgv).
try {
  process.argv.splice(2, Infinity, ...normalizeArgv(process.argv.slice(2), COMMANDS));
} catch (err) {
  process.stderr.write(neutralizeWorkflowCommands(`Error: ${(err as Error).message}\n`));
  process.exit(2);
}

// Output embeds names from the analyzed YAML; no line of it may become a GitHub workflow command in a CI log. The
// language server's stdout carries the protocol and must stay byte-exact.
const lsp = process.argv.slice(2).find((a) => !a.startsWith('-')) === 'lsp';
const streams = lsp ? [] : [process.stdout, process.stderr];
for (const stream of streams) {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) =>
    write(
      typeof chunk === 'string' ? neutralizeWorkflowCommands(chunk) : chunk,
      ...rest,
    )) as typeof stream.write;
}

if (process.argv.includes('--version') || process.argv.includes('-V')) {
  process.stdout.write(`${bannerText()}\n`);
  process.exit(0);
}

const main = defineCommand({
  meta: {
    name: 'flowpact',
    version: VERSION,
    description: 'Lint, trace and lock the data flow between your GitHub Actions workflows',
  },
  subCommands: COMMANDS,
});

/** citty's usage text, then where the docs are; without color codes when the output is not a terminal. */
async function showUsage<T extends ArgsDef>(
  cmd: CommandDef<T>,
  parent: CommandDef<T> | undefined,
  color: boolean,
): Promise<void> {
  const usage = (await renderUsage(cmd, parent)).trimEnd();
  const meta = await (typeof cmd.meta === 'function' ? cmd.meta() : cmd.meta);
  const docs = parent
    ? `Docs: ${DOCS_BASE_URL}/docs/cli#flowpact-${meta?.name ?? ''}`
    : `Docs: ${DOCS_BASE_URL}/docs\nCLI reference: ${DOCS_BASE_URL}/docs/cli`;
  const text = `${usage}\n\n${docs}\n`;
  process.stdout.write(color ? text : text.replace(/\u001B\[[\d;]*m/g, ''));
}

/** citty's argument errors (unknown command, bad enum value, missing positional). */
const ARG_ERRORS = new Set(['EARG', 'E_UNKNOWN_COMMAND', 'E_NO_COMMAND']);

async function run(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  // Help (and no arguments at all) is rendered by citty, including per-command usage.
  if (rawArgs.length === 0 || rawArgs.some((a) => a === '--help' || a === '-h')) {
    const color = colorEnabled(!rawArgs.includes('--no-color'));
    await runMain(main, {
      rawArgs: rawArgs.length ? rawArgs : ['--help'],
      showUsage: (cmd, parent) => showUsage(cmd, parent, color),
    });
    return;
  }
  try {
    await runCommand(main, { rawArgs });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (!code || !ARG_ERRORS.has(code)) throw err;
    // Usage errors exit 2, so CI can tell them apart from findings (1).
    const c = pc.createColors(colorEnabled(!rawArgs.includes('--no-color')));
    const message = (err as Error).message.replace(/\u001B\[[\d;]*m/g, '');
    const sub = rawArgs.find((a) => !a.startsWith('-'));
    process.stderr.write(
      `${c.red(c.bold('Error'))}: ${message}\n${c.dim(`Run \`flowpact ${sub && code !== 'E_UNKNOWN_COMMAND' ? `${sub} ` : ''}--help\` for usage.`)}\n`,
    );
    process.exitCode = 2;
  }
}

void run();
