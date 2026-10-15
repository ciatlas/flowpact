<img src="https://raw.githubusercontent.com/ciatlas/flowpact/main/assets/brand/app-icon-128.png" alt="" width="64" height="64">

# flowpact (`flowpact`)

**Data-flow linter for GitHub Actions:** find the inputs, secrets and matrix values that arrive empty while the run
stays green, across reusable workflows, local actions and calls into other repositories.

GitHub Actions evaluates a missing matrix key, an undeclared secret or an optional input without a default to an empty
value: no error, no warning, a green run. When workflows call reusable workflows and local actions, that is how a test variant
or an upload stops running without anyone noticing. flowpact follows every input, secret, env var, matrix key and
output across those calls, evaluates every combination of the matrices written in your workflows, and reports where a
value goes missing. Use it next to actionlint, which checks each file in depth.

![flowpact lint reporting a matrix combination that passes an empty input](https://ciatlas.github.io/flowpact/screenshots/lint-incident.svg)

```sh
npx flowpact lint                         # lint .github/workflows and local actions
npx flowpact trace pipeline.yml:config    # where does this input go? (--up: where does it come from?)
npx flowpact explain FP401               # why it matters, how to fix it
npx flowpact remotes update               # record the interfaces of the remote workflows and actions you call
npx flowpact generate                     # lock the interfaces in .github/flowpact/
npx flowpact check                        # lint + compare with the locked contracts
```

`flowpact remotes update` writes `.github/flowpact/remotes.lock.yaml`: commit it, and lint checks what you pass to
workflows and actions in other repositories. Run it again on a schedule (`--dry-run --fail-on breaks`) to hear when a
moved tag or a new version drops an input one of your calls passes.

## Install

```sh
npm install --global flowpact     # then: flowpact lint
npm install --save-dev flowpact   # per project: npx flowpact lint
```

Requires Node.js 22 or newer. Exit codes: `0` clean, `1` findings at or above `--fail-on`, `2` usage or
configuration error, `3` internal error.

In GitHub Actions, use the action instead: `uses: ciatlas/flowpact@v0.20` (job summary, annotations, SARIF and a
downloadable patch when contracts drift).

## API

The package is also a library with one function per command (`lint`, `check`, `impact`, `generate`, `graph`, `trace`,
`rules`, `explain`, `remotesUpdate`, `remotesDownload`, `remotesClean`), for programs that run flowpact themselves,
such as your organization's own JavaScript action:

```js
import { lint } from 'flowpact';

const analysis = await lint({ root: '.' });
for (const a of analysis.annotations()) console.log(`${a.file}:${a.startLine} ${a.title}`);
process.exitCode = analysis.exitCode(); // 1 when there are errors, as for `flowpact lint`
```

The results give the JSON report, GitHub annotations, SARIF, Markdown and the terminal report; the types are included.
Reference and a complete action: https://ciatlas.github.io/flowpact/docs/api

📖 **Docs:** https://ciatlas.github.io/flowpact: a [quickstart](https://ciatlas.github.io/flowpact/docs/getting-started),
[remote interfaces](https://ciatlas.github.io/flowpact/docs/remote-interfaces), and a page for every rule.

MIT licensed.
