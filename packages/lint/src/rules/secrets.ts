import {
  type Binding,
  BUILTIN_SECRETS,
  type CallSite,
  type ContextResolver,
  calledFunctions,
  chainTo,
  definitelyFalsy,
  didYouMean,
  type EvalValue,
  type ExprSite,
  escapeControl,
  evaluateTemplate,
  type InputDecl,
  type JobDecl,
  known,
  type LocatedRef,
  lookup,
  needsSecret,
  readsContextDynamically,
  refsOf,
  type SecretDecl,
  secretsNeededBy,
  sym,
  UNKNOWN,
  type WorkflowDecl,
} from '@ciatlas/core';
import { interfaceCalls, isExternal } from '../remotes';
import { addKeys, renameAt, suggestion } from '../suggestions';
import { defineRule, type RuleContext, type RuleDefinition } from './types';
import { chainRelated, type Guard, guardOf, isWholeExpression, listNames, namesKey, quote } from './util';

const missingRequiredSecret = defineRule({
  code: 'FP201',
  name: 'missing-required-secret',
  category: 'secrets',
  defaultSeverity: 'error',
  docs: {
    summary: 'A reusable workflow is called without one of its required secrets.',
    why: 'GitHub fails the run when a required secret is not passed — but only when that call path actually executes.',
    fix: 'Pass the secret under `secrets:`, or use `secrets: inherit` if the callee should see all repository secrets.',
    examples: {
      bad: `uses: ./.github/workflows/deploy.yml
secrets:
  token: \${{ secrets.TOKEN }}
  # deploy.yml also requires "registry-password"`,
      good: `secrets:
  token: \${{ secrets.TOKEN }}
  registry-password: \${{ secrets.REGISTRY_PASSWORD }}`,
    },
  },
  check(ctx) {
    for (const call of interfaceCalls(ctx.index)) {
      if (call.job.secretsInherit) continue;
      for (const s of Object.values(call.callee.call?.secrets ?? {})) {
        if (!s.required || lookup(call.job.secrets, s.name)) continue;
        reportMissingSecret(ctx, call, s);
      }
    }
  },
});

/** FP201's report for a required secret a call does not pass. */
function reportMissingSecret(ctx: RuleContext, call: CallSite, s: SecretDecl): void {
  ctx.report({
    message: `jobs.${call.job.id} calls ${call.callee.path} without required secret ${quote(s.name)}`,
    loc: call.job.uses?.loc ?? call.job.loc,
    symbol: sym.secret(call.callee.path, s.name),
    related: [
      ...chainRelated(chainTo(ctx.index, call.caller.path)),
      ...(isExternal(call.callee) ? [] : [{ loc: s.loc, message: 'declared required here' }]),
    ],
    suggestions: [
      suggestion(`Add secret ${quote(s.name)} under secrets:`, [
        addKeys(
          ctx.index,
          call.caller.source.path,
          ['jobs', call.job.id, 'secrets'],
          [s.name],
          ['with', 'uses'],
        ),
      ]),
    ],
  });
}

const unknownSecret = defineRule({
  code: 'FP202',
  name: 'unknown-secret',
  category: 'secrets',
  defaultSeverity: 'error',
  docs: {
    summary: 'A caller passes a secret the reusable workflow does not declare.',
    why: 'GitHub rejects the call ("Invalid secret … is not defined in the referenced workflow").',
    fix: 'Declare the secret under `on.workflow_call.secrets` in the callee, fix the name, or remove it.',
    examples: {
      bad: `jobs:
  deploy:
    uses: ./.github/workflows/deploy.yml   # declares the secret deploy-token
    secrets:
      deploy_token: \${{ secrets.DEPLOY_TOKEN }}`,
      good: `    secrets:
      deploy-token: \${{ secrets.DEPLOY_TOKEN }}`,
    },
  },
  check(ctx) {
    for (const call of interfaceCalls(ctx.index)) {
      const declared = call.callee.call?.secrets ?? {};
      for (const b of Object.values(call.job.secrets))
        if (!lookup(declared, b.name)) reportUnknownSecret(ctx, call, b, Object.keys(declared));
    }
  },
});

