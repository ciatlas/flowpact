import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type Logger,
  type LogLevel,
  type LogRecord,
  neutralizeWorkflowCommands,
  resolveLogLevel,
} from '@flowpact/core';
import {
  assertSafeWritePath,
  ConfigError,
  DOCS_BASE_URL,
  type LoadedConfig,
  REPOSITORY_URL,
  toolMeta,
} from '@flowpact/lint';
import { type RenderOptions, renderBanner } from '@flowpact/reporters';
import type { ArgsDef } from 'citty';
import pc from 'picocolors';
import { FlowpactError, toFlowpactError } from './lib/errors';
import { openSession, type Session } from './lib/session';
import { displayPath, protectedTrees } from './lib/targets';
import { colorEnabled, terminalRender } from './lib/text';

export { displayPath };

export const EXIT = { ok: 0, findings: 1, usage: 2, internal: 3 } as const;

/** Flags shared by every analysis command. */
export const commonArgs = {
  root: { type: 'string', description: 'Repository root (default: current directory)', valueHint: 'dir' },
  config: {
    type: 'string',
    description: 'Config file (default: .github/flowpact/flowpact.config.yml)',
    valueHint: 'file',
  },
  'base-config': {
    type: 'string',
    description:
      "Defaults under the repository's config, e.g. an organization's (relative to the working directory)",
    valueHint: 'file',
  },
  debug: { type: 'boolean', description: 'Debug logging (also FLOWPACT_DEBUG=1)', alias: 'd' },
  verbose: { type: 'boolean', description: 'Verbose logging; repeat for trace (-vv)', alias: 'v' },
  quiet: { type: 'boolean', description: 'Only print errors and the report', alias: 'q' },
  color: { type: 'boolean', description: 'Colorized output (use --no-color to disable)', default: true },
  ascii: { type: 'boolean', description: 'ASCII-only symbols for limited terminals' },
} satisfies ArgsDef;

/** Flags of the commands that load rules: which plugins run. */
export const pluginArgs = {
  plugins: {
    type: 'boolean',
    default: true,
    description: 'Load the plugins the config lists (--no-plugins on code you do not trust)',
  },
  plugin: {
    type: 'string',
    description:
      'Also load this plugin, relative to the working directory (repeatable; not affected by --no-plugins)',
    valueHint: 'file',
  },
} satisfies ArgsDef;

export interface CommonFlags {
  root?: string | undefined;
  config?: string | undefined;
  'base-config'?: string | undefined;
  debug?: boolean | undefined;
  verbose?: boolean | undefined;
  quiet?: boolean | undefined;
  color?: boolean | undefined;
  ascii?: boolean | undefined;
  plugins?: boolean | undefined;
}

