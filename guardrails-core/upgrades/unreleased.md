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

## Instructions this supersedes

- Any repo instruction that expects a hand-updated guardrails file to show
  as `drift` at every upgrade, or that keeps a list of such exceptions. Run
  `init --apply` once on this version, and the file reads as unmodified from
  then on.

## What to wire

- Nothing. Commit the `.guardrails/scaffold.json` change the first
  `init --apply` makes.
