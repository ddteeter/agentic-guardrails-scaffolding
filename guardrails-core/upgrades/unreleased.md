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
- **A blocked pointer counts the warnings it set aside.** Warnings are in
  neither the manifest nor the count, and a blocked PreToolUse or Stop
  prints nothing but its pointer, so an advisory raised on a blocked
  iteration was seen by nobody. The pointer now ends
  `N warning(s) did not block and are not in the manifest: <rule> ×n, …`.
- **A commit rung that deferred mutation testing says what to do (#229).**
  When the mutation lock is busy and the commit rung defers, its output and
  the PreToolUse deny now say how many files were deferred and to run
  `guardrails gate --mode=push` in the background before reporting done. The
  deferral is still a warning and still does not block.
- **The PreToolUse commit gate ignores a git write inside a string that is
  only data.** `ps aux | grep -E "eslint|tsc|git commit"` no longer runs the
  commit gate. That is all that changed: a string is set aside only where
  every program on the line can do nothing with its strings but read them
  (`grep`, `egrep`, `fgrep`, `echo`, `printf`, `cat`, `head`, `tail`, `wc`,
  `uniq`, `cut`, `tr`, `ls`, `ps`, `pgrep`, `cd`, `pwd`, `true`, `false`,
  `tee`, each by its plain name), and the line has no heredoc, no `$` or
  backtick outside single quotes, no comment and no unclosed string, and
  the tool running it is `bash` (PowerShell quotes differently). Every
  other command is read exactly as it was before, strings and all: a script
  piped to a shell, `sh -c`, `eval`, a variable, `git rebase -x`, `node -e`,
  a string typed into another program.
- **A hook bypass is recognised in every spelling git accepts.** git takes
  any unambiguous prefix of a long option and reads a config key in any
  letter case, so `git commit --no-verif`, `git push --no-veri` and
  `git -c core.hookspath=/dev/null push` skip the hooks exactly as the
  documented spellings do. They are now bypasses to the gate as well: a push
  that carries one is gated at PreToolUse and is never left to the pre-push
  hook it skips. The config key is matched wherever it is written, which
  covers `-c`, `--config-env` and the `GIT_CONFIG_*` variables.
- **A bypass is looked for in the whole command, before anything is
  dropped.** A quoted heredoc fed to a shell (`bash <<'EOF'`, with
  `git commit --no-verify` in its body) used to have its body dropped before
  the check ran. A command that names a bypass anywhere is now read whole.
- **A bypassing write is gated wherever git stands in the command.** The
  gate fires on a git write in command position; a write behind a reserved
  word, a wrapper, a path, a backslash or a line continuation
  (`if git commit ...`, `env git push`, `/usr/bin/git ...`), or inside a
  string handed to another program, is still left to the git hooks. With a
  bypass on it those hooks do not run, so a command that names a bypass and
  has the word `git` in it is now gated whatever its shape. A push among
  them is judged over the branch.
- **That rule gates some commands that write nothing.** It does not model
  the shell, so these now run the commit gate over the staged files, and are
  denied if it finds something: `git grep hooksPath`,
  `git config --get core.hooksPath`, `git log --grep=--no-verify`,
  `gh pr create --body "never run git commit --no-verify"`,
  `echo "git commit -n"`, `grep -n hookspath .git/config`, and a heredoc or a
  script that writes text naming both a bypass and git. A command that names
  a bypass and no git (`grep -rn hooksPath src`) is not gated. To read or
  search for these words without the gate, use a tool that is not a shell
  command, or put the text in a file first.
- **A bypassing write the gate cannot place is refused if the command also
  moves.** Where git stands out of the gate's reading (behind a wrapper, in
  a string, a heredoc or a substitution) and the command also says `cd`,
  `pushd`, `popd`, `-C`, `--git-dir`, `--work-tree`, `GIT_DIR` or
  `GIT_WORK_TREE`, the repository it writes to cannot be known, so it is
  denied instead of being checked against the wrong one. This also denies
  `cd packages && git commit --no-verify -m "about git"`: the word in the
  message counts as a git the gate did not place.
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
- **The "not installed in this checkout" refusal can say to start a new
  session.** Only in a checkout whose install also builds its fixer agents
  (one with `guardrails-plugin/agents/`), and only while they are unbuilt: a
  session that began before that install did not load them. Elsewhere the
  refusal is unchanged.
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
