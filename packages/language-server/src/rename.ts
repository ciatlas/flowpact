import {
  type Loc,
  lookup,
  type Occurrence,
  type ProjectIndex,
  type SymbolLocator,
  sym,
  type UnitDecl,
} from '@ciatlas/core';
import { sourceOf } from '@flowpact/lint';

/** What a rename renames: an input, a secret, an output of a workflow or action, or a job's output. */
export interface RenameTarget {
  kind: 'input' | 'secret' | 'output' | 'jobOutput';
  /** The workflow or action that declares it. */
  unit: string;
  name: string;
  /** For a job's output, the job. */
  job?: string;
  symbol: string;
}

/** A rename flowpact refuses, and why. */
export class RenameRefused extends Error {}

/** What GitHub accepts as the id of an input, a secret or an output. */
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The symbol's unit (the part before `#`). */
const unitOf = (symbol: string) => symbol.slice(0, symbol.indexOf('#'));

/**
 * What renaming the symbol at a position renames: what declares it, so that a caller's `with:` key renames the
 * callee's input and `needs.<job>.outputs.<name>` the called workflow's output.
 */
export function renameTarget(index: ProjectIndex, locator: SymbolLocator, at: Occurrence): RenameTarget {
  if (at.symbol.startsWith('remote:')) throw new RenameRefused('It is declared in another repository.');
  const [d] = locator.declarations(at.symbol);
  if (!d) throw new RenameRefused('Only a declared input, secret or output can be renamed.');
  if (index.unit(d.unit)?.external) throw new RenameRefused('It is declared in another repository.');
  if (d.kind === 'step')
    throw new RenameRefused("The step's script writes this output: rename it in the script and its reads.");
  if (d.kind === 'input')
    return { kind: 'input', unit: d.unit, name: d.decl.name, symbol: sym.input(d.unit, d.decl.name) };
  if (d.kind === 'secret')
    return { kind: 'secret', unit: d.unit, name: d.decl.name, symbol: sym.secret(d.unit, d.decl.name) };
  if (d.kind !== 'output') throw new RenameRefused('Only an input, a secret or an output can be renamed.');
  // A job's own output; else what a called workflow or a step's action declares.
  const job = /#jobs\.([^.]+)\.outputs\.[^.]+$/.exec(at.symbol)?.[1];
  if (job && unitOf(at.symbol) === d.unit)
    return {
      kind: 'jobOutput',
      unit: d.unit,
      name: d.decl.name,
      job,
      symbol: sym.jobOutput(d.unit, job, d.decl.name),
    };
  return { kind: 'output', unit: d.unit, name: d.decl.name, symbol: sym.output(d.unit, d.decl.name) };
}

/** Every place that names the target: its declaration, what callers pass, and what reads it, in any file. */
function occurrencesOf(index: ProjectIndex, locator: SymbolLocator, t: RenameTarget): Occurrence[] {
  const own = locator.occurrences(t.symbol);
  if (t.kind !== 'output') return own;
  // A called workflow's output is read as `needs.<job>.outputs.<name>`; an action's as `steps.<id>.outputs.<name>`.
  const reads =
    index.unit(t.unit)?.kind === 'workflow'
      ? index.callersOf(t.unit).map((c) => sym.jobOutput(c.caller.path, c.job.id, t.name))
      : index
          .usersOf(t.unit)
          .flatMap((u) => (u.step.id ? [sym.stepOutput(u.unit.path, u.job?.id, u.step.id, t.name)] : []));
  return [...own, ...reads.flatMap((s) => locator.occurrences(s))];
}

type Names = Record<string, unknown> | undefined;

/** The names a unit already declares where a target of each kind lives. */
const DECLARED: Record<RenameTarget['kind'], (unit: UnitDecl, t: RenameTarget) => Names[]> = {
  input: (u) => (u.kind === 'action' ? [u.inputs] : [u.call?.inputs, u.dispatch?.inputs]),
  secret: (u) => (u.kind === 'action' ? [] : [u.call?.secrets]),
  output: (u) => (u.kind === 'action' ? [u.outputs] : [u.call?.outputs]),
  jobOutput: (u, t) => (u.kind === 'action' ? [] : [u.jobs[t.job!]?.outputs]),
};

/** Why the target cannot be renamed to `name`, if it cannot. */
function refusal(index: ProjectIndex, t: RenameTarget, name: string): string | undefined {
  if (!NAME.test(name))
    return `${JSON.stringify(name)} is not a valid name: a letter or _, then letters, digits, - or _.`;
  const unit = index.unit(t.unit);
  const other = name.toLowerCase() !== t.name.toLowerCase();
  // Case-insensitively, as GitHub matches them.
  if (unit && other && DECLARED[t.kind](unit, t).some((m) => m && lookup(m, name)))
    return `${t.unit} already has ${JSON.stringify(name)}.`;
  // A caller that inherits its secrets would then pass the callee another secret of its own, by the new name.
  const inherits =
    t.kind === 'secret' ? index.callersOf(t.unit).find((c) => c.job.secretsInherit) : undefined;
  if (inherits)
    return `jobs.${inherits.job.id} of ${inherits.caller.path} passes its secrets with \`secrets: inherit\`: renaming would change which secret the workflow gets.`;
  return undefined;
}

/** The text a one-line location covers. */
function textAt(index: ProjectIndex, loc: Loc): string | undefined {
  if (loc.line !== loc.endLine) return undefined;
  return sourceOf(index, loc.file)?.lines[loc.line - 1]?.slice(loc.column - 1, loc.endColumn - 1);
}

type Edit = { loc: Loc; newText: string };

/** The edit renaming a key, quoted or not. */
function keyEdit(loc: Loc, text: string, from: string, to: string): Edit | undefined {
  const quoted = /^(["'])(.*)\1$/.exec(text);
  if ((quoted?.[2] ?? text).toLowerCase() !== from.toLowerCase()) return undefined;
  return { loc, newText: quoted ? `${quoted[1]}${to}${quoted[1]}` : to };
}

/** The edit renaming the last segment of a reference, such as `needs.build.outputs.url`. */
function segmentEdit(loc: Loc, text: string, from: string, to: string): Edit | undefined {
  const parts = /^[\w.-]+$/.test(text) ? text.split('.') : [];
  const i = parts.findLastIndex((p) => p.toLowerCase() === from.toLowerCase());
  if (i <= 0) return undefined;
  const column = loc.column + parts.slice(0, i).reduce((n, p) => n + p.length + 1, 0);
  return { loc: { ...loc, column, endColumn: column + parts[i]!.length }, newText: to };
}

/** The edit renaming one occurrence: a key, or the last segment of a reference. */
function renameAt(index: ProjectIndex, loc: Loc, from: string, to: string): Edit {
  const text = textAt(index, loc);
  const edit =
    text === undefined ? undefined : (keyEdit(loc, text, from, to) ?? segmentEdit(loc, text, from, to));
  if (edit) return edit;
  throw new RenameRefused(
    `${loc.file}:${loc.line} reads it in a way flowpact does not rename (${text ?? 'over several lines'}): rename it by hand.`,
  );
}

/** The edits that rename the target to `name`, in every file that names it. */
export function renameEdits(
  index: ProjectIndex,
  locator: SymbolLocator,
  t: RenameTarget,
  name: string,
): Edit[] {
  const refused = refusal(index, t, name);
  if (refused) throw new RenameRefused(refused);
  return occurrencesOf(index, locator, t).map((o) => renameAt(index, o.loc, t.name, name));
}
