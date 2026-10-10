import { describe, expect, it } from 'vitest';

import { addedSuppressions } from '../src/edit-suppressions.js';

describe('addedSuppressions', () => {
  it('reports a suppression the edit introduces', () => {
    const added = addedSuppressions([
      {
        file: 'src/a.ts',
        before: 'const a = 1;',
        after: '// eslint-disable-next-line\nconst a = 1;',
      },
    ]);
    expect(added.map((finding) => finding.kind)).toEqual(['eslint-disable']);
    expect(added[0]?.file).toBe('src/a.ts');
  });

  it('ignores a suppression the edit only carries over', () => {
    // An Edit's replacement text routinely includes lines it did not change;
    // a directive present before and after is not one the fixer added.
    const directive = '// fallow-ignore-next-line code-duplication';
    expect(
      addedSuppressions([
        {
          file: 'src/a.ts',
          before: `${directive}\nexport function a() {}`,
          after: `${directive}\nexport function a() { return 1; }`,
        },
      ]),
    ).toEqual([]);
  });

  it('counts occurrences, so a second copy of an existing directive is added', () => {
    const directive = '// Stryker disable next-line StringLiteral';
    const added = addedSuppressions([
      {
        file: 'src/a.ts',
        before: `${directive}\nconst a = 'x';`,
        after: `${directive}\nconst a = 'x';\n${directive}\nconst b = 'y';`,
      },
    ]);
    expect(added.map((finding) => finding.kind)).toEqual(['mutation-suppress']);
  });

  it('flags an `as any` cast like any other suppression', () => {
    const added = addedSuppressions([
      { file: 'src/a.ts', before: 'f(x);', after: 'f(x as any);' },
    ]);
    expect(added.map((finding) => finding.kind)).toEqual(['cast-any']);
  });

  it('ignores files the auditor does not read', () => {
    expect(
      addedSuppressions([
        { file: 'README.md', before: '', after: '// eslint-disable' },
      ]),
    ).toEqual([]);
  });

  it('keeps edits to different files apart', () => {
    // The same directive removed from one file and added to another is still
    // an addition.
    const directive = '// eslint-disable-next-line';
    const added = addedSuppressions([
      { file: 'src/a.ts', before: directive, after: '' },
      { file: 'src/b.ts', before: '', after: directive },
    ]);
    expect(added.map((finding) => finding.file)).toEqual(['src/b.ts']);
  });
});
