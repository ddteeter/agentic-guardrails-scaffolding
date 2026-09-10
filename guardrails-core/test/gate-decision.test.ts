import { describe, expect, it } from 'vitest';

import {
  decideGate,
  type GateConfig,
  type GateDecision,
} from '../src/gate-decision.js';
import { createSession, violationDigest } from '../src/state.js';
import { recurrenceKey, type Violation } from '../src/violation.js';

function v(partial: Partial<Violation> & Pick<Violation, 'ruleId'>): Violation {
  return {
    file: 'src/foo.ts',
    message: 'boom',
    severity: 'error',
    fixable: false,
    tool: 'eslint',
    ...partial,
  };
}

const config: GateConfig = {
  maxAttempts: 3,
  recurThreshold: 3,
  graduationThreshold: 3,
  fastFixer: 'guardrail-fixer',
  thoroughFixer: 'guardrail-fixer-thorough',
};

// The path `state-store.ts` actually writes. The old fixture used
// `.claude/state/guardrails/...`, the same stale location #39 found in
// docs/live-loop-verification.md -- a fixture is documentation too.
const manifestPath = '.guardrails/state/sid.last.json';

function input(overrides: Partial<Parameters<typeof decideGate>[0]> = {}) {
  return {
    violations: [v({ ruleId: 'no-console' })],
    session: createSession(),
    recurrence: {},
    manifestPath,
    config,
    ...overrides,
  };
}

describe('decideGate — clean', () => {
  it('does not block and resets the attempt counter when there are no errors', () => {
    const decision = decideGate(
      input({
        violations: [v({ ruleId: 'x', severity: 'warn' })],
        session: { attempts: 2, ruleCounts: {}, corrected: [] },
      }),
    );
    expect(decision.outcome).toBe('clean');
    expect(decision.block).toBe(false);
    expect(decision.nextSession.attempts).toBe(0);
    expect(decision.nextSession.escalated).toBe(false);
  });
});

describe('decideGate — delegate', () => {
  it('blocks with a terse pointer that forbids reading the manifest', () => {
    const decision = decideGate(input());
    expect(decision.outcome).toBe('delegate');
    expect(decision.block).toBe(true);
    expect(decision.fixerAgent).toBe('guardrail-fixer');
    expect(decision.message).toContain(manifestPath);
    expect(decision.message).toContain('Do NOT read');
    expect(decision.message).toContain('guardrail-fixer');
    expect(decision.additionalContext).toBeUndefined();
  });

  it('tallies rule-keys and bumps the attempt counter', () => {
    const decision = decideGate(input());
    expect(decision.nextSession.attempts).toBe(1);
    expect(decision.nextSession.ruleCounts).toEqual({ 'no-console': 1 });
  });

  it('names the thorough fixer on the final attempt', () => {
    const decision = decideGate(
      input({ session: { attempts: 2, ruleCounts: {}, corrected: [] } }),
    );
    // attempts becomes 3 === maxAttempts → last delegation.
    expect(decision.fixerAgent).toBe('guardrail-fixer-thorough');
  });

  it('routes a loose-class violation to the thorough fixer from attempt 1', () => {
    const decision = decideGate(
      input({
        violations: [
          v({ ruleId: 'ordinary' }),
          v({ ruleId: 'arch/layer-access' }),
        ],
        config: {
          ...config,
          isLoose: (violation) => violation.ruleId.startsWith('arch/'),
        },
      }),
    );
    expect(decision.nextSession.attempts).toBe(1);
    expect(decision.fixerAgent).toBe('guardrail-fixer-thorough');
  });
});

