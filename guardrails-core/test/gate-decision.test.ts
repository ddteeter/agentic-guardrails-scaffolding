import { describe, expect, it } from 'vitest';

import {
  decideGate,
  leaseWaitNote,
  type GateConfig,
  type GateDecision,
} from '../src/gate-decision.js';
import {
  createSession,
  type LeaseOverlap,
  violationDigest,
  violationKeys,
} from '../src/state.js';
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
  it('hands the main agent an aggregate and the manifest path past MAX', () => {
    const decision = decideGate(
      input({
        violations: [v({ ruleId: 'no-console', file: 'src/a.ts', line: 9 })],
        session: { attempts: 3, ruleCounts: {}, corrected: [] },
      }),
    );
    expect(decision.outcome).toBe('escalate');
    expect(decision.block).toBe(true);
    expect(decision.fixerAgent).toBeUndefined();
    expect(decision.additionalContext).toBeUndefined();
    // The escalation arms a terminal release instead of restarting forever.
    expect(decision.nextSession.attempts).toBe(0);
    expect(decision.nextSession.escalated).toBe(true);
    // No fixer is in flight on this path, so the caveat block must be entirely
    // absent -- not just missing its "may still be running" phrase. Pins the
    // exact rendering so an empty-array regression (e.g. a stray placeholder
    // line) is caught even though it wouldn't match that phrase.
    expect(decision.message).toBe(
      '1 violation(s) survived the fix loop across 1 file(s): ' +
        'no-console ×1. Read the manifest at ' +
        `${manifestPath} and resolve them directly — a spent fix loop is the ` +
        'one point at which reading it is correct. Prefer the smallest ' +
        'targeted edit that resolves each one.',
    );
  });

  /**
   * #80: the escalation used to enumerate every violation inline, so the one
   * message the design cannot afford to be verbose in — it fires only after
   * BOTH fixer tiers are spent, i.e. on the hardest and therefore longest
   * manifests — was the only one that was. Observed at 17 violations dumped
   * into the main thread in one live case.
   *
   * The aggregate is strictly less context and strictly more useful: the
   * manifest it points at holds the per-violation detail the summary elides,
   * and reading it HERE is correct, because no fixer is left to read it.
   */
  it('does not enumerate the violations it is escalating', () => {
    const decision = decideGate(
      input({
        violations: [
          v({ ruleId: 'stryker/survived', file: 'src/a.ts', line: 9 }),
          v({ ruleId: 'stryker/survived', file: 'src/b.ts', line: 4 }),
          v({ ruleId: 'stryker/survived', file: 'src/b.ts', line: 7 }),
          v({ ruleId: 'no-console', file: 'src/c.ts', line: 1 }),
        ],
        session: { attempts: 3, ruleCounts: {}, corrected: [] },
      }),
    );
    expect(decision.message).not.toContain('src/a.ts');
    expect(decision.message).not.toContain('boom');
    // Counts by rule, most frequent first, so the main agent knows the shape
    // of the work before it opens the manifest.
    expect(decision.message).toContain(
      '4 violation(s) survived the fix loop across 3 file(s): ' +
        'stryker/survived ×3, no-console ×1.',
    );
    expect(decision.message).toContain(manifestPath);
  });

  it('stops naming rules past a bound, so the aggregate stays bounded', () => {
    const decision = decideGate(
      input({
        violations: ['a', 'b', 'c', 'd', 'e', 'f'].map((ruleId) =>
          v({ ruleId, file: `src/${ruleId}.ts` }),
        ),
        session: { attempts: 3, ruleCounts: {}, corrected: [] },
      }),
    );
    expect(decision.message).toContain(
      'a ×1, b ×1, c ×1, d ×1, +2 more rule(s).',
    );
    expect(decision.message).not.toContain('e ×1');
  });

  /**
   * The bound test above happens to push rule-ids in already-sorted order (all
   * counts equal to 1, so the tie-break — alphabetical — coincides with the
   * insertion order), which cannot distinguish a real frequency sort from a
   * no-op. This case sets the counts so that the FIRST-seen rule-id ('A') has
   * the LOWEST count: a correct descending sort must move it to the end, so
   * this fails under a comparator that leaves the input order unchanged
   * (whether from an emptied comparator body, a conditional collapsed to
   * `false`, or an arithmetic flip that never satisfies "should swap").
   */
  it('reorders by frequency even when the first-seen rule is least frequent', () => {
    const decision = decideGate(
      input({
        violations: [
          v({ ruleId: 'A', file: 'src/a.ts' }),
          v({ ruleId: 'B', file: 'src/b1.ts' }),
          v({ ruleId: 'B', file: 'src/b2.ts' }),
          v({ ruleId: 'B', file: 'src/b3.ts' }),
          v({ ruleId: 'C', file: 'src/c1.ts' }),
          v({ ruleId: 'C', file: 'src/c2.ts' }),
        ],
        session: { attempts: 3, ruleCounts: {}, corrected: [] },
      }),
    );
    expect(decision.message).toContain('B ×3, C ×2, A ×1');
  });

  /**
   * The tie-break half of the comparator (`byCount === 0 ? alphabetical :
   * byCount`) is a separate mutation target from the descending-frequency
   * half exercised above. A `ConditionalExpression` mutant that forces the
   * ternary's CONDITION to `false` always falls through to the `byCount`
   * branch — which is what the real condition also returns whenever counts
   * differ, so a test with no ties cannot see it. It only shows up on a real
   * tie: the mutant then returns `byCount`, which is `0` ("equal") for a tie,
   * leaving the pair in insertion order instead of sorting it alphabetically.
   * The bound test above ties every rule-id, but its insertion order is
   * already alphabetical, so it can't distinguish the two either (see its
   * comment). This test puts the alphabetically-LATER rule-id first so
   * insertion order and alphabetical order disagree.
   */
  it('breaks a tie alphabetically rather than leaving insertion order', () => {
    const decision = decideGate(
      input({
        violations: [
          v({ ruleId: 'zebra', file: 'src/z.ts' }),
          v({ ruleId: 'apple', file: 'src/a.ts' }),
        ],
        session: { attempts: 3, ruleCounts: {}, corrected: [] },
      }),
    );
    expect(decision.message).toContain('apple ×1, zebra ×1');
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
    // The pointer is still there — the agent still needs to know what to fix.
    expect(decision.message).toContain('no-console');
    expect(decision.message).toContain(manifestPath);
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
    expect(decision.message).toContain(manifestPath);
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

  it('counts distinct files, not violations, in the aggregate', () => {
    const decision = decideGate(
      input({
        violations: [
          v({ ruleId: 'no-console', file: 'src/foo.ts', line: 1 }),
          v({ ruleId: 'no-console', file: 'src/foo.ts', line: 2 }),
        ],
        session: { ...createSession(), attempts: 3 },
      }),
    );
    expect(decision.message).toContain('2 violation(s)');
    expect(decision.message).toContain('across 1 file(s)');
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

/**
 * A retry whose previous block reported `previous`, and whose manifest now
 * holds `now` — the shape every regression case below is a variation of.
 */
function afterFixer(
  previous: Violation[],
  now: Violation[],
  session: Partial<Parameters<typeof decideGate>[0]['session']> = {},
): GateDecision {
  return decideGate(
    input({
      violations: now,
      isRetry: true,
      session: {
        attempts: 1,
        escalated: false,
        forgivenAttempts: 0,
        ruleCounts: {},
        corrected: [],
        lastViolationDigest: violationDigest(previous),
        lastViolationKeys: violationKeys(previous),
        ...session,
      },
    }),
  );
}

/**
 * #81: the attempt budget spent one attempt per firing, unconditionally, so a
 * fixer that broke something walked the ladder to escalation on its own mess.
 * `lastViolationDigest` cannot see this — it answers "did anything change?" and
 * a fixer that resolves three and introduces four has certainly changed
 * something. Both escalations observed in a live adoption were this, not a
 * violation that was genuinely too hard.
 */
describe('decideGate: a retry whose fixer introduced new violations', () => {
  const inherited = v({ ruleId: 'a/one', file: 'src/a.ts', line: 1 });
  const collateral = v({ ruleId: 'tsc/2322', file: 'src/b.ts', line: 7 });

  it('does not charge the attempt to the budget', () => {
    const decision = afterFixer([inherited], [inherited, collateral]);
    expect(decision.outcome).toBe('delegate');
    expect(decision.nextSession.attempts).toBe(1);
    expect(decision.nextSession.forgivenAttempts).toBe(1);
  });

  it('routes to the thorough fixer immediately, whatever the attempt', () => {
    // A fixer that damaged the tree on a non-loose, attempt-1 manifest has
    // already shown the fast tier cannot hold this work.
    const decision = afterFixer([inherited], [inherited, collateral]);
    expect(decision.fixerAgent).toBe('guardrail-fixer-thorough');
  });

  it('says what the last attempt actually did, by rule', () => {
    const decision = afterFixer([inherited], [inherited, collateral]);
    expect(decision.message).toContain('resolved 0');
    expect(decision.message).toContain('introduced 1');
    expect(decision.message).toContain('tsc/2322 ×1');
    // The breakdown names only the violation that was actually introduced
    // (collateral) -- not `inherited`, which survived the retry unresolved.
    // A rule-breakdown built from the whole `violations` array rather than
    // the introduced subset would wrongly surface it here too.
    expect(decision.message).not.toContain('a/one');
    // Still a pointer, not a dump: the manifest is named and reading it is
    // still forbidden, because a fixer is still the one doing the work.
    expect(decision.message).toContain(manifestPath);
    expect(decision.message).toContain('Do NOT read it');
    expect(decision.message).not.toContain('src/b.ts');
  });

  it('charges the attempt when the fixer also resolved something', () => {
    // Partial progress is progress. Only a net-damage attempt -- nothing
    // resolved, something introduced -- is the fixer failing to start.
    const decision = afterFixer([inherited], [collateral]);
    expect(decision.nextSession.attempts).toBe(2);
    expect(decision.nextSession.forgivenAttempts).toBe(0);
    expect(decision.message).toMatch(/Spawn the \S+ subagent/);
    expect(decision.message).not.toContain('introduced');
  });

  it('forgives at most one attempt per fix loop', () => {
    // The loop-safety bound. `isStalled` catches a regression that repeats
    // ITSELF; nothing else stops a fixer from breaking something DIFFERENT on
    // every retry, so forgiveness has a ceiling and the ladder still ends.
    const decision = afterFixer([inherited], [inherited, collateral], {
      forgivenAttempts: 1,
    });
    expect(decision.nextSession.attempts).toBe(2);
    expect(decision.nextSession.forgivenAttempts).toBe(1);
  });

  it('still escalates once the budget is genuinely spent', () => {
    const decision = afterFixer([inherited], [inherited, collateral], {
      attempts: 3,
      forgivenAttempts: 1,
    });
    expect(decision.outcome).toBe('escalate');
  });

  it('persists the identities the next retry compares against', () => {
    const decision = afterFixer([inherited], [inherited, collateral]);
    expect(decision.nextSession.lastViolationKeys).toEqual(
      violationKeys([inherited, collateral]),
    );
  });

  it('computes no delta on a first block, which inherited nothing', () => {
    const decision = decideGate(
      input({ violations: [inherited, collateral], isRetry: false }),
    );
    expect(decision.message).toMatch(/Spawn the \S+ subagent/);
    expect(decision.nextSession.attempts).toBe(1);
    expect(decision.nextSession.forgivenAttempts).toBe(0);
  });

  it('computes no delta against a session that predates the identity list', () => {
    // Backward compatibility: state written before #81 carries a digest but no
    // identities, so the delta is unknowable and the attempt is charged as it
    // always was.
    const decision = decideGate(
      input({
        violations: [inherited, collateral],
        isRetry: true,
        session: {
          attempts: 1,
          ruleCounts: {},
          corrected: [],
          lastViolationDigest: violationDigest([inherited]),
        },
      }),
    );
    expect(decision.nextSession.attempts).toBe(2);
  });
});

/**
 * #83: `decideGate` computed the outcome, the fixer it named and the delta on
 * every firing and then threw all three away, so nothing in the loop could
 * report whether work was landing on the cheap agent. The decision carries them
 * out as one row; the CALLER persists it, so the engine stays pure.
 */
describe('decideGate: the decision log row', () => {
  it('carries the delegation and the rules behind it', () => {
    const decision = decideGate(
      input({
        violations: [
          v({ ruleId: 'stryker/survived', file: 'src/a.ts' }),
          v({ ruleId: 'stryker/survived', file: 'src/b.ts' }),
          v({ ruleId: 'no-console', file: 'src/c.ts' }),
        ],
      }),
    );
    expect(decision.log).toEqual({
      outcome: 'delegate',
      fixer: 'guardrail-fixer',
      attempt: 1,
      violations: 3,
      rules: { 'stryker/survived': 2, 'no-console': 1 },
      introduced: 0,
      resolved: 0,
      stalled: false,
    });
  });

  it('records the delta even when the attempt made partial progress', () => {
    // The regression path is not the only one worth counting: an attempt that
    // resolved two and introduced one is the tier-accuracy signal, and it never
    // reaches `regressionPointer`.
    const before = v({ ruleId: 'a/one', file: 'src/a.ts' });
    const also = v({ ruleId: 'a/two', file: 'src/a.ts' });
    const after = v({ ruleId: 'tsc/2322', file: 'src/b.ts' });
    const decision = afterFixer([before, also], [after]);
    expect(decision.log.introduced).toBe(1);
    expect(decision.log.resolved).toBe(2);
  });

  it('marks the firing whose manifest did not move', () => {
    const stuck = [v({ ruleId: 'a/one', file: 'src/a.ts' })];
    const decision = afterFixer(stuck, stuck);
    expect(decision.log.stalled).toBe(true);
    expect(decision.log.outcome).toBe('delegate');
  });

  it("names no fixer on an escalation, which is the main agent's work", () => {
    const decision = decideGate(
      input({ session: { ...createSession(), attempts: 3 } }),
    );
    expect(decision.log.outcome).toBe('escalate');
    expect(decision.log.fixer).toBeUndefined();
    expect(decision.log.attempt).toBe(4);
  });

  it('records a clean turn, so the share has a denominator', () => {
    const decision = decideGate(
      input({ violations: [v({ ruleId: 'x', severity: 'warn' })] }),
    );
    expect(decision.log.outcome).toBe('clean');
    expect(decision.log.violations).toBe(1);
    expect(decision.log.attempt).toBe(0);
    // `logEntry` is not given a `stalled` value on this path -- it must
    // default to `false` rather than leaving it undefined or flipping it true.
    expect(decision.log.stalled).toBe(false);
  });

  it('records the terminal release', () => {
    const decision = decideGate(
      input({
        session: { ...createSession(), attempts: 2, escalated: true },
        isRetry: true,
      }),
    );
    expect(decision.log.outcome).toBe('release');
    expect(decision.log.attempt).toBe(2);
    // Same as the clean path: no `stalled` value is passed in, so the default
    // must be `false`, not `true`.
    expect(decision.log.stalled).toBe(false);
  });
});

describe('decideGate — a fixer already holds these files (#76)', () => {
  const overlap: LeaseOverlap = {
    owner: 'commit:sid-commit',
    manifestPath: '.guardrails/state/sid-commit.last.json',
    fixerAgent: 'guardrail-fixer-thorough',
    files: ['src/a.ts', 'src/b.ts'],
  };

  it('tells the agent to wait rather than to spawn a second fixer', () => {
    // The damage this exists for: two fixers from two manifests editing one
    // file, one removing imports the other's code still used. Each was right
    // about its own manifest; the file that resulted did not compile.
    const decision = decideGate(input({ leaseOverlap: overlap }));

    expect(decision.outcome).toBe('delegate');
    expect(decision.block).toBe(true);
    expect(decision.message).toContain(overlap.manifestPath);
    expect(decision.message).toContain('guardrail-fixer-thorough');
    expect(decision.message).toContain('src/a.ts');
    expect(decision.message).toContain('src/b.ts');
    expect(decision.message).toContain('do NOT spawn');
    // The unconditional order is what an agent follows literally, so it must
    // be absent -- not merely qualified somewhere further down the message.
    expect(decision.message).not.toContain('Spawn the');
  });

  it('still forbids reading either manifest', () => {
    const decision = decideGate(input({ leaseOverlap: overlap }));
    expect(decision.message).toContain('Do NOT read');
  });

  it('says why a dead-code finding in a contested file is not a finding', () => {
    // The class of finding a concurrent edit invalidates: whether an import is
    // used depends on code the other fixer is still writing.
    const decision = decideGate(input({ leaseOverlap: overlap }));
    expect(decision.message).toContain('unused-import');
  });

  it('outranks the unchanged-manifest pointer, which would advise a spawn', () => {
    // The stall message ends "only if it has already finished and changed
    // nothing should you spawn a fresh fixer" -- advice that is wrong while
    // ANOTHER rung's fixer holds the files, because the fixer that has not
    // moved this manifest is not the one to wait for.
    const stuck = [v({ ruleId: 'a/one', file: 'src/a.ts' })];
    const decision = decideGate(
      input({
        violations: stuck,
        leaseOverlap: overlap,
        isRetry: true,
        session: {
          ...createSession(),
          attempts: 1,
          lastViolationDigest: violationDigest(stuck),
          lastViolationKeys: violationKeys(stuck),
        },
      }),
    );
    expect(decision.log.stalled).toBe(true);
    expect(decision.message).toContain(overlap.manifestPath);
    expect(decision.message).not.toContain('Spawn the');
  });

  it('charges the attempt, so a held lease cannot extend the ladder', () => {
    // The wait is bounded by the lease (see MAX_LEASE_DEFERRALS), not by the
    // attempt budget. Forgiving it here would let a stuck claim walk the loop
    // forever.
    const decision = decideGate(input({ leaseOverlap: overlap }));
    expect(decision.nextSession.attempts).toBe(1);
  });

  it('still escalates when the ladder is spent, with a wait-first caveat', () => {
    // The escalation is not withheld -- the budget is spent either way -- but
    // the main agent is about to edit files a subagent may still be in.
    const decision = decideGate(
      input({
        leaseOverlap: overlap,
        session: { ...createSession(), attempts: 3 },
      }),
    );
    expect(decision.outcome).toBe('escalate');
    expect(decision.block).toBe(true);
    expect(decision.message).toContain(overlap.manifestPath);
    expect(decision.message).toContain('src/a.ts');
    expect(decision.message).toContain('before editing them yourself');
  });

  it('leaves the escalation caveat out when no lease is held', () => {
    const decision = decideGate(
      input({ session: { ...createSession(), attempts: 3 } }),
    );
    expect(decision.outcome).toBe('escalate');
    expect(decision.message).not.toContain('before editing them yourself');
  });
});

describe('leaseWaitNote', () => {
  it('names the holder, its fixer and the contested files', () => {
    expect(
      leaseWaitNote({
        owner: 'stop:sid',
        manifestPath: '.guardrails/state/sid.last.json',
        fixerAgent: 'guardrail-fixer',
        files: ['src/a.ts'],
      }),
    ).toBe(
      '1 of the file(s) named here are also in .guardrails/state/sid.last.json, ' +
        'which a guardrail-fixer is already working: src/a.ts',
    );
  });

  it('collapses a long file list to a count, staying a pointer not a dump', () => {
    const note = leaseWaitNote({
      owner: 'stop:sid',
      manifestPath: 'm.json',
      fixerAgent: 'guardrail-fixer',
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
    });
    expect(note).toContain('6 of the file(s)');
    expect(note).toContain('d.ts, +2 more file(s)');
    expect(note).not.toContain('e.ts');
  });
});
