import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import { isRecord } from '../src/is-record.js';
import { preflightErrorLine, preflightFailedLine } from '../src/preflight.js';
import { parseRuns } from '../src/run-log.js';
import {
  LOCK_TIMEOUT_MARKER,
  NOT_INSTALLED_MARKER,
  classifyPushFailure,
  gateFailures,
  parseChecks,
  ship,
  type ShipOptions,
  type ShipStatus,
  shipSummary,
  writeShipStatus,
} from '../src/ship.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-ship-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });
const failed = (stderr: string, code = 1): ExecResult => ({
  stdout: '',
  stderr,
  code,
});

const PR_JSON = JSON.stringify({
  number: 42,
  url: 'https://github.com/o/r/pull/42',
});

interface Call {
  line: string;
  cwd: string | undefined;
}

/**
 * A git + gh whose every answer is `answers[<command line prefix>]`, else a
 * success with no output. Records every call.
 */
function fakeExec(answers: Record<string, ExecResult | ExecResult[]>): {
  exec: Exec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: Exec = (command, args, options) => {
    const line = [command, ...args].join(' ');
    calls.push({ line, cwd: options?.cwd });
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    const answer = key === undefined ? ok('') : answers[key];
    const result = Array.isArray(answer)
      ? (answer.shift() ?? ok(''))
      : (answer ?? ok(''));
    return Promise.resolve(result);
  };
  return { exec, calls };
}

const HAPPY_CHECKS = JSON.stringify([
  { name: 'build', bucket: 'pass' },
  { name: 'lint', bucket: 'skipping' },
]);

const HAPPY: Record<string, ExecResult | ExecResult[]> = {
  'git rev-parse --abbrev-ref HEAD': ok('feat/x\n'),
  'gh pr view': ok(PR_JSON),
  'gh pr checks 42 --json': ok(HAPPY_CHECKS),
  'gh run list': ok('[]'),
  'git rev-parse HEAD': ok('abc123\n'),
  'git ls-remote': ok('abc123\trefs/heads/feat/x\n'),
};

/**
The push gate every test ship runs, and the command line it shows up as.
*/
const PUSH_GATE = { command: 'node', args: ['cli.mjs', 'gate', '--mode=push'] };
const GATE_LINE = 'node cli.mjs gate --mode=push';

function options(exec: Exec, over: Partial<ShipOptions> = {}): ShipOptions {
  return {
    exec,
    repoRoot: root,
    baseBranch: 'main',
    pushGate: PUSH_GATE,
    now: () => new Date('2026-10-12T12:00:00.000Z'),
    delay: () => Promise.resolve(),
    ...over,
  };
}

describe('ship: gh is checked before anything is pushed', () => {
  it('stops before pushing when gh is not installed', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh auth status': {
        stdout: '',
        stderr: 'spawn gh ENOENT',
        code: 1,
        spawnFailed: true,
      },
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail).toContain('gh (GitHub CLI) is not installed');
    expect(calls.some((call) => call.line.startsWith('git push'))).toBe(false);
  });

  it('stops before pushing when gh is not logged in', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh auth status': failed('You are not logged into any GitHub hosts.'),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail).toContain('gh auth login');
    expect(status.tail).toContain('You are not logged into any GitHub hosts.');
    expect(calls.some((call) => call.line.startsWith('git push'))).toBe(false);
  });

  it('asks gh in the repository it ships', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    await ship(options(exec));
    const asked = calls.find((call) => call.line === 'gh auth status');
    expect(asked?.cwd).toBe(root);
    expect(
      calls.findIndex((call) => call.line === 'gh auth status'),
    ).toBeLessThan(calls.findIndex((call) => call.line.startsWith('git push')));
  });
});

describe('ship: the body file is checked before anything is pushed', () => {
  it('stops before pushing when the body file does not exist', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const missing = path.join(root, 'missing.md');
    const status = await ship(options(exec, { bodyFile: missing }));
    expect(status).toMatchObject({ state: 'error', pr: null, url: null });
    expect(status.tail).toBe(
      `guardrails ship: --body-file ${missing} does not exist (or is not ` +
        'readable). Nothing was pushed.',
    );
    expect(calls.some((call) => call.line.startsWith('git push'))).toBe(false);
  });

  it('pushes as before when the body file is readable', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const body = path.join(root, 'pr.md');
    writeFileSync(body, 'the body\n');
    const status = await ship(options(exec, { bodyFile: body }));
    expect(status.state).toBe('green');
    expect(calls.map((call) => call.line)).toContain('git push -u origin HEAD');
  });

  it('checks gh before the body file', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh auth status': failed('You are not logged into any GitHub hosts.'),
    });
    const missing = path.join(root, 'missing.md');
    const status = await ship(options(exec, { bodyFile: missing }));
    expect(status.tail).toContain('gh auth login');
  });
});

async function stateOf(exec: Exec): Promise<string> {
  const status = await ship(options(exec));
  return status.state;
}

/**
Where the first call starting with `prefix` falls among `calls`; -1 if none.
*/
function indexOf(calls: readonly Call[], prefix: string): number {
  return calls.findIndex((call) => call.line.startsWith(prefix));
}

describe('ship: the push gate runs before git push (#204)', () => {
  it('runs the gate after everything asked before the push, and before it', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    await ship(options(exec));
    const gate = indexOf(calls, GATE_LINE);
    expect(gate).toBeGreaterThan(indexOf(calls, 'gh auth status'));
    expect(gate).toBeGreaterThan(indexOf(calls, 'git rev-parse HEAD'));
    expect(gate).toBeGreaterThan(
      indexOf(calls, 'git merge-base --is-ancestor'),
    );
    expect(gate).toBeLessThan(indexOf(calls, 'git push'));
  });

  it('runs the gate once, in the repository it ships', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    await ship(options(exec));
    const gates = calls.filter((call) => call.line === GATE_LINE);
    expect(gates).toEqual([{ line: GATE_LINE, cwd: root }]);
  });

  it('runs no gate when the prechecks stop the ship', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh auth status': failed('You are not logged into any GitHub hosts.'),
    });
    await ship(options(exec));
    expect(indexOf(calls, GATE_LINE)).toBe(-1);
  });
});

describe('ship: the push gate decides before anything is pushed (#204)', () => {
  const BLOCK_TEXT =
    'src/a.ts:3 [no-console] Unexpected console statement. (eslint)\n';

  it('reports a blocked gate as gate-blocked and pushes nothing', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('no pull requests found'),
      [GATE_LINE]: failed(BLOCK_TEXT),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'gate-blocked',
      pr: null,
      url: null,
      failing: ['src/a.ts:3 no-console'],
    });
    expect(status.tail).toContain('src/a.ts:3 [no-console]');
    expect(indexOf(calls, 'git push')).toBe(-1);
    expect(indexOf(calls, 'gh pr create')).toBe(-1);
  });

  it('still names the PR the blocked branch already has', async () => {
    const { exec } = fakeExec({ ...HAPPY, [GATE_LINE]: failed(BLOCK_TEXT) });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'gate-blocked',
      pr: 42,
      url: 'https://github.com/o/r/pull/42',
    });
  });

  it('reports a gate that gave up on the lock as lock-timeout', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      [GATE_LINE]: failed(`${LOCK_TIMEOUT_MARKER} after 10800s`, 75),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('lock-timeout');
    expect(status.tail).toContain(LOCK_TIMEOUT_MARKER);
    expect(indexOf(calls, 'git push')).toBe(-1);
  });

  it('never reads a killed gate as a pass, though it reports exit 0', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      [GATE_LINE]: { stdout: '', stderr: '', code: 0, signal: 'SIGTERM' },
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail).toContain('SIGTERM');
    expect(status.tail).toContain('Nothing was pushed');
    expect(indexOf(calls, 'git push')).toBe(-1);
  });

  it('reports a gate that could not be started as an error', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      [GATE_LINE]: {
        stdout: '',
        stderr: 'spawn node ENOENT',
        code: 1,
        spawnFailed: true,
      },
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail).toContain('could not be started');
    expect(status.tail).toContain('spawn node ENOENT');
    expect(indexOf(calls, 'git push')).toBe(-1);
  });

  it('reports any other gate exit as an error', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      [GATE_LINE]: failed('unknown flag', 2),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail).toContain('exited 2');
    expect(status.tail).toContain('unknown flag');
    expect(indexOf(calls, 'git push')).toBe(-1);
  });
});

describe('ship: no push connection open while the gate waits (#204)', () => {
  const CACHED =
    'guardrails: push gate skipped — this exact tree already passed it ' +
    'against the same base (cached: true).\n';
  const DROPPED =
    'Connection to git.example.com closed by remote host.\n' +
    'fatal: the remote end hung up unexpectedly\n' +
    'error: failed to push some refs\n';
  const HOOK_BLOCK =
    'src/a.ts:3 [no-console] Unexpected console statement. (eslint)\n' +
    "guardrails: push blocked — resolve violations or run 'guardrails verify'.\n";

  it('gates, then pushes into the hook’s cached verdict, and ends green', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'git push': { stdout: '', stderr: CACHED, code: 0 },
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('green');
    expect(indexOf(calls, GATE_LINE)).toBeLessThan(indexOf(calls, 'git push'));
    expect(pushesIn(calls)).toEqual(['git push -u origin HEAD']);
  });

  it('reports a blocked gate as gate-blocked, with no push to drop', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      [GATE_LINE]: failed(HOOK_BLOCK),
      'git push': failed(DROPPED, 128),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('gate-blocked');
    expect(status.failing).toEqual(['src/a.ts:3 no-console']);
    expect(pushesIn(calls)).toEqual([]);
  });

  it('reports gate-blocked when the hook re-gated, blocked and the connection dropped', async () => {
    // ship's pass record missed (the tree changed mid-ship): the hook's own
    // gate ran in full, blocked, and the remote closed the idle connection.
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed(`${HOOK_BLOCK}${DROPPED}`),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('gate-blocked');
    expect(status.failing).toEqual(['src/a.ts:3 no-console']);
    expect(status.tail).not.toContain('the push gate passed');
  });

  it('reports a dropped connection after a green gate as an error that says so', async () => {
    const { exec } = fakeExec({ ...HAPPY, 'git push': failed(DROPPED, 128) });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail).toContain('closed by remote host');
    expect(status.tail).toContain(
      'guardrails ship: the push gate passed, but the connection to the ' +
        'remote dropped during the push',
    );
    expect(status.tail).toContain('the pass is remembered');
  });

  it.each([
    'Connection closed by 192.0.2.1 port 22',
    'Connection to git.example.com closed by 192.0.2.1 port 22',
    'Connection reset by peer',
    'ssh: connect to host git.example.com port 22: Connection timed out',
    'fatal: the remote end hung up unexpectedly',
    'client_loop: send disconnect: Broken pipe',
  ])('names the connection for %s', async (line) => {
    const { exec } = fakeExec({ ...HAPPY, 'git push': failed(line, 128) });
    const status = await ship(options(exec));
    expect(status.tail).toContain('the push gate passed');
  });

  it('adds no connection hint to a push refused for another reason', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed('remote: Permission to o/r.git denied.', 128),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail).not.toContain('the push gate passed');
  });
});

describe('ship: HEAD does not move while the gate runs (#204)', () => {
  it('pushes nothing when HEAD moved under the gate', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'git rev-parse HEAD': [ok('abc123\n'), ok('def456\n')],
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({ state: 'error', pr: 42 });
    expect(status.tail).toContain('HEAD moved from abc123 to def456');
    expect(status.tail).toContain('Nothing was pushed');
    expect(indexOf(calls, GATE_LINE)).toBeLessThan(
      calls.findLastIndex((call) => call.line === 'git rev-parse HEAD'),
    );
    expect(pushesIn(calls)).toEqual([]);
  });

  it('pushes nothing when HEAD cannot be read after the gate', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'git rev-parse HEAD': [ok('abc123\n'), failed('fatal: bad object', 128)],
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail).toContain('fatal: bad object');
    expect(pushesIn(calls)).toEqual([]);
  });
});

describe('ship: a working tree that is not HEAD (#204)', () => {
  it('warns when the tree has changes HEAD does not, and still ships', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'git status --porcelain': ok(' M src/a.ts\n?? notes.txt\n'),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('green');
    expect(status.warnings).toEqual([
      'the working tree has 2 uncommitted or untracked path(s): the push ' +
        'gate checked the working tree, but only HEAD was pushed',
    ]);
    expect(indexOf(calls, 'git status --porcelain')).toBeLessThan(
      indexOf(calls, GATE_LINE),
    );
  });

  it('warns when git cannot say whether the tree is clean', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git status --porcelain': failed('fatal: index file corrupt', 128),
    });
    const status = await ship(options(exec));
    expect(status.warnings).toEqual([
      'could not tell whether the working tree matches HEAD, which is what ' +
        'was pushed after the gate checked the working tree',
    ]);
  });

  it('warns about a killed git status rather than calling the tree clean', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git status --porcelain': {
        stdout: '',
        stderr: '',
        code: 0,
        signal: 'SIGTERM',
      },
    });
    const status = await ship(options(exec));
    expect(status.warnings).toHaveLength(1);
    expect(status.warnings[0]).toContain('could not tell');
  });

  it('warns nothing about a clean tree', async () => {
    const { exec } = fakeExec(HAPPY);
    const status = await ship(options(exec));
    expect(status.warnings).toEqual([]);
  });
});

