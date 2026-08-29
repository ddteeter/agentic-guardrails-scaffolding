import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type CliDeps, runCommand } from '../src/cli-core.js';
import type { Exec, ExecResult } from '../src/exec.js';
import {
  loadSession,
  sessionFile,
  stateDirectory,
  writeViolations,
} from '../src/state-store.js';
import type { Violation } from '../src/violation.js';

let root: string;
let out: string[];
let errors: string[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-cli-'));
  out = [];
  errors = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

function deps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: root,
    exec: () => Promise.resolve(ok('')),
    readStdin: () => Promise.resolve(''),
    stdout: (text) => out.push(text),
    stderr: (text) => errors.push(text),
    ...over,
  };
}

function violation(file: string): Violation {
  return {
    ruleId: 'no-console',
    file,
    message: 'Unexpected console.',
    severity: 'error',
    fixable: false,
    tool: 'eslint',
  };
}

describe('runCommand — verify', () => {
  it('returns 0 when no TypeScript files changed', async () => {
    expect(await runCommand('verify', [], deps())).toBe(0);
  });

  it('returns 1 and reports violations when verify fails', async () => {
    const eslint = JSON.stringify([
      {
        filePath: path.join(root, 'src/foo.ts'),
        messages: [
          { ruleId: 'no-console', severity: 2, message: 'x', line: 1 },
        ],
      },
    ]);
    const exec = (command: string, args: string[]) => {
      const line = [command, ...args].join(' ');
      if (line.includes('--name-only'))
        return Promise.resolve(ok('src/foo.ts'));
      if (line.includes('eslint')) return Promise.resolve(ok(eslint));
      return Promise.resolve(ok(''));
    };
    expect(await runCommand('verify', [], deps({ exec }))).toBe(1);
    expect(errors.join('')).toContain('no-console');
  });
});

describe('runCommand — audit', () => {
  it('returns 1 when the working diff adds a suppression', async () => {
    const diff = [
      '+++ b/src/a.ts',
      '@@ -1,0 +1,1 @@',
      '+  // eslint-disable-next-line',
    ].join('\n');
    const exec = () => Promise.resolve(ok(diff));
    expect(await runCommand('audit', [], deps({ exec }))).toBe(1);
    expect(errors.join('')).toContain('eslint-disable');
  });
});

describe('runCommand — state', () => {
  it('prints the current session and recurrence as JSON', async () => {
    expect(await runCommand('state', [], deps())).toBe(0);
    const printed: unknown = JSON.parse(out.join(''));
    expect(printed).toMatchObject({
      session: { attempts: 0, ruleCounts: {}, corrected: [] },
      recurrence: {},
    });
  });
});

