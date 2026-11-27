import { describe, expect, it } from 'vitest';

import type { StackConfig } from '../../src/packs/pack.js';
import {
  STACK_PACK_IDS,
  debugTargetsOf,
  defaultTrigger,
  implicitStack,
  implicitStacks,
  isStackPackId,
  packOf,
  perPack,
  perStack,
  stackOf,
} from '../../src/packs/stacks.js';

function same(file: string): string {
  return file;
}

function ownedAnswer(): string {
  return 'owned';
}

function owned(): (file: string) => string {
  return ownedAnswer;
}

function stack(over: Partial<StackConfig>): StackConfig {
  return {
    pack: 'typescript',
    root: '.',
    exclude: [],
    wholeProjectTrigger: 'always',
    debugTargets: [],
    ...over,
  };
}

describe('implicitStacks', () => {
  it('is one TypeScript stack at the root that always runs whole-project analyzers', () => {
    expect(implicitStacks()).toEqual([
      {
        pack: 'typescript',
        root: '.',
        exclude: [],
        wholeProjectTrigger: 'always',
        debugTargets: [],
      },
    ]);
  });
});

describe('isStackPackId', () => {
  it('knows the packs guardrails has ids for', () => {
    expect(STACK_PACK_IDS).toEqual(['typescript', 'swift']);
    expect(isStackPackId('typescript')).toBe(true);
    expect(isStackPackId('swift')).toBe(true);
  });

  it.each(['java', '', 'Swift', 3, undefined])('rejects %j', (value) => {
    expect(isStackPackId(value)).toBe(false);
  });
});

describe('packOf', () => {
  const packs = [{ id: 'typescript' as const }, { id: 'swift' as const }];

  it('finds the pack a stack names', () => {
    expect(packOf(packs, stack({ pack: 'swift' }))).toBe(packs[1]);
    expect(packOf(packs, stack({}))).toBe(packs[0]);
  });

  it('finds nothing when this version has no such pack', () => {
    expect(packOf(packs.slice(0, 1), stack({ pack: 'swift' }))).toBeUndefined();
  });
});

describe('implicitStack', () => {
  it('is the one stack implicitStacks holds', () => {
    expect([implicitStack()]).toEqual(implicitStacks());
  });
});

describe('defaultTrigger', () => {
  it.each([
    ['typescript', 'always'],
    ['swift', 'stack-changes'],
  ] as const)('%s defaults to %s', (pack, trigger) => {
    expect(defaultTrigger(pack)).toBe(trigger);
  });
});

describe('stackOf', () => {
  const web = stack({ exclude: ['ios/**'] });
  const ios = stack({ pack: 'swift', root: 'ios' });

  it('gives a root stack every file', () => {
    expect(stackOf('src/a.ts', [stack({})])).toEqual(stack({}));
    expect(stackOf('README.md', [stack({})])).toEqual(stack({}));
  });

  it('gives a file to the stack with the longest root that contains it', () => {
    const nested = stack({ pack: 'swift', root: 'ios/Packages' });
    expect(stackOf('ios/Packages/A/a.swift', [stack({}), ios, nested])).toBe(
      nested,
    );
    expect(stackOf('ios/Packages/A/a.swift', [nested, ios, stack({})])).toBe(
      nested,
    );
    expect(stackOf('ios/App/a.swift', [stack({}), ios, nested])).toBe(ios);
  });

  it('gives a file to the first of two stacks with the same root', () => {
    const second = stack({ pack: 'swift', root: 'ios' });
    expect(stackOf('ios/a.swift', [ios, second])).toBe(ios);
    expect(stackOf('ios/a.swift', [second, ios])).toBe(second);
  });

  it('counts the repository root as the shortest root of all', () => {
    const short = stack({ pack: 'swift', root: 'a' });
    expect(stackOf('a/x.swift', [stack({}), short])).toBe(short);
  });

  it('matches a root by whole path segments', () => {
    expect(stackOf('ios-tools/a.ts', [ios])).toBeUndefined();
    expect(stackOf('ios', [ios])).toBeUndefined();
    expect(stackOf('ios/a.swift', [ios])).toBe(ios);
  });

  it('leaves out a file an exclude glob matches', () => {
    expect(stackOf('ios/App/a.swift', [web])).toBeUndefined();
    expect(stackOf('src/a.ts', [web])).toBe(web);
  });

  it('falls back to a shorter root when the longer one excludes the file', () => {
    const picky = stack({
      pack: 'swift',
      root: 'ios',
      exclude: ['ios/Generated/**'],
    });
    expect(stackOf('ios/Generated/a.swift', [stack({}), picky])).toEqual(
      stack({}),
    );
  });

  it('owns nothing when there are no stacks', () => {
    expect(stackOf('src/a.ts', [])).toBeUndefined();
  });
});

