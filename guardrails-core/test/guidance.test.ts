import { describe, expect, it } from 'vitest';

import { withGuidance } from '../src/guidance.js';
import type { Violation } from '../src/violation.js';

function violation(ruleId: string, extra: Partial<Violation> = {}): Violation {
  return {
    ruleId,
    file: 'src/a.ts',
    message: 'msg',
    severity: 'error',
    fixable: false,
    tool: 'stryker',
    ...extra,
  };
}

describe('withGuidance', () => {
  it('attaches the mutation doc to a surviving-mutant violation', () => {
    const [tagged] = withGuidance([violation('stryker/survived')]);
    expect(tagged?.guidance).toBe('docs/guardrails/crushing-mutants.md');
  });

  it('leaves classes with no guidance untouched, adding no key', () => {
    // The manifest is read into the fixer's context, so it stays terse.
    const [untagged] = withGuidance([violation('no-console')]);
    expect(untagged && Object.hasOwn(untagged, 'guidance')).toBe(false);
  });

  it('does not overwrite guidance a producer already set', () => {
    const [tagged] = withGuidance([
      violation('stryker/survived', { guidance: 'docs/custom.md' }),
    ]);
    expect(tagged?.guidance).toBe('docs/custom.md');
  });

  it('matches on prefix, not exact id', () => {
    const [tagged] = withGuidance([violation('stryker/timeout')]);
    expect(tagged?.guidance).toBe('docs/guardrails/crushing-mutants.md');
  });

  it('preserves every other field and the input order', () => {
    const input = [violation('no-console'), violation('stryker/survived')];
    const result = withGuidance(input);
    expect(result.map((entry) => entry.ruleId)).toEqual([
      'no-console',
      'stryker/survived',
    ]);
    expect(result[0]).toEqual(input[0]);
  });

  it('is empty for no violations', () => {
    expect(withGuidance([])).toEqual([]);
  });
});