describe('runCommand — scope-check', () => {
  it('denies an edit to a file outside the manifest', async () => {
    writeViolations(stateDirectory(root), 'sid', [violation('src/allowed.ts')]);
    const stdin = JSON.stringify({
      cwd: root,
      tool_input: { file_path: path.join(root, 'src/forbidden.ts') },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toContain('deny');
  });

  it('stays silent for a file inside the manifest', async () => {
    writeViolations(stateDirectory(root), 'sid', [violation('src/allowed.ts')]);
    const stdin = JSON.stringify({
      cwd: root,
      tool_input: { file_path: path.join(root, 'src/allowed.ts') },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toBe('');
  });

  it('denies a Read outside the repo (e.g. ~/.claude memory)', async () => {
    writeViolations(stateDirectory(root), 'default', [violation('src/a.ts')]);
    const stdin = JSON.stringify({
      cwd: root,
      tool_name: 'Read',
      tool_input: { file_path: '/home/u/.claude/projects/x/memory/y.md' },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toContain('deny');
  });

  it('allows a Read inside the repo (incl. node_modules)', async () => {
    const stdin = JSON.stringify({
      cwd: root,
      tool_name: 'Read',
      tool_input: {
        file_path: path.join(root, 'node_modules/some-plugin/rule.js'),
      },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toBe('');
  });

  it('allows a Copilot `view` read inside the repo, not in the manifest', async () => {
    // A manifest IS active (for a different file) — this is the regression
    // case: a `view` read must not fall through to the edit-family
    // manifest-lock, which would wrongly deny it.
    writeViolations(stateDirectory(root), 'sid', [violation('src/allowed.ts')]);
    const stdin = JSON.stringify({
      workingDirectory: root,
      toolName: 'view',
      toolArgs: { path: path.join(root, 'src/not-in-manifest.ts') },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toBe('');
  });

  it('denies a Copilot `view` read outside the repo', async () => {
    writeViolations(stateDirectory(root), 'default', [violation('src/a.ts')]);
    const stdin = JSON.stringify({
      workingDirectory: root,
      toolName: 'view',
      toolArgs: { path: '/home/u/.claude/projects/x/memory/y.md' },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toContain('deny');
    expect(out.join('')).toContain('outside the repository');
  });
});

describe('runCommand — gate stop', () => {
  it('emits a block decision when verify fails', async () => {
    const eslint = JSON.stringify([
      {
        filePath: path.join(root, 'src/foo.ts'),
        messages: [
          { ruleId: 'no-console', severity: 2, message: 'x', line: 1 },
        ],
      },
    ]);
    const exec = (command: string, args: string[]) => {
      const line = [command, ...args].join(' ');
      if (line.includes('--name-only'))
        return Promise.resolve(ok('src/foo.ts'));
      if (line.includes('HEAD')) return Promise.resolve(ok(''));
      if (line.includes('eslint')) return Promise.resolve(ok(eslint));
      return Promise.resolve(ok(''));
    };
    const stdin = JSON.stringify({ session_id: 'sid', cwd: root });
    await runCommand(
      'gate',
      ['--mode=stop'],
      deps({ exec, readStdin: () => Promise.resolve(stdin) }),
    );
    const printed: unknown = JSON.parse(out.join(''));
    expect(printed).toMatchObject({ decision: 'block' });
  });
});

/** Canned exec for the pretooluse-gate tests: `merge-base` resolves to a sha,
 * `diff <sha>` returns the mapped diff text, everything else is empty. */
function gitExec(map: Record<string, string>): Exec {
  return (command, args) => {
    let key: string | undefined;
    if (args[0] === 'merge-base') {
      key = 'merge-base';
    } else if (args.slice(0, 2).join(' ') === 'diff BASESHA') {
      key = 'diff BASESHA';
    }
    const stdout = key === undefined ? '' : (map[key] ?? '');
    return Promise.resolve(ok(stdout));
  };
}

describe('runCommand — gate pretooluse (copilot commit/push gate)', () => {
  it('denies a git commit when the tree is dirty (copilot dialect)', async () => {
    const stdin = JSON.stringify({
      toolName: 'bash',
      toolArgs: { command: 'git commit -m wip' },
      cwd: root,
    });
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': [
        '+++ b/src/a.ts',
        '@@ -1,0 +1,1 @@',
        '+// eslint-disable-next-line',
      ].join('\n'),
    });
    const code = await runCommand(
      'gate',
      ['--mode=pretooluse', '--dialect=copilot'],
      deps({ exec, readStdin: () => Promise.resolve(stdin) }),
    );
    expect(code).toBe(0);
    const printed: unknown = JSON.parse(out.join(''));
    expect(printed).toMatchObject({ permissionDecision: 'deny' });
  });

  it('stays silent for a non-git shell command', async () => {
    const stdin = JSON.stringify({
      toolName: 'bash',
      toolArgs: { command: 'ls -la' },
    });
    const code = await runCommand(
      'gate',
      ['--mode=pretooluse', '--dialect=copilot'],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(code).toBe(0);
    expect(out.join('')).toBe('');
  });

  it('stays silent on a clean commit', async () => {
    const stdin = JSON.stringify({
      toolName: 'bash',
      toolArgs: { command: 'git commit -m ok' },
      cwd: root,
    });
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': '+const x = 1;\n',
    });
    const code = await runCommand(
      'gate',
      ['--mode=pretooluse', '--dialect=copilot'],
      deps({ exec, readStdin: () => Promise.resolve(stdin) }),
    );
    expect(code).toBe(0);
    expect(out.join('')).toBe('');
  });
});

describe('runCommand — session lifecycle', () => {
  it('session-start sweeps and returns 0', async () => {
    expect(await runCommand('session-start', [], deps())).toBe(0);
  });

  it('session-end returns 0', async () => {
    const stdin = JSON.stringify({ session_id: 'sid', cwd: root });
    expect(
      await runCommand(
        'session-end',
        [],
        deps({ readStdin: () => Promise.resolve(stdin) }),
      ),
    ).toBe(0);
  });
});

describe('runCommand — unknown', () => {
  it('prints usage and returns 1', async () => {
    expect(await runCommand('bogus', [], deps())).toBe(1);
    expect(errors.join('')).toContain('usage:');
  });
});

/** stdin payload for the pretooluse gate. */
function preToolUseStdin(toolName: unknown, command: unknown): string {
  return JSON.stringify({ toolName, toolArgs: { command }, cwd: root });
}

/** An exec whose branch diff always carries a suppression, so the gate DENIES
 *  whenever it actually runs — making "did the gate fire?" observable. */
function dirtyExec(): Exec {
  return gitExec({
    'merge-base': 'BASESHA\n',
    'diff BASESHA': [
      '+++ b/src/a.ts',
      '@@ -1,0 +1,1 @@',
      '+// eslint-disable-next-line',
    ].join('\n'),
  });
}

async function runPreToolUse(stdin: string): Promise<string> {
  await runCommand(
    'gate',
    ['--mode=pretooluse', '--dialect=copilot'],
    deps({ exec: dirtyExec(), readStdin: () => Promise.resolve(stdin) }),
  );
  return out.join('');
}

describe('pretooluse gate trigger conditions', () => {
  it('fires only for an exact shell tool name, case-insensitively', async () => {
    // Kills the SHELL_TOOLS anchor mutants: unanchored, any tool whose name
    // merely CONTAINS "bash" would be gated.
    expect(
      await runPreToolUse(preToolUseStdin('BASH', 'git commit -m x')),
    ).toContain('deny');
    out.length = 0;
    expect(
      await runPreToolUse(preToolUseStdin('run-bash-task', 'git commit -m x')),
    ).toBe('');
  });

  it('matches git commit/push on word boundaries and any spacing', async () => {
    // Kills the GIT_WRITE mutants: `\s+` -> `\s` misses double spaces, and a
    // dropped `\b` would match `legit commit` or `git commits-are-fun`.
    expect(await runPreToolUse(preToolUseStdin('bash', 'git push'))).toContain(
      'deny',
    );
    out.length = 0;
    expect(
      await runPreToolUse(preToolUseStdin('bash', 'git  commit -m x')),
    ).toContain('deny');
    out.length = 0;
    expect(
      await runPreToolUse(preToolUseStdin('bash', 'legit commit -m x')),
    ).toBe('');
    out.length = 0;
    expect(
      await runPreToolUse(preToolUseStdin('bash', 'git commits-are-fun')),
    ).toBe('');
  });

  it('stays silent when toolName or command is absent', async () => {
    // Kills the `=== undefined` equality mutants and the `||` -> `&&` chain
    // mutants, which would let a non-matching invocation reach the gate.
    expect(await runPreToolUse(preToolUseStdin(undefined, 'git commit'))).toBe(
      '',
    );
    out.length = 0;
    expect(await runPreToolUse(preToolUseStdin('bash', undefined))).toBe('');
    out.length = 0;
    // A shell command that is not a git write must not reach the gate even
    // though the tree is dirty.
    expect(await runPreToolUse(preToolUseStdin('bash', 'ls -la'))).toBe('');
  });
});

describe('cli-core wiring', () => {
  it('prints ? for a violation with no line number', async () => {
    // Kills `violation.line ?? '?'` -> `&&`. ESLint can report a message with
    // no line (a whole-file parse failure), and the printer must not emit
    // `src/a.ts:undefined`.
    const lineless = JSON.stringify([
      {
        filePath: path.join(root, 'src/a.ts'),
        messages: [
          { ruleId: 'no-console', severity: 2, message: 'Unexpected console.' },
        ],
      },
    ]);
    const exec: Exec = (command, args) =>
      Promise.resolve(ok(args.includes('--name-only') ? 'src/a.ts' : lineless));
    await runCommand('verify', [], deps({ exec }));
    expect(errors.join('')).toContain('src/a.ts:?');
  });

  it('resolves tool binaries against the repo-local node_modules', async () => {
    // Kills the binResolver block removal, which silently degrades every tool
    // lookup to a bare PATH name — the repo-local pin is how the gate avoids
    // running whatever version happens to be on PATH.
    mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', '.bin', 'eslint'), '');
    const seen: string[] = [];
    const exec: Exec = (command, args) => {
      seen.push(command);
      return Promise.resolve(
        ok(args.includes('--name-only') ? 'src/a.ts' : ''),
      );
    };
    await runCommand('verify', [], deps({ exec }));
    expect(seen.some((command) => command.includes('node_modules'))).toBe(true);
  });
});

const OUTSIDE_PATH = path.join(tmpdir(), 'outside-the-repo.ts');

/** stdin payload for the scope-check hook. */
function scopeStdin(toolName: unknown, filePath: unknown): string {
  // filePath rides in toolArgs.path (parseHookInput reads tool_input.file_path
  // / toolArgs.path), NOT at the top level.
  return JSON.stringify({ toolName, toolArgs: { path: filePath }, cwd: root });
}

/** The scope-lock only engages while a fix loop is active (non-empty manifest). */
function withActiveManifest(): void {
  writeViolations(stateDirectory(root), 'default', [violation('src/a.ts')]);
}

async function runScopeCheck(stdin: string): Promise<string> {
  await runCommand(
    'scope-check',
    [],
    deps({ readStdin: () => Promise.resolve(stdin) }),
  );
  return out.join('');
}

/** An exec that fails verify, so the stop gate produces a blocking decision. */
function failingVerifyExec(): Exec {
  const eslintJson = JSON.stringify([
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
  return (command, args) => {
    const line = [command, ...args].join(' ');
    if (line.includes('--name-only')) return Promise.resolve(ok('src/foo.ts'));
    if (line.includes('eslint')) return Promise.resolve(ok(eslintJson));
    return Promise.resolve(ok(''));
  };
}

describe('scope-check trigger conditions', () => {
  it('treats only exact read-tool names as reads', async () => {
    withActiveManifest();
    // Kills the READ_TOOLS anchor mutants. Both branches deny an out-of-repo
    // path while a fix loop is active, so the discriminator is WHICH rule
    // fired: an unanchored pattern would misclassify these as reads.
    expect(await runScopeCheck(scopeStdin('my-read', OUTSIDE_PATH))).toContain(
      'scope-lock',
    );
    out.length = 0;
    expect(
      await runScopeCheck(scopeStdin('read-only', OUTSIDE_PATH)),
    ).toContain('scope-lock');
  });

  it('does not treat an arbitrary defined tool name as a read', async () => {
    withActiveManifest();
    // Kills `toolName !== undefined && ...` -> `||` (and -> true): an edit tool
    // would be read-classified, reporting the read-scope rule instead.
    const denied = await runScopeCheck(scopeStdin('edit', OUTSIDE_PATH));
    expect(denied).toContain('scope-lock');
    expect(denied).not.toContain('read-scope');
  });

  it('still denies a genuine out-of-repo read', async () => {
    withActiveManifest();
    const denied = await runScopeCheck(scopeStdin('Read', OUTSIDE_PATH));
    expect(denied).toContain('deny');
    expect(denied).toContain('read-scope');
  });

  it('returns early when no filePath is supplied', async () => {
    // Kills `input.filePath === undefined` -> false: continuing would pass
    // undefined into the path checks.
    writeViolations(stateDirectory(root), 'default', [violation('src/a.ts')]);
    expect(await runScopeCheck(scopeStdin('edit', undefined))).toBe('');
  });

  it('does not confine reads when no fix loop is active', async () => {
    // The hook is wired session-wide, so with no manifest it must leave the
    // MAIN agent alone — its memory, scratchpad and sibling repos all live
    // outside the repository.
    expect(await runScopeCheck(scopeStdin('Read', OUTSIDE_PATH))).toBe('');
  });

  it('allows any edit when no manifest is active', async () => {
    // Kills `files.size > 0` -> `>= 0` / true: with no manifest the fixer is not
    // running, and the scope-lock must not interfere.
    expect(
      await runScopeCheck(scopeStdin('edit', path.join(root, 'src/a.ts'))),
    ).toBe('');
  });
});

describe('cli-core defaults and dialects', () => {
  it('falls back to deps.cwd and the default session when stdin omits them', async () => {
    // Kills the `input.cwd ?? deps.cwd` / `?? 'default'` -> `&&` mutants across
    // the stop, pretooluse, scope-check and session-end paths: with `&&` the
    // repoRoot becomes undefined and the path helpers throw.
    expect(
      await runCommand(
        'gate',
        ['--mode=stop'],
        deps({ readStdin: () => Promise.resolve('{}') }),
      ),
    ).toBe(0);
    expect(
      await runCommand(
        'gate',
        ['--mode=pretooluse'],
        deps({
          readStdin: () =>
            Promise.resolve(
              JSON.stringify({
                toolName: 'bash',
                toolArgs: { command: 'git commit -m x' },
              }),
            ),
        }),
      ),
    ).toBe(0);
    await runCommand(
      'scope-check',
      [],
      deps({
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({ toolName: 'edit', filePath: 'a.ts' }),
          ),
      }),
    );
    expect(
      await runCommand(
        'session-end',
        [],
        deps({ readStdin: () => Promise.resolve('{}') }),
      ),
    ).toBe(0);
    expect(await runCommand('state', [], deps())).toBe(0);
  });

  it('prints nothing when the stop gate produces no hook output', async () => {
    // Kills `if (output)` -> true, which would print `undefined`.
    const code = await runCommand(
      'gate',
      ['--mode=stop'],
      deps({ readStdin: () => Promise.resolve(JSON.stringify({ cwd: root })) }),
    );
    expect(code).toBe(0);
    expect(out.join('')).toBe('');
  });
});

describe('verify and audit exit codes', () => {
  it('reports the clean message only when there are no violations', async () => {
    // Kills the `violations.length === 0` conditional/equality mutants.
    await runCommand('verify', [], deps());
    expect(errors.join('')).toContain('clean (0 violations)');
    errors.length = 0;
    await runCommand('verify', [], deps({ exec: failingVerifyExec() }));
    expect(errors.join('')).toContain('1 violation(s)');
    expect(errors.join('')).not.toContain('clean (0 violations)');
  });

  it('audits the working diff from cwd and exits per findings', async () => {
    // Kills the audit argv/cwd mutants and `findings.length > 0` -> true/>=0.
    const calls: { args: string[]; cwd: string | undefined }[] = [];
    const auditExec =
      (diff: string): Exec =>
      (command, args, execOptions) => {
        calls.push({ args, cwd: execOptions?.cwd });
        return Promise.resolve(ok(diff));
      };
    expect(await runCommand('audit', [], deps({ exec: auditExec('') }))).toBe(
      0,
    );
    expect(calls[0]?.args).toEqual(['diff', 'HEAD']);
    expect(calls[0]?.cwd).toBe(root);

    const dirty = [
      '+++ b/src/a.ts',
      '@@ -1,0 +1,1 @@',
      '+// eslint-disable-next-line',
    ].join('\n');
    expect(
      await runCommand('audit', [], deps({ exec: auditExec(dirty) })),
    ).toBe(1);
  });
});

describe('cli-core residual hardening', () => {
  it('anchors the shell-tool name at BOTH ends', async () => {
    // Kills the two SHELL_TOOLS anchor mutants individually: `bash-task`
    // starts with bash, `run-bash` ends with it — neither may gate.
    expect(
      await runPreToolUse(preToolUseStdin('bash-task', 'git commit')),
    ).toBe('');
    out.length = 0;
    expect(await runPreToolUse(preToolUseStdin('run-bash', 'git commit'))).toBe(
      '',
    );
  });

  it('scope-locks an edit to the manifest, using deps.cwd when stdin omits it', async () => {
    // Kills `toolName !== undefined && READ_TOOLS.test(...)` -> true (an edit
    // treated as a read would be allowed anywhere in-repo) and the
    // `input.cwd ?? deps.cwd` -> `&&` mutant (a lost repoRoot finds no manifest,
    // so the scope-lock silently disengages).
    writeViolations(stateDirectory(root), 'default', [violation('src/a.ts')]);
    await runCommand(
      'scope-check',
      [],
      deps({
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({
              toolName: 'edit',
              toolArgs: { path: path.join(root, 'src/b.ts') },
            }),
          ),
      }),
    );
    expect(out.join('')).toContain('deny');
  });

  it('routes --mode=commit to the commit gate', async () => {
    // Kills `mode === 'commit'` -> false, which would fall through to the stop
    // gate and never block a dirty commit.
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': [
        '+++ b/src/a.ts',
        '@@ -1,0 +1,1 @@',
        '+// eslint-disable-next-line',
      ].join('\n'),
    });
    expect(await runCommand('gate', ['--mode=commit'], deps({ exec }))).toBe(1);
  });

  it('defaults the session id for state and session-end', async () => {
    // Kills the `flag(rest,'session') ?? 'default'` and
    // `input.sessionId ?? 'default'` -> `&&` mutants.
    writeViolations(stateDirectory(root), 'default', [violation('src/a.ts')]);
    expect(await runCommand('state', [], deps())).toBe(0);
    expect(out.join('')).toContain('session');
    expect(
      await runCommand(
        'session-end',
        [],
        deps({ readStdin: () => Promise.resolve('{}') }),
      ),
    ).toBe(0);
  });
});

/** Run the stop gate `times` times against a failing verify, returning the last
 *  stdout. Three runs cross the default recurrence threshold, which is the only
 *  condition under which the two dialects' payloads differ. */
async function primeStopGate(
  times: number,
  dialectArguments: string[],
): Promise<string> {
  const stdin = JSON.stringify({ cwd: root, sessionId: 'sid' });
  let last = '';
  for (let run = 0; run < times; run += 1) {
    out.length = 0;
    await runCommand(
      'gate',
      ['--mode=stop', ...dialectArguments],
      deps({
        exec: failingVerifyExec(),
        readStdin: () => Promise.resolve(stdin),
      }),
    );
    last = out.join('');
  }
  return last;
}

describe('cli-core final hardening', () => {
  it('sweeps sessions older than the TTL and keeps fresh ones', async () => {
    // Kills the four SESSION_TTL_MS arithmetic mutants (each shrinks the TTL to
    // milliseconds, sweeping everything) and the `case 'session-start'` block
    // removal (which sweeps nothing).
    const directory = stateDirectory(root);
    mkdirSync(directory, { recursive: true });
    const stale = sessionFile(directory, 'stale');
    const fresh = sessionFile(directory, 'fresh');
    writeFileSync(stale, '{}');
    writeFileSync(fresh, '{}');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(stale, eightDaysAgo, eightDaysAgo);
    // The fresh file must be meaningfully old (but under the TTL), otherwise a
    // mutant that shrinks the TTL to milliseconds still keeps a just-created
    // file and the assertion below passes vacuously.
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(fresh, oneDayAgo, oneDayAgo);

    expect(await runCommand('session-start', [], deps())).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('emits dialect-specific stop payloads once a rule crosses recurrence', async () => {
    // Kills the `dialect === 'copilot'` mutants and the dialect resolution
    // default. The two formatters are byte-identical UNTIL additionalContext is
    // present, which only happens on the run that crosses recurThreshold.
    const copilot = await primeStopGate(3, ['--dialect=copilot']);
    rmSync(stateDirectory(root), { recursive: true, force: true });
    const claude = await primeStopGate(3, []);

    expect(copilot).not.toBe('');
    expect(claude).not.toBe('');
    // Claude carries additionalContext in hookSpecificOutput; Copilot inlines
    // it into `reason` because its hook host has no such field.
    expect(claude).toContain('hookSpecificOutput');
    expect(copilot).not.toContain('hookSpecificOutput');
  });

  it('defaults the session id to "default" across stop, state and session-end', async () => {
    // Kills the `?? 'default'` -> `&&` mutants, which route reads and writes to
    // an `undefined.json` session instead.
    const directory = stateDirectory(root);
    await runCommand(
      'gate',
      ['--mode=stop'],
      deps({
        exec: failingVerifyExec(),
        readStdin: () => Promise.resolve(JSON.stringify({ cwd: root })),
      }),
    );
    expect(loadSession(directory, 'default').attempts).toBe(1);

    out.length = 0;
    await runCommand('state', [], deps());
    expect(out.join('')).toContain('"attempts": 1');

    await runCommand(
      'session-end',
      [],
      deps({ readStdin: () => Promise.resolve('{}') }),
    );
    expect(existsSync(sessionFile(directory, 'default'))).toBe(false);
  });

  it('prints each added suppression found by the commit gate', async () => {
    // Kills the findings-loop block removal: the gate would block with no
    // explanation of WHICH suppression tripped it.
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': [
        '+++ b/src/a.ts',
        '@@ -1,0 +1,1 @@',
        '+// eslint-disable-next-line',
      ].join('\n'),
    });
    expect(await runCommand('gate', ['--mode=commit'], deps({ exec }))).toBe(1);
    expect(errors.join('')).toContain('added eslint-disable');
  });
});

describe('sanctioned suppressions reach the commit gate', () => {
  it('exempts a finding whose key is sanctioned in the policy file', async () => {
    // Kills the `(sanction) => sanction.key` -> `() => undefined` mutants: a
    // list of undefined keys exempts nothing, so the gate would still block.
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({
        sanctionedSuppressions: [
          {
            key: 'src/a.ts|eslint-disable|// eslint-disable-next-line',
            reason: 'reviewed and approved for this fixture',
          },
        ],
      }),
    );
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': [
        '+++ b/src/a.ts',
        '@@ -1,0 +1,1 @@',
        '+// eslint-disable-next-line',
      ].join('\n'),
    });
    expect(await runCommand('gate', ['--mode=commit'], deps({ exec }))).toBe(0);
  });

  it('also forwards sanctions from the pretooluse gate', async () => {
    // The pretooluse path maps the list independently of --mode=commit; kills
    // the second `(sanction) => sanction.key` -> `() => undefined` mutant.
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({
        sanctionedSuppressions: [
          {
            key: 'src/a.ts|eslint-disable|// eslint-disable-next-line',
            reason: 'reviewed and approved for this fixture',
          },
        ],
      }),
    );
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': [
        '+++ b/src/a.ts',
        '@@ -1,0 +1,1 @@',
        '+// eslint-disable-next-line',
      ].join('\n'),
    });
    await runCommand(
      'gate',
      ['--mode=pretooluse', '--dialect=copilot'],
      deps({
        exec,
        readStdin: () =>
          Promise.resolve(preToolUseStdin('bash', 'git commit -m x')),
      }),
    );
    expect(out.join('')).toBe('');
  });
});

