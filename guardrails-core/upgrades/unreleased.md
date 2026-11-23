---
version: unreleased
---

# Unreleased — what changed for an agent

## Behaviour that changed

- **`init --apply` re-records an owned file that already matches the
  template.** `.guardrails/scaffold.json` held the checksum of what `init`
  last wrote, and only a write refreshed it. A file someone brought up to
  the template by hand, taking a release's new text instead of letting
  `init` write it, kept the old checksum. The plan said `unchanged` while
  the template stayed put, then `drift` at the next template change, on a
  file nobody had edited. Now an owned file the plan calls `unchanged` gets
  its checksum and fingerprint recorded when the record differs, so the next
  `init --apply` writes `.guardrails/scaffold.json` once. A record that is
  already current is left alone, so a repeat run still writes nothing.
- **An unreadable `.guardrails/scaffold.json` is reported on every
  `init --apply`,** not only on a run that writes a file.
- **Changed-line mutation ranges widen to the enclosing function (#196).**
  Each hunk now covers the whole function, method or arrow function it sits
  in (or its top-level statement), with `padding` as the minimum, and each
  ranged file takes in the declarations of exports whose names a removed
  line held, so an export whose last caller was deleted is tested. Scoped
  gate runs may now report `stryker/survived` and `stryker/no-coverage` on
  lines the change did not touch, in the same function or in such an export.
  Those were real, and CI's whole-file run would have reported them. The
  first push after upgrading runs more mutants; the mutation cache is not
  invalidated, and a cached survivor newly in range counts. Widening needs
  the repo's own `typescript`; without it the gate warns once per run and
  keeps the padded ranges.
- **`ship` judges each workflow by its latest run on the commit.** A
  re-triggered workflow (a relabel, a re-run) leaves its older run on the
  commit, and `ship` read every run from `gh run list`, so an older failure
  reported `ci-red` while the newer run was still pending. `ship` now asks
  `gh run list` for each run's `event` and `databaseId` and keeps only the
  run with the highest id per workflow name and event. Runs of one workflow
  from different events, such as `push` and `pull_request`, are still judged
  apart. A row missing either field is dropped as malformed.

## Instructions this supersedes

- Any repo instruction that expects a hand-updated guardrails file to show
  as `drift` at every upgrade, or that keeps a list of such exceptions. Run
  `init --apply` once on this version, and the file reads as unmodified from
  then on.
- Any instruction that treats a gate survivor on a line the change did not
  touch as stale or out of scope. Inside the changed function, or in an
  export the change stopped calling, it is in scope now: kill it.

## What to wire

- Nothing. Commit the `.guardrails/scaffold.json` change the first
  `init --apply` makes.
- Nothing for #196. `"mutationScope": { "enclosing": false }` keeps the
  padded ranges if the wider runs cost too much; `"lines": false` mutates
  changed files whole, as CI does, at several times the cost.
