/**
 * Drift guard for stryker's MUTATE-SCOPE resolution.
 *
 * Since #69 the analyzer intersects the changed-file set with the positive
 * globs in the consumer's `stryker.conf.json`, so a file no glob covers is
 * reported out-of-scope instead of mutated and blocked. That intersection is
 * computed HERE, with `path.matchesGlob`, while stryker computes its own with
 * `minimatch` (`config/file-matcher.js`, `{ dot: false }` for mutate patterns,
 * on `path.resolve`d absolute paths). Two implementations of one grammar.
 *
 * Agreeing today was measured, not assumed — across braces, extglobs,
 * character classes, `?`, `**` spanning and stryker's own default pattern. But
 * nothing in this repo would notice them diverging, and the failure would be
 * silent in the worst direction: a file the project DID declare in scope
 * quietly dropped from the mutation gate, which under-reports rather than
 * over-reports. That is the one failure this pack exists to prevent, and it is
 * what buys the zero-dependency matcher instead of a `minimatch` dependency.
 *
 * So: a fixture whose `mutate` array exercises the grammar, resolved by REAL
 * stryker, compared against what `applyMutateScope` and `applyMutateNegations`
 * resolve over the same files.
 *
 * `--dryRunOnly` with the `command` runner, because scope resolution happens in
 * `ProjectReader` before any test runs and is runner-independent — the whole
 * probe costs under a second. Stryker names the files it will mutate at debug
 * level; asserting against that log line is deliberate, the same choice
 * `stryker-incremental.test.ts` makes for its reuse summary. This file IS the
 * drift guard, so a reworded log failing here is the loud notice that the
 * behaviour can no longer be observed.
 *
 * Fixture written to a temp directory at run time, and skipped under this
 * repo's own mutation pass, for the reasons `stryker-runner.test.ts` gives.
 */

import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { spawnExec } from '../../src/exec.js';
import {
  applyMutateNegations,
  applyMutateScope,
  strykerMutateNegations,
  strykerMutatePositives,
} from '../../src/verify/index.js';
import { isUnderMutationRun } from './under-mutation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const strykerBin = path.join(repoRoot, 'node_modules', '.bin', 'stryker');

/**
 * The fixture's `mutate` array, exercising every construct the two matchers
 * could disagree about: a brace expansion, an extglob, `**` spanning nested
 * directories, a bare path, and a negation.
 */
const MUTATE = [
  'src/**/*.{ts,tsx}',
  'lib/!(vendor).ts',
  'tools/one.ts',
  '!src/generated/**',
];

/**
 * Every source file in the fixture, repo-relative — the candidate set the
 * gate's own changed-file list plays in production.
 *
 * No dotfiles: stryker's INPUT walk (`resolveInputFileNames`) decides those
 * separately from the mutate patterns, so a dotfile mismatch here would
 * indict the input walk rather than the matcher this guard is about. The
 * matchers' agreement on `dot: false` is pinned by unit tests instead.
 */
const SOURCES = [
  'src/a.ts',
  'src/nested/b.tsx',
  'src/nested/deep/c.ts',
  'src/generated/schema.ts',
  'src/notes.md',
  'lib/keep.ts',
  'lib/vendor.ts',
  'lib/nested/skipped.ts',
  'tools/one.ts',
  'tools/two.ts',
];

/**
 * Stryker's own debug line naming what it resolved, as a JSON array.
 */
const FILES_TO_MUTATE = /Files to mutate: (\[[^\]]*])/;

async function buildFixture(): Promise<string> {
  // Realpath'd: on macOS `mkdtemp` hands back `/var/...` while stryker logs
  // the resolved `/private/var/...`, and the paths below are compared as
  // strings.
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), 'guardrails-stryker-scope-')),
  );
  for (const source of SOURCES) {
    await mkdir(path.join(directory, path.dirname(source)), {
      recursive: true,
    });
    await writeFile(
      path.join(directory, source),
      source.endsWith('.md')
        ? '# not a source file\n'
        : `export const value = (n: number): number => n + 1;\n`,
    );
  }
  await writeFile(
    path.join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'stryker-scope-fixture',
        private: true,
        type: 'module',
        // The `command` runner bases its verdict on this exit code. The dry
        // run has to succeed for stryker to report its scope, and nothing
        // here has a verdict to give.
        scripts: { test: 'node -e ""' },
      },
      undefined,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(directory, 'stryker.conf.json'),
    `${JSON.stringify(
      { testRunner: 'command', reporters: ['json'], mutate: MUTATE },
      undefined,
      2,
    )}\n`,
  );
  await symlink(
    path.join(repoRoot, 'node_modules'),
    path.join(directory, 'node_modules'),
    'dir',
  );
  return directory;
}

/**
 * What stryker itself resolved the fixture's `mutate` array to, as
 * fixture-relative paths.
 */
function parseFilesToMutate(output: string, directory: string): string[] {
  const match = FILES_TO_MUTATE.exec(output);
  if (match?.[1] === undefined) {
    return [];
  }
  const absolute: unknown = JSON.parse(match[1]);
  if (!Array.isArray(absolute)) {
    return [];
  }
  return absolute
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => path.relative(directory, entry))
    .toSorted((left, right) => left.localeCompare(right));
}

describe.skipIf(isUnderMutationRun(here))(
  'drift-guard: stryker mutate-scope resolution',
  () => {
    it('resolves the same scope stryker does', async () => {
      const directory = await buildFixture();
      const run = await spawnExec(
        strykerBin,
        ['run', '--dryRunOnly', '--logLevel', 'debug'],
        { cwd: directory },
      );
      const diagnostic = `stryker exit ${run.code}\n${run.stdout}\n${run.stderr}`;
      expect(run.code, diagnostic).toBe(0);

      const theirs = parseFilesToMutate(
        `${run.stdout}\n${run.stderr}`,
        directory,
      );
      // The fixture's premise. A scope that resolved to everything, or to
      // nothing, would make the comparison below vacuous — so the expected
      // set is spelled out rather than derived.
      expect(theirs, diagnostic).toEqual([
        'lib/keep.ts',
        'src/a.ts',
        'src/nested/b.tsx',
        'src/nested/deep/c.ts',
        'tools/one.ts',
      ]);

      const configJson = JSON.stringify({ mutate: MUTATE });
      const ours = applyMutateNegations(
        applyMutateScope(
          SOURCES,
          strykerMutatePositives(configJson),
          directory,
        ),
        strykerMutateNegations(configJson),
      ).toSorted((left, right) => left.localeCompare(right));

      expect(
        ours,
        'guardrails and stryker no longer resolve the same mutation scope. ' +
          'A file stryker mutates but guardrails excludes is a file the ' +
          'gate silently stopped checking. Compare `path.matchesGlob` ' +
          'against the installed minimatch before releasing.',
      ).toEqual(theirs);
    }, 600_000);
  },
);
