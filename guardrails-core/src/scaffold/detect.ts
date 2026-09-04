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

import { isRecord, pickAnalyzers } from '../config.js';
import type { Exec } from '../exec.js';
import { readJsonFile } from '../json-file.js';
import { resolveRepoRoot } from '../repo-root.js';
import type { AnalyzerMode } from '../verify/analyzer-policy.js';
import { declaredProviders } from '../verify/analyzer-policy.js';
import { parseManifest, type ScaffoldManifest } from './manifest.js';

/**
 * Every field here has a production reader, and that is the rule rather than
 * an accident: a fact nothing consults is an `existsSync` per `init` and a
 * line of fixture boilerplate in four test files, bought for a decision no
 * code makes. Five such fields were removed once (`hasTypeScriptConfig`,
 * `hasEslintConfig`, `hasGuardrailsConfig`, `prepareScript`, and, until it was
 * wired up, `hooksPath`) — they are invisible to knip, because the tests
 * assert them directly, so nothing but this rule catches them. Detect the fact
 * when something needs it.
 */
export interface RepoFacts {
  readonly repoRoot: string;
  readonly baseBranch: string;
  /** Read by `templates.ts` — which analyzer configs to offer to seed. */
  readonly declaredProviders: ReadonlySet<string>;
  readonly hasDependencyCruiserConfig: boolean;
  readonly hasStrykerConfig: boolean;
  readonly manifest: ScaffoldManifest | undefined;
  /** Read by `hooks-path.ts` — the one config entry we refuse to overwrite. */
  readonly hooksPath: string | undefined;
  /**
   * The `analyzers` block of an existing `guardrails.config.json`, or
   * `undefined` when the repo has none yet. Read by `effectiveAnalyzers`.
   *
   * The distinction is the point: absent means this run is the one that seeds
   * the file, so the CLI flags decide. Present means the file exists, and
   * `guardrails.config.json` is SEED-ONCE -- `--analyzers` can no longer
   * change it, `--force` included -- so the file, not the flags, is the
   * authority for everything derived from it.
   */
  readonly existingAnalyzers:
    Readonly<Record<string, AnalyzerMode>> | undefined;
}

/**
 * The analyzer policy in force, which is the repo's own config once it has
 * one and the CLI flags only until then.
 *
 * Without this, `--analyzers=stryker=required` on an already-configured repo
 * left every unnamed analyzer at `auto`, so `init` seeded a
 * `.dependency-cruiser.cjs` for an analyzer the real config had set `off` --
 * and orphan files are never removed, so it stayed. The same mismatch would
 * make the silent-skip warning describe a policy the repo does not have.
 */
export function effectiveAnalyzers(
  facts: RepoFacts,
  flagged: Readonly<Record<string, AnalyzerMode>>,
): Readonly<Record<string, AnalyzerMode>> {
  return facts.existingAnalyzers ?? flagged;
}

export interface DetectOptions {
  readonly exec: Exec;
  readonly cwd: string;
  /** Existence probe, injected in tests. Defaults to node:fs existsSync. */
  readonly fileExists?: (filePath: string) => boolean;
  /** File reader seam, injected in tests. Defaults to readJsonFile. */
  readonly readJson?: (filePath: string) => unknown;
}

/**
 * The `analyzers` field of a parsed `guardrails.config.json`, narrowed rather
 * than cast. The file is consumer-authored JSON -- a trust boundary -- so an
 * `as` here would assert a shape nothing checked. `isRecord` is `config.ts`'s
 * own predicate, reused rather than restated: `pickAnalyzers` is already total
 * over `unknown`, so all this has to do is reach the field.
 */
function analyzersField(config: unknown): unknown {
  return isRecord(config) ? config.analyzers : undefined;
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
  const configPath = path.join(repoRoot, 'guardrails.config.json');
  const manifest = parseManifest(
    readJson(path.join(repoRoot, '.guardrails', 'scaffold.json')),
  );

  return {
    repoRoot,
    baseBranch,
    hooksPath,
    declaredProviders: declaredProviders(packageJson),
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
    existingAnalyzers: fileExists(configPath)
      ? pickAnalyzers(analyzersField(readJson(configPath)))
      : undefined,
    manifest,
  };
}
