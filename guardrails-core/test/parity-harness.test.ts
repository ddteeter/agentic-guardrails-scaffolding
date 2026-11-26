/**
 * The parity harness's own pieces (GR-01), checked without any analyzer: a
 * normaliser that rewrote too much would hide exactly the difference the
 * goldens exist to catch.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type ParityFixture,
  fixtureNames,
  loadFixture,
  materialise,
} from './parity/fixture.js';
import { normalise } from './parity/normalise.js';
import { PARITY_COMMANDS, commandKey } from './parity/run.js';

describe('normalise', () => {
  it('replaces every occurrence of the fixture root', () => {
    expect(normalise('/work/p-1/src/a.ts and /work/p-1/b', ['/work/p-1'])).toBe(
      '<root>/src/a.ts and <root>/b',
    );
  });

  it('replaces the longer spelling first, so neither eats the other', () => {
    expect(
      normalise('/private/work/p-1/a /work/p-1/b', [
        '/work/p-1',
        '/private/work/p-1',
      ]),
    ).toBe('<root>/a <root>/b');
  });

  it('reads a root as text, not as a pattern', () => {
    expect(normalise('/work/pXq/a /work/p.q/a', ['/work/p.q'])).toBe(
      '/work/pXq/a <root>/a',
    );
  });

  it('leaves counts, rule ids and line numbers alone', () => {
    const line = 'src/a.ts:12 [TS2322] took 3 s, 5 m, 12 lines (limit 5)';
    expect(normalise(line, ['/work/p-1'])).toBe(line);
  });
});

describe('fixtures', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
    root = undefined;
  });

  const fixture: ParityFixture = {
    description: 'harness check',
    nodeModules: 'none',
    base: { 'a.txt': 'base\n', 'gone.txt': null, 'nested/b.txt': 'b\n' },
    change: { 'a.txt': 'changed\n', 'c.txt': 'new\n' },
  };

  it('writes the base, then the change over it', () => {
    root = materialise(fixture);
    expect(readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(path.join(root, 'nested', 'b.txt'), 'utf8')).toBe(
      'b\n',
    );
    expect(readFileSync(path.join(root, 'c.txt'), 'utf8')).toBe('new\n');
    expect(existsSync(path.join(root, 'gone.txt'))).toBe(false);
  });

  it('links node_modules only when asked to', () => {
    root = materialise(fixture);
    expect(existsSync(path.join(root, 'node_modules'))).toBe(false);
  });

  it('lays a fixture over the common base', () => {
    const clean = loadFixture('clean');
    expect(Object.keys(clean.base)).toContain('tsconfig.json');
    expect(clean.base['guardrails.config.json']).toContain(
      '"eslint": "required"',
    );
  });

  it('names every fixture but the common base', () => {
    expect(fixtureNames()).toContain('clean');
    expect(fixtureNames()).not.toContain('_base');
  });
});

describe('commands', () => {
  it('keys a golden by the argv a hook would pass', () => {
    expect(PARITY_COMMANDS.map((argv) => commandKey(argv))).toEqual([
      'gate --mode=commit',
      'gate --mode=push',
      'gate --mode=ci',
      'verify',
    ]);
  });
});
