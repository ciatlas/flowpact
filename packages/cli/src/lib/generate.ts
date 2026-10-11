/** `generate`: the contracts of every workflow and local action, written or previewed. */
import { resolve } from 'node:path';
import { nodeFileSystem } from '@flowpact/core';
import {
  analyze,
  type ContractChange,
  type ContractStatus,
  contractPatch,
  contractsInScope,
  planContracts,
  scopePlan,
  writeContracts,
} from '@flowpact/lint';
import { attempt, usage } from './errors';
import { bool, loadRegistry, type Session, stringList } from './session';
import { checkNotEmpty, checkTargets, protectedTrees } from './targets';

export interface GenerateOptions {
  /**
   * Workflows and actions whose contracts to write, relative to the root; the contracts that list them as a consumer
   * too. Default: all.
   */
  paths?: string[];
  /** Compute the changes without writing anything. */
  dryRun?: boolean;
  /** Write all contracts under this directory (relative to the working directory) instead of the repository. */
  out?: string;
}

export interface ContractEntry {
  /** The contract file, relative to the root. */
  file: string;
  status: ContractStatus;
  /** The workflow or action it describes (absent for an orphaned contract). */
  unit?: string;
  /** Set when the existing file could not be read as a contract. */
  invalid?: string;
  changes: ContractChange[];
}

export interface ContractGeneration {
  /** Whether any contract file is created, changed or removed. */
  drift: boolean;
  /** Breaking changes among them. */
  breaking: number;
  counts: Record<ContractStatus, number>;
  entries: ContractEntry[];
  /** Workflows and actions whose contracts were kept because their files have YAML syntax errors. */
  skipped: string[];
  /** Nothing was written: the `dryRun` option. */
  dryRun: boolean;
  /** The files written or removed, relative to the root (or to `out`); empty with `dryRun`. */
  written: string[];
  /** The changes as a patch for `git apply`, or undefined when nothing changes. */
  patch(): string | undefined;
}

export async function runGenerate(
  session: Session,
  options: GenerateOptions = {},
): Promise<ContractGeneration> {
  const paths = stringList('paths', options.paths) ?? [];
  if (options.out !== undefined && typeof options.out !== 'string') throw usage('out must be a string');
  const { root, loaded, logger } = session;
  const registry = await loadRegistry(session);
  const result = attempt(() =>
    analyze({
      root,
      config: loaded.config,
      ...(loaded.file ? { configFile: loaded.file } : {}),
      ...(loaded.text !== undefined ? { configText: loaded.text } : {}),
      ...(loaded.overrideLocs ? { overrideLocs: loaded.overrideLocs } : {}),
      logger,
      registry,
      paths,
      only: [],
      validateSchema: false,
    }),
  );
  checkTargets(result.project, paths, root);
  checkNotEmpty(result.summary, root);
  const all = logger.time('plan contracts', () => planContracts(result.index, nodeFileSystem(root)));
  // With paths: their contracts, and the contracts that list them as a consumer (what `check` with the same paths
  // compares); other contracts, orphans included, are left alone.
  const plan = result.project.targets.size > 0 ? scopePlan(all, contractsInScope(result.index)) : all;
  const out = options.out ? resolve(process.cwd(), options.out) : undefined;
  // Every target is checked before anything is written, so a refusal leaves the repository as it was.
  const dryRun = bool('dryRun', options.dryRun) ?? false;
  const written = dryRun ? [] : attempt(() => writeContracts(root, plan, out, protectedTrees(root)));
  return {
    drift: plan.drift,
    breaking: plan.breaking,
    counts: { ...plan.counts },
    entries: plan.entries.map((e) => ({
      file: e.file,
      status: e.status,
      ...(e.unit !== undefined ? { unit: e.unit } : {}),
      ...(e.invalid !== undefined ? { invalid: e.invalid } : {}),
      changes: e.changes,
    })),
    skipped: [...plan.skipped],
    dryRun,
    written,
    patch: () => (plan.drift ? contractPatch(plan) : undefined),
  };
}
