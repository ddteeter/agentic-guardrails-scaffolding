import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { upwardFrom } from '../src/path-walk.js';

describe('upwardFrom', () => {
  it('yields the starting directory first', () => {
    expect([...upwardFrom('/repo/packages/web')][0]).toBe(
      path.resolve('/repo/packages/web'),
    );
  });

  it('yields each ancestor in order and stops at the filesystem root', () => {
    const walked = [...upwardFrom('/repo/packages/web')];
    expect(walked).toEqual([
      path.resolve('/repo/packages/web'),
      path.resolve('/repo/packages'),
      path.resolve('/repo'),
      path.parse(path.resolve('/repo')).root,
    ]);
  });

  it('yields exactly once when started at the filesystem root', () => {
    // The termination case: dirname('/') === '/', so a naive loop never ends.
    const root = path.parse(path.resolve('/')).root;
    expect([...upwardFrom(root)]).toEqual([root]);
  });

  it('resolves a relative start against the working directory', () => {
    expect([...upwardFrom('.')][0]).toBe(process.cwd());
  });
});