describe('decideGate — escalate', () => {
  it('stops hiding and hands the full dump to the main agent past MAX', () => {
    const decision = decideGate(
      input({
        violations: [v({ ruleId: 'no-console', file: 'src/a.ts', line: 9 })],
        session: { attempts: 3, ruleCounts: {}, corrected: [] },
      }),
    );
    expect(decision.outcome).toBe('escalate');
    expect(decision.block).toBe(true);
    expect(decision.fixerAgent).toBeUndefined();
    expect(decision.message).toContain('no-console');
    expect(decision.message).toContain('src/a.ts');
    expect(decision.additionalContext).toBeUndefined();
    // The full dump arms a terminal release instead of restarting forever.
    expect(decision.nextSession.attempts).toBe(0);
    expect(decision.nextSession.escalated).toBe(true);
    // No fixer is in flight on this path, so the caveat block must be entirely
    // absent -- not just missing its "may still be running" phrase. Pins the
    // exact rendering so an empty-array regression (e.g. a stray placeholder
    // line) is caught even though it wouldn't match that phrase.
    expect(decision.message).toBe(
      '1 violation(s) survived the fix loop. Resolve them directly:\n' +
        '- src/a.ts:9 [no-console] boom (eslint)',
    );
  });

  /**
   * Escalation hands the violations to the MAIN agent to edit directly. When it
   * fires on a retry whose manifest is unchanged, the fixer from the previous
   * attempt has not reported yet — so the agent is being told to edit files a
   * subagent is still editing.
   *
   * Observed live: the main agent followed the instruction, its edit raced the
   * fixer's, and it survived only because the stale text no longer matched.
   * The `delegate` path already guards this case (`unchangedPointer`); this is
   * the same signal, on the exit that lacked it.
   *
   * The escalation itself is NOT withheld. An unchanged digest cannot
   * distinguish "fixer still running" from "fixer finished and achieved
   * nothing", so waiting for a change that may never come would trade a race
   * for a hang. The budget is spent either way; what changes is that the agent
   * is told to let the in-flight fixer land first.
   */
  it('warns that a fixer may still be running when the manifest is unchanged', () => {
    const violations = [v({ ruleId: 'no-console', file: 'src/a.ts', line: 9 })];
    const decision = decideGate(
      input({
        violations,
        isRetry: true,
        session: {
          attempts: 3,
          ruleCounts: {},
          corrected: [],
          lastViolationDigest: violationDigest(violations),
        },
      }),
    );
    expect(decision.outcome).toBe('escalate');
    // The dump is still there — the agent still needs to know what to fix.
    expect(decision.message).toContain('no-console');
    expect(decision.message).toContain('src/a.ts');
    // ...but it is told to let the in-flight fixer land first.
    expect(decision.message).toContain('may still be running');
    expect(decision.message).toContain('guardrail-fixer-thorough');
  });

  it('does not warn when the manifest changed, so no fixer is in flight', () => {
    // A different digest proves the previous fixer's edit landed. Warning here
    // would train the agent to ignore the warning in the case that matters.
    const decision = decideGate(
      input({
        violations: [v({ ruleId: 'no-console', file: 'src/a.ts', line: 9 })],
        isRetry: true,
        session: {
          attempts: 3,
          ruleCounts: {},
          corrected: [],
          lastViolationDigest: 'something-else',
        },
      }),
    );
    expect(decision.outcome).toBe('escalate');
    expect(decision.message).toContain('no-console');
    expect(decision.message).not.toContain('may still be running');
  });

  it('does not warn on a first Stop, which has no fixer in flight', () => {
    const violations = [v({ ruleId: 'no-console', file: 'src/a.ts', line: 9 })];
    const decision = decideGate(
      input({
        violations,
        session: {
          attempts: 3,
          ruleCounts: {},
          corrected: [],
          lastViolationDigest: violationDigest(violations),
        },
      }),
    );
    expect(decision.outcome).toBe('escalate');
    expect(decision.message).not.toContain('may still be running');
  });

  it('renders an unknown line explicitly in the terminal dump', () => {
    const decision = decideGate(
      input({ session: { ...createSession(), attempts: 3 } }),
    );
    expect(decision.message).toContain('src/foo.ts:?');
  });

  it('releases the retry after the main agent received the full dump', () => {
    const decision = decideGate(
      input({
        session: {
          ...createSession(),
          escalated: true,
        },
        isRetry: true,
      }),
    );
    expect(decision.outcome).toBe('release');
    expect(decision.block).toBe(false);
    expect(decision.nextSession.escalated).toBe(true);
  });

  it('starts a fresh bounded loop on a later non-retry turn', () => {
    const decision = decideGate(
      input({
        session: {
          ...createSession(),
          escalated: true,
        },
        isRetry: false,
      }),
    );
    expect(decision.outcome).toBe('delegate');
    expect(decision.nextSession.escalated).toBe(false);
  });
});