describe('gateFailures (#204)', () => {
  it('names each violation by file, line and rule', () => {
    expect(
      gateFailures(
        'src/a.ts:3 [no-console] Unexpected console. (eslint)\n' +
          'src/b.ts:? [ts/2322] Type mismatch (tsc)\n',
      ),
    ).toEqual(['src/a.ts:3 no-console', 'src/b.ts:? ts/2322']);
  });

  it('names each added suppression by file, line and kind', () => {
    expect(
      gateFailures('test/a.test.ts:12 added skipped-test: it.skip(\n'),
    ).toEqual(['test/a.test.ts:12 added skipped-test']);
  });

  it('reads a line number of several digits', () => {
    expect(
      gateFailures(
        'src/a.ts:123 [no-console] Unexpected console. (eslint)\n' +
          'test/a.test.ts:456 added skipped-test: it.skip(\n',
      ),
    ).toEqual([
      'src/a.ts:123 no-console',
      'test/a.test.ts:456 added skipped-test',
    ]);
  });

  it('ignores an added-suppression line that does not start at the line start', () => {
    expect(
      gateFailures('note test/a.test.ts:12 added skipped-test: it.skip(\n'),
    ).toEqual([]);
  });

  it('reads a violation whose message is cut off', () => {
    expect(gateFailures('src/a.ts:1 [no-console]')).toEqual([
      'src/a.ts:1 no-console',
    ]);
  });

  it('ignores every other line', () => {
    expect(
      gateFailures(
        'guardrails: 1 violation(s), 0 added suppression(s).\n' +
          '  src/a.ts:3 [indented] not at the start\n' +
          'error: failed to push some refs to origin\n' +
          'see https://example.com:443 [docs]\n',
      ),
    ).toEqual([]);
  });
});

describe('ship: the happy path', () => {
  it('pushes, finds the PR, watches its checks and reports green', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'green',
      branch: 'feat/x',
      pr: 42,
      url: 'https://github.com/o/r/pull/42',
      failing: [],
      finishedAt: '2026-10-12T12:00:00.000Z',
    });
    const lines = calls.map((call) => call.line);
    expect(lines).toContain('git push -u origin HEAD');
    expect(lines).toContain('gh pr checks 42 --watch --fail-fast');
    expect(lines.some((line) => line.startsWith('gh pr create'))).toBe(false);
    expect(calls.every((call) => call.cwd === root)).toBe(true);
  });

  it('runs the steps in order: push, then the PR, then its checks', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    await ship(options(exec));
    const index = (prefix: string) =>
      calls.findIndex((call) => call.line.startsWith(prefix));
    expect(index('git push')).toBeLessThan(index('gh pr view'));
    expect(index('gh pr view')).toBeLessThan(index('gh pr checks 42 --watch'));
    expect(index('gh pr checks 42 --watch')).toBeLessThan(
      index('gh pr checks 42 --json'),
    );
  });

  it('keeps the tail of the watch output', async () => {
    const watch = Array.from({ length: 60 }, (_, line) => `line ${line}`);
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': ok(`${watch.join('\n')}\n`),
    });
    const status = await ship(options(exec));
    const tail = status.tail.split('\n');
    expect(tail).toHaveLength(40);
    expect(tail[0]).toBe('line 20');
    expect(tail.at(-1)).toBe('line 59');
  });
});

describe('ship: finding or creating the pull request', () => {
  it('creates one with --fill when none exists', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr view': [failed('no pull requests found'), ok(PR_JSON)],
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('green');
    expect(calls.map((call) => call.line)).toContain(
      'gh pr create --base main --fill',
    );
  });

  it('creates one from a body file, titled by the last commit', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr view': [failed('no pull requests found'), ok(PR_JSON)],
      'git log -1 --format=%s': ok('feat: the thing\n'),
    });
    const body = path.join(root, 'pr.md');
    writeFileSync(body, 'the body\n');
    await ship(options(exec, { bodyFile: body }));
    expect(calls.map((call) => call.line)).toContain(
      `gh pr create --base main --title feat: the thing --body-file ${body}`,
    );
    expect(calls.every((call) => call.cwd === root)).toBe(true);
  });

  it('is an error when the pull request cannot be created', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('no pull requests found'),
      'gh pr create': {
        stdout: '\n',
        stderr: 'GraphQL: something broke',
        code: 1,
      },
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({ state: 'error', pr: null, url: null });
    expect(status.tail).toBe('GraphQL: something broke');
  });

  it('is an error when the pull request cannot be read back', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': [failed('none'), ok('not json')],
    });
    expect(await stateOf(exec)).toBe('error');
  });

  it.each([
    ['a number that is not a number', { number: '42', url: 'u' }],
    ['a url that is not a string', { number: 42, url: 7 }],
    ['null', null],
  ])('rejects a pull request view with %s', async (_label, view) => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': [ok(JSON.stringify(view)), failed('x')],
      'gh pr create': failed('already exists'),
    });
    expect(await stateOf(exec)).toBe('error');
  });
});

/**
A branch with no PR yet, which gh opens; fresh per test because fakeExec consumes the list.
*/
function newPr(): Record<string, ExecResult | ExecResult[]> {
  return {
    ...HAPPY,
    'gh pr view': [failed('no pull requests found'), ok(PR_JSON)],
  };
}

/**
 * What ship opens a new pull request with, given `over` and a body file
 * holding `body` (none when `body` is undefined). The commit log answers
 * `subject`, and the branch is `branch`.
 */
async function openedWith(
  over: Partial<ShipOptions>,
  {
    body,
    subject = 'docs(designs): records the answers',
    branch = 'fix/w13-sec',
  }: { body?: string; subject?: string; branch?: string } = {},
): Promise<{
  create: string | undefined;
  status: ShipStatus;
  logged: boolean;
}> {
  const { exec, calls } = fakeExec({
    ...newPr(),
    'git rev-parse --abbrev-ref HEAD': ok(`${branch}\n`),
    'git ls-remote': ok(`abc123\trefs/heads/${branch}\n`),
    'git log -1 --format=%s': ok(`${subject}\n`),
  });
  const bodyFile = path.join(root, 'pr.md');
  if (body !== undefined) {
    writeFileSync(bodyFile, body);
  }
  const status = await ship(
    options(exec, body === undefined ? over : { bodyFile, ...over }),
  );
  const lines = calls.map((call) => call.line);
  return {
    create: lines.find((line) => line.startsWith('gh pr create')),
    status,
    logged: lines.includes('git log -1 --format=%s'),
  };
}

describe('ship: the title a new pull request opens with (#175)', () => {
  it('uses --title as given, without reading the commit log', async () => {
    const body = path.join(root, 'pr.md');
    const opened = await openedWith(
      { title: 'fix(ship): the real change' },
      { body: 'the body\n' },
    );
    expect(opened.create).toBe(
      `gh pr create --base main --title fix(ship): the real change --body-file ${body}`,
    );
    expect(opened.logged).toBe(false);
    expect(opened.status.warnings).toEqual([]);
  });

  it('uses --title without a body file, letting gh fill only the body', async () => {
    const opened = await openedWith({ title: 'fix: it' });
    expect(opened.create).toBe(
      'gh pr create --base main --title fix: it --fill',
    );
    expect(opened.logged).toBe(false);
  });

  it.each(['', '  '])(
    'treats a blank --title (%j) as none given',
    async (title) => {
      const opened = await openedWith({ title });
      expect(opened.create).toBe('gh pr create --base main --fill');
    },
  );

  it('takes the title from a leading "# " line, and strips it from the body', async () => {
    const opened = await openedWith(
      {},
      { body: '# fix(ship): the real change \n\n\nthe body\n\n## Why\n' },
    );
    expect(opened.create).toBe(
      'gh pr create --base main --title fix(ship): the real change ' +
        '--body the body\n\n## Why\n',
    );
    expect(opened.logged).toBe(false);
    expect(opened.status.warnings).toEqual([]);
  });

  it.each([
    ['spaces around it', '#   spaced out  \nb\n', 'spaced out'],
    ['one character', '# x\nb\n', 'x'],
  ])('takes a title with %s', async (_label, body, title) => {
    const opened = await openedWith({}, { body });
    expect(opened.create).toBe(
      `gh pr create --base main --title ${title} --body b\n`,
    );
  });

  it.each([
    ['only blank lines', '# t\n\n  ', ''],
    ['an indented first line', '# t\n\n    code\nmore', '    code\nmore'],
  ])('keeps a body of %s as written', async (_label, body, kept) => {
    const opened = await openedWith({}, { body });
    expect(opened.create).toBe(
      `gh pr create --base main --title t --body ${kept}`,
    );
  });

  it('finds the title line past leading blank lines, and leaves an empty body', async () => {
    const opened = await openedWith({}, { body: '\n  \n# fix: only a title' });
    expect(opened.create).toBe(
      'gh pr create --base main --title fix: only a title --body ',
    );
  });

  it.each([
    ['a second-level heading', '## Summary\n\nthe body\n'],
    ['a hash with no space', '#175 is fixed\n'],
    ['a heading with no text', '#   \nthe body\n'],
    ['a heading after the first text', 'the body\n# Not the title\n'],
  ])('does not take a title from %s', async (_label, body) => {
    const file = path.join(root, 'pr.md');
    const opened = await openedWith({}, { body, subject: 'fix: from git' });
    expect(opened.create).toBe(
      `gh pr create --base main --title fix: from git --body-file ${file}`,
    );
  });

  it('lets --title win over the title line, which is still stripped', async () => {
    const opened = await openedWith(
      { title: 'fix: the flag' },
      { body: '# fix: the line\nthe body\n' },
    );
    expect(opened.create).toBe(
      'gh pr create --base main --title fix: the flag --body the body\n',
    );
  });

  it('warns when the last commit titles a fix/ branch as docs', async () => {
    const opened = await openedWith({}, { body: 'the body\n' });
    expect(opened.status.warnings).toEqual([
      'PR #42 is titled by the last commit, "docs(designs): records the ' +
        'answers", whose type (docs) is not the branch\'s (fix): retitle it ' +
        'with gh pr edit 42 --title, and pass --title or start the body file ' +
        'with "# <title>" next time',
    ]);
  });

  it.each([
    ['fix/x', 'fix(ship): y'],
    ['feat/x', 'feat!: y'],
    ['feature/x', 'feat(a): y'],
    ['bugfix/x', 'fix: y'],
    ['hotfix/x', 'fix: y'],
    ['175-ship-title', 'docs: y'],
    ['drew/x', 'docs: y'],
    ['fix/x', 'Update the readme'],
    ['fix/x', 'docs y: not a type'],
    ['fix/x', 'a docs: y'],
    ['fix', 'docs: y'],
    ['a/fix/x', 'docs: y'],
    ['release.fix/x', 'docs: y'],
  ])(
    'does not warn for branch %s and last commit %j',
    async (branch, subject) => {
      const opened = await openedWith({}, { body: 'b\n', subject, branch });
      expect(opened.create).toContain(`--title ${subject} --body-file`);
      expect(opened.status.warnings).toEqual([]);
    },
  );

  it.each([
    ['feature/x', 'fix: y', 'feat', 'fix'],
    ['hotfix/x', 'test(ship): y', 'fix', 'test'],
    ['bugfix/x', 'docs: y', 'fix', 'docs'],
    ['docs/x', 'chore!: y', 'docs', 'chore'],
  ])(
    'warns for branch %s and last commit %j',
    async (branch, subject, wanted, found) => {
      const opened = await openedWith({}, { body: 'b\n', subject, branch });
      expect(opened.status.warnings).toHaveLength(1);
      expect(opened.status.warnings[0]).toContain(
        `whose type (${found}) is not the branch's (${wanted})`,
      );
    },
  );

  it.each([
    'feat',
    'fix',
    'docs',
    'test',
    'chore',
    'refactor',
    'perf',
    'build',
    'ci',
    'style',
    'revert',
  ])('compares a %s/ branch by its type', async (type) => {
    const other = type === 'docs' ? 'fix' : 'docs';
    const differs = await openedWith(
      {},
      { body: 'b\n', branch: `${type}/x`, subject: `${other}: y` },
    );
    expect(differs.status.warnings[0]).toContain(
      `whose type (${other}) is not the branch's (${type})`,
    );
    const agrees = await openedWith(
      {},
      { body: 'b\n', branch: `${other}/x`, subject: `${type}: y` },
    );
    expect(agrees.status.warnings[0]).toContain(
      `whose type (${type}) is not the branch's (${other})`,
    );
  });

  it('does not warn for a subject whose word is not a type', async () => {
    const opened = await openedWith({}, { body: 'b\n', subject: 'Note: y' });
    expect(opened.status.warnings).toEqual([]);
  });

  it('carries an attachment warning and the title warning together', async () => {
    const { exec } = fakeExec({
      ...newPr(),
      'git rev-parse --abbrev-ref HEAD': ok('fix/x\n'),
      'git ls-remote': ok('abc123\trefs/heads/fix/x\n'),
      'git log -1 --format=%s': ok('docs: y\n'),
      'gh pr create': failed('upload failed'),
    });
    const body = path.join(root, 'pr.md');
    writeFileSync(body, 'b\n');
    const status = await ship(
      options(exec, { bodyFile: body, attach: ['a.png'] }),
    );
    expect(status.warnings).toHaveLength(2);
    expect(status.warnings[0]).toBe('attachments not posted: upload failed');
    expect(status.warnings[1]).toContain('is titled by the last commit');
  });

  it('is an error, naming the file, when the body file is gone after the push', async () => {
    const body = path.join(root, 'pr.md');
    writeFileSync(body, '# fix: t\nb\n');
    const { exec: inner, calls } = fakeExec(newPr());
    const exec: Exec = (command, args, execOptions) => {
      if (args[0] === 'push') {
        rmSync(body);
      }
      return inner(command, args, execOptions);
    };
    const status = await ship(options(exec, { bodyFile: body }));
    expect(status).toMatchObject({ state: 'error', pr: null });
    expect(status.tail).toBe(
      `guardrails ship: --body-file ${body} could not be read after the ` +
        'push, so no pull request was opened. Restore it and ship again.',
    );
    expect(calls.some((call) => call.line.startsWith('gh pr create'))).toBe(
      false,
    );
  });

  it('changes nothing on a pull request that is already open', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const body = path.join(root, 'pr.md');
    writeFileSync(body, '# fix: new\nthe body\n');
    const status = await ship(options(exec, { bodyFile: body, title: 'x' }));
    const lines = calls.map((call) => call.line);
    expect(lines.some((line) => line.startsWith('gh pr create'))).toBe(false);
    expect(lines.some((line) => line.startsWith('gh pr edit'))).toBe(false);
    expect(status.warnings).toEqual([]);
  });
});

