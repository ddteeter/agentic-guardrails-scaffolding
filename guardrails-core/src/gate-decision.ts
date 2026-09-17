/**
 * The gate decision engine (§2.1) — pure logic shared by the Claude Code
 * stop-gate and the Copilot commit-gate. Given the current violations, the
 * loaded session tally, and cross-session recurrence, it decides whether to
 * let the turn end (clean), divert the fix to a restricted fixer subagent
 * (delegate), or stop hiding and hand the main agent an aggregate plus the
 * manifest path to resolve itself (escalate) — and computes the next persisted
 * state.
 *
 * Keeping this a pure function means the whole control loop is unit-testable
 * without a filesystem, a git repo, or a running agent.
 */

import {
  bumpRecurrence,
  forgiveAttempt,
  graduationCandidates,
  incrementAttempt,
  markCorrected,
  newlyCrossed,
  recordViolations,
  resetAttempts,
  type RecurrenceCounts,
  type SessionState,
  violationDelta,
  type ViolationDelta,
  violationDigest,
  violationKey,
  violationKeys,
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

/**
 * How many attempts one fix loop may forgive before a regression starts costing
 * budget like any other failure.
 *
 * One, and bounded on purpose. Forgiveness exists so a fixer cannot walk the
 * ladder to escalation on damage it caused itself; an unbounded version instead
 * hands a fixer that breaks something DIFFERENT on every retry an endless loop,
 * because `isStalled` only recognises a regression that repeats itself
 * verbatim. With a ceiling of one, a loop fires at most `maxAttempts + 2` times
 * whatever the fixer does.
 */
const MAX_FORGIVEN_ATTEMPTS = 1;

/**
 * The delegate message for a retry whose previous attempt introduced findings
 * its own manifest did not contain (#81).
 *
 * The main agent currently has to work this out by reading the fixer's report
 * against its own memory of the file. Saying it here costs two clauses, and it
 * is the difference between "this violation class is hard" and "the last fixer
 * broke something" — which are different problems with different next moves.
 *
 * It stays a POINTER: the new findings are still a fixer's work, and the
 * manifest still holds them. What changes is that the fixer is told the new
 * findings are the previous one's damage, so it undoes them rather than builds
 * on them.
 */
function regressionPointer(
  violations: readonly Violation[],
  manifestPath: string,
  fixerAgent: string,
  regression: ViolationDelta,
): string {
  const introducedKeys = new Set(regression.introduced);
  const introduced = violations.filter((violation) =>
    introducedKeys.has(violationKey(violation)),
  );
  return (
    `The last fixer resolved ${regression.resolved.length} and introduced ` +
    `${regression.introduced.length} violation(s) that were not in the ` +
    `manifest it was given (${ruleBreakdown(introduced)}) — its own ` +
    `regression, not a harder problem. ${violations.length} guardrail ` +
    `violation(s) now in ${manifestPath}. Do NOT read it. Spawn the ` +
    `${fixerAgent} subagent, give it that path, and tell it the findings it ` +
    `did not inherit are the previous fixer's damage: undo those rather than ` +
    `build on them. Then try to stop again.`
  );
}

interface DelegatePointerInput {
  violations: readonly Violation[];
  manifestPath: string;
  fixerAgent: string;
  /**
  The manifest is identical to the previous block's.
  */
  isStalled: boolean;
  /** Present only when the previous attempt was net damage — see
   *  `regressionPointer`. */
  regression: ViolationDelta | undefined;
}

/**
 * Which of the three delegate messages this block gets. Ordered by how much the
 * signal constrains the next move: an unchanged manifest means do nothing yet,
 * a regression means spawn the thorough tier and tell it what it is looking at,
 * and otherwise the loop proceeds normally.
 */
function delegatePointer(input: DelegatePointerInput): string {
  const { violations, manifestPath, fixerAgent, regression } = input;
  if (input.isStalled) {
    return unchangedPointer(violations.length, manifestPath, fixerAgent);
  }
  if (regression !== undefined) {
    return regressionPointer(violations, manifestPath, fixerAgent, regression);
  }
  return tersePointer(violations.length, manifestPath, fixerAgent);
}

/**
 * How many distinct rule-ids the escalation names before it stops enumerating.
 *
 * A bound rather than the full set, because the set is what this message must
 * not be: an escalation on a wide manifest can span a dozen rules, and a dozen
 * `rule ×n` pairs is the enumeration again in a thinner disguise. Four names
 * the shape of the work ("mostly surviving mutants, plus some tsc") and the
 * tail is a count.
 */
const MAX_NAMED_RULES = 4;

/**
 * `ruleId ×count` for the most frequent rules, most frequent first, with the
 * tail collapsed into a count. Ties break on the rule-id so the string is
 * deterministic — this text is asserted on, and an order that depended on
 * analyzer emission order would make those assertions flaky.
 */
function ruleBreakdown(violations: readonly Violation[]): string {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    counts.set(violation.ruleId, (counts.get(violation.ruleId) ?? 0) + 1);
  }
  const ordered = [...counts].toSorted((left, right) => {
    const byCount = right[1] - left[1];
    return byCount === 0 ? left[0].localeCompare(right[0]) : byCount;
  });
  const named = ordered
    .slice(0, MAX_NAMED_RULES)
    .map(([ruleId, count]) => `${ruleId} ×${count}`);
  const remaining = ordered.length - named.length;
  return remaining > 0
    ? [...named, `+${remaining} more rule(s)`].join(', ')
    : named.join(', ');
}

