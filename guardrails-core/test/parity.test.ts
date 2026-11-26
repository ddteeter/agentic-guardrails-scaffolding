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
 * Every command against a fresh copy of the fixture, so no rung reads state
 * another wrote: the push rung remembers a passing tree, and a blocked gate
 * leaves a manifest behind.
 */
async function runFixture(name: string): Promise<Golden> {
  const fixture = loadFixture(name);
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
