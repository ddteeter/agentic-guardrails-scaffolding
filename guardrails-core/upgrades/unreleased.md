---
version: unreleased
---

# Unreleased — what changed for an agent

## Behaviour that changed

- **Run-log rows record their project, and `guardrails stats` keeps projects
  apart (#236).** Each gate, ship and `guardrails lock` row now carries
  `project`: the clone its checkout belongs to, read from git's common
  directory, so every lane worktree of one clone has the same name. `repo`
  is still the checkout's folder name. A checkout git cannot read is named by
  its folder. `guardrails stats --project=<name>` narrows the summary to one
  clone's lanes; `--repo=<folder>` still narrows to one checkout. The text
  output opens with a `projects:` line that counts each project's runs, and
  says how many rows predate project identity. Those older rows are counted
  under their folder name. With more than one project in the window, the
  dry-run tables by queue depth and by load are printed per project, and the
  mixed tables are dropped, because a large suite and a small one in one
  table look like contention. `--json` keeps the mixed tables and adds
  `projects`. The output names projects, so check it before you paste it
  anywhere public.
- **A skipped or off seed says why (#236).** The gate row's cache part gains
  `seedWhy`, set only when the seed was `skipped` or `off`. It names the
  cause (no per-test coverage, a test changed under `any-test-change`, a
  test-support file wired to every test, no import graph, `mutationCache.seedFrom`
  not set, no installed stryker), not the file. `why` keeps its meaning.
  `guardrails stats` keys a cold run with no `why` by its `seedWhy`, and
  prints each rung's cold runs whose seed was never tried as
  `seed skipped N×: <reason> n, …` (and `seed off N×: …`). A row from before
  the field shows `reason not recorded`.
- The run log stays at version 1. Both fields are optional, so an older
  guardrails-core reading the same machine-wide log still reads every row.

## What to wire

Nothing. New rows carry the fields once this version writes them.
