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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Exec } from '../src/exec.js';
import { runCommitGate, runStopGate } from '../src/gate.js';
import type { GateConfig } from '../src/gate-decision.js';
import type { CacheInvalidation } from '../src/verify/incremental-cache.js';
import { parseRuns } from '../src/run-log.js';
import {
  computeFingerprint,
  serializeFingerprint,
} from '../src/verify/cache-fingerprint.js';
import {
  CHANGED_FILES,
  SEED_COMMAND,
  STRYKER_CONFIG,
  SUPPORT_CHANGED_FILES,
  keptKills,
  keptKillsOf,
  seedFixtureExec,
  writeCacheFixture,
  writeSeedFixture,
  writeSupportFixture,
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

const supportExec: Exec = (command, args) =>
  Promise.resolve({
    stdout: args.includes('--name-only') ? SUPPORT_CHANGED_FILES : '',
    stderr: '',
    code: 0,
  });

function supportKills(): [number, number] {
  return [keptKillsOf(root, 'src/foo.ts'), keptKillsOf(root, 'src/bar.ts')];
}

/**
 * A changed test-support file reaches the import graph through both gates
 * (#197): traced by the repo's own TypeScript, it costs only the kill of the
 * test that imports it, unless `mutationCache.maxTracedModules` is too small
 * to trace that far, which discards both.
 */
describe.each<[string, number | undefined, [number, number]]>([
  ['traced, by default', undefined, [0, 1]],
  ['refused, past the module cap', 1, [-1, -1]],
])('a test-support change: %s', (_label, cap, expected) => {
  beforeEach(() => {
    writeSupportFixture(root);
  });

  it('is the stop gate’s', async () => {
    await runStopGate({
      repoRoot: root,
      sessionId: 'sid',
      baseBranch: 'main',
      exec: supportExec,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      analyzerRungs: { stryker: 'stop' },
      mutationCacheMaxTracedModules: cap,
    });
    expect(supportKills()).toEqual(expected);
  });

  it('is the commit gate’s', async () => {
    await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec: supportExec,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      mutationCacheMaxTracedModules: cap,
    });
    expect(supportKills()).toEqual(expected);
  });
});

function logged(): ReturnType<typeof parseRuns> {
  const file = path.join(root, 'gate.lock.runs.jsonl');
  return existsSync(file) ? parseRuns(readFileSync(file, 'utf8')) : [];
}

/**
Every analyzer off but stryker, so a gate's verdict is stryker's alone.
*/
const ONLY_STRYKER = {
  eslint: 'off',
  tsc: 'off',
  knip: 'off',
  'npm-peers': 'off',
  'dependency-cruiser': 'off',
  stryker: 'required',
  dupes: 'off',
  complexity: 'off',
} as const;

/**
 * Both gates write their row to the run log beside the gate lock (#176). The
 * fixture's fake git answers everything with success, so it reads as a
 * machine with `lockf`, and the lock file is a real one in the temp repo.
 */
describe('the gates’ rows in the run log', () => {
  const lockConfig = {
    commitWaitSeconds: 60,
    pushWaitSeconds: 60,
    stopGraceSeconds: 1,
  };

  it('is written by the commit gate, with its stryker part', async () => {
    await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      mutationLock: { path: path.join(root, 'gate.lock'), config: lockConfig },
    });
    expect(logged()).toMatchObject([
      {
        kind: 'gate',
        rung: 'commit',
        repo: path.basename(root),
        stryker: { files: 1, cache: { local: 'kept', seed: 'off' } },
      },
    ]);
  });

  it('is written by the stop gate when stryker had something in scope', async () => {
    await runStopGate({
      repoRoot: root,
      sessionId: 'sid',
      baseBranch: 'main',
      exec,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      analyzerRungs: { stryker: 'stop' },
      mutationLock: { path: path.join(root, 'gate.lock'), config: lockConfig },
    });
    expect(logged()).toMatchObject([{ kind: 'gate', rung: 'stop' }]);
  });

  it('is not written by a stop gate with nothing to mutate', async () => {
    await runStopGate({
      repoRoot: root,
      sessionId: 'sid',
      baseBranch: 'main',
      exec,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'off' },
      mutationLock: { path: path.join(root, 'gate.lock'), config: lockConfig },
    });
    expect(logged()).toEqual([]);
  });

  /**
   * The fixture's git, with a stryker that leaves an empty report behind, so
   * the gate has nothing to block on.
   */
  const passing: Exec = (command, args) => {
    const line = new Set([command, ...args]);
    if (line.has('stryker') && line.has('run')) {
      mkdirSync(path.join(root, 'reports', 'mutation'), { recursive: true });
      writeFileSync(
        path.join(root, 'reports', 'mutation', 'mutation.json'),
        '{"files":{}}',
      );
    }
    return exec(command, args);
  };

  it.each<[string, Exec, Partial<GateConfig>, string]>([
    ['a delegation', exec, {}, 'block'],
    ['an escalation', exec, { maxAttempts: 0 }, 'block'],
    ['a clean turn', passing, {}, 'pass'],
  ])('records the stop gate’s %s', async (_label, run, change, outcome) => {
    await runStopGate({
      repoRoot: root,
      sessionId: 'sid',
      baseBranch: 'main',
      exec: run,
      config: { ...config, ...change },
      resolveBin: (tool) => tool,
      analyzers: ONLY_STRYKER,
      analyzerRungs: { stryker: 'stop' },
      mutationLock: { path: path.join(root, 'gate.lock'), config: lockConfig },
    });
    expect(logged()[0]?.kind === 'gate' && logged()[0]).toMatchObject({
      outcome,
    });
  });

  it.each<[string, Exec, string]>([
    ['a block', exec, 'block'],
    ['a pass', passing, 'pass'],
  ])('records the commit gate’s %s', async (_label, run, outcome) => {
    await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec: run,
      config,
      resolveBin: (tool) => tool,
      analyzers: ONLY_STRYKER,
      mutationLock: { path: path.join(root, 'gate.lock'), config: lockConfig },
    });
    expect(logged()[0]).toMatchObject({ outcome });
  });

  it('warns on stderr, and still answers, when its row cannot be written', async () => {
    mkdirSync(path.join(root, 'gate.lock.runs.jsonl'));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = await runCommitGate({
        repoRoot: root,
        baseBranch: 'main',
        exec: passing,
        config,
        resolveBin: (tool) => tool,
        analyzers: ONLY_STRYKER,
        mutationLock: {
          path: path.join(root, 'gate.lock'),
          config: lockConfig,
        },
      });
      expect(result).toBeDefined();
      const lines = stderr.mock.calls.map(([chunk]) => String(chunk));
      expect(
        lines.filter((line) =>
          /^guardrails: could not write the run log \(.+\)\.\n$/.test(line),
        ),
      ).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });
});
