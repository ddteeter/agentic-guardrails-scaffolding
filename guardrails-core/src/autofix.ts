/**
 * Silent mechanical autofix (the PostToolUse class). Each edited file goes to
 * the pack of the stack that owns it, which runs that language's fixer
 * without spending any agent context: `eslint --fix` for TypeScript, and
 * later `swiftformat` then `swiftlint --fix` for Swift.
 */

import type { Exec } from './exec.js';
import type { StackConfig, StackPack } from './packs/pack.js';
import { implicitStacks, packOf, stackOf } from './packs/stacks.js';
import { repoRelative } from './repo-relative.js';
import { stackPacks } from './verify/index.js';

export interface AutofixOptions {
  repoRoot: string;
  /**
  The edited files, as the hook reported them: absolute, or repo-relative.
  */
  files: string[];
  exec: Exec;
  resolveBin?: (tool: string) => string;
  /**
  The repository's stacks; absent means the implicit TypeScript stack.
  */
  stacks?: readonly StackConfig[] | undefined;
  /**
  The packs this run knows. Defaults to `stackPacks()`; injected in tests.
  */
  packs?: readonly StackPack[] | undefined;
}

export async function runAutofix(options: AutofixOptions): Promise<void> {
  const stacks = options.stacks ?? implicitStacks();
  const packs = options.packs ?? stackPacks();
  const resolveBin = options.resolveBin ?? ((tool) => tool);
  for (const stack of stacks) {
    const pack = packOf(packs, stack);
    if (pack === undefined) {
      continue;
    }
    const files = options.files.filter(
      (file) =>
        stackOf(repoRelative(options.repoRoot, file), stacks) === stack &&
        pack.isSourceFile(file),
    );
    if (files.length === 0) {
      continue;
    }
    await pack.autofix(
      { repoRoot: options.repoRoot, stack, exec: options.exec, resolveBin },
      files,
    );
  }
}
