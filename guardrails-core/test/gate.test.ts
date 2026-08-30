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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import {
  runCommitGate,
  runStopGate,
  stopHookReason,
  type StopGateOptions,
} from '../src/gate.js';
import type { GateConfig, GateDecision } from '../src/gate-decision.js';
import { createSession } from '../src/state.js';
import {
  loadSession,
  readViolations,
  stateDirectory,
} from '../src/state-store.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-gate-'));
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

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

/** Build a fake exec from a matcher over the joined command line. */
function makeExec(handler: (line: string) => ExecResult): Exec {
  return (command, args) =>
    Promise.resolve(handler([command, ...args].join(' ')));
}

function options(exec: Exec): StopGateOptions {
  return { repoRoot: root, sessionId: 'sid', baseBranch: 'main', exec, config };
}

function eslintError(): string {
  return JSON.stringify([
    {
      filePath: path.join(root, 'src/foo.ts'),
      messages: [
        {
          ruleId: 'no-console',
          severity: 2,
          message: 'Unexpected console.',
          line: 2,
        },
      ],
    },
  ]);
}

describe('runStopGate', () => {
  it('delegates on a failing verify: writes manifest + snapshot, persists attempt', async () => {
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD')) return ok('');
      if (line.includes('eslint')) return ok(eslintError());
      return ok('');
    });

    const { decision } = await runStopGate(options(exec));

    expect(decision.outcome).toBe('delegate');
    expect(decision.block).toBe(true);
    // Manifest persisted for the fixer to read.
    const directory = stateDirectory(root);
    expect(readViolations(directory, 'sid').map((v) => v.ruleId)).toEqual([
      'no-console',
    ]);
    // Attempt counter persisted.
    expect(loadSession(directory, 'sid').attempts).toBe(1);
  });

  it('tolerates non-string entries in a tampered pre-fix snapshot', async () => {
    // The snapshot baseline is read defensively: a corrupt/tampered
    // `<sid>.pre-fix.json` with non-string elements must be filtered, not crash.
    const directory = stateDirectory(root);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'sid.pre-fix.json'),
      JSON.stringify([{}, 42, 'src/a.ts|eslint-disable|x']),
    );
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('');
      return ok('');
    });
    const { decision } = await runStopGate(options(exec));
    expect(decision.outcome).toBe('clean');
  });

  it('exits clean when verify finds nothing and resets attempts', async () => {
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('');
      return ok('');
    });
    const { decision } = await runStopGate(options(exec));
    expect(decision.outcome).toBe('clean');
    expect(decision.block).toBe(false);
  });

  it('catches a suppression the fixer added since the pre-fix snapshot', async () => {
    // Cycle 1: verify fails → delegate, snapshot taken.
    const exec1 = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD')) return ok('');
      if (line.includes('eslint')) return ok(eslintError());
      return ok('');
    });
    await runStopGate(options(exec1));

    // Cycle 2: verify now passes, but the fixer sneaked in an eslint-disable.
    const sneakyDiff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,2 @@',
      '+  // eslint-disable-next-line no-console',
      '   console.log(1);',
    ].join('\n');
    const exec2 = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD')) return ok(sneakyDiff);
      if (line.includes('eslint')) return ok(JSON.stringify([]));
      return ok('');
    });
    const { decision, auditFindings } = await runStopGate(options(exec2));

    expect(auditFindings.map((f) => f.kind)).toContain('eslint-disable');
    expect(decision.outcome).toBe('delegate');
    // The audit finding is surfaced as a violation in the manifest.
    const ids = readViolations(stateDirectory(root), 'sid').map(
      (v) => v.ruleId,
    );
    expect(ids).toContain('guardrails/added-suppression');
  });
});

interface RecordedCall {
  line: string;
  cwd: string | undefined;
}

/** A fake exec that records the cwd each tool was invoked with. */
function recordingExec(handler: (line: string) => ExecResult): {
  exec: Exec;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const exec: Exec = (command, args, execOptions) => {
    const line = [command, ...args].join(' ');
    calls.push({ line, cwd: execOptions?.cwd });
    return Promise.resolve(handler(line));
  };
  return { exec, calls };
}

const SNEAKY_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,1 +1,2 @@',
  '+  // eslint-disable-next-line no-console',
].join('\n');

const SNEAKY_KEY =
  'src/foo.ts|eslint-disable|// eslint-disable-next-line no-console';

/** Exec that reports a clean verify but a working diff carrying a suppression. */
function suppressionExec(): Exec {
  return makeExec((line) => {
    if (line.includes('--name-only')) return ok('');
    if (line.includes('--others')) return ok('');
    if (line.includes('diff') && line.includes('HEAD')) return ok(SNEAKY_DIFF);
    return ok('');
  });
}

