/**
 * `planRunRanges` against a real repository: a one-line change to a 300-line
 * file mutates only the lines around it (#155's done-criterion), whatever the
 * user's git config does to diff output.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Exec, spawnExec } from '../../src/exec.js';
import {
  DEFAULT_MUTATION_SCOPE,
  mutateEntries,
  planRunRanges,
} from '../../src/verify/mutate-ranges.js';

let root: string;

/**
 * Inherited GIT_* variables are stripped: under a git hook they point at the
 * REAL repository, and this test's git calls would read (or write) it.
 */
function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

const exec: Exec = (command, args, options) =>
  spawnExec(command, args, { ...options, env: cleanEnvironment() });

async function git(...args: string[]): Promise<void> {
  const result = await exec('git', args, { cwd: root });
  expect(result.code, result.stderr).toBe(0);
}

const BIG = Array.from(
  { length: 300 },
  (_, index) => `export const v${index + 1} = ${index};`,
).join('\n');

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-ranges-'));
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  // Settings that would change what `git diff` prints, if the gate let them.
  await git('config', 'diff.noprefix', 'true');
  await git('config', 'color.diff', 'always');
  await git('config', 'diff.mnemonicPrefix', 'true');
  writeFileSync(path.join(root, 'big.ts'), `${BIG}\n`);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  await git('checkout', '-q', '-b', 'feature');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function planned(staged?: 'staged'): Promise<string[]> {
  const plan = await planRunRanges(
    {
      exec,
      repoRoot: root,
      readFile: (filePath) => readFile(filePath, 'utf8'),
    },
    { baseBranch: 'main', changedScope: staged },
    ['big.ts', 'new.ts'],
    DEFAULT_MUTATION_SCOPE,
  );
  return mutateEntries(['big.ts', 'new.ts'], plan);
}

function editLine150(): void {
  const file = path.join(root, 'big.ts');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('v150 = 149', 'v150 = 0'),
  );
}

describe('planRunRanges over a real repository', () => {
  it('mutates the lines around an uncommitted edit, and a new file whole', async () => {
    editLine150();
    writeFileSync(path.join(root, 'new.ts'), 'export const fresh = 1;\n');
    expect(await planned()).toEqual(['big.ts:145-155', 'new.ts']);
  });

  it('reads a committed edit the same way', async () => {
    editLine150();
    await git('commit', '-q', '-am', 'edit');
    expect(await planned()).toEqual(['big.ts:145-155', 'new.ts']);
  });

  it('reads the index alone for a staged run', async () => {
    editLine150();
    await git('add', 'big.ts');
    const file = path.join(root, 'big.ts');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('v10 = 9', 'v10 = 0'),
    );
    expect(await planned('staged')).toEqual(['big.ts:145-155', 'new.ts']);
  });
});

/**
 * `lib.ts`: 300 constants, a `widened` function at lines 100–110 and the
 * `callee` export at lines 200–202, which only `caller.ts` calls.
 */
function writeLibrary(): void {
  const lines = Array.from(
    { length: 300 },
    (_, index) => `export const w${index + 1} = ${index};`,
  );
  lines.splice(
    99,
    11,
    'export function widened(value: number): number {',
    ...Array.from({ length: 9 }, (_, index) => `  value += ${index};`),
    '}',
  );
  lines.splice(
    199,
    3,
    'export function callee(): number {',
    '  return 1;',
    '}',
  );
  writeFileSync(path.join(root, 'lib.ts'), `${lines.join('\n')}\n`);
  writeFileSync(
    path.join(root, 'caller.ts'),
    "import { callee } from './lib.js';\n\nexport const called = callee();\n",
  );
}

async function plannedLibrary(): Promise<string[]> {
  const plan = await planRunRanges(
    {
      exec,
      repoRoot: root,
      readFile: (filePath) => readFile(filePath, 'utf8'),
    },
    { baseBranch: 'main' },
    ['lib.ts'],
    DEFAULT_MUTATION_SCOPE,
  );
  return mutateEntries(['lib.ts'], plan);
}

function editLibrary(from: string, to: string): void {
  const file = path.join(root, 'lib.ts');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(from, () => to),
  );
}

describe('planRunRanges over a real repository, with typescript installed', () => {
  beforeEach(async () => {
    // On the base, so the branch changes it rather than adds it.
    await git('checkout', '-q', 'main');
    writeLibrary();
    await git('add', '-A');
    await git('commit', '-q', '-m', 'library');
    await git('checkout', '-q', '-B', 'feature');
    // This repo's own install, found the way the gate finds a consumer's:
    // through `node_modules` beside the repo's package.json. Ignored, so in
    // no diff.
    writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
    mkdirSync(path.join(root, 'node_modules'));
    symlinkSync(
      path.dirname(
        createRequire(import.meta.url).resolve('typescript/package.json'),
      ),
      path.join(root, 'node_modules', 'typescript'),
      'dir',
    );
  });

  it('widens a one-line edit to the whole function around it', async () => {
    editLibrary('value += 4;', 'value -= 4;');
    expect(await plannedLibrary()).toEqual(['lib.ts:100-110']);
  });

  it('pulls in the declaration of an export whose last caller was deleted', async () => {
    editLibrary('w150 = 149', 'w150 = 0');
    unlinkSync(path.join(root, 'caller.ts'));
    expect(await plannedLibrary()).toEqual([
      'lib.ts:145-155',
      'lib.ts:200-202',
    ]);
  });
});
