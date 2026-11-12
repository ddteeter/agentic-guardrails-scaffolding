---
version: unreleased
supersedes:
  - search: 'gh run list'
    because: 'if it is a check of the workflow runs after `guardrails ship` said green, ship reads the runs itself now and reports a failed start as `ci-red`'
---

# Unreleased — what changed for an agent

## Behaviour that changed

- **`guardrails ship` no longer says `green` when a workflow failed to start
  (#172).** A workflow that ends in `startup_failure` creates no check runs,
  so `gh pr checks` showed nothing wrong and ship reported `green`. Ship now
  also lists the workflow runs on the commit it pushed. A run that ended
  `startup_failure`, `failure`, `timed_out` or `cancelled` is `ci-red`, and
  `failing` names it as `<workflow> (<conclusion>)`. A cancelled run does not
  count when another run of the same workflow on that commit was not
  cancelled, which is what `concurrency: cancel-in-progress` leaves behind.
- **A required check that never reported is `ci-red`.** Ship reads the base
  branch's required status checks, from rulesets and from classic branch
  protection. If one has no check run once the wait for checks to register
  runs out (about two minutes), `failing` names it as
  `<check> (required, not reported)`. Where gh cannot read the requirements,
  ship requires nothing and judges by the checks and runs it can see.
- **An unreadable run listing is an `error`**, as an unreadable check listing
  already was.

## Instructions this supersedes

- Any step that confirms a `green` ship against `gh run list` before
  reporting it. Ship does that now.

## What to wire

- Nothing.
