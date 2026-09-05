import { describe, expect, it } from 'vitest';

import { parseNpmLsJson } from '../../src/verify/npm-peers-adapter.js';

/**
The repo every fixture below is installed inside.
*/
const REPO = '/repo';

/** A node physically installed in this repo's `node_modules`. `--long` supplies
 *  this `path`, and it is what separates this repo's graph from a linked
 *  dependency's. */
function inRepo(
  name: string,
  node: Record<string, unknown>,
): Record<string, unknown> {
  return { path: `${REPO}/node_modules/${name}`, ...node };
}

function parse(tree: unknown): ReturnType<typeof parseNpmLsJson> {
  return parseNpmLsJson(
    typeof tree === 'string' ? tree : JSON.stringify(tree),
    REPO,
  );
}

function messagesOf(tree: unknown): string[] {
  return parse(tree).map((violation) => violation.message);
}

/**
The greenfield failure, in npm's own words.
*/
const INVALID_RANGE =
  '">=4.8.4 <6.1.0" from node_modules/typescript-eslint, ' +
  '">=4.8.4 <6.1.0" from node_modules/@typescript-eslint/parser';

/**
The same violation reachable by two paths — npm repeats it per path.
*/
const duplicatedTree = {
  dependencies: {
    'typescript-eslint': inRepo('typescript-eslint', {
      version: '8.69.0',
      dependencies: {
        typescript: inRepo('typescript', {
          version: '7.0.2',
          invalid: INVALID_RANGE,
        }),
      },
    }),
    '@typescript-eslint/parser': inRepo('@typescript-eslint/parser', {
      version: '8.69.0',
      dependencies: {
        typescript: inRepo('typescript', {
          version: '7.0.2',
          invalid: INVALID_RANGE,
        }),
      },
    }),
  },
};

