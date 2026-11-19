/**
 * `mutationCache.invalidation` reaches the rewriter through both gates.
 *
 * The rule itself is tested in `verify/prepare-cache.test.ts`; this pins the
 * wiring, which is the part that regresses silently — the key would parse, be
 * forwarded nowhere, and every gate would quietly run the default. The fixture
 * is described in `mutation-cache-fixture.ts`; the CLI's half of the wiring is
 * in `cli-core.test.ts`.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec } from '../src/exec.js';
import { runCommitGate, runStopGate } from '../src/gate.js';
import type { GateConfig } from '../src/gate-decision.js';
import type { CacheInvalidation } from '../src/verify/incremental-cache.js';
import {
  computeFingerprint,
  serializeFingerprint,
} from '../src/verify/cache-fingerprint.js';
import {
  CHANGED_FILES,
  SEED_COMMAND,
  STRYKER_CONFIG,
  keptKills,
  seedFixtureExec,
  writeCacheFixture,
  writeSeedFixture,
} from './mutation-cache-fixture.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-cache-wiring-'));
  writeCacheFixture(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const config: GateConfig = {
  maxAttempts: 3,
  recurThreshold: 3,
  graduationThreshold: 3,
  fastFixer: 'guardrail-fixer',
  thoroughFixer: 'guardrail-fixer-thorough',
};

const exec: Exec = (command, args) =>
  Promise.resolve({
    stdout: args.includes('--name-only') ? CHANGED_FILES : '',
    stderr: '',
    code: 0,
  });

describe.each<[string, CacheInvalidation | undefined, number]>([
  ['targeted, by default', undefined, 0],
  ['any-test-change, when asked', 'any-test-change', 1],
])('the cache rule the gates apply: %s', (_label, invalidation, kills) => {
  const policy = { mutationCacheInvalidation: invalidation };

  it('is the stop gate’s', async () => {
    await runStopGate({
      repoRoot: root,
      sessionId: 'sid',
      baseBranch: 'main',
      exec,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      analyzerRungs: { stryker: 'stop' },
      ...policy,
    });
    expect(keptKills(root)).toBe(kills);
  });

  it('is the commit gate’s', async () => {
    await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      ...policy,
    });
    expect(keptKills(root)).toBe(kills);
  });
});

/**
 * `mutationCache.seedFrom` reaches the seeder through both gates (#157). The
 * fixture's worktree has no cache; a gate that runs the seed leaves the CI
 * report's one kill behind, and one that does not leaves no cache at all.
 */
describe.each<
  [string, { command: string; timeoutSeconds: number } | undefined, number]
>([
  ['seeded, when configured', { command: SEED_COMMAND, timeoutSeconds: 5 }, 1],
  ['cold, by default', undefined, -1],
])('a fresh worktree’s mutation cache: %s', (_label, seed, kills) => {
  beforeEach(() => {
    writeSeedFixture(root);
  });

  const policy = { mutationCacheSeed: seed };

  it('is the stop gate’s', async () => {
    await runStopGate({
      repoRoot: root,
      sessionId: 'sid',
      baseBranch: 'main',
      exec: seedFixtureExec,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      analyzerRungs: { stryker: 'stop' },
      ...policy,
    });
    expect(keptKills(root)).toBe(kills);
  });

  it('is the commit gate’s', async () => {
    await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec: seedFixtureExec,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      ...policy,
    });
    expect(keptKills(root)).toBe(kills);
  });
});

/**
The fixture's git, which also lists one tracked package.json.
*/
const tracking: Exec = (command, args) =>
  args[0] === 'ls-files' && args.includes('*/package.json')
    ? Promise.resolve({ stdout: 'package.json\0', stderr: '', code: 0 })
    : exec(command, args);

function writtenSidecar(): string {
  return readFileSync(
    path.join(root, 'reports', 'stryker-incremental.fingerprint.json'),
    'utf8',
  );
}

/**
 * The fingerprint's dependency pins reach the sidecar through both gates
 * (#177), with `mutationCache.verdictDependencies` added to them. The
 * fixture tracks one manifest depending on an installed `zod`.
 */
describe.each<[string, readonly string[] | undefined, string[]]>([
  ['by default', undefined, ['zod@4.1.0']],
  ['with extra names', ['extra'], ['extra@missing', 'zod@4.1.0']],
])('the fingerprint’s dependency pins, %s', (_label, extra, pins) => {
  beforeEach(() => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { zod: '*' } }),
    );
    mkdirSync(path.join(root, 'node_modules', 'zod'), { recursive: true });
    writeFileSync(
      path.join(root, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '4.1.0' }),
    );
  });

  function expectedSidecar(): string {
    const fingerprint = computeFingerprint({
      strykerVersion: '10.0.0',
      config: STRYKER_CONFIG,
      dependencies: { pins },
    });
    return fingerprint === undefined ? '' : serializeFingerprint(fingerprint);
  }

  it('is the stop gate’s', async () => {
    await runStopGate({
      repoRoot: root,
      sessionId: 'sid',
      baseBranch: 'main',
      exec: tracking,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      analyzerRungs: { stryker: 'stop' },
      mutationVerdictDependencies: extra,
    });
    expect(writtenSidecar()).toBe(expectedSidecar());
  });

  it('is the commit gate’s', async () => {
    await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec: tracking,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      mutationVerdictDependencies: extra,
    });
    expect(writtenSidecar()).toBe(expectedSidecar());
  });
});
