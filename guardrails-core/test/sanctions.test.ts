import { describe, expect, it } from 'vitest';

import type { SanctionedSuppression } from '../src/config.js';
import { newlySanctioned, toSanctionViolations } from '../src/sanctions.js';

const sanction = (key: string, reason = 'reviewed'): SanctionedSuppression => ({
  key,
  reason,
});

describe('newlySanctioned', () => {
  it('reports only keys absent from the base revision', () => {
    const added = newlySanctioned(
      [sanction('a.ts|cast-any|x')],
      [sanction('a.ts|cast-any|x'), sanction('b.ts|cast-any|y')],
    );
    expect(added.map((entry) => entry.key)).toEqual(['b.ts|cast-any|y']);
  });

  it('is empty when the branch adds nothing', () => {
    const base = [sanction('a.ts|cast-any|x')];
    expect(newlySanctioned(base, base)).toEqual([]);
  });

  it('ignores edits to an existing entry’s reason', () => {
    // Comparing KEYS, not lines: rewording a justification is a legitimate edit
    // that must not read as a new grant.
    const added = newlySanctioned(
      [sanction('a.ts|cast-any|x', 'old wording')],
      [sanction('a.ts|cast-any|x', 'clearer wording')],
    );
    expect(added).toEqual([]);
  });

  it('ignores removals', () => {
    // Withdrawing an exemption tightens the gate and needs no approval.
    expect(
      newlySanctioned(
        [sanction('a.ts|x|y'), sanction('b.ts|x|y')],
        [sanction('a.ts|x|y')],
      ),
    ).toEqual([]);
  });

  it('treats an empty base as granting everything on the branch', () => {
    expect(
      newlySanctioned([], [sanction('a.ts|x|y')]).map((entry) => entry.key),
    ).toEqual(['a.ts|x|y']);
  });
});

describe('toSanctionViolations', () => {
  it('produces a blocking, non-fixable violation naming the key and reason', () => {
    const [violation] = toSanctionViolations(
      [sanction('a.ts|cast-any|x', 'proven equivalent')],
      'guardrails.config.json',
    );
    expect(violation).toMatchObject({
      ruleId: 'guardrails/self-sanction',
      file: 'guardrails.config.json',
      severity: 'error',
      fixable: false,
      tool: 'guardrails',
    });
    expect(violation?.message).toContain('a.ts|cast-any|x');
    expect(violation?.message).toContain('proven equivalent');
  });

  it('is empty when nothing was added', () => {
    expect(toSanctionViolations([], 'guardrails.config.json')).toEqual([]);
  });
});
