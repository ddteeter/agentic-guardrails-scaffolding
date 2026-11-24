/**
 * `mutationScope` reaches stryker through both gates.
 *
 * The planner itself is tested in `verify/mutate-ranges.test.ts`; this pins
 * the wiring, which regresses silently — the key would parse, be forwarded
 * nowhere, and every gate would quietly run the default. The CLI's half is in
 * `cli-core.test.ts`.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
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
  enclosing: true,
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

/**
 * `src/big.ts` with its changed line 150 inside a function (lines 140–160),
 * and this repo's typescript installed where the gate looks for a repo's own.
 */
function writeFunctionFixture(): void {
  const lines = 'const a = 1;\n'.repeat(300).split('\n');
  lines.splice(
    139,
    21,
    'export function big(value: number): number {',
    ...Array.from({ length: 19 }, () => '  value += 1;'),
    '}',
  );
  writeFileSync(path.join(root, 'src', 'big.ts'), lines.join('\n'));
  mkdirSync(path.join(root, 'node_modules'));
  symlinkSync(
    path.dirname(
      createRequire(import.meta.url).resolve('typescript/package.json'),
    ),
    path.join(root, 'node_modules', 'typescript'),
    'dir',
  );
}

describe('what the gates mutate: a hunk widened to its function (#196)', () => {
  beforeEach(() => {
    writeFunctionFixture();
  });

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
    });
    expect(mutated).toEqual(['src/big.ts:140-160']);
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
    });
    expect(mutated).toEqual(['src/big.ts:140-160']);
  });
});
