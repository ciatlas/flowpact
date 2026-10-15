/**
 * GitHub's workflow dependency lockfile, `.github/workflows/actions.lock` (written by `gh actions-lock`, Dependabot and
 * Renovate): the commit each `owner/repo@ref` runs in the workflows it covers, whatever the tag or branch points at now.
 * flowpact checks a remote reference at the commit that runs, so it reads that commit from there; it never writes the
 * file. The schema is before 1.0 (v0.0.3 when this was written): it is read tolerantly, and a version it does not know
 * is not used.
 */
import type { FileSystem } from '@ciatlas/core';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/mini';
import type { RemoteRef } from './remotes';
import './zod';

export const ACTIONS_LOCK_FILE = '.github/workflows/actions.lock';

// Loose objects: a key a later schema adds is ignored. `commit` is checked per entry (see `commitOfPin`).
const actionsLockSchema = z.looseObject({
  version: z.string(),
  /** Each covered workflow's file, with the pins (`owner/repo@ref`) it uses, its actions' own included. */
  workflows: z.optional(z.record(z.string(), z.array(z.string()))),
  dependencies: z.optional(z.record(z.string(), z.looseObject({ commit: z.optional(z.string()) }))),
});

/** The schema versions read: v0.0.1 to v0.0.3 so far, which differ in keys this reader does not use. */
const KNOWN_VERSION = /^v0\.0\.\d+$/;

export interface ActionsLockRead {
  /** The file, when it exists. */
  file?: string;
  /** The commit each pin runs (by `pinKey`), for the pins a covered workflow uses. */
  commits?: Map<string, string>;
  /** Why the file is not used: it does not parse, or has a version flowpact does not know. */
  error?: string;
}

/** A pin as `actions.lock` keys it: owner and repository (matched in any case) and the ref, without a path. */
const pinKey = (owner: string, repo: string, ref: string) =>
  `${owner.toLowerCase()}/${repo.toLowerCase()}@${ref}`;

/** A pin key from the file, as `pinKey` writes it; undefined for a key that is no `owner/repo@ref`. */
function keyOf(pin: string): string | undefined {
  const m = /^([^/@:]+)\/([^/@:]+)@([^:]+)$/.exec(pin);
  return m ? pinKey(m[1]!, m[2]!, m[3]!) : undefined;
}

/** A dependency's commit without its algorithm (`sha1-<40 hex>`); undefined for another form. */
const commitOfPin = (commit: string | undefined) => /^sha1-([0-9a-f]{40})$/.exec(commit ?? '')?.[1];

/** The commits `actions.lock` pins for the workflows it covers; nothing without the file. */
export function readActionsLock(fs: FileSystem): ActionsLockRead {
  const text = fs.read(ACTIONS_LOCK_FILE);
  if (text === undefined) return {};
  const file = ACTIONS_LOCK_FILE;
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (e) {
    return { file, error: `not valid YAML: ${(e as Error).message.split('\n')[0]}` };
  }
  const parsed = actionsLockSchema.safeParse(data);
  if (!parsed.success) return { file, error: 'not a workflow dependency lockfile flowpact can read' };
  const { version, workflows = {}, dependencies = {} } = parsed.data;
  if (!KNOWN_VERSION.test(version))
    return { file, error: `version ${version} is not one flowpact reads (v0.0.x)` };
  // Only a covered workflow runs the pinned commit; elsewhere the ref resolves as usual.
  const covered = new Set(Object.values(workflows).flatMap((pins) => pins.map(keyOf)));
  const commits = new Map<string, string>();
  for (const [pin, dep] of Object.entries(dependencies)) {
    const key = keyOf(pin);
    const commit = commitOfPin(dep.commit);
    if (key && commit && covered.has(key)) commits.set(key, commit);
  }
  return { file, commits };
}

/**
 * The commit `actions.lock` runs for a remote reference, or undefined when it pins none. A reference with a path
 * (`octo/ship/.github/workflows/deploy.yml@v1`, `actions/cache/restore@v4`) is pinned by its repository's key.
 */
export const lockedCommit = (
  read: ActionsLockRead | undefined,
  r: Pick<RemoteRef, 'owner' | 'repo' | 'ref'>,
) => read?.commits?.get(pinKey(r.owner, r.repo, r.ref));