describe('ship: attaching media to the pull request', () => {
  const ATTACH = ['/r/demo.mp4', '/r/after.png#The fixed state'];

  it('opens a new PR with the attachments', async () => {
    const { exec, calls } = fakeExec(newPr());
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'green', warnings: [] });
    expect(calls.map((call) => call.line)).toContain(
      'gh pr create --base main --fill --attach /r/demo.mp4 --attach /r/after.png#The fixed state',
    );
    expect(calls.some((call) => call.line.startsWith('gh pr comment'))).toBe(
      false,
    );
  });

  it('comments them once on a PR that is already open, before watching', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'green', warnings: [] });
    const lines = calls.map((call) => call.line);
    const comments = lines.filter((line) => line.startsWith('gh pr comment'));
    expect(comments).toEqual([
      'gh pr comment 42 --attach /r/demo.mp4 --attach /r/after.png#The fixed state',
    ]);
    expect(lines.indexOf(comments[0] ?? '')).toBeLessThan(
      lines.findIndex((line) => line.startsWith('gh pr checks')),
    );
  });

  it('keeps the CI outcome and warns when the comment fails', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr comment': failed('uploading demo.mp4\nHTTP 413: too large'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status.state).toBe('green');
    expect(status.warnings).toEqual([
      'attachments not posted: HTTP 413: too large',
    ]);
  });

  it('carries on with the PR gh opened even when an upload failed', async () => {
    const { exec } = fakeExec({
      ...newPr(),
      'gh pr create': failed('created\nfailed to upload demo.mp4'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'green', pr: 42 });
    expect(status.warnings).toEqual([
      'attachments not posted: failed to upload demo.mp4',
    ]);
  });

  it('warns with the last line of gh output, not a blank or an earlier line', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr comment': failed('uploading\nretrying\nHTTP 500: boom\n'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status.warnings).toEqual(['attachments not posted: HTTP 500: boom']);
  });

  it('reports the read-back failure when gh opened the PR but it cannot be read', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('view broke'),
      'gh pr create': ok('https://github.com/o/r/pull/42'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'error', pr: null });
    expect(status.tail).toBe('view broke');
  });

  it('reports the create failure when an upload failed and the PR cannot be read', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('view broke'),
      'gh pr create': failed('upload exploded'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'error', pr: null });
    expect(status.tail).toBe('upload exploded');
  });

  it('carries no warnings when gh is unavailable or HEAD is not shippable', async () => {
    const unavailable = fakeExec({
      ...HAPPY,
      'gh auth status': failed('not logged in'),
    });
    const notShippable = fakeExec({
      ...HAPPY,
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
    });
    for (const { exec } of [unavailable, notShippable]) {
      const status = await ship(options(exec, { attach: ATTACH }));
      expect(status.state).toBe('error');
      expect(status.warnings).toEqual([]);
    }
  });

  it('is still an error when a PR without attachments cannot be opened', async () => {
    const { exec } = fakeExec({
      ...newPr(),
      'gh pr create': failed('GraphQL: something broke'),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({ state: 'error', pr: null, warnings: [] });
  });

  it('posts nothing and warns nothing without --attach', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const status = await ship(options(exec));
    expect(status.warnings).toEqual([]);
    expect(calls.some((call) => call.line.startsWith('gh pr comment'))).toBe(
      false,
    );
  });

  it('warns nothing on a push that failed before any PR step', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'git push': failed('fatal: no remote'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'error', warnings: [] });
    expect(calls.some((call) => call.line.startsWith('gh pr comment'))).toBe(
      false,
    );
  });
});

describe('ship: the branch', () => {
  it.each([
    ['a detached HEAD', ok('HEAD\n')],
    ['the base branch itself', ok('main\n')],
    ['no branch at all', failed('fatal: not a git repository', 128)],
  ])('refuses %s, before pushing anything', async (_label, answer) => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'git rev-parse --abbrev-ref HEAD': answer,
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(calls.some((call) => call.line.startsWith('git push'))).toBe(false);
  });
});

describe('ship: a push that did not go through', () => {
  const GATE_BLOCK = failed(
    'src/a.ts:1 [no-console]\nguardrails: push blocked — resolve violations or run guardrails verify.\nerror: failed to push some refs',
  );

  it('reports the gate block, with the hook output', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('no pull requests found'),
      'git push': GATE_BLOCK,
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'gate-blocked',
      pr: null,
      url: null,
      failing: ['src/a.ts:1 no-console'],
    });
    expect(status.tail).toContain('src/a.ts:1 [no-console]');
    // A blocked push only looks the pull request up: it never opens one.
    const lines = calls.map((call) => call.line);
    expect(lines.some((line) => line.startsWith('gh pr create'))).toBe(false);
    expect(lines.some((line) => line.startsWith('gh pr checks'))).toBe(false);
  });

  it('still names the PR the blocked branch already has', async () => {
    const { exec, calls } = fakeExec({ ...HAPPY, 'git push': GATE_BLOCK });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'gate-blocked',
      pr: 42,
      url: 'https://github.com/o/r/pull/42',
      failing: ['src/a.ts:1 no-console'],
    });
    expect(status.tail).toContain('src/a.ts:1 [no-console]');
    const view = calls.find((call) => call.line.startsWith('gh pr view'));
    expect(view?.line).toBe('gh pr view feat/x --json number,url');
    expect(view?.cwd).toBe(root);
    expect(calls.some((call) => call.line.startsWith('gh pr create'))).toBe(
      false,
    );
  });

  it('keeps the push state and tail when the PR lookup fails', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('HTTP 502: Bad Gateway'),
      'git push': failed(`${LOCK_TIMEOUT_MARKER} after 10800s`),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'lock-timeout',
      pr: null,
      url: null,
      tail: `${LOCK_TIMEOUT_MARKER} after 10800s`,
    });
  });

  it('ignores a lookup that printed something other than a PR', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': ok('not json'),
      'git push': GATE_BLOCK,
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'gate-blocked',
      pr: null,
      url: null,
    });
  });

  it('reports a lock timeout apart from a block', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed(`${LOCK_TIMEOUT_MARKER} after 10800s\nerror: failed`),
    });
    expect(await stateOf(exec)).toBe('lock-timeout');
  });

  it('reports any other failure as an error', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed('! [rejected] HEAD -> feat/x (non-fast-forward)'),
    });
    expect(await stateOf(exec)).toBe('error');
  });
});

/**
Ship `feat/x` as PR 42 over `HAPPY` plus `answers`, recording each wait.
*/
async function shipped(
  answers: Record<string, ExecResult | ExecResult[]>,
): Promise<{ status: ShipStatus; delays: number[]; calls: Call[] }> {
  const delays: number[] = [];
  const { exec, calls } = fakeExec({ ...HAPPY, ...answers });
  const status = await ship(
    options(exec, {
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    }),
  );
  return { status, delays, calls };
}

/**
The `git push` command lines among `calls`, in order.
*/
function pushesIn(calls: Call[]): string[] {
  return calls
    .map((call) => call.line)
    .filter((line) => line.startsWith('git push'));
}

describe('ship: a push that exited 0 without reaching the remote (#170)', () => {
  const HEAD_AT = { 'git rev-parse HEAD': ok('abc123\n') };
  const LANDED = ok('abc123\trefs/heads/feat/x\n');
  const KILLED: ExecResult = {
    stdout: '',
    stderr: 'Enumerating objects: 5, done.',
    code: 0,
    signal: 'SIGPIPE',
  };
  it('asks the remote where the branch is, in the repository it ships', async () => {
    const { calls } = await shipped({ ...HEAD_AT, 'git ls-remote': LANDED });
    expect(calls).toContainEqual({
      line: 'git ls-remote origin refs/heads/feat/x',
      cwd: root,
    });
  });

  it('stops before pushing when HEAD cannot be read', async () => {
    const { status, calls } = await shipped({
      'git rev-parse HEAD': failed('fatal: bad object HEAD', 128),
    });
    expect(status).toMatchObject({
      state: 'error',
      pr: null,
      warnings: [],
      tail:
        'guardrails ship: git rev-parse HEAD named no commit, so a push ' +
        'could not be confirmed. Nothing was pushed.\nfatal: bad object HEAD',
    });
    expect(pushesIn(calls)).toEqual([]);
  });

  it('stops before pushing when HEAD reads as nothing', async () => {
    const { status, calls } = await shipped({ 'git rev-parse HEAD': ok('\n') });
    expect(status.state).toBe('error');
    expect(pushesIn(calls)).toEqual([]);
  });

  it('does not take a branch that only ends in the same name for this one', async () => {
    // `git ls-remote` matches a pattern against the END of a ref.
    const { calls } = await shipped({
      'git ls-remote': [
        ok('abc123\trefs/heads/team/refs/heads/feat/x\n'),
        ok('abc123\trefs/heads/feat/x\n'),
      ],
    });
    expect(pushesIn(calls)).toHaveLength(2);
  });

  it('finds this branch after one that only ends in the same name', async () => {
    const { status, calls } = await shipped({
      'git ls-remote': ok(
        '0ld\trefs/heads/team/refs/heads/feat/x\nabc123\trefs/heads/feat/x\n',
      ),
    });
    expect(status.warnings).toEqual([]);
    expect(pushesIn(calls)).toHaveLength(1);
  });

  it('pushes once when the remote has the commit', async () => {
    const { status, calls } = await shipped({
      ...HEAD_AT,
      'git ls-remote': LANDED,
    });
    expect(status).toMatchObject({ state: 'green', warnings: [] });
    expect(pushesIn(calls)).toHaveLength(1);
  });

  it('pushes again when a killed push left the remote without the commit', async () => {
    // Seen three times after a cold push gate: git push ended by a signal,
    // which the exec seam reports as exit 0, and nothing on the remote.
    const { status, calls } = await shipped({
      ...HEAD_AT,
      'git push': [KILLED, ok('')],
      'git ls-remote': [ok(''), LANDED],
    });
    expect(status).toMatchObject({
      state: 'green',
      pr: 42,
      warnings: [
        'the first git push exited 0 without updating origin/feat/x ' +
          '(ended by SIGPIPE); pushed again',
      ],
    });
    expect(pushesIn(calls)).toEqual([
      'git push -u origin HEAD',
      'git push -u origin HEAD',
    ]);
  });

  it('pushes again when the remote still has the previous commit', async () => {
    const { status, calls } = await shipped({
      ...HEAD_AT,
      'git ls-remote': [ok('0ld\trefs/heads/feat/x\n'), LANDED],
    });
    expect(status.warnings).toEqual([
      'the first git push exited 0 without updating origin/feat/x ' +
        '(no signal reported); pushed again',
    ]);
    expect(pushesIn(calls)).toHaveLength(2);
  });

  it('keeps --force-with-lease on the second push', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      ...HEAD_AT,
      'git ls-remote': [ok(''), LANDED],
    });
    await ship(options(exec, { forceWithLease: true }));
    expect(pushesIn(calls)).toEqual([
      'git push --force-with-lease -u origin HEAD',
      'git push --force-with-lease -u origin HEAD',
    ]);
  });

  it('keeps the attachment warnings after the push warning', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      ...HEAD_AT,
      'git ls-remote': [ok(''), LANDED],
      'gh pr comment': failed('upload failed'),
    });
    const status = await ship(options(exec, { attach: ['a.png'] }));
    expect(status.warnings).toEqual([
      'the first git push exited 0 without updating origin/feat/x ' +
        '(no signal reported); pushed again',
      'attachments not posted: upload failed',
    ]);
  });

  it('is an error, not a look at stale checks, when the second push does not land either', async () => {
    const { status, calls } = await shipped({
      ...HEAD_AT,
      'git push': [KILLED, ok('Everything up-to-date')],
      'git ls-remote': ok('0ld\trefs/heads/feat/x\n'),
    });
    expect(status).toMatchObject({
      state: 'error',
      pr: null,
      failing: [],
      warnings: [],
      tail:
        'guardrails ship: git push exited 0 twice, but origin/feat/x is at ' +
        '0ld, not at abc123 (HEAD). Nothing was checked.\n' +
        'Enumerating objects: 5, done.\nEverything up-to-date',
    });
    expect(pushesIn(calls)).toHaveLength(2);
    expect(calls.some((call) => call.line.startsWith('gh pr'))).toBe(false);
  });

  it('says so when the remote has no such branch after both pushes', async () => {
    const { status } = await shipped({ ...HEAD_AT, 'git ls-remote': ok('') });
    expect(status.tail).toContain('origin/feat/x is at nothing, not at abc123');
  });

  it('classifies a second push the gate blocked as any blocked push', async () => {
    const { status } = await shipped({
      ...HEAD_AT,
      'git push': [
        KILLED,
        failed('guardrails: push blocked — resolve violations'),
      ],
      'git ls-remote': ok(''),
    });
    expect(status).toMatchObject({ state: 'gate-blocked', pr: 42 });
  });
});

