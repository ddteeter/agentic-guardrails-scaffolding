/**
 * Waiting in the foreground is the most expensive thing an agent does while
 * doing nothing.
 *
 * Measured on an adopting repo, background lane agents spent about 27% of a
 * weekly usage limit WAITING: on the pre-push gate queued behind a machine-wide
 * lock, and on CI. They waited in foreground loops -- `until ! kill -0 <pid>;
 * do sleep 20; done`, `gh pr checks --watch` -- which hit the shell tool's
 * ten-minute timeout, so the agent woke every ten minutes. A prompt cache lasts
 * five, so every wake re-paid a 400-540k-token context.
 *
 * Claude Code already wakes an agent exactly once when a `run_in_background`
 * command exits. So the cheap shape exists; this module names the expensive
 * one, narrowly, so the PreToolUse hook can deny it and say which to use.
 *
 * Narrow on purpose: an explicit list of commands whose ONLY job is to wait.
 * A denial an agent cannot predict is a tax on every command it runs.
 */

import { COMMAND_START, withoutQuotedHeredocBodies } from './shell-command.js';

/**
 * An escaped quote or backslash outside quotes -- the only escapes there that
 * change where a string starts -- a single-quoted string, or a double-quoted
 * one (whose own escapes are skipped over), each possibly unterminated. The alternatives start on different characters and the
 * double-quoted body's two branches are disjoint, so there is one parse.
 */
const QUOTED = /\\[\\'"]|'[^']*'?|"(?:\\[\s\S]|[^"\\])*"?/g;

/**
 * The command with the CONTENTS of its quoted strings removed, quotes kept.
 *
 * A wait named inside an argument -- a commit message, an `echo` -- runs
 * nothing. Double quotes honour a backslash escape, single quotes do not, as in
 * the shell. An unterminated quote drops the rest of the command: a guess here
 * can only cost a missed denial, never a spurious one.
 */
export function withoutQuotedText(command: string): string {
  return command.replaceAll(QUOTED, (quoted) => {
    const [open = ''] = quoted;
    if (open === '\\') {
      return quoted;
    }
    return quoted.length > 1 && quoted.endsWith(open) ? `${open}${open}` : open;
  });
}

const GH_PR_CHECKS_WATCH = new RegExp(
  String.raw`${COMMAND_START}gh[ \t]+pr[ \t]+checks\b[^\n;&|]*[ \t]--watch\b`,
);

const GH_RUN_WATCH = new RegExp(
  String.raw`${COMMAND_START}gh[ \t]+run[ \t]+watch\b`,
);

/**
 * An `until`/`while` loop, capturing its condition: everything up to the `;`
 * or newline before its `do`.
 */
const WAIT_LOOP = new RegExp(
  String.raw`${COMMAND_START}(?:until|while)[ \t]([^;\n]*)`,
  'g',
);

/**
A condition that polls a process for liveness.
*/
const PROCESS_POLL = /\bkill[ \t]+-0\b|\bpgrep\b/;

/**
 * A `sleep` in command position -- also straight after `do`, `then` or `else`,
 * where a polling loop puts it. Captures the number and its unit.
 */
const SLEEP = new RegExp(
  String.raw`${COMMAND_START}(?:(?:do|then|else)[ \t]+)?sleep[ \t]+(\d+(?:\.\d+)?)([smhd]?)(?![\w.])`,
  'g',
);

/**
 * Seconds per `sleep` unit. A bare number is seconds, which is the fallback
 * below rather than an entry here.
 */
const SECONDS_PER_UNIT: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
};

/**
 * `guardrails ship`, however the CLI is reached: by bin name, through `npx`,
 * or as `node <path>/cli.mjs` (the `node -e "import(...)"` form reads as
 * `node -e "" guardrails ship` once its quoted text is gone).
 */
const SHIP = new RegExp(
  String.raw`${COMMAND_START}(?:npx[ \t]+|node[ \t]+[^\n;&|]*[ \t/])?(?:guardrails(?:-core)?|cli\.mjs)[ \t]+ship\b`,
);

function longSleep(text: string, limitSeconds: number): string | undefined {
  for (const [, amount = '', unit = ''] of text.matchAll(SLEEP)) {
    if (Number(amount) * (SECONDS_PER_UNIT[unit] ?? 1) > limitSeconds) {
      return `sleep ${amount}${unit}`;
    }
  }
  return undefined;
}

function isPollingLoop(text: string): boolean {
  return text
    .matchAll(WAIT_LOOP)
    .some(([, condition = '']) => PROCESS_POLL.test(condition));
}

/**
 * The foreground wait this command would run, named for the denial message, or
 * `undefined` when it runs none. `sleepLimitSeconds` is the longest `sleep`
 * that still counts as a pause.
 *
 * A command that starts itself detached -- `nohup npx guardrails ship … &`,
 * `setsid gh run watch … &`, `nohup sh -c "until …" &` -- needs no exemption:
 * every pattern here must sit at command position, and `nohup`/`setsid` or a
 * quote is what stands there. A bare `… &` has no such cover and is denied: it
 * ties the job to the shell, and on a host with no wake-on-exit the agent still
 * has to poll it.
 */
export function foregroundWait(
  command: string,
  sleepLimitSeconds: number,
): string | undefined {
  const text = withoutQuotedText(withoutQuotedHeredocBodies(command));
  if (GH_PR_CHECKS_WATCH.test(text)) {
    return 'gh pr checks --watch';
  }
  if (GH_RUN_WATCH.test(text)) {
    return 'gh run watch';
  }
  if (isPollingLoop(text)) {
    return 'a wait loop on kill -0 or pgrep';
  }
  if (SHIP.test(text)) {
    return 'guardrails ship';
  }
  return longSleep(text, sleepLimitSeconds);
}

/**
The denial, in the lines an agent needs to change what it does. Claude Code
wakes the agent once when a background command exits; Codex and Copilot have no
such wake, so the only cheap shape there is to not wait at all.
*/
export function foregroundWaitDenial(
  wait: string,
  dialect: 'claude' | 'codex' | 'copilot' = 'claude',
): string {
  if (dialect !== 'claude') {
    return (
      `guardrails: ${wait} waits inside the agent, and every check re-reads ` +
      `your whole context. Don't wait: start it detached (\`nohup … &\`) and ` +
      `finish your task; ship's outcome lands in ` +
      `.guardrails/state/ship-status.json. (Turn this off with ` +
      `"denyForegroundWaits": false.)`
    );
  }
  return (
    `guardrails: ${wait} waits in the foreground. Run it with ` +
    `run_in_background: true and end your turn; you are woken once, when it ` +
    `exits.\nA foreground wait times out and wakes you again and again, and ` +
    `every wake after the 5-minute prompt-cache window re-pays your whole ` +
    `context. (Turn this off with "denyForegroundWaits": false.)`
  );
}
