import { describe, expect, it } from 'vitest';

import { parseFallowDupesJson } from '../../src/verify/fallow-adapter.js';

/**
 * A minimal `fallow dupes --format json` envelope. Only the fields the adapter
 * reads are modelled; the real report carries `stats`, `next_steps` and a
 * `fragment` per instance, all deliberately ignored (see the adapter header).
 */
function report(
  groups: {
    instances: { file: string; start_line: number; end_line?: number }[];
    line_count?: number;
  }[],
): string {
  return JSON.stringify({
    kind: 'dupes',
    schema_version: 7,
    clone_groups: groups.map((group) => ({
      line_count: group.line_count ?? 5,
      token_count: 55,
      fingerprint: 'dup:a61775a0',
      instances: group.instances.map((instance) => ({
        ...instance,
        end_line: instance.end_line ?? instance.start_line + 4,
        fragment: 'irrelevant',
      })),
    })),
  });
}

const crossFile = report([
  {
    instances: [
      { file: 'src/a.ts', start_line: 1 },
      { file: 'src/b.ts', start_line: 1 },
    ],
  },
]);

describe('parseFallowDupesJson', () => {
  it('reports every instance of a group when one side is in the changed set', () => {
    // The whole point of the scoping rule: a fixer shown only the changed half
    // of a clone pair has no way to deduplicate it.
    const violations = parseFallowDupesJson(crossFile, ['src/b.ts']);

    expect(violations.map((violation) => violation.file)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('drops a group that touches nothing in the changed set', () => {
    // Without this, every commit re-reports every pre-existing clone in the
    // repository -- the failure --mode=commit already solves for the others.
    expect(parseFallowDupesJson(crossFile, ['src/unrelated.ts'])).toEqual([]);
  });

  it('reports nothing when nothing changed', () => {
    expect(parseFallowDupesJson(crossFile, [])).toEqual([]);
  });

  it('names the sibling sites, so one violation is actionable alone', () => {
    const [first] = parseFallowDupesJson(crossFile, ['src/a.ts']);

    expect(first?.message).toContain('src/b.ts:1');
    expect(first?.message).not.toContain('src/a.ts:1');
  });

  it('carries the line, the rule id and the loose-class metadata', () => {
    const [first] = parseFallowDupesJson(crossFile, ['src/a.ts']);

    expect(first).toMatchObject({
      ruleId: 'fallow/code-duplication',
      file: 'src/a.ts',
      line: 1,
      severity: 'error',
      fixable: false,
      tool: 'dupes',
    });
  });

  it('states the size of the duplication', () => {
    const [first] = parseFallowDupesJson(
      report([
        {
          line_count: 11,
          instances: [
            { file: 'src/a.ts', start_line: 1 },
            { file: 'src/b.ts', start_line: 40 },
          ],
        },
      ]),
      ['src/a.ts'],
    );

    expect(first?.message).toContain('11 lines');
  });

  it('handles a group with three instances', () => {
    const violations = parseFallowDupesJson(
      report([
        {
          instances: [
            { file: 'src/a.ts', start_line: 1 },
            { file: 'src/b.ts', start_line: 2 },
            { file: 'src/c.ts', start_line: 3 },
          ],
        },
      ]),
      ['src/c.ts'],
    );

    expect(violations).toHaveLength(3);
    expect(violations[0]?.message).toContain('src/b.ts:2, src/c.ts:3');
  });

  it('keeps groups independent of one another', () => {
    const violations = parseFallowDupesJson(
      report([
        {
          instances: [
            { file: 'src/a.ts', start_line: 1 },
            { file: 'src/b.ts', start_line: 1 },
          ],
        },
        {
          instances: [
            { file: 'src/x.ts', start_line: 9 },
            { file: 'src/y.ts', start_line: 9 },
          ],
        },
      ]),
      ['src/x.ts'],
    );

    expect(violations.map((violation) => violation.file)).toEqual([
      'src/x.ts',
      'src/y.ts',
    ]);
  });

  it('returns nothing for output that is not JSON', () => {
    // A crashed analyzer must never read as a clean one; the orchestrator's
    // spawn tracker owns that signal, so the adapter just stays quiet.
    expect(parseFallowDupesJson('not json at all', ['src/a.ts'])).toEqual([]);
  });

  it('returns nothing for JSON of the wrong shape', () => {
    expect(parseFallowDupesJson('{"clone_groups":"nope"}', ['a.ts'])).toEqual(
      [],
    );
    expect(parseFallowDupesJson('[]', ['a.ts'])).toEqual([]);
    expect(parseFallowDupesJson('null', ['a.ts'])).toEqual([]);
  });

  it('skips a group whose instances are not the documented shape', () => {
    // A schema change upstream must degrade to "no findings", not to a throw
    // that takes the whole verify run down.
    const malformed = JSON.stringify({
      clone_groups: [
        { instances: [{ file: 'src/a.ts' }, { file: 'src/b.ts' }] },
        {
          instances: [
            { file: 'src/x.ts', start_line: 1 },
            { file: 'src/y.ts', start_line: 1 },
          ],
        },
      ],
    });

    expect(parseFallowDupesJson(malformed, ['src/a.ts', 'src/x.ts'])).toEqual([
      expect.objectContaining({ file: 'src/x.ts' }),
      expect.objectContaining({ file: 'src/y.ts' }),
    ]);
  });

  it('omits the size when the report carries no line count', () => {
    // The size is decoration; a report that drops the field must still yield an
    // actionable violation rather than an "(undefined lines)" one.
    const sizeless = JSON.stringify({
      clone_groups: [
        {
          instances: [
            { file: 'src/a.ts', start_line: 1 },
            { file: 'src/b.ts', start_line: 1 },
          ],
        },
      ],
    });
    const [first] = parseFallowDupesJson(sizeless, ['src/a.ts']);

    expect(first?.message).toContain('Duplicated code, also at src/b.ts:1');
  });

  it('caps how many sibling sites one message names', () => {
    // A generated file matching itself dozens of times must not become the
    // whole manifest.
    const instances = Array.from({ length: 12 }, (_, index) => ({
      file: `src/f${index}.ts`,
      start_line: index + 1,
    }));
    const [first] = parseFallowDupesJson(report([{ instances }]), [
      'src/f0.ts',
    ]);

    expect(first?.message).toContain('src/f8.ts:9');
    expect(first?.message).not.toContain('src/f9.ts:10');
  });

  it('skips an instance missing its file, rather than reporting a nameless site', () => {
    const nameless = JSON.stringify({
      clone_groups: [
        {
          instances: [{ start_line: 1 }, { file: 'src/b.ts', start_line: 1 }],
        },
      ],
    });

    expect(parseFallowDupesJson(nameless, ['src/b.ts'])).toEqual([]);
  });

  it('skips an instance whose file is not a string', () => {
    const wrongType = JSON.stringify({
      clone_groups: [
        {
          instances: [
            { file: 42, start_line: 1 },
            { file: 'src/b.ts', start_line: 1 },
          ],
        },
      ],
    });

    expect(parseFallowDupesJson(wrongType, ['src/b.ts'])).toEqual([]);
  });

  it('drops a group where only SOME instances parse', () => {
    // The all-or-nothing rule, stated as its own case. Reporting the readable
    // half of a group would name fewer sites than the clone actually has,
    // which is the one thing a duplication finding must not do -- a fixer that
    // deduplicates two of three copies has left the bug in.
    const partial = JSON.stringify({
      clone_groups: [
        {
          instances: [
            { file: 'src/a.ts', start_line: 1 },
            { file: 'src/b.ts' },
          ],
        },
      ],
    });

    expect(parseFallowDupesJson(partial, ['src/a.ts'])).toEqual([]);
  });

  it('skips a group whose instances field is not an array', () => {
    const notArray = JSON.stringify({
      clone_groups: [{ instances: { file: 'src/a.ts', start_line: 1 } }],
    });

    expect(parseFallowDupesJson(notArray, ['src/a.ts'])).toEqual([]);
  });

  it('skips a group that is not an object at all', () => {
    expect(parseFallowDupesJson('{"clone_groups":[null,7]}', ['a.ts'])).toEqual(
      [],
    );
  });

  it('reports a clean tree as no violations', () => {
    expect(parseFallowDupesJson(report([]), ['src/a.ts'])).toEqual([]);
  });
});
