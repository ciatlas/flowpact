# Contributing

## Setup

Node.js 22 or later and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```sh
pnpm install
pnpm build        # bundles the CLI and the GitHub Action
pnpm test         # unit, property and end-to-end tests
pnpm lint         # Biome
pnpm typecheck
pnpm docs:gen     # regenerate rule pages and JSON schemas after changing a rule or schema
pnpm coverage     # tests with coverage thresholds (core and lint ≥ 90 % lines)
pnpm docs:dev     # docs site with generated rule pages
pnpm docs:screenshots                      # terminal screenshots from real CLI output
pnpm --filter vscode-flowpact screenshots  # editor screenshots in a real VS Code (after pnpm build; opens windows)
```

`packages/action/dist` is committed (GitHub runs the action from it). Rebuild it with `pnpm build` and commit the
result whenever `packages/core`, `packages/lint`, `packages/reporters` or `packages/action` change; CI fails otherwise.

## Repository layout

| Path | What |
| --- | --- |
| `packages/core` | Workflow model: YAML → IR → expressions → graph → matrix expansion. No rules: it is the foundation flowpact's checks are built on |
| `packages/lint` | flowpact's checks on the model: rules, config, contracts, impact mode, plugins, the JSON report and trace |
| `packages/reporters` | Terminal (pretty), JSON, Markdown, SARIF, trace, graph and contract renderers |
| `packages/cli` | The `flowpact` command and the API (published as `flowpact`): `src/lib` implements each command once, `src/api.ts` exports it as a function and `src/commands` prints it; the API's types are hand-written in `api.d.ts` |
| `packages/action` | The GitHub Action (`action.yml` at the root runs `packages/action/dist/index.js`): job summary, annotations, SARIF, contract patch artifact |
| `packages/language-server` | The language server (`flowpact lsp`): diagnostics, hover, definitions and references |
| `packages/vscode` | The VS Code extension, bundling the language server |
| `apps/docs` | Fumadocs site, deployed to GitHub Pages |
| `fixtures/` | Small repositories used by tests, screenshots and docs |
| `scripts/` | Rule-doc, schema and screenshot generators; link checker |

`packages/lint/src/location.json` says where flowpact lives: its repository and its docs URL. The docs and schema
URLs flowpact prints, `scripts/sync-version-refs.mjs` (action references) and `scripts/check-pack.mjs` (npm's
`repository.url`) all read it. When flowpact moves, change it and add the old values to
`scripts/previous-locations.json`: `scripts/test/location.test.ts` then lists every file that still names the old
location, and the sync script moves the action references.

Rule pages under `apps/docs/content/docs/rules/` are generated from the rule definitions (`pnpm docs:gen`); a test
fails when they are out of date.

## Pull requests

`main` is protected: changes land through pull requests that pass the **CI passed** and **Conventional PR title**
checks, are approved by a code owner (`.github/CODEOWNERS`), and are squash-merged. GitHub does not let authors
approve their own pull requests, so repository admins may merge their own without the approval (the `main reviews`
ruleset); the checks still apply to everyone (the `main` ruleset). **CI passed** sums up every CI job — tests on Node 22 and 24, the docs build, smoke
tests of the packed CLI on Linux, macOS and Windows, and the GitHub Action on this repository and on fixtures. New
checks are added as jobs to `.github/workflows/ci.yml` and listed under the `ci-passed` job's `needs`.

The branch and tag rules live in the repository, not only in the settings UI: `.github/rulesets/*.json` (GitHub's
ruleset export format) and `.github/repository.json` (merge settings). A pull request that changes them shows the
difference from the live settings (**Settings diff**); merging applies them, and a weekly run reverts changes made in
the UI. Release tags (`v*`) can only be created or moved by the release bot and repository admins.

Dependencies are updated by Renovate (`renovate.json`) with Conventional Commit titles. When a runtime dependency
changes, the release bot rebuilds the committed action bundle on the Renovate branch. Non-major updates (except 0.x
minors) merge themselves once every required check passes: Renovate may skip the code owner review, not the checks.
Nothing reaches users that way — a dependency fix only updates the release pull request, which needs approval. Actions
are pinned to commit SHAs, with the version in a comment.

## Commit messages

Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`. The
title is the whole squashed commit on `main` (the description is not copied), and release-please reads only those.
Retitle GitHub's `Revert "…"` pull requests as `revert: …`.

| Type | Use for | Release |
| --- | --- | --- |
| `feat` | a new rule, option or command | minor |
| `fix` | a bug fix, including false positives and negatives | patch |
| `perf` | a faster analysis | patch |
| `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `style` | everything else | none |

