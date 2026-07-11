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
}

export type GateOutcome = 'clean' | 'delegate' | 'escalate';

export interface GateDecision {
  outcome: GateOutcome;
  /** Whether to block the Stop (Claude Code) / deny the commit (Copilot). */
  block: boolean;
  message: string;
  additionalContext?: string;
  fixerAgent?: string;
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
    const count = session.ruleCounts[key] ?? 0;
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
    ...(extras.additionalContext === undefined
      ? {}
      : { additionalContext: extras.additionalContext }),
    ...(extras.fixerAgent === undefined
      ? {}
      : { fixerAgent: extras.fixerAgent }),
  };
}

export function decideGate(input: GateInput): GateDecision {
  const { violations, session, recurrence, manifestPath, config } = input;

  if (!hasErrors(violations)) {
    return {
      outcome: 'clean',
      block: false,
      message: '',
      nextSession: resetAttempts(session),
      nextRecurrence: recurrence,
    };
  }

  const tallied = recordViolations(session, violations);
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
        nextSession: resetAttempts(corrected),
        nextRecurrence,
      },
      { additionalContext },
    );
  }

  const loose = violations.some((violation) => config.isLoose?.(violation));
  const fixerAgent =
    loose || attempt >= config.maxAttempts
      ? config.thoroughFixer
      : config.fastFixer;

  return withOptional(
    {
      outcome: 'delegate',
      block: true,
      message: tersePointer(violations.length, manifestPath, fixerAgent),
      nextSession: corrected,
      nextRecurrence,
    },
    { additionalContext, fixerAgent },
  );
}
