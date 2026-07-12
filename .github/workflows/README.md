# Workflows & required settings

Three workflows (plus the `dependabot.yml` version-update config), hardened for
a **public** repository. The workflows are only half the story — several repo
settings are load-bearing for their security. Set them before relying on the
automation.

## Workflows

| File                        | Trigger                                 | Token scope                  | Notes                                                                                             |
| --------------------------- | --------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `ci.yml`                    | `pull_request`, push `main`             | `contents: read`, no secrets | Fork-safe. The `build-test` job is the **required check** auto-merge waits on.                    |
| `claude-code-review.yml`    | `pull_request` (owner-authored only)    | read + PR/issue write        | Never runs on fork PRs (gated on PR **author** = `ddteeter`), so no untrusted content reaches it. |
| `dependabot-auto-merge.yml` | `pull_request_target` (dependabot only) | see below                    | Auto-merges minor/patch after CI; Claude reviews majors read-only.                                |

(The interactive `@claude` workflow was intentionally omitted: on a public repo
its `issues`/`issue_comment` events run on the default branch with a write token,
which is an owner-initiated footgun on fork PRs for little marginal benefit over
the auto-review.)

## Required repository settings

1. **Secret** — add `CLAUDE_CODE_OAUTH_TOKEN` (Settings → Secrets and variables →
   Actions). Not exposed to fork PR runs, so it stays owner-only in practice.

2. **Branch protection on `main`** (Settings → Branches) — **required** for
   auto-merge to be safe:
   - Require the **`build-test`** status check to pass. `gh pr merge --auto`
     merges only once required checks are green; **without a required check,
     auto-merge lands immediately** — so this is the real supply-chain gate,
     together with the 7-day Dependabot cooldown.
   - Keep **0 required approvals** (the auto-approve step is non-gating hygiene;
     GitHub won't count a token self-approval toward a required count anyway).

3. **Allow auto-merge** (Settings → General → Pull Requests) — enable, or
   `--auto` has nothing to arm.

4. **Actions → General → Workflow permissions**:
   - Default `GITHUB_TOKEN` permissions → **Read repository contents** (each
     workflow re-grants its own minimum; a read-only default is defense in depth).
   - Enable **"Allow GitHub Actions to create and approve pull requests"** — the
     auto-merge job's `gh pr review --approve` needs it.

5. **Actions → General → Fork pull request workflows** — set **"Require approval
   for all outside collaborators"** (tighter than the first-time-contributor
   default). This means a fork PR's CI run won't execute until you approve it —
   important because `npm ci` runs dependency install scripts.

## Security model (why this is safe on a public repo)

- **Owner-only gates** on the Claude workflows use fields GitHub sets
  (`user.login`, `actor`) that outsiders cannot spoof.
- **`pull_request` (not `_target`)** for the review workflow → fork runs get a
  read-only token and no secrets; combined with the author gate it never touches
  fork content anyway.
- **`pull_request_target` auto-merge job runs no untrusted code** — no checkout
  of PR head, no `npm ci`, no build — so its `contents: write` token can't be
  reached by a dependency install script. The workflow definition is always read
  from `main`.
- **Majors are read-only** — the Claude major-review job has
  `contents: read` + `pull-requests: write` and a read-only Bash allowlist, so
  its entire blast radius is one PR comment.
- **All third-party actions are pinned to a full commit SHA** (with a version
  comment), so a moved tag can't swap in malicious code. Dependabot's
  `github-actions` ecosystem keeps the SHAs (and their comments) updated.

## Note

The owner login `ddteeter` is hardcoded in the workflow `if:` gates. If the
owner changes, update it in `claude-code-review.yml`.
