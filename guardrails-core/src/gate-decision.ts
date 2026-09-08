/**
 * The gate decision engine (§2.1) — pure logic shared by the Claude Code
 * stop-gate and the Copilot commit-gate. Given the current violations, the
 * loaded session tally, and cross-session recurrence, it decides whether to
 * let the turn end (clean), divert the fix to a restricted fixer subagent
 * (delegate), or stop hiding and hand the full dump to the main agent
 * (escalate) — and computes the next persisted state.
 *
 * Keeping this a pure function means the whole control loop is unit-testable
 * without a filesystem, a git repo, or a running agent.
 */

import {
  bumpRecurrence,
  graduationCandidates,
  incrementAttempt,
  markCorrected,
  newlyCrossed,
  recordViolations,
  resetAttempts,
  type RecurrenceCounts,
  type SessionState,
  violationDigest,
} from './state.js';
import { hasErrors, type Violation } from './violation.js';

export interface GateConfig {
  maxAttempts: number;
  recurThreshold: number;
  graduationThreshold: number;
  fastFixer: string;
  thoroughFixer: string;
  /**
   * Classifies a violation as "loose" — a class where a green fix can be far
   * from a good one (architecture, mutants, logic-revealing type errors,
   * maybe-live dead code). Loose classes route above the bottom tier from
   * attempt 1. Safety mechanism, not an optimization (§2.3).
   */
  isLoose?: (violation: Violation) => boolean;
}

export interface GateInput {
  violations: Violation[];
  session: SessionState;
  recurrence: RecurrenceCounts;
  manifestPath: string;
  config: GateConfig;
  /** True when the host is retrying because this Stop hook already blocked the
   * turn. Retry cycles spend attempts but are not separate recurring mistakes. */
  isRetry?: boolean | undefined;
}

export type GateOutcome = 'clean' | 'delegate' | 'escalate' | 'release';

export interface GateDecision {
  outcome: GateOutcome;
  /**
  Whether to block the Stop (Claude Code) / deny the commit (Copilot).
  */
  block: boolean;
  message: string;
  additionalContext?: string | undefined;
  fixerAgent?: string | undefined;
  nextSession: SessionState;
  nextRecurrence: RecurrenceCounts;
}

function tersePointer(
  count: number,
  manifestPath: string,
  fixerAgent: string,
): string {
  return (
    `${count} guardrail violation(s) written to ${manifestPath}. ` +
    `Do NOT read it. Spawn the ${fixerAgent} subagent and give it that path ` +
    `to fix. Then try to stop again.`
  );
}

/**
 * The message for a retry whose manifest is IDENTICAL to the one the previous
 * block reported — reported from a live adoption (#39).
 *
 * The fixer subagent runs in the background, so the move `tersePointer` asks
 * for next ("then try to stop again") naturally re-fires the gate while the
 * fixer is still working. Repeating the spawn instruction verbatim there is an
 * instruction to spawn a SECOND fixer against the same manifest, and an agent
 * following it literally does exactly that — two fixers racing edits on the
 * same files.
 *
 * So this says the one thing the identical manifest actually proves: nothing
 * has changed yet. It still names the manifest and the fixer, because the other
 * reading is live too — the fixer may have finished having achieved nothing, in
 * which case the agent needs to know what to spawn once it has confirmed that.
 * What it deliberately does NOT do is repeat an unconditional order to spawn.
 */
function unchangedPointer(
  count: number,
  manifestPath: string,
  fixerAgent: string,
): string {
  return (
    `${count} guardrail violation(s) in ${manifestPath} — UNCHANGED since the ` +
    `last block. Do NOT read it, and do NOT spawn another fixer yet: a ` +
    `${fixerAgent} you already spawned is most likely still running. Wait for ` +
    `it to report, then try to stop again. Only if it has already finished and ` +
    `changed nothing should you spawn a fresh ${fixerAgent} against that path.`
  );
}