/** FP202 for a secret a call passes that its callee does not declare (`declared`). */
function reportUnknownSecret(ctx: RuleContext, call: CallSite, b: Binding, declared: string[]): void {
  const guess = didYouMean(b.name, declared);
  const remote = isExternal(call.callee);
  const where = call.callee.call && !remote ? call.callee.call.loc : undefined;
  ctx.report({
    message: `${call.callee.path} has no secret ${quote(b.name)}${guess ? ` — did you mean ${quote(guess)}?` : ''}`,
    loc: b.loc,
    symbol: sym.secret(call.callee.path, b.name),
    suggestions: [guess ? renameAt(ctx.index, b.loc, b.name, guess) : undefined],
    // The rule's own fix says to declare the secret in the callee, which the caller of a remote one cannot do.
    ...(remote && !guess
      ? { fix: `Remove ${quote(b.name)} from \`secrets:\`: ${call.callee.path} does not declare it.` }
      : {}),
    related: where ? [{ loc: where, message: `declared secrets: ${listNames(declared)}` }] : [],
  });
}

const unusedSecret = defineRule({
  code: 'FP203',
  name: 'unused-secret',
  category: 'secrets',
  defaultSeverity: 'warning',
  generatedFiles: 'skip',
  docs: {
    summary: 'A `workflow_call` secret is declared but never read.',
    why: 'Every caller must still wire the secret, widening its exposure for nothing.',
    fix: 'Remove the declaration and the callers’ `secrets:` bindings, or use the secret where intended.',
    scope:
      'A secret counts as read when the workflow reads it by name or reads the whole `secrets` context ' +
      '(`toJSON(secrets)`, `secrets.*`, `secrets[inputs.name]`), or hands every secret through `secrets: inherit` to a ' +
      'callee that reads it by name or reads every secret it gets, itself or further down. An expression that does ' +
      'not parse, and a callee flowpact cannot read (a remote workflow, or a local one that is missing or not ' +
      'reusable), may read any secret, so they count as reading every secret.',
    examples: {
      bad: `on:
  workflow_call:
    secrets:
      npm_token:
        required: true   # nothing below reads it
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test`,
      good: `jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: \${{ secrets.npm_token }}`,
    },
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      if (!wf.call) continue;
      if (readsContextDynamically(wf, 'secrets')) continue;
      // Also forwarded implicitly through `secrets: inherit` to callees that read it, or may read any secret.
      const needed = secretsNeededBy(ctx.index, wf);
      for (const s of Object.values(wf.call.secrets)) {
        if (ctx.index.usagesOf(sym.secret(wf.path, s.name)).length > 0) continue;
        if (needsSecret(needed, s.name)) continue;
        ctx.report({
          message: `Secret ${quote(s.name)} of ${wf.path} is never read`,
          loc: s.loc,
          symbol: sym.secret(wf.path, s.name),
        });
      }
    }
  },
});

