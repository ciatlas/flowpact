# Maintainers

This file lists who can change flowpact's code, settings, releases and published packages, and what each role does.
It changes through a pull request, like any other file.

| Name | GitHub | Role |
| --- | --- | --- |
| Ruman Kazi | [@rumankazi](https://github.com/rumankazi) | Maintainer |

flowpact has one maintainer today, who holds every account below. The release bot and Renovate are GitHub Apps:
workflows act as the release bot, and Mend's service acts as Renovate. No person signs in as either.

## Access to sensitive resources

### GitHub

- **The `ciatlas` organization:** @rumankazi is its only member and its owner. It requires two-factor
  authentication, and its members get only Read on its repositories. It has no teams, outside collaborators or
  pending invitations.
- **The repositories:** [ciatlas/flowpact](https://github.com/ciatlas/flowpact) and
  [ciatlas/core](https://github.com/ciatlas/core), the workflow model flowpact bundles. In each, @rumankazi is the
  only collaborator, with the Admin role, and the code owner (`.github/CODEOWNERS`). Neither has deploy keys.
- **Rulesets** (`.github/rulesets/`, the same in both repositories): the `main` ruleset (changes only through pull
  requests that pass the required checks; no deletion or force push) has no bypass, not even for admins. Repository
  admins and Renovate may merge a pull request without the code owner's approval (`main reviews`); Renovate merges
  only its own. Only repository admins and the release bot may create, move or delete release tags (`release tags`,
  `v*`).
- **Secrets and variables:** the organization secret `RELEASE_BOT_PRIVATE_KEY` and variable `RELEASE_BOT_CLIENT_ID`
  are the release bot's credentials, available to ciatlas/flowpact and ciatlas/core only. Neither repository has
  secrets of its own. flowpact's variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` name the identity that publishes
  to the VS Code Marketplace, and `OPEN_VSX_PUBLISH` turns on publishing to Open VSX. In both repositories the
  workflows' `GITHUB_TOKEN` is read-only unless a workflow asks for more, and cannot approve pull requests.
- **Environments:** flowpact's `npm`, `vscode-marketplace`, `open-vsx` and `github-pages` environments accept jobs
  from `main` only (`.github/environments.json`) and hold no secrets.
- **GitHub Pages:** the docs at <https://ciatlas.github.io/flowpact>, built and deployed from `main` by
  `.github/workflows/docs.yml` through the `github-pages` environment, with HTTPS enforced. Only its deploy job can
  write to Pages.

### GitHub Apps

Both apps are installed on the `ciatlas` organization for ciatlas/flowpact and ciatlas/core.

| App | Owner | Permissions of its installation | What it does |
| --- | --- | --- | --- |
| [ciatlas-release-bot](https://github.com/apps/ciatlas-release-bot) | The `ciatlas` organization | Administration, contents, issues and pull requests: write. Metadata: read. It receives no webhook events. | Release pull requests and tags, rebuilt action bundles on Renovate's branches, repository settings |
| [Renovate](https://github.com/apps/renovate) | Mend | Checks, contents, issues, pull requests, statuses and workflows: write. Administration, members, metadata, packages and vulnerability alerts: read. | Dependency update pull requests and the Dependency Dashboard |

Each flowpact job that acts as the release bot creates its own short-lived token, limited to the permissions that
job needs (`actions/create-github-app-token`).

### Outside GitHub

| Resource | Who controls it | How releases use it |
| --- | --- | --- |
| npm package [`flowpact`](https://www.npmjs.com/package/flowpact) | @rumankazi, its only owner (`npm owner ls flowpact`) | Trusted publishing from `release.yml` in the `npm` environment, with provenance. No npm token is stored in GitHub. |
| npm package [`workflow-contracts`](https://www.npmjs.com/package/workflow-contracts) | @rumankazi, its only owner (`npm owner ls workflow-contracts`) | None. It was flowpact's name for 0.1.x; it is deprecated and no longer published. |
| VS Code Marketplace publisher `flowpact` | @rumankazi | `release.yml` signs in to Azure as the identity below, a member of the publisher, and runs `vsce publish --azure-credential`. |
| Azure managed identity (Microsoft Entra ID) | @rumankazi, through the Azure subscription that holds it | A federated credential accepts jobs in flowpact's `vscode-marketplace` environment: the Marketplace job of `release.yml`, and `vscode-publisher.yml`, which checks the identity's access. |
| Open VSX namespace `flowpact` (verified) | @rumankazi, through his open-vsx.org account (GitHub login), which the registry shows as the extension's publisher | Trusted publishing from `release.yml` in the `open-vsx` environment. No Open VSX token is stored in GitHub. |

## Roles and responsibilities

### Maintainer

A maintainer:

- reviews pull requests, approves them as code owner and merges them (GitHub does not let authors approve their own
  pull requests, so a repository admin may merge any pull request without an approving review, but not without the
  required checks);
- merges the release pull request, which publishes the release, and finishes a release whose publishing failed
  ([CONTRIBUTING.md](CONTRIBUTING.md#releases));
- reviews the dependency updates that do not merge themselves: major versions and 0.x minors;
- triages issues, and handles vulnerability reports privately within the times in [SECURITY.md](SECURITY.md);
- changes repository settings in `.github/rulesets/`, `.github/repository.json`, `.github/environments.json` and
  `.github/security.json`, not in the settings UI;
- holds the accounts above and the release bot's private key, and rotates the key
  ([CONTRIBUTING.md](CONTRIBUTING.md#releases));
- keeps this file up to date.

### Contributors

Anyone with a GitHub account can open issues and pull requests ([CONTRIBUTING.md](CONTRIBUTING.md)). Contributors
have no write access and no access to secrets: a pull request from a fork runs CI with a read-only token and without
secrets, and it merges only when the maintainer approves or merges it.

### ciatlas-release-bot

A GitHub App owned by the `ciatlas` organization, used only by workflows. It:

- opens and updates the release pull request, and commits the rebuilt action bundle and version references to it
  (`release.yml`);
- tags the release and creates its draft when that pull request merges, and moves the release line's floating tag
  once the release is published;
- commits the rebuilt action bundle to Renovate's branches when a runtime dependency changes
  (`dependency-bundle.yml`);
- applies the repository settings from `.github/` (`repo-settings.yml`).

In ciatlas/core it opens the release pull requests, tags the releases and applies the repository settings. It
cannot bypass the `main` rules or the code owner review, and its pull requests and pushes run the same checks as
anyone's. Its administration permission, used only by `repo-settings.yml`, could change the rulesets; that is why the
key is rotated when someone with write access leaves.

### Renovate

The hosted Renovate app, run by Mend and configured by each repository's `renovate.json`. It:

- opens pull requests that update dependencies, pnpm, `@ciatlas/core` and the actions, on Mondays, and keeps the
  Dependency Dashboard issue up to date;
- opens pull requests for dependency versions with known vulnerabilities;
- merges non-major updates itself once every required check passes, skipping only the code owner review. Major
  versions and 0.x minors wait for a maintainer.

It cannot push to `main`.

## Joining and leaving

- **Joining:** access is given by hand, one resource at a time, and only what the role needs. The organization
  requires two-factor authentication, so GitHub admits nobody without it, and a new member gets Read only. A
  repository role, code ownership and access to the registries and Azure are separate steps. The pull request that
  adds someone to this file says what they were given.
- **Leaving:** the person is removed from the organization, the repositories and `.github/CODEOWNERS`, and from the
  owners of both npm packages, the Marketplace publisher, the Open VSX namespace and the Azure subscription. If they
  had write access, which is enough to run a workflow that reads the organization's secrets, the release bot's private
  key is rotated. This file changes in the same pull request.
- **What stays:** publishing does not depend on anyone's credentials. npm and Open VSX trust the release workflow,
  and the Azure identity trusts flowpact's `vscode-marketplace` environment, so none of them changes when people
  join or leave.
- **Apps:** uninstalling an app from the organization ends its access, and a pull request removes it from the bypass
  lists in `.github/rulesets/`. If the release bot's private key may have leaked, the key is rotated.

<!--
For the maintainer to confirm, then delete this comment (gh and npm cannot show most of it):
- Marketplace publisher `flowpact`: you are its owner, and its only other member is the Azure identity (Contributor).
- Azure: only you hold roles on the subscription that holds the identity, and its only federated credential is the
  `vscode-marketplace` one (delete the leftover `github-release` and `github-release-ciatlas-classic` credentials).
- Open VSX: you are the namespace's only owner, its trusted publisher is ciatlas/flowpact, release.yml, open-vsx, and
  the access token used for the first publish is deleted on open-vsx.org.
- npm: the trusted publisher of `flowpact` is ciatlas/flowpact, release.yml, npm (the old rumankazi entry deleted), no
  publish-capable npm tokens remain, and `workflow-contracts` and `flowpact@0.0.0-stage` are deprecated.
- The process statements (triage, Joining and leaving) match how you want to work.
-->
