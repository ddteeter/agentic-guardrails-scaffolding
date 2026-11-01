# Rebuild a stale `dist/` when HEAD moves — implementation plan

Fixes plan.md → "Roadmap: fixer-loop hardening" → "The hooks in this checkout
run a stale `dist/`…" (a recurrence of "The gate had never actually run").
Repo-only: no `guardrails-core/src` change.

## What git actually does (probed on git 2.50.1)

| Operation                       | Hook(s) fired                                                   | Old → new             |
| ------------------------------- | --------------------------------------------------------------- | --------------------- |
| `git pull` (merge or ff)        | `post-merge`                                                    | `ORIG_HEAD` → `HEAD`  |
| `git pull --rebase`, no local   | `post-merge` (it fast-forwards)                                 | `ORIG_HEAD` → `HEAD`  |
| `git pull --rebase`, local work | `post-checkout` _during_ the rebase, then `post-rewrite rebase` | `ORIG_HEAD` → `HEAD`  |
| `git commit --amend`            | `post-rewrite amend` (stdin `old new`)                          | stdin old → new       |
| `git switch` / `checkout <ref>` | `post-checkout $1 $2 1`                                         | `$1` → `$2`           |
| `git checkout -- <file>`        | `post-checkout … 0`                                             | — (skip)              |
| `git worktree add`              | `post-checkout 0000… $2 1`                                      | — (skip: no old tree) |

So post-checkout skips while a rebase is in progress (`rebase-merge/` or
`rebase-apply/` exists) — post-rewrite covers it once, from `ORIG_HEAD`, with
no double build. A null old sha (worktree add, clone) skips: there is no old
tree to diff, and that checkout needs `npm install` anyway, whose `prepare`
builds.

## Build inputs

Outputs that are gitignored and therefore can go stale: `guardrails-core/dist/`
and `.claude/agents/` + `.claude/skills/`. Their inputs:

`guardrails-core/src/`, `guardrails-core/package.json`,
`guardrails-core/tsup.config.ts`, `guardrails-core/tsconfig.json`,
`guardrails-core/tsconfig.build.json`, `tsconfig.base.json`, `package.json`,
`package-lock.json`, `scripts/sync-agents.mjs`, `guardrails-plugin/agents/`,
`guardrails-plugin/skills/`.

## Cost

`npm run build` measured at 4.4–4.9 s (full) / 3.7 s (core only) on this
machine. The no-change path is one `git diff --quiet <old> <new> -- <inputs>`
(or nothing at all for same-sha / file checkouts / null old) — measured and
reported in the PR.

## Steps

1. **Failing tests** — `guardrails-core/test/rebuild-hooks.test.ts`. Same shape
   as `templates.test.ts`'s hook tests: spawn the real hook files with `sh` in a
   temp git repo (GIT\_\* scrubbed, git argv-pinned per `end-to-end.test.ts`),
   with a stub `npm` first on `PATH` that logs its argv and exits `FAKE_EXIT`.
   Real git operations drive the hooks via `core.hooksPath` wrappers, so the
   old/new resolution is tested against what git really passes:
   - `git merge --ff-only` that touches `guardrails-core/src/` → builds once.
   - same, touching only `README.md` → no build.
   - `it.each` over every build input → builds.
   - `git switch` across a src change → builds; same-commit switch, file
     checkout, `git worktree add` → no build.
   - `git rebase` of a local commit onto a src change → exactly one build
     (post-checkout suppressed, post-rewrite builds).
   - `git commit --amend` that changes src → builds; amend of message only → no.
   - build failure → hook exits non-zero and stderr names `npm run build`.
     Done when: all fail (hook files do not exist).
2. **Implement** — `scripts/rebuild-if-changed.sh <old> <new>`: the diff test +
   `npm run build`, with a one-line "inputs changed, rebuilding…" note and a
   loud warning on failure. `.husky/post-merge`, `.husky/post-checkout`,
   `.husky/post-rewrite`: each a few lines resolving old/new as in the table,
   then calling the script. Done when: step 1 green, lint/typecheck clean.
3. **Measure** — time a no-change `git switch` and a no-change merge in the
   real checkout with the hooks live, and one changed-input rebuild.
4. **Docs** — CLAUDE.md "Setup": dist now rebuilds itself on pull/switch/rebase;
   plan.md entry marked fixed with the PR number and measured timings.
5. **Ship** — commit, PR, wait for CI + Claude review in the background, fix
   anything real, merge.

## Not in scope

- The `session-start` "src newer than dist" warning (the plan's cheaper
  backstop) — that is product code in guardrails-core.
- Working-tree edits to `src/` without a commit: no git hook sees those.
