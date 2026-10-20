<img src="https://raw.githubusercontent.com/ciatlas/flowpact/main/assets/brand/app-icon-128.png" alt="" width="64" height="64">

# flowpact (`flowpact`)

**Data-flow linter for GitHub Actions:** change shared workflows and actions without breaking the repositories that
use them.

flowpact checks both sides of every interface between GitHub Actions workflows:

- **When you publish a reusable workflow or action,** it grades every pull request major, minor, patch or none against
  what callers can see, check names included, and fails it when its title declares less.
- **When you call one,** it checks every call against the interface of the version it targets, recorded in a lockfile,
  and grades a version bump or a tag that moved against your calls before you take it.
- **Inside a repository,** it follows every input, secret, env var, matrix key and output across workflows, actions and
  matrix combinations, and reports where a value arrives empty while the run stays green.

Use it next to actionlint, which checks each file in depth.

![flowpact impact failing a pull request titled "fix: tidy the test job": a removed output and a renamed job require a major release](https://ciatlas.github.io/flowpact/screenshots/impact.svg)

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

In GitHub Actions, use the action instead: `uses: ciatlas/flowpact@v0.28` (job summary, annotations, SARIF and a
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
