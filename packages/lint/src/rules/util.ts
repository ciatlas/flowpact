import {
  type CallSite,
  type ConditionUse,
  conditionUses,
  type ExprSite,
  escapeControl,
  findTemplateSegments,
  type LocatedRef,
} from '@ciatlas/core';
import type { RelatedLocation } from './types';

/**
 * True when a condition site is one expression — bare, or a single `${{ }}` with nothing around it — rather than a
 * string with interpolations (which is always truthy when not empty).
 */
export function isWholeExpression(site: ExprSite): boolean {
  if (site.segments.length !== 1) return false;
  const templated = findTemplateSegments(site.text);
  return (
    templated.length === 0 ||
    (templated.length === 1 && site.text.trim() === site.text.slice(templated[0]!.start, templated[0]!.end))
  );
}

/** A job's or step's `if:` that decides whether a site is evaluated: its expression, or `false` for a literal `if: false`. */
export type Guard = ExprSite | false;

/** The guard a job's or step's `if:` sets, if any. A literal `if: false` (a YAML boolean) has no site but never runs. */
export function guardOf(decl: { ifValue?: boolean; ifSite?: ExprSite }): Guard | undefined {
  return decl.ifValue === false ? false : decl.ifSite;
}

/** How a condition site uses a reference: only the value of a whole-expression `if:` decides by truthiness. */
export function useInCondition(site: ExprSite, ref: LocatedRef): ConditionUse | undefined {
  const seg = site.segments.find((s) => s.refs.includes(ref));
  return seg ? conditionUses(seg.expr, isWholeExpression(site)).get(ref.start) : undefined;
}

export function chainRelated(chain: CallSite[]): RelatedLocation[] {
  return chain.map((c) => ({
    loc: c.job.uses?.loc ?? c.job.loc,
    message: `jobs.${c.job.id} calls ${c.callee.path}`,
  }));
}

/** Quotes a name from the analyzed YAML, making control characters (incl. newlines) visible. */
export const quote = (s: string) => `"${escapeControl(s)}"`;

/** A message's ` — did you mean "x"?` suffix for a guess, or nothing without one. */
export const didYouMeanNote = (guess: string | undefined) =>
  guess ? ` — did you mean ${quote(guess)}?` : '';

/** True when a reference's path segment names a key: present, and neither a `*` filter nor a `?` computed index. */
export function namesKey(segment: string | undefined): segment is string {
  return !!segment && segment !== '*' && segment !== '?';
}

/**
 * True when a reference's path segment is the context property `name` (written in lower case), compared the way GitHub
 * looks properties up: ignoring case. `@actions/expressions` lower-cases the keys of its `Dictionary`, and the runner's
 * `DictionaryContextData` compares them with `OrdinalIgnoreCase`, so `github.Event.Inputs` is `github.event.inputs`.
 */
export function isProperty(segment: string | undefined, name: string): boolean {
  return segment?.toLowerCase() === name;
}

export function listNames(names: string[], max = 6): string {
  if (names.length === 0) return '(none)';
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown}, … (+${names.length - max})` : shown;
}