Mark a breaking change with `!` (`feat(config)!: …`) or a `BREAKING CHANGE:` footer. Before 1.0 a breaking change
bumps the minor version. Useful scopes: `core`, `lint`, `rules`, `contracts`, `config`, `cli`, `action`, `reporters`, `docs`.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please), acting as the
`ciatlas-release-bot` GitHub App (so its pull requests and tags run the usual workflows). Its client id and private
key are the `ciatlas` organization variable `RELEASE_BOT_CLIENT_ID` and secret `RELEASE_BOT_PRIVATE_KEY`. To rotate
the key, generate a new one (the app's **Credentials → Key pairs**), update the secret, run a workflow that uses it,
then delete the old key; the app accepts both until then.

1. Every push to `main` updates a **release pull request** that bumps the version in every package, rebuilds the
   action bundle, moves the version references in the docs and READMEs to the new release line
   (`scripts/sync-version-refs.mjs`) and adds the changelog entry from the commits since the last release.
2. Merging it tags the release (`vX.Y.Z`) and creates the GitHub release as a **draft**
   (`release-please-config.json`: `draft`, `force-tag-creation`).
3. The release workflow then publishes `flowpact` to npm with provenance through npm trusted publishing (no
   token; only the very first publish of a new package name needs a short-lived `NPM_TOKEN` secret, because a trusted
   publisher can be configured only once the package exists), and smoke-tests the published package on Linux, macOS
   and Windows.

4. For stable releases it also packages the VS Code extension, smoke-tests the package in VS Code, attaches the
   signed `.vsix` to the GitHub release, and publishes that file to the registries set up below.
5. It attaches the signed assets to the draft: the npm tarball, the `.vsix` and the action archive
   (`flowpact-action-X.Y.Z.tar.gz`: `action.yml`, the bundle and the license, built reproducibly by
   `scripts/action-archive.sh`), each with its Sigstore bundle and in-toto provenance, and a CycloneDX SBOM of each,
   attested against it. Only when every one of them is on the release does it publish the release (a failed extension
   build keeps it a draft too), and only after that does it move the floating tag used by
   `uses: ciatlas/flowpact@v0.12` (before 1.0 one tag per minor line, because a 0.x minor may be breaking; from 1.0
   the major, `v1`). **Immutable releases** are enabled in the repository settings (since 0.9.0 went out), so a
   published release's tag and assets cannot change, and what a mirror verified stays what was released.

If publishing fails after the tag exists, run the **Release** workflow manually with that tag, or re-run the failed
jobs: assets already attached with their signature bundle and provenance are kept, the missing ones are added (an asset
whose upload stopped halfway is replaced), the release stays a draft until every asset is attached, and versions already
on npm, the Marketplace or Open VSX are skipped. A published release is never changed, so the same run can publish an
old release to a registry that was set up after it went out without touching its assets.

### Publishing the VS Code extension (one-time setup)

The extension's id is `<publisher>.vscode-flowpact`, with `publisher` from `packages/vscode/package.json`. The
publisher id must be the same on both registries and can never be renamed. Neither registry stores a long-lived token
in this repository.

**Visual Studio Marketplace** (Microsoft Entra ID; the Azure DevOps tokens the Marketplace used before stop working
on 2026-12-01):

1. Sign in at <https://marketplace.visualstudio.com/manage> and create the publisher.
2. Create a managed identity that this repository's `vscode-marketplace` environment can sign in as. It needs an
   Azure subscription that stays active: a pay-as-you-go one. A free account's trial subscription is disabled after
   30 days and later deleted together with the identity, unless it is upgraded. The identity itself costs nothing; a
   budget alert at $0 makes sure of that. In [Azure Cloud Shell](https://shell.azure.com) (Bash):

   ```bash
   # New subscriptions cannot create resources in some busy regions (West Europe, East US): if Azure answers
   # "The selected region is currently not accepting new customers", pick another one. The region does not matter.
   az group create --name flowpact-publishing --location swedencentral
   az identity create --name flowpact-marketplace --resource-group flowpact-publishing --location swedencentral
   # GitHub names this repository's jobs by owner and repository id (immutable subjects); the subject must match
   # exactly. `gh api repos/ciatlas/flowpact/actions/oidc/customization/sub` shows the prefix.
   az identity federated-credential create --name github-release --identity-name flowpact-marketplace \
     --resource-group flowpact-publishing --issuer https://token.actions.githubusercontent.com \
     --subject 'repo:ciatlas@340914892/flowpact@1408943843:environment:vscode-marketplace' \
     --audiences api://AzureADTokenExchange
   az identity show --name flowpact-marketplace --resource-group flowpact-publishing --query clientId -o tsv
   az account show --query tenantId -o tsv
   ```

3. Add the two ids as repository **variables** (not secrets) `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`.
4. Run the **VS Code publisher setup** workflow. Its summary shows the identity's profile id: add it as a
   **Contributor** under the publisher's **Members**. Run the workflow again with the publisher id to check access.
   If sign-in fails with AADSTS700213, the subject in step 2 does not match the `subject claim` azure/login logs.
   A new identity (for example after losing the subscription) has a new profile id: repeat steps 2 to 4.

**Open VSX** (used by VSCodium, Cursor, Windsurf and others; trusted publishing after the first version):

1. Sign in at <https://open-vsx.org> with GitHub. Under **Settings**, log in with an Eclipse account (its GitHub
   username must be yours) and sign the Publisher Agreement.
2. Create an access token (**Settings → Access Tokens**) and the namespace, spelled exactly like the publisher:
   `npx ovsx@1.2.0 create-namespace <publisher> -p <token>`.
3. Claim the namespace by opening an issue at <https://github.com/EclipseFdn/open-vsx.org/issues>. Until it is
   granted, the namespace is unverified and trusted publishing cannot be set up.
4. Add the token as the secret `OVSX_PAT` in the `open-vsx` environment, and set the repository variable
   `OPEN_VSX_PUBLISH` to `true`. The next release (or a re-run) publishes the first version with the token.
5. Then, under **Settings → Trusted Publishers** on open-vsx.org, add a GitHub Actions publisher: owner `ciatlas`,
   repository `flowpact`, workflow `release.yml`, environment `open-vsx`. Delete `OVSX_PAT` here and the token on
   open-vsx.org; later releases publish through trusted publishing.

The `vscode-marketplace` and `open-vsx` environments come from `.github/environments.json` (deploys from `main`
only).

Rule codes are stable: a code never changes meaning, and removed codes are not reused.
