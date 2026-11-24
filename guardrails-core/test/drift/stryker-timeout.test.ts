/**
 * Settles #180: does the push gate score a stryker `Timeout` as a survivor?
 *
 * It does not. A `Timeout` is a detected mutant — stryker's own score counts
 * it with the killed ones — and the adapter's failing statuses are `Survived`
 * and `NoCoverage` only. This test holds that against REAL stryker rather than
 * a hand-written report, because the belief that timeouts block came from
 * real gate runs, and a hand-written report cannot show what stryker writes
 * for a mutant that hangs.
 *
 * The fixture's loop has an `UpdateOperator` mutant (`index++` → `index--`)
 * that never ends, so stryker can only time it out. The branch changes the
 * file without touching the loop, and the gate judges it at the push rung
 * twice:
 *
 * - **cold**, with no cache and no seed, so stryker measures the timeout;
 * - **seeded**, from a report stryker wrote on `main` (the way CI's report
 *   reaches a lane through `mutationCache.seedFrom`), so the timeout verdict
 *   is reused, not re-measured.
 *
 * Both must report nothing, and both reports must hold the `Timeout`, so the
 * test cannot pass on a run whose loop mutant was never generated.
 *
 * Fixture written to a temp directory at run time, and skipped under this
 * repo's own mutation pass, for the reasons `stryker-runner.test.ts` gives.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { type Exec, spawnExec } from '../../src/exec.js';
import { runVerify, writeMutationFingerprint } from '../../src/verify/index.js';
import { describeUnlessMutating } from './under-mutation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const binDirectory = path.join(repoRoot, 'node_modules', '.bin');

const COUNT_SOURCE = `export function countUp(limit: number): number {
  let steps = 0;
  for (let index = 0; index < limit; index++) {
    steps += 1;
  }
  return steps;
}
`;

const COUNT_TEST = `import { describe, expect, it } from 'vitest';

import { countUp } from './src/count.js';

describe('countUp', () => {
  it('counts to its limit', () => {
    expect(countUp(3)).toBe(3);
    expect(countUp(0)).toBe(0);
  });
});
`;

const FIXTURE_MANIFEST = {
  name: 'stryker-timeout-fixture',
  private: true,
  type: 'module',
};

/**
 * A short `timeoutMS`, so the hanging mutant costs seconds, not the
 * default's tens of them.
 */
const STRYKER_CONFIG = {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  reporters: ['json'],
  vitest: { configFile: 'vitest.config.ts' },
  mutate: ['src/count.ts'],
  coverageAnalysis: 'perTest',
  timeoutMS: 1000,
};

/**
The fixture's stryker config with `change` applied, as file text.
*/
function strykerConfigWith(change: Record<string, unknown>): string {
  return `${JSON.stringify({ ...STRYKER_CONFIG, ...change })}\n`;
}

/**
Every analyzer but stryker off, so the verdict is stryker's alone.
*/
const ONLY_STRYKER = {
  eslint: 'off',
  tsc: 'off',
  knip: 'off',
  'npm-peers': 'off',
  'dependency-cruiser': 'off',
  stryker: 'required',
  dupes: 'off',
  complexity: 'off',
} as const;

/** Inherited GIT_* variables are stripped: under a git hook they point at the
 *  REAL repository, and this fixture's git calls would read or write it. The
 *  caller's own variables are kept: the seed command needs
 *  `GUARDRAILS_SEED_DIR`. */
function cleanEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('GIT_')),
  );
}

const exec: Exec = (command, args, options) =>
  spawnExec(command, args, {
    ...options,
    env: cleanEnvironment(options?.env ?? process.env),
  });

async function run(
  directory: string,
  command: string,
  ...args: string[]
): Promise<void> {
  const result = await exec(command, args, { cwd: directory });
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
}

async function buildFixture(): Promise<string> {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'guardrails-stryker-timeout-'),
  );
  const files: Record<string, string> = {
    'src/count.ts': COUNT_SOURCE,
    'count.test.ts': COUNT_TEST,
    '.gitignore': 'node_modules\nreports\n.stryker-tmp\n',
    'package.json': `${JSON.stringify(FIXTURE_MANIFEST)}\n`,
    'vitest.config.ts': `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { include: ['*.test.ts'] } });\n`,
    'stryker.conf.json': strykerConfigWith({}),
  };
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  await symlink(
    path.join(repoRoot, 'node_modules'),
    path.join(directory, 'node_modules'),
    'dir',
  );
  await run(directory, 'git', 'init', '-q', '-b', 'main');
  await run(directory, 'git', 'config', 'user.email', 'test@example.com');
  await run(directory, 'git', 'config', 'user.name', 'Test');
  await run(directory, 'git', 'add', '-A');
  await run(directory, 'git', 'commit', '-q', '-m', 'main');
  return directory;
}

function statusesOf(reportJson: string, file: string): string[] {
  const report = JSON.parse(reportJson) as {
    files: Record<string, { mutants: { status: string }[] }>;
  };
  return (report.files[file]?.mutants ?? []).map((mutant) => mutant.status);
}

function readReport(directory: string): Promise<string> {
  return readFile(
    path.join(directory, 'reports', 'mutation', 'mutation.json'),
    'utf8',
  );
}

