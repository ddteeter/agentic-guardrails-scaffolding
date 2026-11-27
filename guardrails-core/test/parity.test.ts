/**
 * Verdict parity (GR-01). Every fixture under `fixtures/parity/` is a small
 * consumer repository; each is run through four guardrails commands with the
 * REAL analyzers, and the normalised exit code, stdout and stderr are held
 * against a golden recorded at the version this suite was added in.
 *
 * The claim the goldens support is that no later build changes a verdict a
 * TypeScript consumer gets today. So: **no later change may edit a golden.**
 * A golden changes only in its own owner-approved pull request that names the
 * behaviour change (see `docs/releasing.md`). `PARITY_RECORD=1` re-records;
 * without it a missing golden is a failure, never a silent pass.
 *
 * It stands down inside this repository's own mutation run, like the drift
 * guards and for the same reason: nested Stryker and ESLint do not start
 * inside Stryker's sandbox.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { describeUnlessMutating } from './drift/under-mutation.js';
import {
  GOLDEN_DIRECTORY,
  type ParityFixture,
  cleanEnvironment,
  fixtureNames,
  loadFixture,
  materialise,
} from './parity/fixture.js';
import {
  PARITY_COMMANDS,
  type ParityOutcome,
  commandKey,
  runParityCommand,
} from './parity/run.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Closed at module scope, before anything spawns: under a git hook the
// environment carries GIT_DIR and GIT_INDEX_FILE, which override `cwd` and
// would point a fixture's git calls at this repository (#223).
process.env = cleanEnvironment();
// A lock of this suite's own. The real Stryker run in the `stryker` fixture
// must never find the machine-wide lock busy with another test's run: the
// commit rung answers a busy lock by deferring, which is a different verdict.
process.env.GUARDRAILS_GATE_LOCK = path.join(
  tmpdir(),
  `guardrails-parity-${String(process.pid)}.lock`,
);

const isRecording = process.env.PARITY_RECORD === '1';
const only = process.env.PARITY_ONLY;

type Golden = Record<string, ParityOutcome>;

function goldenPath(name: string): string {
  return path.join(GOLDEN_DIRECTORY, `${name}.json`);
}

function readGolden(name: string): Golden {
  return JSON.parse(readFileSync(goldenPath(name), 'utf8')) as Golden;
}

/**
 * How many fixtures run their tools at once. Each fixture spawns real
 * analyzers (one of them a whole Stryker run), and the rest of the suite
 * holds timing-sensitive guards of its own: five fixtures at once on a
 * four-core machine starved `drift/stryker-timeout.test.ts` into a retest
 * it asserts does not happen.
 */
const FIXTURES_AT_ONCE = 2;

let running = 0;
const waiting: (() => void)[] = [];