const secretsInherit = defineRule({
  code: 'FP204',
  name: 'secrets-inherit',
  category: 'secrets',
  defaultSeverity: 'info',
  generatedFiles: 'skip',
  docs: {
    summary:
      '`secrets: inherit` hands every repository secret to the callee; flowpact lists what is actually needed.',
    why:
      'Inherit makes the secret flow invisible: nobody can tell from the caller which secrets reach which job, and every ' +
      'nested workflow gets all of them.',
    fix: 'Replace `secrets: inherit` with an explicit `secrets:` mapping of the secrets listed in the message.',
    scope:
      'Not reported when the callee, or a callee it hands every secret to, reads the whole `secrets` context ' +
      '(`toJSON(secrets)`, `secrets.*`, `secrets[inputs.name]`), has an expression that does not parse, or hands every ' +
      'secret on to a workflow flowpact cannot read (a remote workflow, or a local one that is missing or not ' +
      'reusable): it then reads, or may read, every secret the caller has, which no explicit mapping can list.',
    examples: {
      bad: `uses: ./.github/workflows/deploy.yml
secrets: inherit`,
      good: `uses: ./.github/workflows/deploy.yml
secrets:
  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}`,
    },
  },
  check(ctx) {
    for (const call of ctx.index.callSites) {
      if (!call.job.secretsInherit) continue;
      const reads = secretsNeededBy(ctx.index, call.callee);
      if (reads.all) continue;
      const needed = [...reads.names].sort();
      ctx.report({
        message: `jobs.${call.job.id} inherits all secrets; ${call.callee.path} and its callees read ${needed.length ? listNames(needed, 10) : 'none'}`,
        loc: call.job.secretsLoc ?? call.job.loc,
        symbol: `${call.caller.path}#jobs.${call.job.id}.secrets`,
        fix: needed.length
          ? `Replace with:\nsecrets:\n${needed.map((n) => `  ${escapeControl(n)}: \${{ secrets.${escapeControl(n)} }}`).join('\n')}`
          : 'Remove `secrets: inherit`; the callee reads no secrets.',
        // The snippet's own line breaks are kept; the names are escaped (`secrets['…']` can hold any string).
        fixMultiline: true,
      });
    }
  },
});

const undeclaredSecretRef = defineRule({
  code: 'FP205',
  name: 'undeclared-secret-ref',
  category: 'secrets',
  defaultSeverity: 'error',
  docs: {
    summary:
      'A reusable workflow reads a secret it does not declare, and some caller does not use `secrets: inherit`.',
    why:
      'Inside a called workflow only declared (or inherited) secrets exist. Reading anything else yields an empty string, ' +
      'so authentication steps fail late or, worse, fall back to anonymous access.',
    fix:
      'Declare the secret under `on.workflow_call.secrets` and pass it from every caller, or use `secrets: inherit`. ' +
      "Callers whose `with:` values make the reading job's or step's `if:` false (e.g. an omitted input in " +
      "`if: contains(inputs.registries, 'docker.io')`) are not counted: the read never runs for them. Neither are reads " +
      'under an `if:` that is always false (`if: false`). For a remote reusable workflow, which you cannot change: call ' +
      'it with `secrets: inherit` (it passes secrets within one organization or enterprise), ask its maintainers to ' +
      'declare the secret, or add an override.',
    scope:
      'Reads where GitHub allows no `secrets` (an input default, a `workflow_call` output, `jobs.<id>.with`, `if` or ' +
      '`name`) are refused rather than empty, and not reported. For a remote reusable workflow, the secrets come from the ' +
      'remote interfaces lockfile, which `flowpact remotes update` fills only with reads that run on every call: none ' +
      'under an `if:` (on the step, the job, or a job it needs), none in a condition. A secret the call passes by name is ' +
      'left to FP202.',
    examples: {
      bad: `on:
  workflow_call: {}   # declares no secrets
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}   # empty unless the caller uses secrets: inherit`,
      good: `on:
  workflow_call:
    secrets:
      DEPLOY_TOKEN:
        required: true   # and every caller passes it`,
    },
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      if (!wf.call) continue;
      const strictCallers = ctx.index.callersOf(wf.path).filter((c) => !c.job.secretsInherit);
      if (strictCallers.length === 0) continue;
      const resolvers = new Map(strictCallers.map((c) => [c, callerInputsResolver(wf, c)]));
      for (const { site, ref } of refsOf(wf)) {
        const name = undeclaredSecretRead(wf.call.secrets, ref, site);
        if (!name) continue;
        // A caller whose inputs make the job's or step's `if:` false never runs the read.
        const guards = guardsOf(wf, site);
        const reached = strictCallers.filter((c) => !guards.some((g) => isFalse(g, resolvers.get(c)!)));
        if (reached.length > 0) reportUndeclaredSecret(ctx, wf, ref, name, reached);
      }
    }
    checkRemoteCalls(ctx);
  },
});