function fullDump(violations: readonly Violation[]): string {
  const lines = violations.map(
    (violation) =>
      `- ${violation.file}:${violation.line ?? '?'} [${violation.ruleId}] ` +
      `${violation.message} (${violation.tool})`,
  );
  return [
    `${violations.length} violation(s) survived the fix loop. Resolve them directly:`,
    ...lines,
  ].join('\n');
}

function buildContext(
  crossed: readonly string[],
  session: SessionState,
  graduation: readonly string[],
): string | undefined {
  const parts: string[] = [];
  for (const key of crossed) {
    const count = session.ruleCounts[key];
    parts.push(
      `Rule "${key}" has failed verification in ${count} separate turns this ` +
        `session. Address the underlying pattern rather than patching each ` +
        `instance.`,
    );
  }
  if (graduation.length > 0) {
    parts.push(
      `These rules keep recurring across sessions: ${graduation.join(', ')}. ` +
        `Consider graduating them into CLAUDE.md or a hard gate.`,
    );
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function withOptional(
  base: Omit<GateDecision, 'additionalContext' | 'fixerAgent'>,
  extras: {
    additionalContext?: string | undefined;
    fixerAgent?: string | undefined;
  },
): GateDecision {
  return {
    ...base,
    additionalContext: extras.additionalContext,
    fixerAgent: extras.fixerAgent,
  };
}

export function decideGate(input: GateInput): GateDecision {
  const {
    violations,
    session,
    recurrence,
    manifestPath,
    config,
    isRetry = false,
  } = input;

  if (!hasErrors(violations)) {
    return {
      outcome: 'clean',
      block: false,
      message: '',
      nextSession: { ...resetAttempts(session), escalated: false },
      nextRecurrence: recurrence,
    };
  }

  // The main agent received the full dump on the preceding blocked Stop. If it
  // still cannot resolve the violation, release this retry and leave the
  // commit/CI gate as the hard backstop. Without this terminal state, resetting
  // attempts after escalation restarts the fixer ladder forever.
  if (isRetry && session.escalated) {
    return {
      outcome: 'release',
      block: false,
      message: fullDump(violations),
      nextSession: session,
      nextRecurrence: recurrence,
    };
  }

  // A later user turn gets a fresh bounded attempt rather than permanently
  // disabling the Stop gate after one hard case.
  const activeSession = session.escalated
    ? { ...session, escalated: false }
    : session;
  // One mistake may cause several fixer retries. Recurrence is intended to
  // measure separate turns, so only the host's first Stop tallies the rule.
  const tallied = isRetry
    ? activeSession
    : recordViolations(activeSession, violations);
  const bumped = incrementAttempt(tallied);
  const attempt = bumped.attempts;

  const crossed = newlyCrossed(bumped, config.recurThreshold);
  const corrected = markCorrected(bumped, crossed);
  const nextRecurrence = bumpRecurrence(recurrence, crossed);
  const graduation = graduationCandidates(
    nextRecurrence,
    config.graduationThreshold,
  );
  const additionalContext = buildContext(crossed, corrected, graduation);

  if (attempt > config.maxAttempts) {
    return withOptional(
      {
        outcome: 'escalate',
        block: true,
        message: fullDump(violations),
        nextSession: { ...resetAttempts(corrected), escalated: true },
        nextRecurrence,
      },
      { additionalContext },
    );
  }

  const isLoose = violations.some((violation) => config.isLoose?.(violation));
  const fixerAgent =
    isLoose || attempt >= config.maxAttempts
      ? config.thoroughFixer
      : config.fastFixer;

  // Identical manifest on a retry means no fixer edit has landed yet. See
  // `unchangedPointer`.
  const digest = violationDigest(violations);
  const isStalled = isRetry && session.lastViolationDigest === digest;

  return withOptional(
    {
      outcome: 'delegate',
      block: true,
      message: isStalled
        ? unchangedPointer(violations.length, manifestPath, fixerAgent)
        : tersePointer(violations.length, manifestPath, fixerAgent),
      nextSession: { ...corrected, lastViolationDigest: digest },
      nextRecurrence,
    },
    { additionalContext, fixerAgent },
  );
}
