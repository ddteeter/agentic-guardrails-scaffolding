/**
 * Which stack a file belongs to (GR-03), and the stack every repository has
 * when it configures none (GR-02).
 */

import path from 'node:path';

import type { StackConfig, StackPackId, WholeProjectTrigger } from './pack.js';

/**
 * Every pack id, as a runtime list: the type is the authority, this is the
 * witness `stacks` parsing and `--stack` validate against.
 */
export const STACK_PACK_IDS: readonly StackPackId[] = ['typescript', 'swift'];

export function isStackPackId(value: unknown): value is StackPackId {
  return (STACK_PACK_IDS as readonly unknown[]).includes(value);
}

/**
The pack that gates `stack`, or none when this version does not have it.
*/
export function packOf<Pack extends { id: StackPackId }>(
  packs: readonly Pack[],
  stack: StackConfig,
): Pack | undefined {
  return packs.find((candidate) => candidate.id === stack.pack);
}

/**
The `root` that means the repository root.
*/
const REPOSITORY_ROOT = '.';

/**
 * TypeScript keeps running knip and dependency-cruiser on every commit, as
 * it always has. A Swift stack's graph checks wait for a change under it:
 * they need a toolchain, and a web-only change cannot break them.
 */
export function defaultTrigger(pack: StackPackId): WholeProjectTrigger {
  return pack === 'typescript' ? 'always' : 'stack-changes';
}

/**
 * What a repository with no `stacks` key has: one TypeScript stack at the
 * root, excluding nothing. This is exactly the behaviour from before stacks
 * existed, which is the point of it.
 */
export function implicitStack(): StackConfig {
  return {
    pack: 'typescript',
    root: REPOSITORY_ROOT,
    exclude: [],
    wholeProjectTrigger: defaultTrigger('typescript'),
    debugTargets: [],
  };
}

/**
`stacks`, for a repository that configured none.
*/
export function implicitStacks(): StackConfig[] {
  return [implicitStack()];
}

function isOwnedBy(stack: StackConfig, file: string): boolean {
  const isUnderRoot =
    stack.root === REPOSITORY_ROOT || file.startsWith(`${stack.root}/`);
  return (
    isUnderRoot &&
    stack.exclude.every((glob) => !path.posix.matchesGlob(file, glob))
  );
}

/**
How specific a root is: the repository root least of all.
*/
function rootLength(stack: StackConfig): number {
  return stack.root === REPOSITORY_ROOT ? 0 : stack.root.length;
}

/**
 * The stack that owns `file` (a repo-relative POSIX path): the one with the
 * longest root that contains it and does not exclude it, the first listed
 * when two roots are the same. A file in no stack has no owner, and no
 * stack's analyzers see it.
 */
export function stackOf(
  file: string,
  stacks: readonly StackConfig[],
): StackConfig | undefined {
  let owner: StackConfig | undefined;
  for (const stack of stacks) {
    if (
      isOwnedBy(stack, file) &&
      (owner === undefined || rootLength(stack) > rootLength(owner))
    ) {
      owner = stack;
    }
  }
  return owner;
}

/**
 * Route a per-file question to the stack that owns the file. `bind` turns a
 * stack into its answerer and is called once per stack, the first time one
 * of its files is asked about, so a stack nobody asks about reads nothing
 * from disk. A file no stack owns, or one whose stack has no answerer, gets
 * no answer.
 */
export function perStack<Answer>(
  stacks: readonly StackConfig[],
  bind: (
    stack: StackConfig,
  ) => ((file: string) => Answer | undefined) | undefined,
): (file: string) => Answer | undefined {
  const bound = new Map<
    StackConfig,
    ((file: string) => Answer | undefined) | undefined
  >();
  return (file) => {
    const owner = stackOf(file, stacks);
    if (owner === undefined) {
      return;
    }
    if (!bound.has(owner)) {
      bound.set(owner, bind(owner));
    }
    return bound.get(owner)?.(file);
  };
}

/**
 * `perStack`, for a question a stack's PACK answers: `bind` is handed the
 * pack that gates the stack. A stack whose pack this version does not have
 * has nobody to ask, so its files get no answer.
 */
export function perPack<Pack extends { id: StackPackId }, Answer>(
  stacks: readonly StackConfig[],
  packs: readonly Pack[],
  bind: (
    pack: Pack,
    stack: StackConfig,
  ) => (file: string) => Answer | undefined,
): (file: string) => Answer | undefined {
  return perStack(stacks, (stack) => {
    const pack = packOf(packs, stack);
    return pack === undefined ? undefined : bind(pack, stack);
  });
}
