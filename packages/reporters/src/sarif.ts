import { jsonSafe, type Loc } from '@flowpact/core';
import {
  type AnalysisResult,
  createRegistry,
  DOCS_BASE_URL,
  type Finding,
  type Severity,
  type SuppressedFinding,
} from '@flowpact/lint';
import { inRepository } from './github';

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  error: 'error',
  warning: 'warning',
  info: 'note',
};

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription?: { text: string };
  helpUri: string;
  help: { text: string; markdown: string };
  defaultConfiguration: { level: 'error' | 'warning' | 'note' };
  properties: { tags: string[] };
}

const region = (loc: Loc) => ({
  startLine: loc.line,
  startColumn: loc.column,
  endLine: loc.endLine,
  endColumn: loc.endColumn,
});

const physicalLocation = (loc: Loc, pathPrefix?: string) => ({
  artifactLocation: { uri: inRepository(loc.file, pathPrefix), uriBaseId: '%SRCROOT%' },
  region: region(loc),
});

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

  const rules: SarifRule[] = codes.map((code) => {
    const configured = result.rules.find((r) => r.code === code);
    const def = registry.get(code);
    const sample = firstFinding.get(code);
    const name = def?.name ?? configured?.name ?? sample?.name ?? code;
    const why = def?.docs.why ?? sample?.why ?? '';
    const fix = def?.docs.fix ?? sample?.fix ?? '';
    const summary = def?.docs.summary ?? why ?? name;
    const helpUri = def ? registry.docsUrl(def) : (sample?.docsUrl ?? DOCS_BASE_URL);
    const severity =
      configured && configured.severity !== 'off' ? configured.severity : (sample?.severity ?? 'warning');
    const category = def?.category ?? sample?.category;
    return {
      id: code,
      name,
      shortDescription: { text: summary || name },
      ...(why ? { fullDescription: { text: why } } : {}),
      helpUri,
      help: {
        text: [why, fix && `Fix: ${fix}`, `Docs: ${helpUri}`].filter(Boolean).join('\n\n'),
        markdown: [why && `**Why:** ${why}`, fix && `**Fix:** ${fix}`, `[Documentation](${helpUri})`]
          .filter(Boolean)
          .join('\n\n'),
      },
      defaultConfiguration: { level: LEVEL[severity] },
      properties: { tags: category ? [category] : [] },
    };
  });
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
    ...('override' in f
      ? { suppressions: [{ kind: 'external', status: 'accepted', justification: f.override.reason }] }
      : {}),
    properties: {
      ...(f.combos?.length ? { combos: f.combos } : {}),
      ...(f.symbol ? { symbol: f.symbol } : {}),
    },
  }));

  const sarif = {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: result.meta.tool,
            version: result.meta.version,
            semanticVersion: result.meta.version,
            informationUri: DOCS_BASE_URL,
            rules,
          },
        },
        columnKind: 'utf16CodeUnits',
        results,
      },
    ],
  };
  return jsonSafe(`${JSON.stringify(sarif, null, 2)}\n`);
}