/** The push rung's analyzer, over the whole file so the untouched loop is
 *  judged (line ranges would scope it out). */
function pushGate(
  directory: string,
  extra: Partial<Parameters<typeof runVerify>[0]> = {},
): ReturnType<typeof runVerify> {
  return runVerify({
    repoRoot: directory,
    baseBranch: 'main',
    exec,
    profile: 'push',
    analyzers: ONLY_STRYKER,
    resolveBin: (tool) => path.join(binDirectory, tool),
    mutationScope: {
      lines: false,
      padding: 0,
      wholeFileAbove: 0,
      enclosing: false,
    },
    ...extra,
  });
}

/** Runs stryker on `main`, as CI does, and returns a directory holding its
 *  report and fingerprint sidecar: what a seed command copies. */
async function seedFromMain(directory: string): Promise<string> {
  await run(directory, path.join(binDirectory, 'stryker'), 'run');
  const seedDirectory = mkdtempSync(
    path.join(tmpdir(), 'guardrails-stryker-timeout-seed-'),
  );
  const mainReport = await readReport(directory);
  expect(statusesOf(mainReport, 'src/count.ts')).toContain('Timeout');
  writeFileSync(path.join(seedDirectory, 'mutation.json'), mainReport);
  const sidecar = await writeMutationFingerprint(directory, exec, []);
  expect(sidecar).toBeDefined();
  cpSync(
    path.join(directory, String(sidecar)),
    path.join(seedDirectory, 'mutation.fingerprint.json'),
  );
  rmSync(path.join(directory, 'reports'), { recursive: true });
  return seedDirectory;
}

/**
The branch: count.ts changes, its loop does not; `files` change too.
*/
async function branch(
  directory: string,
  files: Record<string, string> = {},
): Promise<void> {
  await run(directory, 'git', 'checkout', '-q', '-b', 'feature');
  writeFileSync(
    path.join(directory, 'src', 'count.ts'),
    `${COUNT_SOURCE}// The loop above is unchanged on this branch.\n`,
  );
  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(path.join(directory, file), contents);
  }
  await run(directory, 'git', 'add', '-A');
  await run(directory, 'git', 'commit', '-q', '-m', 'feature');
}

/**
The push gate with the seed in `seedDirectory`, and its progress lines.
*/
async function seededPushGate(
  directory: string,
  seedDirectory: string,
): Promise<{ violations: unknown[]; progress: string }> {
  const lines: string[] = [];
  const result = await pushGate(directory, {
    mutationCacheSeed: {
      command: `cp "${seedDirectory}"/* "$GUARDRAILS_SEED_DIR"/`,
      timeoutSeconds: 60,
    },
    progress: (line) => {
      lines.push(line);
    },
  });
  return { violations: result.violations, progress: lines.join('\n') };
}

describeUnlessMutating(here)(
  'drift-guard: a stryker Timeout at the push gate',
  () => {
    it('blocks nothing, cold or seeded', async () => {
      const directory = await buildFixture();
      const seedDirectory = await seedFromMain(directory);
      await branch(directory);

      const cold = await pushGate(directory);
      expect(cold.violations).toEqual([]);
      expect(statusesOf(await readReport(directory), 'src/count.ts')).toContain(
        'Timeout',
      );

      rmSync(path.join(directory, 'reports'), { recursive: true });
      const seeded = await seededPushGate(directory, seedDirectory);
      expect(seeded.progress).toContain('seeded the mutation cache from 1');
      expect(seeded.violations).toEqual([]);
      expect(statusesOf(await readReport(directory), 'src/count.ts')).toContain(
        'Timeout',
      );
    }, 600_000);
  },
);

/**
 * #177: a seed survives what cannot change a verdict, through the real gate.
 * The branch adds a `mutate` entry for another module, changes the reporters,
 * adds a formatter devDependency and writes a lockfile -- each of which threw
 * every seed away when the fingerprint hashed the whole config and lockfile.
 * A change to an option that judges mutants still does.
 */
describeUnlessMutating(here)('drift-guard: the seed fingerprint (#177)', () => {
  it('keeps the seed across changes that cannot change a verdict', async () => {
    const directory = await buildFixture();
    const seedDirectory = await seedFromMain(directory);
    await branch(directory, {
      'stryker.conf.json': strykerConfigWith({
        mutate: ['src/count.ts', 'src/other.ts'],
        reporters: ['json', 'clear-text'],
      }),
      'package.json': `${JSON.stringify({ ...FIXTURE_MANIFEST, devDependencies: { prettier: '*' } })}\n`,
      'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n',
    });
    const seeded = await seededPushGate(directory, seedDirectory);
    expect(seeded.progress).toContain('seeded the mutation cache from 1');
    expect(seeded.violations).toEqual([]);
  }, 600_000);

  it('rejects the seed when an option that judges mutants changed', async () => {
    const directory = await buildFixture();
    const seedDirectory = await seedFromMain(directory);
    await branch(directory, {
      'stryker.conf.json': strykerConfigWith({ timeoutMS: 2000 }),
    });
    const seeded = await seededPushGate(directory, seedDirectory);
    expect(seeded.progress).toContain(
      'was measured under different stryker options from this checkout',
    );
  }, 600_000);
});
