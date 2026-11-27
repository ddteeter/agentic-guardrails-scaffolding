---
version: unreleased
supersedes:
  - search: 'nosession-commit'
    because: 'if it tells agents to delete `.guardrails/state/nosession-commit.last.json` when a commit is refused for a fixer that is "already working", a commit gate run from a git hook no longer claims the files it names, so that refusal no longer happens and the file should be left alone'
  - search: '.stryker-tmp'
    because: 'if it tells agents to remove `.stryker-tmp/` before committing because dependency-cruiser reports the copied files, add the sandbox to the `exclude` in `.dependency-cruiser.cjs` instead (see "What to wire")'
---

# Unreleased — what changed for an agent

## Behaviour that changed

- **A blocked commit counts, and hands a fixer, only what blocks.** The
  commit-gate pointer (`N violation(s), M added suppression(s)`) counts
  error-severity violations, and the manifest it names holds those and the
  added suppressions. Warnings are still printed by `gate --mode=commit`, and
  are in neither the count nor the manifest. Before, seven "Nothing to do"
  mutation deferrals beside two errors read as nine violations to fix.
- **The Stop gate does the same, and its counts change.** The Stop pointer's
  `N guardrail violation(s)` now counts error-severity violations and added
  suppressions only, and the manifest it names (`<session>.last.json`) holds
  only those. A warning no longer picks the fixer's tier, is no longer part
  of the files a fixer is said to hold, and is no longer tallied in the
  recurrence counts: `ruleCounts` in the session state, and through it
  `.guardrails/state/recurrence.json` and the "has failed verification in N
  separate turns" note, count a rule only on a turn where it blocked. The
  `violations` and `rules` fields of a Stop row in the decision log shrink the
  same way, so a `guardrails report` taken across this version compares
  rows counted two ways. Whether a turn is blocked is unchanged: a turn with
  only warnings ended before and ends now.
- **A commit rung that deferred mutation testing says what to do (#229).**
  When the mutation lock is busy and the commit rung defers, its output and
  the PreToolUse deny now say how many files were deferred and to run
  `guardrails gate --mode=push` in the background before reporting done. The
  deferral is still a warning and still does not block.
- **The PreToolUse commit gate ignores a git write inside a quoted string.**
  `ps aux | grep -E "eslint|tsc|git commit"` no longer runs the commit gate.
  A real write is matched as before, and anything the reader of quotes does
  not model is too: an unterminated string, `$'...'`, a command substitution
  inside double quotes, any heredoc, a string handed to a shell (`sh -c`,
  `eval`, `git rebase --exec`), and any command that names `--no-verify`,
  `hooksPath`, or `-n` on a `git commit`. A commit typed into another program as a plain string (through
  `tmux send-keys`, say) used to match by accident and no longer does; the
  git hook still runs for it.
- **`git commit -n` is read as the hook bypass it is.** `-n` is the short
  form of `--no-verify` for `git commit`, alone or in a cluster (`-nm "x"`,
  `-an`). A command that names it anywhere keeps the wider reading the
  bypass check gives `--no-verify`, and a push that carries one is gated at
  PreToolUse instead of being left to its hook. `-n` on any other command
  (`git push -n`, `git clean -n`, `git add -n`, `head -n`) is not a bypass,
  and neither is `git commit -mn`, which is a message.
- **A duplication pointer says who extracts.** When a manifest holds
  `fallow/code-duplication` findings, a pointer that says to spawn a fixer
  adds that extraction into a NEW module is the main agent's to do. The
  fixer's scope is unchanged: it may edit only the files the manifest names.
- **A commit gate run from a git hook claims no files (#216).** It has no
  session and spawns no fixer, so it no longer leaves a lease that made the
  session's next commit wait for one.
- **A CLI that resolved from outside the repository says what to do.** Where
  the checkout has no guardrails-core: `npm ci`. Where it has one the command
  did not reach: `npm rebuild guardrails-core`, or `node <path>`.

## Instructions this supersedes

- **Deleting a state file to get a commit through.** If an instruction says
  to remove `.guardrails/state/nosession-commit.last.json` (or `leases.json`)
  when the gate says a fixer is already working, drop it.
- **Removing `.stryker-tmp/` before a commit**, where the reason was
  dependency-cruiser. Exclude it in the config instead.

## What to wire

`guardrails init` seeds `.dependency-cruiser.cjs` once and never rewrites it,
so a config seeded before this release still cruises a leftover stryker
sandbox (#55). Add `\\.stryker-tmp` to its `exclude`:

```js
exclude: {
  path: '(^|/)(dist|build|coverage|node_modules|\\.stryker-tmp)/|^\\.claude/worktrees/',
},
```

Nothing else.
