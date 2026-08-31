/**
 * `guardrails init` end to end, against a real temporary repository.
 *
 * The unit-level pieces (detect, plan, merge, apply, the desired map) each have
 * their own tests; what only this file can prove is the assembly -- above all
 * the ONE safety property the command exists to guarantee: it never writes
 * unless `--apply` was passed.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type CliDeps, runCommand } from '../../src/cli-core.js';
import type { Exec, ExecResult } from '../../src/exec.js';

interface ExecCall {
  readonly line: string;
  readonly cwd: string | undefined;
}

let root: string;
let out: string[];
let errors: string[];
let execCalls: ExecCall[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-init-'));
  out = [];
  errors = [];
  execCalls = [];
});

function execLines(): string[] {
  return execCalls.map((call) => call.line);
}

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

/** git as `detect` sees it: a toplevel at the fixture, an origin/HEAD, and no
 *  `core.hooksPath` yet. Every invocation is recorded so the tests can assert
 *  what `--apply` did (and, just as importantly, what a plan run did not). */
const gitExec: Exec = (command, args, options) => {
  const line = [command, ...args].join(' ');
  execCalls.push({ line, cwd: options?.cwd });
  if (line.includes('--show-toplevel')) {
    return Promise.resolve(ok(`${root}\n`));
  }
  if (line.includes('symbolic-ref')) {
    return Promise.resolve(ok('origin/main\n'));
  }
  return Promise.resolve(ok(''));
};

function deps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: root,
    exec: gitExec,
    readStdin: () => Promise.resolve(''),
    stdout: (text) => out.push(text),
    stderr: (text) => errors.push(text),
    ...over,
  };
}

function init(...rest: string[]): Promise<number> {
  return runCommand('init', rest, deps());
}

function read(relative: string): string {
  return readFileSync(path.join(root, relative), 'utf8');
}

const HOOK = '.githooks/pre-commit';
const HOOKS_WRITE = 'git config core.hooksPath .githooks';

const EXPECTED_WRITES = [
  '.claude/agents/guardrail-fixer.md',
  '.claude/agents/guardrail-fixer-thorough.md',
  '.claude/settings.json',
  '.github/agents/guardrail-fixer.agent.md',
  '.github/agents/guardrail-fixer-thorough.agent.md',
  '.github/hooks/guardrails.json',
  HOOK,
  '.gitignore',
  'package.json',
  'guardrails.config.json',
  '.guardrails/scaffold.json',
] as const;

describe('init — never writes without --apply', () => {
  it('leaves the repository byte-for-byte untouched and prints a plan', async () => {
    // THE safety property. `init` with no TTY is identical to `--plan`.
    expect(await init()).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    expect(out.join('')).toContain(HOOK);
    expect(out.join('')).toContain('--apply');
  });

  it('is still read-only when --plan is combined with --force', async () => {
    expect(await init('--plan', '--force')).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });

  it('never asks git to repoint core.hooksPath on a plan run', async () => {
    // `detect` READS core.hooksPath on every run; only the write must be absent.
    await init('--plan');
    expect(execLines()).not.toContain(HOOKS_WRITE);
  });
});

describe('init --plan --json', () => {
  it('emits parseable JSON carrying the planned actions', async () => {
    expect(await init('--plan', '--json')).toBe(0);
    const report: unknown = JSON.parse(out.join(''));
    expect(report).toHaveProperty('actions');
    const { actions, repoRoot } = report as {
      actions: { path: string; kind: string; fileClass: string }[];
      repoRoot: string;
    };
    expect(repoRoot).toBe(root);
    const hook = actions.find((action) => action.path === HOOK);
    expect(hook?.kind).toBe('create');
    expect(hook?.fileClass).toBe('owned');
  });
});

