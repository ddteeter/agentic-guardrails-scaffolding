import { describe, expect, it } from 'vitest';

import {
  isStrykerReportJson,
  parseStrykerJson,
  unrunSurvivedMutants,
} from '../../src/verify/stryker-adapter.js';

const report = JSON.stringify({
  schemaVersion: '1.0',
  thresholds: { high: 80, low: 60 },
  files: {
    'src/changed.ts': {
      language: 'typescript',
      source: '',
      mutants: [
        {
          id: '1',
          mutatorName: 'ConditionalExpression',
          status: 'Survived',
          location: {
            start: { line: 12, column: 3 },
            end: { line: 12, column: 9 },
          },
        },
        {
          id: '2',
          mutatorName: 'BlockStatement',
          status: 'Killed',
          location: {
            start: { line: 20, column: 1 },
            end: { line: 22, column: 2 },
          },
        },
        {
          id: '3',
          mutatorName: 'ArithmeticOperator',
          status: 'NoCoverage',
          location: {
            start: { line: 30, column: 1 },
            end: { line: 30, column: 5 },
          },
        },
      ],
    },
    'src/untouched.ts': {
      language: 'typescript',
      source: '',
      mutants: [
        {
          id: '4',
          mutatorName: 'EqualityOperator',
          status: 'Survived',
          location: {
            start: { line: 5, column: 1 },
            end: { line: 5, column: 8 },
          },
        },
      ],
    },
  },
});

describe('parseStrykerJson', () => {
  it('emits one violation per Survived mutant in a changed file', () => {
    const result = parseStrykerJson(report, ['src/changed.ts']);
    expect(result).toContainEqual({
      ruleId: 'stryker/survived',
      file: 'src/changed.ts',
      line: 12,
      message:
        'ConditionalExpression mutant survived — a test executes this line but does not assert its behavior',
      severity: 'error',
      fixable: false,
      tool: 'stryker',
    });
  });

  it('emits one violation per NoCoverage mutant in a changed file', () => {
    // NoCoverage is a STRICTER failure than Survived: Survived means a test ran
    // the line without asserting on it, NoCoverage means no test ran it at all.
    // Stryker does not execute these mutants (no covering test could fail), so
    // they are reported by status rather than by outcome.
    const result = parseStrykerJson(report, ['src/changed.ts']);
    expect(result).toContainEqual({
      ruleId: 'stryker/no-coverage',
      file: 'src/changed.ts',
      line: 30,
      message:
        'ArithmeticOperator mutant was never executed — no test covers this line',
      severity: 'error',
      fixable: false,
      tool: 'stryker',
    });
  });

  it('ignores Killed mutants and mutants in unchanged files', () => {
    // Paired with the two positive cases above: an adapter that emitted
    // everything, or nothing, fails one of the three.
    const result = parseStrykerJson(report, ['src/changed.ts']);
    expect(result).toHaveLength(2);
    expect(
      result.map((v) => v.line).toSorted((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([12, 30]);
    expect(result.every((v) => v.file === 'src/changed.ts')).toBe(true);
  });

  it('distinguishes the two failure classes by ruleId, not by message alone', () => {
    // The remedies differ — write a covering test vs strengthen an existing
    // assertion — so the fixer routes on ruleId.
    const result = parseStrykerJson(report, ['src/changed.ts']);
    expect(
      result.map((v) => v.ruleId).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['stryker/no-coverage', 'stryker/survived']);
  });

  it('returns [] on malformed or wrong-shaped JSON', () => {
    expect(parseStrykerJson('not json', ['src/changed.ts'])).toEqual([]);
    expect(parseStrykerJson('{"files":"nope"}', ['src/changed.ts'])).toEqual(
      [],
    );
  });
});

/**
 * Guard-rejection suite. Every case pairs the malformed entry with a VALID
 * Survived mutant in a changed file, so a guard that wrongly ACCEPTS the input
 * emits a violation and the `toEqual([])` assertion fails. Asserting `[]`
 * against malformed input alone is not enough: most guards fail open to `[]`
 * anyway, which is why these mutants survived the original suite.
 */
const validMutant = {
  id: 'ok',
  mutatorName: 'ConditionalExpression',
  status: 'Survived',
  location: { start: { line: 3, column: 1 }, end: { line: 3, column: 9 } },
};

function reportWith(mutants: unknown[]): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    files: {
      'src/changed.ts': { language: 'typescript', source: '', mutants },
    },
  });
}

