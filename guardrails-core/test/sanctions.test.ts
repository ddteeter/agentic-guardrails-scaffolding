import { describe, expect, it } from 'vitest';

import type { SanctionedSuppression } from '../src/config.js';
import {
  formatGrantReport,
  newlySanctioned,
  newlySanctionedFiles,
  sanctionCountDrift,
  toMalformedViolations,
} from '../src/sanctions.js';

const sanction = (
  key: string,
  reason = 'reviewed',
  count?: number,
): SanctionedSuppression => ({
  key,
  reason,
  ...(count !== undefined && { count }),
});

describe('newlySanctioned', () => {
  it('reports only keys absent from the base revision', () => {
    const grants = newlySanctioned(
      [sanction('a.ts|cast-any|x')],
      [sanction('a.ts|cast-any|x'), sanction('b.ts|cast-any|y')],
    );
    expect(grants.map((grant) => grant.key)).toEqual(['b.ts|cast-any|y']);
  });

  it('is empty when the branch adds nothing', () => {
    const base = [sanction('a.ts|cast-any|x')];
    expect(newlySanctioned(base, base)).toEqual([]);
  });

  it('ignores edits to an existing entry’s reason', () => {
    // Comparing KEYS/counts, not lines: rewording a justification is a
    // legitimate edit that must not read as a new grant.
    const grants = newlySanctioned(
      [sanction('a.ts|cast-any|x', 'old wording')],
      [sanction('a.ts|cast-any|x', 'clearer wording')],
    );
    expect(grants).toEqual([]);
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
      newlySanctioned([], [sanction('a.ts|x|y')]).map((grant) => grant.key),
    ).toEqual(['a.ts|x|y']);
  });

  it('reports a key whose count increased, even though the key already existed', () => {
    // This is the headline case a bare key-set diff would miss: the key was
    // already approved once, but the branch raises how many occurrences it
    // covers — that IS a new grant and must surface for review.
    const grants = newlySanctioned(
      [sanction('a.ts|mutation-suppress|x', 'first grant', 1)],
      [sanction('a.ts|mutation-suppress|x', 'covers a second site too', 2)],
    );
    expect(grants).toEqual([
      {
        key: 'a.ts|mutation-suppress|x',
        count: 2,
        reasons: ['covers a second site too'],
      },
    ]);
  });

  it('does not report a key whose count is unchanged', () => {
    const grants = newlySanctioned(
      [sanction('a.ts|x|y', 'reviewed', 2)],
      [sanction('a.ts|x|y', 'reviewed', 2)],
    );
    expect(grants).toEqual([]);
  });

  it('sums counts across several entries sharing a key on each side', () => {
    // The base already grants a total of 2 (1 + 1); the branch raises the
    // total to 3, which must read as a new grant of 3, not of each entry.
    const grants = newlySanctioned(
      [sanction('a.ts|x|y', 'first'), sanction('a.ts|x|y', 'second')],
      [
        sanction('a.ts|x|y', 'first'),
        sanction('a.ts|x|y', 'second'),
        sanction('a.ts|x|y', 'third'),
      ],
    );
    expect(grants).toEqual([
      { key: 'a.ts|x|y', count: 3, reasons: ['first', 'second', 'third'] },
    ]);
  });

  it('reports reasons scoped to the granted key only, not every reason in head', () => {
    // A head with several DIFFERENT keys must not let one grant's `reasons`
    // leak in reasons belonging to an unrelated key.
    const grants = newlySanctioned(
      [],
      [
        sanction('a.ts|x|y', 'reason for a'),
        sanction('b.ts|x|y', 'reason for b'),
      ],
    );
    const grantForA = grants.find((grant) => grant.key === 'a.ts|x|y');
    const grantForB = grants.find((grant) => grant.key === 'b.ts|x|y');
    expect(grantForA?.reasons).toEqual(['reason for a']);
    expect(grantForB?.reasons).toEqual(['reason for b']);
  });

  it('treats a missing count as 1 on both sides', () => {
    expect(
      newlySanctioned(
        [sanction('a.ts|x|y', 'reviewed', 1)],
        [sanction('a.ts|x|y', 'reviewed')],
      ),
    ).toEqual([]);
  });
});

