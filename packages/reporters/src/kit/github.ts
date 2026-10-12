import { posix } from 'node:path';

/** A GitHub annotation: an error, warning or notice on a line range of a file, shown on the run and the pull request. */
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

/** A path relative to a directory of the repository (`pathPrefix`) as a path relative to the repository. */
export function inRepository(file: string, pathPrefix = ''): string {
  return pathPrefix ? posix.join(pathPrefix, file) : file;
}

// The escaping of `@actions/core`: a command is one line, and its properties are separated by `,` and end at `::`.
const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

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
