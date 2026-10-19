import type { Loc } from '@ciatlas/core';
import { defineRule, type OverrideUsage, type RuleDefinition } from './types';

/** Days before expiry at which FP903 starts reminding. */
const EXPIRY_WARNING_DAYS = 14;

const configLoc = (loc: Loc | undefined): Loc =>
  loc ?? { file: '.github/flowpact/flowpact.config.yml', line: 1, column: 1, endLine: 1, endColumn: 1 };

const describe = (o: { rule: string; target?: string | undefined; file?: string | undefined }) =>
  `${o.rule} on ${o.target ?? o.file}`;

const overrideExpired = defineRule({
  code: 'FP901',
  name: 'override-expired',
  category: 'config',
  defaultSeverity: 'error',
  phase: 'post',
  docs: {
    summary: 'An override passed its `expires` date; the findings it suppressed are reported again.',
    why:
      'Overrides are meant to be temporary exceptions with an owner. An expired one means the follow-up work was not done ' +
      'and the original problem is back in scope.',
    fix: 'Fix the underlying findings and delete the override, or — if the exception is still justified — extend `expires` with an updated reason.',
    examples: {
      bad: `overrides:
  - rule: unused-input
    target: .github/workflows/pipeline.yml#inputs.legacy-flag
    reason: Read by the release dispatcher until the migration (JIRA-123)
    expires: 2026-01-31`,
      good: `# migration done: input removed, override deleted`,
    },
  },
  check(ctx) {
    for (const u of ctx.overrides ?? []) {
      // Like FP902: an override whose rule did not run (off, --only, contract rules under lint) is judged where it runs.
      if (!u.expired || u.inactive) continue;
      ctx.report({ message: expiredMessage(u), loc: configLoc(u.loc), fix: expiredFix(u) });
    }
  },
});

/** FP901's message: how many findings the expired override let through again, if any. */
function expiredMessage(u: OverrideUsage): string {
  const owner = u.override.owner ? ` (owner ${u.override.owner})` : '';
  return u.matched
    ? `Override for ${describe(u.override)} expired on ${u.override.expires}${owner}; ${u.matched} finding${u.matched === 1 ? ' is' : 's are'} reported again`
    : `Override for ${describe(u.override)} expired on ${u.override.expires}${owner}; it matches no finding now`;
}

/** FP901's fix: fix the findings it matches (or extend it), or, matching none, delete it. */
function expiredFix(u: OverrideUsage): string {
  return u.matched
    ? `Fix the finding${u.matched === 1 ? '' : 's'} and delete the override, or extend \`expires\` with an updated reason ("${u.override.reason}").`
    : 'Delete the override.';
}

const overrideUnused = defineRule({
  code: 'FP902',
  name: 'override-unused',
  category: 'config',
  defaultSeverity: 'warning',
  phase: 'post',
  docs: {
    summary: 'An override matches no finding — the problem was fixed, or the target is misspelled.',
    why: 'Stale overrides hide future problems at the same target and make the exception list untrustworthy.',
    fix: 'Delete the override, or correct its `rule` / `target` / `file` (use the `symbol` shown in JSON output or `flowpact lint --format json`).',
    examples: {
      bad: `overrides:
  - rule: unused-input
    target: .github/workflows/deploy.yml#inputs.siute   # misspelled: matches no finding
    reason: Read by the release dispatcher until the migration`,
      good: `overrides:
  - rule: unused-input
    target: .github/workflows/deploy.yml#inputs.suite
    reason: Read by the release dispatcher until the migration`,
    },
  },
  check(ctx) {
    for (const u of ctx.overrides ?? []) {
      if (u.expired || u.inactive || u.matched > 0) continue;
      const n = u.skippedInGenerated ?? 0;
      ctx.report({
        message: unusedMessage(u, n),
        loc: configLoc(u.loc),
        ...(n
          ? {
              fix: 'Delete the override: flowpact no longer reports this rule in generated files. If the file is written by hand, list it under `generated.exclude` instead.',
            }
          : {}),
      });
    }
  },
});

/** FP902's message, naming the findings in generated files (`n`) the override would match. */
function unusedMessage(u: OverrideUsage, n: number): string {
  return n
    ? `Override for ${describe(u.override)} matches no finding: ${u.override.rule} is not reported in generated files, where its ${n} finding${n === 1 ? ' is' : 's are'}`
    : `Override for ${describe(u.override)} matches no finding`;
}

