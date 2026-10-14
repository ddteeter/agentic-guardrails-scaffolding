/**
 * Does the push this agent is about to run already pass through the push gate?
 *
 * The PreToolUse gate runs the commit-rung gate over the whole branch before a
 * Bash `git push`, and then git runs the pre-push hook, which -- as
 * `guardrails init` scaffolds it -- runs `gate --mode=push`: a superset of the
 * same checks, serialized behind the machine-wide lock. The first run bought
 * nothing but up to `hookDeadlineSeconds` of unlocked analyzer load on a
 * machine other agents were queueing to use.
 *
 * So that pre-run is skipped when, and only when, the hook git will actually
 * run can be read and visibly invokes the push gate. Every way of not knowing
 * -- no hook, a hook git would skip, a hook that delegates elsewhere (husky's
 * stubs) -- answers `false`, which keeps the pre-run: the fail-safe direction.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Exec } from './exec.js';

/**
A command line (not a comment) that runs the push rung.
*/
const PUSH_GATE = /\bgate[ \t]+--mode=push\b/;

/**
 * A quoted string, or the `#` that opens a shell comment: one that starts a
 * word. Matched left to right, so a `#` inside a closed quote belongs to the
 * string. An unclosed quote matches nothing, leaving its `#` a comment --
 * which errs toward "does not gate", the side that still runs the gate.
 */
const QUOTED_OR_COMMENT = /("[^"]*"|'[^']*')|(?:(?:^|(?<=\s))#)/g;

/**
The line up to its shell comment, if it has one.
*/
function withoutComment(line: string): string {
  for (const match of line.matchAll(QUOTED_OR_COMMENT)) {
    if (match[1] === undefined) {
      return line.slice(0, match.index);
    }
  }
  return line;
}

/**
Any execute bit: git runs a hook only when it is executable.
*/
const EXECUTABLE = 0o111;

/**
 * The hook's text, or nothing when git would not run it. Empty rather than
 * `undefined`: no text contains the push gate, so "unreadable" and "does not
 * gate" need no separate answer.
 */
function readHook(file: string): string {
  try {
    const stats = statSync(file);
    // Git skips a hook it cannot execute -- with a warning, and the push
    // goes through ungated -- so such a hook gates nothing.
    return (stats.mode & EXECUTABLE) === 0 ? '' : readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * True when the effective pre-push hook runs `gate --mode=push`.
 *
 * Resolved through `git rev-parse --git-path hooks/pre-push`, which honours
 * `core.hooksPath` -- the hook git will run, not the one in `.git/hooks`.
 */
export async function isPushGatedByHook(
  exec: Exec,
  repoRoot: string,
): Promise<boolean> {
  const named = await exec(
    'git',
    ['rev-parse', '--git-path', 'hooks/pre-push'],
    {
      cwd: repoRoot,
    },
  );
  // No empty-output guard: an empty name resolves to the repository root, a
  // directory, which `readHook` already cannot read.
  const relative = named.stdout.trim();
  if (named.code !== 0) {
    return false;
  }
  return readHook(path.resolve(repoRoot, relative))
    .split('\n')
    .some((line) => PUSH_GATE.test(withoutComment(line)));
}
