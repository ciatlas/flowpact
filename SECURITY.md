# Security policy

## Supported versions

flowpact is before 1.0: only the latest release (`flowpact` on npm, `ciatlas/flowpact@v0.12`, the newest minor line, for the GitHub Action)
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

Releases up to 0.11.1 were built before the move: verify them with `--repo rumankazi/flowpact`.

The [security page](https://ciatlas.github.io/flowpact/docs/security) describes what flowpact reads, writes and
sends, the permissions it needs, and how to verify each artifact.