/** git fake for sanctions-check: merge-base resolves, `git show` returns the
 *  base revision of the policy file. Records calls for argv/cwd assertions. */
function sanctionsExec(
  baseConfig: string | null,
  mergeBase: ExecResult = ok('BASESHA\n'),
  showCode = 0,
): { exec: Exec; calls: { args: string[]; cwd: string | undefined }[] } {
  const calls: { args: string[]; cwd: string | undefined }[] = [];
  const exec: Exec = (command, args, execOptions) => {
    calls.push({ args, cwd: execOptions?.cwd });
    if (args[0] === 'merge-base') return Promise.resolve(mergeBase);
    if (args[0] === 'show') {
      return Promise.resolve(
        baseConfig === null
          ? { stdout: '', stderr: 'does not exist', code: 128 }
          : { stdout: baseConfig, stderr: '', code: showCode },
      );
    }
    return Promise.resolve(ok(''));
  };
  return { exec, calls };
}

function writeRepoConfig(sanctions: unknown[]): void {
  writeFileSync(
    path.join(root, 'guardrails.config.json'),
    JSON.stringify({ sanctionedSuppressions: sanctions }),
  );
}

const REVIEWED = { key: 'a.ts|cast-any|x', reason: 'proven equivalent' };
const REQUESTED = { key: 'b.ts|cast-any|y', reason: 'newly requested' };

