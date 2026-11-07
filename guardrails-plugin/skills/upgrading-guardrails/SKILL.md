---
name: upgrading-guardrails
description: Use when guardrails-core has just been bumped to a newer version in a repo, or a release says to read this. Covers reading every release's upgrade notes between the old pin and the new, refreshing guardrails' own files, finding the repo's own instructions the new version has superseded, wiring what it adds, and finishing on a green `guardrails verify`.
---

# Upgrading guardrails

A release can leave two kinds of thing stale. Guardrails' **own** files (fixer
agents, hooks, guidance docs) are refreshed by `guardrails init`. The repo's
**own** instructions are the other kind: rules people wrote in `CLAUDE.md`,
`AGENTS.md`, skills and scripts, around how guardrails used to behave. A rule
the new version enforces for you, a workaround for a bug it fixed, a command
nothing calls yet. Nothing mechanical fixes those, because they are someone's
words. This skill finds them and proposes the edit.

Read this copy, in `node_modules/guardrails-core/guidance/`, not any copy
vendored into the repo: a vendored one is from the version you are leaving.

## The six steps

### 1. Pin the range

Find the version the repo was on (the `guardrails-core` line in the
lockfile or `package.json` before the bump, from `git diff` or `git log -p`)
and the version now installed (`node_modules/guardrails-core/package.json`).

Done when you can name both versions.

### 2. Read every release's notes in the range

`node_modules/guardrails-core/upgrades/` holds one file per release,
`<version>.md`. Read every one newer than the old pin and no newer than the
new version, oldest first. A later release can reverse an earlier one, and
the later word wins. Releases before 0.12.0 have no notes. For those, read
the release PR titles (`gh release view v<version>`) and treat what you find
the same way.

Each file's frontmatter lists `supersedes`, a phrase to search for and why it
is stale, and `wire`, a script, hook or config key to add and why. The body
says what changed, and when an old rule is only **partly** superseded, which
part to keep.

Done when every release in the range is read, and you hold its `supersedes`
and `wire` lists.

### 3. Refresh guardrails' own files

Run `guardrails init --plan`, read the plan, and act on it the way
`adopting-guardrails` step 1 describes. Owned files that only drifted by
formatting upgrade on their own. A file the plan reports as edited is a
judgement call for the developer, not for `--force`.

Done when `init --apply` has run and the plan shows nothing left to update.

### 4. Find the superseded instructions

For each `supersedes` phrase, search case-insensitively, as a literal, in the
repo's own instruction surfaces:

- `CLAUDE.md` and `AGENTS.md`, at the root and in subdirectories
- `.claude/rules/`, `.claude/skills/`, `.claude/commands/`, and `.cursor/`
- `.github/copilot-instructions.md` outside the `guardrails:` marker blocks
- `package.json` scripts, CI workflows, and docs a lane or reviewer is told to follow

Skip files guardrails owns. `init` just refreshed them, and they are listed in
`.guardrails/scaffold.json`.

For each hit, read the surrounding rule rather than the matched line alone,
and decide against the note's body whether it is superseded, partly
superseded, or a false match. Then **propose** the edit to the developer, with
the note's `because`: the rule, the replacement wording, and the release that
made the change. These are the developer's words. Apply an edit once they
agree to it.

Done when every phrase from every release has been searched for, and every
hit has been either proposed or dismissed with a reason.

### 5. Wire what the releases add

For each `wire` entry, check whether the repo already has it: the script in
`package.json`, the hook in the host's hook config, or the key in
`guardrails.config.json`. Propose what is missing, with its `because`. Leave
out what the note says is optional and the repo does not need.

Done when every `wire` entry is present, proposed, or declined.

### 6. Verify, and say what needs a fresh session

Run `guardrails verify` and iterate until it is green. That, not edited
files, is the exit criterion. If hooks, agents or host settings changed, tell
the developer that they load at session start, so a fresh session is needed
before the new behaviour applies.

Done when `verify` is green and the developer has the list of what changed:
files refreshed, instructions edited or left, wiring added.
