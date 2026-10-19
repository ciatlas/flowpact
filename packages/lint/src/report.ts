import type { Loc, ProjectIndex } from '@ciatlas/core';
import * as z from 'zod/mini';
import type { AnalysisResult } from './analyze';
import { schemaUrl } from './version';
import { described } from './zod';

/** A whole number, as the report's JSON Schema says (`type: integer`). */
const int = () => z.number().check(z.int());
const positiveInt = () => z.number().check(z.int(), z.positive());
const LEVEL = ['none', 'patch', 'minor', 'major'] as const;

const locSchema = z.object({
  file: z.string(),
  line: positiveInt(),
  column: positiveInt(),
  endLine: positiveInt(),
  endColumn: positiveInt(),
});

export const findingSchema = z.object({
  code: z.string().check(z.regex(/^[A-Z][A-Z0-9]{1,9}\d{3}$/)),
  name: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  category: z.string(),
  message: z.string(),
  loc: locSchema,
  related: z.array(z.object({ loc: locSchema, message: z.string() })),
  combos: z.optional(z.array(z.string())),
  symbol: z.optional(z.string()),
  why: z.string(),
  fix: z.string(),
  docsUrl: z.url(),
  fingerprint: z.string().check(z.regex(/^[0-9a-f]{16}$/)),
  suggestions: z.optional(
    z.array(
      z.object({
        title: z.string(),
        edits: z.array(z.object({ loc: locSchema, newText: z.string() })),
      }),
    ),
  ),
});

export const reportSchema = z.object({
  $schema: z.string(),
  meta: z.object({
    tool: z.string(),
    version: z.string(),
    schemas: z.object({ config: z.number(), contract: z.number(), report: z.number() }),
    node: z.string(),
    platform: z.string(),
    root: z.string(),
    configFile: z.optional(z.string()),
    repository: z.optional(z.string()),
    durationMs: z.number().check(z.nonnegative()),
  }),
  summary: z.object({
    errors: int(),
    warnings: int(),
    infos: int(),
    total: int(),
    workflows: int(),
    actions: int(),
    jobs: int(),
    matrixCombinations: int(),
    graph: z.object({ nodes: int(), edges: int() }),
    byCode: z.record(z.string(), int()),
    byFile: z.record(z.string(), int()),
    suppressed: int(),
    ignoredByComment: described(
      z.optional(int()),
      'Findings accepted by `# flowpact: ignore[…]` comments (not counted above).',
    ),
    skippedInGenerated: described(
      z.optional(int()),
      'Findings not reported because they are about the internals of generated files.',
    ),
  }),
  findings: z.array(findingSchema),
  suppressed: z.array(
    z.extend(findingSchema, {
      override: z.object({
        index: int(),
        reason: z.string(),
        expires: z.optional(z.string()),
        owner: z.optional(z.string()),
      }),
    }),
  ),
  ignoredByComment: described(
    z.optional(
      z.array(
        z.extend(findingSchema, {
          comment: z.object({ loc: locSchema, reason: z.optional(z.string()) }),
        }),
      ),
    ),
    'Findings accepted by `# flowpact: ignore[…]` comments, each with the comment that accepted it.',
  ),
  contracts: z.optional(
    z.object({
      drift: z.boolean(),
      breaking: int(),
      counts: z.object({ create: int(), update: int(), delete: int(), unchanged: int() }),
      entries: z.array(
        z.object({
          file: z.string(),
          status: z.enum(['create', 'update', 'delete', 'unchanged']),
          unit: z.optional(z.string()),
          invalid: z.optional(z.string()),
          changes: z.array(z.object({ breaking: z.boolean(), path: z.string(), message: z.string() })),
        }),
      ),
    }),
  ),
  impact: z.optional(
    z.object({
      baseline: z.object({ kind: z.enum(['ref', 'release']), ref: z.string(), commit: z.string() }),
      required: z.enum(LEVEL),
      declared: z.optional(
        z.object({
          kind: z.enum(['explicit', 'title', 'labels', 'version']),
          value: z.string(),
          level: z.enum(LEVEL),
        }),
      ),
      ok: z.boolean(),
      changes: z.array(
        z.object({
          unit: z.string(),
          kind: z.string(),
          level: z.enum(LEVEL),
          certain: z.boolean(),
          message: z.string(),
          loc: locSchema,
        }),
      ),
      scope: described(
        z.optional(
          z.object({
            paths: described(z.array(z.string()), 'The paths given, relative to the root.'),
            units: described(
              z.array(z.string()),
              'The published workflows and actions within them, in the baseline or the working tree: the only ones graded.',
            ),
          }),
        ),
        'Only when paths were given: impact mode graded only the published units within them, and the verdict is about those alone.',
      ),
      ignored: described(
        z.optional(z.array(z.string())),
        "Only when `ignore` left out published workflows or actions (within the paths): those units, which were not graded, as both the baseline's and the pull request's `ignore` match them.",
      ),
    }),
  ),
  rules: z.array(
    z.object({ code: z.string(), name: z.string(), severity: z.enum(['error', 'warning', 'info', 'off']) }),
  ),
  graph: z.optional(
    z.object({
      nodes: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          label: z.string(),
          unit: z.optional(z.string()),
          loc: z.optional(locSchema),
        }),
      ),
      edges: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          kind: z.string(),
          loc: z.optional(locSchema),
          siteId: z.optional(int()),
        }),
      ),
    }),
  ),
});

