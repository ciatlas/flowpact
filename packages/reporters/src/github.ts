import type { AnalysisResult, Finding, Severity } from '@flowpact/lint';
import { type GithubAnnotation, inRepository, workflowCommands } from './kit';

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

/** A finding as a GitHub annotation: what the action passes to `@actions/core`, and `--format github` prints. */
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

/**
 * `--format github`: one workflow command per finding (`::error file=…,line=…::message`), which GitHub Actions turns
 * into an annotation on the run and the pull request. Findings accepted by overrides are left out.
 */
export function renderGithub(result: AnalysisResult, opts: GithubOptions = {}): string {
  return workflowCommands(result.findings.map((f) => githubAnnotation(f, opts)));
}