describe('parseNpmLsJson', () => {
  it('reports an installed package that violates a peer range', () => {
    expect(parse(duplicatedTree)).toEqual([
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
    const [violation] = parse(duplicatedTree);
    expect(violation?.message).toContain('typescript@7.0.2');
    expect(violation?.message).toContain('>=4.8.4 <6.1.0');
    expect(violation?.message).toContain('typescript-eslint');
  });

  it('de-duplicates a violation reachable by several paths', () => {
    // The tree above holds the same finding twice; one real fixture produced a
    // dozen. Reporting each would bury the signal.
    expect(parse(duplicatedTree)).toHaveLength(1);
  });

  it('reports two genuinely different packages separately', () => {
    // The positive control for de-duplication: a de-duplicator keyed too
    // broadly would collapse these into one, and the test above would pass.
    expect(
      messagesOf({
        dependencies: {
          typescript: inRepo('typescript', {
            version: '7.0.2',
            invalid: '">=4 <6.1" from a',
          }),
          eslint: inRepo('eslint', {
            version: '10.9.1',
            invalid: '"^9" from b',
          }),
        },
      }),
    ).toEqual([
      expect.stringContaining('typescript@7.0.2'),
      expect.stringContaining('eslint@10.9.1'),
    ]);
  });

  it('reports two versions of one package as two findings', () => {
    // A hoisting conflict: npm's tree holds `typescript` twice, at different
    // paths and different versions, each invalid against a different range.
    // These are distinct findings with distinct remedies, so a de-duplicator
    // keyed on the package NAME would report the first and silently drop the
    // second -- and the dropped one is real.
    expect(
      messagesOf({
        dependencies: {
          'pkg-a': inRepo('pkg-a', {
            version: '1.0.0',
            dependencies: {
              typescript: inRepo('pkg-a/node_modules/typescript', {
                version: '7.0.2',
                invalid: '">=4 <6.1" from pkg-a',
              }),
            },
          }),
          'pkg-b': inRepo('pkg-b', {
            version: '1.0.0',
            dependencies: {
              typescript: inRepo('pkg-b/node_modules/typescript', {
                version: '4.0.0',
                invalid: '">=5" from pkg-b',
              }),
            },
          }),
        },
      }),
    ).toEqual([
      expect.stringContaining('typescript@7.0.2'),
      expect.stringContaining('typescript@4.0.0'),
    ]);
  });

  it('still collapses one version reached by several paths', () => {
    // The counterpart the key must not break: npm accumulates requirers as it
    // walks, so the SAME physical package reports a progressively longer
    // `invalid` string at deeper paths. Keying on that text would restore the
    // duplicate-per-path noise; keying on name@version does not.
    expect(
      parse({
        dependencies: {
          'pkg-a': inRepo('pkg-a', {
            version: '1.0.0',
            dependencies: {
              typescript: inRepo('typescript', {
                version: '7.0.2',
                invalid: '">=4 <6.1" from pkg-a',
              }),
            },
          }),
          'pkg-b': inRepo('pkg-b', {
            version: '1.0.0',
            dependencies: {
              typescript: inRepo('typescript', {
                version: '7.0.2',
                invalid: '">=4 <6.1" from pkg-a, ">=4 <6.1" from pkg-b',
              }),
            },
          }),
        },
      }),
    ).toHaveLength(1);
  });

  it('ignores a package installed outside the repo', () => {
    // A `file:` dependency or `npm link` puts a SYMLINK in node_modules, and
    // `npm ls --all` walks through it into the target's own tree. Measured in
    // CI: the smoke fixture installs TypeScript by local path, and the check
    // reported seven findings belonging to the development repo -- including
    // "chai violates a range required by node_modules/typescript", which
    // TypeScript does not require. Paired with an in-repo finding so a parser
    // that dropped everything would fail here too.
    expect(
      messagesOf({
        dependencies: {
          chai: {
            path: '/elsewhere/node_modules/chai',
            version: '6.2.2',
            invalid: '"^4.5.0" from /elsewhere/node_modules/typescript',
          },
          typescript: inRepo('typescript', {
            version: '7.0.2',
            invalid: '">=4 <6.1" from a',
          }),
        },
      }),
    ).toEqual([expect.stringContaining('typescript@7.0.2')]);
  });

  it('does not mistake a sibling directory for the repo', () => {
    // '/repo-other' shares '/repo' as a string prefix but is not inside it.
    expect(
      messagesOf({
        dependencies: {
          chai: {
            path: '/repo-other/node_modules/chai',
            version: '6.2.2',
            invalid: '"^4.5.0" from x',
          },
          typescript: inRepo('typescript', {
            version: '7.0.2',
            invalid: '">=4 <6.1" from a',
          }),
        },
      }),
    ).toEqual([expect.stringContaining('typescript@7.0.2')]);
  });

  it('skips a node whose path npm did not report', () => {
    // A finding we cannot locate is one we cannot vouch for, and this is a
    // diagnostic rather than a gate of last resort.
    expect(
      messagesOf({
        dependencies: {
          chai: { version: '6.2.2', invalid: '"^4.5.0" from x' },
          typescript: inRepo('typescript', {
            version: '7.0.2',
            invalid: '">=4 <6.1" from a',
          }),
        },
      }),
    ).toEqual([expect.stringContaining('typescript@7.0.2')]);
  });

  it('ignores missing peers, which are frequently legitimate', () => {
    // An absent OPTIONAL peer is normal. Only `invalid` means a package is
    // installed at a version that violates a range.
    expect(
      messagesOf({
        dependencies: {
          eslint: inRepo('eslint', {
            missing: true,
            problems: ['missing: eslint@^9, required by x@1.0.0'],
          }),
          typescript: inRepo('typescript', {
            version: '7.0.2',
            invalid: '">=4 <6.1" from a',
          }),
        },
      }),
    ).toEqual([expect.stringContaining('typescript@7.0.2')]);
  });

  it('ignores an empty invalid string', () => {
    expect(
      messagesOf({
        dependencies: {
          eslint: inRepo('eslint', { version: '10.9.1', invalid: '' }),
          typescript: inRepo('typescript', {
            version: '7.0.2',
            invalid: '">=4 <6.1" from a',
          }),
        },
      }),
    ).toEqual([expect.stringContaining('typescript@7.0.2')]);
  });

  it('still reports a violation whose version npm omitted', () => {
    expect(
      parse({
        dependencies: {
          typescript: inRepo('typescript', { invalid: '">=4 <6.1" from a' }),
        },
      })[0]?.message,
    ).toContain('typescript@unknown');
  });

  it('is empty for a healthy tree', () => {
    expect(
      parse({
        dependencies: {
          typescript: inRepo('typescript', { version: '5.9.3' }),
        },
      }),
    ).toEqual([]);
  });

  it('is empty for output that is not a tree', () => {
    expect(parse('not json')).toEqual([]);
    expect(parse('[]')).toEqual([]);
    expect(parse('null')).toEqual([]);
  });

  it('is empty for a tree with no dependencies at all', () => {
    expect(parse({ name: 'x' })).toEqual([]);
  });

  it('skips a dependency entry that is not an object', () => {
    // `null` rather than a string on purpose. Destructuring a string yields
    // undefined and walks on, so a string cannot tell a working guard from a
    // missing one -- but destructuring `null` THROWS, so this fails loudly if
    // the guard is ever dropped. Paired with a real finding so a parser that
    // bailed out entirely would fail too.
    expect(
      parse({
        dependencies: {
          broken: null,
          alsoBroken: 'not-an-object',
          typescript: inRepo('typescript', {
            version: '7.0.2',
            invalid: '">=4 <6.1" from a',
          }),
        },
      }),
    ).toHaveLength(1);
  });
});
