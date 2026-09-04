/**
 * The one piece of guardrails' wiring that does not live in a file:
 * `core.hooksPath`, the per-clone git config entry that makes
 * `.githooks/pre-commit` fire at all (spec §6.6).
 *
 * It is also the one piece that CANNOT be merged. Every other consumer-owned
 * artefact guardrails touches is additive -- `mergePrepareScript` appends to
 * `scripts.prepare` rather than replacing it, precisely so a consumer's husky
 * survives -- but git accepts exactly one hooks directory. So a consumer who
 * already has one (husky sets `.husky/_`) is a repo where installing our hook
 * means UNINSTALLING theirs: pre-commit, commit-msg, lint-staged, all of it,
 * silently, and again on every `npm install` for as long as
 * `scripts.prepare` runs `guardrails-core install-hooks`.
 *
 * Between two incomplete outcomes we take the visible one. Not activating our
 * hook leaves the consumer exactly as they were and says so out loud; taking
 * theirs over leaves them worse off and says nothing. This module is that
 * decision, shared by `init` and `install-hooks` so the two commands cannot
 * answer it differently.
 */

/** Where guardrails installs its hook, and points `core.hooksPath` when it can. */
export const HOOKS_DIRECTORY = '.githooks';

/** The hook script itself -- the thing a foreign `core.hooksPath` leaves inert. */
export const HOOKS_SCRIPT_PATH = `${HOOKS_DIRECTORY}/pre-commit`;

/** The branch-wide companion rung, inert under a foreign `core.hooksPath` for
 *  exactly the same reason. */
export const PUSH_HOOK_SCRIPT_PATH = `${HOOKS_DIRECTORY}/pre-push`;

/**
 * The already-configured `core.hooksPath` that guardrails must not overwrite,
 * or `undefined` when there is nothing in the way -- either git has no
 * `core.hooksPath` at all, or it already points where we would point it.
 *
 * Returning the VALUE rather than a boolean is what lets the caller name it in
 * the warning: "already set to `.husky/_`" is actionable, "already set" is not.
 *
 * A filter, not a classifier: only `.githooks` is mapped to "nothing in the
 * way", and the absent case falls through unchanged because absent ALREADY is
 * `undefined`. An explicit `hooksPath === undefined ||` arm would read as
 * thorough and be unprovable -- both of its branches return `undefined` for
 * that input, so no test could tell it from `false`.
 */
export function foreignHooksPath(
  hooksPath: string | undefined,
): string | undefined {
  return hooksPath === HOOKS_DIRECTORY ? undefined : hooksPath;
}

/**
 * What a consumer whose `core.hooksPath` we refused to touch is told: the
 * value we found, the hook that is therefore inert, why we left it that way,
 * and the one-line way to get the check running inside the hooks they already
 * have. Chaining is the honest suggestion -- their hook stays theirs, and the
 * guardrails check becomes one more line in it.
 */
export function foreignHooksPathWarning(existing: string): string {
  return (
    `core.hooksPath is already set to "${existing}", so ${HOOKS_SCRIPT_PATH} ` +
    `was NOT activated: repointing it at ${HOOKS_DIRECTORY} would silently ` +
    `disable every hook you already have there. To run the guardrails check ` +
    `too, add \`node ./node_modules/guardrails-core/dist/cli.mjs gate ` +
    `--mode=commit\` to your existing pre-commit hook.`
  );
}
