/**
 * Generates one MDX page per rule (plus an index) from the rule registry, so the docs, `flowpact explain`
 * and the docs URLs printed with every finding can never drift apart.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addIgnoreComment,
  analyze,
  CATEGORIES,
  createRegistry,
  IMPACT_CODES,
  loadConfig,
  REPOSITORY_URL,
  type RuleDefinition,
} from '@flowpact/lint';
import { guidesOf, RELATED } from './rule-docs-meta';

const OUT = join(import.meta.dirname, '../apps/docs/content/docs/rules');

const SEVERITY_BADGE: Record<string, string> = {
  error: '🔴 error',
  warning: '🟡 warning',
  info: '🔵 info',
  off: '⚪ off (opt-in)',
};

/** An inline code span: a run of backticks, then the shortest text up to a run of the same length. */
const CODE_SPAN = /(`+)[\s\S]*?[^`]\1(?!`)/g;

/** `prose` applied to the text outside inline code spans, `code` to the spans (as they are by default). */
function outsideCode(s: string, prose: (t: string) => string, code = (t: string) => t): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(CODE_SPAN)) {
    out += prose(s.slice(last, m.index)) + code(m[0]);
    last = m.index + m[0].length;
  }
  return out + prose(s.slice(last));
}

/**
 * Escapes text for MDX prose (braces and angle brackets would be parsed as JSX). Backslashes too: `\{` would otherwise
 * become an escaped backslash followed by a `{` that starts an expression. Code spans are left as they are: MDX takes
 * them literally, so an escape there would show (`$\{\{ inputs.x \}\}`).
 */
const mdx = (s: string) => outsideCode(s, (t) => t.replace(/[\\{}<>]/g, (c) => `\\${c}`));
/**
 * `mdx` for a table cell: pipes are escaped in the same pass, after an already escaped backslash run. A code span in a
 * cell is refused when it holds a pipe (a GFM table reads it as a cell border, even in code) or a backslash (which would
 * then escape it): no summary needs one, and rewording beats a cell that renders differently from its source.
 */
const mdxCell = (s: string) =>
  outsideCode(
    s,
    (t) => t.replace(/[\\{}<>|]/g, (c) => `\\${c}`),
    (t) => {
      if (/[|\\]/.test(t)) throw new Error(`a code span in a table cell holds a pipe or a backslash: ${t}`);
      return t;
    },
  );

/** A finding of a rule as flowpact reports it, from one of the repository's fixtures: what a page shows under "What you see". */
export interface RuleSample {
  fixture: string;
  severity: string;
  message: string;
  file: string;
  line: number;
  column: number;
  symbol?: string;
}

const FIXTURES = join(import.meta.dirname, '../fixtures');

/**
 * The first finding of each rule in the fixtures, with their configs, contracts checked. Fixed inputs (the repository's
 * name, the date overrides expire against) keep the pages the same wherever and whenever they are generated.
 */
export function ruleSamples(): Map<string, RuleSample> {
  const out = new Map<string, RuleSample>();
  for (const fixture of readdirSync(FIXTURES).sort()) {
    if (fixture === 'checknames-lab') continue; // real GitHub runs' check names, not a fixture of findings
    for (const sample of fixtureFindings(fixture)) if (!out.has(sample.code)) out.set(sample.code, sample);
  }
  return out;
}

/** A fixture's findings, analyzed as the CLI's `check` would, with its own config. */
function fixtureFindings(fixture: string): (RuleSample & { code: string })[] {
  const root = join(FIXTURES, fixture);
  const loaded = loadConfig(root);
  const result = analyze({
    root,
    config: loaded.config,
    ...(loaded.file ? { configFile: loaded.file } : {}),
    ...(loaded.text !== undefined ? { configText: loaded.text } : {}),
    ...(loaded.overrideLocs ? { overrideLocs: loaded.overrideLocs } : {}),
    checkContracts: true,
    repository: `flowpact-fixtures/${fixture}`,
    now: new Date('2026-01-01T00:00:00Z'),
  });
  return result.findings.map((f) => ({
    code: f.code,
    fixture,
    severity: f.severity,
    message: f.message,
    file: f.loc.file,
    line: f.loc.line,
    column: f.loc.column,
    ...(f.symbol ? { symbol: f.symbol } : {}),
  }));
}

/** Where a rule runs: impact mode's only there, the contracts' with them, the others everywhere flowpact lints. */
function reportedBy(rule: RuleDefinition): string {
  if (IMPACT_CODES.includes(rule.code)) return '[Impact mode](/docs/impact-mode)';
  if (rule.category === 'contracts') return "`check`, the action's `mode: check`, the editor with contracts";
  return '`lint`, `check`, the action, the editor';
}

/** The severity as the terminal report marks it. */
const SEVERITY_MARK: Record<string, string> = { error: '✖  ERROR', warning: '▲  WARN', info: '●  INFO' };

/** "What you see": the sample finding, as the terminal shows it, with the fixture it comes from. */
function sampleLines(rule: RuleDefinition, sample: RuleSample): string[] {
  return [
    '## What you see',
    '',
    `In the [\`${sample.fixture}\`](${REPOSITORY_URL}/tree/main/fixtures/${sample.fixture}) fixture:`,
    '',
    '```text',
    `${SEVERITY_MARK[sample.severity] ?? sample.severity}  ${rule.code} ${rule.name}`,
    `  ${sample.message}`,
    `  ▶ ${sample.file}:${sample.line}:${sample.column}`,
    '```',
    '',
  ];
}

/** Rules about a whole file, or about a lockfile or contract file: no ignore comment accepts their findings. */
const WHOLE_FILE_RULES = new Set(['FP611', 'FP612', 'FP801', 'FP802', 'FP804', 'FP805']);

const REASON = 'why it is acceptable here';

/**
 * The ignore comment for a finding of `code`, above the sample's line as the editor's quick fix adds it, without the
 * indentation they share; a placeholder line without a sample.
 */
function ignoreSnippet(code: string, sample: RuleSample | undefined): { file: string; lines: string[] } {
  const text = sample && readFileSync(join(FIXTURES, sample.fixture, sample.file), 'utf8');
  const at = sample && text !== undefined ? addIgnoreComment(text, code, sample.line) : undefined;
  if (sample && text !== undefined && at?.column === 1) {
    const target = text.split('\n')[at.line - 1]!;
    const indent = /^ */.exec(target)![0].length;
    return {
      file: sample.file,
      lines: [`${at.newText.trimEnd()} ${REASON}`, target].map((l) => l.slice(indent)),
    };
  }
  return {
    file: '.github/workflows/ci.yml',
    lines: [`# flowpact: ignore[${code}] ${REASON}`, '<the line of the finding>'],
  };
}

/** "On its line": the ignore comment, unless the rule's findings are about whole files or files other than YAML ones. */
function commentLines(rule: RuleDefinition, sample: RuleSample | undefined): string[] {
  if (WHOLE_FILE_RULES.has(rule.code) || IMPACT_CODES.includes(rule.code)) return [];
  const { file, lines } = ignoreSnippet(rule.code, sample);
  return [
    '**On its line**, with an [ignore comment](/docs/configuration#ignore-comments) alone on the line above it (the',
    "editor's quick fix adds it there) or at the end of the line, after any other comment such as a version",
    `(\`# v4.3.0 # flowpact: ignore[${rule.code}] why\`):`,
    '',
    `\`\`\`yaml title=${JSON.stringify(file)}`,
    ...lines,
    '```',
    '',
    '**In the config**, with an [override](/docs/configuration#overrides), which can expire:',
    '',
  ];
}

/**
 * "Accept one finding": an ignore comment on its line, and an override for it, by its symbol (else its file). Not for
 * the rules about overrides and ignore comments, which run after them and which they cannot accept.
 */
function acceptLines(rule: RuleDefinition, sample: RuleSample | undefined): string[] {
  if (rule.phase === 'post') return [];
  const matcher = sample?.symbol
    ? `target: ${JSON.stringify(sample.symbol)}`
    : sample
      ? `file: ${JSON.stringify(sample.file)}`
      : "target: <the finding's symbol>";
  const comment = commentLines(rule, sample);
  return [
    '## Accept one finding',
    '',
    'When a finding is intended, accept it with a reason rather than turning the rule off. It is listed apart from the other',
    comment.length
      ? 'findings, and does not fail the build.'
      : 'findings, and comes back when the date passes ([overrides](/docs/configuration#overrides)):',
    '',
    ...comment,
    '```yaml title=".github/flowpact/flowpact.config.yml"',
    'overrides:',
    `  - rule: ${rule.code}`,
    `    ${matcher}`,
    '    reason: Why it is acceptable here, at least 10 characters.',
    '    expires: YYYY-MM-DD   # optional',
    '```',
    '',
    '`target` is the symbol the finding is about; to list them:',
    '',
    '```sh',
    `flowpact lint --format json | jq -r '.findings[] | select(.code == "${rule.code}") | .symbol'`,
    '```',
    '',
    '`*` matches within a path segment and `**` across segments, so one entry accepts every finding whose symbol matches:',
    "`target: '**#inputs.app-id'` is that input in every workflow and action.",
    '',
    ...baselineLines(rule, 'override'),
  ];
}

/**
 * Impact mode grades the pull request itself, so its rules take their overrides and severities from the baseline's
 * config, and no ignore comment accepts them.
 */
function baselineLines(rule: RuleDefinition, what: 'override' | 'severity'): string[] {
  if (!IMPACT_CODES.includes(rule.code)) return [];
  if (what === 'severity')
    return [
      "A severity counts only once it is on the base branch, as impact mode reads it from the baseline's config.",
      '',
    ];
  return [
    'An override counts only once it is on the base branch: impact mode reads the overrides and severities of its rules',
    "from the baseline's config, so a pull request cannot accept or switch off its own check. No ignore comment accepts",
    'its findings.',
    '',
  ];
}

/** "Related": the rules that report a neighbouring problem, and the guides that explain the rule's feature. */
function relatedLines(rule: RuleDefinition, rules: Map<string, RuleDefinition>): string[] {
  const related = (RELATED[rule.code] ?? []).map((code) => rules.get(code)!);
  const guides = guidesOf(rule.code);
  if (!related.length && !guides.length) return [];
  return [
    '## Related',
    '',
    ...related.map(
      (r) => `- [\`${r.code}\`](/docs/rules/${r.code.toLowerCase()}) ${r.name}: ${mdx(r.docs.summary)}`,
    ),
    ...guides.map(([title, href]) => `- [${title}](${href})`),
    '',
  ];
}

export function rulePage(
  rule: RuleDefinition,
  context: { sample?: RuleSample; rules?: Map<string, RuleDefinition> } = {},
): string {
  const category = Object.values(CATEGORIES).find((c) => c.id === rule.category)!;
  const rules =
    context.rules ??
    new Map(
      createRegistry()
        .all()
        .map((r) => [r.code, r]),
    );
  const lines = [
    '---',
    `title: '${rule.code} · ${rule.name}'`,
    `description: ${JSON.stringify(rule.docs.summary)}`,
    '---',
    '',
    `{/* Generated by scripts/gen-rule-docs.ts from packages/lint/src/rules — edit the rule, not this file. */}`,
    '',
    '| Code | Name | Category | Default severity | Reported by |',
    '| --- | --- | --- | --- | --- |',
    `| \`${rule.code}\` | \`${rule.name}\` | ${category.title} | ${SEVERITY_BADGE[rule.defaultSeverity]} | ${reportedBy(rule)} |`,
    '',
    ...(context.sample ? sampleLines(rule, context.sample) : []),
    '## Why it matters',
    '',
    mdx(rule.docs.why),
    '',
    '## How to fix',
    '',
    mdx(rule.docs.fix),
    '',
  ];
  if (rule.docs.examples) {
    lines.push(
      '## Example',
      '',
      '<Tabs items={["Problem", "Fixed"]}>',
      '<Tab value="Problem">',
      '',
      '```yaml',
      rule.docs.examples.bad,
      '```',
      '',
      '</Tab>',
      '<Tab value="Fixed">',
      '',
      '```yaml',
      rule.docs.examples.good,
      '```',
      '',
      '</Tab>',
      '</Tabs>',
      '',
    );
  }
  const generated =
    rule.generatedFiles === 'skip'
      ? 'Not reported in [generated files](/docs/configuration#generated-files), which are not edited by hand.'
      : undefined;
  if (rule.docs.scope || generated) {
    lines.push(
      '## Scope',
      '',
      [rule.docs.scope && mdx(rule.docs.scope), generated].filter(Boolean).join(' '),
      '',
    );
  }
  lines.push(
    ...acceptLines(rule, context.sample),
    '## Change the severity',
    '',
    'Change the severity (or turn the rule off) in `.github/flowpact/flowpact.config.yml`, by code or by name:',
    '',
    '```yaml title=".github/flowpact/flowpact.config.yml"',
    'rules:',
    `  ${rule.code}: ${rule.defaultSeverity === 'off' ? 'warning' : 'off'}`,
    `  # or: ${rule.name}: error`,
    '```',
    '',
    ...baselineLines(rule, 'severity'),
    'Explain it in the terminal:',
    '',
    '```sh',
    `flowpact explain ${rule.code}`,
    '```',
    '',
    ...relatedLines(rule, rules),
  );
  return lines.join('\n');
}

export function indexPage(rules: RuleDefinition[]): string {
  const lines = [
    '---',
    'title: Rules',
    'description: Every finding flowpact reports, grouped by category. Each code links to why it matters and how to fix it.',
    '---',
    '',
    '{/* Generated by scripts/gen-rule-docs.ts — edit the rules, not this file. */}',
    '',
    'Codes have the form `<PREFIX><category><nn>` — built-in rules use `FP`, so `FP4xx` are matrix rules.',
    'Severity is configurable per rule; codes never change meaning. Plugin rules use their own prefix (for example `ACME101`).',
    '',
  ];
  for (const group of ruleGroups(rules)) {
    lines.push(`## ${group.title}`, '', '| Code | Name | Default | Summary |', '| --- | --- | --- | --- |');
    for (const r of group.rules) {
      lines.push(
        `| [\`${r.code}\`](/docs/rules/${r.code.toLowerCase()}) | \`${r.name}\` | ${SEVERITY_BADGE[r.defaultSeverity]} | ${mdxCell(r.docs.summary)} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Reserved ranges', '', '- `FP7xx`: hygiene rules (none yet).', '');
  return lines.join('\n');
}

/** A lucide icon for each group of the Rules tab's sidebar, by the start of its title. */
const GROUP_ICONS: [string, string][] = [
  ['Inputs', 'TextCursorInput'],
  ['Secrets', 'KeyRound'],
  ['Outputs', 'ArrowRightFromLine'],
  ['Matrix', 'Grid3x3'],
  ['Env', 'Braces'],
  ['Graph', 'Network'],
  ['Contracts', 'FileLock'],
  ['Impact', 'GitPullRequest'],
  ['Config', 'Settings'],
];

/** The Rules tab of the sidebar: the index, then the rules under a separator per group (`meta.json`). */
export function rulesMeta(rules: RuleDefinition[]) {
  const pages = ['index'];
  for (const group of ruleGroups(rules)) {
    const icon = GROUP_ICONS.find(([start]) => group.title.startsWith(start))?.[1];
    pages.push(`---${icon ? `[${icon}]` : ''}${group.title.replace(/`/g, '')}---`);
    pages.push(...group.rules.map((r) => r.code.toLowerCase()));
  }
  return {
    title: 'Rules',
    description: 'Every finding, why it matters and how to fix it',
    root: true,
    icon: 'ListChecks',
    pages,
  };
}

/** Ranges within a category that read as a group of their own: impact mode's rules share the contracts category. */
const SUBGROUPS: { prefix: string; title: string }[] = [{ prefix: 'FP81', title: 'Impact mode (`FP81x`)' }];

/** The rules by category, in code order, with each subgroup split out under its own title. */
export function ruleGroups(rules: RuleDefinition[]): { title: string; rules: RuleDefinition[] }[] {
  const out: { title: string; rules: RuleDefinition[] }[] = [];
  for (const [digit, cat] of Object.entries(CATEGORIES)) {
    const inCat = rules.filter((r) => r.category === cat.id);
    const sub = (r: RuleDefinition) => SUBGROUPS.find((g) => r.code.startsWith(g.prefix));
    const main = inCat.filter((r) => !sub(r));
    const range =
      main.length && main.every((r) => r.code.startsWith(`FP${digit}0`)) && inCat.length > main.length;
    if (main.length) out.push({ title: `${cat.title} (\`FP${digit}${range ? '0x' : 'xx'}\`)`, rules: main });
    for (const g of SUBGROUPS) {
      const inGroup = inCat.filter((r) => sub(r) === g);
      if (inGroup.length) out.push({ title: g.title, rules: inGroup });
    }
  }
  return out;
}

if (import.meta.main ?? process.argv[1]?.endsWith('gen-rule-docs.ts')) {
  const rules = createRegistry().all();
  const byCode = new Map(rules.map((r) => [r.code, r]));
  const samples = ruleSamples();
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (/^fp\d{3}\.mdx$/.test(f)) rmSync(join(OUT, f));
  for (const rule of rules) {
    const sample = samples.get(rule.code);
    const page = rulePage(rule, { ...(sample ? { sample } : {}), rules: byCode });
    writeFileSync(join(OUT, `${rule.code.toLowerCase()}.mdx`), page);
  }
  const without = rules.filter((r) => !samples.has(r.code)).map((r) => r.code);
  console.log(`no fixture shows ${without.length} rules: ${without.join(', ')}`);
  writeFileSync(join(OUT, 'index.mdx'), indexPage(rules));
  writeFileSync(join(OUT, 'meta.json'), `${JSON.stringify(rulesMeta(rules), null, 2)}\n`);
  console.log(`wrote ${rules.length} rule pages to ${OUT}`);
}
