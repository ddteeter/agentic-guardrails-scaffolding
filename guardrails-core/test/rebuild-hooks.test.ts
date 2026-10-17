/**
 * This repo's own hooks run `guardrails-core/dist`, which is gitignored and
 * rebuilt only by `npm install` or `npm run build`. Twice now a pull brought a
 * gate fix that the gate then did not have, because nothing rebuilt `dist/`
 * (plan.md: "The hooks in this checkout run a stale `dist/`"). The husky
 * post-merge / post-checkout / post-rewrite hooks close that, and these tests
 * drive them through REAL git operations, so what is under test is what git
 * actually passes them -- not what its documentation suggests it passes.
 *
 * `npm` is a stub first on PATH that logs each call, so "did it build" is a
 * line count and nothing here runs a real build.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// This suite runs under the pre-push hook, and git exports GIT_DIR /
// GIT_INDEX_FILE into hook processes; inherited, they would point every git
// call below -- and every git call the hooks under test make -- at the REAL
// repository. Scrub them before anything spawns.
process.env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

const repoRoot = path.join(import.meta.dirname, '..', '..');
const HOOKS = ['post-merge', 'post-checkout', 'post-rewrite'] as const;
const SCRIPT = path.join('scripts', 'rebuild-if-changed.sh');

/**
Every path whose change can leave a gitignored build output stale.
*/
const BUILD_INPUTS = [
  'guardrails-core/src/index.ts',
  'guardrails-core/package.json',
  'guardrails-core/tsup.config.ts',
  'guardrails-core/tsconfig.json',
  'guardrails-core/tsconfig.build.json',
  'tsconfig.base.json',
  'package.json',
  'package-lock.json',
  'scripts/sync-agents.mjs',
  'guardrails-plugin/agents/guardrail-fixer.md',
  'guardrails-plugin/skills/example/SKILL.md',
] as const;

let sandbox: string;
let checkout: string;
let npmLog: string;
let environment: NodeJS.ProcessEnv;

function git(...args: string[]): ReturnType<typeof spawnSync> {
  const result = spawnSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8',
    env: environment,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result;
}