describe('formatGrantReport', () => {
  it('renders each grant with its key, count, and joined reasons', () => {
    expect(
      formatGrantReport([
        { key: 'a.ts|cast-any|x', count: 2, reasons: ['first', 'second'] },
      ]),
    ).toEqual(['  - a.ts|cast-any|x (count: 2): first; second']);
  });

  it('is empty for no grants', () => {
    expect(formatGrantReport([])).toEqual([]);
  });
});

describe('toMalformedViolations', () => {
  it('produces a blocking, non-fixable violation naming the file and message', () => {
    const [violation] = toMalformedViolations(
      ['entry 2: missing reason'],
      'guardrails.config.json',
    );
    expect(violation).toMatchObject({
      ruleId: 'guardrails/malformed-sanction',
      file: 'guardrails.config.json',
      severity: 'error',
      fixable: false,
      tool: 'guardrails',
    });
    expect(violation?.message).toContain('entry 2: missing reason');
  });

  it('is empty when nothing is malformed', () => {
    expect(toMalformedViolations([], 'guardrails.config.json')).toEqual([]);
  });
});

describe('newlySanctionedFiles', () => {
  const routeTree = {
    path: 'src/routeTree.gen.ts',
    kind: 'cast-any' as const,
    reason: 'Generated by the router; never hand-edited.',
  };

  it('reports a path grant this branch introduces', () => {
    // A path grant is BROADER than a keyed one -- it covers every occurrence
    // of a kind in a file, forever, with no count to bound it. Review is its
    // only safeguard (decided in #39 triage), so it must never land silently.
    expect(newlySanctionedFiles([], [routeTree])).toEqual([routeTree]);
  });

  it('reports nothing when the grant already existed on the base', () => {
    expect(newlySanctionedFiles([routeTree], [routeTree])).toEqual([]);
  });

  it('treats a widened kind on the same file as a new grant', () => {
    // Changing which kind a file is exempt from is a fresh decision, not an
    // edit to an approved one.
    const widened = { ...routeTree, kind: 'skipped-test' as const };

    expect(newlySanctionedFiles([routeTree], [routeTree, widened])).toEqual([
      widened,
    ]);
  });

  it('treats the same kind moved to another file as a new grant', () => {
    const elsewhere = { ...routeTree, path: 'src/other.gen.ts' };

    expect(newlySanctionedFiles([routeTree], [elsewhere])).toEqual([elsewhere]);
  });

  it('does not report a grant merely reworded', () => {
    // Editing a reason is a legitimate improvement, not a new approval --
    // the same rule the keyed check applies by comparing totals, not text.
    const reworded = { ...routeTree, reason: 'Same grant, clearer wording.' };

    expect(newlySanctionedFiles([routeTree], [reworded])).toEqual([]);
  });

  it('reports removal as nothing, since removing a grant needs no approval', () => {
    expect(newlySanctionedFiles([routeTree], [])).toEqual([]);
  });

  it('reports a duplicated grant once, not once per entry', () => {
    // Two entries naming the same file and kind are one decision, and a
    // reviewer reading the check output should be shown one grant to approve.
    expect(newlySanctionedFiles([], [routeTree, { ...routeTree }])).toEqual([
      routeTree,
    ]);
  });
});

describe('sanctionCountDrift with path grants', () => {
  it('never reports drift for a path grant, which is the point', () => {
    // The defect (#39): a keyed grant's `count` must equal the real occurrence
    // count, and this check FAILS the build on a mismatch -- so a generated
    // file forces the adopter to bump a number on every regeneration. A path
    // grant carries no count, so it must be invisible to this check entirely,
    // however many occurrences the file holds.
    const source = ['const a = x as any;', 'const b = y as any;'].join('\n');

    // A path grant is never handed to this check at all -- that is how the
    // exclusion is expressed. Passing only the keyed grants (none here) must
    // therefore report nothing, however many occurrences the file holds.
    expect(sanctionCountDrift([], () => source)).toEqual([]);
  });

  it('still reports drift on a keyed grant in the same file', () => {
    // A path grant must not become a blanket amnesty for the keyed grants
    // sharing its file -- those keep their exact-count discipline.
    const source = 'const a = x as any;';

    expect(
      sanctionCountDrift(
        [
          {
            key: 'src/routeTree.gen.ts|skipped-test|it.skip("x", () => {});',
            reason: 'Hand-written.',
            count: 3,
          },
        ],
        () => source,
      ),
    ).toHaveLength(1);
  });
});