const overrideExpiringSoon = defineRule({
  code: 'FP903',
  name: 'override-expiring-soon',
  category: 'config',
  defaultSeverity: 'info',
  phase: 'post',
  docs: {
    summary: `An override expires within ${EXPIRY_WARNING_DAYS} days.`,
    why: 'A heads-up so the owner can finish the follow-up before the build starts failing.',
    fix: 'Fix the underlying findings, or extend `expires` with an updated reason.',
    examples: {
      bad: `overrides:
  - rule: unused-input
    target: .github/workflows/pipeline.yml#inputs.legacy-flag
    reason: Read by the release dispatcher until the migration (JIRA-123)
    expires: 2026-01-31   # within 14 days`,
      good: `# migration done: the input and the override deleted; or, when it slipped, a new date and why
    reason: The release dispatcher reads it until the migration moves to Q2 (JIRA-123)
    expires: 2026-04-30`,
    },
  },
  check(ctx) {
    for (const u of ctx.overrides ?? []) {
      if (u.expired || u.daysLeft === undefined || u.daysLeft > EXPIRY_WARNING_DAYS || u.matched === 0)
        continue;
      ctx.report({
        message: `Override for ${describe(u.override)} expires in ${u.daysLeft} day${u.daysLeft === 1 ? '' : 's'} (${u.override.expires})${u.override.owner ? ` — owner ${u.override.owner}` : ''}`,
        loc: configLoc(u.loc),
      });
    }
  },
});

const ignoreCommentInvalid = defineRule({
  code: 'FP904',
  name: 'ignore-comment-invalid',
  category: 'config',
  defaultSeverity: 'warning',
  phase: 'post',
  generatedFiles: 'skip',
  docs: {
    summary:
      'A `# flowpact: ignore[…]` comment names an unknown rule or one no comment can ignore, or is not written as `ignore[<rules>]`.',
    why: 'Such a comment accepts nothing: the finding it was written for is still reported, and the comment hides why.',
    fix:
      'Correct the rule: its code or its name, as `flowpact rules` lists them, in brackets after `# flowpact: ignore`. ' +
      'The rules about overrides and ignore comments (FP9xx) check them once they are applied, so no comment can ignore them.',
    examples: {
      bad: `notify:
  uses: acme/shared/.github/workflows/notify.yml@0123456789abcdef0123456789abcdef01234567 # v1.2.0 # flowpact: ignore[remote-unverifed] checked in acme/shared`,
      good: `notify:
  uses: acme/shared/.github/workflows/notify.yml@0123456789abcdef0123456789abcdef01234567 # v1.2.0 # flowpact: ignore[remote-unverified] checked in acme/shared`,
    },
  },
  check(ctx) {
    for (const u of ctx.ignoreComments ?? []) {
      if (u.invalid) ctx.report({ message: u.invalid, loc: u.rule?.loc ?? u.comment.loc });
    }
  },
});

const ignoreCommentUnused = defineRule({
  code: 'FP905',
  name: 'ignore-comment-unused',
  category: 'config',
  defaultSeverity: 'warning',
  phase: 'post',
  generatedFiles: 'skip',
  docs: {
    summary: 'A `# flowpact: ignore[…]` comment names a rule that reports nothing on the line it accepts.',
    why:
      'The problem was fixed, or the comment is on another line than the finding. Either way it would hide a later ' +
      'finding of that rule there that nobody looked at.',
    fix:
      'Delete the rule from the comment, or the comment when it names no other. A comment accepts the findings reported ' +
      'on its line; alone on its line, those on the next line of YAML; on a block scalar’s line (`run: |`), those in its text.',
    examples: {
      bad: `# the workflow declares inputs.target now, so FP108 reports nothing on the next line
- run: echo "\${{ inputs.target }}" # flowpact: ignore[FP108]`,
      good: `- run: echo "\${{ inputs.target }}"`,
    },
  },
  check(ctx) {
    for (const u of ctx.ignoreComments ?? []) {
      if (!u.code || !u.rule || u.invalid || u.inactive || u.matched > 0) continue;
      ctx.report({
        message: u.comment.line
          ? `Ignore comment for ${u.code} matches no finding on line ${u.comment.line}`
          : `Ignore comment for ${u.code} matches no finding: no line of YAML follows it`,
        loc: u.rule.loc,
      });
    }
  },
});

export const overrideRules: RuleDefinition[] = [
  overrideExpired,
  overrideUnused,
  overrideExpiringSoon,
  ignoreCommentInvalid,
  ignoreCommentUnused,
];
