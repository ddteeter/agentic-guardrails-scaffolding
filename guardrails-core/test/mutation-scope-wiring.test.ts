/**
 * `mutationScope` reaches stryker through both gates.
 *
 * The planner itself is tested in `verify/mutate-ranges.test.ts`; this pins
 * the wiring, which regresses silently — the key would parse, be forwarded
 * nowhere, and every gate would quietly run the default. The CLI's half is in
 * `cli-core.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCommitGate, runStopGate } from '../src/gate.js';
import type { GateConfig } from '../src/gate-decision.js';
import type { MutationScopeSettings } from '../src/verify/mutate-ranges.js';
import {
  RANGED,
  WHOLE,
  rangeFixtureExec,
  writeRangeFixture,
} from './mutation-scope-fixture.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-scope-wiring-'));
  writeRangeFixture(root);
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

const wholeFiles: MutationScopeSettings = {
  lines: false,
  padding: 5,
  wholeFileAbove: 0.4,
};

describe.each<[string, MutationScopeSettings | undefined, string]>([
  ['changed lines, by default', undefined, RANGED],
  ['whole files, when asked', wholeFiles, WHOLE],
])('what the gates mutate: %s', (_label, mutationScope, expected) => {
  it('is the stop gate’s', async () => {
    const { exec, mutated } = rangeFixtureExec();
    await runStopGate({
      repoRoot: root,
      sessionId: 'sid',
      baseBranch: 'main',
      exec,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      analyzerRungs: { stryker: 'stop' },
      mutationScope,
    });
    expect(mutated).toEqual([expected]);
  });

  it('is the commit gate’s', async () => {
    const { exec, mutated } = rangeFixtureExec();
    await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec,
      config,
      resolveBin: (tool) => tool,
      analyzers: { stryker: 'required' },
      mutationScope,
    });
    expect(mutated).toEqual([expected]);
  });
});