describe('init --apply', () => {
  it.each(EXPECTED_WRITES)('writes %s', async (relative) => {
    expect(await init('--apply')).toBe(0);
    expect(read(relative).length).toBeGreaterThan(0);
  });

  it('writes real .gitignore content, not the SHARED-merger placeholder marker', async () => {
    // `.gitignore`'s desired value is a placeholder marker string that
    // `mergeGitignore` ignores entirely (see templates.ts's `MERGER_DERIVED`)
    // -- if `.gitignore` were ever demoted from SHARED_MERGERS, `classifyFile`
    // would read it as OWNED and write that literal marker text into a
    // consumer's `.gitignore`. The file would still be non-empty, so a bare
    // `.length > 0` check (see the EXPECTED_WRITES table above) would not
    // catch it; only asserting the real content does.
    await init('--apply');
    const gitignore = read('.gitignore');
    expect(gitignore).toContain('.guardrails/state/');
    expect(gitignore).toContain('reports/mutation/');
    expect(gitignore).toContain('.stryker-tmp/');
    expect(gitignore).not.toContain(
      'derived from the file already in the repository',
    );
  });

  it('copies the packaged guidance docs into docs/guardrails', async () => {
    await init('--apply');
    expect(read('docs/guardrails/crushing-mutants.md')).toContain(
      'Crushing mutants',
    );
  });

  it('makes the git hook executable', async () => {
    // A hook without the executable bit is silently skipped by git, which
    // looks exactly like a working install until the gate never fires.
    await init('--apply');
    expect(statSync(path.join(root, HOOK)).mode & 0o111).not.toBe(0);
  });

  it('does not make ordinary scaffolded files executable', async () => {
    await init('--apply');
    expect(statSync(path.join(root, '.gitignore')).mode & 0o111).toBe(0);
  });

  it('points core.hooksPath at the scaffolded hook directory', async () => {
    await init('--apply');
    // The cwd is the point: `core.hooksPath` is per-clone local config, so
    // setting it anywhere but the repo git resolved would configure the wrong
    // repository (or none).
    expect(execCalls).toContainEqual({ line: HOOKS_WRITE, cwd: root });
  });

  it('wires our installer into package.json without losing the consumer script', async () => {
    writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'consumer', scripts: { prepare: 'husky' } }, undefined, 2)}\n`,
    );
    await init('--apply');
    const parsed: unknown = JSON.parse(read('package.json'));
    expect(parsed).toEqual({
      name: 'consumer',
      scripts: { prepare: 'husky && guardrails install-hooks' },
    });
  });

  it('writes a real, parseable package.json on a repo with no package.json yet', async () => {
    // The EXPECTED_WRITES table above only proves `package.json` ends up
    // non-empty; the case above only exercises a repo that ALREADY has one.
    // Neither would catch `package.json`'s desired value being the SHARED-
    // merger placeholder marker (see the `.gitignore` test above) landing
    // literally in a brand-new consumer's file -- only parsing it does.
    await init('--apply');
    const parsed: unknown = JSON.parse(read('package.json'));
    expect(parsed).toEqual({
      scripts: { prepare: 'guardrails install-hooks' },
    });
  });

  it('names every file it wrote and does not claim there was nothing to do', async () => {
    await init('--apply');
    expect(out.join('')).toContain(`wrote: ${HOOK}`);
    expect(out.join('')).toContain('file(s)');
    expect(out.join('')).not.toContain('nothing to do');
  });

  it('reports the applied result as JSON under --json', async () => {
    expect(await init('--apply', '--json')).toBe(0);
    const report: unknown = JSON.parse(out.join(''));
    const { written, skipped, warnings } = report as {
      written: string[];
      skipped: string[];
      warnings: string[];
    };
    expect(written).toContain(HOOK);
    expect(written).toContain('.guardrails/scaffold.json');
    expect(skipped).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('records a checksum per owned file in the committed manifest', async () => {
    await init('--apply');
    const manifest: unknown = JSON.parse(read('.guardrails/scaffold.json'));
    const { files } = manifest as { files: Record<string, string> };
    expect(Object.keys(files)).toContain(HOOK);
    expect(files[HOOK]).toMatch(/^sha256-[0-9a-f]{64}$/);
  });
});

describe('init --apply — idempotency', () => {
  it('reports nothing to do on a second run and writes nothing new', async () => {
    await init('--apply');
    const before = read(HOOK);
    const settingsBefore = read('.claude/settings.json');
    out = [];
    execCalls = [];

    expect(await init('--apply')).toBe(0);
    expect(out.join('')).toContain('nothing to do');
    expect(read(HOOK)).toBe(before);
    expect(read('.claude/settings.json')).toBe(settingsBefore);
    expect(execLines()).not.toContain(HOOKS_WRITE);
  });
});

describe('init --apply — drift on a consumer-edited owned file', () => {
  it('leaves the edit alone and reports it', async () => {
    await init('--apply');
    writeFileSync(path.join(root, HOOK), '#!/bin/sh\necho mine\n');
    out = [];
    errors = [];

    expect(await init('--apply')).toBe(0);
    expect(read(HOOK)).toBe('#!/bin/sh\necho mine\n');
    expect(errors.join('')).toContain('drifted');
    expect(errors.join('')).toContain('--force');
  });

  it('overwrites it with --force', async () => {
    await init('--apply');
    const scaffolded = read(HOOK);
    writeFileSync(path.join(root, HOOK), '#!/bin/sh\necho mine\n');

    expect(await init('--apply', '--force')).toBe(0);
    expect(read(HOOK)).toBe(scaffolded);
  });
});

describe('init --apply — seed-once analyzer configs', () => {
  it('seeds .dependency-cruiser.cjs when the analyzer is required', async () => {
    expect(
      await init('--apply', '--analyzers=dependency-cruiser=required'),
    ).toBe(0);
    expect(read('.dependency-cruiser.cjs')).toContain('no-circular');
  });

  it('never adds a second config for a consumer who already has .dependency-cruiser.js', async () => {
    // detect probes `.dependency-cruiser.{cjs,js,json}`; the seed-once key is
    // `.cjs` only. Without gating on the FACT, this consumer would end up with
    // two dependency-cruiser configs, one of them silently ignored.
    writeFileSync(
      path.join(root, '.dependency-cruiser.js'),
      'module.exports = { forbidden: [] };\n',
    );
    expect(
      await init('--apply', '--analyzers=dependency-cruiser=required'),
    ).toBe(0);
    expect(readdirSync(root)).not.toContain('.dependency-cruiser.cjs');
  });

  it('never rewrites a guardrails.config.json the consumer already has', async () => {
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      '{ "enforcement": "block" }\n',
    );
    await init('--apply', '--enforcement=warn');
    expect(read('guardrails.config.json')).toBe('{ "enforcement": "block" }\n');
  });
});

describe('init --help', () => {
  it('prints usage and exits 0, unlike an unrecognised flag', async () => {
    // An explicit request for help asking `--help` is not a mistake the way
    // `--nope` is -- it should read as "show me the usage", not fail the way
    // every other unrecognised option does.
    expect(await init('--help')).toBe(0);
    expect(out.join('')).toContain('usage: guardrails init');
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('init — flag validation', () => {
  it.each([['--nope'], ['--applyy'], ['-p'], ['--analyzers']])(
    'rejects %s with usage and a non-zero exit',
    async (argument) => {
      expect(await init(argument)).toBe(1);
      expect(errors.join('')).toContain('usage: guardrails init');
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it.each([
    ['--enforcement=loud'],
    ['--distribution=duo'],
    ['--analyzers=stryker=maybe'],
    ['--analyzers=not-an-analyzer=off'],
    ['--analyzers=off'],
  ])('rejects the invalid value in %s', async (argument) => {
    expect(await init('--apply', argument)).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses --plan and --apply together rather than guessing', async () => {
    expect(await init('--plan', '--apply')).toBe(1);
    expect(errors.join('')).toContain('mutually exclusive');
    expect(readdirSync(root)).toEqual([]);
  });

  it('accepts every documented flag together', async () => {
    expect(
      await init(
        '--apply',
        '--json',
        '--force',
        '--enforcement=block',
        '--distribution=team',
        '--analyzers=stryker=off,knip=required',
      ),
    ).toBe(0);
    const config: unknown = JSON.parse(read('guardrails.config.json'));
    expect(config).toMatchObject({
      enforcement: 'block',
      distribution: 'team',
      analyzers: { stryker: 'off', knip: 'required' },
    });
  });
});

describe('init — orphan files from an older scaffold', () => {
  it('leaves a file guardrails no longer ships in place, unreported', async () => {
    // Characterisation, NOT an endorsement: removing files from a consumer's
    // repository is a decision that needs its own design, so `init` currently
    // neither reports nor deletes an orphan. Recorded as a follow-up.
    mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(path.join(root, '.claude/agents/retired.md'), 'old\n');
    mkdirSync(path.join(root, '.guardrails'), { recursive: true });
    writeFileSync(
      path.join(root, '.guardrails/scaffold.json'),
      `${JSON.stringify({
        guardrailsVersion: '0.0.1',
        files: { '.claude/agents/retired.md': 'sha256-stale' },
      })}\n`,
    );

    await init('--apply');
    expect(read('.claude/agents/retired.md')).toBe('old\n');
    expect(`${out.join('')}${errors.join('')}`).not.toContain('retired.md');

    // The orphan's manifest entry is not just left alone -- `writeManifest`
    // spreads the existing entries under the fresh ones, so nothing ever
    // drops it. Pinned here, not just inferred from the file being left in
    // place: a future change that started pruning dead manifest keys while
    // still leaving the orphaned file on disk would pass every assertion
    // above and only fail this one.
    const manifest: unknown = JSON.parse(read('.guardrails/scaffold.json'));
    const { files } = manifest as { files: Record<string, string> };
    expect(files['.claude/agents/retired.md']).toBe('sha256-stale');
  });
});

describe('init — the usage banner', () => {
  it('lists init among the commands', async () => {
    expect(await runCommand('bogus-command', [], deps())).toBe(1);
    expect(errors.join('')).toContain('init');
  });
});
