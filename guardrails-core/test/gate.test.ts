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
import { createSession, type FixerLease } from '../src/state.js';
import {
  leasesFile,
  loadLeases,
  loadRecurrence,
  loadSession,
  readDecisions,
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

/**
Build a fake exec from a matcher over the joined command line.
*/
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
  /**
   * #83: the caller, not `decideGate`, writes the decision log — the engine is
   * shared with the commit gate and has to stay a pure function over its input.
   * This is the write that turns "the gate decided something" into a fact an
   * adopter can count later.
   */
  it('appends one decision-log row per firing', async () => {
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD')) return ok('');
      if (line.includes('eslint')) return ok(eslintError());
      if (line.includes('--showConfig'))
        return ok(JSON.stringify({ files: ['src/foo.ts'] }));
      return ok('');
    });

    await runStopGate(options(exec));
    await runStopGate(options(exec));

    const rows = readDecisions(stateDirectory(root));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rung: 'stop',
      session: 'sid',
      outcome: 'delegate',
      fixer: 'guardrail-fixer',
      attempt: 1,
      rules: { 'no-console': 1 },
    });
    // A real instant, not a placeholder: the report orders the log by it.
    expect(Date.parse(rows[0]?.at ?? '')).not.toBeNaN();
  });

  it('logs a clean turn too, so the delegation share has a denominator', async () => {
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('--showConfig'))
        return ok(JSON.stringify({ files: ['src/foo.ts'] }));
      return ok('');
    });

    await runStopGate(options(exec));

    expect(
      readDecisions(stateDirectory(root)).map((row) => row.outcome),
    ).toEqual(['clean']);
  });

  it('persists the recurrence tally to disk, not just the session', async () => {
    // Recurrence is the CROSS-session half of the memory: it is what lets a
    // rule that keeps coming back attach a behavioural correction on a later
    // turn. Only the on-disk write carries it there, and the session file --
    // asserted by its neighbours -- does not, so nothing else here notices if
    // that write disappears.
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD')) return ok('');
      if (line.includes('eslint')) return ok(eslintError());
      if (line.includes('--showConfig'))
        return ok(JSON.stringify({ files: ['src/foo.ts'] }));
      return ok('');
    });

    // recurThreshold is 3: the rule has to fail three separate turns before it
    // is recorded as recurring.
    await runStopGate(options(exec));
    await runStopGate(options(exec));
    await runStopGate(options(exec));

    expect(loadRecurrence(stateDirectory(root))).toHaveProperty('no-console');
  });

  it('delegates on a failing verify: writes manifest + snapshot, persists attempt', async () => {
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD')) return ok('');
      if (line.includes('eslint')) return ok(eslintError());
      if (line.includes('--showConfig'))
        return ok(JSON.stringify({ files: ['src/foo.ts'] }));
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

  it('audits suppressions in an untracked new file', async () => {
    // The auditor reports only inside an open fix loop; this test is about
    // what the diff CONTAINS, so open one and let it speak.
    writeSnapshot(JSON.stringify([]));
    const source = path.join(root, 'src', 'new.ts');
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(
      source,
      '// eslint-disable-next-line no-console\nconsole.log(1);\n',
    );
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('');
      if (line.includes('--others')) return ok('src/new.ts');
      if (line.includes('diff') && line.includes('HEAD')) return ok('');
      if (line.includes('eslint')) return ok('[]');
      if (line.includes('--showConfig'))
        return ok(JSON.stringify({ files: ['src/new.ts'] }));
      return ok('');
    });
    const { decision } = await runStopGate(options(exec));
    expect(decision.outcome).toBe('delegate');
    expect(
      readViolations(stateDirectory(root), 'sid').map((v) => v.ruleId),
    ).toContain('guardrails/added-suppression');
  });

  it('falls back to the index for an unborn branch and audits its staged diff', async () => {
    // The auditor reports only inside an open fix loop; this test is about
    // what the diff CONTAINS, so open one and let it speak.
    writeSnapshot(JSON.stringify([]));
    const { exec, calls } = recordingExec((line) => {
      if (line === 'git diff HEAD')
        return { stdout: '', stderr: 'bad revision HEAD', code: 128 };
      if (line === 'git diff --cached') return ok(SNEAKY_DIFF);
      if (line.includes('--name-only') || line.includes('--others'))
        return ok('');
      return ok('');
    });
    const result = await runStopGate(options(exec));
    expect(result.auditFindings.map((finding) => finding.kind)).toEqual([
      'eslint-disable',
    ]);
    expect(calls.map((call) => call.line)).toContain('git diff --cached');
    expect(calls.find((call) => call.line === 'git diff --cached')?.cwd).toBe(
      root,
    );
  });

  it('does not treat a git spawn failure as an unborn-branch revision error', async () => {
    const { exec, calls } = recordingExec((line) => {
      if (line === 'git diff HEAD')
        return {
          stdout: '',
          stderr: 'spawn ENOENT',
          code: 1,
          spawnFailed: true,
        };
      if (line.includes('--name-only') || line.includes('--others'))
        return ok('');
      return ok('');
    });
    await runStopGate(options(exec));
    expect(calls.map((call) => call.line)).not.toContain('git diff --cached');
  });

  it('does not hide a successful HEAD diff behind the unborn fallback', async () => {
    // The auditor reports only inside an open fix loop; this test is about
    // what the diff CONTAINS, so open one and let it speak.
    writeSnapshot(JSON.stringify([]));
    const { exec, calls } = recordingExec((line) => {
      if (line === 'git diff HEAD') return ok(SNEAKY_DIFF);
      if (line.includes('--name-only') || line.includes('--others'))
        return ok('');
      return ok('');
    });
    const result = await runStopGate(options(exec));
    expect(result.auditFindings).toHaveLength(1);
    expect(calls.map((call) => call.line)).not.toContain('git diff --cached');
  });

  it('audits an untracked final line even when the file has no trailing newline', async () => {
    // The auditor reports only inside an open fix loop; this test is about
    // what the diff CONTAINS, so open one and let it speak.
    writeSnapshot(JSON.stringify([]));
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'new.ts'), '// @ts-ignore');
    const exec = makeExec((line) => {
      if (line.includes('--others')) return ok('src/new.ts\n');
      if (line.includes('--name-only')) return ok('');
      return ok('');
    });
    const result = await runStopGate(options(exec));
    expect(result.auditFindings).toHaveLength(1);
    expect(result.auditFindings[0]?.text).toBe('// @ts-ignore');
  });

  it('combines tracked and untracked audit input without dropping either', async () => {
    // The auditor reports only inside an open fix loop; this test is about
    // what the diff CONTAINS, so open one and let it speak.
    writeSnapshot(JSON.stringify([]));
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'new.ts'), '// @ts-ignore\n');
    const exec = makeExec((line) => {
      if (line === 'git diff HEAD') return ok(SNEAKY_DIFF);
      if (line.includes('--others')) return ok('src/new.ts');
      if (line.includes('--name-only')) return ok('');
      return ok('');
    });
    const result = await runStopGate(options(exec));
    expect(
      result.auditFindings
        .map((finding) => finding.kind)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(['eslint-disable', 'ts-suppress']);
  });

  it('ignores an untracked path that disappears before it can be read', async () => {
    const exec = makeExec((line) => {
      if (line.includes('--others')) return ok('src/disappeared.ts');
      if (line.includes('--name-only')) return ok('');
      return ok('');
    });
    const result = await runStopGate(options(exec));
    expect(result.auditFindings).toEqual([]);
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

/**
A fake exec that records the cwd each tool was invoked with.
*/
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

/**
Exec that reports a clean verify but a working diff carrying a suppression.
*/
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

/**
 * The module docstring states the invariant: "at the first delegation of a fix
 * loop we snapshot the suppressions already present in the working diff; every
 * subsequent cycle flags only suppressions absent from that baseline -- i.e.
 * the ones the fixer added". The implementation broke it on exactly the cycle
 * where no fixer has run, because the findings were computed against a
 * baseline that did not exist yet. Everything already in the diff -- the main
 * agent's own deliberate `eslint-disable`, a `.skip`, a `@ts-expect-error` --
 * was reported as `Fixer added a forbidden ...`, blocked the turn, and asked
 * for a fixer to be spawned against a manifest naming a change no fixer made.
 * The retry then passed anyway, because the delegate had by then written the
 * snapshot that forgave it. One wasted subagent round-trip, and a pointer to
 * the wrong culprit, per deliberate suppression.
 */
describe('runStopGate — no fixer has run yet', () => {
  it('does not attribute a pre-existing suppression to the fixer', async () => {
    const { decision, auditFindings } = await runStopGate(
      options(suppressionExec()),
    );
    expect(auditFindings).toEqual([]);
    expect(decision.outcome).toBe('clean');
  });

  it('writes no manifest entry blaming a fixer that never ran', async () => {
    await runStopGate(options(suppressionExec()));
    const ids = readViolations(stateDirectory(root), 'sid').map(
      (v) => v.ruleId,
    );
    expect(ids).not.toContain('guardrails/added-suppression');
  });

  it('still blocks on a real violation, and does not add the suppression to it', async () => {
    // The suppression must not become part of the fixer's manifest: it is not
    // the fixer's to answer for, and removing it is not the fix being asked
    // for. The verify violation still blocks the turn.
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD'))
        return ok(SNEAKY_DIFF);
      if (line.includes('eslint')) return ok(eslintError());
      return ok('');
    });
    const { decision } = await runStopGate(options(exec));
    expect(decision.outcome).toBe('delegate');
    const ids = readViolations(stateDirectory(root), 'sid').map(
      (v) => v.ruleId,
    );
    expect(ids).toContain('no-console');
    expect(ids).not.toContain('guardrails/added-suppression');
  });

  it('baselines that suppression so the loop it just opened never re-flags it', async () => {
    // The delegate above starts the fix loop, so the snapshot must capture what
    // was already there -- otherwise cycle 2 blames the fixer for it instead.
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD'))
        return ok(SNEAKY_DIFF);
      if (line.includes('eslint')) return ok(eslintError());
      return ok('');
    });
    await runStopGate(options(exec));
    expect(readFileSync(snapshotPath(), 'utf8')).toContain(SNEAKY_KEY);
  });
});

