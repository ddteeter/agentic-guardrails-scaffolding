/**
 * Does this push need the machine-wide gate lock?
 *
 * The scaffolded `.githooks/pre-push` serializes `gate --mode=push` across
 * every checkout on the machine, because mutation testing runs on that rung
 * and N concurrent stryker runs thrash the cores. A push that will not run
 * stryker has nothing to protect the machine from, yet it used to queue behind
 * one that does -- a docs-only push could wait hours.
 *
 * Every answer comes from the gate's own predicates, never a copy of them:
 * `isRememberedPass` (the push memo), `isAnalyzerSelected` (the cadence and
 * opt-in policy) and `strykerScope` (the mutate filter). A probe with its own
 * rules could say "no mutation testing" for a change set the gate then
 * mutates, unlocked.
 *
 * It fails TOWARD the lock. A wrong "needed" costs a wait; a wrong "not
 * needed" costs the thrash the lock exists to prevent, so every error and
 * every unreadable input answers "needed".
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Exec } from './exec.js';
import { isRememberedPass, pushPassKey } from './gate.js';
import { readJsonFile } from './json-file.js';
import { loadPushPass, stateDirectory } from './state-store.js';
import {
  declaredProviders,
  type AnalyzerMode,
  type Rung,
} from './verify/analyzer-policy.js';
import {
  changedTypeScriptFiles,
  isAnalyzerSelected,
  strykerScope,
} from './verify/index.js';

export interface PushLockOptions {
  repoRoot: string;
  baseBranch: string;
  exec: Exec;
  analyzers?: Readonly<Record<string, AnalyzerMode>> | undefined;
  analyzerRungs?: Readonly<Record<string, Rung>> | undefined;
}

export interface PushLockDecision {
  needed: boolean;
  /**
  One clause, printed by `guardrails gate-lock` after "because".
  */
  reason: string;
}

export async function pushLockDecision(
  options: PushLockOptions,
): Promise<PushLockDecision> {
  try {
    return await decide(options);
  } catch (error) {
    return {
      needed: true,
      reason: `the probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function decide(options: PushLockOptions): Promise<PushLockDecision> {
  const { repoRoot } = options;
  const pass = await pushPassKey({ ...options, profile: 'push' });
  if (isRememberedPass(pass, loadPushPass(stateDirectory(repoRoot)))) {
    return { needed: false, reason: 'this tree already passed the push gate' };
  }
  const { files, violations } = await changedTypeScriptFiles({
    repoRoot,
    baseBranch: options.baseBranch,
    exec: options.exec,
    changedScope: 'branch',
  });
  if (violations.length > 0) {
    return { needed: true, reason: 'the branch diff could not be read' };
  }
  const manifest = readJsonFile(path.join(repoRoot, 'package.json')).parsed;
  const declared = declaredProviders(manifest);
  const isSelected = isAnalyzerSelected('stryker', {
    analyzers: options.analyzers ?? {},
    analyzerRungs: options.analyzerRungs ?? {},
    declared,
    profile: 'push',
    hasChangedFiles: files.length > 0,
  });
  if (!isSelected) {
    return { needed: false, reason: 'stryker does not run for this push' };
  }
  const { inScope } = await strykerScope(files, repoRoot, (filePath) =>
    readFile(filePath, 'utf8'),
  );
  if (inScope.length === 0) {
    return {
      needed: false,
      reason: "no changed file is in stryker's mutate scope",
    };
  }
  const noun = inScope.length === 1 ? 'file' : 'files';
  return {
    needed: true,
    reason: `stryker will mutate ${String(inScope.length)} changed ${noun}`,
  };
}