describe('ship: a branch rewritten since its last push', () => {
  const HINT =
    'guardrails ship: the branch was rewritten since its last push ' +
    '(rebased?); re-run with --force-with-lease';

  it.each([
    '! [rejected]        HEAD -> feat/x (non-fast-forward)\nerror: failed to push some refs',
    '! [rejected]        HEAD -> feat/x (stale info)\nerror: failed to push some refs',
    '! [rejected]        HEAD -> feat/x (fetch first)\nerror: failed to push some refs',
  ])('names --force-with-lease as the fix for %j', async (stderr) => {
    const { exec } = fakeExec({ ...HAPPY, 'git push': failed(stderr) });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail.split('\n').at(-1)).toBe(HINT);
    expect(status.tail).toContain('[rejected]');
  });

  it('adds no hint to a push the gate blocked', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed(
        'guardrails: push blocked — resolve violations or run guardrails verify.',
      ),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('gate-blocked');
    expect(status.tail).not.toContain('--force-with-lease');
  });

  it('adds no hint to any other failed push', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed('fatal: unable to access remote'),
    });
    const status = await ship(options(exec));
    expect(status.tail).toBe('fatal: unable to access remote');
  });

  it('pushes plainly by default', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    await ship(options(exec));
    expect(calls.find((call) => call.line.startsWith('git push'))?.line).toBe(
      'git push -u origin HEAD',
    );
  });

  it('pushes --force-with-lease when asked', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const status = await ship(options(exec, { forceWithLease: true }));
    expect(status.state).toBe('green');
    expect(calls.find((call) => call.line.startsWith('git push'))?.line).toBe(
      'git push --force-with-lease -u origin HEAD',
    );
  });

  it('still refuses to ship the base branch with --force-with-lease', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
    });
    const status = await ship(options(exec, { forceWithLease: true }));
    expect(status.state).toBe('error');
    expect(calls.some((call) => call.line.startsWith('git push'))).toBe(false);
  });
});

describe('classifyPushFailure', () => {
  it('reads the marker on stdout too', () => {
    expect(
      classifyPushFailure({ stdout: LOCK_TIMEOUT_MARKER, stderr: '', code: 1 }),
    ).toBe('lock-timeout');
    expect(
      classifyPushFailure({
        stdout: 'guardrails: push blocked',
        stderr: '',
        code: 1,
      }),
    ).toBe('gate-blocked');
  });

  it('prefers the lock timeout, which also blocks the push', () => {
    expect(
      classifyPushFailure(
        failed(`${LOCK_TIMEOUT_MARKER}\nguardrails: push blocked`),
      ),
    ).toBe('lock-timeout');
  });

  it('reports an uninstalled checkout as an error, not a gate block', () => {
    expect(
      classifyPushFailure(
        failed(
          `guardrails: push blocked — ${NOT_INSTALLED_MARKER}. Run 'npm ci' here, then push again.`,
        ),
      ),
    ).toBe('error');
  });
});

describe('ship: CI', () => {
  it('reports red checks by name', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': failed('X build\nX e2e'),
      'gh pr checks 42 --json': ok(
        JSON.stringify([
          { name: 'build', bucket: 'fail' },
          { name: 'lint', bucket: 'pass' },
          { name: 'e2e', bucket: 'cancel' },
        ]),
      ),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'ci-red',
      failing: ['build', 'e2e'],
    });
    expect(status.tail).toContain('X e2e');
  });

  it('is an error when a check is still pending after the watch', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': ok(
        JSON.stringify([{ name: 'build', bucket: 'pending' }]),
      ),
    });
    expect(await stateOf(exec)).toBe('error');
  });

  it('watches again when checks register just after the watch gave up', async () => {
    // The race seen on dialed.run #191: the watch ran before CI registered
    // anything and exited with "no checks reported", then the listing a moment
    // later found every check pending. That watch never watched, so a pending
    // check there means "start watching", not "the watch broke".
    const delays: number[] = [];
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': [
        failed("no checks reported on the 'feat/x' branch"),
        ok('build\tpass'),
      ],
      'gh pr checks 42 --json': [
        ok(JSON.stringify([{ name: 'build', bucket: 'pending' }])),
        ok(JSON.stringify([{ name: 'build', bucket: 'pass' }])),
      ],
    });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status.state).toBe('green');
    expect(delays).toEqual([15_000]);
    expect(
      calls.filter(
        (call) => call.line === 'gh pr checks 42 --watch --fail-fast',
      ),
    ).toHaveLength(2);
  });

  it('does not wait again when the checks had already settled', async () => {
    const delays: number[] = [];
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': failed(
        "no checks reported on the 'feat/x' branch",
      ),
      'gh pr checks 42 --json': ok(
        JSON.stringify([{ name: 'build', bucket: 'pass' }]),
      ),
    });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status.state).toBe('green');
    expect(delays).toEqual([]);
  });

  it('gives up as an error when checks stay pending past the registration wait', async () => {
    const delays: number[] = [];
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': failed(
        "no checks reported on the 'feat/x' branch",
      ),
      'gh pr checks 42 --json': ok(
        JSON.stringify([{ name: 'build', bucket: 'pending' }]),
      ),
    });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status.state).toBe('error');
    expect(delays).toHaveLength(8);
  });

  it('is an error when the checks cannot be read', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': ok('not json'),
    });
    expect(await stateOf(exec)).toBe('error');
  });

  it('drops malformed check rows rather than trusting them', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': ok(
        JSON.stringify([
          { name: 'build', bucket: 'pass' },
          { name: 5, bucket: 'fail' },
          { name: 'x' },
          'junk',
          null,
        ]),
      ),
    });
    expect(await stateOf(exec)).toBe('green');
  });

  it('counts a row with no bucket as no check at all', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': ok('watched'),
      'gh pr checks 42 --json': ok(JSON.stringify([{ name: 'x' }])),
    });
    const status = await ship(options(exec));
    expect(status.tail).toBe('no checks reported');
  });

  it('waits for checks that have not registered yet', async () => {
    const delays: number[] = [];
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': [
        ok('[]'),
        ok('[]'),
        ok(JSON.stringify([{ name: 'build', bucket: 'fail' }])),
      ],
    });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status.state).toBe('ci-red');
    expect(delays).toEqual([15_000, 15_000]);
    expect(
      calls.filter(
        (call) => call.line === 'gh pr checks 42 --watch --fail-fast',
      ),
    ).toHaveLength(3);
  });

  it("waits through gh's own 'no checks reported' failure", async () => {
    // What `gh pr checks --json` actually does before CI registers: exit 1,
    // nothing on stdout, this sentence on stderr. Seen on the first real run
    // (guardrails PR #122), which gave up as `error` within seconds.
    const delays: number[] = [];
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': [
        failed("no checks reported on the 'feat/x' branch"),
        ok(JSON.stringify([{ name: 'build', bucket: 'pass' }])),
      ],
    });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status.state).toBe('green');
    expect(delays).toEqual([15_000]);
  });

  it('is still an error when gh fails for any other reason', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': failed('HTTP 502: Bad Gateway'),
    });
    expect(await stateOf(exec)).toBe('error');
  });

  it('is green with no checks once the registration wait runs out', async () => {
    const delays: number[] = [];
    const { exec } = fakeExec({ ...HAPPY, 'gh pr checks 42 --json': ok('[]') });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status).toMatchObject({ state: 'green', failing: [] });
    expect(delays).toHaveLength(8);
    expect(status.tail).toContain('no checks reported');
  });
});

// Each run is newer than the one before it, comes from a pull request, is on
// its first attempt, and is still running only while it has no conclusion,
// unless the row says otherwise.
const runs = (...rows: unknown[]): ExecResult =>
  ok(
    JSON.stringify(
      rows.map((row, index) =>
        isRecord(row)
          ? {
              databaseId: index + 1,
              event: 'pull_request',
              status: row.conclusion === '' ? 'in_progress' : 'completed',
              attempt: 1,
              ...row,
            }
          : row,
      ),
    ),
  );

describe('ship: workflow runs and required checks (#172)', () => {
  const RULES = 'gh api repos/{owner}/{repo}/rules/branches/main';
  const PROTECTION = 'gh api repos/{owner}/{repo}/branches/main';
  const SKIPPED_ONLY = ok(
    JSON.stringify([{ name: 'review', bucket: 'skipping' }]),
  );

  it('is ci-red when a workflow failed to start, though no check failed', async () => {
    // dialed.run #602: every workflow ended in startup_failure, which creates
    // no check runs, so the only checks were another workflow's skipped jobs.
    const { status } = await shipped({
      'gh pr checks 42 --watch': ok('review\tskipping'),
      'gh pr checks 42 --json': SKIPPED_ONLY,
      'gh run list': runs(
        { workflowName: 'CI', conclusion: 'startup_failure' },
        { workflowName: 'Dependabot PR', conclusion: 'skipped' },
        { workflowName: 'Mutation', conclusion: 'startup_failure' },
      ),
    });
    expect(status).toMatchObject({
      state: 'ci-red',
      pr: 42,
      failing: ['CI (startup_failure)', 'Mutation (startup_failure)'],
      tail: 'review\tskipping',
    });
  });

  it('lists the runs of the commit it pushed, in the repository it ships', async () => {
    const { calls } = await shipped({
      'git rev-parse HEAD': ok('abc123\n'),
      'git ls-remote': ok('abc123\trefs/heads/feat/x\n'),
    });
    // Once before the push gate and once after it, to see it did not move.
    expect(
      calls.filter((call) => call.line === 'git rev-parse HEAD'),
    ).toHaveLength(2);
    expect(calls).toContainEqual({
      line:
        'gh run list --commit abc123 --limit 100 ' +
        '--json workflowName,conclusion,event,databaseId,status,attempt',
      cwd: root,
    });
  });

  it.each(['failure', 'timed_out', 'cancelled'])(
    'counts a run that ended %s as red',
    async (conclusion) => {
      const { status } = await shipped({
        'gh run list': runs({ workflowName: 'CI', conclusion }),
      });
      expect(status.state).toBe('ci-red');
      expect(status.failing).toEqual([`CI (${conclusion})`]);
    },
  );

  it.each(['success', 'skipped', 'neutral', ''])(
    'does not count a run with conclusion "%s" as red',
    async (conclusion) => {
      const { status } = await shipped({
        'gh run list': runs({ workflowName: 'CI', conclusion }),
      });
      expect(status).toMatchObject({ state: 'green', failing: [] });
    },
  );

  it.each(['success', ''])(
    'does not count a cancelled run that a later "%s" run of its workflow replaced',
    async (conclusion) => {
      // `concurrency: cancel-in-progress` leaves the cancelled run on the
      // commit after the run that replaced it has passed.
      const { status } = await shipped({
        'gh run list': runs(
          { workflowName: 'CI', conclusion: 'cancelled' },
          { workflowName: 'CI', conclusion },
        ),
      });
      expect(status).toMatchObject({ state: 'green', failing: [] });
    },
  );

  it('counts a cancelled run that only another workflow outlived', async () => {
    const { status } = await shipped({
      'gh run list': runs(
        { workflowName: 'CI', conclusion: 'cancelled' },
        { workflowName: 'Docs', conclusion: 'success' },
      ),
    });
    expect(status.failing).toEqual(['CI (cancelled)']);
  });

  it('counts a cancelled run when every run of its workflow was cancelled', async () => {
    const { status } = await shipped({
      'gh run list': runs(
        { workflowName: 'CI', conclusion: 'cancelled' },
        { workflowName: 'CI', conclusion: 'cancelled' },
      ),
    });
    expect(status.failing).toEqual(['CI (cancelled)']);
  });

  it('judges a workflow by its latest run, not an older failure (#199)', async () => {
    // A relabel re-runs a label-triggered workflow on the same commit. gh
    // lists the newest run first.
    const { status } = await shipped({
      'gh run list': runs(
        { workflowName: 'Review', conclusion: '', databaseId: 9 },
        { workflowName: 'Review', conclusion: 'failure', databaseId: 7 },
      ),
    });
    expect(status).toMatchObject({ state: 'green', failing: [] });
  });

  it('counts a latest run that failed after an older one passed', async () => {
    const { status } = await shipped({
      'gh run list': runs(
        { workflowName: 'Review', conclusion: 'success', databaseId: 7 },
        { workflowName: 'Review', conclusion: 'failure', databaseId: 9 },
      ),
    });
    expect(status.failing).toEqual(['Review (failure)']);
  });

  it('judges the runs of each event apart', async () => {
    const { status } = await shipped({
      'gh run list': runs(
        { workflowName: 'CI', conclusion: 'failure', event: 'push' },
        { workflowName: 'CI', conclusion: 'success' },
      ),
    });
    expect(status.failing).toEqual(['CI (failure)']);
  });

  it('drops a run row without a numeric id', async () => {
    const { status } = await shipped({
      'gh run list': ok(
        JSON.stringify([
          { workflowName: 'CI', conclusion: 'failure', event: 'push' },
          {
            workflowName: 'CI',
            conclusion: 'failure',
            event: 'push',
            databaseId: '3',
          },
        ]),
      ),
    });
    expect(status).toMatchObject({ state: 'green', failing: [] });
  });

  it('names the failed run, not the cancelled one it replaced', async () => {
    const { status } = await shipped({
      'gh run list': runs(
        { workflowName: 'CI', conclusion: 'cancelled' },
        { workflowName: 'CI', conclusion: 'failure' },
      ),
    });
    expect(status.failing).toEqual(['CI (failure)']);
  });

  it('names failing checks before failing runs', async () => {
    const { status } = await shipped({
      'gh pr checks 42 --json': ok(
        JSON.stringify([{ name: 'build', bucket: 'fail' }]),
      ),
      'gh run list': runs({ workflowName: 'CI', conclusion: 'failure' }),
    });
    expect(status.failing).toEqual(['build', 'CI (failure)']);
  });

  it('does not wait for checks once a run has failed to start', async () => {
    const { status, delays } = await shipped({
      'gh pr checks 42 --json': ok('[]'),
      'gh run list': runs({
        workflowName: 'CI',
        conclusion: 'startup_failure',
      }),
    });
    expect(status.state).toBe('ci-red');
    expect(delays).toEqual([]);
  });

  it('drops a run row whose conclusion is not a string, rather than letting it hide a failure', async () => {
    const { status } = await shipped({
      'gh run list': runs(
        { workflowName: 'CI', conclusion: 5, databaseId: 9 },
        { workflowName: 'CI', conclusion: 'failure', databaseId: 7 },
      ),
    });
    expect(status.failing).toEqual(['CI (failure)']);
  });

  it('drops a run row with a string id, rather than letting it hide a failure', async () => {
    const { status } = await shipped({
      'gh run list': runs(
        { workflowName: 'CI', conclusion: '', databaseId: '9' },
        { workflowName: 'CI', conclusion: 'failure', databaseId: 7 },
      ),
    });
    expect(status.failing).toEqual(['CI (failure)']);
  });

  it.each<[string, Record<string, unknown>]>([
    ['whose status is not a string', { status: 3 }],
    ['whose attempt is not a number', { attempt: '2' }],
  ])(
    'drops a run row %s, rather than letting it hide a failure',
    async (_label, bad) => {
      const { status } = await shipped({
        'gh run list': runs(
          { workflowName: 'CI', conclusion: '', databaseId: 9, ...bad },
          { workflowName: 'CI', conclusion: 'failure', databaseId: 7 },
        ),
      });
      expect(status.failing).toEqual(['CI (failure)']);
    },
  );

  it('drops a run row whose event is not a string', async () => {
    const { status } = await shipped({
      'gh run list': runs({
        workflowName: 'CI',
        conclusion: 'failure',
        event: 5,
      }),
    });
    expect(status).toMatchObject({ state: 'green', failing: [] });
  });

  it('drops a malformed run row', async () => {
    const { status } = await shipped({
      'gh run list': runs(
        { workflowName: 5, conclusion: 'failure' },
        { workflowName: 'CI' },
        'junk',
        null,
      ),
    });
    expect(status).toMatchObject({ state: 'green', failing: [] });
  });

  it('is an error when the run listing cannot be read', async () => {
    const { status } = await shipped({
      'gh run list': failed('HTTP 502: Bad Gateway'),
    });
    expect(status).toMatchObject({
      state: 'error',
      pr: 42,
      failing: [],
      tail: 'HTTP 502: Bad Gateway',
    });
  });

  it('is ci-red when a required check never reported', async () => {
    const { status, delays, calls } = await shipped({
      'gh pr checks 42 --watch': ok('watched'),
      [RULES]: ok('build\nguardrails\n'),
    });
    expect(status).toMatchObject({
      state: 'ci-red',
      failing: ['guardrails (required, not reported)'],
      tail: 'watched',
    });
    expect(delays).toHaveLength(8);
    expect(calls.find((call) => call.line.startsWith(RULES))).toEqual({
      line:
        `${RULES} --paginate --jq ` +
        '.[] | select(.type == "required_status_checks") | ' +
        '.parameters.required_status_checks[].context',
      cwd: root,
    });
  });

  it('reads required checks from classic branch protection too', async () => {
    const { status, calls } = await shipped({
      [PROTECTION]: ok('e2e\n'),
    });
    expect(status).toMatchObject({
      state: 'ci-red',
      failing: ['e2e (required, not reported)'],
    });
    expect(calls.find((call) => call.line.startsWith(PROTECTION))).toEqual({
      line: `${PROTECTION} --paginate --jq .protection.required_status_checks.contexts[]?`,
      cwd: root,
    });
  });

  it('asks for the required checks of the base branch, once', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': [ok('[]'), ok('[]'), ok(HAPPY_CHECKS)],
    });
    await ship(options(exec, { baseBranch: 'develop' }));
    const asked = calls
      .filter((call) => call.line.startsWith('gh api'))
      .map((call) => call.line.split(' --paginate ', 1)[0]);
    expect(asked).toEqual([
      'gh api repos/{owner}/{repo}/rules/branches/develop',
      'gh api repos/{owner}/{repo}/branches/develop',
    ]);
  });

  it('is green when every required check reported, passed or skipped', async () => {
    const { status, delays } = await shipped({
      [RULES]: ok('build\n'),
      [PROTECTION]: ok('lint\n'),
    });
    expect(status).toMatchObject({ state: 'green', failing: [] });
    expect(delays).toEqual([]);
  });

  it('waits for a required check that registers late', async () => {
    const { status, delays } = await shipped({
      [RULES]: ok('guardrails\n'),
      'gh pr checks 42 --json': [
        ok(JSON.stringify([{ name: 'build', bucket: 'pass' }])),
        ok(
          JSON.stringify([
            { name: 'build', bucket: 'pass' },
            { name: 'guardrails', bucket: 'pass' },
          ]),
        ),
      ],
    });
    expect(status).toMatchObject({ state: 'green', failing: [] });
    expect(delays).toEqual([15_000]);
  });

  it('requires nothing when the required checks cannot be read', async () => {
    // A token without access to the rules, or a forge without them: ship
    // judges by the checks and runs it can see.
    const { status } = await shipped({
      [RULES]: { stdout: 'guardrails\n', stderr: 'HTTP 403', code: 1 },
      [PROTECTION]: { stdout: 'e2e\n', stderr: 'HTTP 404', code: 1 },
    });
    expect(status).toMatchObject({ state: 'green', failing: [] });
  });
});

