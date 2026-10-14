# Changelog

All notable changes to flowpact (called wfc before 0.2.0) are documented here. The project uses
[Semantic Versioning](https://semver.org/). Rule codes (`FPnnn`) are stable: a code never changes meaning, and removed
codes are not reused. They were renamed once, from `WFCnnn` to `FPnnn` with the same numbers, in 0.2.0.

## [0.16.0](https://github.com/ciatlas/flowpact/compare/v0.15.0...v0.16.0) (2026-10-14)


### Features

* **rules:** FP104, FP105, FP106 and FP401 follow inputs read through github as GitHub does, with core 1.0.0; some findings change, see https://ciatlas.github.io/flowpact/docs/upgrading ([#137](https://github.com/ciatlas/flowpact/issues/137)) ([ce3c119](https://github.com/ciatlas/flowpact/commit/ce3c11930242be379f756dd4ff603e00551efe35))


### Bug Fixes

* **rules:** FP104 reports the inputs of a workflow or composite action that reads github.event as a whole, and a dispatch input read only in the workflow's own input defaults or workflow_call outputs ([#137](https://github.com/ciatlas/flowpact/issues/137)) ([ce3c119](https://github.com/ciatlas/flowpact/commit/ce3c11930242be379f756dd4ff603e00551efe35))
* **rules:** FP106 reports a callee that reads a passed input only through github, also through a step's own env, and FP401 no longer reports such a condition ([#137](https://github.com/ciatlas/flowpact/issues/137)) ([ce3c119](https://github.com/ciatlas/flowpact/commit/ce3c11930242be379f756dd4ff603e00551efe35))

## [0.15.0](https://github.com/ciatlas/flowpact/compare/v0.14.1...v0.15.0) (2026-10-13)


### Features

* **graph:** flowpact graph &lt;paths&gt; draws the given workflows and actions and what they call ([#134](https://github.com/ciatlas/flowpact/issues/134)) ([a4223ac](https://github.com/ciatlas/flowpact/commit/a4223ac3e4fd777fde97a977059735ac17b768a0))
* **impact:** flowpact impact &lt;paths&gt;, lint/check --impact &lt;paths&gt; and the action's paths grade only the published workflows and actions within the paths, and say so in the report ([#134](https://github.com/ciatlas/flowpact/issues/134)) ([a4223ac](https://github.com/ciatlas/flowpact/commit/a4223ac3e4fd777fde97a977059735ac17b768a0))


### Bug Fixes

* **check:** check and generate with paths report and remove a removed unit's orphaned contract ([#134](https://github.com/ciatlas/flowpact/issues/134)) ([a4223ac](https://github.com/ciatlas/flowpact/commit/a4223ac3e4fd777fde97a977059735ac17b768a0))
* **impact:** a run with paths or ignore no longer passes silently when a published unit it does not report on needs a higher impact; verdict and findings always agree ([#134](https://github.com/ciatlas/flowpact/issues/134)) ([a4223ac](https://github.com/ciatlas/flowpact/commit/a4223ac3e4fd777fde97a977059735ac17b768a0))
* **impact:** ignore leaves a published unit out of impact mode only when both the baseline's and the pull request's config ignore it ([#134](https://github.com/ciatlas/flowpact/issues/134)) ([a4223ac](https://github.com/ciatlas/flowpact/commit/a4223ac3e4fd777fde97a977059735ac17b768a0))
* **lint:** locate a reference after a string literal that spans lines, and a computed index inside another reference ([#131](https://github.com/ciatlas/flowpact/issues/131)) ([b288f87](https://github.com/ciatlas/flowpact/commit/b288f878429b1d90f15f345e4aa1dd67c7cf7b56))
* **rules:** FP203 and FP204 count a whole secrets read, or a callee whose reads are unknown, behind secrets: inherit, and no longer suggest removing it ([#131](https://github.com/ciatlas/flowpact/issues/131)) ([b288f87](https://github.com/ciatlas/flowpact/commit/b288f878429b1d90f15f345e4aa1dd67c7cf7b56))
* **rules:** match github.event.inputs and outputs in any case, as GitHub does ([#133](https://github.com/ciatlas/flowpact/issues/133)) ([c0a052b](https://github.com/ciatlas/flowpact/commit/c0a052bf58638854a9aacf5dc1918a9a51415d37))
* **trace:** label an action's output edge 'action output' ([#131](https://github.com/ciatlas/flowpact/issues/131)) ([b288f87](https://github.com/ciatlas/flowpact/commit/b288f878429b1d90f15f345e4aa1dd67c7cf7b56))

## [0.14.1](https://github.com/ciatlas/flowpact/compare/v0.14.0...v0.14.1) (2026-10-13)


### Bug Fixes

* **rules:** FP104 counts a whole github.event.inputs read in a callee as reading the root's dispatch inputs ([#129](https://github.com/ciatlas/flowpact/issues/129)) ([d81d713](https://github.com/ciatlas/flowpact/commit/d81d71360e3b44cbdd5fb50df01ef7ab74bf59e5))

## [0.14.0](https://github.com/ciatlas/flowpact/compare/v0.13.0...v0.14.0) (2026-10-13)


### Features

* **trace:** follow input defaults, whole-object reads and github.event.inputs in workflows that can be called, and print each branch's note; some findings and contracts change, see https://ciatlas.github.io/flowpact/docs/upgrading ([#125](https://github.com/ciatlas/flowpact/issues/125)) ([4166c00](https://github.com/ciatlas/flowpact/commit/4166c00fe3f1e3c8e0c28486fbde8c7aa4a7dc5a))


### Bug Fixes

* **lint:** locate a finding at the expression in a bare if: written as a block or quoted scalar ([#125](https://github.com/ciatlas/flowpact/issues/125)) ([4166c00](https://github.com/ciatlas/flowpact/commit/4166c00fe3f1e3c8e0c28486fbde8c7aa4a7dc5a))
* **lint:** no FP104 or FP203 for a read through a `*` filter, and no false FP404 for a matrix exclude item that is an expression ([#125](https://github.com/ciatlas/flowpact/issues/125)) ([4166c00](https://github.com/ciatlas/flowpact/commit/4166c00fe3f1e3c8e0c28486fbde8c7aa4a7dc5a))
* **lint:** report a value a called workflow reads only through github.event.inputs (FP106) ([#125](https://github.com/ciatlas/flowpact/issues/125)) ([4166c00](https://github.com/ciatlas/flowpact/commit/4166c00fe3f1e3c8e0c28486fbde8c7aa4a7dc5a))

## [0.13.0](https://github.com/ciatlas/flowpact/compare/v0.12.3...v0.13.0) (2026-10-13)


### Features

* **trace:** show the contexts and plain values a value comes from when tracing up ([#123](https://github.com/ciatlas/flowpact/issues/123)) ([ad17271](https://github.com/ciatlas/flowpact/commit/ad17271ac3bc5de01cc5c4ee0abd930a6148a8fb))

## [0.12.3](https://github.com/ciatlas/flowpact/compare/v0.12.2...v0.12.3) (2026-10-12)


### Bug Fixes

* **lint:** never write through a symlinked directory in the repository ([#112](https://github.com/ciatlas/flowpact/issues/112)) ([1d8a570](https://github.com/ciatlas/flowpact/commit/1d8a570ac240889fba3e149e1c36c86f27c41da5))

## [0.12.2](https://github.com/ciatlas/flowpact/compare/v0.12.1...v0.12.2) (2026-10-12)


### Performance

* **lint:** validate with zod/mini, without zod's code generation ([#108](https://github.com/ciatlas/flowpact/issues/108)) ([0d78300](https://github.com/ciatlas/flowpact/commit/0d78300f1dffe3040bea3ebd09e17a376f271e9c))

## [0.12.1](https://github.com/ciatlas/flowpact/compare/v0.12.0...v0.12.1) (2026-10-12)


### Bug Fixes

* **core:** `always()` is known to be true, so a condition like `!always()` is known never to run ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** `impact.publish` lists each action once, finds `action.yaml` in an exact directory, and treats `./dir` like `dir` ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** a fractional array index is rounded down like GitHub, in expressions and matrix values ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** a step's own `env:` shadows the job's and the workflow's in that step's data flow ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** check names use GitHub's defaults for inputs without one, and are uncertain when a default is an expression ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** files whose names start with `..` are read, and locations before the start of a file are clamped ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** impact mode reads a base commit's linked files and directories like the working tree, bounded against loops and fan-out ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** keys named like `constructor` or `toString` are not treated as defined, and no longer hide a file's schema errors ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** matrix include and exclude entries tell object values with different keys apart ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** numbers convert to strings like GitHub (G15) in names, `format()`, `join()` and comparisons ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** the hint for a missing base like `origin/main` suggests `git fetch origin main` ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** the repository is detected from origin's url, not its pushurl ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))
* **core:** walking the repository no longer loops on a directory linked into itself ([#94](https://github.com/ciatlas/flowpact/issues/94)) ([7756e28](https://github.com/ciatlas/flowpact/commit/7756e28879521de1dfcb1ae17f858b34dd797bcd))

## [0.12.0](https://github.com/ciatlas/flowpact/compare/v0.11.1...v0.12.0) (2026-10-11)


### ⚠ BREAKING CHANGES

* flowpact moved to the ciatlas organization. Use `uses: ciatlas/flowpact@v0.12` (GitHub redirects the old name). The docs and schemas are now at https://ciatlas.github.io/flowpact, and the old rumankazi.github.io/flowpact URLs no longer resolve. Contracts written by 0.11 or earlier name the old schema and docs URLs: run `flowpact generate` once, or `flowpact check` reports FP802. Releases up to 0.11.1 verify with `gh attestation verify --owner rumankazi`, or offline with the release's `.sigstore.json` bundle and `--repo rumankazi/flowpact`; `gh release verify` no longer finds their release attestations. See https://ciatlas.github.io/flowpact/docs/upgrading.

### Features

* flowpact moves to ciatlas/flowpact and https://ciatlas.github.io/flowpact ([#90](https://github.com/ciatlas/flowpact/issues/90)) ([634431c](https://github.com/ciatlas/flowpact/commit/634431c224224755e36287c77e933ee1dc751dba))

## [0.11.1](https://github.com/rumankazi/flowpact/compare/v0.11.0...v0.11.1) (2026-10-11)


### Bug Fixes

* **core:** treat an unquoted `if: false` as never running in FP401, FP402, FP404 and FP205 ([#86](https://github.com/rumankazi/flowpact/issues/86)) ([ccfb1c9](https://github.com/rumankazi/flowpact/commit/ccfb1c955abc7f6614e54a1a885e4cc0845ea610))

## [0.11.0](https://github.com/rumankazi/flowpact/compare/v0.10.1...v0.11.0) (2026-10-11)


### Features

* **cli:** every command's text in the API: formatGraph, formatTrace, formatRules, formatExplain, formatGeneration, Analysis.github() and terminalOptions() ([#84](https://github.com/rumankazi/flowpact/issues/84)) ([e076cb9](https://github.com/rumankazi/flowpact/commit/e076cb9f24f713ce0f23c3ad198723a2137c4185))


### Bug Fixes

* **cli:** a fractional COLUMNS no longer makes flowpact lint fail ([#84](https://github.com/rumankazi/flowpact/issues/84)) ([e076cb9](https://github.com/rumankazi/flowpact/commit/e076cb9f24f713ce0f23c3ad198723a2137c4185))

## [0.10.1](https://github.com/rumankazi/flowpact/compare/v0.10.0...v0.10.1) (2026-10-10)


### Bug Fixes

* **action:** name the plugin input's files that a run skips, and why ([#82](https://github.com/rumankazi/flowpact/issues/82)) ([fd6c359](https://github.com/rumankazi/flowpact/commit/fd6c3592ccfc53c3e460b620e90a20cf1e5d1f44))
* **action:** print no empty impact baseline group when impact mode does not run ([#82](https://github.com/rumankazi/flowpact/issues/82)) ([fd6c359](https://github.com/rumankazi/flowpact/commit/fd6c3592ccfc53c3e460b620e90a20cf1e5d1f44))
* **action:** warn when a copy of the action has an action.yml that cannot be read, instead of ignoring its defaults ([#82](https://github.com/rumankazi/flowpact/issues/82)) ([fd6c359](https://github.com/rumankazi/flowpact/commit/fd6c3592ccfc53c3e460b620e90a20cf1e5d1f44))
* **cli:** publish the npm package without devDependencies and scripts, so a vendored copy works in an npm workspace ([#82](https://github.com/rumankazi/flowpact/issues/82)) ([fd6c359](https://github.com/rumankazi/flowpact/commit/fd6c3592ccfc53c3e460b620e90a20cf1e5d1f44))

## [0.10.0](https://github.com/rumankazi/flowpact/compare/v0.9.0...v0.10.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* **cli:** The npm package's `dist/index.js` now loads a second file next to it (code it shares with the new API), so a copy of `dist/index.js` alone no longer runs. Vendor the whole `package/` folder and run `node tools/flowpact/dist/index.js`; see https://rumankazi.github.io/flowpact/docs/upgrading.

### Features

* **action:** base-config and plugin inputs, so an organization's copy of the action carries its defaults and rules ([#76](https://github.com/rumankazi/flowpact/issues/76)) ([442ff0b](https://github.com/rumankazi/flowpact/commit/442ff0be94b4f842ffb5f85cc45da63fae1360d4))
* **cli:** a programmatic API, one function per command, in the flowpact package ([#78](https://github.com/rumankazi/flowpact/issues/78)) ([9fae33a](https://github.com/rumankazi/flowpact/commit/9fae33a3c101126b2f8d1c4bb2279527449323ed))


### Performance

* **action:** upload regenerated contracts without @actions/artifact, halving the action ([#77](https://github.com/rumankazi/flowpact/issues/77)) ([1beb611](https://github.com/rumankazi/flowpact/commit/1beb611fb91d447dd0b2743312280d7621d8cbed))

## [0.9.0](https://github.com/rumankazi/flowpact/compare/v0.8.2...v0.9.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* Options now go after the command. Before 0.9, an option written before it (`flowpact --no-plugins lint`) was silently dropped; it is now a usage error (exit 2). Write `flowpact lint --no-plugins`; `flowpact --help` and `flowpact --version` work as before. See https://rumankazi.github.io/flowpact/docs/upgrading.

### Features

* **cli:** annotations, several reports in one run and plugin flags, for wrappers built on flowpact ([#70](https://github.com/rumankazi/flowpact/issues/70)) ([a9e81cc](https://github.com/rumankazi/flowpact/commit/a9e81ccb358842daf274a2d43e45eee7a782f5e7))
* **config:** organization defaults with --base-config, and rules that are not loaded no longer stop a run ([#73](https://github.com/rumankazi/flowpact/issues/73)) ([665f687](https://github.com/rumankazi/flowpact/commit/665f687187af93a400427e9a084e37f1028bf023))


### Bug Fixes

* harden 0.9.0 before its release: flag values, plugins, report paths and release assets ([#74](https://github.com/rumankazi/flowpact/issues/74)) ([1dca54a](https://github.com/rumankazi/flowpact/commit/1dca54ac5f5843b0b8d80f1467eeffd94756943d))

## [0.8.2](https://github.com/rumankazi/flowpact/compare/v0.8.1...v0.8.2) (2026-10-09)


### Bug Fixes

* **core:** report an invalid expression once, as FP502 ([#65](https://github.com/rumankazi/flowpact/issues/65)) ([fd8cd1a](https://github.com/rumankazi/flowpact/commit/fd8cd1afb241c3ad13d37171c7edb35ac8e4d98f))

## [0.8.1](https://github.com/rumankazi/flowpact/compare/v0.8.0...v0.8.1) (2026-10-09)


### Bug Fixes

* **vscode:** load the Marketplace screenshots from raw.githubusercontent.com ([#62](https://github.com/rumankazi/flowpact/issues/62)) ([a3ef6a3](https://github.com/rumankazi/flowpact/commit/a3ef6a3b65a22de3be1afa62a5cf21a085299d13))

## [0.8.0](https://github.com/rumankazi/flowpact/compare/v0.7.0...v0.8.0) (2026-10-09)


### ⚠ BREAKING CHANGES

* **core:** FP105, FP205, FP401, FP402 and FP404 no longer report empty values the workflow handles, so overrides for those findings are reported by FP902 ([#58](https://github.com/rumankazi/flowpact/issues/58)). Some of their messages changed, so those code-scanning alerts close and reopen once. See https://rumankazi.github.io/flowpact/docs/upgrading.
* **core:** run `flowpact generate` after upgrading if you lock contracts ([#56](https://github.com/rumankazi/flowpact/issues/56)): a read of a whole outputs object such as `toJSON(needs.build.outputs)` now counts every output in it, so `flowpact check` reports contracts written by 0.7 as outdated (FP802). FP303 no longer reports outputs of published units, and rules about the internals of generated files are skipped there, so overrides for those findings are reported by FP902. See https://rumankazi.github.io/flowpact/docs/upgrading.
* **core:** a step's `uses: ./path` now resolves against the runner's workspace, as GitHub does ([#55](https://github.com/rumankazi/flowpact/issues/55)). Contracts of repositories that use actions through a checkout `path:` or `$/` gain `uses` entries, so `flowpact check` reports FP802 until you run `flowpact generate`; overrides for the old false FP606 findings are reported by FP902. See https://rumankazi.github.io/flowpact/docs/upgrading.

### Features

* **core:** precise output tracking for FP303/FP304, and quiet internals of generated files ([#56](https://github.com/rumankazi/flowpact/issues/56)) ([ac647a7](https://github.com/rumankazi/flowpact/commit/ac647a7691a127063ec183a1956ef6e2a4762c95))
* **core:** resolve step `uses: ./` against the workspace and support `$/` ([#55](https://github.com/rumankazi/flowpact/issues/55)) ([22fa1eb](https://github.com/rumankazi/flowpact/commit/22fa1eb6c6f7f59ee4a7190f9190480ead5a1253))
* **lsp:** a compact hover card with a flowpact header and docs link ([#49](https://github.com/rumankazi/flowpact/issues/49)) ([ecf6405](https://github.com/rumankazi/flowpact/commit/ecf64050a7d328c444968759ce1ad91daa8883ca))


### Bug Fixes

* **cli:** generate only the contracts of the given paths, and link the docs from --help ([#50](https://github.com/rumankazi/flowpact/issues/50)) ([bafeb74](https://github.com/rumankazi/flowpact/commit/bafeb74f6df5d3c9b92996d3ac07af05298f1e59))
* **core:** accept background steps and cache-mode, warn on keys GitHub ignores ([#52](https://github.com/rumankazi/flowpact/issues/52)) ([c58aaa6](https://github.com/rumankazi/flowpact/commit/c58aaa694137cd44f647a13eef76334c9a8443fc))
* **core:** stop reporting empty values the workflow already handles ([#58](https://github.com/rumankazi/flowpact/issues/58)) ([8f7c946](https://github.com/rumankazi/flowpact/commit/8f7c9465b456ded90bf04163a7a87782ec471624))
* **rules:** allow a job-level if to read jobs it depends on indirectly (FP302) ([#57](https://github.com/rumankazi/flowpact/issues/57)) ([d70dabc](https://github.com/rumankazi/flowpact/commit/d70dabca3387891b744b2f77dd23fd0195277199))
* **vscode:** activate without a workspace search when workflows are at the root ([#53](https://github.com/rumankazi/flowpact/issues/53)) ([5ea2e64](https://github.com/rumankazi/flowpact/commit/5ea2e648edb359e30008711767beb4e018e6fa25))

## [0.7.0](https://github.com/rumankazi/flowpact/compare/v0.6.0...v0.7.0) (2026-10-08)


### Features

* **brand:** add the flowpact logo ([#46](https://github.com/rumankazi/flowpact/issues/46)) ([485f6d8](https://github.com/rumankazi/flowpact/commit/485f6d828a73798a0998e39bab87f696165dbfa8))

## [0.6.0](https://github.com/rumankazi/flowpact/compare/v0.5.0...v0.6.0) (2026-10-08)


### Features

* **vscode:** add the VS Code extension ([#39](https://github.com/rumankazi/flowpact/issues/39)) ([e80a59a](https://github.com/rumankazi/flowpact/commit/e80a59ad1e9b7c2b1ce204b34e9372e97b29fe9f))

## [0.5.0](https://github.com/rumankazi/flowpact/compare/v0.4.0...v0.5.0) (2026-10-08)


### Features

* **core:** find symbols by source position for editors ([#34](https://github.com/rumankazi/flowpact/issues/34)) ([c8220d2](https://github.com/rumankazi/flowpact/commit/c8220d2ff48af010411c5a7594101fe985ba29b2))
* **lsp:** add the language server and `flowpact lsp` ([#35](https://github.com/rumankazi/flowpact/issues/35)) ([17b422f](https://github.com/rumankazi/flowpact/commit/17b422f44c74d464657daba40fd89a0cc23e1c2d))

## [0.4.0](https://github.com/rumankazi/flowpact/compare/v0.3.2...v0.4.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* remove the wfc migration support ([#30](https://github.com/rumankazi/flowpact/issues/30))

### Refactoring

* remove the wfc migration support ([#30](https://github.com/rumankazi/flowpact/issues/30)) ([0f5b667](https://github.com/rumankazi/flowpact/commit/0f5b6677ca25a921e523738d164c39f18f524927))

## [0.3.2](https://github.com/rumankazi/flowpact/compare/v0.3.1...v0.3.2) (2026-10-08)


### Bug Fixes

* close the gaps the review of the code-scanning fixes found ([#27](https://github.com/rumankazi/flowpact/issues/27)) ([c3ae275](https://github.com/rumankazi/flowpact/commit/c3ae27589393d4da00d9c8814fe88d1e55cce12a))

## [0.3.1](https://github.com/rumankazi/flowpact/compare/v0.3.0...v0.3.1) (2026-10-08)


### Bug Fixes

* resolve the open code-scanning alerts ([#25](https://github.com/rumankazi/flowpact/issues/25)) ([05ae008](https://github.com/rumankazi/flowpact/commit/05ae008f6fee0b5fd7b5377a8f2e08be256fa7ef))

## [0.3.0](https://github.com/rumankazi/flowpact/compare/v0.2.1...v0.3.0) (2026-10-08)


### Features

* impact mode for publishers of reusable workflows and actions ([#20](https://github.com/rumankazi/flowpact/issues/20)) ([9531d70](https://github.com/rumankazi/flowpact/commit/9531d70127b445baaf90359142efda9a8148e5db))

## [0.2.1](https://github.com/rumankazi/flowpact/compare/v0.2.0...v0.2.1) (2026-10-08)


### Bug Fixes

* **reporters:** leave findings accepted by overrides out of SARIF ([#21](https://github.com/rumankazi/flowpact/issues/21)) ([efb84ee](https://github.com/rumankazi/flowpact/commit/efb84ee6468248c48fb3a1ac6eba3d38c0884ed4))

## [0.2.0](https://github.com/rumankazi/flowpact/compare/v0.1.1...v0.2.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* rename wfc to flowpact ([#18](https://github.com/rumankazi/flowpact/issues/18))

### Features

* rename wfc to flowpact ([#18](https://github.com/rumankazi/flowpact/issues/18)) ([b7d04b9](https://github.com/rumankazi/flowpact/commit/b7d04b9cf78679250aa09e731dae4aedb77d451b))

## [0.1.1](https://github.com/rumankazi/wfc/compare/v0.1.0...v0.1.1) (2026-10-08)


### Bug Fixes

* **action:** shorten the description to fit the GitHub Marketplace limit ([#5](https://github.com/rumankazi/wfc/issues/5)) ([2ea93bb](https://github.com/rumankazi/wfc/commit/2ea93bb5bc7073046a26292c7da849ee21ad9445))

## [0.1.0] — 2026-10-08

First release.

### Engine

- Parses workflows and local composite/JavaScript/Docker actions into a data-flow graph with exact source positions:
  inputs, secrets, env, matrix keys and outputs across nested reusable workflows, same-repository `owner/repo@ref`
  references, YAML anchors and aliases.
- Uses GitHub's own `@actions/expressions` and `@actions/workflow-parser` for expressions and schema validation.
- Expands matrices exactly like GitHub (`include`/`exclude`) and evaluates bindings per combination, honouring each
  job's and step's own `if:`.

### Rules (45)

- `WFC1xx` inputs, `WFC2xx` secrets, `WFC3xx` outputs, `WFC4xx` matrix, `WFC5xx` expressions, env, schema and context
  availability, `WFC6xx` structure, `WFC8xx` contracts, `WFC9xx` overrides. Every finding has a code, location, call
  chain, why, fix and docs link.

### Contracts

- `wfc generate` writes a deterministic, semantic contract per workflow and local action to
  `.github/workflow-contracts/`; `wfc check` reports drift and classifies breaking changes; `--patch` writes a
  `git apply`-able patch.

### Configuration

- `.github/workflow-contracts/wfc.config.yml` with rule severities, limits, ignored paths, overrides (mandatory
  reason, optional expiry and owner), declared shapes for runtime-computed matrices, and plugins. JSON Schemas for the
  config, contracts and the JSON report are published at `https://rumankazi.github.io/wfc/schemas/`.

### CLI (`npx workflow-contracts`, command `wfc`)

- `lint`, `check`, `generate`, `trace`, `graph`, `explain`, `rules`; pretty, JSON, Markdown and SARIF output; reports
  to files; debug logging; exit codes 0 (clean), 1 (findings), 2 (usage/config error), 3 (internal error).

### GitHub Action (`rumankazi/wfc@v0`)

- Job summary, pull request annotations, JSON/SARIF/Markdown reports, and — in check mode — the regenerated contracts
  plus a patch as a downloadable artifact for people who cannot run the CLI.

[0.1.0]: https://github.com/rumankazi/wfc/releases/tag/v0.1.0
