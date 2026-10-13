/** `graph`, `trace`, `rules` and `explain`: what flowpact knows about a repository and its rules. */
import { didYouMean, resolveSymbols, type TraceDirection, type TraceNode, trace } from '@ciatlas/core';
import { analyze, type RuleCategory, resolveSeverities, type SeveritySetting } from '@flowpact/lint';
import { buildCallGraph, type CallGraph, reachableGraph } from '@flowpact/reporters';
import { attempt, NoSymbolMatchError, usage } from './errors';
import { analyzeSession, bool, loadRegistry, type Session, stringList } from './session';
import { checkNotEmpty, checkTargets } from './targets';

export interface GraphOptions {
  /**
   * Workflow and action files or directories, relative to the root: draw only them and what they call and use.
   * Default: all.
   */
  paths?: string[];
}

/** Which workflows call which reusable workflows and local actions; with paths, from those workflows and actions. */
export async function callGraph(session: Session, options: GraphOptions = {}): Promise<CallGraph> {
  const paths = stringList('paths', options.paths) ?? [];
  const { root, loaded, logger } = session;
  const result = attempt(() =>
    analyze({ root, config: loaded.config, logger, validateSchema: false, only: [], paths }),
  );
  checkTargets(result.project, paths, root);
  checkNotEmpty(result.summary, root);
  const { targets } = result.project;
  const whole = buildCallGraph(result.index);
  const graph = targets.size
    ? reachableGraph(
        whole,
        result.index
          .units()
          .filter((u) => targets.has(u.file))
          .map((u) => u.path),
      )
    : whole;
  logger.debug('call graph', { nodes: graph.nodes.length, edges: graph.edges.length });
  return graph;
}

export interface TraceOptions {
  /** e.g. `pipeline.yml#inputs.config`, `pipeline.yml:config`, or `pipeline.yml` for its whole interface. */
  symbol: string;
  /** Trace upstream: who provides the value. */
  up?: boolean;
  /** Maximum depth. Default: 12. */
  depth?: number;
}

/** What `trace --format json` prints: one tree per matching symbol. */
export interface TraceResult {
  query: string;
  direction: TraceDirection;
  traces: TraceNode[];
  /** The workflow or action the query names when it declares no inputs, secrets or outputs (`traces` is empty). */
  unit?: string;
}

/** Traces a symbol. */
export async function traceSymbol(session: Session, options: TraceOptions): Promise<TraceResult> {
  const query = options?.symbol;
  if (typeof query !== 'string') throw usage('symbol must be a string');
  const depth = options.depth ?? 12;
  if (!Number.isInteger(depth) || depth < 1)
    throw usage(`depth must be a positive integer (got ${JSON.stringify(depth)})`);
  const analysis = await analyzeSession(session, { validateSchema: false, only: [] });
  const direction: TraceDirection = bool('up', options.up) ? 'up' : 'down';
  const matches = resolveSymbols(analysis.index, query);
  if (matches.length === 0) {
    const unit = analysis.index.units().find((u) => u.path === query || u.path.endsWith(`/${query}`));
    if (unit) return { query, direction, traces: [], unit: unit.path };
    const traceable = new Set(
      [...analysis.index.nodes.values()]
        .filter((n) => ['input', 'secret', 'output'].includes(n.kind))
        .map((n) => n.unit),
    );
    // The workflows and actions that have an interface to trace, as suggestions.
    const files = [...analysis.project.workflows.keys(), ...analysis.project.actions.keys()].filter((f) =>
      traceable.has(f),
    );
    throw new NoSymbolMatchError(
      files.length
        ? `No symbol matches "${query}". Workflows and actions with inputs, secrets or outputs: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''}`
        : `No symbol matches "${query}", and no workflow or action here declares inputs, secrets or outputs.`,
      files,
    );
  }
  const traces = matches.map((m) => trace(analysis.index, m.id, { direction, maxDepth: depth }));
  return { query, direction, traces };
}

/** A rule as `rules --format json` lists it. */
export interface RuleInfo {
  code: string;
  name: string;
  category: RuleCategory;
  defaultSeverity: SeveritySetting;
  /** After the config. */
  severity: SeveritySetting;
  summary: string;
  docsUrl: string;
}

/** A rule's documentation, as `explain` shows it. */
export interface RuleDocs extends RuleInfo {
  why: string;
  fix: string;
  /** What the rule deliberately leaves out. */
  scope?: string;
  examples?: { bad: string; good: string };
  /** `skip`: the rule's findings in generated files are not reported. */
  generatedFiles: 'report' | 'skip';
}

export async function listRules(session: Session): Promise<RuleInfo[]> {
  const registry = await loadRegistry(session);
  const severities = attempt(() => resolveSeverities(registry, session.loaded.config));
  return registry.all().map((r) => ({
    code: r.code,
    name: r.name,
    category: r.category,
    defaultSeverity: r.defaultSeverity,
    severity: severities.get(r.code) ?? r.defaultSeverity,
    summary: r.docs.summary,
    docsUrl: registry.docsUrl(r),
  }));
}

export async function explainRule(session: Session, codeOrName: string): Promise<RuleDocs> {
  if (typeof codeOrName !== 'string') throw usage('the rule must be a code or name (a string)');
  const registry = await loadRegistry(session);
  const rule = registry.get(codeOrName);
  if (!rule) {
    const guess = didYouMean(
      codeOrName,
      registry.all().flatMap((r) => [r.code, r.name]),
    );
    throw usage(`Unknown rule "${codeOrName}".${guess ? ` Did you mean ${guess}?` : ''}`);
  }
  const severities = attempt(() => resolveSeverities(registry, session.loaded.config));
  const { docs } = rule;
  return {
    code: rule.code,
    name: rule.name,
    category: rule.category,
    defaultSeverity: rule.defaultSeverity,
    severity: severities.get(rule.code) ?? rule.defaultSeverity,
    summary: docs.summary,
    docsUrl: registry.docsUrl(rule),
    why: docs.why,
    fix: docs.fix,
    ...(docs.scope !== undefined ? { scope: docs.scope } : {}),
    ...(docs.examples ? { examples: { bad: docs.examples.bad, good: docs.examples.good } } : {}),
    generatedFiles: rule.generatedFiles ?? 'report',
  };
}
