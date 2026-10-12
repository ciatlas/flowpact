# Check-run names captured from GitHub

The workflows here are a copy of the private lab repository `rumankazi/flowpact-checknames-lab`. `expected.json` lists
the check runs GitHub reported for them (commit and command inside). The test that computes the names and requires an exact
match lives with the workflow model in [ciatlas/core](https://github.com/ciatlas/core) (`test/checks.test.ts`, with its
own copy of this lab), so any change in GitHub's naming shows up there as a failing test after the lab is re-run and
`expected.json` is refreshed. Here the lab is one of the repositories the lint fixture tests analyze.

Two lab jobs depend on runtime facts and are marked in the test: `after-boom` is skipped because the job it needs
fails, and `Ref ${{ github.event_name }}` reads the triggering event.