/** The secrets a remote reusable workflow reads without declaring them, empty in a call without `secrets: inherit`. */
function emptyInCall(ctx: RuleContext, call: CallSite): string[] {
  if (!isExternal(call.callee) || call.job.secretsInherit) return [];
  // A name the call passes is FP202's: GitHub refuses it outright.
  const read = ctx.remotes?.lock?.remotes[call.callee.path]?.undeclaredSecrets ?? [];
  return read.filter((name) => !lookup(call.job.secrets, name));
}

/**
 * FP205 for a call of a remote reusable workflow without `secrets: inherit`: the secrets its lockfile entry says it
 * reads without declaring are empty in the call (GitHub refuses them by name, see FP202).
 */
function checkRemoteCalls(ctx: RuleContext): void {
  for (const call of interfaceCalls(ctx.index)) {
    for (const name of emptyInCall(ctx, call)) {
      ctx.report({
        message: `jobs.${call.job.id} calls ${call.callee.path}, which reads secrets.${name} without declaring it — it is empty unless the call uses \`secrets: inherit\` (from the same organization or enterprise)`,
        loc: call.job.uses?.loc ?? call.job.loc,
        symbol: sym.secret(call.callee.path, name),
        related: chainRelated(chainTo(ctx.index, call.caller.path)),
      });
    }
  }
}

/**
 * The secrets a reusable workflow reads by name without declaring them, at reads that run on every call: none under a
 * condition (see `runsOnEveryCall`), and none in a condition itself, which checks the secret rather than uses it. Only
 * `secrets: inherit` gives them to it. For the remote interfaces lockfile, which keeps no body to judge a caller against
 * (see FP205); nothing for a file that cannot be called.
 */
export function undeclaredSecretsRead(wf: WorkflowDecl): string[] {
  if (!wf.call) return [];
  const out = new Map<string, string>();
  for (const { site, ref } of refsOf(wf)) {
    const name = undeclaredSecretRead(wf.call.secrets, ref, site);
    if (!name || out.has(name.toLowerCase()) || site.isCondition || !runsOnEveryCall(wf, site)) continue;
    out.set(name.toLowerCase(), name);
  }
  return [...out.values()].sort();
}

/**
 * Whether a site runs on every call: neither its step nor its job has a condition, nor any job its job needs (unless its
 * own `if:` calls a status function, so it runs whatever those jobs did). A condition on the caller's inputs or event,
 * a matrix, an env value or a secret may each leave it out.
 */
function runsOnEveryCall(wf: WorkflowDecl, site: ExprSite): boolean {
  const job = site.job !== undefined ? wf.jobs[site.job] : undefined;
  const step = job && site.step !== undefined ? job.steps[site.step] : undefined;
  return !(step && hasCondition(step)) && !(job && jobMayBeSkipped(wf, job, new Set()));
}

/** Whether an `if:` is a real condition: `if: false`, or one that reads a context (status functions alone are not). */
const hasCondition = (d: { ifValue?: boolean; ifSite?: ExprSite }) =>
  d.ifValue === false || !!d.ifSite?.segments.some((s) => s.refs.length);

/** Whether a job may be skipped: its own condition, or one of a job it needs when its `if:` calls no status function. */
function jobMayBeSkipped(wf: WorkflowDecl, job: JobDecl, seen: Set<string>): boolean {
  if (seen.has(job.id)) return false;
  seen.add(job.id);
  if (hasCondition(job)) return true;
  if (job.ifSite?.segments.some((s) => calledFunctions(s.expr).length)) return false;
  return job.needs.some((n) => {
    const needed = wf.jobs[n.id];
    return needed !== undefined && jobMayBeSkipped(wf, needed, seen);
  });
}

