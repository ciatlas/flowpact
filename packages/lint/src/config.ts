import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { insideRepository, type Loc } from '@ciatlas/core';
import { isMap, isSeq, LineCounter, parseDocument } from 'yaml';
import * as z from 'zod/mini';
import { SCHEMA_VERSIONS, schemaUrl } from './version';
import { described } from './zod';

export const CONFIG_DIR = '.github/flowpact';
export const CONFIG_FILES = ['flowpact.config.yml', 'flowpact.config.yaml'] as const;

export const severitySettingSchema = z.enum(['error', 'warning', 'info', 'off']);

export const overrideSchema = z
  .strictObject({
    rule: described(
      z.string().check(z.minLength(1)),
      'Rule code (FP104) or name (unused-input) to suppress.',
    ),
    target: described(
      z.optional(z.string()),
      'Symbol the finding is about, e.g. `.github/workflows/ci.yml#inputs.legacy`. Supports `*` and `**`.',
    ),
    file: described(
      z.optional(z.string()),
      'Repo-relative file path, prefix or glob the finding is located in.',
    ),
    reason: described(
      z.string().check(z.minLength(10)),
      'Why this finding is accepted. Required, at least 10 characters.',
    ),
    expires: described(
      z.optional(z.iso.date()),
      'YYYY-MM-DD (UTC). After the end of this day the finding is reported again, together with FP901.',
    ),
    owner: described(z.optional(z.string()), 'Who owns the exception, e.g. `@platform-team`.'),
  })
  .check(
    z.refine((o) => o.target !== undefined || o.file !== undefined, {
      message:
        'set `target` or `file` so the override cannot silence a rule everywhere (use `rules:` for that)',
    }),
  );

export type Override = z.infer<typeof overrideSchema>;

const IMPACT_LABELS = {
  major: 'semver:major',
  minor: 'semver:minor',
  patch: 'semver:patch',
  none: 'semver:none',
};

