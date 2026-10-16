# Security policy

## Supported versions

flowpact is before 1.0: only the latest release (`flowpact` on npm, `ciatlas/flowpact@v0.22`, the newest minor line, for the GitHub Action)
receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/ciatlas/flowpact/security/advisories/new), not in a public
issue. Include the version, how flowpact was run (CLI, GitHub Action, plugins) and, if possible, a minimal repository or
workflow that reproduces it.

You can expect an acknowledgement within 3 working days and an assessment within 10. Fixes are released as soon as
they are ready; the advisory is published once a fixed release is available, crediting the reporter unless they prefer
otherwise.

## Scope

flowpact reads untrusted input: the workflow, action and contract files of the repository it analyzes. Relevant reports
include anything that lets that input:

- read or write files outside the repository, or inside `.git` (for example through symlinks);
- inject terminal escape sequences, GitHub workflow commands (`::…::`) or Markdown/HTML into flowpact's output, annotations
  or job summary;
- exhaust memory or CPU disproportionately (for example YAML alias expansion or matrix size);
- execute code. Plugins listed in the config are JavaScript and run by design; the GitHub Action skips them on
  `pull_request_target` and `workflow_run` unless `plugins: true` is set. Ways around that are in scope.

## Security fixes in past releases

Vulnerabilities fixed after 0.12.3 are published as
[GitHub security advisories](https://github.com/ciatlas/flowpact/security/advisories), with the affected and fixed
versions, and the release notes of the fixed release name them.

The issues below were fixed in 0.12.3 or earlier. Only the latest release receives fixes, so for each one the remedy
is to upgrade to it. To find the version you run:

- CLI: `flowpact --version`. 0.1.x was published on npm as `workflow-contracts`, with the command `wfc`. That package
  is deprecated and gets no fixed version: install `flowpact` instead.
- GitHub Action: the banner near the top of the step's log (`flowpact vX.Y.Z · …`, or `wfc v0.1.x · …` for 0.1.x). A
  `uses:` ref of a minor line, from `@v0.2` on, runs the newest release of that line; 0.1.x has no such tag.
- VS Code extension: its version in the Extensions view, which is the version of the release it was built from.

| Issue | Affected | Fixed in | Severity |
| --- | --- | --- | --- |
| Reports, patches and contracts written through symbolic links | 0.1.0 to 0.12.2 | 0.9.0 in part, 0.12.3 | Moderate up to 0.8.2, low from 0.9.0 |
| Flag values read as flags | 0.3.0 to 0.8.2, CLI only | 0.9.0 | Low |
| Legacy workflow commands in output | 0.1.0 to 0.8.2 | 0.9.0 | Low |
| A hang on linked directories | 0.1.0 to 0.12.0 | 0.12.1 | Low |
| Markdown from the analyzed files in the job summary | 0.1.0 to 0.3.1 | 0.3.2 | Low |

### Reports, patches and contracts written through symbolic links

flowpact writes reports, patches and contracts to paths that can lie in the checkout it analyzes, where a pull request
can commit a symbolic link in place of a file or a directory. Up to 0.8.2, reports, patches, graphs and contracts
written with `generate --out` followed any such link: a pull request could commit, for example, `flowpact.sarif` as a
link to a file elsewhere on the runner, and flowpact then overwrote that file with the report. Contracts written in
place were already checked: flowpact refused one that was a link, or that a link took outside the repository or into
`.git`.

From 0.9.0, flowpact also refused a report or patch path that was itself a link, or that a link took outside the
repository or `GITHUB_WORKSPACE` ([#74](https://github.com/ciatlas/flowpact/pull/74)). Up to 0.12.2, though, it still
followed a linked directory that stays inside the repository: for reports, patches, graphs and `generate --out` also
one into `.git` (with `reports` committed as a link to `.git`, `-o reports/flowpact.sarif` wrote
`.git/flowpact.sarif`), and for contracts written in place one that leads elsewhere in the repository.

- **Affected:** 0.1.0 to 0.12.2, in runs on pull request code that write a report, patch or contracts inside the
  checkout: the CLI's `-o`, `--patch`, `--dump-graph`, `generate --out` and `generate` writing contracts in place, and
  the action's `report-json`, `report-sarif` and `report-markdown` inputs. Runs that write nothing inside the checkout
  or the workspace were not affected.
- **Severity:** moderate up to 0.8.2, where the pull request could write the report's text to any file the job can
  write. Low from 0.9.0: the write stays in the repository or the workspace, under the file name the workflow gave,
  though it can land in `.git`.
- **Fix:** upgrade. From 0.12.3, flowpact refuses any path that goes through a link inside the repository or the
  workspace ([#112](https://github.com/ciatlas/flowpact/pull/112)). With an older version, write reports outside the
  checkout, for example under `$RUNNER_TEMP`.

### Flag values read as flags

The CLI looked for `--help`, `-h`, `--version` and `-V` among all its arguments, also where one was the value of
another flag. A pull request titled `--help`, passed as `--title "$PR_TITLE"` as the impact mode page showed, made
flowpact print its help and exit with code 0 without checking anything.

- **Affected:** the CLI from 0.3.0 to 0.8.2, when `--title` or `--labels` is given pull request data as a separate
  argument. The GitHub Action reads the title and labels from the event and was not affected.
- **Severity:** low. It needs a pull request title that is exactly one of those four flags, or a pull request whose
  only label is one (labels need triage access). It makes the check pass without running.
- **Fix:** upgrade. From 0.9.0, the value of a string flag is never read as a flag
  ([#74](https://github.com/ciatlas/flowpact/pull/74)). With an older version, write `--title="$PR_TITLE"`, or leave
  `--title` out in GitHub Actions, where flowpact reads the title from the event.

### Legacy workflow commands in output

flowpact keeps text from the analyzed files from being read as a GitHub workflow command in a CI log. Up to 0.8.2 it
handled only `::command::` at the start of a line. The runner also reads the legacy form `##[command]` anywhere in a
line, so a file name or a value in the YAML that contained, for example, `##[warning]` or `##[add-mask]` became a
command when flowpact printed it.

- **Affected:** 0.1.0 to 0.8.2, in GitHub Actions: the CLI's output, the action's log, and report files that a later
  step prints.
- **Severity:** low. It needs such a name in the analyzed files. It can add annotations, mask text in the log, or turn
  off the workflow commands that follow (`stop-commands`).
- **Fix:** upgrade. From 0.9.0, flowpact breaks up `##[` in its output, and JSON and SARIF write its `[` as a Unicode
  escape ([#74](https://github.com/ciatlas/flowpact/pull/74)). There is no workaround other than not printing
  flowpact's output in the log.

### A hang on linked directories

flowpact follows symbolic links to directories inside the repository. Up to 0.12.0 it did so without a bound. Two
links in a directory that point back to it, such as `.github/actions/a` and `.github/actions/b` both linking to `.`,
made a run hang. Links that fan out made the time and memory grow exponentially with their depth.

- **Affected:** 0.1.0 to 0.12.0, on a checkout or workspace with such links under `.github/actions` or another
  directory flowpact reads: the CLI, the GitHub Action, the language server (from 0.5.0) and the VS Code extension
  (from 0.7.0, the first release that shipped it), also in Restricted Mode. Impact mode, from 0.3.0, also expanded such
  links in the base commit without a bound, and could run long and then fail with an error; there the links had to be
  on the base branch already.
- **Severity:** low. It needs two committed links. The CI job runs until it times out, or the language server stops
  responding.
- **Fix:** upgrade. From 0.12.1, flowpact does not follow a link back into a directory it is in, follows links at
  most 40 deep and expands at most 1,000 linked directories per walk
  ([#94](https://github.com/ciatlas/flowpact/pull/94)). With an older version, set `timeout-minutes` on the job.

### Markdown from the analyzed files in the job summary

The job summary and Markdown reports quote file names and values from the analyzed files. Up to 0.3.1, some of them
could escape their formatting: a file name with two backticks closed its code span early, a backslash canceled the
escape after it, and an escaped `@` still made a mention. A pull request could make the summary show live links,
mentions and the HTML GitHub allows.

- **Affected:** 0.1.0 to 0.3.1: the action's job summary, which is on by default, and Markdown reports
  (`--format markdown`, `report-markdown`). They were the latest release for about 5 hours on 2026-10-08, from 0.1.0
  at 05:09 UTC to 0.3.2 at 10:17 UTC (npm publish times).
- **Severity:** low. It needs such a name in the analyzed files. It changes what the summary or report shows.
- **Fix:** upgrade. 0.3.1 fixed the backslashes ([#25](https://github.com/ciatlas/flowpact/pull/25)), and 0.3.2 the
  code spans and mentions ([#27](https://github.com/ciatlas/flowpact/pull/27)).

## Verifying releases

Releases are published from GitHub Actions only:

- the npm package has npm provenance (`npm audit signatures`);
- each GitHub release carries the npm tarball with a Sigstore bundle (`.sigstore.json`) and its in-toto provenance
  (`.intoto.jsonl`): `gh attestation verify flowpact-<version>.tgz --repo ciatlas/flowpact`;
- from 0.9.0, the release also carries the GitHub Action as an archive
  (`flowpact-action-<version>.tar.gz`), signed the same way, and a CycloneDX SBOM of each artifact, attested against
  that artifact (`gh attestation verify <artifact> --predicate-type https://cyclonedx.org/bom`); it is published only
  once every asset is attached, and never changed after that;
- from 0.10.0, every release is a GitHub immutable release: its tag and files cannot change
  once it is published, and GitHub attests them (`gh release verify <tag> --repo ciatlas/flowpact`,
  `gh release verify-asset <tag> <file> --repo ciatlas/flowpact`);
- release tags (`v*`) can only be created or moved by the release automation and maintainers.

Releases up to 0.11.1 were built before the move, and GitHub keeps their attestations under the old owner: verify
them online with `--owner rumankazi`, or offline against the bundle attached to the release with
`gh attestation verify <file> --bundle <file>.sigstore.json --repo rumankazi/flowpact`. `gh release verify` no longer
finds their release attestations.

The [security page](https://ciatlas.github.io/flowpact/docs/security) describes what flowpact reads, writes and
sends, the permissions it needs, and how to verify each artifact. The
[threat model](https://ciatlas.github.io/flowpact/docs/threat-model) ranks the threats to flowpact and its releases,
and names the code and tests that defend against each.