export interface CliContext {
  root: string;
  logger: Logger;
  level: LogLevel;
  render: RenderOptions;
  /** Render options for files: never colored, no hyperlinks. */
  plain: RenderOptions;
  loaded: LoadedConfig;
  /** What the API's functions run with: the root, the logger, the config and the plugins to load. */
  session: Session;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/** How a command's string flags can be written: `--name`, its camelCase, long aliases, and `-x` for one-letter aliases. */
function flagSpellings(def: ArgsDef) {
  const strings = new Map<string, string>(); // spelling without dashes → flag name
  const shortStrings = new Map<string, string>();
  for (const [key, arg] of Object.entries(def)) {
    if (arg.type === 'positional') continue;
    const alias = 'alias' in arg ? (arg.alias as string | string[] | undefined) : undefined;
    const aliases = alias === undefined ? [] : Array.isArray(alias) ? alias : [alias];
    const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (arg.type === 'boolean') continue;
    // citty makes every alias an option of its own, so a one-letter alias also works as `--o`.
    for (const long of [key, camel, ...aliases]) strings.set(long, key);
    for (const a of aliases) if (a.length === 1) shortStrings.set(a, key);
  }
  return { strings, shortStrings };
}

/**
 * The arguments with every value of a string flag attached to its flag: `--title X` becomes `--title=X`, `-o X` becomes
 * `-oX`. citty looks for `--no-*`, `--`, `--help` and `--version` before it knows which arguments are values, so a value
 * such as a pull request title (`--title "--"`, `--title "--help"`) could otherwise turn off `--no-plugins` or end the
 * run. Options before the command (`flowpact --no-plugins lint`), which citty would drop, are a usage error.
 */
export function normalizeArgv(argv: string[], commands: Record<string, { args?: unknown }>): string[] {
  const [first, ...rest] = argv;
  const command = argv.findIndex((a) => !a.startsWith('-'));
  const options = command < 0 ? argv : argv.slice(0, command);
  // Help and the version need no command: `flowpact --no-color --help` still prints help.
  if (first === undefined || options.some((a) => ['--help', '-h', '--version', '-V'].includes(a)))
    return argv;
  if (first.startsWith('-')) {
    throw new UsageError(
      `Options go after the command, e.g. \`flowpact lint ${first}\` (got \`${first}\` before the command).`,
    );
  }
  const args = commands[first]?.args;
  // The language server reads its own arguments (--socket <port>) the way editors pass them.
  if (first === 'lsp' || !args || typeof args !== 'object') return argv;
  const { strings, shortStrings } = flagSpellings(args as ArgsDef);
  const out = [first];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const next = rest[i + 1];
    if (a === '--') {
      out.push(...rest.slice(i));
      break;
    }
    const long = /^--([^=]+)$/.exec(a)?.[1];
    if (long !== undefined && strings.has(long) && next !== undefined) {
      out.push(`--${long}=${next}`);
      i++;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(a)) {
      // A cluster of short flags (`-qo`): a string flag takes the rest of it, or the next argument when it is last.
      const at = [...a.slice(1)].findIndex((c) => shortStrings.has(c));
      if (at === a.length - 2 && next !== undefined) {
        // An empty value cannot be attached to a short flag; the long form keeps it.
        out.push(
          ...(next === ''
            ? [...(at ? [a.slice(0, -1)] : []), `--${shortStrings.get(a.at(-1)!)}=`]
            : [a + next]),
        );
        i++;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/**
 * Every value of a flag that may be repeated (`-o`, `--plugin`), in order; citty keeps only the last one. The arguments
 * are parsed the way citty parses them — node:util's parseArgs, not strict, with the command's flags and their aliases,
 * after dropping `--no-*` — so the value of another flag is never taken for this one: in `--title "--plugin=x"`,
 * `--plugin=x` is the title. A flag without a value (`-o` at the end) is '', as in citty; callers skip it.
 */
export function repeatedFlag(rawArgs: string[], def: ArgsDef, name: string): string[] {
  type Option = { type: 'string' | 'boolean'; short?: string };
  const options: Record<string, Option> = {};
  const names = new Set<string>([name]);
  for (const [key, arg] of Object.entries(def)) {
    if (arg.type === 'positional') continue;
    const type = arg.type === 'boolean' ? 'boolean' : 'string';
    const alias = 'alias' in arg ? (arg.alias as string | string[] | undefined) : undefined;
    const aliases = alias === undefined ? [] : Array.isArray(alias) ? alias : [alias];
    const short = aliases.find((a) => a.length === 1);
    options[key] = { type, ...(short ? { short } : {}) };
    const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    for (const long of [camel, ...aliases]) {
      if (long === key) continue;
      options[long] ??= { type };
      if (key === name) names.add(long);
    }
  }
  const end = rawArgs.indexOf('--');
  const args = rawArgs.filter((a, i) => !(a.startsWith('--no-') && (end < 0 || i < end)));
  let tokens: ReturnType<typeof parseArgs>['tokens'];
  try {
    ({ tokens } = parseArgs({ args, options, allowPositionals: true, strict: false, tokens: true }));
  } catch {
    return [];
  }
  return (tokens ?? []).flatMap((t) =>
    t.kind === 'option' && names.has(t.name) ? [typeof t.value === 'string' ? t.value : ''] : [],
  );
}

export function stderrSink(color: boolean) {
  const c = pc.createColors(color);
  const tag: Record<LogRecord['level'], string> = {
    error: c.red('error'),
    warn: c.yellow(' warn'),
    info: c.cyan(' info'),
    debug: c.magenta('debug'),
    trace: c.dim('trace'),
  };
  let depth = 0;
  return {
    write(r: LogRecord) {
      const data = r.data && Object.keys(r.data).length ? ` ${c.dim(JSON.stringify(r.data))}` : '';
      process.stderr.write(
        `${'  '.repeat(depth)}${tag[r.level]} ${c.dim(r.scope.padEnd(14))} ${r.message}${data}\n`,
      );
    },
    group(title: string) {
      process.stderr.write(`${c.bold(title)}\n`);
      depth++;
    },
    groupEnd() {
      depth = Math.max(0, depth - 1);
    },
  };
}

/** `def`: the command's flags (citty's `cmd.args`), to read repeated flags as citty reads the others. */
export function createContext(flags: CommonFlags, rawArgs: string[], def: ArgsDef): CliContext {
  const render = terminalRender({ color: flags.color, ascii: Boolean(flags.ascii) });
  const { color } = render;
  const resolved = resolveLogLevel({
    debug: Boolean(flags.debug),
    // Every -v counts, also in a cluster such as -vvo; read like any flag, so a value never does.
    verbose: repeatedFlag(rawArgs, def, 'verbose').filter((v) => v !== 'false').length,
    quiet: Boolean(flags.quiet),
  });
  // The CLI keeps info-level progress quiet unless asked for; the report itself is the output.
  const level: LogLevel = resolved === 'info' ? 'warn' : resolved;
  const session = openSession({
    ...(flags.root !== undefined ? { root: flags.root } : {}),
    ...(flags.config !== undefined ? { config: flags.config } : {}),
    ...(flags['base-config'] !== undefined ? { baseConfig: flags['base-config'] } : {}),
    log: { level, ...stderrSink(color) },
    // `--no-plugins` anywhere disables them, even where citty would not see it: failing safe.
    repositoryPlugins: flags.plugins !== false && !rawArgs.includes('--no-plugins'),
    plugins: repeatedFlag(rawArgs, def, 'plugin').filter(Boolean),
  });
  const { root, logger, loaded } = session;
  logger.debug('cli context', {
    root,
    level,
    color,
    width: render.width,
    config: loaded.file ?? '(defaults)',
    ...(loaded.base ? { base: loaded.base.file } : {}),
  });
  return {
    root,
    logger,
    level,
    render,
    plain: { ...render, color: false, hyperlinks: false },
    loaded,
    session,
    stdout: (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`),
    stderr: (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`),
  };
}

export function printBanner(ctx: CliContext, extra?: string) {
  if (ctx.level === 'error') return;
  ctx.stderr(renderBanner(toolMeta(), ctx.render, extra));
}

/**
 * Prints GitHub workflow commands (`--format github`). index.ts keeps every string written to stdout from being read
 * as a workflow command; a Buffer passes, which is only right for commands flowpact builds with every value escaped.
 */
export function writeWorkflowCommands(text: string) {
  process.stdout.write(Buffer.from(text));
}

/**
 * In GitHub Actions, the root relative to the workspace (the repository) when it is a subdirectory of it, or ''.
 * Annotations, code scanning and links to files resolve paths against the repository.
 */
export function workspacePrefix(root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_WORKSPACE) return '';
  const rel = relative(resolve(env.GITHUB_WORKSPACE), root);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : '';
}

/**
 * Writes a report or a patch. A text report may be printed by a later CI step, so it is kept free of workflow commands;
 * JSON is written with `jsonSafe` by whoever renders it; a patch is written as is, for `git apply`.
 */
export function writeOutput(file: string, content: string, ctx: CliContext, kind: 'text' | 'data' = 'text') {
  const abs = resolve(process.cwd(), file);
  assertSafeWritePath(abs, protectedTrees(ctx.root));
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, kind === 'text' ? neutralizeWorkflowCommands(content) : content);
  } catch (err) {
    throw new UsageError(`Cannot write ${file}: ${(err as Error).message}`);
  }
  ctx.logger.info(`report written to ${file}`, { bytes: Buffer.byteLength(content) });
  if (ctx.level !== 'error') ctx.stderr(pc.createColors(ctx.render.color).dim(`report written to ${file}`));
}

/** Turns expected failures into friendly messages and exit codes; unexpected ones into a bug-report hint. */
export async function guard(fn: () => Promise<number> | number): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (thrown) {
    const c = pc.createColors(colorEnabled(!process.argv.includes('--no-color')));
    const err = toFlowpactError(thrown);
    // What the engine reports as a config error (the config, a plugin it cannot load) comes with each problem and the
    // docs.
    if (err instanceof FlowpactError && err.cause instanceof ConfigError) {
      process.stderr.write(
        `${c.red(c.bold('Config error'))}${err.file ? c.dim(` (${err.file})`) : ''}: ${err.message}\n`,
      );
      for (const i of err.issues) process.stderr.write(`  ${c.red('•')} ${i}\n`);
      process.stderr.write(c.dim(`  docs: ${DOCS_BASE_URL}/docs/configuration\n`));
      process.exitCode = EXIT.usage;
      return;
    }
    if (err instanceof FlowpactError || err instanceof UsageError) {
      process.stderr.write(`${c.red(c.bold('Error'))}: ${err.message}\n`);
      process.exitCode = EXIT.usage;
      return;
    }
    process.stderr.write(
      `${c.red(c.bold('flowpact crashed'))}: ${(thrown as Error).stack ?? String(thrown)}\n`,
    );
    process.stderr.write(c.dim(`Please report this at ${REPOSITORY_URL}/issues with the --debug output.\n`));
    process.exitCode = EXIT.internal;
  }
}

export class UsageError extends Error {}

/**
 * Positional paths of `lint`, `check` and `generate`. They are relative to --root; a path that only exists relative to
 * the working directory is taken from there.
 */
export function pathArgs(positionals: string[], command: string, root: string): string[] {
  return positionals
    .filter((p) => p !== command)
    .map((p) =>
      isAbsolute(p) || existsSync(resolve(root, p)) || !existsSync(resolve(process.cwd(), p))
        ? p
        : resolve(process.cwd(), p),
    );
}