const changed = ['src/changed.ts'];

/**
A report whose first mutant overrides `validMutant` with a bad field.
*/
function bad(fields: Record<string, unknown>): string {
  return reportWith([{ ...validMutant, ...fields }, validMutant]);
}

describe('parseStrykerJson guard rejection', () => {
  it('rejects a null or non-object report', () => {
    expect(parseStrykerJson('null', changed)).toEqual([]);
    expect(parseStrykerJson('"a string"', changed)).toEqual([]);
    expect(parseStrykerJson('5', changed)).toEqual([]);
  });

  it('rejects a report whose files key is null or not an object', () => {
    expect(parseStrykerJson('{"files":null}', changed)).toEqual([]);
    expect(parseStrykerJson('{"files":"nope"}', changed)).toEqual([]);
  });

  it('rejects the whole report when ANY file entry is malformed', () => {
    // Kills `.every` -> `.some`: the good file would otherwise be parsed.
    const mixed = JSON.stringify({
      files: {
        'src/changed.ts': { mutants: [validMutant] },
        'src/other.ts': 'not-a-file-result',
      },
    });
    expect(parseStrykerJson(mixed, changed)).toEqual([]);
  });

  it('rejects a null file entry or a non-array mutants field', () => {
    expect(
      parseStrykerJson(
        JSON.stringify({ files: { 'src/changed.ts': null } }),
        changed,
      ),
    ).toEqual([]);
    expect(
      parseStrykerJson(
        JSON.stringify({ files: { 'src/changed.ts': { mutants: 'nope' } } }),
        changed,
      ),
    ).toEqual([]);
  });

  it('rejects a null or non-object mutant', () => {
    expect(parseStrykerJson(reportWith([null, validMutant]), changed)).toEqual(
      [],
    );
    expect(
      parseStrykerJson(reportWith(['not-a-mutant', validMutant]), changed),
    ).toEqual([]);
  });

  it('rejects a mutant with a missing location or a missing location.start', () => {
    expect(
      parseStrykerJson(
        reportWith([
          { id: 'x', mutatorName: 'X', status: 'Survived' },
          validMutant,
        ]),
        changed,
      ),
    ).toEqual([]);
    expect(
      parseStrykerJson(
        reportWith([
          { id: 'x', mutatorName: 'X', status: 'Survived', location: {} },
          validMutant,
        ]),
        changed,
      ),
    ).toEqual([]);
  });

  it('rejects a mutant with a wrongly-typed status, mutatorName, or line', () => {
    expect(parseStrykerJson(bad({ status: 1 }), changed)).toEqual([]);
    expect(parseStrykerJson(bad({ mutatorName: 5 }), changed)).toEqual([]);
    expect(
      parseStrykerJson(bad({ location: { start: { line: 'nope' } } }), changed),
    ).toEqual([]);
  });

  it('does not fall through to parsing when the report shape is rejected', () => {
    // Kills the early-return removal at the `isReport` guard: this shape is
    // rejected, but parsing it anyway would dereference a missing `location`.
    const shaped = JSON.stringify({
      files: { 'src/changed.ts': { mutants: [{ status: 'Survived' }] } },
    });
    expect(parseStrykerJson(shaped, changed)).toEqual([]);
  });
});

describe('isStrykerReportJson', () => {
  it('accepts a real report, empty or not', () => {
    expect(isStrykerReportJson(report)).toBe(true);
    expect(isStrykerReportJson(JSON.stringify({ files: {} }))).toBe(true);
  });

  it('rejects payloads that parse as JSON but are not a report', () => {
    // This is the whole reason the predicate exists. `parseStrykerJson` answers
    // `[]` for a malformed payload and for a genuinely empty report alike, so
    // `runStryker` cannot use it to tell "the run completed and found nothing"
    // from "what is at the report path is not a report" — and reading the
    // second as the first is a silently clean mutation gate.
    expect(isStrykerReportJson('{}')).toBe(false);
    expect(isStrykerReportJson('null')).toBe(false);
    expect(isStrykerReportJson('[]')).toBe(false);
    expect(isStrykerReportJson('5')).toBe(false);
    expect(isStrykerReportJson(JSON.stringify({ files: 'nope' }))).toBe(false);
    expect(isStrykerReportJson(JSON.stringify({ files: { 'a.ts': {} } }))).toBe(
      false,
    );
  });

  it('rejects output that is not JSON at all', () => {
    // A truncated or half-written file throws in `JSON.parse`; the catch must
    // answer "not a report", never let the exception escape into the gate.
    expect(isStrykerReportJson('')).toBe(false);
    expect(isStrykerReportJson('{"files":')).toBe(false);
    expect(isStrykerReportJson('<html>500</html>')).toBe(false);
  });
});

