import { sep } from 'node:path';
import type { Loc } from '@ciatlas/core';
import type { Finding } from '@flowpact/lint';
import { type Diagnostic, DiagnosticSeverity, DiagnosticTag, type Range } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

export const toPosix = (p: string) => p.split(sep).join('/');

/** The file-system path of a `file:` URI; other schemes (untitled buffers, git diffs) are not analyzed. */
export function uriToPath(uri: string): string | undefined {
  const parsed = URI.parse(uri);
  return parsed.scheme === 'file' ? parsed.fsPath : undefined;
}

export const pathToUri = (path: string) => URI.file(path).toString();

/**
 * A {@link Loc} (1-based, end exclusive) as an LSP range (0-based, end exclusive). Both count UTF-16 code units: the
 * YAML parser's offsets are JavaScript string indexes.
 */
export function toRange(loc: Pick<Loc, 'line' | 'column' | 'endLine' | 'endColumn'>): Range {
  return {
    start: { line: loc.line - 1, character: loc.column - 1 },
    end: { line: loc.endLine - 1, character: loc.endColumn - 1 },
  };
}

const SEVERITY: Record<Finding['severity'], DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
};

/** Rules about declarations nothing uses; editors fade them out. */
const UNNECESSARY = new Set(['FP104', 'FP203', 'FP303', 'FP405', 'FP902']);

/** Matrix combinations listed in a message before the rest are counted. */
const MAX_COMBOS = 5;

/** What a published diagnostic carries for later requests (quick fixes). */
interface DiagnosticData {
  fingerprint: string;
  symbol?: string;
}

export function toDiagnostic(f: Finding, uriOf: (file: string) => string): Diagnostic {
  const combos = f.combos ?? [];
  const more = combos.length > MAX_COMBOS ? ` and ${combos.length - MAX_COMBOS} more` : '';
  const matrix = combos.length ? `\nMatrix: ${combos.slice(0, MAX_COMBOS).join('; ')}${more}` : '';
  return {
    range: toRange(f.loc),
    severity: SEVERITY[f.severity],
    code: f.code,
    codeDescription: { href: f.docsUrl },
    source: 'flowpact',
    message: `${f.message}${matrix}`,
    ...(f.related.length
      ? {
          relatedInformation: f.related.map((r) => ({
            location: { uri: uriOf(r.loc.file), range: toRange(r.loc) },
            message: r.message,
          })),
        }
      : {}),
    ...(UNNECESSARY.has(f.code) ? { tags: [DiagnosticTag.Unnecessary] } : {}),
    data: { fingerprint: f.fingerprint, ...(f.symbol ? { symbol: f.symbol } : {}) } satisfies DiagnosticData,
  };
}
