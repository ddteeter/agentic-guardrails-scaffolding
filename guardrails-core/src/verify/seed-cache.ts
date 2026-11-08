/**
 * Fetching a seed for stryker's incremental cache (#157,
 * `mutationCache.seedFrom`).
 *
 * A fresh worktree has no cache, so its first mutation run is cold — even
 * when CI has just measured nearly every mutant on the base branch. A
 * consumer that keeps CI's report somewhere fetchable names a shell command;
 * this runs it with `GUARDRAILS_SEED_DIR` pointing at an empty temporary
 * directory, and merges whatever reports land there (`mergeReports`, which
 * handles a sharded run).
 *
 * What to fetch and from where is entirely the consumer's: nothing here
 * knows about GitHub, artifacts or `gh` (docs/adoption.md has a sample). And
 * nothing here decides what to TRUST — the caller writes the seed as the
 * local cache and runs it through the same rewrite every cache gets, so a seed
 * can only spare a mutant the targeted rule would have spared locally.
 *
 * Every failure is a cold run, never a gate failure: the seed is an
 * optimisation, and a flaky download must not block a push. Each says why on
 * one line, so a consumer whose seeding silently stopped working can see it.
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { Exec, ExecResult } from '../exec.js';
import { mergeReports } from './merge-reports.js';

export interface SeedSettings {
  /**
  Run with `sh -c`, from the repo root.
  */
  readonly command: string;
  readonly timeoutSeconds: number;
}

export interface SeedSeams {
  exec: Exec;
  repoRoot: string;
  /**
  The command's environment, before `GUARDRAILS_SEED_DIR` is added.
  */
  environment: NodeJS.ProcessEnv;
  makeTempDir: () => Promise<string>;
  /**
  Every file under `directory`, recursively, relative to it.
  */
  listFiles: (directory: string) => Promise<string[]>;
  readFile: (filePath: string) => Promise<string>;
  removeDirectory: (directory: string) => Promise<void>;
  warn: (line: string) => void;
}

/**
 * The real filesystem and environment behind `fetchSeed`; `exec`, the repo
 * and where the one line goes come from the caller.
 */
export function nodeSeedSeams(
  base: Pick<SeedSeams, 'exec' | 'repoRoot' | 'warn'>,
): SeedSeams {
  return {
    ...base,
    environment: process.env,
    makeTempDir: () => mkdtemp(path.join(tmpdir(), 'guardrails-seed-')),
    listFiles: (directory) => readdir(directory, { recursive: true }),
    readFile: (filePath) => readFile(filePath, 'utf8'),
    removeDirectory: (directory) =>
      rm(directory, { recursive: true, force: true }),
  };
}

/**
 * Why the command's run gave no seed, or `undefined` when it exited cleanly.
 * The timeout comes first: it is also a signal, and the less useful reading.
 */
function commandFailure(
  result: ExecResult,
  settings: SeedSettings,
): string | undefined {
  if (result.timedOut) {
    return `timed out after ${String(settings.timeoutSeconds)}s`;
  }
  if (result.spawnFailed) {
    return 'could not be started';
  }
  if (result.signal !== undefined) {
    return `was stopped by ${result.signal}`;
  }
  return result.code === 0 ? undefined : `failed (exit ${String(result.code)})`;
}

/**
 * A report, by name: JSON, but not the fingerprint sidecar a consumer may
 * upload beside the cache — the seed is fingerprinted from this checkout.
 */
function isReport(file: string): boolean {
  return file.endsWith('.json') && !file.endsWith('.fingerprint.json');
}

type Outcome =
  { readonly seed: string; readonly count: number } | { readonly why: string };

async function collect(
  seams: SeedSeams,
  directory: string,
  settings: SeedSettings,
): Promise<Outcome> {
  const result = await seams.exec('sh', ['-c', settings.command], {
    cwd: seams.repoRoot,
    env: { ...seams.environment, GUARDRAILS_SEED_DIR: directory },
    processGroup: true,
    timeoutMs: settings.timeoutSeconds * 1000,
  });
  const failure = commandFailure(result, settings);
  if (failure !== undefined) {
    return { why: failure };
  }
  const landed = await seams.listFiles(directory);
  const reports = landed.filter((file) => isReport(file));
  if (reports.length === 0) {
    return { why: 'wrote no report to $GUARDRAILS_SEED_DIR' };
  }
  const texts = await Promise.all(
    reports.map((file) => seams.readFile(path.join(directory, file))),
  );
  const seed = mergeReports(texts);
  return seed === undefined
    ? {
        why: 'left reports that cannot be merged (malformed, or one file in two reports)',
      }
    : { seed, count: reports.length };
}

async function collectInScratchDirectory(
  seams: SeedSeams,
  settings: SeedSettings,
): Promise<Outcome> {
  const directory = await seams.makeTempDir();
  try {
    return await collect(seams, directory, settings);
  } finally {
    try {
      await seams.removeDirectory(directory);
    } catch {
      // A leftover scratch directory costs disk, not correctness.
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The seed `settings.command` fetched, as one cache's JSON, or `undefined` —
 * a cold run. Says which on one line through `seams.warn`, either way.
 */
export async function fetchSeed(
  seams: SeedSeams,
  settings: SeedSettings,
): Promise<string | undefined> {
  let outcome: Outcome;
  try {
    outcome = await collectInScratchDirectory(seams, settings);
  } catch (error) {
    outcome = { why: `could not be read (${messageOf(error)})` };
  }
  if ('why' in outcome) {
    seams.warn(
      `guardrails: mutation cache seed (mutationCache.seedFrom) ${outcome.why}; running stryker cold.`,
    );
    return undefined;
  }
  seams.warn(
    `guardrails: seeded the mutation cache from ${String(outcome.count)} report(s) (mutationCache.seedFrom).`,
  );
  return outcome.seed;
}