function write(relative: string, content: string): void {
  const file = path.join(checkout, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function commitChange(relative: string, message: string): void {
  write(relative, `${message}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', message);
}

/**
How many times the hooks ran `npm run build` so far.
*/
function builds(): number {
  if (!existsSync(npmLog)) {
    return 0;
  }
  return readFileSync(npmLog, 'utf8')
    .split('\n')
    .filter((line) => line === 'run build').length;
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'guardrails-rebuild-hooks-'));
  checkout = path.join(sandbox, 'checkout');
  npmLog = path.join(sandbox, 'npm.log');

  const bin = path.join(sandbox, 'bin');
  mkdirSync(bin);
  const npm = path.join(bin, 'npm');
  writeFileSync(
    npm,
    '#!/bin/sh\necho "$*" >> "$NPM_LOG"\necho "stub build output"\nexit "${FAKE_EXIT:-0}"\n',
  );
  chmodSync(npm, 0o755);

  // git runs a hook from the root of the worktree it fires in, which is where
  // the committed `.husky/` copy lives -- so `git worktree add` runs the new
  // worktree's copy, exactly as it would in the real repo.
  const hooks = path.join(sandbox, 'hooks');
  mkdirSync(hooks);
  for (const hook of HOOKS) {
    const wrapper = path.join(hooks, hook);
    writeFileSync(wrapper, `#!/bin/sh\nexec sh ".husky/${hook}" "$@"\n`);
    chmodSync(wrapper, 0o755);
  }

  environment = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    NPM_LOG: npmLog,
  };

  mkdirSync(checkout);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  for (const relative of [...HOOKS.map((hook) => `.husky/${hook}`), SCRIPT]) {
    mkdirSync(path.dirname(path.join(checkout, relative)), { recursive: true });
    copyFileSync(path.join(repoRoot, relative), path.join(checkout, relative));
  }
  for (const input of BUILD_INPUTS) {
    write(input, 'initial\n');
  }
  write('README.md', 'initial\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  // Installed only now, so building the fixture fires nothing.
  git('config', 'core.hooksPath', hooks);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('post-merge (git pull, merge or fast-forward)', () => {
  it('rebuilds when guardrails-core/src changed', () => {
    git('switch', '-q', '-c', 'upstream');
    commitChange('guardrails-core/src/index.ts', 'gate fix');
    git('switch', '-q', 'main');
    const before = builds();

    git('merge', '-q', '--ff-only', 'upstream');

    expect(builds() - before).toBe(1);
  });

  it('does not rebuild when nothing it builds from changed', () => {
    git('switch', '-q', '-c', 'upstream');
    commitChange('README.md', 'docs only');
    git('switch', '-q', 'main');

    git('merge', '-q', '--ff-only', 'upstream');

    expect(builds()).toBe(0);
  });

  it.each(BUILD_INPUTS)('rebuilds when %s changed', (input) => {
    git('switch', '-q', '-c', 'upstream');
    commitChange(input, 'input change');
    git('switch', '-q', 'main');
    const before = builds();

    git('merge', '-q', '--ff-only', 'upstream');

    expect(builds() - before).toBe(1);
  });

  it('rebuilds after a true (non-fast-forward) merge', () => {
    git('switch', '-q', '-c', 'upstream');
    commitChange('guardrails-core/src/index.ts', 'gate fix');
    git('switch', '-q', 'main');
    commitChange('README.md', 'local docs');
    const before = builds();

    git('merge', '-q', '--no-edit', 'upstream');

    expect(builds() - before).toBe(1);
  });
});

describe('post-checkout (branch switches, worktree add)', () => {
  it('rebuilds on a switch across a src change', () => {
    git('switch', '-q', '-c', 'feature');
    commitChange('guardrails-core/src/index.ts', 'feature work');
    const before = builds();

    git('switch', '-q', 'main');

    expect(builds() - before).toBe(1);
  });

  it('does not rebuild on a switch that leaves the inputs alone', () => {
    git('switch', '-q', '-c', 'feature');
    commitChange('README.md', 'docs only');

    git('switch', '-q', 'main');

    expect(builds()).toBe(0);
  });

  it('does not rebuild on a new branch at the same commit', () => {
    git('switch', '-q', '-c', 'feature');

    expect(builds()).toBe(0);
  });

  it('does not rebuild on a file checkout', () => {
    write('guardrails-core/src/index.ts', 'uncommitted\n');

    git('checkout', '-q', 'HEAD', '--', 'guardrails-core/src/index.ts');

    expect(builds()).toBe(0);
  });

  it('does not rebuild on git worktree add (no old tree; npm install builds)', () => {
    git('worktree', 'add', '-q', path.join(sandbox, 'second'));

    expect(builds()).toBe(0);
  });
});

describe('post-rewrite (git pull --rebase with local work, amend)', () => {
  it('rebuilds exactly once when a rebase brings in a src change', () => {
    // Rebase fires post-checkout onto the new base AND post-rewrite at the
    // end; building on both would double the cost of every rebasing pull.
    git('switch', '-q', '-c', 'upstream');
    commitChange('guardrails-core/src/index.ts', 'gate fix');
    git('switch', '-q', 'main');
    commitChange('README.md', 'local work');
    const before = builds();

    git('rebase', '-q', 'upstream');

    expect(builds() - before).toBe(1);
  });

  it('does not rebuild when the rebase brings in nothing it builds from', () => {
    git('switch', '-q', '-c', 'upstream');
    commitChange('README.md', 'upstream docs');
    git('switch', '-q', 'main');
    commitChange('notes.md', 'local notes');
    const before = builds();

    git('rebase', '-q', 'upstream');

    expect(builds() - before).toBe(0);
  });

  it('rebuilds when an amend changes src', () => {
    write('guardrails-core/src/index.ts', 'amended\n');
    git('add', '-A');

    git('commit', '-q', '--amend', '--no-edit');

    expect(builds()).toBe(1);
  });

  it('does not rebuild when an amend only rewords', () => {
    git('commit', '-q', '--amend', '-m', 'reworded');

    expect(builds()).toBe(0);
  });
});

describe('a failed build', () => {
  it('fails the hook loudly and says how to recover', () => {
    git('switch', '-q', '-c', 'feature');
    commitChange('guardrails-core/src/index.ts', 'feature work');
    const feature = String(git('rev-parse', 'HEAD').stdout).trim();
    git('switch', '-q', 'main');
    const main = String(git('rev-parse', 'HEAD').stdout).trim();

    const result = spawnSync(
      'sh',
      [path.join('.husky', 'post-checkout'), feature, main, '1'],
      {
        cwd: checkout,
        encoding: 'utf8',
        env: { ...environment, FAKE_EXIT: '1' },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('stub build output');
    expect(result.stderr).toContain('npm run build');
  });
});
