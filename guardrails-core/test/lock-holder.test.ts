import { describe, expect, it } from 'vitest';

import { type JsonFileResult, parseJsonText } from '../src/json-file.js';
import {
  describeHolder,
  type Holder,
  holderPath,
  readHolder,
  waitingCount,
} from '../src/lock-holder.js';

const MINUTE = 60_000;

const isAlive = (): boolean => true;

function reading(content: string): () => JsonFileResult {
  return () => parseJsonText(content);
}

function missing(): JsonFileResult {
  return { parsed: undefined };
}

const mutating: Holder = {
  repo: '/Users/someone/dev/dialed-163',
  rung: 'push',
  pid: 4242,
  startedAt: 1_000_000,
  phase: 'mutating',
  tested: 160,
  total: 258,
  reused: 0,
  survived: 3,
  mutatingSince: 1_000_000,
};

describe('holderPath', () => {
  it('puts the holder file beside the lock', () => {
    expect(holderPath('/locks/gate.lock')).toBe('/locks/gate.lock.holder.json');
  });
});

describe('readHolder', () => {
  it('reads a well-formed holder whose pid is alive', () => {
    expect(
      readHolder('/h.json', reading(JSON.stringify(mutating)), isAlive),
    ).toEqual(mutating);
  });

  it('reads a holder with no mutatingSince yet', () => {
    const starting: Holder = {
      repo: '/r/app',
      rung: 'commit',
      pid: 7,
      startedAt: 5,
      phase: 'starting',
      tested: 0,
      total: 0,
      reused: 0,
      survived: 0,
    };
    const read = readHolder(
      '/h.json',
      reading(JSON.stringify(starting)),
      isAlive,
    );
    expect(read).toEqual(starting);
    expect(read).not.toHaveProperty('mutatingSince');
  });

  it('passes the path to the reader and the pid to the liveness check', () => {
    const paths: string[] = [];
    const pids: number[] = [];
    readHolder(
      '/locks/x.holder.json',
      (path) => {
        paths.push(path);
        return parseJsonText(JSON.stringify(mutating));
      },
      (pid) => {
        pids.push(pid);
        return true;
      },
    );
    expect(paths).toEqual(['/locks/x.holder.json']);
    expect(pids).toEqual([4242]);
  });

  it('gives undefined for a missing file', () => {
    expect(readHolder('/h.json', missing, isAlive)).toBeUndefined();
  });

  it('gives undefined for garbage', () => {
    expect(
      readHolder('/h.json', reading('{not json'), isAlive),
    ).toBeUndefined();
  });

  it('gives undefined for JSON that is not an object', () => {
    expect(readHolder('/h.json', reading('[1,2]'), isAlive)).toBeUndefined();
    expect(readHolder('/h.json', reading('null'), isAlive)).toBeUndefined();
    expect(readHolder('/h.json', reading('"x"'), isAlive)).toBeUndefined();
  });

  it('gives undefined for a stale holder whose pid is dead', () => {
    expect(
      readHolder('/h.json', reading(JSON.stringify(mutating)), () => false),
    ).toBeUndefined();
  });

  it.each([
    ['repo', 42],
    ['rung', 'deploy'],
    ['pid', '4242'],
    ['startedAt', 'yesterday'],
    ['phase', 'finishing'],
    ['tested', '1'],
    ['total', undefined],
    ['reused', false],
    ['survived', '0'],
    ['mutatingSince', 'now'],
  ])('gives undefined when %s is %j', (field, value) => {
    const broken = { ...mutating, [field]: value };
    expect(
      readHolder('/h.json', reading(JSON.stringify(broken)), isAlive),
    ).toBeUndefined();
  });

  it('gives undefined for a non-finite number', () => {
    const content = JSON.stringify(mutating).replace(
      '"tested":160',
      '"tested":1e999',
    );
    expect(readHolder('/h.json', reading(content), isAlive)).toBeUndefined();
  });

  it('keeps only the known fields', () => {
    const extra = { ...mutating, secret: 'x' };
    expect(
      readHolder('/h.json', reading(JSON.stringify(extra)), isAlive),
    ).not.toHaveProperty('secret');
  });
});

