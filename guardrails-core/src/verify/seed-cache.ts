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
 * nothing here decides which verdicts to TRUST — the caller runs the seed
 * through the same rewrite every cache gets, so a seed can only spare a
 * mutant the targeted rule would have spared locally.
 *
 * What this does check is that the seed was measured under THIS checkout:
 * every report must land with its fingerprint sidecar beside it
 * (`<name>.fingerprint.json` next to `<name>.json`, as CI uploads them), every
 * sidecar must agree — a sharded run writes one per shard — and they must
 * match the caller's fingerprint. A seed measured under another stryker,
 * config or lockfile is the same hazard `cache-fingerprint.ts` discards a
 * local cache for.
 *
 * Every failure is a cold run for the files the seed would have covered,
 * never a gate failure: the seed is an optimisation, and a flaky download
 * must not block a push. Each says why on one line, so a consumer whose
 * seeding silently stopped working can see it.
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { Exec, ExecResult } from '../exec.js';
import {
  isFingerprintEqual,
  parseFingerprint,
  serializeFingerprint,
  type CacheFingerprint,
} from './cache-fingerprint.js';
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

const SIDECAR_SUFFIX = '.fingerprint.json';

/**
A report, by name: JSON, but not a fingerprint sidecar.
*/
function isReport(file: string): boolean {
  return file.endsWith('.json') && !file.endsWith(SIDECAR_SUFFIX);
}

/**
`<name>.json`'s sidecar: `<name>.fingerprint.json`, in the same directory.
*/
function sidecarOf(report: string): string {
  return `${report.slice(0, -'.json'.length)}${SIDECAR_SUFFIX}`;
}

/**
 * Why the reports' sidecars rule the seed out, or `undefined` when every
 * report has one and all of them match `current`.
 */
async function fingerprintFailure(
  seams: SeedSeams,
  directory: string,
  landed: ReadonlySet<string>,
  reports: readonly string[],
  current: CacheFingerprint,
): Promise<string | undefined> {
  const unpaired = reports.find((report) => !landed.has(sidecarOf(report)));
  if (unpaired !== undefined) {
    return `left ${unpaired} with no fingerprint beside it`;
  }
  const sidecars = reports.map((report) => sidecarOf(report));
  const texts = await Promise.all(
    sidecars.map((file) => seams.readFile(path.join(directory, file))),
  );
  const fingerprints: CacheFingerprint[] = [];
  for (const [index, text] of texts.entries()) {
    const fingerprint = parseFingerprint(text);
    if (fingerprint === undefined) {
      return `left a fingerprint that cannot be read (${String(sidecars[index])})`;
    }
    fingerprints.push(fingerprint);
  }
  if (
    new Set(fingerprints.map((each) => serializeFingerprint(each))).size > 1
  ) {
    return 'left shards whose fingerprints disagree';
  }
  return fingerprints.every((each) => isFingerprintEqual(each, current))
    ? undefined
    : 'was measured under another stryker version, stryker config or lockfile than this checkout';
}

type Outcome =
  { readonly seed: string; readonly count: number } | { readonly why: string };

async function collect(
  seams: SeedSeams,
  directory: string,
  settings: SeedSettings,
  current: CacheFingerprint,
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
  const mismatch = await fingerprintFailure(
    seams,
    directory,
    new Set(landed),
    reports,
    current,
  );
  if (mismatch !== undefined) {
    return { why: mismatch };
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
  current: CacheFingerprint,
): Promise<Outcome> {
  const directory = await seams.makeTempDir();
  try {
    return await collect(seams, directory, settings, current);
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
 * a cold run for the files it would have covered. `current` is this
 * checkout's fingerprint, which the seed's must match. Says which on one line
 * through `seams.warn`, either way.
 */
export async function fetchSeed(
  seams: SeedSeams,
  settings: SeedSettings,
  current: CacheFingerprint,
): Promise<string | undefined> {
  let outcome: Outcome;
  try {
    outcome = await collectInScratchDirectory(seams, settings, current);
  } catch (error) {
    outcome = { why: `could not be read (${messageOf(error)})` };
  }
  if ('why' in outcome) {
    seams.warn(
      `guardrails: mutation cache seed (mutationCache.seedFrom) ${outcome.why}; running cold for the files it would have covered.`,
    );
    return undefined;
  }
  seams.warn(
    `guardrails: seeded the mutation cache from ${String(outcome.count)} report(s) (mutationCache.seedFrom).`,
  );
  return outcome.seed;
}
