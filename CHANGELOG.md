# Changelog

All notable changes to flowpact (called wfc before 0.2.0) are documented here. The project uses
[Semantic Versioning](https://semver.org/). Rule codes (`FPnnn`) are stable: a code never changes meaning, and removed
codes are not reused. They were renamed once, from `WFCnnn` to `FPnnn` with the same numbers, in 0.2.0.

## [0.22.0](https://github.com/ciatlas/flowpact/compare/v0.21.1...v0.22.0) (2026-10-16)


### Features

* **language-server:** hover and go to definition in contract files ([#211](https://github.com/ciatlas/flowpact/issues/211)) ([26b6177](https://github.com/ciatlas/flowpact/commit/26b6177cf6ff278ced3a4a4741b0a60ee28aed0c))
* **language-server:** quick fixes, and accepting a finding with an override ([#207](https://github.com/ciatlas/flowpact/issues/207)) ([951c9f3](https://github.com/ciatlas/flowpact/commit/951c9f3f8b6a1c4feb00946cb8a79478853e9d64))
* **language-server:** regenerate the contracts from a contract finding ([#209](https://github.com/ciatlas/flowpact/issues/209)) ([ac8f4f3](https://github.com/ciatlas/flowpact/commit/ac8f4f33ad8e8bfd80cfd20e807de0b59ef5e9f4))
* **lint:** findings suggest the fix when it is certain, starting with renames ([#205](https://github.com/ciatlas/flowpact/issues/205)) ([72005cb](https://github.com/ciatlas/flowpact/commit/72005cbe0e4e89a9d930bb0b989ef337c0fc275e))
* **lint:** suggest adding a missing input, secret or matrix key, and removing an unused input ([#206](https://github.com/ciatlas/flowpact/issues/206)) ([72005cb](https://github.com/ciatlas/flowpact/commit/72005cbe0e4e89a9d930bb0b989ef337c0fc275e))


### Bug Fixes

* **language-server:** analyze a repository with no .github folder, such as an action's ([#210](https://github.com/ciatlas/flowpact/issues/210)) ([db60409](https://github.com/ciatlas/flowpact/commit/db60409a6a48ff63eb0f3c3844f334ea86f50aa1))

## [0.21.1](https://github.com/ciatlas/flowpact/compare/v0.21.0...v0.21.1) (2026-10-15)


### Bug Fixes

* **lint:** a removed action input warns the steps that pass it, it does not fail them ([#200](https://github.com/ciatlas/flowpact/issues/200)) ([97d6f1a](https://github.com/ciatlas/flowpact/commit/97d6f1a76d400a881c2e64bd65b9443774efbdbe))
* **lint:** retry GitHub API requests that fail in a way that passes ([#192](https://github.com/ciatlas/flowpact/issues/192)) ([84e488e](https://github.com/ciatlas/flowpact/commit/84e488e0633e03be4686187a028da79d170c0341))

## [0.21.0](https://github.com/ciatlas/flowpact/compare/v0.20.0...v0.21.0) (2026-10-15)


### Features

* **action:** grade the remote references a pull request moves to another version ([#183](https://github.com/ciatlas/flowpact/issues/183)) ([0dc8ab5](https://github.com/ciatlas/flowpact/commit/0dc8ab5fe5105f9d2ed4f48fdbf58dec244fe55e))
* **cli:** remotes download, and a per-user cache of the remote sources for the editor ([#171](https://github.com/ciatlas/flowpact/issues/171)) ([faaf945](https://github.com/ciatlas/flowpact/commit/faaf94517ff2be2f426b7a6c4182db91657c674d))
* **cli:** remotes update says what each changed entry does to your calls ([#182](https://github.com/ciatlas/flowpact/issues/182)) ([82b1981](https://github.com/ciatlas/flowpact/commit/82b19813da0b41eeb3fb17cb61b911df563242e9))
* **cli:** remotesUpdate, remotesDownload and remotesClean in the API ([#173](https://github.com/ciatlas/flowpact/issues/173)) ([5b5943b](https://github.com/ciatlas/flowpact/commit/5b5943bfe52a55c573169c84a216c6825d5a7ac8))
* **language-server:** describe remote calls and their keys from the remotes lockfile ([#169](https://github.com/ciatlas/flowpact/issues/169)) ([93fd11a](https://github.com/ciatlas/flowpact/commit/93fd11a44f80f4656605c7722e5dba81701d3115))
* **language-server:** go to the cached sources of remote workflows and actions ([#172](https://github.com/ciatlas/flowpact/issues/172)) ([86dd462](https://github.com/ciatlas/flowpact/commit/86dd462d9c414d630af96ce03d6a5bc49fd3d9ad))
* **lint:** check remote references at the commits GitHub's actions.lock pins ([#184](https://github.com/ciatlas/flowpact/issues/184)) ([aa677dc](https://github.com/ciatlas/flowpact/commit/aa677dc71e10aa0be8cecf99fd0a7a9703a88951))
* **lint:** FP205 for remote reusable workflows, from the secrets the lockfile records they read without declaring ([#168](https://github.com/ciatlas/flowpact/issues/168)) ([b030b55](https://github.com/ciatlas/flowpact/commit/b030b55f9b9fab70a2b41c9588bcf03579d4a0b1))
* **lint:** grade a remote version change against the repository's calls ([#181](https://github.com/ciatlas/flowpact/issues/181)) ([1c5244c](https://github.com/ciatlas/flowpact/commit/1c5244c2b3457bb241b2e1fab6336aa93855cfc1))


### Bug Fixes

* **lint:** for a remote call, suggest removing what the callee does not declare ([#187](https://github.com/ciatlas/flowpact/issues/187)) ([653d929](https://github.com/ciatlas/flowpact/commit/653d929886b0042aafcdc25e67d06dbcab128741))
* **rules:** FP612 reports, and the checks skip, a lockfile entry with another commit than its reference pins ([#174](https://github.com/ciatlas/flowpact/issues/174)) ([703030d](https://github.com/ciatlas/flowpact/commit/703030ded3707170e97c7ada4785ff5f1e4a2c63))

## [0.20.0](https://github.com/ciatlas/flowpact/compare/v0.19.1...v0.20.0) (2026-10-14)


### Features

* **cli:** look on github.com for what GitHub Enterprise Server lacks, as GitHub Connect does ([#167](https://github.com/ciatlas/flowpact/issues/167)) ([a36a5ba](https://github.com/ciatlas/flowpact/commit/a36a5bac2dde21cdc4cafe3c1e43c5658d6189dd))
* **cli:** remotes update takes paths, shows progress and the token, and says why a fetch failed ([#165](https://github.com/ciatlas/flowpact/issues/165)) ([975d647](https://github.com/ciatlas/flowpact/commit/975d647856f02600226efb97d92cf8976cc0549b))

## [0.19.1](https://github.com/ciatlas/flowpact/compare/v0.19.0...v0.19.1) (2026-10-14)


### Bug Fixes

* **lint:** fixes from smoke-testing 0.19.0 on real repositories ([#163](https://github.com/ciatlas/flowpact/issues/163)) ([68d789a](https://github.com/ciatlas/flowpact/commit/68d789a551bcbd8211ce072126ac34dd8a9cf45f))

## [0.19.0](https://github.com/ciatlas/flowpact/compare/v0.18.0...v0.19.0) (2026-10-14)


### Features

* **action:** fetch the remote interfaces a lockfile lacks in CI, report an outdated lockfile, and document Renovate and Dependabot ([#161](https://github.com/ciatlas/flowpact/issues/161)) ([694955a](https://github.com/ciatlas/flowpact/commit/694955a72f6e793c046f018b89cef158f93ba273))
* **cli:** flowpact remotes update fetches the remote interfaces lockfile ([#160](https://github.com/ciatlas/flowpact/issues/160)) ([d1b8ab9](https://github.com/ciatlas/flowpact/commit/d1b8ab9026f37b3b80723a358e13a292ae929e3a))
* **impact:** grade a job that gains, changes or loses its environment ([#155](https://github.com/ciatlas/flowpact/issues/155)) ([a02ad35](https://github.com/ciatlas/flowpact/commit/a02ad35aee38c53c5dbe0ae4c2eb4cbba5d0a6dd))
* **impact:** grade a job that needs runners callers may not have ([#154](https://github.com/ciatlas/flowpact/issues/154)) ([4d27fd2](https://github.com/ciatlas/flowpact/commit/4d27fd2b43f6e6782137c288c0325066224655eb))
* **impact:** grade an artifact a published unit no longer uploads ([#156](https://github.com/ciatlas/flowpact/issues/156)) ([72146e0](https://github.com/ciatlas/flowpact/commit/72146e05c20351b03870b8d6eb8acc6ee7f7f6a5))
* **impact:** grade an output that is now set only when an if: holds ([#153](https://github.com/ciatlas/flowpact/issues/153)) ([5a34a90](https://github.com/ciatlas/flowpact/commit/5a34a90c338cd9ca406c69967f66e70c67884ef4))
* **impact:** grade changed jobs or steps of a published unit as a patch ([#157](https://github.com/ciatlas/flowpact/issues/157)) ([ef22a21](https://github.com/ciatlas/flowpact/commit/ef22a219d5af186c64ec1e587b73cf5940304750))
* **lint:** check inputs passed to remote workflows and actions against a lockfile of their interfaces ([#158](https://github.com/ciatlas/flowpact/issues/158)) ([debbe85](https://github.com/ciatlas/flowpact/commit/debbe85f08d4afc36c94c784464556f94a690551))
* **lint:** check secrets passed to, and outputs read from, remote workflows and actions ([#159](https://github.com/ciatlas/flowpact/issues/159)) ([53e2ca4](https://github.com/ciatlas/flowpact/commit/53e2ca4056516c214a8291ff01f7294ac9174f8b))


### Bug Fixes

* **deps:** update dependency zod to v4.6.6 ([#149](https://github.com/ciatlas/flowpact/issues/149)) ([7b11e6e](https://github.com/ciatlas/flowpact/commit/7b11e6e9719e5bf0e54a90f0a8e1745cac955877))

## [0.18.0](https://github.com/ciatlas/flowpact/compare/v0.17.1...v0.18.0) (2026-10-14)


### Features

* **contracts:** write new contracts as .contract.yaml and read .contract.yml too ([#147](https://github.com/ciatlas/flowpact/issues/147)) ([c034092](https://github.com/ciatlas/flowpact/commit/c0340920eb47e1537712761d659f3d1abce9656b))

## [0.17.1](https://github.com/ciatlas/flowpact/compare/v0.17.0...v0.17.1) (2026-10-14)


### Bug Fixes

* **impact:** keep the links inside the repository on a base config path that enters it through a link outside it ([#144](https://github.com/ciatlas/flowpact/issues/144)) ([4c1ba54](https://github.com/ciatlas/flowpact/commit/4c1ba54db9e23a06040368a2d098f8e3079dd92f))

## [0.17.0](https://github.com/ciatlas/flowpact/compare/v0.16.0...v0.17.0) (2026-10-14)


### Features

* **trace:** follow a whole secrets read to every secret a workflow holds, and name the workflow of a secret no file declares, with core 2.0.0; see https://ciatlas.github.io/flowpact/docs/upgrading ([#141](https://github.com/ciatlas/flowpact/issues/141)) ([f6a5ffa](https://github.com/ciatlas/flowpact/commit/f6a5ffab8b0b726bd31ab761a5a38b2989b2b6b3))


### Bug Fixes

* **impact:** note an ignore edit only for the units the pull request's ignore leaves out once merged ([#140](https://github.com/ciatlas/flowpact/issues/140)) ([746df9f](https://github.com/ciatlas/flowpact/commit/746df9f21b0a6aff30c73b7a670d1c91fddc77b0))
* **impact:** read a base config through links, submodules and letter case as the baseline has it, so a pull request can no longer leave a published unit out of impact mode with its own ignore ([#140](https://github.com/ciatlas/flowpact/issues/140)) ([746df9f](https://github.com/ciatlas/flowpact/commit/746df9f21b0a6aff30c73b7a670d1c91fddc77b0))
* **lint:** locate a finding's end, and a reference after a property that follows a dot and spaces, where the source has them ([#141](https://github.com/ciatlas/flowpact/issues/141)) ([f6a5ffa](https://github.com/ciatlas/flowpact/commit/f6a5ffab8b0b726bd31ab761a5a38b2989b2b6b3))

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