export type JsonReport = z.infer<typeof reportSchema>;
/** A finding as the JSON report has it: a plugin's rule may name any category. */
export type JsonFinding = JsonReport['findings'][number];

export function toJsonReport(result: AnalysisResult, opts: { includeGraph?: boolean } = {}): JsonReport {
  return {
    $schema: schemaUrl('report'),
    meta: { ...result.meta, durationMs: result.durationMs },
    summary: result.summary,
    findings: result.findings,
    suppressed: result.suppressed,
    ignoredByComment: result.ignoredByComment,
    ...(result.contracts
      ? {
          contracts: {
            drift: result.contracts.drift,
            breaking: result.contracts.breaking,
            counts: result.contracts.counts,
            // File contents are omitted; use `flowpact generate --dry-run` or the patch for those.
            entries: result.contracts.entries.map(({ before: _b, after: _a, ...e }) => e),
          },
        }
      : {}),
    ...(result.impact
      ? {
          impact: {
            baseline: result.impact.baseline,
            required: result.impact.verdict.required,
            ...(result.impact.verdict.declared ? { declared: result.impact.verdict.declared } : {}),
            ok: result.impact.verdict.ok,
            changes: result.impact.changes,
            ...(result.impact.scope
              ? { scope: { paths: result.impact.scope.paths, units: result.impact.scope.units } }
              : {}),
            ...(result.impact.narrowed?.ignored.length ? { ignored: result.impact.narrowed.ignored } : {}),
          },
        }
      : {}),
    rules: result.rules,
    ...(opts.includeGraph ? { graph: reportGraph(result.index) } : {}),
  };
}

/**
 * The graph with the fields the report schema documents, copied one by one: a field the workflow model adds to its
 * nodes, edges or locations does not reach the published report.
 */
function reportGraph(index: ProjectIndex): NonNullable<JsonReport['graph']> {
  const { nodes, edges } = index.toJSON();
  const loc = (l: Loc) => ({
    file: l.file,
    line: l.line,
    column: l.column,
    endLine: l.endLine,
    endColumn: l.endColumn,
  });
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      ...(n.unit !== undefined ? { unit: n.unit } : {}),
      ...(n.loc ? { loc: loc(n.loc) } : {}),
    })),
    edges: edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      ...(e.loc ? { loc: loc(e.loc) } : {}),
      ...(e.siteId !== undefined ? { siteId: e.siteId } : {}),
    })),
  };
}

export function reportJsonSchema(): Record<string, unknown> {
  return { $id: schemaUrl('report'), title: 'flowpact report', ...z.toJSONSchema(reportSchema) };
}