describe('writeShipStatus and shipSummary', () => {
  it('names each warning on the same line', () => {
    const line = shipSummary(
      {
        state: 'green',
        branch: 'feat/x',
        pr: 42,
        url: 'u',
        failing: [],
        tail: '',
        finishedAt: '',
        warnings: ['attachments not posted: HTTP 413'],
        diagnosis: null,
      },
      's.json',
    );
    expect(line).toBe(
      'guardrails ship: green — feat/x, PR #42 u; warning: attachments not posted: HTTP 413 (status: s.json)',
    );
  });

  it('writes the status as JSON, creating the directory', () => {
    const file = path.join(root, 'deep', 'status.json');
    const status = {
      state: 'ci-red' as const,
      branch: 'feat/x',
      pr: 42,
      url: 'u',
      failing: ['build'],
      tail: 'X build',
      finishedAt: '2026-10-12T12:00:00.000Z',
      warnings: [],
      diagnosis: null,
    };
    writeShipStatus(file, status);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(status);
  });

  it('says the state, the PR and the failing checks on one line', () => {
    const line = shipSummary(
      {
        state: 'ci-red',
        branch: 'feat/x',
        pr: 42,
        url: 'https://github.com/o/r/pull/42',
        failing: ['build', 'e2e'],
        tail: '',
        finishedAt: '',
        warnings: [],
        diagnosis: null,
      },
      'status.json',
    );
    expect(line).toBe(
      'guardrails ship: ci-red — feat/x, PR #42 https://github.com/o/r/pull/42; failing: build, e2e (status: status.json)',
    );
    expect(line).not.toContain('\n');
  });

  it('says the next step after the failing checks, before the warnings', () => {
    const line = shipSummary(
      {
        state: 'ci-red',
        branch: 'feat/x',
        pr: 42,
        url: 'u',
        failing: ['build'],
        tail: '',
        finishedAt: '',
        warnings: ['w'],
        diagnosis: {
          base: 'moved',
          rerunnable: [7],
          advice: 'rebase',
          next: 'rebase onto origin/main, which moved after this commit was tested, and ship again',
        },
      },
      's.json',
    );
    expect(line).toBe(
      'guardrails ship: ci-red — feat/x, PR #42 u; failing: build; ' +
        'next: rebase onto origin/main, which moved after this commit was ' +
        'tested, and ship again; warning: w (status: s.json)',
    );
  });

  it('says plainly when there is no PR yet', () => {
    expect(
      shipSummary(
        {
          state: 'gate-blocked',
          branch: 'feat/x',
          pr: null,
          url: null,
          failing: [],
          tail: '',
          finishedAt: '',
          warnings: [],
          diagnosis: null,
        },
        's.json',
      ),
    ).toBe('guardrails ship: gate-blocked — feat/x, no PR (status: s.json)');
  });
});

describe('ship: the details a reader acts on', () => {
  it('keeps stdout and stderr of a failed push, one per line', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': { stdout: 'hook says', stderr: 'git says', code: 1 },
    });
    const status = await ship(options(exec));
    expect(status.tail).toBe('hook says\ngit says');
  });

  it('says which branch it would not ship', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
    });
    const status = await ship(options(exec));
    expect(status.tail).toContain('HEAD is main; base is main');
    expect(status.branch).toBe('main');
  });

  it('says unknown when git named no branch', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git rev-parse --abbrev-ref HEAD': failed('fatal: no repo', 128),
    });
    const status = await ship(options(exec));
    expect(status.tail).toContain('HEAD is unknown');
    expect(status.tail).toContain('fatal: no repo');
  });

  it('keeps the PR it found when the checks cannot be read', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': ok('not json'),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'error',
      pr: 42,
      url: 'https://github.com/o/r/pull/42',
      tail: 'not json',
      failing: [],
    });
  });

  it('is an error while any one check is still pending', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': ok(
        JSON.stringify([
          { name: 'build', bucket: 'pass' },
          { name: 'e2e', bucket: 'pending' },
        ]),
      ),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({ state: 'error', pr: 42 });
  });

  it('stamps the real time when none is injected', async () => {
    const { exec } = fakeExec(HAPPY);
    const before = Date.now();
    const status = await ship({
      exec,
      repoRoot: root,
      baseBranch: 'main',
      pushGate: PUSH_GATE,
    });
    const stamped = Date.parse(status.finishedAt);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it('really waits between looks when no delay is injected', async () => {
    vi.useFakeTimers();
    try {
      const { exec, calls } = fakeExec({
        ...HAPPY,
        'gh pr checks 42 --json': [
          ok('[]'),
          ok(JSON.stringify([{ name: 'build', bucket: 'pass' }])),
        ],
      });
      const shipped = ship({
        exec,
        repoRoot: root,
        baseBranch: 'main',
        pushGate: PUSH_GATE,
      });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(
        calls.filter(
          (call) => call.line === 'gh pr checks 42 --watch --fail-fast',
        ),
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await shipped;
      expect(result.state).toBe('green');
    } finally {
      vi.useRealTimers();
    }
  });
});

function hasPushed(calls: readonly Call[]): boolean {
  return calls.some((call) => call.line.startsWith('git push'));
}

describe('ship: a branch behind or conflicting with its base (#178)', () => {
  const NOT_CONTAINED = failed('', 1);
  const BEHIND: Record<string, ExecResult | ExecResult[]> = {
    ...HAPPY,
    'git merge-base --is-ancestor': NOT_CONTAINED,
    'git merge-tree': ok('4b825dc642cb6eb9a060e54bf8d69288fbee4904\n'),
  };

  it('refuses a branch that is behind, before pushing', async () => {
    const { exec, calls } = fakeExec(BEHIND);
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'behind',
      pr: null,
      url: null,
      failing: [],
      warnings: [],
    });
    expect(status.tail).toBe(
      'guardrails ship: feat/x does not contain origin/main. Rebase it onto ' +
        'origin/main (or merge origin/main into it), then ship again. ' +
        'Nothing was pushed.',
    );
    expect(hasPushed(calls)).toBe(false);
  });

  it('refuses a branch that conflicts, naming the conflicted files', async () => {
    // merge-tree prints on stdout even when it exits 1.
    const { exec, calls } = fakeExec({
      ...BEHIND,
      'git merge-tree': {
        stdout:
          '4b825dc642cb6eb9a060e54bf8d69288fbee4904\nsrc/a.ts\ndocs/b.md\n',
        stderr: '',
        code: 1,
      },
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'conflicting',
      failing: ['src/a.ts', 'docs/b.md'],
    });
    expect(status.tail).toBe(
      'guardrails ship: feat/x conflicts with origin/main in 2 file(s). ' +
        'Rebase it onto origin/main and resolve them, then ship again. ' +
        'Nothing was pushed.',
    );
    expect(hasPushed(calls)).toBe(false);
  });

  it.each<[string, ExecResult]>([
    ['cannot answer', failed('usage: git merge-tree', 129)],
    ['exits 1 naming no file', failed('', 1)],
    ['merges cleanly, whatever else it printed', ok('4b825dc\nsrc/a.ts\n')],
  ])(
    'is behind, not conflicting, when merge-tree %s',
    async (_label, answer) => {
      const { exec } = fakeExec({ ...BEHIND, 'git merge-tree': answer });
      expect(await ship(options(exec))).toMatchObject({
        state: 'behind',
        failing: [],
      });
    },
  );

  it('fetches the base, then asks, all before pushing and in the repository it ships', async () => {
    const { exec, calls } = fakeExec(BEHIND);
    await ship(options(exec, { baseBranch: 'develop' }));
    const lines = calls.map((call) => call.line);
    const fetch = lines.indexOf('git fetch --quiet origin develop');
    const asked = lines.indexOf(
      'git merge-base --is-ancestor origin/develop HEAD',
    );
    const merged = lines.indexOf(
      'git merge-tree --write-tree --name-only --no-messages HEAD origin/develop',
    );
    expect(fetch).toBeGreaterThan(-1);
    expect(asked).toBeGreaterThan(fetch);
    expect(merged).toBeGreaterThan(asked);
    for (const index of [fetch, asked, merged]) {
      expect(calls[index]?.cwd).toBe(root);
    }
  });

  it('asks after gh and the body file are checked', async () => {
    const { exec, calls } = fakeExec({
      ...BEHIND,
      'gh auth status': failed('You are not logged into any GitHub hosts.'),
    });
    await ship(options(exec));
    expect(calls.some((call) => call.line.startsWith('git fetch'))).toBe(false);
  });

  it('ships as before when the branch contains the base, without merge-tree', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const status = await ship(options(exec));
    expect(status.state).toBe('green');
    expect(status.warnings).toEqual([]);
    expect(calls.some((call) => call.line.startsWith('git merge-tree'))).toBe(
      false,
    );
  });

  it('ships with a warning when the base cannot be fetched', async () => {
    const { exec, calls } = fakeExec({
      ...BEHIND,
      'git fetch': failed('fatal: unable to access', 128),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('green');
    expect(status.warnings).toEqual([
      'could not fetch origin/main, so whether feat/x is behind it was not checked',
    ]);
    expect(calls.some((call) => call.line.startsWith('git merge-base'))).toBe(
      false,
    );
    expect(hasPushed(calls)).toBe(true);
  });

  it.each<[string, ExecResult]>([
    ['exits with an error', failed('fatal: Not a valid object name', 128)],
    ['is killed', { stdout: '', stderr: '', code: 0, signal: 'SIGTERM' }],
  ])(
    'ships with a warning when the ancestry check %s',
    async (_label, answer) => {
      const { exec, calls } = fakeExec({
        ...BEHIND,
        'git merge-base --is-ancestor': answer,
      });
      const status = await ship(options(exec));
      expect(status.state).toBe('green');
      expect(status.warnings).toEqual([
        'could not tell whether feat/x contains origin/main, so it was not checked',
      ]);
      expect(hasPushed(calls)).toBe(true);
    },
  );

  it('ships with a warning when the fetch is killed', async () => {
    const { exec } = fakeExec({
      ...BEHIND,
      'git fetch': { stdout: '', stderr: '', code: 0, signal: 'SIGTERM' },
    });
    const status = await ship(options(exec));
    expect(status.warnings).toEqual([
      'could not fetch origin/main, so whether feat/x is behind it was not checked',
    ]);
  });

  it('keeps the fetch warning ahead of the push and attachment warnings', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git fetch': failed('offline', 128),
      'gh pr comment': failed('upload failed'),
    });
    const status = await ship(
      options(exec, { attach: [path.join(root, 'demo.png')] }),
    );
    expect(status.warnings[0]).toBe(
      'could not fetch origin/main, so whether feat/x is behind it was not checked',
    );
    expect(status.warnings).toHaveLength(2);
  });
});

