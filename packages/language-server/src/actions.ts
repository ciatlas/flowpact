import { join } from 'node:path';
import {
  type AnalysisResult,
  addIgnoreComment,
  addOverride,
  type ContractPlan,
  type ContractPlanEntry,
  type Finding,
  type OverrideEntry,
  overrideFor,
  unsafeContractPaths,
} from '@flowpact/lint';
import {
  type CodeAction,
  CodeActionKind,
  CreateFile,
  DeleteFile,
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

/** Whether a file is one of the repository's workflows or actions, where ignore comments are read. */
function isUnitFile(result: AnalysisResult | undefined, file: string): boolean {
  if (!result) return false;
  const { workflows, actions } = result.project;
  return [...workflows.values(), ...actions.values()].some((u) => u.file === file);
}

/**
 * "Ignore it on this line": a `# flowpact: ignore[<code>]` comment on a line of its own above the finding's, or the
 * code added to a comment that accepts that line already. Only in a workflow or action file of the repository at
 * `root.dir` (`textOf` gives its text as the editor has it), and not for a finding about the config, overrides or
 * ignore comments.
 */
export function ignoreAction(
  f: Finding,
  diagnostic: Diagnostic,
  root: { dir: string; result?: AnalysisResult | undefined },
  textOf: (path: string) => string | undefined,
): CodeAction | undefined {
  if (f.category === 'config' || !isUnitFile(root.result, f.loc.file)) return undefined;
  const path = join(root.dir, f.loc.file);
  const text = textOf(path);
  const at = text === undefined ? undefined : addIgnoreComment(text, f.code, f.loc.line);
  if (!at) return undefined;
  const pos = { line: at.line - 1, character: at.column - 1 };
  return {
    title: `Ignore ${f.code} on this line with a comment`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: { changes: { [pathToUri(path)]: [{ range: { start: pos, end: pos }, newText: at.newText }] } },
  };
}

/** The contract findings, which regenerating the contracts fixes. */
const CONTRACT_CODES = new Set(['FP801', 'FP802', 'FP803', 'FP804', 'FP805']);

/** What a client can do in a workspace edit: `documentChanges`, and creating and deleting files with them. */
export interface FileOps {
  documentChanges: boolean;
  create: boolean;
  delete: boolean;
}

/** The range of a whole text. */
function wholeRange(text: string) {
  const lines = text.split('\n');
  return {
    start: { line: 0, character: 0 },
    end: { line: lines.length - 1, character: lines.at(-1)!.length },
  };
}

/** A contract file's change as `documentChanges`: created, replaced or deleted. */
function contractChange(
  e: ContractPlanEntry,
  uri: string,
  current: string,
): (CreateFile | DeleteFile | TextDocumentEdit)[] {
  const start = { line: 0, character: 0 };
  if (e.status === 'delete') return [DeleteFile.create(uri, { ignoreIfNotExists: true })];
  if (e.status === 'create')
    return [
      CreateFile.create(uri, { overwrite: true }),
      TextDocumentEdit.create({ uri, version: null }, [
        { range: { start, end: start }, newText: e.after ?? '' },
      ]),
    ];
  return [
    TextDocumentEdit.create({ uri, version: null }, [{ range: wholeRange(current), newText: e.after ?? '' }]),
  ];
}

/**
 * "Regenerate the contracts" on a contract finding: every contract file as `flowpact generate` writes it, created,
 * replaced or deleted in one edit (`textOf` gives a file's current text, an open document's when it is open). None
 * when nothing changes, when the client cannot create or delete a file it would have to, or when a contract path is a
 * symlink or leads outside the repository.
 */
export function regenerateAction(
  dir: string,
  plan: ContractPlan | undefined,
  diagnostic: Diagnostic,
  ops: FileOps,
  textOf: (path: string) => string | undefined,
): CodeAction | undefined {
  if (!plan?.drift || !CONTRACT_CODES.has(String(diagnostic.code))) return undefined;
  const changed = plan.entries.filter((e) => e.status !== 'unchanged');
  const needs = (status: string) => changed.some((e) => e.status === status);
  if ((needs('create') && !ops.create) || (needs('delete') && !ops.delete)) return undefined;
  if (changed.length === 0 || unsafeContractPaths(dir, plan).length) return undefined;
  const files = changed.map((e) => {
    const path = join(dir, e.file);
    return { e, uri: pathToUri(path), current: textOf(path) ?? e.before ?? '' };
  });
  // Only updates: a client without `documentChanges` takes them as plain text edits.
  const edit: WorkspaceEdit = ops.documentChanges
    ? { documentChanges: files.flatMap(({ e, uri, current }) => contractChange(e, uri, current)) }
    : {
        changes: Object.fromEntries(
          files.map(({ e, uri, current }) => [uri, [{ range: wholeRange(current), newText: e.after ?? '' }]]),
        ),
      };
  const n = changed.length;
  return {
    title: `Regenerate the contracts (${n} file${n > 1 ? 's' : ''})`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit,
  };
}
