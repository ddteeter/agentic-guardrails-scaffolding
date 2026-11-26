---
version: unreleased
---

# unreleased — what changed for an agent

## Behaviour that changed

- **Nothing, for a repository with no `stacks` key: no action.** guardrails
  now reaches everything TypeScript-specific through a language **pack**
  (which files are source, which analyzers gate them, how a tool is
  installed, who owns a file, which tests cover it). A repository that
  configures no stacks has one implicit TypeScript stack at its root, which
  is the behaviour from before. That is held by recorded goldens: twenty
  fixture repositories run through `gate --mode=commit`, `push`, `ci` and
  `verify` with the real analyzers, compared on every build
  (`docs/releasing.md`).
- **`stacks` in `guardrails.config.json` (optional).** A list of
  `{ "pack", "root", "exclude", "wholeProjectTrigger" }` entries says which
  directory is gated by which pack. A changed file belongs to the stack with
  the longest `root` that contains it and whose `exclude` globs do not match
  it; each stack's analyzers see only that stack's files. `wholeProjectTrigger`
  is `always` (the TypeScript default: knip and dependency-cruiser run on
  every commit, as they do today) or `stack-changes` (run the stack's
  whole-project analyzers only when the stack owns a changed file; at ci
  they always run). An entry that cannot be used is dropped and named on
  stderr; a block with no usable entry falls back to the implicit TypeScript
  stack, so a broken block never turns the TypeScript gates off.
- **Only `typescript` has a pack in this version.** `"pack": "swift"` is
  accepted, and reported as one `warn`-severity
  `guardrails/stack-unsupported` violation: none of its analyzers exist yet.
- **`--stack=<id>`** on `verify` and `gate --mode=ci` runs only the stacks of
  that pack, so two CI jobs can each run their own tools. An id that is not
  a pack exits 2; one no configured stack uses is an error-severity
  `guardrails/stack-unmatched` violation, because a job that selected nothing
  must not read clean. The commit and push rungs refuse the flag.
- **A violation carries `stack`** (the pack id) in a repository that
  configures `stacks`, in the manifest a fixer reads. It is absent everywhere
  else.

## Instructions this supersedes

- None.

## What to wire

- Nothing. Add a `stacks` block only when a second language arrives in the
  repository.
