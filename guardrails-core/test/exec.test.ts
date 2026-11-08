import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import {
  signalFromExitCode,
  spawnExec,
  forwardTerminationSignal,
  terminateChildren,
} from '../src/exec.js';

const node = process.execPath;

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-exec-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('spawnExec', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await spawnExec(node, ['-e', 'process.stdout.write("hi")']);
    expect(result.stdout).toBe('hi');
    expect(result.code).toBe(0);
  });

  it('captures a non-zero exit code', async () => {
    const result = await spawnExec(node, ['-e', 'process.exit(3)']);
    expect(result.code).toBe(3);
  });

  it('runs in the given cwd', async () => {
    const result = await spawnExec(
      node,
      ['-e', 'process.stdout.write(process.cwd())'],
      {
        cwd: root,
      },
    );
    // macOS symlinks /var → /private/var; compare basenames to avoid that.
    expect(path.basename(result.stdout)).toBe(path.basename(root));
  });

  it('applies a custom environment (and can drop inherited vars)', async () => {
    // The load-bearing case: a caller wanting an isolated git invocation must be
    // able to strip inherited GIT_* vars so a hook's GIT_DIR can't hijack it.
    const result = await spawnExec(
      node,
      ['-e', 'process.stdout.write(String(process.env.GIT_DIR))'],
      { env: { PATH: process.env.PATH } },
    );
    expect(result.stdout).toBe('undefined');
  });

  it('writes input to the child on stdin, then closes it', async () => {
    // Closing matters as much as writing: a child reading stdin to its end
    // would otherwise wait forever.
    const result = await spawnExec(
      node,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      { input: '{"cwd":"/x"}' },
    );
    expect(result.stdout).toBe('{"cwd":"/x"}');
  });

  it('leaves stdin open when there is no input', async () => {
    const result = await spawnExec(node, [
      '-e',
      [
        'process.stdin.resume();',
        "process.stdin.on('end', () => { process.stdout.write('closed'); process.exit(0); });",
        "setTimeout(() => { process.stdout.write('open'); process.exit(0); }, 300);",
      ].join(' '),
    ]);
    expect(result.stdout).toBe('open');
  });

  it('resolves (does not reject) when the command does not exist', async () => {
    const result = await spawnExec('definitely-not-a-real-binary-xyz', []);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('spawn failure is distinguishable from a failing run', () => {
  it('flags spawnFailed when the binary does not exist', async () => {
    // A missing analyzer must not look like a clean one. Exit code cannot carry
    // this: eslint exits 1 on findings and tsc exits non-zero on type errors, so
    // non-zero is the NORMAL case.
    const result = await spawnExec('guardrails-no-such-binary-xyz', [
      '--version',
    ]);
    expect(result.spawnFailed).toBe(true);
    expect(result.stdout).toBe('');
  });

  it('does NOT flag spawnFailed for a process that ran and exited non-zero', async () => {
    const result = await spawnExec(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.code).toBe(3);
    expect(result.spawnFailed).toBeUndefined();
  });

  it('does NOT flag spawnFailed for a successful run', async () => {
    const result = await spawnExec(process.execPath, [
      '-e',
      'console.log("ok")',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
    expect(result.spawnFailed).toBeUndefined();
  });
});

describe('env replacement', () => {
  it('passes an explicit env through, replacing the inherited one', async () => {
    // Load-bearing: hooks run with GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
    // exported into the environment, and a `git` spawned from inside a hook
    // would target the HOOK's repo regardless of cwd unless they are stripped.
    const result = await spawnExec(
      process.execPath,
      ['-e', 'console.log(process.env.GUARDRAILS_PROBE)'],
      { env: { GUARDRAILS_PROBE: 'replaced' } },
    );
    expect(result.stdout.trim()).toBe('replaced');
  });

  it('inherits the parent environment when no env is given', async () => {
    const result = await spawnExec(process.execPath, [
      '-e',
      'console.log(process.env.PATH === undefined ? "stripped" : "inherited")',
    ]);
    expect(result.stdout.trim()).toBe('inherited');
  });
});

describe('stderr capture from a real process', () => {
  // The `child.stderr.on('data')` handler was previously exercised only via the
  // spawn-error path (a missing binary), which fills `stderr` from the `error`
  // event instead. `analyzerFailedViolation` quotes the first line of stderr as
  // its diagnostic, so a process that RUNS and writes to stderr is the case
  // that actually has to work.
  it('accumulates what a running process writes to stderr', async () => {
    const result = await spawnExec(node, [
      '-e',
      String.raw`process.stderr.write("first line\nsecond line"); process.exit(2)`,
    ]);
    expect(result.stderr).toBe('first line\nsecond line');
    expect(result.code).toBe(2);
    expect(result.spawnFailed).toBeUndefined();
  });

  it('accumulates stderr across multiple chunks without interleaving stdout', async () => {
    const result = await spawnExec(node, [
      '-e',
      'process.stderr.write("a"); process.stdout.write("OUT"); process.stderr.write("b");',
    ]);
    expect(result.stderr).toBe('ab');
    expect(result.stdout).toBe('OUT');
  });
});

describe('a signal-killed run is distinguishable from a clean one', () => {
  // Node reports a process killed by a signal as `code === null,
  // signal === 'SIGTERM'`, and this spawn deliberately uses `shell: false`, so
  // there is no shell to translate that into 128+N. Coalescing the null to zero
  // made a killed analyzer — empty stdout, "exit 0" — read exactly like a clean
  // one.
  it('carries the signal that killed the process', async () => {
    const result = await spawnExec(node, [
      '-e',
      'process.kill(process.pid, "SIGTERM")',
    ]);
    expect(result.signal).toBe('SIGTERM');
  });

  it('never presents a killed run as the reading a caller treats as clean', async () => {
    const result = await spawnExec(node, [
      '-e',
      'process.kill(process.pid, "SIGKILL")',
    ]);
    // The whole fail-open in one assertion: "exit 0, nothing on stderr, no
    // signal" is what every consumer of this seam reads as success.
    expect(result.code === 0 && result.signal === undefined).toBe(false);
  });

  it('leaves signal absent for a process that exited on its own', async () => {
    const result = await spawnExec(node, ['-e', 'process.exit(3)']);
    expect(result.signal).toBeUndefined();
    expect(result.code).toBe(3);
  });

  it('leaves signal absent for a clean run', async () => {
    const result = await spawnExec(node, ['-e', 'process.stdout.write("ok")']);
    expect(result.signal).toBeUndefined();
    expect(result.code).toBe(0);
  });

  it('leaves signal absent when the binary could not be started', async () => {
    const result = await spawnExec('guardrails-no-such-binary-xyz', []);
    expect(result.spawnFailed).toBe(true);
    expect(result.signal).toBeUndefined();
  });
});

describe('signalFromExitCode', () => {
  // A wrapper binary between guardrails and the analyzer (npx, sh, a shell
  // script) waits on the child itself and re-reports the kill the way a shell
  // does: 128 + the signal number. By the time that reaches this process it is
  // an ordinary exit code with no signal attached, so the only way to recognise
  // it is to read the number.
  it('recognises the shell convention for a SIGTERM kill (143)', () => {
    expect(signalFromExitCode(143)).toBe('SIGTERM');
  });

  it('recognises an OOM kill (137)', () => {
    expect(signalFromExitCode(137)).toBe('SIGKILL');
  });

  it('recognises a Ctrl-C (130)', () => {
    expect(signalFromExitCode(130)).toBe('SIGINT');
  });

  // The whole table, so a signal cannot quietly drop out of the list it is
  // decoded from. The numbers are the POSIX-standard ones, which is what makes
  // 128+N a convention rather than a per-platform accident.
  it.each([
    [129, 'SIGHUP'],
    [130, 'SIGINT'],
    [131, 'SIGQUIT'],
    [132, 'SIGILL'],
    [134, 'SIGABRT'],
    [136, 'SIGFPE'],
    [137, 'SIGKILL'],
    [139, 'SIGSEGV'],
    [141, 'SIGPIPE'],
    [142, 'SIGALRM'],
    [143, 'SIGTERM'],
    [152, 'SIGXCPU'],
    [153, 'SIGXFSZ'],
  ])('decodes exit %i as %s', (code, name) => {
    expect(signalFromExitCode(code)).toBe(name);
  });

  it('returns undefined for exit codes analyzers really use', () => {
    // eslint exits 1 on findings and 2 on a crash; tsc uses 1/2/3; git uses
    // 128 for "bad revision". None of these are kills, and reading them as one
    // would replace a true diagnosis with a wrong story about timeouts.
    expect(signalFromExitCode(0)).toBeUndefined();
    expect(signalFromExitCode(1)).toBeUndefined();
    expect(signalFromExitCode(2)).toBeUndefined();
    expect(signalFromExitCode(128)).toBeUndefined();
  });

  it('returns undefined for a number above the signal range', () => {
    expect(signalFromExitCode(255)).toBeUndefined();
  });
});

describe('terminateChildren', () => {
  it('signals every child still running and reports how many', async () => {
    // The hook deadline's half of the job: a gate that gives up before the
    // host's timeout must not leave tsc or stryker running behind it. In the
    // field, abandoned gates kept analysers alive for up to 20 minutes and held
    // a machine-wide lock while they did.
    const running = spawnExec(node, ['-e', 'setInterval(() => {}, 1000)']);
    const count = terminateChildren();
    const result = await running;

    expect(count).toBe(1);
    expect(result.signal).toBe('SIGTERM');
  });

  it('forgets a child once it has exited', async () => {
    await spawnExec(node, ['-e', 'process.exit(0)']);
    expect(terminateChildren()).toBe(0);
  });

  it('forgets a child that could not be started', async () => {
    await spawnExec('definitely-not-a-real-binary-xyz', []);
    expect(terminateChildren()).toBe(0);
  });
});

/**
 * Spawn `sh` as a process group whose grandchild writes its pid to `pidFile`
 * and then runs forever -- the shape of `lockf … stryker`, without needing a
 * locker on the machine.
 *
 * The grandchild handles SIGINT, as stryker does: a job `sh` starts with `&`
 * otherwise inherits SIGINT ignored (POSIX, for a non-interactive shell),
 * which `lockf` -- it execs its command -- does not do to stryker.
 */
function groupWithGrandchild(pidFile: string) {
  return spawnExec(
    'sh',
    [
      '-c',
      // The grandchild names itself once its handler is in, so no test
      // signals it before then.
      `${node} -e "process.on('SIGINT', () => process.exit(130)); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)" "${pidFile}" & wait`,
    ],
    { processGroup: true },
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const text = existsSync(pidFile)
      ? readFileSync(pidFile, 'utf8').trim()
      : '';
    if (text !== '') {
      return Number(text);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('grandchild never started');
}

const forever = 'setInterval(() => {}, 1000)';

/**
A child-side expression for the child's own process group, via `ps`.
*/
const groupLookup =
  'require("node:child_process").execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)]).toString().trim()';

/**
The process group of `pid`, as `ps` reports it.
*/
function groupOf(pid: number): string {
  return execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)])
    .toString()
    .trim();
}

describe('processGroup decides whether a child leads its own group', () => {
  it('starts a group child as the leader of a new group', async () => {
    const result = await spawnExec(
      node,
      ['-e', `process.stdout.write(${groupLookup})`],
      { processGroup: true },
    );
    expect(result.stdout).not.toBe(groupOf(process.pid));
  });

  it('leaves an ordinary child in the group it was started from', async () => {
    const result = await spawnExec(node, [
      '-e',
      `process.stdout.write(${groupLookup})`,
    ]);
    expect(result.stdout).toBe(groupOf(process.pid));
  });
});

describe('terminateChildren picks the right way to stop each child', () => {
  it('addresses a process group only for a child that leads one', async () => {
    const kill = vi.spyOn(process, 'kill');
    try {
      const plain = spawnExec(node, ['-e', forever]);
      terminateChildren();
      await plain;
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});

/**
How many SIGINT and SIGTERM handlers the process has right now.
*/
function listeners(): number[] {
  return [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
}

describe('termination handlers are installed only while a group is live', () => {
  it('adds one handler per signal for a group, and removes it when the group ends', async () => {
    const [interrupts = 0, terminations = 0] = listeners();
    const running = spawnExec(node, ['-e', forever], { processGroup: true });
    expect(listeners()).toEqual([interrupts + 1, terminations + 1]);
    terminateChildren();
    await running;
    expect(listeners()).toEqual([interrupts, terminations]);
  });

  it('adds none for a child that is not a group', async () => {
    const before = listeners();
    const running = spawnExec(node, ['-e', forever]);
    expect(listeners()).toEqual(before);
    terminateChildren();
    await running;
    expect(listeners()).toEqual(before);
  });

  it('shares one handler across overlapping groups, until the last one ends', async () => {
    const [interrupts = 0, terminations = 0] = listeners();
    const short = spawnExec(node, ['-e', 'setTimeout(() => {}, 200)'], {
      processGroup: true,
    });
    const long = spawnExec(node, ['-e', forever], { processGroup: true });
    expect(listeners()).toEqual([interrupts + 1, terminations + 1]);
    await short;
    expect(listeners()).toEqual([interrupts + 1, terminations + 1]);
    terminateChildren();
    await long;
    expect(listeners()).toEqual([interrupts, terminations]);
  });

  it('removes them when a group child fails to start', async () => {
    const before = listeners();
    await spawnExec('definitely-not-a-real-binary-xyz', [], {
      processGroup: true,
    });
    expect(listeners()).toEqual(before);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'ends the group and exits when the process receives %s',
    async (signal, expected) => {
      const exits: unknown[] = [];
      const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
        exits.push(code);
        throw new Error('exit intercepted');
      });
      try {
        const existing = process.listeners(signal);
        const running = spawnExec(node, ['-e', forever], {
          processGroup: true,
        });
        // Call only the handler this spawn installed: emitting the signal
        // itself would also run whatever the test runner listens with.
        const handler = process
          .listeners(signal)
          .find((listener) => !existing.includes(listener));
        expect(handler).toBeDefined();
        expect(() => handler?.(signal)).toThrow('exit intercepted');
        const result = await running;
        expect(result.signal).toBe('SIGINT');
        expect(exits).toEqual([expected]);
      } finally {
        exit.mockRestore();
      }
    },
  );
});

/**
 * A group child that counts the SIGINTs it gets and survives them, printing
 * the running count -- a stryker that will not stop, or one told to stop
 * twice.
 */
const countsInterrupts =
  'let heard = 0; process.on("SIGINT", () => { heard += 1; process.stdout.write(String(heard)); }); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)';

describe('a process group is stopped with one SIGINT, then a SIGKILL after its grace', () => {
  // Measured (plan.md, 2026-11-07): stryker saves its partial incremental
  // report on the first stop signal and loses it on a second (#6257). SIGINT,
  // not SIGTERM, is the stop stryker documents for an interrupted run.
  it('sends a group SIGINT, not SIGTERM', async () => {
    const running = spawnExec(node, ['-e', forever], { processGroup: true });
    terminateChildren();
    const result = await running;
    expect(result.signal).toBe('SIGINT');
  });

  it('signals a group once, however many times it is told to stop', async () => {
    const ready = path.join(root, 'ready.pid');
    const running = spawnExec(node, ['-e', countsInterrupts, ready], {
      processGroup: true,
      stopGraceSeconds: 1,
    });
    // The child names itself once its handler is in.
    await readPid(ready);
    terminateChildren();
    terminateChildren();
    const result = await running;
    expect(result.stdout).toBe('1');
  });

  it('SIGKILLs a group still running when its grace runs out', async () => {
    const ready = path.join(root, 'ready.pid');
    const running = spawnExec(node, ['-e', countsInterrupts, ready], {
      processGroup: true,
      stopGraceSeconds: 1,
    });
    await readPid(ready);
    const stoppedAt = Date.now();
    terminateChildren();
    const result = await running;
    expect(result.signal).toBe('SIGKILL');
    // Not before the grace: the SIGINT alone did not end it.
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(1000);
  });

  it('kills the whole group at the grace, not only its leader', async () => {
    const pidFile = path.join(root, 'grandchild.pid');
    const running = spawnExec(
      'sh',
      [
        '-c',
        `trap '' INT; ${node} -e 'process.on("SIGINT", () => {}); setInterval(() => {}, 1000)' & echo $! > "${pidFile}"; wait; wait`,
      ],
      { processGroup: true, stopGraceSeconds: 1 },
    );
    const grandchild = await readPid(pidFile);
    terminateChildren();
    await running;
    const deadline = Date.now() + 5000;
    while (isAlive(grandchild) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isAlive(grandchild)).toBe(false);
  });

  it('leaves a plain child to SIGTERM, as before', async () => {
    const running = spawnExec(node, ['-e', forever]);
    terminateChildren();
    const result = await running;
    expect(result.signal).toBe('SIGTERM');
  });
});

describe('a process-group child takes its grandchildren with it', () => {
  it('terminates the whole group, not just the direct child', async () => {
    // Measured 2026-11-01: SIGTERM to `lockf -k … cmd` frees the lock AND
    // leaves cmd running. An abandoned gate would leave stryker mutating
    // unlocked -- the thrash the lock exists to prevent.
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-group-'));
    const pidFile = path.join(directory, 'grandchild.pid');
    try {
      const running = groupWithGrandchild(pidFile);
      const grandchild = await readPid(pidFile);
      expect(terminateChildren()).toBe(1);
      await running;
      const deadline = Date.now() + 5000;
      while (isAlive(grandchild) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(isAlive(grandchild)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('terminates the group on a forwarded signal, then exits with its code', async () => {
    // A detached group no longer receives the terminal's Ctrl-C, so the CLI
    // has to pass it on.
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-group-'));
    const pidFile = path.join(directory, 'grandchild.pid');
    const exits: number[] = [];
    try {
      const running = groupWithGrandchild(pidFile);
      const grandchild = await readPid(pidFile);
      forwardTerminationSignal('SIGINT', (code) => {
        exits.push(code);
      });
      await running;
      const deadline = Date.now() + 5000;
      while (isAlive(grandchild) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(isAlive(grandchild)).toBe(false);
      expect(exits).toEqual([130]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * Run `terminateChildren` straight after spawning a binary that does not
 * exist, before Node has reported the failure -- in a node of its OWN SESSION,
 * and report whether that node survived.
 *
 * Measured 2026-11-01 (Node 24, macOS): `child.kill()` in that window sends
 * SIGTERM to the caller's whole process group, grouped child or not. A gate
 * abandoned at its deadline while an analyzer spawn is failing would kill
 * itself and the hook that ran it. Isolated because a regression here kills
 * whatever process group runs the test -- the test runner, or a push hook.
 */
function survivesTerminatingAnUnstartedSpawn(isGroup: boolean): string {
  const exec = path.join(import.meta.dirname, '..', 'src', 'exec.ts');
  const script = [
    `import { spawnExec, terminateChildren } from ${JSON.stringify(exec)};`,
    `void spawnExec('definitely-not-a-real-binary-xyz', [], { processGroup: ${String(isGroup)} });`,
    'terminateChildren();',
    "setTimeout(() => { process.stdout.write('survived'); }, 200);",
  ].join('\n');
  const result = spawnSync(
    'python3',
    [
      '-c',
      'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])',
      node,
      '--input-type=module',
      '-e',
      script,
    ],
    { encoding: 'utf8' },
  );
  return result.stdout;
}

/**
 * A child whose spawn has not yet reported: no pid, 'error' still to come.
 */
function unstartedChild(stopChild: Mock) {
  // Streams, not bare emitters: a stream IS an emitter with the `.on` the
  // spawn wrapper listens with, and a child's stdout and stderr are streams.
  return Object.assign(new PassThrough(), {
    pid: undefined,
    kill: stopChild,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}

describe('terminateChildren skips a child that has no pid yet', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  // Faked at the `spawn` seam, with a freshly imported copy of exec.ts, so no
  // real process exists to signal: a real unstarted spawn killed in-process
  // signals the test runner's whole group. The test above covers that
  // end to end in its own session; this one pins the guard in-process.
  it.each([false, true])(
    'neither kills the child nor signals a group (processGroup: %s)',
    async (isGroup) => {
      const kill = vi.fn(() => true);
      const child = unstartedChild(kill);
      vi.resetModules();
      vi.doMock('node:child_process', () => ({ spawn: () => child }));
      const groupKill = vi
        .spyOn(process, 'kill')
        .mockImplementation(() => true);
      const fresh = await import('../src/exec.js');

      const pending = fresh.spawnExec('never-started', [], {
        processGroup: isGroup,
      });

      // Counted as live, but there is nothing running to stop.
      expect(fresh.terminateChildren()).toBe(1);
      expect(kill).not.toHaveBeenCalled();
      expect(groupKill).not.toHaveBeenCalled();

      child.emit('error', new Error('spawn ENOENT'));
      const result = await pending;
      groupKill.mockRestore();
      expect(result.spawnFailed).toBe(true);
      expect(fresh.terminateChildren()).toBe(0);
    },
  );
});

describe('terminateChildren never signals its own process group', () => {
  it.each([false, true])(
    'leaves the caller alive after a spawn that never started (processGroup: %s)',
    (isGroup) => {
      expect(survivesTerminatingAnUnstartedSpawn(isGroup)).toBe('survived');
    },
  );
});
