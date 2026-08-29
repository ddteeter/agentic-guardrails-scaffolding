import { describe, expect, it } from 'vitest';

import { parseStrykerJson } from '../../src/verify/stryker-adapter.js';

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
    // No packageId argument: the exact-object match below asserts the
    // emitted violation carries no `package` key.
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

  it('ignores Killed, NoCoverage, and survivors in unchanged files', () => {
    const result = parseStrykerJson(report, ['src/changed.ts']);
    expect(result).toHaveLength(1);
    expect(result.map((v) => v.line)).toEqual([12]);
  });

  it('adds the package id when given', () => {
    const result = parseStrykerJson(
      report,
      ['src/changed.ts'],
      'guardrails-core',
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        package: 'guardrails-core',
        ruleId: 'stryker/survived',
      }),
    );
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

/** A report whose first mutant overrides `validMutant` with a bad field. */
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

  it('omits the package key entirely when no packageId is given', () => {
    // Kills the `packageId === undefined` ternary mutant, which would spread
    // `{ package: undefined }` — an own key that `toEqual` alone would miss.
    const result = parseStrykerJson(reportWith([validMutant]), changed);
    expect(result).toHaveLength(1);
    expect(result.every((v) => !Object.hasOwn(v, 'package'))).toBe(true);
  });
});