/**
 * Once a fix loop IS open, the same finding is real and must block -- this is
 * the behaviour the change above must not cost us.
 */
describe('runStopGate — a fix loop is open', () => {
  it('flags a suppression absent from the baseline', async () => {
    writeSnapshot(JSON.stringify([]));
    const { decision, auditFindings } = await runStopGate(
      options(suppressionExec()),
    );
    expect(auditFindings.map((f) => f.kind)).toContain('eslint-disable');
    expect(decision.outcome).toBe('delegate');
  });

  it('describes when the suppression appeared, not who it guesses added it', async () => {
    // The gate sees a diff, not an author. Inside a fix loop the fixer is the
    // expected editor, but the main agent is unconfined on Claude Code and can
    // edit during a loop too -- so the message states the fact the gate
    // actually has.
    writeSnapshot(JSON.stringify([]));
    await runStopGate(options(suppressionExec()));
    const added = readViolations(stateDirectory(root), 'sid').find(
      (v) => v.ruleId === 'guardrails/added-suppression',
    );
    expect(added?.message).toContain('during the fix loop');
    expect(added?.message).not.toContain('Fixer added');
  });

  it('tells the reader what to do instead of adding the suppression', async () => {
    // Issue #77: naming the catch is not enough. Every recorded instance of
    // this violation was a FIXER reaching for a suppression, and the message it
    // got back said only that it had been caught -- so the message has to carry
    // the remedy (fix or report it) and the fact that an exemption is a
    // developer-approved grant in a file the fixer cannot reach.
    writeSnapshot(JSON.stringify([]));
    await runStopGate(options(suppressionExec()));
    const added = readViolations(stateDirectory(root), 'sid').find(
      (v) => v.ruleId === 'guardrails/added-suppression',
    );
    expect(added?.message).toContain('Remove it');
    expect(added?.message).toContain('report');
    expect(added?.message).toContain('guardrails.config.json');
  });
});

