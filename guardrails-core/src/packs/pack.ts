/**
 * The pack seam (GR-02). A **stack** is one language's corner of a
 * repository (`guardrails.config.json` `stacks`); a **pack** is what
 * guardrails knows about that language: which files are its source, which
 * analyzers gate it, how its tools are installed, who owns a file and which
 * tests cover it.
 *
 * Everything else stays generic and is not in this file on purpose: the
 * `Violation` contract, the rungs, analyzer selection, the gate, state,
 * sanctions, hooks, the fixer ladder and `ship`.
 *
 * Types only, and a leaf: `verify/index.ts` builds the registry, so nothing
 * here may import it (the module graph has a no-circular rule, and type
 * imports count).
 */

import type { Exec } from '../exec.js';
import type { Rung } from '../verify/analyzer-policy.js';

/**
A language guardrails has a pack for. A later pack adds one member.
*/
export type StackPackId = 'typescript' | 'swift';

/**
 * When a stack's whole-project analyzers run below the ci rung. `always` is
 * how knip and dependency-cruiser have always run; `stack-changes` runs them
 * only when the stack owns a changed file. At ci both always run.
 */
export type WholeProjectTrigger = 'always' | 'stack-changes';

/**
One entry of `stacks`, after parsing: every key present, defaults applied.
*/
export interface StackConfig {
  pack: StackPackId;
  /**
  Repo-relative POSIX directory with no trailing slash; `.` is the root.
  */
  root: string;
  /**
  Repo-relative globs the stack does not own, though they are under `root`.
  */
  exclude: readonly string[];
  wholeProjectTrigger: WholeProjectTrigger;
  /**
   * Swift targets whose files may hold `#if DEBUG` (the auditor's
   * `compile-escape` row exempts them). Empty for every other pack.
   */
  debugTargets: readonly string[];
}

/**
Where a stack lives. Enough to answer a question about one of its files.
*/
export interface StackContext {
  repoRoot: string;
  stack: StackConfig;
}

/**
A stack, plus what it takes to run one of its tools.
*/
interface StackRun extends StackContext {
  exec: Exec;
  resolveBin: (tool: string) => string;
}

/**
 * What analyzer SELECTION reads of an analyzer. The orchestrator's own
 * analyzer type adds the runner; a pack is generic in it so this file need
 * not know what a runner takes.
 */
export interface PackAnalyzer {
  /**
  The name a consumer configures. Unique across every pack.
  */
  tool: string;
  /**
  What provides the binary: an npm package, a brew formula, `npm` itself.
  */
  provider: string;
  /**
  The lowest rung it runs at; a consumer's override replaces it.
  */
  minRung: Rung;
  /**
   * `changed-files` runs only when the stack has a changed source or config
   * file; `whole-project` runs whenever the rung and the stack's
   * `wholeProjectTrigger` allow.
   */
  scope: 'whole-project' | 'changed-files';
}

export interface StackPack<Analyzer extends PackAnalyzer = PackAnalyzer> {
  id: StackPackId;
  /**
  A file this pack's analyzers lint, type-check and mutate.
  */
  isSourceFile(file: string): boolean;
  /**
  Test material: a spec, or a helper under a test directory.
  */
  isTestFile(file: string): boolean;
  /**
  A tool config written in the pack's own files.
  */
  isConfigFile(file: string): boolean;
  /**
  The pack's analyzer table, in the order its violations are reported.
  */
  analyzers: readonly Analyzer[];
  /**
   * Has the repository asked for `provider`? A declared provider whose
   * binary does not start is a broken install, not an opt-out. `manifest` is
   * every package name the root `package.json` declares; a pack whose tools
   * are not npm packages reads its own stack config instead.
   */
  isProviderDeclared(
    stack: StackConfig,
    provider: string,
    manifest: ReadonlySet<string>,
  ): boolean;
  /**
  The command that installs `provider`, as it is shown in a violation.
  */
  installHint(provider: string): string;
  /**
  The silent mechanical fix for `files`, all of them this pack's source.
  */
  autofix(run: StackRun, files: string[]): Promise<void>;
  /**
   * Who owns a file: a workspace member, a Swift package target. Bound to
   * the stack once per run because the answer is read from disk; the
   * function it returns is pure.
   */
  ownerOf(context: StackContext): (file: string) => string | undefined;
  /**
   * The tests that exercise a file. `undefined` means "not worked out" (a
   * test file, or no way to ask); an empty list means none were found. Bound
   * once per run for the same reason as `ownerOf`, and lazy: nothing is read
   * until the first file is asked about.
   */
  coveringTests(
    context: StackContext,
  ): (file: string) => readonly string[] | undefined;
}
