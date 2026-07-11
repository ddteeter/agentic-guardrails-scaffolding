/**
 * Silent mechanical autofix (the PostToolUse class). Runs `eslint --fix` over
 * the changed TypeScript files so formatting and `--fix`-able lint are
 * corrected without spending any agent context. The Java analog (spotless
 * apply) is added in the Java pack.
 */

import type { Exec } from './exec.js';
import { isTypeScriptFile } from './verify/git.js';

export interface AutofixOptions {
  repoRoot: string;
  files: string[];
  exec: Exec;
  resolveBin?: (tool: string) => string;
}

export async function runAutofix(options: AutofixOptions): Promise<void> {
  const files = options.files.filter((file) => isTypeScriptFile(file));
  if (files.length === 0) {
    return;
  }
  const resolveBin = options.resolveBin ?? ((tool) => tool);
  await options.exec(resolveBin('eslint'), ['--fix', ...files], {
    cwd: options.repoRoot,
  });
}
