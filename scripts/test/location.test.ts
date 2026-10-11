import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS_BASE_URL, REPOSITORY, REPOSITORY_URL } from '@flowpact/lint';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const location = JSON.parse(read('packages/lint/src/location.json')) as {
  repository: string;
  docsBaseUrl: string;
};
/** Where flowpact lived before: only these scripts read it, so the shipped code carries no old location. */
const previous = JSON.parse(read('scripts/previous-locations.json')) as {
  repositories: string[];
  docsBaseUrls: string[];
};
/** Files that describe the past on purpose, including the list of previous locations itself. */
const HISTORY = ['CHANGELOG.md', 'apps/docs/content/docs/upgrading.mdx', 'scripts/previous-locations.json'];
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz|tgz|vsix)$/i;

describe('where flowpact lives (packages/lint/src/location.json)', () => {
  it('is what the code prints', () => {
    expect(REPOSITORY).toBe(location.repository);
    expect(REPOSITORY_URL).toBe(`https://github.com/${location.repository}`);
    expect(DOCS_BASE_URL).toBe(location.docsBaseUrl);
  });

  it('is what the published manifests say', () => {
    const cli = JSON.parse(read('packages/cli/package.json'));
    // npm provenance: repository.url must name the publishing repository exactly (scripts/check-pack.mjs checks it too).
    expect(cli.repository.url).toBe(`git+https://github.com/${location.repository}.git`);
    expect(cli.homepage).toBe(location.docsBaseUrl);
    expect(cli.bugs.url).toBe(`${REPOSITORY_URL}/issues`);
    const vscode = JSON.parse(read('packages/vscode/package.json'));
    expect(vscode.repository.url).toBe(`https://github.com/${location.repository}.git`);
    expect(vscode.homepage.startsWith(`${location.docsBaseUrl}/`)).toBe(true);
    expect(vscode.bugs.url).toBe(`${REPOSITORY_URL}/issues`);
    expect(vscode.qna).toBe(`${REPOSITORY_URL}/issues`);
  });

  it('leaves no previous location outside the history', () => {
    const old = [
      ...previous.repositories,
      ...previous.docsBaseUrls.map((url) => url.replace(/^https?:\/\//, '')),
    ];
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((f) => f && !HISTORY.includes(f) && !BINARY.test(f));
    const leftovers = files.flatMap((file) => {
      const text = read(file);
      return old.filter((o) => text.includes(o)).map((o) => `${file}: ${o}`);
    });
    expect(leftovers).toEqual([]);
  });
});
