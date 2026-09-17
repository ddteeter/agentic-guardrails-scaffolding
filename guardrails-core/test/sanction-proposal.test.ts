import { describe, expect, it, vi } from 'vitest';

import { auditSource } from '../src/audit.js';
import type { SanctionedFile, SanctionedSuppression } from '../src/config.js';
import {
  findingsFromManifest,
  formatProposals,
  proposeSanctions,
  type SanctionProposalContext,
} from '../src/sanction-proposal.js';
import { ADDED_SUPPRESSION_RULE, type Violation } from '../src/violation.js';

const CAST_LINE = 'const report = raw as unknown as Report;';

function context(
  overrides: Partial<SanctionProposalContext> = {},
): SanctionProposalContext {
  return {
    readSource: () => CAST_LINE,
    sanctions: [],
    files: [],
    ...overrides,
  };
}

function suppression(violation: Partial<Violation> = {}): Violation {
  return {
    ruleId: ADDED_SUPPRESSION_RULE,
    file: 'src/a.ts',
    line: 1,
    message: 'Forbidden cast-any added during the fix loop',
    severity: 'error',
    fixable: false,
    tool: 'guardrails',
    ...violation,
  };
}

describe('findingsFromManifest', () => {
  it('recovers the auditor’s own finding for each added-suppression violation', () => {
    // The whole point of #75: the key must come from the auditor's lexer, not
    // from parsing the violation's human-readable message.
    const findings = findingsFromManifest([suppression()], () => CAST_LINE);

    expect(findings).toEqual([
      { file: 'src/a.ts', line: 1, kind: 'cast-any', text: CAST_LINE },
    ]);
  });

  it('ignores violations that are not added suppressions', () => {
    expect(
      findingsFromManifest(
        [suppression({ ruleId: 'eslint/no-console' })],
        () => CAST_LINE,
      ),
    ).toEqual([]);
  });

  it('does not even read the file for a violation with no line', () => {
    // Without a line there is nothing to resolve against the source, and
    // guessing would produce a key that is wrong by construction. The file is
    // not read at all: a violation that cannot be resolved is not a reason to
    // go looking through source.
    const { line: _line, ...withoutLine } = suppression();
    const read = vi.fn(() => CAST_LINE);

    expect(findingsFromManifest([withoutLine], read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads each named file once, however many violations name it', () => {
    const read = vi.fn(() => `${CAST_LINE}\n${CAST_LINE}`);

    const findings = findingsFromManifest(
      [suppression({ line: 1 }), suppression({ line: 2 })],
      read,
    );

    expect(findings.map((finding) => finding.line)).toEqual([1, 2]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('drops a violation whose line no longer holds a suppression', () => {
    // The file moved under the manifest. Reporting a key for a line that no
    // longer carries the suppression would be a guess presented as derived.
    expect(
      findingsFromManifest([suppression({ line: 9 })], () => CAST_LINE),
    ).toEqual([]);
  });

  it('reports nothing for a file it cannot read', () => {
    const unreadable = vi.fn<(file: string) => string | undefined>();

    expect(findingsFromManifest([suppression()], unreadable)).toEqual([]);
  });
});

describe('proposeSanctions', () => {
  const findings = auditSource('src/a.ts', CAST_LINE);

  it('derives the exact key with the auditor’s findingKey', () => {
    const [proposal] = proposeSanctions(findings, context());

    expect(proposal?.key).toBe(`src/a.ts|cast-any|${CAST_LINE}`);
    expect(proposal?.file).toBe('src/a.ts');
    expect(proposal?.line).toBe(1);
    expect(proposal?.kind).toBe('cast-any');
  });

  it('leaves `reason` blank — the argument is the developer’s to accept', () => {
    const [proposal] = proposeSanctions(findings, context());

    expect(proposal?.entry).toEqual({
      key: `src/a.ts|cast-any|${CAST_LINE}`,
      reason: '',
    });
  });

  it('derives `count` from every occurrence in the file, not from the diff', () => {
    // `sanctions-check` re-derives the count against the whole file, so a
    // count taken from the blocking diff alone would fail on the next run.
    const source = [CAST_LINE, 'const other = 1;', CAST_LINE].join('\n');

    const [proposal] = proposeSanctions(
      auditSource('src/a.ts', source).slice(0, 1),
      context({ readSource: () => source }),
    );

    expect(proposal?.count).toBe(2);
    expect(proposal?.entry).toEqual({
      key: `src/a.ts|cast-any|${CAST_LINE}`,
      reason: '',
      count: 2,
    });
  });

  it('proposes one entry per key, however many occurrences blocked', () => {
    const source = [CAST_LINE, CAST_LINE].join('\n');

    expect(
      proposeSanctions(
        auditSource('src/a.ts', source),
        context({ readSource: () => source }),
      ),
    ).toHaveLength(1);
  });

  it('still leads with the counted entry for a file that reads as generated', () => {
    // The inference is a GUESS, and a wrong guess must not steer the reader
    // toward the broader grant. The counted entry stays the proposal; the
    // whole-file grant is offered beside it, for the reader to accept or
    // reject.
    const generated = ['// @generated by the route generator', CAST_LINE].join(
      '\n',
    );

    const [proposal] = proposeSanctions(
      auditSource('src/routeTree.gen.ts', generated),
      context({ readSource: () => generated }),
    );

    expect(proposal?.entry).toEqual({
      key: `src/routeTree.gen.ts|cast-any|${CAST_LINE}`,
      reason: '',
    });
    expect(proposal?.wholeFile?.entry).toEqual({
      path: 'src/routeTree.gen.ts',
      kind: 'cast-any',
      reason: '',
    });
  });

  it('puts the whole-file offer to the reader as a question, not a verdict', () => {
    const generated = ['// @generated by the route generator', CAST_LINE].join(
      '\n',
    );

    const [proposal] = proposeSanctions(
      auditSource('src/routeTree.gen.ts', generated),
      context({ readSource: () => generated }),
    );

    // Hedged about the file ("reads as"), and explicit that the counted entry
    // above is what to use if a person maintains it.
    expect(proposal?.wholeFile?.question).toContain('reads as generated');
    expect(proposal?.wholeFile?.question).toContain('If a person maintains');
    expect(proposal?.wholeFile?.question).toContain('regeneration');
  });

  // Each generated-path shape on its own: a directory a generator owns, and
  // each filename infix one stamps on its output. `src/routes/…` is three
  // segments deep so a check that looked at the wrong segment would miss it.
  it.each([
    'src/__generated__/schema.ts',
    'src/generated/schema.ts',
    'src/routes/routeTree.gen.ts',
    'src/schema.generated.tsx',
  ])('offers the whole-file alternative for %s, on its path alone', (file) => {
    // No header in the source: the path is the whole signal here.
    expect(
      proposeSanctions(auditSource(file, CAST_LINE), context())[0]?.wholeFile,
    ).toBeDefined();
  });

  it('offers no whole-file alternative for a hand-written file', () => {
    // The negative half of the pair: `sanctionedFiles` is the broader grant,
    // so over-matching here would put the un-counted exemption in front of a
    // reader for code a person wrote and will keep editing.
    expect(
      proposeSanctions(
        auditSource('src/regenerate.ts', CAST_LINE),
        context(),
      )[0]?.wholeFile,
    ).toBeUndefined();
  });

  // The header markers, each on its own, in the casing a real generator writes
  // them in — the match is case-insensitive, so an upper-case banner and a
  // lower-case one must both land.
  it.each([
    '/* DO NOT EDIT: this file is machine-written */',
    '// @generated by the route generator',
    '// Code generated by protoc-gen-ts. ',
    '// autogenerated — do not modify',
    '// auto-generated — do not modify',
  ])('offers the whole-file alternative for the header %s', (header) => {
    const generated = [header, CAST_LINE].join('\n');

    expect(
      proposeSanctions(
        auditSource('src/schema.ts', generated),
        context({ readSource: () => generated }),
      )[0]?.wholeFile,
    ).toBeDefined();
  });

  it('does not take a generated-sounding line deep in a file as provenance', () => {
    // "auto-generated" in prose halfway down a hand-written file is a comment
    // about something else. Only a header says who wrote the file.
    const source = [
      ...Array.from({ length: 12 }, (_unused, index) => `// line ${index}`),
      '// this value is auto-generated at runtime',
      CAST_LINE,
    ].join('\n');

    expect(
      proposeSanctions(
        auditSource('src/a.ts', source),
        context({ readSource: () => source }),
      )[0]?.wholeFile,
    ).toBeUndefined();
  });

  it('still counts a generated file’s occurrences, since the counted entry leads', () => {
    // The primary entry is the counted one even here, so its `count` has to be
    // real — a placeholder would fail `sanctions-check` the moment a reader
    // took the proposal at its word.
    const generated = [
      '// @generated by the route generator',
      CAST_LINE,
      CAST_LINE,
    ].join('\n');

    const [proposal] = proposeSanctions(
      auditSource('src/routeTree.gen.ts', generated).slice(0, 1),
      context({ readSource: () => generated }),
    );

    expect(proposal?.count).toBe(2);
    expect(proposal?.entry).toEqual({
      key: `src/routeTree.gen.ts|cast-any|${CAST_LINE}`,
      reason: '',
      count: 2,
    });
  });

  it('warns about a repetition pattern for hand-written code', () => {
    // CLAUDE.md is explicit that `sanctionedFiles` is for GENERATED code only.
    // A high count is a warning about the code, not a licence for the broader
    // grant.
    const source = Array.from({ length: 9 }, () => CAST_LINE).join('\n');

    const [proposal] = proposeSanctions(
      auditSource('src/a.ts', source).slice(0, 1),
      context({ readSource: () => source }),
    );

    expect(proposal?.wholeFile).toBeUndefined();
    expect(proposal?.mechanismNote).toContain('pattern, not an exception');
  });

  it('does not call a handful of occurrences a pattern', () => {
    // The boundary matters in the safe direction: the note is an accusation
    // about the code, and firing it on an ordinary repeated suppression would
    // train the reader to ignore it.
    const source = Array.from({ length: 5 }, () => CAST_LINE).join('\n');

    const [proposal] = proposeSanctions(
      auditSource('src/a.ts', source).slice(0, 1),
      context({ readSource: () => source }),
    );

    expect(proposal?.count).toBe(5);
    expect(proposal?.mechanismNote).not.toContain('pattern, not an exception');
  });

  it('falls back to a count of one when the file cannot be read', () => {
    // A file the reader cannot reach still deserves a derived key — the entry
    // is a proposal, and a missing file is the developer's to explain.
    const unreadable = vi.fn<(file: string) => string | undefined>();

    const [proposal] = proposeSanctions(
      findings,
      context({ readSource: unreadable }),
    );

    expect(proposal?.count).toBe(1);
    expect(proposal?.wholeFile).toBeUndefined();
  });

  it('counts only the occurrences of THIS key, not every suppression in the file', () => {
    // `count` is spent per suppression key, so a file holding two different
    // suppressions must not inflate either one's budget.
    const other = 'const flag = raw as any;';
    const source = [CAST_LINE, other].join('\n');

    const proposals = proposeSanctions(
      auditSource('src/a.ts', source),
      context({ readSource: () => source }),
    );

    expect(proposals.map((proposal) => proposal.count)).toEqual([1, 1]);
  });

  it('makes precedent visible rather than persuasive', () => {
    // The degradation #75 records: two grants went in with no ask because they
    // were the ninth of their shape. The count is the thing that should START
    // a conversation, so it has to be on the proposal.
    const existing: SanctionedSuppression[] = Array.from(
      { length: 8 },
      (_unused, index) => ({
        key: `src/r${index}.tsx|analyzer-ignore|// fallow-ignore`,
        reason: 'route shape',
      }),
    );
    const source = '// fallow-ignore';

    const [proposal] = proposeSanctions(
      auditSource('src/r8.tsx', source),
      context({ readSource: () => source, sanctions: existing }),
    );

    expect(proposal?.precedent).toBe(8);
  });

  it('counts whole-file grants of the same kind as precedent too', () => {
    const files: SanctionedFile[] = [
      { path: 'src/gen.ts', kind: 'cast-any', reason: 'generated' },
    ];

    expect(proposeSanctions(findings, context({ files }))[0]?.precedent).toBe(
      1,
    );
  });

  it('does not count a whole-file grant of a different kind as precedent', () => {
    const files: SanctionedFile[] = [
      { path: 'src/gen.ts', kind: 'skipped-test', reason: 'generated' },
    ];

    expect(proposeSanctions(findings, context({ files }))[0]?.precedent).toBe(
      0,
    );
  });

  it('does not count grants of a different kind as precedent', () => {
    const sanctions: SanctionedSuppression[] = [
      { key: 'src/b.ts|skipped-test|it.skip("x");', reason: 'quarantined' },
    ];

    expect(
      proposeSanctions(findings, context({ sanctions }))[0]?.precedent,
    ).toBe(0);
  });

  it('says what stops being checked, per kind', () => {
    const mutation = '// Stryker disable next-line ConditionalExpression';

    expect(
      proposeSanctions(
        auditSource('src/a.ts', mutation),
        context({ readSource: () => mutation }),
      )[0]?.cost,
    ).toContain('mutant');
    expect(proposeSanctions(findings, context())[0]?.cost).toContain(
      'type system',
    );
  });
});

describe('formatProposals', () => {
  const findings = auditSource('src/a.ts', CAST_LINE);

  it('prints the key, the entry and the cost, and says nothing was written', () => {
    const printed = formatProposals(proposeSanctions(findings, context())).join(
      '\n',
    );

    expect(printed).toContain(`src/a.ts|cast-any|${CAST_LINE}`);
    expect(printed).toContain('"reason": ""');
    expect(printed).toContain('NOTHING HAS BEEN WRITTEN');
    expect(printed).toContain('sanctionedSuppressions');
  });

  it('tells the agent to ask the developer rather than add the entry', () => {
    // The pointer, not the agent's judgment, is what says "ask first" — that
    // is the half of #75 that fixes the degradation on precedent-shaped grants.
    const printed = formatProposals(proposeSanctions(findings, context())).join(
      '\n',
    );

    expect(printed).toContain('Ask the developer');
  });

  it('prints the precedent count so the ninth grant of a shape is visible', () => {
    const sanctions: SanctionedSuppression[] = Array.from(
      { length: 8 },
      (_unused, index) => ({
        key: `src/r${index}.ts|cast-any|${CAST_LINE}`,
        reason: 'route shape',
      }),
    );

    expect(
      formatProposals(proposeSanctions(findings, context({ sanctions }))).join(
        '\n',
      ),
    ).toContain('number 9');
  });

  it('says so plainly when nothing needs a grant', () => {
    expect(formatProposals([]).join('\n')).toContain('no suppression');
  });

  it('prints no whole-file block for a hand-written file', () => {
    const lines = formatProposals(proposeSanctions(findings, context()));
    const printed = lines.join('\n');

    expect(printed).not.toContain('ALSO CONSIDER');
    expect(printed).not.toContain('sanctionedFiles');
    // And the block ENDS at the entry: the whole-file offer is the only thing
    // that belongs after it, so a hand-written proposal's entry is followed by
    // the blank separator and nothing else.
    const entryEnd = lines.lastIndexOf('      }');
    expect(entryEnd).toBeGreaterThan(0);
    expect(lines[entryEnd + 1]).toBe('');
  });

  it('prints the whole-file grant below the counted entry, clearly marked as an alternative', () => {
    // Ordering is the whole point of the change: a reader skimming this must
    // hit the counted entry first and reach the broader grant only through a
    // question they have to answer.
    const generated = ['// @generated by the route generator', CAST_LINE].join(
      '\n',
    );
    const printed = formatProposals(
      proposeSanctions(
        auditSource('src/routeTree.gen.ts', generated),
        context({ readSource: () => generated }),
      ),
    ).join('\n');

    expect(printed).toContain('ALSO CONSIDER');
    expect(printed).toContain('"path": "src/routeTree.gen.ts"');
    expect(printed.indexOf('sanctionedSuppressions')).toBeLessThan(
      printed.indexOf('sanctionedFiles'),
    );
    expect(printed.indexOf(`"key"`)).toBeLessThan(printed.indexOf(`"path"`));
  });
});
