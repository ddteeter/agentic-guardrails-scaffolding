/**
 * The silent autofix class removes findings; it must not CONVERT one.
 *
 * Found dogfooding: PostToolUse `eslint --fix` rewrote
 * `readSource: () => undefined` to `readSource: () => {}`, because
 * `unicorn/no-useless-undefined` is fixable and checks arrow-function bodies
 * by default. The result is a `@typescript-eslint/no-empty-function` error,
 * which has no autofix -- so a file that was clean when the agent wrote it
 * arrived at the gate with an error nobody typed, and no edit to undo.
 *
 * A live probe, like the other guards in this directory: what a fixer does is
 * a fact about the installed plugins, not something a fixture can pin. It runs
 * this repository's real `eslint.config.js` the way `runAutofix` does.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { expect, it } from 'vitest';

import { spawnExec } from '../../src/exec.js';
import { describeUnlessMutating } from './under-mutation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const eslintBin = path.join(repoRoot, 'node_modules', '.bin', 'eslint');

/**
An explicit no-op: a function that is there to return nothing, on purpose.
*/
const EXPLICIT_NO_OP =
  'export const noReader = { readSource: () => undefined };\n';

interface LintResult {
  output?: string;
  messages: { ruleId: string | null }[];
}

/**
 * What `eslint --fix` would leave of `source`, and what it would still report,
 * with `rules` laid over the repository's own config.
 */
async function fixed(source: string, ...rules: string[]): Promise<LintResult> {
  const { stdout } = await spawnExec(
    eslintBin,
    [
      '--stdin',
      '--stdin-filename',
      path.join('guardrails-core', 'src', 'is-record.ts'),
      '--fix-dry-run',
      '--format',
      'json',
      ...rules.flatMap((rule) => ['--rule', rule]),
    ],
    { cwd: repoRoot, input: source },
  );
  const [result] = JSON.parse(stdout) as LintResult[];
  return result ?? { messages: [] };
}

describeUnlessMutating(here)(
  'autofix does not trade one finding for another',
  () => {
    it(
      'leaves an explicit no-op arrow function as it was written',
      { timeout: 120_000 },
      async () => {
        const result = await fixed(EXPLICIT_NO_OP);
        // No `output` means the fixer changed nothing.
        expect(result.output).toBeUndefined();
        expect(result.messages).toEqual([]);
      },
    );

    it(
      'would trade it for an unfixable error with the arrow-body check on',
      { timeout: 120_000 },
      async () => {
        // The pair this repository's config reconciles, reproduced: if this
        // stops failing the way it does, the option above has nothing left to
        // guard and can go.
        const result = await fixed(
          EXPLICIT_NO_OP,
          'unicorn/no-useless-undefined: [error, { checkArguments: false }]',
        );
        expect(result.output).toBe(
          'export const noReader = { readSource: () => {} };\n',
        );
        expect(result.messages.map((message) => message.ruleId)).toEqual([
          '@typescript-eslint/no-empty-function',
        ]);
      },
    );
  },
);