/** Where GitHub allows no `secrets` context: a read there is refused, not empty, so FP205 does not judge it. */
const SECRETS_UNAVAILABLE: ReadonlySet<ExprSite['field']> = new Set([
  'input.default',
  'workflow.output',
  'job.if',
  'job.name',
  'job.with',
  'job.strategy',
]);

/** The secret a reference reads, when it is neither one of GitHub's own nor declared in `declared`. */
function undeclaredSecretRead(
  declared: Record<string, SecretDecl>,
  ref: LocatedRef,
  site: ExprSite,
): string | undefined {
  const name = ref.path[0];
  if (ref.context !== 'secrets' || !namesKey(name) || SECRETS_UNAVAILABLE.has(site.field)) return undefined;
  if (BUILTIN_SECRETS.has(name.toLowerCase()) || lookup(declared, name)) return undefined;
  return name;
}

/** FP205's report, naming the callers (`reached`) that run the read without `secrets: inherit`. */
function reportUndeclaredSecret(
  ctx: RuleContext,
  wf: WorkflowDecl,
  ref: LocatedRef,
  name: string,
  reached: CallSite[],
): void {
  ctx.report({
    message: `${wf.path} reads secrets.${name}, which is not declared — it is empty when called from ${reached.length} caller${reached.length > 1 ? 's' : ''} without \`secrets: inherit\``,
    loc: ref.loc,
    symbol: sym.secret(wf.path, name),
    related: reached.slice(0, 3).map((c) => ({
      loc: c.job.uses?.loc ?? c.job.loc,
      message: `${c.caller.path} › jobs.${c.job.id} passes explicit secrets`,
    })),
  });
}

/**
 * The called workflow's `inputs` as one caller sets them: literal `with:` values, and for omitted inputs the default
 * (or `false`, `0`, `''` by type, as GitHub does). Values computed from expressions at runtime stay unknown.
 */
function callerInputsResolver(callee: WorkflowDecl, call: CallSite): ContextResolver {
  return ({ context, path }) => {
    if (context !== 'inputs') return undefined;
    if (path.length !== 1 || !path[0]) return UNKNOWN;
    const decl = lookup(callee.call?.inputs ?? {}, path[0]);
    return decl ? callerInputValue(decl, call) : UNKNOWN;
  };
}

/** A declared input's value as one caller sets it: the `with:` value it passes, else the value when omitted. */
function callerInputValue(decl: InputDecl, call: CallSite): EvalValue {
  const b = lookup(call.job.with, decl.name);
  if (b) return b.site ? evaluateTemplate(b.site.text, () => undefined) : known(b.value);
  return omittedInputValue(decl);
}

/** An omitted input's value: its default (unknown when an expression), else `false`, `0` or `''` by type. */
function omittedInputValue(decl: InputDecl): EvalValue {
  if (decl.hasDefault) {
    const d = decl.default ?? null;
    return typeof d === 'string' && d.includes('${{') ? UNKNOWN : known(d);
  }
  return known(decl.type === 'boolean' ? false : decl.type === 'number' ? 0 : '');
}

/** The guards that decide whether a site in a job or step is evaluated: `if:` sites, or `false` for a literal `if: false`. */
function guardsOf(wf: WorkflowDecl, site: ExprSite): Guard[] {
  const job = site.job !== undefined ? wf.jobs[site.job] : undefined;
  const step = job && site.step !== undefined ? job.steps[site.step] : undefined;
  return [job && guardOf(job), step && guardOf(step)].filter(
    (g): g is Guard => g !== undefined && g !== site,
  );
}

/** True when a condition is false whatever the runtime-only parts evaluate to. */
function isFalse(guard: Guard, resolve: ContextResolver): boolean {
  if (guard === false) return true;
  const ast = isWholeExpression(guard) ? guard.segments[0]!.expr.ast : undefined;
  return ast !== undefined && definitelyFalsy(ast, resolve);
}

export const secretRules: RuleDefinition[] = [
  missingRequiredSecret,
  unknownSecret,
  unusedSecret,
  secretsInherit,
  undeclaredSecretRef,
];