describe('runCommand — sanctions-check (CI approval gate)', () => {
  it('passes when the branch adds no new exemption', async () => {
    writeRepoConfig([REVIEWED]);
    const base = JSON.stringify({ sanctionedSuppressions: [REVIEWED] });
    expect(
      await runCommand(
        'sanctions-check',
        [],
        deps({ exec: sanctionsExec(base).exec }),
      ),
    ).toBe(0);
    expect(errors.join('')).toContain('no new diff-auditor exemptions');
  });

  it('fails and names each newly-requested exemption', async () => {
    writeRepoConfig([REVIEWED, REQUESTED]);
    const base = JSON.stringify({ sanctionedSuppressions: [REVIEWED] });
    expect(
      await runCommand(
        'sanctions-check',
        [],
        deps({ exec: sanctionsExec(base).exec }),
      ),
    ).toBe(1);
    const printed = errors.join('');
    expect(printed).toContain('b.ts|cast-any|y');
    expect(printed).toContain('newly requested');
    expect(printed).toContain('require human approval');
    // The already-approved entry must not be re-reported.
    expect(printed).not.toContain('a.ts|cast-any|x');
  });

  it('treats every entry as new when the base has no policy file', async () => {
    writeRepoConfig([REVIEWED]);
    expect(
      await runCommand(
        'sanctions-check',
        [],
        deps({ exec: sanctionsExec(null).exec }),
      ),
    ).toBe(1);
  });

  it('ignores an unjustified entry, which never takes effect anyway', async () => {
    // No reason => dropped by loadConfig => not an exemption => nothing to approve.
    writeRepoConfig([{ key: 'c.ts|cast-any|z' }]);
    const base = JSON.stringify({ sanctionedSuppressions: [] });
    expect(
      await runCommand(
        'sanctions-check',
        [],
        deps({ exec: sanctionsExec(base).exec }),
      ),
    ).toBe(0);
  });
});

