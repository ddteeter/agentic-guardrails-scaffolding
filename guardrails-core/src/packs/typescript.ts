/**
 * The TypeScript pack (GR-02): today's behaviour, behind the seam.
 *
 * Built by a function that is HANDED its analyzer table rather than owning
 * it. The runners (`runEslint` … `runStryker`) are some two thousand lines
 * of `verify/index.ts`; moving them here would mark every line as changed,
 * the push gate mutates changed lines, and a move that changes no behaviour
 * would cost a whole-file mutation run and risk a verdict for nothing. So
 * the table stays beside its runners and the orchestrator builds the pack
 * from it. Everything else TypeScript-specific is reached through here.
 */

import { coveringTestsFinder, readTestCorpus } from '../covering-tests.js';
import { createImportResolver } from '../import-graph.js';
import { repoSourceReader } from '../repo-source.js';
import { loadWorkspaceResolver } from '../workspaces.js';
import type { PackAnalyzer, StackPack } from './pack.js';
import {
  isConfigFile,
  isTestFile,
  isTypeScriptFile,
} from './typescript-files.js';

/**
 * How an npm-provided tool is installed, as a violation shows it. Exported
 * because `git` is reported missing in the same words: it is nobody's
 * analyzer, and the message predates the seam.
 */
export function npmInstallHint(provider: string): string {
  return `\`npm install --save-dev ${provider}\``;
}

export function typescriptPack<Analyzer extends PackAnalyzer>(
  analyzers: readonly Analyzer[],
): StackPack<Analyzer> {
  return {
    id: 'typescript',
    isSourceFile: isTypeScriptFile,
    isTestFile,
    isConfigFile,
    analyzers,
    // The stack is not consulted: a TypeScript stack's tools are npm
    // packages, and what the repository asked for is its package.json.
    isProviderDeclared: (_stack, provider, manifest) => manifest.has(provider),
    installHint: npmInstallHint,
    autofix: async (run, files) => {
      await run.exec(run.resolveBin('eslint'), ['--fix', ...files], {
        cwd: run.repoRoot,
      });
    },
    ownerOf: (context) => loadWorkspaceResolver(context.repoRoot),
    coveringTests: (context) =>
      coveringTestsFinder(
        () => readTestCorpus(context.repoRoot),
        () => createImportResolver(context.repoRoot),
        repoSourceReader(context.repoRoot),
      ),
  };
}
