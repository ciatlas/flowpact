<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/wordmark-dark.svg">
    <img alt="flowpact" src="assets/brand/wordmark.svg" height="56">
  </picture>
</h1>

<p align="center">Find the GitHub Actions values that arrive empty while the run stays green.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=flowpact.vscode-flowpact"><b>VS Code extension</b></a> ·
  <a href="https://open-vsx.org/extension/flowpact/vscode-flowpact">Open VSX</a> ·
  <a href="https://github.com/marketplace/actions/flowpact">GitHub Action</a> ·
  <a href="https://www.npmjs.com/package/flowpact">npm</a> ·
  <a href="https://ciatlas.github.io/flowpact">Docs</a>
</p>

[![CI](https://github.com/ciatlas/flowpact/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ciatlas/flowpact/actions/workflows/ci.yml)
[![Release](https://github.com/ciatlas/flowpact/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/ciatlas/flowpact/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/flowpact?logo=npm)](https://www.npmjs.com/package/flowpact)
[![Node.js](https://img.shields.io/node/v/flowpact?logo=nodedotjs)](https://www.npmjs.com/package/flowpact)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/ciatlas/flowpact/badge)](https://scorecard.dev/viewer/?uri=github.com/ciatlas/flowpact)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15403/badge)](https://www.bestpractices.dev/projects/15403)
[![License: MIT](https://img.shields.io/github/license/ciatlas/flowpact)](LICENSE)

**Data-flow linter for GitHub Actions.**

GitHub Actions evaluates a missing matrix key, an undeclared secret or an optional input without a default to an empty
value: no error, no warning, a green run. When workflows call reusable workflows and local actions, that is how a test variant
or an upload stops running without anyone noticing. flowpact follows every input, secret, env var, matrix key and
output across those calls, evaluates every combination of the matrices written in your workflows, and reports where a
value goes missing. It runs as a CLI, a GitHub Action and a VS Code extension, and complements actionlint.

![flowpact lint reporting a matrix combination that passes an empty input](apps/docs/public/screenshots/lint-incident.svg)

*The incident that started flowpact: one matrix entry had no `config`, so that test variant never ran. actionlint
reports nothing here.*

## Is this for me?

- **You call reusable workflows or local actions:** flowpact finds inputs callers do not pass, secrets that are never
  declared, and matrix values that are empty in some combinations.
- **You publish actions or reusable workflows that other repositories use,** in public or inside your organization:
  contracts show interface changes in review and mark the breaking ones, and impact mode fails a pull request whose
  title declares less than the minor or major release its changes need
  ([how](#for-publishers-of-actions-and-reusable-workflows)).
- **You edit workflows in VS Code:** the same findings as you type, with the
  [extension](https://marketplace.visualstudio.com/items?itemName=flowpact.vscode-flowpact).

It adds little to a few standalone workflows. Calls to reusable workflows in other repositories are reported as
unverified, not checked (cross-repository resolution is on the [roadmap](https://ciatlas.github.io/flowpact/docs/roadmap));
the repository that publishes them can still lint them and lock their interfaces with contracts.

## Get started

```sh
npx flowpact lint                       # lint .github/workflows and local actions
npx flowpact explain FP401              # why does this matter, how do I fix it?
npx flowpact trace pipeline.yml:config  # where does this input go?
```

In CI, add the action; it lints by default and annotates the pull request:

```yaml
- uses: actions/checkout@v7
- uses: ciatlas/flowpact@v0.12
```

Findings you accept go into `.github/flowpact/flowpact.config.yml` as **overrides** with a reason, an owner and an
expiry date; expired overrides bring the findings back.

📖 **Docs:** https://ciatlas.github.io/flowpact — getting started, how it works, the CLI (`generate`, `check`,
`graph`, `lsp`), CI and action usage, contracts, impact mode, configuration, and a page for every rule.

## What it finds that other tools miss

| Problem | actionlint | flowpact |
| --- | --- | --- |
| One matrix `include` entry lacks a key that is passed to a reusable workflow or action | — | `FP401`, naming the combination |
| An optional input with no default is left out, so a step is skipped or a required input further down is empty | — | `FP105`, `FP107` |
| A reusable workflow that declares no secrets reads one, and a caller does not use `secrets: inherit` | — | `FP205` |
| A step runs `./.github/actions/...` after checking the repository out into a subdirectory | — | `FP606` |
| A published workflow removes an output or renames a job, which can break consumers in other repositories | — | `FP803` (against the committed contracts), `FP810` (impact mode, against the base commit) |

In a large public repository, flowpact found the third case: a reusable workflow that reads `secrets.CODECOV_TOKEN`
while declaring no secrets, called from 31 places and none with `secrets: inherit`, so the token is always empty.

Both tools report a missing or unknown input on a direct call to a local reusable workflow or action, and actionlint
also checks shell scripts, runner labels, expression types, cron schedules and the inputs of popular actions such as
`actions/checkout`. Use flowpact next to it, and zizmor for security. The
[comparison](https://ciatlas.github.io/flowpact/docs/comparison) shows both tools' output side by side.

## For publishers of actions and reusable workflows

Other repositories pin your action or reusable workflow to a tag such as `@v1`, and you cannot see their workflows or
their branch protection. Remove an output and their steps read an empty value; rename a job in a reusable workflow and
their required check waits on *Expected — Waiting for status to be reported*. Nothing fails in your repository, and neither actionlint nor
GitHub's Actions extension reports either change. flowpact puts both in the pull request:

1. **Commit the contracts.** `npx flowpact generate` writes one contract per workflow and per action in the repository
   (the root `action.yml` included) into `.github/flowpact/`: its inputs, secrets and outputs, what it calls and which
   workflows in this repository call it. Contracts are deterministic (no hashes or timestamps), so a pull request that
   changes an interface also changes a contract, and reviewers see a small YAML diff.
2. **Check every pull request.** `npx flowpact check`, or the action with `mode: check`, fails until the contracts match the
   workflows again and marks **breaking** changes, such as a removed output or a new required input. The action's job
   summary lists every change, breaking ones in bold, and the action uploads the regenerated contracts as a patch that
   contributors without Node.js can apply with `git apply`.

   ![flowpact check reporting a breaking change, an outdated contract and an orphaned contract](apps/docs/public/screenshots/check-drift.svg)

3. **Grade the release.** With `impact: auto`, the action compares each pull request with its base and grades what
   consumers can see as major, minor, patch or none: a renamed job or a removed output is major, a new optional input
   minor. It fails the pull request when its changes need a minor or major release and its Conventional Commits title
   declares less (`fix:` patch, `feat:` minor, `feat!:` major). When pull requests are squash-merged with the title as
   the commit message (*Default commit message: Pull request title* in the repository settings; GitHub's default uses
   the commit's own title when a pull request has one commit), release tools such as release-please read that title,
   so the release they cut is no smaller than the change needs. Labels can declare the impact instead, and release pull
   requests are compared with the last release tag.

   ![flowpact impact failing a pull request titled "fix: tidy the test job" with FP810: a removed output and a renamed job require a major release](apps/docs/public/screenshots/impact.svg)

```yaml
on:
  pull_request:
    # edited / labeled: re-check when the title or the labels change
    types: [opened, edited, synchronize, reopened, labeled, unlabeled]

jobs:
  flowpact:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - uses: ciatlas/flowpact@v0.12
        with:
          mode: check   # lint, and compare with the committed contracts
          impact: auto  # grade the change against the pull request title
```

See [contracts](https://ciatlas.github.io/flowpact/docs/contracts) and
[impact mode](https://ciatlas.github.io/flowpact/docs/impact-mode).

## In your editor

The [VS Code extension](https://marketplace.visualstudio.com/items?itemName=flowpact.vscode-flowpact) (also on
[Open VSX](https://open-vsx.org/extension/flowpact/vscode-flowpact)) reports the same findings as you type, traces
inputs, secrets and outputs on hover, and goes to definitions and references across workflow calls. Other editors can
use the language server, `flowpact lsp` ([editors](https://ciatlas.github.io/flowpact/docs/editors)).

![VS Code showing a finding as you type: the windows matrix entry passes an empty config to a reusable workflow](apps/docs/public/screenshots/editor-diagnostics.png)

## Status

Shipped: the engine, 51 rules, contracts (`flowpact generate` / `flowpact check`), overrides with reason and expiry, plugins,
the CLI (pretty, JSON, Markdown and SARIF output; `flowpact graph`), the GitHub Action, a language server and the
[VS Code extension](https://marketplace.visualstudio.com/items?itemName=flowpact.vscode-flowpact) (diagnostics as you
type, hover traces, go to definition across workflow calls; also on
[Open VSX](https://open-vsx.org/extension/flowpact/vscode-flowpact)). Next: quick fixes in the editor, then
cross-repository resolution — see the [roadmap](https://ciatlas.github.io/flowpact/docs/roadmap).

## Feedback and contributing

Report bugs and ask for features in [GitHub Issues](https://github.com/ciatlas/flowpact/issues); report
vulnerabilities privately, as the [security policy](SECURITY.md) explains. To contribute, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