function writeSnapshot(contents: string): void {
  const directory = stateDirectory(root);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'sid.pre-fix.json'), contents);
}

function snapshotPath(): string {
  return path.join(stateDirectory(root), 'sid.pre-fix.json');
}

describe('runStopGate mutation-hardening', () => {
  it('classifies an added suppression as NON-fixable', async () => {
    // Kills `fixable: false` -> true. A fixable suppression would be routed to
    // the SILENT autofix class — the gate would quietly accept gate-cheating.
    const { decision: _decision } = await runStopGate(
      options(suppressionExec()),
    );
    const violations = readViolations(stateDirectory(root), 'sid');
    const added = violations.filter(
      (v) => v.ruleId === 'guardrails/added-suppression',
    );
    expect(added).toHaveLength(1);
    expect(added.every((v) => !v.fixable)).toBe(true);
  });

  it('does not re-flag a suppression already present in the snapshot', async () => {
    // Kills the baseline `.filter(...)` removal and the readSnapshot
    // array/predicate mutants: all of them empty or invert the baseline, which
    // makes this pre-existing suppression flag as if the fixer had added it.
    writeSnapshot(JSON.stringify([SNEAKY_KEY]));
    const { decision } = await runStopGate(options(suppressionExec()));
    expect(decision.outcome).toBe('clean');
  });

  it('survives a snapshot that is valid JSON but not an array', async () => {
    // Kills the `Array.isArray(parsed) ? ... : []` -> `true` mutant, which
    // would call .filter on a non-array and throw.
    writeSnapshot('{"not":"an array"}');
    const { decision } = await runStopGate(options(suppressionExec()));
    expect(decision.outcome).toBe('delegate');
  });

  it('survives a snapshot that is not valid JSON at all', async () => {
    // Kills the readSnapshot catch-block mutant: an emptied catch returns
    // undefined and the very next `baseline.has(...)` throws.
    writeSnapshot('{ not json');
    const { decision } = await runStopGate(options(suppressionExec()));
    expect(decision.outcome).toBe('delegate');
  });

  it('writes the snapshot on delegate and removes it when the loop ends', async () => {
    // Kills the `outcome === 'delegate'` conditional/equality mutants and the
    // `else { rmSync }` block removal — the baseline must not outlive its loop.
    await runStopGate(options(suppressionExec()));
    expect(existsSync(snapshotPath())).toBe(true);

    const clean = makeExec((line) => {
      if (line.includes('--name-only')) return ok('');
      return ok('');
    });
    await runStopGate(options(clean));
    expect(existsSync(snapshotPath())).toBe(false);
  });

  it('does not overwrite an existing snapshot on a later delegate cycle', async () => {
    // Kills `!hadSnapshot` -> hadSnapshot/true/false: re-snapshotting mid-loop
    // would absorb the fixer's newly-added suppressions into the baseline.
    writeSnapshot(JSON.stringify(['sentinel|kind|text']));
    await runStopGate(options(suppressionExec()));
    expect(readFileSync(snapshotPath(), 'utf8')).toContain('sentinel');
  });

  it('records real finding keys in the snapshot it writes', async () => {
    // Kills the `(finding) => findingKey(finding)` -> `() => undefined` mutant.
    // The manual-snapshot test above bypasses the WRITE path; this exercises it:
    // cycle 1 delegates (on a verify failure) and snapshots the suppression that
    // is already present, so cycle 2 must not attribute it to the fixer.
    const cycle1 = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD'))
        return ok(SNEAKY_DIFF);
      if (line.includes('eslint')) return ok(eslintError());
      return ok('');
    });
    const first = await runStopGate(options(cycle1));
    expect(first.decision.outcome).toBe('delegate');

    const { decision } = await runStopGate(options(suppressionExec()));
    expect(decision.outcome).toBe('clean');
  });

  it('runs the working diff from the repo root', async () => {
    // Kills the `{ cwd: repoRoot }` -> `{}` mutant.
    const { exec, calls } = recordingExec(() => ok(''));
    await runStopGate(options(exec));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.cwd === root)).toBe(true);
  });

  it('forwards the analyzer policy to verify', async () => {
    // Kills the `...(options.analyzers ? {...} : {})` -> `{}` mutant on
    // runStopGate's verifyOptions: with eslint turned off, its command must
    // never be spawned even though the turn touched a TypeScript file.
    const { exec, calls } = recordingExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      return ok('');
    });
    await runStopGate({ ...options(exec), analyzers: { eslint: 'off' } });
    expect(calls.some((call) => call.line.includes('eslint'))).toBe(false);
  });
});

