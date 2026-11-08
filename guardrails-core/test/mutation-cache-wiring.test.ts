/**
 * `mutationCache.invalidation` reaches the rewriter through both gates.
 *
 * The rule itself is tested in `verify/prepare-cache.test.ts`; this pins the
 * wiring, which is the part that regresses silently — the key would parse, be
 * forwarded nowhere, and every gate would quietly run the default. The fixture
 * is described in `mutation-cache-fixture.ts`; the CLI's half of the wiring is
 * in `cli-core.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec } from '../src/exec.js';
import { runCommitGate, runStopGate } from '../src/gate.js';
import type { GateConfig } from '../src/gate-decision.js';
import type { CacheInvalidation } from '../src/verify/incremental-cache.js';
import {
  CHANGED_FILES,
  keptKills,
  writeCacheFixture,
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