describe('ship: the first failed check ends the wait (#178)', () => {
  it('watches with --fail-fast', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    await ship(options(exec));
    expect(calls.map((call) => call.line)).toContain(
      'gh pr checks 42 --watch --fail-fast',
    );
  });

  it('is ci-red on a failed check while others are still running', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': failed('X build'),
      'gh pr checks 42 --json': ok(
        JSON.stringify([
          { name: 'build', bucket: 'fail' },
          { name: 'mutation (shard 3)', bucket: 'pending' },
        ]),
      ),
    });
    expect(await ship(options(exec))).toMatchObject({
      state: 'ci-red',
      failing: ['build'],
    });
  });

  it('watches without --fail-fast when gh does not know it', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch --fail-fast': failed(
        'unknown flag: --fail-fast\n\nUsage:  gh pr checks',
      ),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('green');
    const watches = calls
      .map((call) => call.line)
      .filter((line) => line.startsWith('gh pr checks 42 --watch'));
    expect(watches).toEqual([
      'gh pr checks 42 --watch --fail-fast',
      'gh pr checks 42 --watch',
    ]);
  });
});

describe('classifyPushFailure: the hook’s own line decides (#178)', () => {
  it('is a gate block when the uninstalled text appears only in earlier output', () => {
    expect(
      classifyPushFailure(
        failed(
          // As a test of the hook itself prints it, ahead of the real verdict.
          `guardrails: push blocked — ${NOT_INSTALLED_MARKER}\n` +
            'src/a.ts:1 [stryker/survived]\n' +
            "guardrails: push blocked — resolve violations or run 'guardrails verify'.",
        ),
      ),
    ).toBe('gate-blocked');
  });

  it('is an error when the last push-blocked line says the checkout is not installed', () => {
    expect(
      classifyPushFailure(
        failed(
          `guardrails: push blocked — ${NOT_INSTALLED_MARKER}. Run 'npm ci' here, then push again.\n` +
            'error: failed to push some refs',
        ),
      ),
    ).toBe('error');
  });

  it('is an error, not a gate block, with no push-blocked line at all', () => {
    expect(classifyPushFailure(failed(NOT_INSTALLED_MARKER))).toBe('error');
  });
});

/**
A clock that moves one second on every look.
*/
function steppingClock() {
  let at = Date.parse('2026-11-19T10:00:00.000Z');
  return {
    now: () => {
      at += 1000;
      return new Date(at);
    },
    sample: () => ({ load1: 4, freeMb: 3000 }),
    cores: () => 8,
  };
}

function logFile(): string {
  return path.join(root, 'gate.lock.runs.jsonl');
}

describe('ship: its row in the run log (#176)', () => {
  it('hands its id to the push, for the gate’s row to carry', async () => {
    const pushes: (string | undefined)[] = [];
    const { exec: base } = fakeExec(HAPPY);
    const exec: Exec = (command, args, execOptions) => {
      if (command === 'git' && args[0] === 'push') {
        pushes.push(execOptions?.env?.GUARDRAILS_SHIP_ID);
      }
      return base(command, args, execOptions);
    };
    await ship(options(exec, { shipId: 'ship-42' }));
    expect(pushes).toEqual(['ship-42']);
  });

  it('makes up an id when given none', async () => {
    const pushes: (string | undefined)[] = [];
    const { exec: base } = fakeExec(HAPPY);
    const exec: Exec = (command, args, execOptions) => {
      if (args[0] === 'push') {
        pushes.push(execOptions?.env?.GUARDRAILS_SHIP_ID);
      }
      return base(command, args, execOptions);
    };
    await ship(options(exec));
    expect(pushes[0]).toMatch(/^[\da-f-]{36}$/);
  });

  it('appends a row with its push, gate and CI times', async () => {
    writeFileSync(
      logFile(),
      `${JSON.stringify({
        v: 1,
        kind: 'gate',
        rung: 'push',
        repo: 'r',
        ship: 'ship-42',
        startedAt: '2026-11-19T10:00:00.000Z',
        finishedAt: '2026-11-19T10:00:30.000Z',
        outcome: 'pass',
      })}\n`,
    );
    const { exec } = fakeExec(HAPPY);
    const status = await ship(
      options(exec, {
        shipId: 'ship-42',
        lockPath: path.join(root, 'gate.lock'),
        runClock: steppingClock(),
      }),
    );
    const rows = parseRuns(readFileSync(logFile(), 'utf8'));
    expect(rows.at(-1)).toEqual({
      v: 1,
      kind: 'ship',
      repo: path.basename(root),
      branch: 'feat/x',
      ship: 'ship-42',
      startedAt: '2026-11-19T10:00:01.000Z',
      finishedAt: '2026-11-19T10:00:06.000Z',
      pr: 42,
      state: status.state,
      pushMs: 1000,
      gateMs: 30_000,
      ciMs: 1000,
      machine: {
        cores: 8,
        concurrency: 'default',
        start: { load1: 4, freeMb: 3000 },
        end: { load1: 4, freeMb: 3000 },
      },
    });
  });

  it('times the push from the start of its gate to the end of the push (#204)', async () => {
    const clock = steppingClock();
    const now = clock.now;
    let skipped = 0;
    const steppedClock = {
      ...clock,
      now: () => new Date(now().getTime() + skipped),
    };
    const { exec: base } = fakeExec(HAPPY);
    const exec: Exec = (command, args, execOptions) => {
      if (command === PUSH_GATE.command) {
        // The gate's wait for the lock and its run: thirty seconds.
        skipped += 30_000;
      }
      return base(command, args, execOptions);
    };
    await ship(
      options(exec, {
        lockPath: path.join(root, 'gate.lock'),
        runClock: steppedClock,
      }),
    );
    const [row] = parseRuns(readFileSync(logFile(), 'utf8'));
    expect(row).toMatchObject({ kind: 'ship', pushMs: 31_000 });
  });

  it('hands its id to its own gate, for that gate’s row to carry (#204)', async () => {
    const gates: (string | undefined)[] = [];
    const { exec: base } = fakeExec(HAPPY);
    const exec: Exec = (command, args, execOptions) => {
      if (command === PUSH_GATE.command) {
        gates.push(execOptions?.env?.GUARDRAILS_SHIP_ID);
      }
      return base(command, args, execOptions);
    };
    await ship(options(exec, { shipId: 'ship-42' }));
    expect(gates).toEqual(['ship-42']);
  });

  it('records a blocked push with no CI time and no gate it can find', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('no pull requests found'),
      'git push': failed(
        "guardrails: push blocked — resolve violations or run 'guardrails verify'.",
      ),
    });
    await ship(
      options(exec, {
        lockPath: path.join(root, 'gate.lock'),
        runClock: steppingClock(),
      }),
    );
    const [row] = parseRuns(readFileSync(logFile(), 'utf8'));
    expect(row).toMatchObject({
      kind: 'ship',
      state: 'gate-blocked',
      pr: null,
    });
    expect(row).not.toHaveProperty('ciMs');
    expect(row).not.toHaveProperty('gateMs');
  });

  it('records a ship that never pushed, with no push time', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh auth status': failed('You are not logged into any GitHub hosts.'),
    });
    await ship(options(exec, { lockPath: path.join(root, 'gate.lock') }));
    const [row] = parseRuns(readFileSync(logFile(), 'utf8'));
    expect(row).toMatchObject({ kind: 'ship', state: 'error', pushMs: 0 });
  });

  it('writes no row without a lock to sit beside', async () => {
    const { exec } = fakeExec(HAPPY);
    await ship(options(exec));
    expect(existsSync(logFile())).toBe(false);
  });

  it('says on stderr when its row cannot be written', async () => {
    // A directory where the run log should be: nobody can append to that,
    // root included, which a read-only directory does not stop.
    mkdirSync(path.join(root, 'gate.lock.runs.jsonl'));
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    try {
      const { exec } = fakeExec(HAPPY);
      await ship(options(exec, { lockPath: path.join(root, 'gate.lock') }));
    } finally {
      spy.mockRestore();
    }
    expect(written).toEqual([
      expect.stringMatching(
        /^guardrails: could not write the run log \(.+\)\.\n$/,
      ),
    ]);
  });
});

/**
The `git fetch` command lines among `calls`.
*/
function fetchesIn(calls: readonly Call[]): string[] {
  return calls
    .map((call) => call.line)
    .filter((line) => line.startsWith('git fetch'));
}

const FAILED_BUILD = ok(
  JSON.stringify([{ name: 'build', bucket: 'fail', workflow: 'CI' }]),
);

/**
 * `origin/<base>` is in HEAD before the push, and no longer in it after CI. A
 * fresh list each time: fakeExec uses the answers up.
 */
function baseMoved(): ExecResult[] {
  return [ok(''), failed('', 1)];
}