/**
`run`, once fewer than `FIXTURES_AT_ONCE` others are running.
*/
async function inTurn<Result>(run: () => Promise<Result>): Promise<Result> {
  while (running >= FIXTURES_AT_ONCE) {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  }
  running += 1;
  try {
    return await run();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * Every command against a fresh copy of the fixture, so no rung reads state
 * another wrote: the push rung remembers a passing tree, and a blocked gate
 * leaves a manifest behind.
 */
async function runFixture(
  name: string,
  configure: (fixture: ParityFixture) => ParityFixture = (fixture) => fixture,
): Promise<Golden> {
  const fixture = configure(loadFixture(name));
  return inTurn(async () => {
    const outcomes: Golden = {};
    // In order, never at once: the four share one mutation lock.
    for (const argv of PARITY_COMMANDS) {
      const root = materialise(fixture);
      try {
        outcomes[commandKey(argv)] = await runParityCommand(root, argv);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    return outcomes;
  });
}

const names = fixtureNames().filter(
  (name) => only === undefined || name === only,
);

describeUnlessMutating(here)('verdict parity with the recorded goldens', () => {
  it('has a golden for every fixture and a fixture for every golden', () => {
    const goldens = readdirSync(GOLDEN_DIRECTORY)
      .map((file) => file.slice(0, -'.json'.length))
      .toSorted((left, right) => left.localeCompare(right));
    expect(isRecording ? fixtureNames() : goldens).toEqual(fixtureNames());
  });

  it.concurrent.each(names)(
    '%s: every rung answers as recorded',
    async (name) => {
      const outcomes = await runFixture(name);
      if (isRecording) {
        writeFileSync(
          goldenPath(name),
          `${JSON.stringify(outcomes, undefined, 2)}\n`,
        );
      }
      expect(existsSync(goldenPath(name))).toBe(true);
      expect(outcomes).toEqual(readGolden(name));
    },
    600_000,
  );
});

const CONFIG_FILE = 'guardrails.config.json';

/**
 * The fixture, with the stack every repository has implicitly written out in
 * its config: one TypeScript stack at the root that always runs its
 * whole-project analyzers.
 */
function withExplicitTypescriptStack(fixture: ParityFixture): ParityFixture {
  const config = JSON.parse(fixture.base[CONFIG_FILE] ?? '{}') as Record<
    string,
    unknown
  >;
  return {
    ...fixture,
    base: {
      ...fixture.base,
      [CONFIG_FILE]: JSON.stringify({
        ...config,
        stacks: [
          { pack: 'typescript', root: '.', wholeProjectTrigger: 'always' },
        ],
      }),
    },
  };
}

/**
 * `outcomes` without the one thing a `stacks` key adds: each violation's
 * `stack` stamp. Returns how many stamps it removed, so a run that silently
 * ignored the key cannot pass as one that honoured it.
 */
function withoutStackStamps(outcomes: Golden): {
  outcomes: Golden;
  stamps: number;
} {
  let stamps = 0;
  const unstamped = JSON.parse(
    JSON.stringify(outcomes, (key, value: unknown) => {
      if (key === 'stack' && value === 'typescript') {
        stamps += 1;
        return;
      }
      return value;
    }),
  ) as Golden;
  return { outcomes: unstamped, stamps };
}

describeUnlessMutating(here)(
  'a TypeScript-only stacks block reproduces the goldens',
  () => {
    it.concurrent.each(names)(
      '%s: every rung answers as recorded, the stack stamp aside',
      async (name) => {
        const { outcomes } = withoutStackStamps(
          await runFixture(name, withExplicitTypescriptStack),
        );
        expect(outcomes).toEqual(readGolden(name));
      },
      600_000,
    );

    it('stamps each analyzer violation, so the block was read and not ignored', async () => {
      const { stamps } = withoutStackStamps(
        await runFixture('eslint', withExplicitTypescriptStack),
      );
      // One violation in the manifest of each of the three gate rungs.
      expect(stamps).toBe(3);
    }, 600_000);
  },
);

describeUnlessMutating(here)(
  'the commit rung judges what is committed, not what is on disk',
  () => {
    it('refuses a staged file whose working copy was edited, where it used to pass', async () => {
      // The `dupes` fixture stages two files holding the same function, which
      // blocks. Editing one working copy (unstaged) used to make the gate
      // pass: the clone detector reads the file on disk, and the clone there
      // was gone, while the commit still held it.
      const root = materialise(loadFixture('dupes'));
      try {
        writeFileSync(
          path.join(root, 'src', 'sum-b.ts'),
          'export function sumB(): number {\n  return 1;\n}\n',
        );
        const outcome = await inTurn(() =>
          runParityCommand(root, ['gate', '--mode=commit']),
        );
        expect(outcome.exitCode).toBe(1);
        expect(outcome.stderr[0]).toBe(
          'src/sum-b.ts:? [guardrails/staged-differs] src/sum-b.ts is ' +
            'staged, and the file on disk has changes that are not staged. ' +
            'The gate reads files from disk, so it would be judging content ' +
            'this commit does not hold. Stage the rest (`git add ' +
            'src/sum-b.ts`) or set it aside (`git stash --keep-index`), ' +
            'then commit again. (guardrails)',
        );
        // Refused before any analyzer ran: the clone finding is not there.
        expect(outcome.stderr.join('\n')).not.toContain('code-duplication');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 600_000);
  },
);
