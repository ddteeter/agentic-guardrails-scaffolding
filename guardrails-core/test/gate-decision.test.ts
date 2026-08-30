import { describe, expect, it } from 'vitest';

import { decideGate, type GateConfig } from '../src/gate-decision.js';
import { createSession } from '../src/state.js';
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

const manifestPath = '.claude/state/guardrails/sid.last.json';

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
        violations: [v({ ruleId: 'arch/layer-access' })],
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
    // Counter resets so the next cycle starts fresh.
    expect(decision.nextSession.attempts).toBe(0);
  });
});

describe('decideGate — recurrence injection', () => {
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
    expect(decision.additionalContext).toContain('no-console');
    expect(decision.nextSession.corrected).toContain('no-console');
    // Cross-session recurrence incremented for the crossed key.
    expect(decision.nextRecurrence['no-console']).toBe(1);
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
