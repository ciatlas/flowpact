import { posix } from 'node:path';
import type { AnalysisResult, Finding, Severity } from '@flowpact/lint';

/** A finding as a GitHub annotation: what the action passes to `@actions/core`, and `--format github` prints. */
export interface GithubAnnotation {
  level: 'error' | 'warning' | 'notice';
  message: string;
  title: string;
  file: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface GithubOptions {
  /**
   * The flowpact root relative to the repository, when it is a subdirectory of it. flowpact reports paths relative to
   * its root; GitHub resolves annotation paths (and code scanning, SARIF URIs) against the repository.
   */
  pathPrefix?: string;
}

const LEVEL: Record<Severity, GithubAnnotation['level']> = {
  error: 'error',
  warning: 'warning',
  info: 'notice',
};

/** A root-relative path relative to the repository instead. */
export function inRepository(file: string, pathPrefix = ''): string {
  return pathPrefix ? posix.join(pathPrefix, file) : file;
}

export function githubAnnotation(f: Finding, opts: GithubOptions = {}): GithubAnnotation {
  const loc = f.loc;
  return {
    level: LEVEL[f.severity],
    message: `${f.message}\n${f.fix}\n${f.docsUrl}`,
    title: `${f.code} ${f.name}`,
    file: inRepository(loc.file, opts.pathPrefix),
    startLine: loc.line,
    endLine: loc.endLine,
    // GitHub only honours columns on single-line annotations.
    ...(loc.line === loc.endLine ? { startColumn: loc.column, endColumn: loc.endColumn } : {}),
  };
}

// The escaping of `@actions/core`: a command is one line, and its properties are separated by `,` and end at `::`.
const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * `--format github`: one workflow command per finding (`::error file=…,line=…::message`), which GitHub Actions turns
 * into an annotation on the run and the pull request. Findings accepted by overrides are left out.
 */
export function renderGithub(result: AnalysisResult, opts: GithubOptions = {}): string {
  return workflowCommands(result.findings.map((f) => githubAnnotation(f, opts)));
}

/** Annotations as workflow commands, every value escaped. */
export function workflowCommands(annotations: GithubAnnotation[]): string {
  return annotations
    .map((a) => {
      const props = (
        [
          ['title', a.title],
          ['file', a.file],
          ['line', a.startLine],
          ['endLine', a.endLine],
          ['col', a.startColumn],
          ['endColumn', a.endColumn],
        ] as const
      )
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${escapeProperty(String(v))}`)
        .join(',');
      return `::${a.level} ${props}::${escapeData(a.message)}\n`;
    })
    .join('');
}