/**
A process stopped part-way: exit 0, empty stdout, and a signal that says so.
*/
function killedBy(signal: NodeJS.Signals): ExecResult {
  return { stdout: '', stderr: '', code: 0, signal };
}

/**
Exec whose every call answers cleanly except the one git call under test.
*/
function execKilling(command: string, signal: NodeJS.Signals): Exec {
  return makeExec((line) => (line === command ? killedBy(signal) : ok('')));
}

/**
 * A `git diff HEAD` that never finished is the auditor's fail-open (#87).
 *
 * The auditor's whole job is to notice a suppression that appeared while a
 * fixer had the manifest, and its only input is this diff. A killed git call
 * reports exit 0 with empty stdout (see `ExecResult.signal`), so the gate used
 * to hand `auditDiff` an empty string, get nothing back, and let the turn end
 * -- byte-for-byte the same as a turn in which nothing was suppressed. "No
 * changes" and "could not look" must not be the same answer.
 */
describe('runStopGate — the working diff could not be read', () => {
  it('blocks instead of auditing the empty diff a killed `git diff HEAD` leaves', async () => {
    // A fix loop is open, so a readable diff carrying a suppression would be
    // reported; an unreadable one must not read as "the fixer added nothing".
    writeSnapshot(JSON.stringify([]));
    const { decision, auditFindings } = await runStopGate(
      options(execKilling('git diff HEAD', 'SIGTERM')),
    );
    expect(decision.block).toBe(true);
    expect(decision.outcome).toBe('escalate');
    expect(auditFindings).toEqual([]);
  });

  it('names the git call, the signal, and what the developer should do', async () => {
    const { decision } = await runStopGate(
      options(execKilling('git diff HEAD', 'SIGTERM')),
    );
    expect(decision.message).toContain('git diff HEAD');
    expect(decision.message).toContain('SIGTERM');
    expect(decision.message).toContain('inspected nothing');
    expect(decision.message).toContain('unaudited');
    expect(decision.message).toContain('An empty diff is not a clean one');
    expect(decision.message).toContain('invocation environment');
    expect(decision.message).toContain('Re-run the gate.');
  });

  it('blocks when the unborn-branch fallback `git diff --cached` is killed', async () => {
    // The fallback reads the index on a repo with no HEAD -- the first commit
    // of an adoption is audited through this call and nothing else.
    const exec = makeExec((line) => {
      if (line === 'git diff HEAD')
        return {
          stdout: '',
          stderr: "fatal: ambiguous argument 'HEAD'",
          code: 128,
        };
      if (line === 'git diff --cached') return killedBy('SIGKILL');
      return ok('');
    });
    const { decision } = await runStopGate(options(exec));
    expect(decision.block).toBe(true);
    expect(decision.message).toContain('git diff --cached');
    expect(decision.message).toContain('SIGKILL');
  });

  it('blocks when the untracked-file listing is killed', async () => {
    // `git diff HEAD` omits untracked files, so a suppression in a brand-new
    // file is visible only through this call: losing it loses that whole half.
    const { decision } = await runStopGate(
      options(
        execKilling('git ls-files --others --exclude-standard', 'SIGINT'),
      ),
    );
    expect(decision.block).toBe(true);
    expect(decision.message).toContain('git ls-files --others');
    expect(decision.message).toContain('SIGINT');
  });

  it('leaves the open fix loop in place rather than closing it on a non-answer', async () => {
    // The clean/escalate path deletes the baseline. Dropping it here would
    // forgive every suppression already in the diff on the next cycle, which
    // is exactly the state a killed call must not be able to manufacture.
    writeSnapshot(JSON.stringify([SNEAKY_KEY]));
    await runStopGate(options(execKilling('git diff HEAD', 'SIGTERM')));
    expect(existsSync(snapshotPath())).toBe(true);
  });

  it('logs the firing, so a turn with no verdict is not missing from the log', async () => {
    // #83 logs EVERY firing, clean included, because the delegation share is a
    // fraction and a log that silently omits an outcome has the wrong
    // denominator. A blocked turn that audited nothing is the one outcome most
    // worth being able to count afterwards.
    await runStopGate(options(execKilling('git diff HEAD', 'SIGTERM')));

    const rows = readDecisions(stateDirectory(root));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rung: 'stop',
      session: 'sid',
      outcome: 'escalate',
      // Nothing was audited, so there is no violation count to report and no
      // fixer was named -- the row says the gate fired and produced no verdict.
      violations: 0,
      rules: {},
      introduced: 0,
      resolved: 0,
    });
    expect(Date.parse(rows[0]?.at ?? '')).not.toBeNaN();
  });

  it('does not run verify against a diff it could not read', async () => {
    // The block is decided before anything else spawns: there is no verdict to
    // be had this turn, and the remedy named in the message is to re-run the
    // whole gate, not to act on a half-run one.
    const { exec, calls } = recordingExec((line) =>
      line === 'git diff HEAD' ? killedBy('SIGTERM') : ok(''),
    );
    await runStopGate(options(exec));
    expect(calls.map((call) => call.line)).toEqual(['git diff HEAD']);
  });
});

