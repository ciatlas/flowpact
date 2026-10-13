/**
 * The flowpact package's programmatic API (`import { lint } from 'flowpact'`): one function per CLI command, built on
 * the same code as the commands (src/lib). Its types are the hand-written ../api.d.ts, which the build copies to
 * dist/api.d.ts; each export here is typed with them, so the type check fails when the two disagree.
 */
import { VERSION as ENGINE_VERSION } from '@flowpact/lint';
import type * as Api from '../api';
import { FlowpactError as FlowpactErrorClass } from './lib/errors';
import { runGenerate } from './lib/generate';
import { callGraph, explainRule, listRules, traceSymbol } from './lib/inspect';
import { type ReportCommand, runReport } from './lib/report';
import { openSession } from './lib/session';
import {
  explainText,
  generationText,
  graphText,
  renderOptions,
  rulesText,
  terminalRender,
  traceText,
} from './lib/text';

export const VERSION: typeof Api.VERSION = ENGINE_VERSION;

export const FlowpactError: typeof Api.FlowpactError = FlowpactErrorClass;

async function report(command: ReportCommand, options: Api.LintOptions | Api.ImpactOptions = {}) {
  // Without hooks, nothing stops the run before the analysis.
  return (await runReport(openSession(options), command, options))!;
}

export const lint: typeof Api.lint = (options) => report('lint', options);

export const check: typeof Api.check = (options) => report('check', options);

export const impact: typeof Api.impact = (options) => report('impact', options);

export const generate: typeof Api.generate = async (options = {}) =>
  runGenerate(openSession(options), options);

export const graph: typeof Api.graph = async (options = {}) => callGraph(openSession(options), options);

export const trace: typeof Api.trace = async (options) => traceSymbol(openSession(options), options);

export const rules: typeof Api.rules = async (options = {}) => listRules(openSession(options));

export const explain: typeof Api.explain = async (codeOrName, options = {}) =>
  explainRule(openSession(options), codeOrName);

// What the commands print, from what the functions above return: the same text as the CLI's for the same options.

export const formatGraph: typeof Api.formatGraph = (graph, options = {}) =>
  graphText(graph, options.format, renderOptions(options));

export const formatTrace: typeof Api.formatTrace = (result, options) =>
  traceText(result, renderOptions(options));

export const formatRules: typeof Api.formatRules = (list, options) => rulesText(list, renderOptions(options));

export const formatExplain: typeof Api.formatExplain = (rule, options) =>
  explainText(rule, renderOptions(options));

export const formatGeneration: typeof Api.formatGeneration = (generation, options = {}) =>
  generationText(generation, renderOptions(options), Boolean(options.diff));

export const terminalOptions: typeof Api.terminalOptions = () => {
  const { color, width, hyperlinks, ascii } = terminalRender();
  return { color, width, hyperlinks, ascii: Boolean(ascii) };
};

/** Returns the rule as is: it only gives a plugin rule written in TypeScript its type. */
export const defineRule: typeof Api.defineRule = (rule) => rule;