/**
 * The terminal hand-back: the fixer ladder is spent, so the MAIN agent gets the
 * violations to resolve itself.
 *
 * It gets an AGGREGATE and the manifest path, not the violations themselves
 * (#80). This message fires only after both fixer tiers are spent — i.e. on the
 * hardest manifests, which are also the longest — so enumerating here made the
 * design's context discipline strongest when the work was easy and absent when
 * it was hard; 17 violations landing inline in the main thread was observed in
 * a live adoption. The manifest holds every detail this summary elides, and
 * this is the one moment at which the main agent reading it is correct: there
 * is no fixer left to read it instead.
 *
 * `inFlightFixer` names a fixer that has not reported yet, and is present only
 * when this escalation fires on a retry whose manifest is unchanged. That is
 * the same signal `unchangedPointer` reads on the delegate path, and it matters
 * here for the same reason: resolving them directly sends the main agent into
 * files a subagent may still be editing, and two writers on one file lose each
 * other's work. Observed live — the main agent's edit raced a running fixer's
 * and survived only because the stale text no longer matched.
 *
 * The escalation is NOT withheld while a fixer is in flight. An unchanged
 * digest cannot distinguish "still running" from "finished and achieved
 * nothing", so waiting for a change that may never arrive would trade a race
 * for a hang, and the attempt budget is spent either way. What changes is that
 * the agent is told to let the in-flight fixer land before it starts editing.
 */
