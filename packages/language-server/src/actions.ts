import { join } from 'node:path';
import { addOverride, type Finding, type OverrideEntry, overrideFor } from '@flowpact/lint';
import {
  type CodeAction,
  CodeActionKind,
  CreateFile,
  type Diagnostic,
  TextDocumentEdit,
  type TextEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { pathToUri, toRange } from './convert';

/** The server command that adds an override for a finding: `[{ uri, fingerprint, reason, expires? }]`. */
export const ACCEPT_COMMAND = 'flowpact.acceptFinding';
/** The client command (VS Code's) that asks for the reason and the expiry, then runs `ACCEPT_COMMAND`. */
const ACCEPT_PROMPT_COMMAND = 'flowpact.acceptFindingWithReason';
/** The reason an override gets from a client that cannot ask for one, to replace. */
const PLACEHOLDER_REASON = 'Explain why this finding is accepted';

/** What `ACCEPT_COMMAND` and `ACCEPT_PROMPT_COMMAND` take. */
export interface AcceptArgs {
  uri: string;
  fingerprint: string;
  reason?: string;
  expires?: string;
}

/** The quick fixes of a finding's suggestions, the first one preferred. */
export function suggestionActions(dir: string, f: Finding, diagnostic: Diagnostic): CodeAction[] {
  return (f.suggestions ?? []).map((s, i) => {
    const changes: Record<string, TextEdit[]> = {};
    for (const e of s.edits) {
      const uri = pathToUri(join(dir, e.loc.file));
      changes[uri] = [...(changes[uri] ?? []), { range: toRange(e.loc), newText: e.newText }];
    }
    return {
      title: s.title,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      isPreferred: i === 0,
      edit: { changes },
    };
  });
}

/**
 * The edit adding an override to the config file at `path` (absolute), whose text is `text` (`undefined`: no file
 * yet, created when the client can). None when the config's `overrides` cannot be extended.
 */
export function acceptEdit(
  path: string,
  text: string | undefined,
  entry: OverrideEntry,
  canCreate: boolean,
): WorkspaceEdit | undefined {
  const at = addOverride(text, entry);
  if (!at) return undefined;
  const uri = pathToUri(path);
  const pos = { line: at.line - 1, character: at.column - 1 };
  const edit: TextEdit = { range: { start: pos, end: pos }, newText: at.newText };
  if (!at.create) return { changes: { [uri]: [edit] } };
  if (!canCreate) return undefined;
  return {
    documentChanges: [
      CreateFile.create(uri, { ignoreIfExists: true }),
      TextDocumentEdit.create({ uri, version: null }, [edit]),
    ],
  };
}

/** How a client accepts a finding: it asks for the reason itself, or gets an edit with a placeholder reason. */
export interface AcceptOptions {
  prompt: boolean;
  canCreate: boolean;
  config: { path: string; text: string | undefined };
}

/**
 * "Accept this finding": an override for it in the config, by its symbol (else for its rule in its file). None for a
 * finding about the config itself.
 */
export function acceptAction(
  f: Finding,
  diagnostic: Diagnostic,
  uri: string,
  opts: AcceptOptions,
): CodeAction | undefined {
  if (f.category === 'config') return undefined;
  const title = f.symbol
    ? 'Accept this finding with an override'
    : `Accept ${f.code} in this file with an override`;
  const base = { kind: CodeActionKind.QuickFix, diagnostics: [diagnostic] };
  if (opts.prompt) {
    const args: AcceptArgs = { uri, fingerprint: f.fingerprint };
    return {
      ...base,
      title: `${title}…`,
      command: { title, command: ACCEPT_PROMPT_COMMAND, arguments: [args] },
    };
  }
  const edit = acceptEdit(
    opts.config.path,
    opts.config.text,
    overrideFor(f, PLACEHOLDER_REASON),
    opts.canCreate,
  );
  return edit && { ...base, title, edit };
}
