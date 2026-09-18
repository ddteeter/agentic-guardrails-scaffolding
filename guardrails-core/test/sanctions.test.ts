import { describe, expect, it, vi } from 'vitest';

import type { SanctionedSuppression } from '../src/config.js';
import {
  formatGrantReport,
  newlySanctioned,
  newlySanctionedFiles,
  sanctionCountDrift,
  sanctionPlacementIssues,
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

/**
 * Placement, not just count (#79). A granted Stryker directive means one thing
 * when it is written and can mean something else after a reformat or a moved
 * statement — and the over-extension direction FAILS OPEN: an unbound
 * `restore` lets its `disable` run to end of file, and the mutation score
 * reads clean while whole functions go unmutated.
 */
const mutationKey = (file: string, text: string): SanctionedSuppression =>
  sanction(`${file}|mutation-suppress|${text}`);

describe('sanctionPlacementIssues', () => {
  it('reports a region disable with no restore, naming the range it really covers', () => {
    const source = [
      '// Stryker disable BlockStatement',
      'function one(): number {',
      '  return 1;',
      '}',
      'function two(): number {',
      '  return 2;',
      '}',
    ].join('\n');

    const issues = sanctionPlacementIssues(
      [mutationKey('src/a.ts', '// Stryker disable BlockStatement')],
      () => source,
    );

    expect(issues).toEqual([
      {
        file: 'src/a.ts',
        line: 1,
        text: '// Stryker disable BlockStatement',
        problem: 'unclosed-disable',
        detail: 'covers lines 1-7, to end of file',
      },
    ]);
  });

  it('accepts a disable closed by a restore of the same mutators', () => {
    const source = [
      '// Stryker disable BlockStatement',
      'function one(): number {',
      '  return 1;',
      '}',
      '// Stryker restore BlockStatement',
      'function two(): number {',
      '  return 2;',
      '}',
    ].join('\n');

    expect(
      sanctionPlacementIssues(
        [mutationKey('src/a.ts', '// Stryker disable BlockStatement')],
        () => source,
      ),
    ).toEqual([]);
  });

  it('accepts `restore all` as closing a narrower disable', () => {
    const source = [
      '// Stryker disable BlockStatement,ConditionalExpression',
      'const a = 1;',
      '// Stryker restore all',
      'const b = 2;',
    ].join('\n');

    expect(
      sanctionPlacementIssues(
        [
          mutationKey(
            'src/a.ts',
            '// Stryker disable BlockStatement,ConditionalExpression',
          ),
        ],
        () => source,
      ),
    ).toEqual([]);
  });

  it('does not accept a narrower restore as closing `disable all`', () => {
    // The half-closed region is the fail-open in miniature: everything the
    // restore does not name stays disabled to end of file.
    const source = [
      '// Stryker disable all',
      'const a = 1;',
      '// Stryker restore BlockStatement',
      'const b = 2;',
    ].join('\n');

    const issues = sanctionPlacementIssues(
      [mutationKey('src/a.ts', '// Stryker disable all')],
      () => source,
    );

    expect(issues.map((issue) => issue.problem)).toEqual(['unclosed-disable']);
  });

  it('never asks a `disable next-line` for a restore', () => {
    // A next-line directive is self-terminating; demanding a restore for one
    // would make the check fire on every legitimate equivalent-mutant grant.
    const source = [
      '// Stryker disable next-line ConditionalExpression',
      'const a = x === 1;',
    ].join('\n');

    expect(
      sanctionPlacementIssues(
        [
          mutationKey(
            'src/a.ts',
            '// Stryker disable next-line ConditionalExpression',
          ),
        ],
        () => source,
      ),
    ).toEqual([]);
  });

  it('reports a restore that no statement follows', () => {
    // The documented 21-mutant bug: a restore placed after the last statement
    // of a block never attaches, so its disable runs to end of file.
    const source = [
      'function one(): number {',
      '  // Stryker disable BlockStatement',
      '  const a = 1;',
      '  return a;',
      '  // Stryker restore BlockStatement',
      '}',
      'function two(): number {',
      '  return 2;',
      '}',
    ].join('\n');

    const issues = sanctionPlacementIssues(
      [
        mutationKey('src/a.ts', '// Stryker disable BlockStatement'),
        mutationKey('src/a.ts', '// Stryker restore BlockStatement'),
      ],
      () => source,
    );

    expect(issues).toEqual([
      {
        file: 'src/a.ts',
        line: 5,
        text: '// Stryker restore BlockStatement',
        problem: 'unbound-restore',
        detail:
          'the next code line is `}`, so this restore attaches to nothing ' +
          'and its disable runs to end of file',
      },
    ]);
  });

  it('reports a restore at end of file', () => {
    const source = [
      '// Stryker disable BlockStatement',
      'const a = 1;',
      '// Stryker restore BlockStatement',
      '',
    ].join('\n');

    // Asserts the full `detail` text, not just `problem`: the two branches of
    // `next === undefined ? ... : ...` read very differently to a reviewer,
    // and a test that only checks `problem` cannot tell them apart.
    expect(
      sanctionPlacementIssues(
        [
          mutationKey('src/a.ts', '// Stryker disable BlockStatement'),
          mutationKey('src/a.ts', '// Stryker restore BlockStatement'),
        ],
        () => source,
      ),
    ).toEqual([
      {
        file: 'src/a.ts',
        line: 3,
        text: '// Stryker restore BlockStatement',
        problem: 'unbound-restore',
        detail:
          'nothing follows it before end of file, so this restore attaches ' +
          'to nothing and its disable runs to end of file',
      },
    ]);
  });

  it('does not mistake an indented blank line for the statement a restore binds to', () => {
    // The blank line here is not EMPTY, it's whitespace-only -- `isSkippableLine`
    // must trim before checking `length === 0`, or this line reads as "a real
    // statement" and the check stops looking for what actually follows it.
    const source = [
      'if (x) {',
      '  // Stryker disable BlockStatement',
      '  run();',
      '  // Stryker restore BlockStatement',
      ' '.repeat(3),
      '}',
    ].join('\n');

    const issues = sanctionPlacementIssues(
      [
        mutationKey('src/a.ts', '// Stryker disable BlockStatement'),
        mutationKey('src/a.ts', '// Stryker restore BlockStatement'),
      ],
      () => source,
    );

    expect(issues).toEqual([
      {
        file: 'src/a.ts',
        line: 4,
        text: '// Stryker restore BlockStatement',
        problem: 'unbound-restore',
        detail:
          'the next code line is `}`, so this restore attaches to nothing ' +
          'and its disable runs to end of file',
      },
    ]);
  });

  it('trims the bound candidate before checking it, not just before returning it', () => {
    // An indented closer must still be recognised as "binds to nothing" --
    // `BINDS_TO_NOTHING` is anchored at the start of the string, so an
    // untrimmed leading space would hide the match entirely.
    const source = [
      'if (x) {',
      '  // Stryker disable BlockStatement',
      '  run();',
      '  // Stryker restore BlockStatement',
      '  }',
      'more();',
    ].join('\n');

    const issues = sanctionPlacementIssues(
      [
        mutationKey('src/a.ts', '// Stryker disable BlockStatement'),
        mutationKey('src/a.ts', '// Stryker restore BlockStatement'),
      ],
      () => source,
    );

    expect(issues.map((issue) => issue.problem)).toEqual(['unbound-restore']);
  });

  it('never checks a disable directive for a bound statement — only restores need one', () => {
    // A region `disable` governs everything from itself onward regardless of
    // what line follows it; only `unboundRestores`'s own directives (restores)
    // need to bind to a statement. A disable placed right before a `}` must
    // not be flagged by THIS check even though `unboundRestores` sees it too.
    const source = [
      'if (x) {',
      '  run();',
      '  // Stryker disable BlockStatement',
      '}',
      '// Stryker restore BlockStatement',
      'more();',
    ].join('\n');

    const issues = sanctionPlacementIssues(
      [
        mutationKey('src/a.ts', '// Stryker disable BlockStatement'),
        mutationKey('src/a.ts', '// Stryker restore BlockStatement'),
      ],
      () => source,
    );

    expect(issues).toEqual([]);
  });

  it('looks past blank lines and comments for the statement a restore binds to', () => {
    const source = [
      '// Stryker disable BlockStatement',
      'const a = 1;',
      '// Stryker restore BlockStatement',
      '',
      '// an explanatory comment',
      '/* and a block one */',
      'const b = 2;',
    ].join('\n');

    expect(
      sanctionPlacementIssues(
        [
          mutationKey('src/a.ts', '// Stryker disable BlockStatement'),
          mutationKey('src/a.ts', '// Stryker restore BlockStatement'),
        ],
        () => source,
      ),
    ).toEqual([]);
  });

  it('flags `else` and `catch` as binding to nothing, like `}`', () => {
    const source = [
      'try {',
      '  // Stryker disable BlockStatement',
      '  run();',
      '  // Stryker restore BlockStatement',
      '} catch {',
      '  fallback();',
      '}',
    ].join('\n');

    expect(
      sanctionPlacementIssues(
        [
          mutationKey('src/a.ts', '// Stryker disable BlockStatement'),
          mutationKey('src/a.ts', '// Stryker restore BlockStatement'),
        ],
        () => source,
      ).map((issue) => issue.problem),
    ).toEqual(['unbound-restore']);
  });

  it('only reads the files named by a mutation-suppress grant', () => {
    // A cast-any grant says nothing about Stryker placement, and reading its
    // file would make this check fire on suppressions it has no business in.
    const read = vi.fn(() => 'const a = x as any;');

    expect(
      sanctionPlacementIssues(
        [sanction('src/a.ts|cast-any|const a = x as any;')],
        read,
      ),
    ).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('reports nothing for a file it cannot read', () => {
    // A deleted file is the count drift-guard's finding, not this one's —
    // reporting it twice would make one failure read as two defects.
    const unreadable = vi.fn<(file: string) => string | undefined>();
    expect(
      sanctionPlacementIssues(
        [mutationKey('src/gone.ts', '// Stryker disable all')],
        unreadable,
      ),
    ).toEqual([]);
  });

  it('reports each file named by a grant, reading every file once', () => {
    const read = vi.fn(
      () => '// Stryker disable all\nconst a = 1;\nconst b = 2;',
    );

    const issues = sanctionPlacementIssues(
      [
        mutationKey('src/a.ts', '// Stryker disable all'),
        mutationKey('src/a.ts', '// Stryker restore all'),
        mutationKey('src/b.ts', '// Stryker disable all'),
      ],
      read,
    );

    expect(issues.map((issue) => issue.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('drops a Stryker-shaped comment that names no mutator, rather than crashing', () => {
    // The auditor's own signature stops at `Stryker (disable|restore)`, but
    // stryker's parser requires a mutator list — so this comment silences
    // nothing. Reporting it as a region running to end of file would be a
    // BLOCKING false positive about a directive that is already inert.
    const source = ['// Stryker disable', 'const a = 1;'].join('\n');

    expect(
      sanctionPlacementIssues(
        [mutationKey('src/a.ts', '// Stryker disable')],
        () => source,
      ),
    ).toEqual([]);
  });

  it('skips an audit finding whose kind is not mutation-suppress, even when its text also reads as a directive', () => {
    // `it.skip(...)` is matched BEFORE `mutation-suppress` in the auditor's own
    // signature table, so this line classifies as `skipped-test` even though it
    // also carries a valid-looking Stryker comment. Only a `mutation-suppress`
    // finding may become a directive here.
    const source = [
      "it.skip('bad', () => {}); // Stryker disable BlockStatement",
      'const a = 1;',
    ].join('\n');

    const issues = sanctionPlacementIssues(
      [mutationKey('src/a.ts', '// Stryker disable BlockStatement')],
      () => source,
    );

    expect(issues).toEqual([]);
  });

  it('filters an empty mutator produced by a trailing comma', () => {
    const source = [
      '// Stryker disable BlockStatement,',
      'const a = 1;',
      '// Stryker restore BlockStatement',
      'const b = 2;',
    ].join('\n');

    expect(
      sanctionPlacementIssues(
        [
          mutationKey('src/a.ts', '// Stryker disable BlockStatement,'),
          mutationKey('src/a.ts', '// Stryker restore BlockStatement'),
        ],
        () => source,
      ),
    ).toEqual([]);
  });

  it('trims whitespace around each mutator name', () => {
    const source = [
      '// Stryker disable BlockStatement, ConditionalExpression',
      'const a = 1;',
      '// Stryker restore BlockStatement,ConditionalExpression',
      'const b = 2;',
    ].join('\n');

    const issues = sanctionPlacementIssues(
      [
        mutationKey(
          'src/a.ts',
          '// Stryker disable BlockStatement, ConditionalExpression',
        ),
        mutationKey(
          'src/a.ts',
          '// Stryker restore BlockStatement,ConditionalExpression',
        ),
      ],
      () => source,
    );

    expect(issues).toEqual([]);
  });

  it('captures the full mutator list even past the whitespace after a comma', () => {
    // If the mutator-list character class stopped at whitespace, the capture
    // would silently truncate to `ConditionalExpression,` and lose
    // `BlockStatement` entirely -- and losing a mutator from the DISABLE side
    // makes it easier, not harder, to look closed.
    const source = [
      '// Stryker disable ConditionalExpression, BlockStatement',
      'const a = 1;',
      '// Stryker restore ConditionalExpression',
      'const b = 2;',
    ].join('\n');

    const issues = sanctionPlacementIssues(
      [
        mutationKey(
          'src/a.ts',
          '// Stryker disable ConditionalExpression, BlockStatement',
        ),
        mutationKey('src/a.ts', '// Stryker restore ConditionalExpression'),
      ],
      () => source,
    );

    expect(issues.map((issue) => issue.problem)).toEqual(['unclosed-disable']);
  });

  it('requires a restore naming EVERY mutator a multi-mutator disable named, not just one', () => {
    const source = [
      '// Stryker disable BlockStatement,ConditionalExpression',
      'const a = 1;',
      '// Stryker restore BlockStatement',
      'const b = 2;',
    ].join('\n');

    const issues = sanctionPlacementIssues(
      [
        mutationKey(
          'src/a.ts',
          '// Stryker disable BlockStatement,ConditionalExpression',
        ),
        mutationKey('src/a.ts', '// Stryker restore BlockStatement'),
      ],
      () => source,
    );

    expect(issues.map((issue) => issue.problem)).toEqual(['unclosed-disable']);
  });

  it('only counts a restore that comes AFTER the disable it might close', () => {
    // The restore here textually precedes the disable it happens to name the
    // same mutators as -- it must not count as closing it.
    const source = [
      '// Stryker restore BlockStatement',
      '// Stryker disable BlockStatement',
      'const a = 1;',
    ].join('\n');

    const issues = sanctionPlacementIssues(
      [
        mutationKey('src/a.ts', '// Stryker restore BlockStatement'),
        mutationKey('src/a.ts', '// Stryker disable BlockStatement'),
      ],
      () => source,
    );

    expect(issues.map((issue) => issue.problem)).toEqual(['unclosed-disable']);
  });

  it('tolerates extra whitespace between `Stryker` and `disable`/`restore`', () => {
    const source = ['// Stryker  disable BlockStatement', 'const a = 1;'].join(
      '\n',
    );

    const issues = sanctionPlacementIssues(
      [mutationKey('src/a.ts', '// Stryker  disable BlockStatement')],
      () => source,
    );

    expect(issues.map((issue) => issue.problem)).toEqual(['unclosed-disable']);
  });

  it('tolerates extra whitespace between `disable`/`restore` and `next-line`', () => {
    const source = [
      '// Stryker disable  next-line ConditionalExpression',
      'const a = x === 1;',
    ].join('\n');

    expect(
      sanctionPlacementIssues(
        [
          mutationKey(
            'src/a.ts',
            '// Stryker disable  next-line ConditionalExpression',
          ),
        ],
        () => source,
      ),
    ).toEqual([]);
  });

  // A line is skippable when it STARTS with a comment marker. Each case below
  // is a line that merely ENDS with one: if the check were `endsWith`, the
  // statement the restore binds to would be skipped, the `}` beneath it would
  // become the next code line, and the restore would be reported as unbound.
  it.each([
    ['//', '  const done = true; //'],
    ['/*', '  const marker = 1; /*'],
    ['*', '  const total = width * height *'],
  ])(
    'does not treat a line that merely ENDS with `%s` as a comment',
    (_marker, statement) => {
      const source = [
        'if (x) {',
        '  // Stryker disable BlockStatement',
        '  run();',
        '  // Stryker restore BlockStatement',
        statement,
        '}',
      ].join('\n');

      expect(
        sanctionPlacementIssues(
          [
            mutationKey('src/a.ts', '// Stryker disable BlockStatement'),
            mutationKey('src/a.ts', '// Stryker restore BlockStatement'),
          ],
          () => source,
        ),
      ).toEqual([]);
    },
  );
});
