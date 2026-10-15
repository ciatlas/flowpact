import {
  type AnalysisResult,
  createRegistry,
  DOCS_BASE_URL,
  type Finding,
  type RuleDefinition,
  type RuleRegistry,
  type Severity,
  type SuppressedFinding,
} from '@flowpact/lint';
import { sarifLocation as physicalLocation, type SarifRule, sarifFixes, sarifLog } from './kit';

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  error: 'error',
  warning: 'warning',
  info: 'note',
};

export interface SarifOptions {
  /**
   * Also list findings accepted by overrides, as results with a `suppressions` entry. Off by default: GitHub code
   * scanning ignores `suppressions` and would open an alert for every accepted finding.
   */
  includeSuppressed?: boolean;
  /**
   * The flowpact root relative to the repository, when it is a subdirectory of it: code scanning resolves `%SRCROOT%`
   * against the repository.
   */
  pathPrefix?: string;
}

/** A rule as the analysis ran it: its code, name and configured severity. */
type ConfiguredRule = AnalysisResult['rules'][number];

/** A rule's name: its definition's, else the configured one's, else its findings'. */
function ruleName(
  code: string,
  def: RuleDefinition | undefined,
  configured: ConfiguredRule | undefined,
  sample: Finding | undefined,
): string {
  return def?.name ?? configured?.name ?? sample?.name ?? code;
}

/** Why a rule matters and how to fix what it reports: from its docs, else from its findings. */
function ruleAdvice(def: RuleDefinition | undefined, sample: Finding | undefined) {
  return { why: def?.docs.why ?? sample?.why ?? '', fix: def?.docs.fix ?? sample?.fix ?? '' };
}

/** A rule's docs page: the registry's, else its findings', else flowpact's docs. */
function ruleHelpUri(registry: RuleRegistry, def: RuleDefinition | undefined, sample: Finding | undefined) {
  return def ? registry.docsUrl(def) : (sample?.docsUrl ?? DOCS_BASE_URL);
}

/** The level a rule reports at: as configured when it is on, else its findings' severity. */
function ruleSeverity(configured: ConfiguredRule | undefined, sample: Finding | undefined): Severity {
  return configured && configured.severity !== 'off' ? configured.severity : (sample?.severity ?? 'warning');
}

/** A rule's category as its tags. */
function ruleTags(def: RuleDefinition | undefined, sample: Finding | undefined): string[] {
  const category = def?.category ?? sample?.category;
  return category ? [category] : [];
}

/** A rule's help, as text and as Markdown: why, the fix, and its docs. */
function ruleHelp(why: string, fix: string, helpUri: string) {
  return {
    text: [why, fix && `Fix: ${fix}`, `Docs: ${helpUri}`].filter(Boolean).join('\n\n'),
    markdown: [why && `**Why:** ${why}`, fix && `**Fix:** ${fix}`, `[Documentation](${helpUri})`]
      .filter(Boolean)
      .join('\n\n'),
  };
}

/** The SARIF descriptor of a rule; `sample` is its first finding, if any. */
function sarifRule(
  code: string,
  result: AnalysisResult,
  registry: RuleRegistry,
  sample: Finding | undefined,
): SarifRule {
  const configured = result.rules.find((r) => r.code === code);
  const def = registry.get(code);
  const name = ruleName(code, def, configured, sample);
  const { why, fix } = ruleAdvice(def, sample);
  const summary = def?.docs.summary ?? why ?? name;
  const helpUri = ruleHelpUri(registry, def, sample);
  return {
    id: code,
    name,
    shortDescription: { text: summary || name },
    ...(why ? { fullDescription: { text: why } } : {}),
    helpUri,
    help: ruleHelp(why, fix, helpUri),
    defaultConfiguration: { level: LEVEL[ruleSeverity(configured, sample)] },
    properties: { tags: ruleTags(def, sample) },
  };
}

/** SARIF 2.1.0 for GitHub code scanning and other SARIF viewers. */
export function renderSarif(result: AnalysisResult, opts: SarifOptions = {}): string {
  const registry = createRegistry();
  const all: (Finding | SuppressedFinding)[] = [
    ...result.findings,
    ...(opts.includeSuppressed ? result.suppressed : []),
  ];
  const firstFinding = new Map<string, Finding>();
  for (const f of all) if (!firstFinding.has(f.code)) firstFinding.set(f.code, f);

  // Every enabled rule, plus any rule that reported despite not being listed (defensive).
  const codes = result.rules.filter((r) => r.severity !== 'off').map((r) => r.code);
  for (const code of firstFinding.keys()) if (!codes.includes(code)) codes.push(code);
  codes.sort();

  const rules = codes.map((code) => sarifRule(code, result, registry, firstFinding.get(code)));
  const ruleIndex = new Map(rules.map((r, i) => [r.id, i]));

  const results = all.map((f) => ({
    ruleId: f.code,
    ruleIndex: ruleIndex.get(f.code)!,
    level: LEVEL[f.severity],
    message: { text: f.message },
    locations: [{ physicalLocation: physicalLocation(f.loc, opts.pathPrefix) }],
    ...(f.related.length
      ? {
          relatedLocations: f.related.map((r, id) => ({
            id,
            message: { text: r.message },
            physicalLocation: physicalLocation(r.loc, opts.pathPrefix),
          })),
        }
      : {}),
    partialFingerprints: { 'flowpact/v1': f.fingerprint },
    ...(f.suggestions?.length ? { fixes: sarifFixes(f.suggestions, opts.pathPrefix) } : {}),
    ...('override' in f
      ? { suppressions: [{ kind: 'external', status: 'accepted', justification: f.override.reason }] }
      : {}),
    properties: {
      ...(f.combos?.length ? { combos: f.combos } : {}),
      ...(f.symbol ? { symbol: f.symbol } : {}),
    },
  }));

  return sarifLog(
    { name: result.meta.tool, version: result.meta.version, informationUri: DOCS_BASE_URL, rules },
    results,
  );
}
