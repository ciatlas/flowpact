/**
 * Type-level checks of the hand-written declarations (api.d.ts) against the engine's own types, compiled by
 * `pnpm typecheck`; there is nothing to run. src/api.ts is typed with the declarations too, so its functions must
 * return what they promise.
 */
import type { ProjectIndex as EngineIndex, Loc as EngineLoc } from '@flowpact/core';
import type {
  Finding as EngineFinding,
  RuleContext as EngineRuleContext,
  RuleDefinition as EngineRuleDefinition,
  JsonReport,
  RuleRegistry,
} from '@flowpact/lint';
import type { CallGraph as EngineCallGraph, GithubAnnotation, MarkdownOptions } from '@flowpact/reporters';
import type * as Api from '../api';
import type { Analysis as EngineAnalysis } from '../src/lib/report';

/** True when A and B are the same type, property for property (optional and readonly included). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(check: Equal<A, B>) => check;

// The report is the schema's type: every key, nested ones included, and nothing else.
same<Api.Report, JsonReport>(true);
same<Api.Finding, JsonReport['findings'][number]>(true);
same<Api.Loc, EngineLoc>(true);
same<Api.Annotation, GithubAnnotation>(true);
same<Api.MarkdownOptions, MarkdownOptions>(true);
same<Api.CallGraph, EngineCallGraph>(true);
same<Api.Severity, EngineFinding['severity']>(true);

// What the API returns is what the CLI renders from.
const analysis = (a: EngineAnalysis): Api.Analysis => a;

// A plugin rule written against the declarations is a rule the engine runs, and the context the engine passes it is
// the context the declarations describe (the members a rule can use are there, with compatible types).
const register = (registry: RuleRegistry, rule: Api.RuleDefinition) => registry.register(rule);
const context = (ctx: EngineRuleContext): Api.RuleContext => ctx;
const index = (i: EngineIndex): Api.ProjectIndex => i;
const builtIn = (rule: EngineRuleDefinition): Api.RuleDefinition => rule;

export const checks = [analysis, register, context, index, builtIn];