describe('runCommitGate mutation-hardening', () => {
  it('falls back to the staged diff when merge-base fails or is empty', async () => {
    // Kills the `mergeBase.code === 0 && sha` conditional/logical mutants: a
    // shallow clone must audit the staged diff, not a bogus `git diff ''`.
    const failing = recordingExec((line) => {
      if (line.startsWith('git merge-base'))
        return { stdout: '', stderr: 'no merge base', code: 1 };
      if (line.includes('--cached')) return ok(SNEAKY_DIFF);
      return ok('');
    });
    const failed = await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec: failing.exec,
    });
    expect(failed.findings).toHaveLength(1);
    expect(failing.calls.some((call) => call.line.includes('--cached'))).toBe(
      true,
    );

    // A NON-EMPTY stdout with a non-zero exit must still fall back: kills the
    // `mergeBase.code === 0` -> true mutant, which the empty-sha case alone
    // cannot reach (the `&& sha` half catches that one).
    const noisy = recordingExec((line) => {
      if (line.startsWith('git merge-base'))
        return { stdout: 'not-a-sha\n', stderr: '', code: 1 };
      if (line.includes('--cached')) return ok(SNEAKY_DIFF);
      return ok('');
    });
    const noised = await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec: noisy.exec,
    });
    expect(noised.findings).toHaveLength(1);
    // ...and the staged fallback also runs from the repo root (kills its
    // `{ cwd }` -> `{}` mutant, which the merge-base path never exercises).
    const stagedCall = noisy.calls.find((call) =>
      call.line.includes('--cached'),
    );
    expect(stagedCall?.cwd).toBe(root);

    // code 0 but an EMPTY sha must also fall back.
    const empty = recordingExec((line) => {
      if (line.startsWith('git merge-base')) return ok('  \n');
      if (line.includes('--cached')) return ok(SNEAKY_DIFF);
      return ok('');
    });
    const emptied = await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec: empty.exec,
    });
    expect(emptied.findings).toHaveLength(1);
  });

  it('runs its git commands from the repo root', async () => {
    const { exec, calls } = recordingExec((line) =>
      line.startsWith('git merge-base') ? ok('BASESHA\n') : ok(''),
    );
    await runCommitGate({ repoRoot: root, baseBranch: 'main', exec });
    const gitCalls = calls.filter((call) => call.line.startsWith('git '));
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(gitCalls.every((call) => call.cwd === root)).toBe(true);
  });

  it('forwards resolveBin to verify', async () => {
    // Kills the `...(options.resolveBin ? {...} : {})` -> `{}` mutant.
    const { exec, calls } = recordingExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.startsWith('git merge-base')) return ok('BASESHA\n');
      return ok('');
    });
    await runCommitGate({
      repoRoot: root,
      baseBranch: 'main',
      exec,
      resolveBin: (tool) => `/bin/resolved-${tool}`,
    });
    expect(calls.some((call) => call.line.includes('/bin/resolved-'))).toBe(
      true,
    );
  });
});

describe('manifest guidance', () => {
  it('carries the mutation doc path into the manifest the fixer reads', async () => {
    // The fixer reads the manifest into its own context on every surface, so a
    // pointer here reaches it without any per-runtime instruction file.
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('eslint'))
        return ok(
          JSON.stringify([
            {
              filePath: path.join(root, 'src/foo.ts'),
              messages: [
                {
                  ruleId: 'no-console',
                  severity: 2,
                  message: 'Unexpected console.',
                  line: 2,
                },
              ],
            },
          ]),
        );
      return ok('');
    });
    await runStopGate(options(exec));
    const written = readViolations(stateDirectory(root), 'sid');
    // eslint violations get no guidance key; the manifest stays terse.
    expect(written.every((v) => !Object.hasOwn(v, 'guidance'))).toBe(true);
  });
});

// Public API (exported from index.ts) with no internal caller — it is what a
// consumer wiring their own Stop hook would use to render the block text.
// stryker reported both its branches as NoCoverage.
const blockDecision = (over: Partial<GateDecision> = {}): GateDecision => ({
  outcome: 'delegate',
  block: true,
  message: 'Guardrail blocked this turn.',
  nextSession: createSession(),
  nextRecurrence: {},
  ...over,
});

describe('stopHookReason', () => {
  it('returns the message alone when there is no behavioral correction', () => {
    expect(stopHookReason(blockDecision())).toBe(
      'Guardrail blocked this turn.',
    );
  });

  it('appends the behavioral correction below the message', () => {
    const reason = stopHookReason(
      blockDecision({ additionalContext: 'Do not weaken the test.' }),
    );
    expect(reason).toBe(
      'Guardrail blocked this turn.\n\nDo not weaken the test.',
    );
  });
});