describe('sanctions-check git plumbing', () => {
  it('resolves the merge-base and reads the policy file at that revision', async () => {
    // Kills the argv/cwd/trim mutants: a lost `.trim()` yields the ref
    // "BASESHA\n:guardrails.config.json", and a dropped cwd reads the wrong repo.
    writeRepoConfig([REVIEWED]);
    const base = JSON.stringify({ sanctionedSuppressions: [REVIEWED] });
    const { exec, calls } = sanctionsExec(base);
    await runCommand('sanctions-check', [], deps({ exec }));
    const mergeBaseCall = calls.find((call) => call.args[0] === 'merge-base');
    const showCall = calls.find((call) => call.args[0] === 'show');
    expect(mergeBaseCall?.args).toEqual(['merge-base', 'main', 'HEAD']);
    expect(mergeBaseCall?.cwd).toBe(root);
    expect(showCall?.args).toEqual(['show', 'BASESHA:guardrails.config.json']);
    expect(showCall?.cwd).toBe(root);
  });

  it('falls back to the base branch when merge-base fails or is empty', async () => {
    // Kills the `code === 0 && sha` conditional/logical/equality mutants: each
    // would use a bogus (or empty) ref instead of the branch name.
    writeRepoConfig([REVIEWED]);
    const base = JSON.stringify({ sanctionedSuppressions: [REVIEWED] });

    const failed = sanctionsExec(base, {
      stdout: 'noise\n',
      stderr: '',
      code: 1,
    });
    await runCommand('sanctions-check', [], deps({ exec: failed.exec }));
    expect(failed.calls.find((call) => call.args[0] === 'show')?.args).toEqual([
      'show',
      'main:guardrails.config.json',
    ]);

    const empty = sanctionsExec(base, ok('   \n'));
    await runCommand('sanctions-check', [], deps({ exec: empty.exec }));
    expect(empty.calls.find((call) => call.args[0] === 'show')?.args).toEqual([
      'show',
      'main:guardrails.config.json',
    ]);
  });

  it('ignores the base file contents when git show fails', async () => {
    // Kills `base.code === 0 ? parse : []` -> true. A failed `git show` may
    // still print to stdout; trusting it would silently approve an exemption.
    writeRepoConfig([REVIEWED]);
    const { exec } = sanctionsExec(
      JSON.stringify({ sanctionedSuppressions: [REVIEWED] }),
      ok('BASESHA\n'),
      128,
    );
    expect(await runCommand('sanctions-check', [], deps({ exec }))).toBe(1);
  });
});
