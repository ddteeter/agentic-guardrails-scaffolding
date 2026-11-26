import { describe, expect, it } from 'vitest';

import { repoRelative } from '../src/repo-relative.js';

describe('repoRelative', () => {
  it('makes an absolute path relative to the root', () => {
    expect(repoRelative('/repo', '/repo/src/a.ts')).toBe('src/a.ts');
  });

  it('keeps a path that is already relative', () => {
    expect(repoRelative('/repo', 'src/a.ts')).toBe('src/a.ts');
  });

  it('answers with / between the parts', () => {
    expect(repoRelative('/repo', '/repo/a/b/c.ts').split('/')).toEqual([
      'a',
      'b',
      'c.ts',
    ]);
  });
});