describe('ship: what to do about ci-red (#198)', () => {
  it('says rebase when the base moved while CI ran, and stays ci-red', async () => {
    const { status } = await shipped({
      'gh pr checks 42 --json': FAILED_BUILD,
      'gh run list': runs({ workflowName: 'CI', conclusion: 'failure' }),
      'git merge-base --is-ancestor': baseMoved(),
    });
    expect(status.state).toBe('ci-red');
    expect(status.diagnosis).toEqual({
      base: 'moved',
      rerunnable: [1],
      advice: 'rebase',
      next:
        'rebase onto origin/main, which moved after this commit was ' +
        'tested, and ship again',
    });
    expect(status.warnings).toEqual([]);
  });

  it('names the base the config gives, not main', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': FAILED_BUILD,
      'git merge-base --is-ancestor': baseMoved(),
    });
    const status = await ship(options(exec, { baseBranch: 'trunk' }));
    expect(status.diagnosis?.next).toBe(
      'rebase onto origin/trunk, which moved after this commit was ' +
        'tested, and ship again',
    );
    expect(fetchesIn(calls)).toEqual([
      'git fetch --quiet origin trunk',
      'git fetch --quiet origin trunk',
    ]);
  });

  it('asks about the commit it pushed, not whatever HEAD is now', async () => {
    const { calls } = await shipped({
      'gh pr checks 42 --json': FAILED_BUILD,
    });
    const asked = calls
      .map((call) => call.line)
      .filter((line) => line.startsWith('git merge-base --is-ancestor'));
    expect(asked).toEqual([
      'git merge-base --is-ancestor origin/main HEAD',
      'git merge-base --is-ancestor origin/main abc123',
    ]);
  });

  it('offers to re-run the failed runs when the base has not moved', async () => {
    const { status } = await shipped({
      'gh pr checks 42 --json': FAILED_BUILD,
      'gh run list': runs(
        { workflowName: 'CI', conclusion: 'failure', databaseId: 7 },
        { workflowName: 'Docs', conclusion: 'success', databaseId: 8 },
        { workflowName: 'E2E', conclusion: 'timed_out', databaseId: 9 },
      ),
    });
    expect(status.diagnosis).toEqual({
      base: 'contains',
      rerunnable: [7, 9],
      advice: 'rerun-failed',
      next:
        'origin/main has not moved since this commit was tested: re-run ' +
        'the failed jobs with guardrails ship --rerun-failed, or fix them ' +
        'and ship again',
    });
    expect(status.warnings).toEqual([]);
  });

  it.each<[string, ExecResult[]]>([
    ['cannot be fetched', [ok(''), failed('offline', 128)]],
    [
      'is killed',
      [ok(''), { stdout: '', stderr: '', code: 0, signal: 'SIGTERM' }],
    ],
  ])(
    'says the base is unknown, with a warning, when it %s after CI',
    async (_label, fetches) => {
      const { status } = await shipped({
        'gh pr checks 42 --json': FAILED_BUILD,
        'gh run list': runs({ workflowName: 'CI', conclusion: 'failure' }),
        'git fetch': fetches,
      });
      expect(status.state).toBe('ci-red');
      expect(status.diagnosis).toEqual({
        base: 'unknown',
        rerunnable: [1],
        advice: 'rerun-failed',
        next:
          're-run the failed jobs with guardrails ship --rerun-failed, or ' +
          'fix them and ship again',
      });
      expect(status.warnings).toEqual([
        'could not fetch origin/main after CI, so whether it moved since ' +
          'this commit was tested was not checked',
      ]);
    },
  );

  it('says the base is unknown, with a warning, when git cannot tell', async () => {
    const { status } = await shipped({
      'gh pr checks 42 --json': FAILED_BUILD,
      'git merge-base --is-ancestor': [
        ok(''),
        failed('fatal: bad object', 128),
      ],
    });
    expect(status.diagnosis?.base).toBe('unknown');
    expect(status.warnings).toEqual([
      'could not tell whether origin/main moved since this commit was ' +
        'tested',
    ]);
  });

  it.each<[string, Record<string, ExecResult | ExecResult[]>]>([
    [
      'a failed check in no workflow run',
      {
        'gh pr checks 42 --json': ok(
          JSON.stringify([{ name: 'deploy', bucket: 'fail' }]),
        ),
      },
    ],
    [
      'a workflow that failed to start',
      {
        'gh run list': runs({
          workflowName: 'CI',
          conclusion: 'startup_failure',
        }),
      },
    ],
    [
      'a required check that never reported',
      {
        'gh api repos/{owner}/{repo}/rules/branches/main': ok('build\n'),
        'gh pr checks 42 --json': ok('[]'),
      },
    ],
    [
      'a cancelled run that another run of its workflow outlived',
      {
        'gh pr checks 42 --json': ok(
          JSON.stringify([{ name: 'deploy', bucket: 'fail' }]),
        ),
        'gh run list': runs(
          { workflowName: 'CI', conclusion: 'cancelled', event: 'push' },
          { workflowName: 'CI', conclusion: 'success' },
        ),
      },
    ],
  ])('says fix when nothing can be re-run: %s', async (_label, answers) => {
    const { status } = await shipped(answers);
    expect(status.state).toBe('ci-red');
    expect(status.diagnosis).toEqual({
      base: 'contains',
      rerunnable: [],
      advice: 'fix',
      next:
        'fix the failing checks and ship again: no failed workflow run ' +
        'can be re-run',
    });
  });

  it('finds the run a fail-fast check is in, while that run is still going', async () => {
    const { status } = await shipped({
      'gh pr checks 42 --json': ok(
        JSON.stringify([
          { name: 'test', bucket: 'fail', workflow: 'CI' },
          { name: 'mutation', bucket: 'pending', workflow: 'Mutation' },
        ]),
      ),
      'gh run list': runs(
        { workflowName: 'CI', conclusion: '', databaseId: 11 },
        { workflowName: 'Mutation', conclusion: '', databaseId: 12 },
      ),
    });
    expect(status.diagnosis).toMatchObject({
      rerunnable: [11],
      advice: 'rerun-failed',
    });
  });

  it('does not take a failed check with no workflow for a run with no name', async () => {
    const { status } = await shipped({
      'gh pr checks 42 --json': ok(
        JSON.stringify([{ name: 'deploy', bucket: 'fail', workflow: '' }]),
      ),
      'gh run list': runs({ workflowName: '', conclusion: '' }),
    });
    expect(status.diagnosis?.rerunnable).toEqual([]);
  });

  it('reads a workflow that is not a string as none', () => {
    expect(
      parseChecks(
        JSON.stringify([
          { name: 'build', bucket: 'fail', workflow: 5 },
          { name: 'lint', bucket: 'pass' },
        ]),
      ),
    ).toEqual([
      { name: 'build', outcome: 'fail', workflow: '' },
      { name: 'lint', outcome: 'pass', workflow: '' },
    ]);
  });

  it('never takes an id from a check link', async () => {
    const { status } = await shipped({
      'gh pr checks 42 --json': ok(
        JSON.stringify([
          {
            name: 'build',
            bucket: 'fail',
            workflow: '',
            link: 'https://github.com/o/r/actions/runs/999/job/555',
          },
        ]),
      ),
      'gh run list': runs({ workflowName: 'CI', conclusion: '' }),
    });
    expect(status.diagnosis?.rerunnable).toEqual([]);
  });

  it('lists the checks with their workflow', async () => {
    const { calls } = await shipped({});
    expect(calls.map((call) => call.line)).toContain(
      'gh pr checks 42 --json name,bucket,workflow',
    );
  });

  it('lists the checks without their workflow on a gh that does not know it', async () => {
    const { status, calls } = await shipped({
      'gh pr checks 42 --json': [
        failed(
          'Unknown JSON field: "workflow"\nAvailable fields:\n  bucket\n  name',
        ),
        FAILED_BUILD,
      ],
      'gh run list': runs({ workflowName: 'CI', conclusion: '' }),
    });
    expect(calls.map((call) => call.line)).toContain(
      'gh pr checks 42 --json name,bucket',
    );
    expect(status).toMatchObject({ state: 'ci-red', failing: ['build'] });
  });

  it('has no diagnosis, and fetches once, on green', async () => {
    const { status, calls } = await shipped({});
    expect(status.state).toBe('green');
    expect(status.diagnosis).toBeNull();
    expect(fetchesIn(calls)).toHaveLength(1);
  });

  it.each<[string, Record<string, ExecResult | ExecResult[]>]>([
    [
      'gate-blocked',
      {
        'git push': failed(
          "guardrails: push blocked — resolve violations or run 'guardrails verify'.",
        ),
      },
    ],
    ['error', { 'gh pr checks 42 --json': failed('HTTP 502') }],
  ])('has no diagnosis on %s', async (state, answers) => {
    const { status } = await shipped(answers);
    expect(status.state).toBe(state);
    expect(status.diagnosis).toBeNull();
  });
});

/**
 * A branch pushed as `abc123`, PR 42, whose CI run 7 failed and passes on its
 * second attempt: the listing before the re-run, the one that sees the new
 * attempt, and the one the watch reads.
 */
function rerunAnswers(
  over: Record<string, ExecResult | ExecResult[]> = {},
): Record<string, ExecResult | ExecResult[]> {
  return {
    ...HAPPY,
    'gh pr checks 42 --json': [FAILED_BUILD, ok(HAPPY_CHECKS)],
    'gh run list': [
      runs({ workflowName: 'CI', conclusion: 'failure', databaseId: 7 }),
      runs({ workflowName: 'CI', conclusion: '', databaseId: 7, attempt: 2 }),
      runs({
        workflowName: 'CI',
        conclusion: 'success',
        databaseId: 7,
        attempt: 2,
      }),
    ],
    ...over,
  };
}

async function rerun(
  answers: Record<string, ExecResult | ExecResult[]>,
  over: Partial<ShipOptions> = {},
): Promise<{ status: ShipStatus; delays: number[]; lines: string[] }> {
  const delays: number[] = [];
  const { exec, calls } = fakeExec(answers);
  const status = await ship(
    options(exec, {
      rerunFailed: true,
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      ...over,
    }),
  );
  return { status, delays, lines: calls.map((call) => call.line) };
}

function wasRerun(lines: readonly string[]): boolean {
  return lines.some((line) => line.startsWith('gh run rerun'));
}

describe('ship --rerun-failed (#198)', () => {
  it('re-runs the failed jobs of the failed run, waits for the new attempt, and watches it', async () => {
    const { status, lines } = await rerun(rerunAnswers());
    expect(status).toMatchObject({
      state: 'green',
      pr: 42,
      failing: [],
      diagnosis: null,
      warnings: [],
    });
    const index = (prefix: string) =>
      lines.findIndex((line) => line.startsWith(prefix));
    expect(lines).toContain('gh run rerun 7 --failed');
    expect(index('gh run rerun 7 --failed')).toBeLessThan(
      index('gh pr checks 42 --watch'),
    );
    expect(
      lines.filter((line) => line.startsWith('gh run list --commit abc123')),
    ).toHaveLength(3);
    expect(lines.some((line) => line.startsWith('git push'))).toBe(false);
    expect(lines.some((line) => line.startsWith('gh run watch'))).toBe(false);
  });

  it('waits for a run still going to finish before re-running it', async () => {
    const { lines } = await rerun(
      rerunAnswers({
        'gh pr checks 42 --json': [
          ok(
            JSON.stringify([{ name: 'test', bucket: 'fail', workflow: 'CI' }]),
          ),
          ok(HAPPY_CHECKS),
        ],
        'gh run list': [
          runs({ workflowName: 'CI', conclusion: '', databaseId: 11 }),
          runs({
            workflowName: 'CI',
            conclusion: '',
            databaseId: 11,
            attempt: 2,
          }),
          runs({ workflowName: 'CI', conclusion: 'success', databaseId: 11 }),
        ],
      }),
    );
    const watched = lines.indexOf('gh run watch 11');
    expect(watched).toBeGreaterThan(-1);
    expect(watched).toBeLessThan(lines.indexOf('gh run rerun 11 --failed'));
  });

  it('waits until every re-run has a new attempt', async () => {
    const both = (second: number) =>
      runs(
        { workflowName: 'CI', conclusion: '', databaseId: 7, attempt: 2 },
        { workflowName: 'E2E', conclusion: '', databaseId: 8, attempt: second },
      );
    const { status, delays, lines } = await rerun(
      rerunAnswers({
        'gh run list': [
          runs(
            { workflowName: 'CI', conclusion: 'failure', databaseId: 7 },
            { workflowName: 'E2E', conclusion: 'failure', databaseId: 8 },
          ),
          both(1),
          both(2),
          ok('[]'),
        ],
      }),
    );
    expect(lines).toContain('gh run rerun 7 --failed');
    expect(lines).toContain('gh run rerun 8 --failed');
    expect(delays).toEqual([15_000]);
    expect(status.state).toBe('green');
  });

  it('looks again when the runs cannot be read while it waits', async () => {
    const { status, delays } = await rerun(
      rerunAnswers({
        'gh run list': [
          runs({ workflowName: 'CI', conclusion: 'failure', databaseId: 7 }),
          failed('HTTP 502: Bad Gateway'),
          runs({
            workflowName: 'CI',
            conclusion: '',
            databaseId: 7,
            attempt: 2,
          }),
          runs({ workflowName: 'CI', conclusion: 'success', databaseId: 7 }),
        ],
      }),
    );
    expect(status.state).toBe('green');
    expect(delays).toEqual([15_000]);
  });

  it('is an error, and watches nothing, when the new attempt never starts', async () => {
    const stuck = runs({
      workflowName: 'CI',
      conclusion: 'failure',
      databaseId: 7,
    });
    const { status, delays, lines } = await rerun(
      rerunAnswers({ 'gh run list': stuck }),
    );
    expect(status).toMatchObject({ state: 'error', pr: 42, diagnosis: null });
    expect(status.tail).toBe(
      'guardrails ship --rerun-failed: gh accepted the re-run, but run(s) 7 ' +
        'did not start a new attempt in time, so the checks were not watched.',
    );
    expect(delays).toHaveLength(8);
    expect(
      lines.some((line) => line.startsWith('gh pr checks 42 --watch')),
    ).toBe(false);
  });

  it('diagnoses again when the re-run is red too', async () => {
    const { status } = await rerun(
      rerunAnswers({
        'gh pr checks 42 --json': [FAILED_BUILD, FAILED_BUILD],
        'gh run list': [
          runs({ workflowName: 'CI', conclusion: 'failure', databaseId: 7 }),
          runs({
            workflowName: 'CI',
            conclusion: '',
            databaseId: 7,
            attempt: 2,
          }),
          runs({
            workflowName: 'CI',
            conclusion: 'failure',
            databaseId: 7,
            attempt: 2,
          }),
        ],
      }),
    );
    expect(status).toMatchObject({
      state: 'ci-red',
      failing: ['build', 'CI (failure)'],
      diagnosis: { base: 'contains', rerunnable: [7], advice: 'rerun-failed' },
    });
  });

  it('refuses when HEAD is not the commit origin has', async () => {
    const { status, lines } = await rerun(
      rerunAnswers({ 'git ls-remote': ok('def456\trefs/heads/feat/x\n') }),
    );
    expect(status).toMatchObject({ state: 'error', diagnosis: null });
    expect(status.tail).toBe(
      'guardrails ship --rerun-failed: HEAD (abc123) is not the commit ' +
        'origin/feat/x has (def456), so the runs there did not test it. ' +
        'Ship it instead. Nothing was re-run.',
    );
    expect(wasRerun(lines)).toBe(false);
  });

  it('refuses without a pull request', async () => {
    const { status, lines } = await rerun(
      rerunAnswers({ 'gh pr view': failed('no pull requests found') }),
    );
    expect(status).toMatchObject({ state: 'error', pr: null });
    expect(status.tail).toBe(
      'guardrails ship --rerun-failed: feat/x has no pull request. Ship it ' +
        'instead. Nothing was re-run.',
    );
    expect(wasRerun(lines)).toBe(false);
  });

  it('refuses as behind when the base moved since the commit was tested', async () => {
    const { status, lines } = await rerun(
      rerunAnswers({ 'git merge-base --is-ancestor': failed('', 1) }),
    );
    expect(status).toMatchObject({
      state: 'behind',
      pr: 42,
      url: 'https://github.com/o/r/pull/42',
      diagnosis: null,
    });
    expect(status.tail).toBe(
      'guardrails ship --rerun-failed: origin/main moved after abc123 was ' +
        'tested, and a re-run would test it against the old base. Rebase ' +
        'onto origin/main and ship again. Nothing was re-run.',
    );
    expect(lines).toContain('git merge-base --is-ancestor origin/main abc123');
    expect(wasRerun(lines)).toBe(false);
  });

  it('re-runs with a warning when the base cannot be fetched', async () => {
    const { status, lines } = await rerun(
      rerunAnswers({ 'git fetch': failed('offline', 128) }),
    );
    expect(status.state).toBe('green');
    expect(status.warnings).toEqual([
      'could not fetch origin/main after CI, so whether it moved since this ' +
        'commit was tested was not checked',
    ]);
    expect(wasRerun(lines)).toBe(true);
  });

  it('refuses when no failed run can be re-run', async () => {
    const { status, lines } = await rerun(
      rerunAnswers({
        'gh run list': runs({
          workflowName: 'CI',
          conclusion: 'startup_failure',
        }),
        'gh pr checks 42 --json': ok('[]'),
      }),
    );
    expect(status).toMatchObject({ state: 'error', pr: 42 });
    expect(status.tail).toBe(
      'guardrails ship --rerun-failed: no failed workflow run on abc123 has ' +
        'jobs to re-run. Fix the failing checks and ship again. Nothing was ' +
        're-run.',
    );
    expect(wasRerun(lines)).toBe(false);
  });

  it('is an error when the runs cannot be read', async () => {
    const { status, lines } = await rerun(
      rerunAnswers({ 'gh run list': failed('HTTP 502: Bad Gateway') }),
    );
    expect(status).toMatchObject({
      state: 'error',
      pr: 42,
      tail: 'HTTP 502: Bad Gateway',
    });
    expect(wasRerun(lines)).toBe(false);
  });

  it('is an error, with what gh said, when gh refuses the re-run', async () => {
    const { status, lines } = await rerun(
      rerunAnswers({
        'gh run rerun': failed(
          'run 7 cannot be rerun; its workflow file may be broken',
        ),
      }),
    );
    expect(status).toMatchObject({ state: 'error', pr: 42 });
    expect(status.tail).toBe(
      'run 7 cannot be rerun; its workflow file may be broken',
    );
    expect(
      lines.some((line) => line.startsWith('gh pr checks 42 --watch')),
    ).toBe(false);
  });

  it('stops before anything when gh cannot be used', async () => {
    const { status, lines } = await rerun(
      rerunAnswers({
        'gh auth status': failed('You are not logged into any GitHub hosts.'),
      }),
    );
    expect(status.state).toBe('error');
    expect(lines).toEqual([
      'git rev-parse --abbrev-ref HEAD',
      'gh auth status',
    ]);
  });

  it('is an error when HEAD names no commit', async () => {
    const { status, lines } = await rerun(
      rerunAnswers({ 'git rev-parse HEAD': ok('') }),
    );
    expect(status.state).toBe('error');
    expect(status.tail).toMatch(
      /^guardrails ship: git rev-parse HEAD named no commit/,
    );
    expect(wasRerun(lines)).toBe(false);
  });

  it('appends its row to the run log, with its CI time and no push', async () => {
    await rerun(rerunAnswers(), {
      shipId: 'rerun-1',
      lockPath: path.join(root, 'gate.lock'),
      runClock: steppingClock(),
    });
    const [row] = parseRuns(readFileSync(logFile(), 'utf8'));
    expect(row).toMatchObject({
      kind: 'ship',
      ship: 'rerun-1',
      state: 'green',
      pr: 42,
      pushMs: 0,
      ciMs: 1000,
    });
  });
});