describe('decideGate — recurrence injection', () => {
  it('does not count fixer retries as separate recurring mistakes', () => {
    const decision = decideGate(
      input({
        session: {
          ...createSession(),
          attempts: 1,
          ruleCounts: { 'no-console': 1 },
        },
        isRetry: true,
      }),
    );
    expect(decision.nextSession.attempts).toBe(2);
    expect(decision.nextSession.ruleCounts).toEqual({ 'no-console': 1 });
    expect(decision.additionalContext).toBeUndefined();
  });

  it('injects a behavioral correction when a rule crosses the session threshold', () => {
    // Two prior turns already tallied this rule; this is the third.
    const decision = decideGate(
      input({
        session: {
          attempts: 1,
          ruleCounts: { 'no-console': 2 },
          corrected: [],
        },
      }),
    );
    expect(decision.additionalContext).toBeDefined();
    expect(decision).toHaveProperty('additionalContext');
    expect(decision.additionalContext).toContain('no-console');
    expect(decision.nextSession.corrected).toContain('no-console');
    // Cross-session recurrence incremented for the crossed key.
    expect(decision.nextRecurrence['no-console']).toBe(1);
  });

  it('retains recurrence context when escalation happens on the same stop', () => {
    const decision = decideGate(
      input({
        session: {
          ...createSession(),
          attempts: 3,
          ruleCounts: { 'no-console': 2 },
        },
      }),
    );
    expect(decision.outcome).toBe('escalate');
    expect(decision.additionalContext).toContain('3 separate turns');
  });

  it('does not re-inject a correction already given this session', () => {
    const decision = decideGate(
      input({
        session: {
          attempts: 1,
          ruleCounts: { 'no-console': 3 },
          corrected: ['no-console'],
        },
      }),
    );
    expect(decision.additionalContext).toBeUndefined();
  });

  it('suggests graduation once cross-session recurrence is high enough', () => {
    const decision = decideGate(
      input({
        session: {
          attempts: 1,
          ruleCounts: { 'no-console': 2 },
          corrected: [],
        },
        recurrence: { 'no-console': 2 },
      }),
    );
    // bumped to 3 === graduationThreshold → suggest graduation.
    expect(decision.additionalContext).toContain('CLAUDE.md');
  });
});

describe('per-package recurrence', () => {
  const base = {
    ruleId: 'no-console',
    file: 'a.ts',
    message: 'msg',
    severity: 'error' as const,
    fixable: false,
    tool: 'eslint',
  };

  it('keys the same rule separately in different packages', () => {
    // The whole point of attribution: a rule recurring in one package must not
    // be diluted across the repo, which is what recurrence-as-signal measures.
    const api: Violation = { ...base, package: 'packages/api' };
    const web: Violation = { ...base, package: 'packages/web' };
    expect(recurrenceKey(api)).not.toBe(recurrenceKey(web));
    expect(recurrenceKey(api)).toBe('packages/api:no-console');
  });

  it('keys on the bare ruleId when there is no package', () => {
    expect(recurrenceKey(base)).toBe('no-console');
  });
});

describe('decideGate: a retry that changed nothing', () => {
  const blocked = v({ ruleId: 'eslint/no-console', file: 'src/a.ts', line: 3 });
  const stuck: Violation[] = [blocked];

  /** Drive the loop the way a host actually does: block, then retry with the
   *  session the previous decision produced. */
  function retryWith(violations: Violation[]): GateDecision {
    const first = decideGate({
      violations: stuck,
      session: createSession(),
      recurrence: {},
      manifestPath,
      config,
    });
    return decideGate({
      violations,
      session: first.nextSession,
      recurrence: {},
      manifestPath,
      config,
      isRetry: true,
    });
  }

  it('says the manifest is unchanged instead of repeating the spawn order', () => {
    // Reported from a live adoption (#39): the fixer subagent runs in the
    // background, so the natural next move -- try to stop again -- re-fires the
    // gate while it is still working. The old message was byte-identical to the
    // first block, so an agent following it literally spawned a SECOND fixer
    // against the same manifest, racing edits on the same files.
    const message = retryWith(stuck).message;

    expect(message).toMatch(/unchanged/i);
    expect(message).not.toMatch(/Spawn the \S+ subagent/);
  });

  it('still names the manifest and the fixer, so the turn can proceed', () => {
    // "Wait" must not mean "and now you have no information": if the fixer
    // really did finish and no-op, the agent still needs to know what to spawn.
    const decision = retryWith(stuck);

    expect(decision.message).toContain(manifestPath);
    expect(decision.fixerAgent).toBe('guardrail-fixer');
    expect(decision.outcome).toBe('delegate');
    expect(decision.block).toBe(true);
  });

  it('gives the normal spawn instruction when the fixer DID change something', () => {
    // The counterweight: a retry whose manifest differs means the fixer ran and
    // made progress, and the loop must keep going without hesitation.
    const progressed: Violation[] = [
      { ...blocked, ruleId: 'eslint/prefer-const', line: 12 },
    ];
    const message = retryWith(progressed).message;

    expect(message).toMatch(/Spawn the \S+ subagent/);
    expect(message).not.toMatch(/unchanged/i);
  });

  it('does not warn on the FIRST block, which no fixer has seen yet', () => {
    const first = decideGate({
      violations: stuck,
      session: createSession(),
      recurrence: {},
      manifestPath,
      config,
    });

    expect(first.message).toMatch(/Spawn the \S+ subagent/);
    expect(first.message).not.toMatch(/unchanged/i);
  });
});