describe('perStack', () => {
  const web = stack({ exclude: ['ios/**'] });
  const ios = stack({ pack: 'swift', root: 'ios' });

  it('asks the stack that owns the file', () => {
    const answer = perStack(
      [web, ios],
      (owner) => (file) => `${owner.pack}:${file}`,
    );
    expect(answer('src/a.ts')).toBe('typescript:src/a.ts');
    expect(answer('ios/a.swift')).toBe('swift:ios/a.swift');
  });

  it('answers nothing for a file no stack owns', () => {
    const answer = perStack([ios], owned);
    expect(answer('src/a.ts')).toBeUndefined();
  });

  it('binds each stack once, and only when one of its files is asked about', () => {
    const bound: string[] = [];
    const answer = perStack([web, ios], (owner) => {
      bound.push(owner.pack);
      return same;
    });
    expect(bound).toEqual([]);
    answer('ios/a.swift');
    answer('ios/b.swift');
    expect(bound).toEqual(['swift']);
    answer('src/a.ts');
    expect(bound).toEqual(['swift', 'typescript']);
  });

  it('answers nothing when the stack has no answerer', () => {
    const answer = perStack([web, ios], (owner) =>
      owner.pack === 'swift' ? undefined : same,
    );
    expect(answer('ios/a.swift')).toBeUndefined();
    expect(answer('src/a.ts')).toBe('src/a.ts');
  });
});

describe('perPack', () => {
  const web = stack({ exclude: ['ios/**'] });
  const ios = stack({ pack: 'swift', root: 'ios' });
  const packs = [
    { id: 'typescript' as const, name: 'ts' },
    { id: 'swift' as const, name: 'sw' },
  ];

  it('hands the bind the pack that gates the owning stack, and the stack', () => {
    const answer = perPack(
      [web, ios],
      packs,
      (pack, owner) => (file) => `${pack.name}@${owner.root}:${file}`,
    );
    expect(answer('src/a.ts')).toBe('ts@.:src/a.ts');
    expect(answer('ios/a.swift')).toBe('sw@ios:ios/a.swift');
  });

  it('answers nothing for a stack whose pack this version does not have', () => {
    const answer = perPack([web, ios], packs.slice(0, 1), owned);
    expect(answer('ios/a.swift')).toBeUndefined();
    expect(answer('src/a.ts')).toBe('owned');
  });
});

describe('debugTargetsOf', () => {
  it('gathers every stack’s debug targets, in order', () => {
    expect(
      debugTargetsOf([
        stack({}),
        stack({ pack: 'swift', root: 'ios', debugTargets: ['Hooks', 'Menu'] }),
        stack({ pack: 'swift', root: 'mac', debugTargets: ['MacHooks'] }),
      ]),
    ).toEqual(['Hooks', 'Menu', 'MacHooks']);
  });

  it('has none when no stacks are configured', () => {
    expect(debugTargetsOf(undefined)).toEqual([]);
  });
});
