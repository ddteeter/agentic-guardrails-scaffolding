/**
 * Reads the world `guardrails init` will act on: what the target repo already
 * has, so `planScaffold` (pure) can decide what to do with it without ever
 * touching a filesystem or a spawn itself.
 *
 * Every probe is injectable (`fileExists`, `readJson`) precisely so this
 * module's own tests build a fake world instead of touching the real
 * filesystem — the same reasoning that keeps `planScaffold` pure applies here
 * one layer up: I/O is a seam, not a detail buried inside the function.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { Exec } from '../exec.js';
import { readJsonFile } from '../json-file.js';
import { resolveRepoRoot } from '../repo-root.js';
import { declaredProviders } from '../verify/analyzer-policy.js';
import { isRecord } from './record.js';
import { parseManifest, type ScaffoldManifest } from './manifest.js';

export interface RepoFacts {
  readonly repoRoot: string;
  readonly baseBranch: string;
  readonly declaredProviders: ReadonlySet<string>;
  readonly hasTypeScriptConfig: boolean;
  readonly hasEslintConfig: boolean;
  readonly hasDependencyCruiserConfig: boolean;
  readonly hasStrykerConfig: boolean;
  readonly hasGuardrailsConfig: boolean;
  readonly manifest: ScaffoldManifest | undefined;
  readonly hooksPath: string | undefined;
  readonly prepareScript: string | undefined;
}

export interface DetectOptions {
  readonly exec: Exec;
  readonly cwd: string;
  /** Existence probe, injected in tests. Defaults to node:fs existsSync. */
  readonly fileExists?: (filePath: string) => boolean;
  /** File reader seam, injected in tests. Defaults to readJsonFile. */
  readonly readJson?: (filePath: string) => unknown;
}

/** True when any of `candidates` (repo-root-relative) exists. */
function anyExists(
  repoRoot: string,
  candidates: readonly string[],
  fileExists: (filePath: string) => boolean,
): boolean {
  return candidates.some((candidate) =>
    fileExists(path.join(repoRoot, candidate)),
  );
}

async function detectBaseBranch(exec: Exec, cwd: string): Promise<string> {
  const result = await exec(
    'git',
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    { cwd },
  );
  if (result.code !== 0) {
    return 'main';
  }
  const trimmed = result.stdout.trim();
  if (trimmed === '') {
    return 'main';
  }
  return trimmed.replace(/^origin\//, '');
}

async function detectHooksPath(
  exec: Exec,
  cwd: string,
): Promise<string | undefined> {
  const result = await exec('git', ['config', '--get', 'core.hooksPath'], {
    cwd,
  });
  if (result.code !== 0) {
    return undefined;
  }
  const trimmed = result.stdout.trim();
  return trimmed === '' ? undefined : trimmed;
}

function detectPrepareScript(packageJson: unknown): string | undefined {
  if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) {
    return undefined;
  }
  const { prepare } = packageJson.scripts;
  return typeof prepare === 'string' ? prepare : undefined;
}

export async function detect(options: DetectOptions): Promise<RepoFacts> {
  const { exec, cwd } = options;
  const fileExists = options.fileExists ?? existsSync;
  const readJson =
    options.readJson ?? ((filePath) => readJsonFile(filePath).parsed);

  const repoRoot = await resolveRepoRoot(exec, cwd);
  const [baseBranch, hooksPath] = await Promise.all([
    detectBaseBranch(exec, repoRoot),
    detectHooksPath(exec, repoRoot),
  ]);

  const packageJson = readJson(path.join(repoRoot, 'package.json'));
  const manifest = parseManifest(
    readJson(path.join(repoRoot, '.guardrails', 'scaffold.json')),
  );

  return {
    repoRoot,
    baseBranch,
    hooksPath,
    declaredProviders: declaredProviders(packageJson),
    prepareScript: detectPrepareScript(packageJson),
    hasTypeScriptConfig: anyExists(repoRoot, ['tsconfig.json'], fileExists),
    hasEslintConfig: anyExists(
      repoRoot,
      ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'],
      fileExists,
    ),
    hasDependencyCruiserConfig: anyExists(
      repoRoot,
      [
        '.dependency-cruiser.cjs',
        '.dependency-cruiser.js',
        '.dependency-cruiser.json',
      ],
      fileExists,
    ),
    hasStrykerConfig: anyExists(repoRoot, ['stryker.conf.json'], fileExists),
    hasGuardrailsConfig: anyExists(
      repoRoot,
      ['guardrails.config.json'],
      fileExists,
    ),
    manifest,
  };
}