const PREFLIGHT_COMMANDS = ['npm run build', 'npm test'];

function withPreflight(
  exec: Exec,
  commands: readonly string[] = PREFLIGHT_COMMANDS,
  over: Partial<ShipOptions> = {},
): ShipOptions {
  return options(exec, {
    preflight: { commands, baseBranch: 'main', warnings: [] },
    ...over,
  });
}

function preflightCalls(calls: readonly Call[]): string[] {
  return calls
    .filter((call) => call.line.startsWith('sh -c'))
    .map((call) => call.line);
}

/**
The git answers that give the tree a fingerprint, so a pass is recorded.
*/
const FINGERPRINTED: Record<string, ExecResult | ExecResult[]> = {
  'git rev-parse --git-path index': ok('.git/index\n'),
  'git write-tree': ok('tree1\n'),
  'git merge-base main HEAD': ok('base1\n'),
};

function preflightRecord(): string {
  return path.join(root, '.guardrails', 'state', 'preflight-pass.json');
}

describe('ship: preflight commands (#243)', () => {
  it('runs each command in order, after the prechecks and before the gate', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const status = await ship(withPreflight(exec));
    expect(status.state).toBe('green');
    expect(preflightCalls(calls)).toEqual([
      'sh -c npm run build',
      'sh -c npm test',
    ]);
    const first = indexOf(calls, 'sh -c npm run build');
    expect(first).toBeGreaterThan(
      indexOf(calls, 'git merge-base --is-ancestor'),
    );
    expect(first).toBeGreaterThan(indexOf(calls, 'git status --porcelain'));
    expect(indexOf(calls, 'sh -c npm test')).toBeLessThan(
      indexOf(calls, GATE_LINE),
    );
    expect(
      calls
        .filter((call) => call.line.startsWith('sh -c'))
        .map((call) => call.cwd),
    ).toEqual([root, root]);
  });

  it('runs the commands in the gate’s environment, with stdin closed', async () => {
    const seen: {
      env: NodeJS.ProcessEnv | undefined;
      input: string | undefined;
    }[] = [];
    const { exec: base } = fakeExec(HAPPY);
    const exec: Exec = (command, args, execOptions) => {
      if (command === 'sh') {
        seen.push({ env: execOptions?.env, input: execOptions?.input });
      }
      return base(command, args, execOptions);
    };
    await ship(withPreflight(exec, ['npm test'], { shipId: 'ship-9' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.env?.GUARDRAILS_SHIP_ID).toBe('ship-9');
    expect(seen[0]?.input).toBe('');
  });

  it('stops on a command that fails: names it, keeps its tail, and gates nothing', async () => {
    const printed = Array.from(
      { length: 60 },
      (_, index) => `line ${String(index)}`,
    );
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('no pull requests found'),
      'sh -c npm run build': {
        stdout: printed.join('\n'),
        stderr: '',
        code: 2,
      },
    });
    const status = await ship(withPreflight(exec));
    expect(status).toMatchObject({
      state: 'preflight-failed',
      failing: ['npm run build'],
      pr: null,
      url: null,
    });
    const tail = status.tail.split('\n');
    expect(tail).toHaveLength(40);
    expect(tail.at(-1)).toBe(
      'guardrails ship: preflight "npm run build" exited 2. Nothing was ' +
        'pushed; the gate did not run.',
    );
    expect(tail.at(-2)).toBe('line 59');
    expect(indexOf(calls, GATE_LINE)).toBe(-1);
    expect(indexOf(calls, 'git push')).toBe(-1);
    expect(indexOf(calls, 'sh -c npm test')).toBe(-1);
  });

  it('still names the PR the branch already has when preflight fails', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'sh -c npm test': failed('1 failed'),
    });
    const status = await ship(withPreflight(exec));
    expect(status).toMatchObject({
      state: 'preflight-failed',
      failing: ['npm test'],
      pr: 42,
      url: 'https://github.com/o/r/pull/42',
    });
  });

  it.each([
    [
      'ended by a signal',
      {
        stdout: '',
        stderr: '',
        code: 0,
        signal: 'SIGKILL',
      } satisfies ExecResult,
      'was ended by SIGKILL before it finished',
    ],
    [
      'that could not start',
      {
        stdout: '',
        stderr: 'spawn sh ENOENT',
        code: 1,
        spawnFailed: true,
      } satisfies ExecResult,
      'could not be started',
    ],
  ])(
    'reads a command %s as an error, and gates nothing',
    async (_label, result, why) => {
      const { exec, calls } = fakeExec({
        ...HAPPY,
        'sh -c npm run build': result,
      });
      const status = await ship(withPreflight(exec));
      expect(status).toMatchObject({ state: 'error', failing: [], pr: 42 });
      expect(status.tail.split('\n').at(-1)).toBe(
        `guardrails ship: preflight "npm run build" ${why}. Nothing was pushed; ` +
          'the gate did not run.',
      );
      expect(indexOf(calls, GATE_LINE)).toBe(-1);
      expect(indexOf(calls, 'git push')).toBe(-1);
    },
  );

  it('runs nothing, and asks nothing more, for an empty or absent list', async () => {
    const baseline = fakeExec(HAPPY);
    await ship(options(baseline.exec));
    const empty = fakeExec(HAPPY);
    await ship(withPreflight(empty.exec, []));
    expect(preflightCalls(empty.calls)).toEqual([]);
    expect(empty.calls).toEqual(baseline.calls);
  });

  it('gates nothing when HEAD moved while the commands ran', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'git rev-parse HEAD': [ok('abc123\n'), ok('def456\n')],
    });
    const status = await ship(withPreflight(exec));
    expect(status).toMatchObject({ state: 'error', pr: 42 });
    expect(status.tail).toContain('HEAD moved from abc123 to def456');
    expect(status.tail).toContain('while preflight or the push gate ran');
    expect(indexOf(calls, GATE_LINE)).toBe(-1);
    expect(indexOf(calls, 'git push')).toBe(-1);
  });

  it('reports the entries the config dropped as warnings, first', async () => {
    const dropped = ['ship.preflight entry 2 is not a command; ignored'];
    const { exec } = fakeExec(HAPPY);
    const status = await ship(
      options(exec, {
        preflight: {
          commands: ['npm test'],
          baseBranch: 'main',
          warnings: dropped,
        },
      }),
    );
    expect(status.state).toBe('green');
    expect(status.warnings[0]).toBe(dropped[0]);
  });

  it('keeps the dropped-entry warnings when preflight fails', async () => {
    const dropped = ['ship.preflight entry 1 is not a command; ignored'];
    const { exec } = fakeExec({ ...HAPPY, 'sh -c npm test': failed('red') });
    const status = await ship(
      options(exec, {
        preflight: {
          commands: ['npm test'],
          baseBranch: 'main',
          warnings: dropped,
        },
      }),
    );
    expect(status.state).toBe('preflight-failed');
    expect(status.warnings).toEqual(dropped);
  });

  it('never runs preflight for --rerun-failed', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    await ship(withPreflight(exec, PREFLIGHT_COMMANDS, { rerunFailed: true }));
    expect(preflightCalls(calls)).toEqual([]);
  });
});

describe('ship: the preflight pass record (#243)', () => {
  it('records a pass, and a second ship of the same tree runs no command', async () => {
    const first = fakeExec({ ...HAPPY, ...FINGERPRINTED });
    await ship(withPreflight(first.exec));
    expect(preflightCalls(first.calls)).toHaveLength(2);
    expect(existsSync(preflightRecord())).toBe(true);

    const second = fakeExec({ ...HAPPY, ...FINGERPRINTED });
    const status = await ship(withPreflight(second.exec));
    expect(status.state).toBe('green');
    expect(preflightCalls(second.calls)).toEqual([]);
    expect(indexOf(second.calls, GATE_LINE)).toBeGreaterThan(-1);
  });

  it('leaves the record as it was when a command fails', async () => {
    const first = fakeExec({ ...HAPPY, ...FINGERPRINTED });
    await ship(withPreflight(first.exec, ['npm test']));
    const before = readFileSync(preflightRecord(), 'utf8');

    const second = fakeExec({
      ...HAPPY,
      ...FINGERPRINTED,
      'sh -c npm run build': failed('red'),
    });
    const status = await ship(withPreflight(second.exec));
    expect(status.state).toBe('preflight-failed');
    expect(readFileSync(preflightRecord(), 'utf8')).toBe(before);
  });
});

describe('classifyPushFailure: a hook stopped by preflight (#243)', () => {
  const STOPPED = 'guardrails: push stopped — preflight "npm test" failed';

  it('reads the preflight line as preflight-failed', () => {
    expect(classifyPushFailure(failed(`1 failed\n${STOPPED}`))).toBe(
      'preflight-failed',
    );
  });

  it('is still a gate block when the gate’s own line comes last', () => {
    expect(
      classifyPushFailure(
        failed(
          `${STOPPED}\nsrc/a.ts:1 [stryker/survived]\n` +
            "guardrails: push blocked — resolve violations or run 'guardrails verify'.",
        ),
      ),
    ).toBe('gate-blocked');
  });

  it('reads a preflight that reached no verdict as an error', () => {
    expect(
      classifyPushFailure(
        failed(
          'guardrails: preflight "npm test" was ended by SIGTERM before it finished.\n' +
            `${preflightErrorLine('npm test')}\nerror: failed to push some refs`,
        ),
      ),
    ).toBe('error');
  });

  it('names a multi-line command the hook stopped on', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed(
        `1 failed\n${preflightFailedLine('npm run build\nnpm test')}\n` +
          'error: failed to push some refs',
      ),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'preflight-failed',
      failing: ['npm run build\nnpm test'],
    });
  });

  it('names the command the hook stopped on', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed(
        `1 failed\n${STOPPED}\nerror: failed to push some refs`,
      ),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'preflight-failed',
      failing: ['npm test'],
      pr: 42,
    });
  });

  it('names nothing when the hook’s line carries no command', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed(
        'guardrails: push stopped — preflight\nerror: failed to push some refs',
      ),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('preflight-failed');
    expect(status.failing).toEqual([]);
  });
});
