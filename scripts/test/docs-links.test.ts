/** The link checker's decisions (scripts/docs-links.ts), apart from the files it reads. */
import { describe, expect, it } from 'vitest';
import { anchorOf, anchorProblem, commandNames, htmlIds, siteLinksIn, underBase } from '../docs-links';

describe('docs links', () => {
  it('reads the ids of a page, decoding &amp;', () => {
    expect(htmlIds('<h2 id="flowpact-lint">x</h2><a id="a&amp;b"></a><div data-id="no">')).toEqual(
      new Set(['flowpact-lint', 'a&b']),
    );
  });

  it('finds an anchor that names no id, and accepts one that does or none', () => {
    const ids = new Set(['flowpact-remotes-update', 'café']);
    expect(anchorProblem('/flowpact/docs/cli#flowpact-remotes-update', ids)).toBeUndefined();
    expect(anchorProblem('/flowpact/docs/cli#caf%C3%A9', ids)).toBeUndefined();
    expect(anchorProblem('/flowpact/docs/cli', ids)).toBeUndefined();
    expect(anchorProblem('/flowpact/docs/cli#', ids)).toBeUndefined();
    expect(anchorProblem('/flowpact/docs/cli#flowpact-remotes', ids)).toBe(
      'no #flowpact-remotes on the page',
    );
    expect(anchorProblem('#nope', ids)).toBe('no #nope on the page');
    expect(anchorOf('/x#a%20b')).toBe('a b');
  });

  it('knows the base path', () => {
    expect(underBase('/flowpact', '/flowpact')).toBe(true);
    expect(underBase('/flowpact/docs', '/flowpact')).toBe(true);
    expect(underBase('/flowpact#top', '/flowpact')).toBe(true);
    expect(underBase('/docs/cli', '/flowpact')).toBe(false);
    expect(underBase('/flowpactx/docs', '/flowpact')).toBe(false);
  });

  it('finds the site URLs a text names, without sentence punctuation or template URLs', () => {
    const text = [
      'See https://ciatlas.github.io/flowpact/docs/cli#flowpact-lint.',
      '(https://ciatlas.github.io/flowpact/docs/rules/fp401), and https://ciatlas.github.io/flowpact.',
      '`https://ciatlas.github.io/flowpact/docs/rules/${code}`',
      '"https://ciatlas.github.io/flowpact/schemas/config/v1.json"',
      'https://example.com/flowpact/docs/x',
    ].join('\n');
    expect(siteLinksIn(text)).toEqual([
      '/flowpact/docs/cli#flowpact-lint',
      '/flowpact/docs/rules/fp401',
      '/flowpact',
      '/flowpact/schemas/config/v1.json',
    ]);
  });

  it('reads the command names a module exports', () => {
    expect(commandNames({ lintCommand: { meta: { name: 'lint' } }, helper: () => 1, other: null })).toEqual([
      'lint',
    ]);
  });
});