describe('describeHolder', () => {
  it('names the repo by its basename and the rung', () => {
    const starting: Holder = { ...mutating, phase: 'starting' };
    expect(describeHolder(starting, 2_000_000)).toBe(
      'dialed-163 (push) is starting mutation testing',
    );
  });

  it('describes the dry run', () => {
    const dryRun: Holder = { ...mutating, rung: 'commit', phase: 'dry-run' };
    expect(describeHolder(dryRun, 2_000_000)).toBe(
      'dialed-163 (commit) is running the dry run',
    );
  });

  it('gives progress and the time left while mutating', () => {
    // 160 mutants in 4 minutes is 40/min; 98 remain, about 2.45 minutes.
    expect(describeHolder(mutating, 1_000_000 + 4 * MINUTE)).toBe(
      'dialed-163 (push) is mutating, 62% (160/258), ~2m left',
    );
  });

  it('estimates from the mutants actually run, not the reused ones', () => {
    // 100 reused arrive at once; 60 run in 6 minutes is 10/min; 98 remain.
    const incremental: Holder = { ...mutating, reused: 100 };
    expect(describeHolder(incremental, 1_000_000 + 6 * MINUTE)).toBe(
      'dialed-163 (push) is mutating, 62% (160/258), ~10m left',
    );
  });

  it('says hours when the run is long', () => {
    // 10 mutants in 10 minutes is 1/min; 248 remain, 4h 8m.
    const slow: Holder = { ...mutating, tested: 10 };
    expect(describeHolder(slow, 1_000_000 + 10 * MINUTE)).toBe(
      'dialed-163 (push) is mutating, 3% (10/258), ~4h 8m left',
    );
  });

  it('says under a minute when nearly done', () => {
    const nearly: Holder = { ...mutating, tested: 257 };
    expect(describeHolder(nearly, 1_000_000 + 10 * MINUTE)).toBe(
      'dialed-163 (push) is mutating, 99% (257/258), <1m left',
    );
  });

  it('says one minute, not under a minute, at exactly one minute left', () => {
    // 10 mutants in 10 minutes is 1/min; 1 remains.
    const oneLeft: Holder = { ...mutating, tested: 10, total: 11 };
    expect(describeHolder(oneLeft, 1_000_000 + 10 * MINUTE)).toBe(
      'dialed-163 (push) is mutating, 90% (10/11), ~1m left',
    );
  });

  it('says minutes, not hours, at 59 minutes left', () => {
    const almost: Holder = { ...mutating, tested: 10, total: 69 };
    expect(describeHolder(almost, 1_000_000 + 10 * MINUTE)).toBe(
      'dialed-163 (push) is mutating, 14% (10/69), ~59m left',
    );
  });

  it('says one hour at exactly sixty minutes left', () => {
    const hour: Holder = { ...mutating, tested: 10, total: 70 };
    expect(describeHolder(hour, 1_000_000 + 10 * MINUTE)).toBe(
      'dialed-163 (push) is mutating, 14% (10/70), ~1h 0m left',
    );
  });

  it('omits the time left before any mutant has run', () => {
    const fresh: Holder = { ...mutating, tested: 0 };
    expect(describeHolder(fresh, 1_000_000 + MINUTE)).toBe(
      'dialed-163 (push) is mutating, 0% (0/258)',
    );
  });

  it('omits the time left when only reused mutants are in', () => {
    const reusedOnly: Holder = { ...mutating, tested: 50, reused: 50 };
    expect(describeHolder(reusedOnly, 1_000_000 + MINUTE)).toBe(
      'dialed-163 (push) is mutating, 19% (50/258)',
    );
  });

  it('omits the time left with no mutatingSince', () => {
    const { mutatingSince: _omitted, ...rest } = mutating;
    expect(describeHolder(rest, 1_000_000 + 4 * MINUTE)).toBe(
      'dialed-163 (push) is mutating, 62% (160/258)',
    );
  });

  it('omits the time left when no time has passed', () => {
    expect(describeHolder(mutating, 1_000_000)).toBe(
      'dialed-163 (push) is mutating, 62% (160/258)',
    );
  });

  it('omits the percentage when there is nothing to mutate', () => {
    const empty: Holder = { ...mutating, tested: 0, total: 0 };
    expect(describeHolder(empty, 1_000_000 + MINUTE)).toBe(
      'dialed-163 (push) is mutating',
    );
  });
});

describe('waitingCount', () => {
  const lock = '/Users/me/.guardrails-gate.lock';
  // The holder is stryker, pid 500, started by lockf 400. Two other lockf
  // waiters queue behind it, one flock waiter too; a zero-wait probe and a
  // waiter on a different lock must not count.
  const ps = [
    '  400   300 lockf -k -s -t 10800 /Users/me/.guardrails-gate.lock npx stryker run',
    '  500   400 node /repo/node_modules/.bin/stryker run',
    '  401   301 lockf -k -s -t 60 /Users/me/.guardrails-gate.lock npx stryker run',
    '  402   302 /usr/bin/lockf -k -s -t 10800 /Users/me/.guardrails-gate.lock npx stryker run',
    '  403   303 flock -w 60 -E 75 /Users/me/.guardrails-gate.lock npx stryker run',
    '  404   304 lockf -k -s -t 0 /Users/me/.guardrails-gate.lock true',
    '  405   305 lockf -k -s -t 60 /locks/other.lock npx stryker run',
    '  406   306 lockf -k -s -t 60 /Users/me/.guardrails-gate.lock2 npx stryker run',
    '  407   307 vim /Users/me/.guardrails-gate.lock notes',
    '',
  ].join('\n');

  it('counts the waiters on this lock, excluding the holder and probes', () => {
    expect(waitingCount(ps, lock, 500)).toBe(3);
  });

  it('counts none when only the holder holds the lock', () => {
    const alone = [ps.split('\n', 1)[0], ps.split('\n', 2)[1]].join('\n');
    expect(waitingCount(alone, lock, 500)).toBe(0);
  });

  it('counts every locker when the holder pid is not in the listing', () => {
    expect(waitingCount(ps, lock, 9999)).toBe(4);
  });

  it('counts the waiters on another lock for that lock', () => {
    expect(waitingCount(ps, '/locks/other.lock', 9999)).toBe(1);
  });

  it('skips lines that do not start with a pid and a ppid', () => {
    const garbled = [
      '500 400 node /repo/node_modules/.bin/stryker run',
      'x 300 lockf -k -s -t 60 /Users/me/.guardrails-gate.lock npx stryker run',
      '401 y lockf -k -s -t 60 /Users/me/.guardrails-gate.lock npx stryker run',
    ].join('\n');
    expect(waitingCount(garbled, lock, 500)).toBe(0);
  });

  it('counts none in empty output', () => {
    expect(waitingCount('', lock, 500)).toBe(0);
  });
});