function escalationPointer(
  violations: readonly Violation[],
  manifestPath: string,
  inFlightFixer?: string,
): string {
  const files = new Set(violations.map((violation) => violation.file));
  const caveat =
    inFlightFixer === undefined
      ? []
      : [
          `NOTE: the ${inFlightFixer} from the last attempt may still be ` +
            `running — the manifest has not changed since the previous block. ` +
            `Wait for it to report before editing those files yourself; its ` +
            `edits and yours would race.`,
        ];
  return [
    `${violations.length} violation(s) survived the fix loop across ` +
      `${files.size} file(s): ${ruleBreakdown(violations)}. ` +
      `Read the manifest at ${manifestPath} and resolve them directly — ` +
      `a spent fix loop is the one point at which reading it is correct. ` +
      `Prefer the smallest targeted edit that resolves each one.`,
    ...caveat,
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

/**
 * The previous attempt's delta, but ONLY when it was net damage: something
 * introduced and nothing resolved.
 *
 * Partial progress is progress — a fixer that resolved three and introduced one
 * moved the loop forward and spends its attempt like any other. The case this
 * names is the one the budget could not see: an attempt whose entire effect was
 * to add findings its own manifest never contained.
 *
 * `undefined` rather than an empty delta, so every caller reads the same
 * question ("was this a regression?") off the same value.
 */
function netDamage(
  session: SessionState,
  violations: readonly Violation[],
  isRetry: boolean,
): ViolationDelta | undefined {
  const previous = session.lastViolationKeys;
  if (!isRetry || previous === undefined) {
    return undefined;
  }
  const delta = violationDelta(previous, violationKeys(violations));
  return delta.introduced.length > 0 && delta.resolved.length === 0
    ? delta
    : undefined;
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

  // The main agent received the escalation pointer on the preceding blocked
  // Stop. If it still cannot resolve the violation, release this retry and
  // leave the commit/CI gate as the hard backstop. Without this terminal state,
  // resetting attempts after escalation restarts the fixer ladder forever.
  if (isRetry && session.escalated) {
    return {
      outcome: 'release',
      block: false,
      message: escalationPointer(violations, manifestPath),
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

  // What the PREVIOUS attempt did, not merely that it changed something (#81).
  // Absent on a first block, and on a session written before the identities
  // were persisted — in both cases there is nothing to have regressed from.
  const regression = netDamage(session, violations, isRetry);
  // A fixer that only broke things has not shown the violation is hard, so the
  // attempt is not charged — up to `MAX_FORGIVEN_ATTEMPTS`, which is what keeps
  // the ladder finite when the damage is different every time.
  const isForgiven =
    regression !== undefined &&
    (tallied.forgivenAttempts ?? 0) < MAX_FORGIVEN_ATTEMPTS;
  const bumped = isForgiven
    ? forgiveAttempt(tallied)
    : incrementAttempt(tallied);
  const attempt = bumped.attempts;

  const crossed = newlyCrossed(bumped, config.recurThreshold);
  const corrected = markCorrected(bumped, crossed);
  const nextRecurrence = bumpRecurrence(recurrence, crossed);
  const graduation = graduationCandidates(
    nextRecurrence,
    config.graduationThreshold,
  );
  const additionalContext = buildContext(crossed, corrected, graduation);

  const isLoose = violations.some((violation) => config.isLoose?.(violation));
  // A regression routes to the thorough tier immediately, whatever the attempt
  // or the rule class: the fast tier has already damaged this tree once.
  const fixerAgent =
    isLoose || regression !== undefined || attempt >= config.maxAttempts
      ? config.thoroughFixer
      : config.fastFixer;

  // Identical manifest on a retry means no fixer edit has landed yet. Read by
  // BOTH exits below: `unchangedPointer` on the delegate path, and the
  // in-flight caveat on the escalate path. See `unchangedPointer` and
  // `escalationPointer`.
  const digest = violationDigest(violations);
  const isStalled = isRetry && session.lastViolationDigest === digest;

  if (attempt > config.maxAttempts) {
    return withOptional(
      {
        outcome: 'escalate',
        block: true,
        message: escalationPointer(
          violations,
          manifestPath,
          isStalled ? fixerAgent : undefined,
        ),
        nextSession: { ...resetAttempts(corrected), escalated: true },
        nextRecurrence,
      },
      { additionalContext },
    );
  }

  return withOptional(
    {
      outcome: 'delegate',
      block: true,
      message: delegatePointer({
        violations,
        manifestPath,
        fixerAgent,
        isStalled,
        regression,
      }),
      nextSession: {
        ...corrected,
        lastViolationDigest: digest,
        lastViolationKeys: violationKeys(violations),
      },
      nextRecurrence,
    },
    { additionalContext, fixerAgent },
  );
}