describe('runStopGate mutation-hardening', () => {
  it('classifies an added suppression as NON-fixable', async () => {
    // Kills `fixable: false` -> true. A fixable suppression would be routed to
    // the SILENT autofix class — the gate would quietly accept gate-cheating.
    writeSnapshot(JSON.stringify([]));
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
    // Delegation is driven by a VERIFY failure here: a suppression alone no
    // longer delegates, because outside a loop there is no fixer to blame.
    const failing = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD'))
        return ok(SNEAKY_DIFF);
      if (line.includes('eslint')) return ok(eslintError());
      return ok('');
    });
    await runStopGate(options(failing));
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

  it('forwards analyzerRungs so an override can lower an analyzer onto this rung', async () => {
    // Kills the `...(options.analyzerRungs && { analyzerRungs: ... })` -> `{}`
    // (ObjectLiteral), `-> false` (ConditionalExpression) and `||`
    // (LogicalOperator) mutants on runStopGate's verifyOptions: stryker's
    // built-in floor is 'commit', so without the override reaching `runVerify`
    // it would never spawn at the per-turn stop gate at all.
    const { exec, calls } = recordingExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      return ok('');
    });
    await runStopGate({
      ...options(exec),
      analyzers: { stryker: 'required' },
      analyzerRungs: { stryker: 'stop' },
    });
    expect(calls.some((call) => call.line.includes('stryker'))).toBe(true);
  });

  it('forwards retry state so one turn is tallied only once', async () => {
    const failing = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('eslint')) return ok(eslintError());
      if (line.includes('--showConfig')) return ok('{"compilerOptions":{}}');
      return ok('');
    });
    await runStopGate(options(failing));
    await runStopGate({ ...options(failing), isRetry: true });
    expect(loadSession(stateDirectory(root), 'sid').ruleCounts).toEqual({
      'no-console': 1,
    });
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
      config,
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
      config,
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
      config,
      exec: empty.exec,
    });
    expect(emptied.findings).toHaveLength(1);
  });

  it('runs its git commands from the repo root', async () => {
    const { exec, calls } = recordingExec((line) =>
      ok(line.startsWith('git merge-base') ? 'BASESHA\n' : ''),
    );
    await runCommitGate({ repoRoot: root, baseBranch: 'main', config, exec });
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
      config,
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

  it('carries the covering test files into the manifest', async () => {
    // End-to-end for the other half of the fixer-search fix: the fixer is told
    // where the test for the violated file lives, through the one channel it
    // reads. `coveringTests` proves the resolution; this proves the gate
    // actually runs it and the result survives serialisation.
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'test'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'foo.ts'), 'export const foo = 1;\n');
    writeFileSync(
      path.join(root, 'test', 'unrelated-name.test.ts'),
      `import { foo } from '../src/foo.js';\n`,
    );
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
    expect(written).toContainEqual(
      expect.objectContaining({
        file: 'src/foo.ts',
        relatedTests: ['test/unrelated-name.test.ts'],
      }),
    );
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
  log: {
    outcome: 'delegate',
    attempt: 1,
    violations: 1,
    rules: { 'eslint/no-console': 1 },
    introduced: 0,
    resolved: 0,
    stalled: false,
  },
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

/** A repo stuck on the same eslint finding: every run reports it, so nothing
 *  the fixer could have done shows up between attempts. */
function stuckExec(): Exec {
  return makeExec((line) => {
    if (line.includes('--name-only')) return ok('src/foo.ts');
    if (line.includes('--others')) return ok('');
    if (line.includes('diff') && line.includes('HEAD')) return ok('');
    if (line.includes('eslint')) return ok(eslintError());
    if (line.includes('--showConfig'))
      return ok(JSON.stringify({ files: ['src/foo.ts'] }));
    return ok('');
  });
}

describe('runStopGate: the unchanged-retry message, across processes', () => {
  /**
   * The regression guard for the defect review found in #47. The
   * unchanged-retry check compares against a digest of the PREVIOUS block, and
   * every Stop-hook fire is a fresh CLI process — so the whole mechanism runs
   * through `saveSession`/`loadSession` on disk. `gate-decision.test.ts` drives
   * the decision twice in memory and cannot see a field that fails to survive
   * that round-trip; this exercises the real store, which is where the bug was.
   */
  it('tells the second block to WAIT rather than spawn another fixer', async () => {
    const exec = stuckExec();

    const first = await runStopGate(options(exec));
    const second = await runStopGate({ ...options(exec), isRetry: true });

    expect(first.decision.message).toMatch(/Spawn the \S+ subagent/);
    expect(second.decision.message).toMatch(/unchanged/i);
    expect(second.decision.message).not.toMatch(/Spawn the \S+ subagent/);
  });

  it('keeps saying WAIT while nothing changes', async () => {
    // A fixer taking a while must not fall back into inviting duplicates on the
    // third or fourth attempt either.
    const exec = stuckExec();

    await runStopGate(options(exec));
    await runStopGate({ ...options(exec), isRetry: true });
    const third = await runStopGate({ ...options(exec), isRetry: true });

    expect(third.decision.message).toMatch(/unchanged/i);
  });
});

/** A diff over a generated file: three generator-emitted casts, plus one
 *  finding of a DIFFERENT kind that no `cast-any` grant may cover. */
const generatedDiff = [
  'diff --git a/src/routeTree.gen.ts b/src/routeTree.gen.ts',
  '--- a/src/routeTree.gen.ts',
  '+++ b/src/routeTree.gen.ts',
  '@@ -1,0 +1,4 @@',
  '+  const a = one as any;',
  '+  const b = two as any;',
  '+  const c = three as any;',
  '+  it.skip("still reported", () => {});',
].join('\n');

function generatedDiffExec(): Exec {
  return makeExec((line) => ok(line.includes('diff') ? generatedDiff : ''));
}

function commitOptions(exec: Exec) {
  return { repoRoot: root, baseBranch: 'main', exec, config };
}

describe('runCommitGate: path-scoped sanctions for generated files', () => {
  it('exempts every occurrence of the granted kind, with no count to keep', async () => {
    // The whole point (#39). A keyed grant needs `count` to equal the real
    // occurrence count, and `sanctionCountDrift` fails the build on a mismatch
    // -- so a generated file churns that number on every regeneration. Three
    // casts here, and the grant names none of them.
    const result = await runCommitGate({
      ...commitOptions(generatedDiffExec()),
      sanctionedFiles: [
        {
          path: 'src/routeTree.gen.ts',
          kind: 'cast-any',
          reason: 'Generated by the router; never hand-edited.',
        },
      ],
    });

    expect(
      result.findings.filter((finding) => finding.kind === 'cast-any'),
    ).toEqual([]);
  });

  it('does not exempt a different kind in the same file', async () => {
    // The grant is file+kind, not file. A generated file that somehow acquires
    // a skipped test is still reported -- otherwise "generated" would become a
    // blanket amnesty.
    const result = await runCommitGate({
      ...commitOptions(generatedDiffExec()),
      sanctionedFiles: [
        {
          path: 'src/routeTree.gen.ts',
          kind: 'cast-any',
          reason: 'Generated by the router.',
        },
      ],
    });

    expect(result.findings.map((finding) => finding.kind)).toEqual([
      'skipped-test',
    ]);
  });

  it('does not exempt the same kind in a different file', async () => {
    const result = await runCommitGate({
      ...commitOptions(generatedDiffExec()),
      sanctionedFiles: [
        {
          path: 'src/somewhere-else.ts',
          kind: 'cast-any',
          reason: 'A different file entirely.',
        },
      ],
    });

    expect(
      result.findings.filter((finding) => finding.kind === 'cast-any'),
    ).toHaveLength(3);
  });

  it('reports everything when no path grant is configured', async () => {
    const result = await runCommitGate(commitOptions(generatedDiffExec()));

    expect(result.findings).toHaveLength(4);
  });
});

/**
 * The laborious classes (#49) reach the commit rung with no delegation path:
 * the terse-pointer → fixer loop exists only at `stop`, so knip,
 * dependency-cruiser and stryker violations blocked with no manifest and no
 * pointer. Surviving mutants are the most labour-intensive class in the pack
 * and were the one class with no fixer — on the reported adoption the main
 * agent worked through 214 of them inline.
 */
function blockingExec(): Exec {
  return makeExec((line) => {
    if (line.includes('--name-only')) return ok('src/foo.ts');
    if (line.includes('--others')) return ok('');
    if (line.includes('diff')) return ok('');
    if (line.includes('eslint')) return ok(eslintError());
    if (line.includes('--showConfig'))
      return ok(JSON.stringify({ files: ['src/foo.ts'] }));
    return ok('');
  });
}

function leases(): FixerLease[] {
  return loadLeases(stateDirectory(root));
}

/** The claims file as it was actually WRITTEN, before `loadLeases` filters it.
 *  Some settle bugs are only visible here — see the release test. */
function readLeasesFile(): unknown {
  return JSON.parse(readFileSync(leasesFile(stateDirectory(root)), 'utf8'));
}

function blockedOptions() {
  return {
    repoRoot: root,
    baseBranch: 'main',
    exec: blockingExec(),
    config,
    sessionId: 'sid',
  };
}

describe('runCommitGate: delegation for the laborious classes', () => {
  it('writes the violations to a manifest the fixer can be pointed at', async () => {
    const result = await runCommitGate(blockedOptions());

    expect(result.blocked).toBe(true);
    expect(result.delegation?.manifestPath).toBeDefined();
    expect(readViolations(stateDirectory(root), 'sid-commit')).toHaveLength(
      result.violations.length,
    );
  });

  it('names a fixer agent to spawn', async () => {
    const result = await runCommitGate(blockedOptions());

    expect(result.delegation?.fixerAgent).toBeDefined();
  });

  it('keeps the commit-rung manifest clear of the stop-rung one', async () => {
    // Both rungs write `<id>.last.json`. Sharing an id would have the commit
    // gate clobber a manifest an in-flight stop loop is still working from.
    await runCommitGate(blockedOptions());

    expect(readViolations(stateDirectory(root), 'sid')).toEqual([]);
    expect(
      readViolations(stateDirectory(root), 'sid-commit').length,
    ).toBeGreaterThan(0);
  });

  it('writes nothing and names nobody when the gate passes', async () => {
    // A clean commit must not leave a stale manifest behind for the next
    // block to be read against.
    const clean = makeExec((line) => {
      if (line.includes('--name-only')) return ok('');
      if (line.includes('--others')) return ok('');
      return ok('');
    });
    const result = await runCommitGate({ ...blockedOptions(), exec: clean });

    expect(result.blocked).toBe(false);
    expect(result.delegation?.manifestPath).toBeUndefined();
    expect(result.delegation?.fixerAgent).toBeUndefined();
  });

  it('routes a loose violation to the thorough fixer', async () => {
    // Reusing the stop gate's loose-class rule rather than inventing a second
    // policy. The commit-rung analyzers -- knip, dependency-cruiser, stryker --
    // are loose by construction, which is why this is the branch that matters.
    const result = await runCommitGate({
      ...blockedOptions(),
      config: { ...config, isLoose: () => true },
    });

    expect(result.delegation?.fixerAgent).toBe('guardrail-fixer-thorough');
  });

  it('routes to the thorough fixer when only SOME violations are loose', async () => {
    // `.some`, not `.every`: a batch mixing a mechanical eslint finding with a
    // surviving mutant is the normal commit-rung shape, and the loose one is
    // what decides. `.every` would quietly demote exactly that batch.
    let call = 0;
    const result = await runCommitGate({
      ...blockedOptions(),
      config: {
        ...config,
        isLoose: () => {
          call += 1;
          return call === 1;
        },
      },
    });

    expect(result.delegation?.fixerAgent).toBe('guardrail-fixer-thorough');
  });

  it('routes a tight violation to the fast fixer', async () => {
    const result = await runCommitGate({
      ...blockedOptions(),
      config: { ...config, isLoose: () => false },
    });

    expect(result.delegation?.fixerAgent).toBe('guardrail-fixer');
  });

  it('delivers the manifest and the fixer together or not at all', async () => {
    // The pair is one optional object rather than two optional fields, so
    // "a manifest with nobody named to fix it" is not a state the result can
    // express. Asserted rather than left to the type, since the type is what a
    // future edit would loosen first.
    const result = await runCommitGate(blockedOptions());

    expect(result.delegation).toMatchObject({
      manifestPath: expect.any(String),
      fixerAgent: expect.any(String),
    });
  });

  it('still blocks — delegation changes the message, never the verdict', async () => {
    // The load-bearing assertion. The stop gate's ladder ends in `escalate`,
    // which RELEASES the turn; at the commit rung that would mean letting a
    // bad commit through. Whatever the pointer says, `blocked` stays true.
    const result = await runCommitGate(blockedOptions());

    expect(result.blocked).toBe(true);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('works without a session id, as a git hook has none', async () => {
    // `.husky/pre-commit` runs `gate --mode=commit` with no hook payload, so
    // there is no session to key on.
    const { sessionId: _omitted, ...noSession } = blockedOptions();
    const result = await runCommitGate(noSession);

    expect(result.blocked).toBe(true);
    expect(result.delegation?.manifestPath).toBeDefined();
  });
});

/**
 * The cross-rung collision (#76). The two rungs write different manifests and
 * name fixers independently, so the unchanged-digest guard — which asks "is a
 * fixer already running on THIS manifest" — never sees it. Observed as real
 * damage: two fixers in one file, one removing imports the other's code used.
 */
describe('fixer leases across the two rungs', () => {
  it('claims the files a commit-rung block hands to a fixer', async () => {
    await runCommitGate(blockedOptions());

    expect(leases()).toEqual([
      {
        owner: 'commit:sid-commit',
        manifestPath: path.join('.guardrails', 'state', 'sid-commit.last.json'),
        fixerAgent: 'guardrail-fixer',
        // Every file the manifest names, not only the source one: the commit
        // rung runs analyzers the stop rung does not, and each of their
        // findings is work a fixer is about to do somewhere.
        files: ['package.json', 'src/foo.ts'],
        grantedAt: expect.any(Number),
        deferrals: 0,
      },
    ]);
  });

  it('releases the claim when the commit gate passes', async () => {
    // The fix loop that claim belonged to is over; holding it would make the
    // next Stop gate wait for a fixer that has nothing left to do.
    const clean = makeExec((line) => {
      if (line.includes('--name-only')) return ok('');
      if (line.includes('--others')) return ok('');
      return ok('');
    });
    await runCommitGate(blockedOptions());
    await runCommitGate({ ...blockedOptions(), exec: clean });

    expect(leases()).toEqual([]);
    // Asserted on the FILE, not only on what `loadLeases` gives back. The
    // release is the one branch keyed on "no fixer was named", so code that
    // skipped it would store a claim whose `fixerAgent` is undefined -- which
    // `loadLeases` rejects on the way back in, making an in-memory assertion
    // pass over a claim that is still sitting on disk. Only the file shows
    // the difference.
    expect(readLeasesFile()).toEqual([]);
  });

  it('writes no claims file at all when nothing is ever claimed', async () => {
    // A repo whose gates pass must not accumulate state for claims that were
    // never taken: the settle step returns early rather than writing `[]`.
    const clean = makeExec((line) => {
      if (line.includes('--name-only')) return ok('');
      if (line.includes('--others')) return ok('');
      return ok('');
    });
    await runStopGate(options(clean));

    expect(existsSync(leasesFile(stateDirectory(root)))).toBe(false);
  });

  it('makes the Stop gate wait instead of naming a second fixer', async () => {
    // The whole point: the commit rung's fixer is mid-edit in src/foo.ts when
    // the turn ends and the Stop gate finds the same file.
    await runCommitGate(blockedOptions());
    const { decision } = await runStopGate(options(blockingExec()));

    expect(decision.outcome).toBe('delegate');
    expect(decision.block).toBe(true);
    expect(decision.message).toContain('sid-commit.last.json');
    expect(decision.message).toContain('src/foo.ts');
    expect(decision.message).not.toContain('Spawn the');
  });

  it('does not claim the files it just declined to spawn a fixer into', async () => {
    // A deferral names no fixer, so there is nothing to hold the files for --
    // and a second claim on them would make the commit rung wait in turn.
    await runCommitGate(blockedOptions());
    await runStopGate(options(blockingExec()));

    expect(leases().map((lease) => lease.owner)).toEqual(['commit:sid-commit']);
  });

  it('spends the wait, so a fixer that died cannot deadlock the loop', async () => {
    // The commit rung only releases its claim when it fires again, which needs
    // a commit ATTEMPT the agent may never make while the Stop gate blocks.
    // The second Stop gate therefore proceeds normally.
    await runCommitGate(blockedOptions());
    await runStopGate(options(blockingExec()));
    expect(leases()[0]?.deferrals).toBe(1);

    const { decision } = await runStopGate(options(blockingExec()));
    expect(decision.message).toContain('Spawn the');
  });

  it('claims the files once the Stop gate does name a fixer', async () => {
    await runStopGate(options(blockingExec()));

    expect(leases()).toEqual([
      expect.objectContaining({
        owner: 'stop:sid',
        fixerAgent: 'guardrail-fixer',
        files: ['src/foo.ts'],
      }),
    ]);
  });

  it('releases the Stop claim when the turn goes clean', async () => {
    const clean = makeExec((line) => {
      if (line.includes('--name-only')) return ok('');
      if (line.includes('--others')) return ok('');
      return ok('');
    });
    await runStopGate(options(blockingExec()));
    await runStopGate(options(clean));

    expect(leases()).toEqual([]);
  });

  it('tells the commit rung to wait for a Stop-rung fixer too', async () => {
    // Symmetric by construction: whichever rung fires second is the observer.
    await runStopGate(options(blockingExec()));
    const result = await runCommitGate(blockedOptions());

    expect(result.blocked).toBe(true);
    expect(result.delegation?.waitFor).toMatchObject({
      owner: 'stop:sid',
      files: ['src/foo.ts'],
    });
  });

  it('names nobody to wait for when the rungs are in different files', async () => {
    // A lease is a claim on FILES, not a session-wide "a fixer is running"
    // flag: two fixers in disjoint file sets are exactly the parallelism worth
    // keeping.
    const elsewhere = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/other.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff')) return ok('');
      if (line.includes('eslint'))
        return ok(
          JSON.stringify([
            {
              filePath: path.join(root, 'src/other.ts'),
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
      if (line.includes('--showConfig'))
        return ok(JSON.stringify({ files: ['src/other.ts'] }));
      return ok('');
    });
    await runCommitGate(blockedOptions());
    const { decision } = await runStopGate({
      ...options(elsewhere),
      sessionId: 'sid',
    });

    expect(decision.message).toContain('Spawn the');
    expect(
      leases()
        .map((lease) => lease.owner)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(['commit:sid-commit', 'stop:sid']);
  });
});
