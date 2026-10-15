## flowpact lint

<sub>flowpact v0.21.0 · config schema v1 · contract schema v1 · report schema v1 · 12 ms</sub>

❌ **1 error**

| Errors | Warnings | Info | Suppressed | Workflows | Actions | Jobs | Matrix combinations |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 0 | 0 | 3 | 0 | 3 | 3 |

### ❌ Errors (1)

**[`FP401`](https://ciatlas.github.io/flowpact/docs/rules/fp401) empty-binding-for-matrix-combo** · `.github/workflows/tests.yml:23:19`

Input "config" for .github/workflows/run-suite.yml is empty in 1 of 3 matrix combinations — matrix.config is not defined there

Matrix: `{ name: windows }`

<details><summary>Why / fix</summary>

**Why:** GitHub evaluates a missing matrix key to an empty string — no error, no warning. The affected matrix leg runs with an empty input, so the callee may skip its real work (e.g. a test configuration) while the run stays green.

**Fix:** Set `config` in every combination, or use a fallback: `${{ matrix.config || '<default>' }}`.

**Related locations:**

- `.github/workflows/pipeline.yml:9:11` — jobs.tests calls .github/workflows/tests.yml
- `.github/workflows/tests.yml:18:13` — this include entry has no `config`
- `.github/workflows/run-suite.yml:11:7` — receives the empty value: input "config"
- `.github/workflows/run-suite.yml:17:9` — this condition reads "config", so the legs with an empty value take the other branch

</details>
