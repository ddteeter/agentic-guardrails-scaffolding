import { describe, expect, it } from 'vitest';

import { parseNpmLsJson } from '../../src/verify/npm-peers-adapter.js';

/** The greenfield failure, in npm's own words. */
const INVALID_RANGE =
  '">=4.8.4 <6.1.0" from node_modules/typescript-eslint, ' +
  '">=4.8.4 <6.1.0" from node_modules/@typescript-eslint/parser';

/** The same violation reachable by two paths — npm repeats it per path. */
const duplicatedTree = JSON.stringify({
  dependencies: {
    'typescript-eslint': {
      version: '8.69.0',
      dependencies: {
        typescript: { version: '7.0.2', invalid: INVALID_RANGE },
      },
    },
    '@typescript-eslint/parser': {
      version: '8.69.0',
      dependencies: {
        typescript: { version: '7.0.2', invalid: INVALID_RANGE },
      },
    },
  },
});

describe('parseNpmLsJson', () => {
  it('reports an installed package that violates a peer range', () => {
    expect(parseNpmLsJson(duplicatedTree)).toEqual([
      expect.objectContaining({
        ruleId: 'guardrails/peer-range-violation',
        file: 'package.json',
        severity: 'error',
        fixable: false,
        tool: 'npm',
      }),
    ]);
  });

  it('names the package, its version, and the range it violates', () => {
    // The message IS the diagnostic -- an agent acts on it without re-running
    // anything, which is the whole reason this check exists.
    const [violation] = parseNpmLsJson(duplicatedTree);
    expect(violation?.message).toContain('typescript@7.0.2');
    expect(violation?.message).toContain('>=4.8.4 <6.1.0');
    expect(violation?.message).toContain('typescript-eslint');
  });

  it('de-duplicates a violation reachable by several paths', () => {
    // The tree above holds the same finding twice; one real fixture produced a
    // dozen. Reporting each would bury the signal.
    expect(parseNpmLsJson(duplicatedTree)).toHaveLength(1);
  });

  it('reports two genuinely different packages separately', () => {
    // The positive control for de-duplication: a de-duplicator keyed too
    // broadly would collapse these into one, and the test above would still
    // pass.
    const tree = JSON.stringify({
      dependencies: {
        typescript: { version: '7.0.2', invalid: '">=4 <6.1" from a' },
        eslint: { version: '10.9.1', invalid: '"^9" from b' },
      },
    });
    expect(parseNpmLsJson(tree).map((violation) => violation.message)).toEqual([
      expect.stringContaining('typescript@7.0.2'),
      expect.stringContaining('eslint@10.9.1'),
    ]);
  });

  it('ignores missing peers, which are frequently legitimate', () => {
    // An absent OPTIONAL peer is normal. Only `invalid` means a package is
    // installed at a version that violates a range. Paired with a real finding
    // so a parser that ignored EVERYTHING would fail here.
    const tree = JSON.stringify({
      dependencies: {
        eslint: {
          missing: true,
          problems: ['missing: eslint@^9, required by x@1.0.0'],
        },
        typescript: { version: '7.0.2', invalid: '">=4 <6.1" from a' },
      },
    });
    expect(parseNpmLsJson(tree).map((violation) => violation.message)).toEqual([
      expect.stringContaining('typescript@7.0.2'),
    ]);
  });

  it('ignores an empty invalid string', () => {
    // Paired with a real finding for the same reason as above.
    const tree = JSON.stringify({
      dependencies: {
        eslint: { version: '10.9.1', invalid: '' },
        typescript: { version: '7.0.2', invalid: '">=4 <6.1" from a' },
      },
    });
    expect(parseNpmLsJson(tree).map((violation) => violation.message)).toEqual([
      expect.stringContaining('typescript@7.0.2'),
    ]);
  });

  it('still reports a violation whose version npm omitted', () => {
    const tree = JSON.stringify({
      dependencies: { typescript: { invalid: '">=4 <6.1" from a' } },
    });
    expect(parseNpmLsJson(tree)[0]?.message).toContain('typescript@unknown');
  });

  it('is empty for a healthy tree', () => {
    const tree = JSON.stringify({
      dependencies: { typescript: { version: '5.9.3' } },
    });
    expect(parseNpmLsJson(tree)).toEqual([]);
  });

  it('is empty for output that is not a tree', () => {
    expect(parseNpmLsJson('not json')).toEqual([]);
    expect(parseNpmLsJson('[]')).toEqual([]);
    expect(parseNpmLsJson('null')).toEqual([]);
  });

  it('is empty for a tree with no dependencies at all', () => {
    expect(parseNpmLsJson(JSON.stringify({ name: 'x' }))).toEqual([]);
  });

  it('skips a dependency entry that is not an object', () => {
    // `null` rather than a string on purpose. Destructuring a string yields
    // undefined and walks on, so a string cannot tell a working guard from a
    // missing one -- but destructuring `null` THROWS, so this fails loudly if
    // the guard is ever dropped. Paired with a real finding so a parser that
    // bailed out entirely would fail too.
    const tree = JSON.stringify({
      dependencies: {
        broken: null,
        alsoBroken: 'not-an-object',
        typescript: { version: '7.0.2', invalid: '">=4 <6.1" from a' },
      },
    });
    expect(parseNpmLsJson(tree)).toHaveLength(1);
  });
});
