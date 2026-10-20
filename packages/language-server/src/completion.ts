import { type InputDecl, lookup, type ProjectIndex, type SecretDecl } from '@ciatlas/core';
import { isPlainName, lockedRemote, type RemotesLock } from '@flowpact/lint';
import {
  type CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
} from 'vscode-languageserver/node';
import { code, text } from './hover';
import type { RemoteSources } from './sources';

/** Where a key is being typed: in the `with:` or `secrets:` block of a call or step, and what that block has. */
export interface KeyContext {
  block: 'with' | 'secrets';
  /** The call's or step's `uses:` value. */
  uses: string;
  /** The keys the block already has, the one being typed aside. */
  present: string[];
  /** The key typed so far: its line and columns (0-based). */
  range: { line: number; start: number; end: number };
}

/** A line of YAML as far as a block's keys go: where it starts (a `- ` counts as indentation), and its key and value. */
interface LineInfo {
  column: number;
  /** The line starts a list item. */
  dash: boolean;
  key?: string;
  value?: string;
}

function lineInfo(line: string): LineInfo | undefined {
  const m = /^(\s*)(- +)?(.*)$/.exec(line)!;
  const rest = m[3]!;
  if (rest === '' || rest.startsWith('#')) return undefined;
  const column = m[1]!.length + (m[2]?.length ?? 0);
  const kv = /^(["']?)([^\s"'#:][^"'#:]*?)\1\s*:(?:\s+(.*?))?\s*(?:\s#.*)?$/.exec(rest);
  const value = kv?.[3]?.replace(/^(["'])(.*)\1$/, '$2');
  return { column, dash: m[2] !== undefined, ...(kv ? { key: kv[2]! } : {}), ...(value ? { value } : {}) };
}

/** The `uses:` among the keys of the mapping whose keys start at `column`, around line `at`. */
function usesAround(lines: (LineInfo | undefined)[], at: number, column: number): string | undefined {
  const sibling = (i: number) => {
    const l = lines[i];
    return l?.column === column && l.key === 'uses' ? l.value : undefined;
  };
  for (let i = at; i >= 0; i--) {
    const l = lines[i];
    if (!l) continue;
    if (l.column < column) return undefined;
    const uses = sibling(i);
    if (uses !== undefined || (l.column === column && l.dash)) return uses;
  }
  return undefined;
}

function usesBelow(lines: (LineInfo | undefined)[], from: number, column: number): string | undefined {
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (l.column < column || (l.column === column && l.dash)) return undefined;
    if (l.column === column && l.key === 'uses') return l.value;
  }
  return undefined;
}

/**
 * The block a key is being typed in, from the text as the editor has it (a block being edited often does not parse): the
 * cursor's line holds only the start of a key, under `with:` or `secrets:`, beside a `uses:`.
 */
export function keyContext(text: string, line: number, character: number): KeyContext | undefined {
  const raw = text.split(/\r?\n/);
  const typed = /^(\s*)([\w-]*)$/.exec(raw[line]?.slice(0, character) ?? '');
  if (!typed) return undefined;
  const indent = typed[1]!.length;
  const lines = raw.map((l, i) => (i === line ? undefined : lineInfo(l)));
  const p = parentOf(lines, line, indent);
  const parent = lines[p];
  if (parent?.key !== 'with' && parent?.key !== 'secrets') return undefined;
  // A `- with:` starts its list item: the step's keys are all below it.
  const uses =
    (parent.dash ? undefined : usesAround(lines, p - 1, parent.column)) ??
    usesBelow(lines, p + 1, parent.column);
  if (!uses) return undefined;
  const end = character + (/^[\w-]*/.exec(raw[line]!.slice(character))?.[0].length ?? 0);
  const present = keysOf(lines, p, indent);
  return { block: parent.key, uses, present, range: { line, start: indent, end } };
}

/** The line of the key a block holding keys at `indent` belongs to, when that key has no value of its own on its line. */
function parentOf(lines: (LineInfo | undefined)[], line: number, indent: number): number {
  let p = line - 1;
  while (p >= 0 && (lines[p] === undefined || lines[p]!.column >= indent)) p--;
  return lines[p]?.value === undefined ? p : -1;
}

/** The keys at `indent` of the block under line `p`. */
function keysOf(lines: (LineInfo | undefined)[], p: number, indent: number): string[] {
  const keys: string[] = [];
  for (let i = p + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (l.column <= lines[p]!.column) break;
    if (l.key && l.column === indent) keys.push(l.key);
  }
  return keys;
}

/** An input or secret a call can pass. */
interface Offer {
  name: string;
  required: boolean;
  type?: string;
  default?: unknown;
  description?: string;
  options?: string[];
}

const fromDecls = (decls: Record<string, InputDecl | SecretDecl> | undefined): Offer[] =>
  Object.values(decls ?? {}).map((d) => ({
    name: d.name,
    required: d.required,
    ...('type' in d && d.type ? { type: d.type } : {}),
    ...('hasDefault' in d && d.hasDefault ? { default: d.default } : {}),
    ...(d.description ? { description: d.description } : {}),
    ...('options' in d && d.options ? { options: d.options } : {}),
  }));

/** What a local workflow (`./.github/workflows/x.yml`) or action (known by its directory) declares. */
function localOffers(index: ProjectIndex, uses: string, block: KeyContext['block']): Offer[] | undefined {
  const unit = index.unit(uses.slice(2).replace(/\/+$/, ''));
  if (unit?.kind === 'workflow') return fromDecls(block === 'with' ? unit.call?.inputs : unit.call?.secrets);
  return unit?.kind === 'action' && block === 'with' ? fromDecls(unit.inputs) : undefined;
}

/** What the lockfile records for a remote reference, with descriptions from its cached source when there is one. */
function remoteOffers(
  lock: RemotesLock | undefined,
  sources: RemoteSources,
  uses: string,
  block: KeyContext['block'],
): Offer[] | undefined {
  const { entry } = lockedRemote(lock, uses);
  if (!entry || (block === 'secrets' && entry.kind !== 'workflow')) return undefined;
  const cached = sources.of(lock, uses)?.unit;
  const described = (name: string) => {
    if (!cached) return undefined;
    const decls =
      cached.kind === 'action'
        ? cached.inputs
        : block === 'with'
          ? cached.call?.inputs
          : cached.call?.secrets;
    return decls && lookup<InputDecl | SecretDecl>(decls, name)?.description;
  };
  const declared: Record<
    string,
    { required?: boolean; type?: string; default?: unknown; options?: string[] }
  > = (block === 'with' ? entry.inputs : entry.secrets) ?? {};
  return Object.entries(declared).map(([name, d]) => {
    const description = described(name);
    return {
      name,
      required: d.required === true,
      ...(d.type ? { type: d.type } : {}),
      ...(d.default !== undefined ? { default: d.default } : {}),
      ...(description ? { description } : {}),
      ...(d.options ? { options: d.options } : {}),
    };
  });
}

/** The inputs or secrets of the call a block belongs to: a local unit's, else the lockfile's for a remote reference. */
export function offersFor(
  index: ProjectIndex,
  lock: RemotesLock | undefined,
  sources: RemoteSources,
  ctx: KeyContext,
): Offer[] | undefined {
  return ctx.uses.startsWith('./')
    ? localOffers(index, ctx.uses, ctx.block)
    : remoteOffers(lock, sources, ctx.uses, ctx.block);
}

/** The completion items for the inputs or secrets the block does not pass yet: required ones first. */
export function completionItems(offers: Offer[], ctx: KeyContext): CompletionItem[] {
  const present = new Set(ctx.present.map((k) => k.toLowerCase()));
  const what = ctx.block === 'with' ? 'input' : 'secret';
  const range = {
    start: { line: ctx.range.line, character: ctx.range.start },
    end: { line: ctx.range.line, character: ctx.range.end },
  };
  return (
    offers
      // A name that is not plain could write other keys into the file (see `isPlainName`).
      .filter((o) => isPlainName(o.name) && !present.has(o.name.toLowerCase()))
      .map((o) => {
        const facts = [
          o.required ? 'required' : 'optional',
          o.type,
          o.default !== undefined ? `default ${code(JSON.stringify(o.default))}` : undefined,
          o.options?.length ? `one of ${o.options.map(code).join(', ')}` : undefined,
        ].filter(Boolean);
        return {
          label: o.name,
          kind: CompletionItemKind.Property,
          detail: `${o.required ? 'required' : 'optional'} ${o.type ? `${o.type} ` : ''}${what} of ${ctx.uses}`,
          documentation: {
            kind: MarkupKind.Markdown,
            value: [o.description && text(o.description), facts.join(' · ')].filter(Boolean).join('\n\n'),
          },
          sortText: `${o.required ? 0 : 1}${o.name}`,
          filterText: o.name,
          textEdit: { range, newText: `${o.name}: ` },
          insertTextFormat: InsertTextFormat.PlainText,
        };
      })
  );
}