const at = (line: number) => ({ start: { line } });

function reportOf(mutants: unknown[]): string {
  return JSON.stringify({ files: { 'src/a.ts': { mutants } } });
}

describe('unrunSurvivedMutants', () => {
  it('counts a Survived mutant whose covering tests never ran', () => {
    const json = reportOf([
      {
        status: 'Survived',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: ['0', '1'],
        testsCompleted: 0,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(1);
  });

  it('does not count a genuine survivor, whose covering test did run', () => {
    const json = reportOf([
      {
        status: 'Survived',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: ['0'],
        testsCompleted: 1,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(0);
  });

  it('does not count a Killed mutant, whatever its counters say', () => {
    const json = reportOf([
      {
        status: 'Killed',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: ['0', '1'],
        testsCompleted: 0,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(0);
  });

  it('does not count NoCoverage, which legitimately runs no tests', () => {
    const json = reportOf([
      {
        status: 'NoCoverage',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: [],
        testsCompleted: 0,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(0);
  });

  // This is the shape a runner WITHOUT per-test data produces, and it is why
  // the guard keys on `coveredBy` rather than on `testsCompleted` alone.
  // Measured on the `command` runner -- the one `init` seeds by default -- with
  // a deliberately vacuous test: 11 genuine survivors, every one of them
  // `coveredBy: []`. A runner that cannot attribute tests to mutants reports no
  // covering list at all, so it exits at the `covering === 0` check and its
  // honest `Survived` verdicts are never reclassified. Zero misfires.
  it('does not count a Survived mutant with no covering tests at all', () => {
    const json = reportOf([
      {
        status: 'Survived',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: [],
        testsCompleted: 0,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(0);
  });

  it('does not count a mutant from a file outside the changed set', () => {
    const json = JSON.stringify({
      files: {
        'src/other.ts': {
          mutants: [
            {
              status: 'Survived',
              mutatorName: 'EqualityOperator',
              location: at(1),
              coveredBy: ['0'],
              testsCompleted: 0,
            },
          ],
        },
      },
    });
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(0);
  });

  it('treats a missing testsCompleted as unrun, failing closed', () => {
    const json = reportOf([
      {
        status: 'Survived',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: ['0'],
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(1);
  });

  it('answers 0 for a payload that is not JSON at all', () => {
    expect(unrunSurvivedMutants('not json', ['src/a.ts'])).toBe(0);
  });

  it('answers 0 for JSON that parses but is not a report', () => {
    expect(unrunSurvivedMutants('{"nope":1}', ['src/a.ts'])).toBe(0);
  });

  it('treats an absent coveredBy as no covering tests, not as unrun', () => {
    const json = reportOf([
      {
        status: 'Survived',
        mutatorName: 'EqualityOperator',
        location: at(1),
        testsCompleted: 0,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(0);
  });

  it('counts every affected mutant, so the message can say how many', () => {
    const json = reportOf([
      {
        status: 'Survived',
        mutatorName: 'EqualityOperator',
        location: at(1),
        coveredBy: ['0'],
        testsCompleted: 0,
      },
      {
        status: 'Survived',
        mutatorName: 'ConditionalExpression',
        location: at(2),
        coveredBy: ['0'],
        testsCompleted: 0,
      },
    ]);
    expect(unrunSurvivedMutants(json, ['src/a.ts'])).toBe(2);
  });
});

/**
 * The message a surviving mutant carrying `replacement` renders to. Built on
 * the module's existing `reportWith` rather than a second report builder --
 * `dupes` would rightly flag a near-copy, and the two want the same thing.
 */
function messageFor(replacement: unknown): string {
  const [violation] = parseStrykerJson(
    reportWith([{ ...validMutant, status: 'Survived', replacement }]),
    changed,
  );
  return violation?.message ?? '';
}

describe('parseStrykerJson: what the mutation actually did', () => {
  /**
   * The fixer that resolves a surviving mutant has Read/Edit/Write and no way
   * to run stryker, so it writes assertions blind — reported from a real
   * adoption (#49), where it claimed eight mutants addressed and several were
   * still alive on the re-run.
   *
   * Stryker's report already says what each mutant replaced the code WITH; the
   * adapter parsed that field and discarded it. Carrying it into the message
   * turns "assert something about this line" into "assert the thing that
   * distinguishes it from this value" — without giving the fixer the ability
   * to execute anything, which would weaken the scope-lock the design rests on.
   */
  it('names the replacement the mutant substituted', () => {
    const message = messageFor('false');

    expect(message).toContain('false');
  });

  it('reads as two sentences, not a run-on', () => {
    // Neither FAILURES reason ends in punctuation, so the detail has to supply
    // the break. Caught by rendering 387 real mutants from this repo's own
    // report rather than by the fixtures above.
    const message = messageFor('false');

    expect(message).toContain('behavior. It replaced');
  });

  it('keeps the mutator name and the reason alongside it', () => {
    // The replacement ADDS to the diagnosis; it does not replace it. The
    // mutator name is what the fixer routes on, and the reason is what
    // separates a survivor from an uncovered line.
    const message = messageFor('false');

    expect(message).toContain('ConditionalExpression');
    expect(message).toContain('survived');
  });

  it('reads normally when the report carries no replacement', () => {
    // `replacement` is optional in the schema, and a runner that omits it must
    // still produce a sensible message rather than an "undefined".
    const message = messageFor(undefined);

    expect(message).toBe(
      'ConditionalExpression mutant survived — a test executes this line but does not assert its behavior',
    );
    expect(message).not.toContain('undefined');
  });

  it('ignores a replacement that is not a string', () => {
    // Boundary data: the report is JSON off disk, so the field is validated
    // rather than trusted, like every other field this adapter reads.
    const message = messageFor(42);

    expect(message).not.toContain('42');
  });

  it('truncates a runaway replacement rather than pasting a whole block', () => {
    // A BlockStatement mutant's replacement can be an entire function body.
    // The manifest is the fixer's context budget; one mutant must not consume
    // it.
    const message = messageFor('x'.repeat(500));

    expect(message.length).toBeLessThan(300);
    expect(message).toContain('…');
  });

  it('says nothing for a replacement that is only whitespace', () => {
    // `.trim()` is load-bearing: a blank replacement carries no information,
    // and rendering it would append an empty pair of backticks.
    expect(messageFor(' '.repeat(4))).not.toContain('It replaced');
  });

  it('collapses every run of whitespace to a single space', () => {
    // Not just newlines: a replacement can carry indentation, and one run of
    // whitespace must become exactly one space rather than merely losing its
    // newlines.
    expect(messageFor('if (a)   {\n\t return b;  }')).toContain(
      '`if (a) { return b; }`',
    );
  });

  it('strips whitespace at the edges of the replacement', () => {
    // Collapsing runs to single spaces is not enough on its own: a replacement
    // that starts or ends with whitespace would render as `` ` false ` ``,
    // which reads as though the space were part of the code.
    expect(messageFor('  false  ')).toContain('`false`');
  });

  it('keeps a replacement of exactly the budget intact', () => {
    // The boundary. `>` not `>=`: a replacement that exactly fills the budget
    // is shown whole, and only one longer is cut.
    const exact = 'y'.repeat(80);

    expect(messageFor(exact)).toContain(`\`${exact}\``);
    expect(messageFor(exact)).not.toContain('…');
  });

  it('truncates one character over the budget', () => {
    expect(messageFor('y'.repeat(81))).toContain('…');
  });

  it('keeps a multi-line replacement on one line', () => {
    // Violations are rendered one per line in the manifest and in the gate's
    // dump; an embedded newline would break both.
    const message = messageFor('if (a) {\n  return b;\n}');

    expect(message).not.toContain('\n');
  });
});
