/** The host of a repository's `origin` remote, read from its git config without running git. */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** The host of the `origin` remote of the repository a directory is in (or below), as its URL writes it. */
export function originHost(root: string): string | undefined {
  const config = gitConfigOf(root);
  let text: string;
  try {
    text = config ? readFileSync(config, 'utf8') : '';
  } catch {
    return undefined;
  }
  // `url` at the start of a line, not the end of `pushurl` (as core's `detectRepository` reads it).
  const url = /\[remote "origin"\][^[]*?^[ \t]*url\s*=\s*(\S+)/m.exec(text)?.[1];
  return url ? hostOfGitUrl(url) : undefined;
}

/**
 * The git config of the repository a directory is in: `.git/config`, found upwards. A `.git` file names the git
 * directory: a worktree's has a `commondir` naming the main repository's; a submodule's (or one made with
 * `--separate-git-dir`) is its own. Each file is read, not checked first: nothing can change between a check and a read.
 */
function gitConfigOf(root: string): string | undefined {
  for (let top = root; ; top = dirname(top)) {
    const git = join(top, '.git');
    const found = readGit(git);
    if (found === DIRECTORY) return join(git, 'config');
    if (found !== undefined) return configOfGitdir(top, found);
    if (dirname(top) === top) return undefined;
  }
}

const DIRECTORY = Symbol('directory');

/** A `.git` entry: a directory, the text of a `.git` file, or undefined when there is none (or it cannot be read). */
function readGit(path: string): string | typeof DIRECTORY | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EISDIR' ? DIRECTORY : undefined;
  }
}

/** The config of the git directory a `.git` file names (`gitdir: …`), through its `commondir` when it has one. */
function configOfGitdir(top: string, text: string): string | undefined {
  const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (!gitdir) return undefined;
  const dir = isAbsolute(gitdir) ? gitdir : join(top, gitdir);
  let common: string | undefined;
  try {
    common = readFileSync(join(dir, 'commondir'), 'utf8').trim();
  } catch {
    // No commondir: the git directory is its own (a submodule's, or one made with --separate-git-dir).
  }
  return join(common ? join(dir, common) : dir, 'config');
}

/** The host of a git remote's URL: `https://host/…`, `ssh://git@host:22/…`, or `git@host:owner/repo`. */
export function hostOfGitUrl(url: string): string | undefined {
  const scp = /^[^@/:]+@([^:/]+):/.exec(url);
  let host = scp?.[1];
  if (!host) {
    try {
      host = new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
  return plainHost(host);
}

/** A host name as links may use it: letters, digits, dots and hyphens only, in lower case. */
export const plainHost = (host: string) => (/^[a-z0-9.-]+$/i.test(host) ? host.toLowerCase() : undefined);