export const configSchema = z.strictObject({
  $schema: described(z.optional(z.string()), 'JSON Schema reference for editor autocomplete.'),
  version: described(
    z._default(z.literal(SCHEMA_VERSIONS.config), SCHEMA_VERSIONS.config),
    'Config schema version. Currently 1.',
  ),
  repository: described(
    z.optional(z.string().check(z.regex(/^[\w.-]+\/[\w.-]+$/))),
    'owner/repo of this repository. Lets `uses: owner/repo/.github/workflows/x.yml@ref` resolve locally.',
  ),
  rules: described(
    z._default(z.record(z.string(), severitySettingSchema), {}),
    'Severity per rule, keyed by code (FP401) or name (empty-binding-for-matrix-combo).',
  ),
  limits: described(
    z.prefault(
      z.strictObject({
        nestingDepth: described(
          z._default(z.number().check(z.int(), z.positive()), 10),
          'Maximum workflows in one call chain, counting the top-level workflow (FP602).',
        ),
        maxInputs: described(
          z._default(z.number().check(z.int(), z.positive()), 30),
          'Inputs on one workflow_call interface before FP605 suggests grouping them.',
        ),
      }),
      {},
    ),
    'Thresholds used by structure rules.',
  ),
  ignore: described(
    z._default(z.array(z.string()), []),
    'Repo-relative path prefixes or globs (`*`, `**`) whose findings are suppressed.',
  ),
  overrides: described(
    z._default(z.array(overrideSchema), []),
    'Accepted findings, each with a reason and an optional expiry date.',
  ),
  matrixShapes: described(
    z._default(
      z.record(
        z.string().check(z.regex(/^[^#]+#[^#]+$/, 'use `<workflow path>#<job id>`')),
        z.strictObject({ keys: z.array(z.string()).check(z.minLength(1)) }),
      ),
      {},
    ),
    'Declared keys of runtime-computed matrices, keyed by `<workflow path>#<job id>`. Lets flowpact verify `matrix.*` reads (FP404) instead of reporting FP403.',
  ),
  generated: described(
    z.prefault(
      z.strictObject({
        include: described(
          z._default(z.array(z.string()), []),
          'Files or globs of workflows and actions that are generated, even without a marker.',
        ),
        exclude: described(
          z._default(z.array(z.string()), []),
          'Files or globs of workflows and actions written by hand, even with a marker or a `.lock.yml` name. Wins over `include`.',
        ),
      }),
      {},
    ),
    'Which workflow and action files are generated. Rules about their internals are not reported there; flowpact detects them by a header comment or the `.lock.yml` name.',
  ),
  plugins: described(
    z._default(z.array(z.string()), []),
    'Repo-relative JavaScript modules (.js/.mjs) exporting extra rules (default export: rule or array of rules).',
  ),
  impact: described(
    z._default(
      z.strictObject({
        publish: described(
          z.optional(z.array(z.string())),
          'Files or globs of the units other repositories use. Default: every workflow with `workflow_call` except `_`-prefixed files, and the root `action.yml`.',
        ),
        declaredBy: described(
          z.optional(z.enum(['explicit', 'title', 'labels'])),
          'The authoritative source of the declared impact; others are advisory. Default: `explicit` when given, else `title`.',
        ),
        labels: described(
          z._default(
            z.strictObject({
              major: z._default(z.string(), 'semver:major'),
              minor: z._default(z.string(), 'semver:minor'),
              patch: z._default(z.string(), 'semver:patch'),
              none: z._default(z.string(), 'semver:none'),
            }),
            IMPACT_LABELS,
          ),
          'Pull request labels that declare each impact level.',
        ),
        types: described(
          z._default(z.record(z.string(), z.enum(['none', 'patch', 'minor', 'major'])), {
            feat: 'minor',
            fix: 'patch',
            perf: 'patch',
          }),
          'Conventional Commits types and the impact they declare; other types declare `none`, `!` declares `major`.',
        ),
        uncertain: described(
          z._default(z.enum(['warn', 'fail']), 'warn'),
          'Changes flowpact cannot fully resolve: only warn (default), or count them towards the required impact.',
        ),
      }),
      // A function, so each parse gets its own nested objects (a plain default is copied one level deep only).
      () => ({
        labels: { ...IMPACT_LABELS },
        types: { feat: 'minor' as const, fix: 'patch' as const, perf: 'patch' as const },
        uncertain: 'warn' as const,
      }),
    ),
    'Impact mode: which units are published and how pull requests declare their release impact.',
  ),
});

export type FlowpactConfig = z.infer<typeof configSchema>;

export const defaultConfig = (): FlowpactConfig => configSchema.parse({});

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file?: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export interface LoadedConfig {
  /** The repository's config, on top of the base config when one was given. */
  config: FlowpactConfig;
  /** Repo-relative path of the config file, when one was found. */
  file?: string;
  /** The base config (`--base-config`): its path as given, and its contents for `parseConfigText`. */
  base?: { file: string; data: Record<string, unknown> };
  /** Raw text of the config file, for code frames. */
  text?: string;
  /** Location of each `overrides[i]` entry in the config file. */
  overrideLocs?: Loc[];
}

/**
 * Keys a base config cannot set: they name files of one repository, or (`plugins`) run code, which a wrapper loads
 * with `--plugin` instead.
 */
const REPOSITORY_ONLY = ['repository', 'overrides', 'matrixShapes', 'plugins'] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The repository's raw config on top of a base config's: maps (`rules`, `limits`, `impact`, …) merge key by key and the
 * repository's value wins; lists (`ignore`, `generated.include`, …) add up.
 */
export function mergeConfig(base: unknown, repo: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(repo)) {
    // Own keys only, and entries rather than assignments, so a `__proto__` key stays a key (which the strict schema
    // rejects) instead of setting the merged object's prototype.
    return Object.fromEntries([
      ...Object.entries(base).filter(([k]) => !Object.hasOwn(repo, k)),
      ...Object.entries(repo).map(([k, v]) => [k, Object.hasOwn(base, k) ? mergeConfig(base[k], v) : v]),
    ]);
  }
  if (Array.isArray(base) && Array.isArray(repo)) return [...new Set([...base, ...repo])];
  return repo === undefined ? base : repo;
}

/**
 * Reads a base config (`--base-config`): organization defaults under the repository's config. It is validated on its
 * own, so a problem in it names its file.
 */
export function loadBaseConfig(file: string): Record<string, unknown> {
  const full = isAbsolute(file) ? file : resolve(process.cwd(), file);
  if (!existsSync(full)) throw new ConfigError(`Base config file not found: ${file}`, file);
  const data = readYaml(readFileSync(full, 'utf8'), file).data ?? {};
  if (!isPlainObject(data))
    throw new ConfigError(`Invalid base config in ${file}`, file, ['(root): expected a map']);
  const repositoryOnly = [
    ...REPOSITORY_ONLY.filter((k) => Object.hasOwn(data, k)),
    ...(isPlainObject(data.impact) && Object.hasOwn(data.impact, 'publish') ? ['impact.publish'] : []),
  ];
  if (repositoryOnly.length) {
    throw new ConfigError(
      `Invalid base config in ${file}`,
      file,
      repositoryOnly.map((k) =>
        k === 'plugins'
          ? 'plugins: not in a base config; load organization rules with --plugin'
          : `${k}: belongs in the repository's config, not in a base config`,
      ),
    );
  }
  parseConfig(data, file);
  return data;
}

/**
 * Finds and validates the config. An explicit `--config` path must exist; the default location is optional. With
 * `base`, the config found goes on top of that base config (see `mergeConfig`).
 */
export function loadConfig(root: string, explicit?: string, opts: { base?: string } = {}): LoadedConfig {
  const base = opts.base !== undefined ? loadBaseConfig(opts.base) : undefined;
  const withBase = base ? { base: { file: opts.base!, data: base } } : {};
  const candidates = explicit ? [explicit] : CONFIG_FILES.map((f) => join(root, CONFIG_DIR, f));
  for (const abs of candidates) {
    const full = explicit && !abs.startsWith('/') ? join(process.cwd(), abs) : abs;
    if (!existsSync(full)) {
      if (explicit) throw new ConfigError(`Config file not found: ${explicit}`, explicit);
      continue;
    }
    const rel = relative(root, full).split('\\').join('/');
    // The default location is part of the checkout: never follow a symlink out of the repository.
    if (!explicit && !insideRepository(root, full)) {
      throw new ConfigError(`${rel} links outside the repository; flowpact does not read it`, rel);
    }
    const text = readFileSync(full, 'utf8');
    return { ...parseConfigText(text, rel, base), file: rel, text, ...withBase };
  }
  return { config: base ? parseConfig(base, opts.base) : defaultConfig(), ...withBase };
}

function readYaml(text: string, file: string) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  if (doc.errors.length) {
    throw new ConfigError(`Config file is not valid YAML: ${doc.errors[0]!.message.split('\n')[0]}`, file);
  }
  try {
    return { doc, lineCounter, data: doc.toJS() as unknown };
  } catch (err) {
    // e.g. yaml's alias limit ("Excessive alias count …").
    throw new ConfigError(`Config file cannot be read: ${(err as Error).message.split('\n')[0]}`, file);
  }
}

/**
 * Parses config YAML, keeping the location of each override for findings about it. With `base` (from
 * `loadBaseConfig`), the result is this config on top of it.
 */
export function parseConfigText(
  text: string,
  file = 'flowpact.config.yml',
  base?: Record<string, unknown>,
): { config: FlowpactConfig; overrideLocs: Loc[] } {
  const lines = text.split(/\r?\n/);
  const { doc, lineCounter, data: raw } = readYaml(text, file);
  const data = raw ?? {};
  const config = parseConfig(base ? mergeConfig(base, data) : data, file);
  const overridesNode = isMap(doc.contents) ? doc.contents.get('overrides', true) : undefined;
  const overrideLocs: Loc[] = isSeq(overridesNode)
    ? overridesNode.items.map((item) => {
        const r = (item as { range?: [number, number, number] }).range ?? [0, 0, 0];
        const a = lineCounter.linePos(r[0]);
        return {
          file,
          line: a.line,
          column: a.col,
          endLine: a.line,
          endColumn: (lines[a.line - 1]?.trimEnd().length ?? a.col) + 1,
        };
      })
    : [];
  return { config, overrideLocs };
}

export function parseConfig(raw: unknown, file?: string): FlowpactConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    // Record-key failures hide the key schema's own message ("use `<workflow path>#<job id>`") one level down.
    const message = (i: z.core.$ZodIssue): string =>
      i.code === 'invalid_key' && i.issues.length
        ? `invalid key: ${i.issues.map((n) => n.message).join('; ')}`
        : i.message;
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${message(i)}`);
    throw new ConfigError(`Invalid config${file ? ` in ${file}` : ''}`, file, issues);
  }
  return result.data;
}

export function configJsonSchema(): Record<string, unknown> {
  return {
    $id: schemaUrl('config'),
    title: 'flowpact configuration',
    ...z.toJSONSchema(configSchema, { io: 'input' }),
  };
}
