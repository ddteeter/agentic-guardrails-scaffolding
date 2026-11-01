#!/bin/sh
# Rebuild this checkout's gitignored build outputs when HEAD moved from <old>
# to <new> across a change to anything they are built from. Called by
# .husky/post-merge, post-checkout and post-rewrite.
#
# Every hook in .claude/settings.json and .husky/ runs guardrails-core/dist,
# and dist/ (like .claude/agents/ and .claude/skills/, which the same build
# syncs) is gitignored. Without this, a pull that brings a gate fix leaves the
# gate running the old build -- found twice; see plan.md, "The hooks in this
# checkout run a stale `dist/`".
#
# The no-change path is one `git diff --quiet`, or nothing at all: this also
# fires on every branch switch.
#
# Usage: rebuild-if-changed.sh <old> <new>

old=$1
new=$2

# No old tree to compare against (a clone or `git worktree add` passes the null
# sha): that checkout needs `npm install`, whose `prepare` builds.
if [ -z "$old" ] || [ "$old" = "$new" ] ||
  ! git cat-file -e "$old^{commit}" 2>/dev/null; then
  exit 0
fi

if git diff --quiet "$old" "$new" -- \
  guardrails-core/src \
  guardrails-core/package.json \
  guardrails-core/tsup.config.ts \
  guardrails-core/tsconfig.json \
  guardrails-core/tsconfig.build.json \
  tsconfig.base.json \
  package.json \
  package-lock.json \
  scripts/sync-agents.mjs \
  guardrails-plugin/agents \
  guardrails-plugin/skills; then
  exit 0
fi

echo "guardrails: build inputs changed, rebuilding dist/ (npm run build)..." >&2
if ! output=$(npm run build 2>&1); then
  printf '%s\n' "$output" >&2
  echo "guardrails: npm run build FAILED -- this checkout's hooks are running a stale dist/. Fix the build and re-run npm run build." >&2
  exit 1
fi
