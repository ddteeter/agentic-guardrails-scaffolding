import { describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import {
  type BaseReferenceCache,
  resolveEffectiveBase,
  BASE_REFERENCE_TTL_MS,
} from '../src/base-reference.js';

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });
const fails = (code = 1): ExecResult => ({ stdout: '', stderr: '', code });

/**
 * An `Exec` that answers by the command it is given and records every call, so
 * a test can assert that `gh` was NOT reached as easily as that it was.
 */
function fakeExec(answers: Record<string, ExecResult> = {}): {
  exec: Exec;
  calls: string[];
  cwds: (string | undefined)[];
} {
  const calls: string[] = [];
  const cwds: (string | undefined)[] = [];
  const exec: Exec = (command, args, options) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    cwds.push(options?.cwd);
    const key = Object.keys(answers).find((candidate) =>
      line.includes(candidate),
    );
    const answer = key === undefined ? undefined : answers[key];
    if (answer !== undefined) {
      return Promise.resolve(answer);
    }
    if (command === 'git' && args.includes('--abbrev-ref')) {
      return Promise.resolve(ok('feature/child\n'));
    }
    return Promise.resolve(fails());
  };
  return { exec, calls, cwds };
}

function memoryCache(
  seed: Record<string, { base: string | null; at: number }> = {},
): BaseReferenceCache & {
  store: Record<string, { base: string | null; at: number }>;
} {
  const store = { ...seed };
  return {
    store,
    read: () => store,
    write: (branch, entry) => {
      store[branch] = entry;
    },
  };
}

const NOW = 1_000_000;

const gitCannotStart: Exec = () =>
  Promise.resolve({
    stdout: '',
    stderr: '',
    code: 0,
    spawnFailed: true as const,
  });

const gitExitsNonZero: Exec = () =>
  Promise.resolve({ stdout: 'feature/child\n', stderr: '', code: 1 });

const gitAnswersBlankBranch: Exec = (command, args) =>
  Promise.resolve(
    command === 'git' && args.includes('--abbrev-ref') ? ok('\n') : fails(),
  );

describe('resolveEffectiveBase', () => {
  it('prefers an explicit --base over everything else', async () => {
    const { exec, calls } = fakeExec();
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      explicit: 'feature/parent',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved).toEqual({ base: 'feature/parent', source: 'flag' });
    // An explicit answer must cost nothing: no branch lookup, no host call.
    expect(calls).toEqual([]);
  });

  it('reads the PR base when the host can answer', async () => {
    const { exec } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 'feature/parent' })),
    });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved).toEqual({ base: 'feature/parent', source: 'pr' });
  });

  it('falls back to the configured base when gh is not installed', async () => {
    // The silent fallback is safe in the direction that matters: the config
    // base is WIDER, so the run verifies more than it needed to, never less.
    const { exec } = fakeExec({
      'pr view': { stdout: '', stderr: '', code: 1, spawnFailed: true },
    });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved).toEqual({ base: 'main', source: 'config' });
  });

  it('falls back when the branch has no pull request', async () => {
    const { exec } = fakeExec({ 'pr view': fails() });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved).toEqual({ base: 'main', source: 'config' });
  });

  it('falls back when gh answers with something unparseable', async () => {
    const { exec } = fakeExec({ 'pr view': ok('not json at all') });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved).toEqual({ base: 'main', source: 'config' });
  });

  it('falls back when gh answers with a blank base', async () => {
    const { exec } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: ' '.repeat(3) })),
    });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved).toEqual({ base: 'main', source: 'config' });
  });

  it('caches a hit, so the next run does not reach the host', async () => {
    // The Stop rung runs every turn. One network call per branch is the budget.
    const cache = memoryCache();
    const first = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 'feature/parent' })),
    });
    await resolveEffectiveBase({
      exec: first.exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache,
      now: NOW,
    });
    const second = fakeExec();
    const resolved = await resolveEffectiveBase({
      exec: second.exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache,
      now: NOW + 1000,
    });
    expect(resolved).toEqual({ base: 'feature/parent', source: 'pr' });
    expect(second.calls.some((line) => line.includes('pr view'))).toBe(false);
  });

  it('caches a MISS too, so a branch with no PR costs one call, not one per turn', async () => {
    const cache = memoryCache();
    const first = fakeExec({ 'pr view': fails() });
    await resolveEffectiveBase({
      exec: first.exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache,
      now: NOW,
    });
    const second = fakeExec();
    const resolved = await resolveEffectiveBase({
      exec: second.exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache,
      now: NOW + 1000,
    });
    expect(resolved).toEqual({ base: 'main', source: 'config' });
    expect(second.calls.some((line) => line.includes('pr view'))).toBe(false);
  });

  it('re-asks once the cached answer has expired', async () => {
    const cache = memoryCache({
      'feature/child': { base: 'feature/old-parent', at: NOW },
    });
    const { exec, calls } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 'feature/new-parent' })),
    });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache,
      now: NOW + BASE_REFERENCE_TTL_MS + 1,
    });
    expect(resolved).toEqual({ base: 'feature/new-parent', source: 'pr' });
    expect(calls.some((line) => line.includes('pr view'))).toBe(true);
  });

  it('keys the cache by branch, so a sibling branch is not served the wrong base', async () => {
    const cache = memoryCache({
      'some/other-branch': { base: 'feature/unrelated', at: NOW },
    });
    const { exec } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 'feature/parent' })),
    });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache,
      now: NOW,
    });
    expect(resolved.base).toBe('feature/parent');
  });

  it('does not consult the host on a detached HEAD', async () => {
    // A detached checkout has no branch to key a cache by and no branch for
    // `gh pr view` to resolve. CI checks a pull request out exactly this way,
    // and there the configured base is already the right answer.
    const calls: string[] = [];
    const recording: Exec = (command, args) => {
      calls.push([command, ...args].join(' '));
      return Promise.resolve(
        command === 'git' && args.includes('--abbrev-ref')
          ? ok('HEAD\n')
          : fails(),
      );
    };
    const resolved = await resolveEffectiveBase({
      exec: recording,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved).toEqual({ base: 'main', source: 'config' });
    expect(calls.some((line) => line.includes('pr view'))).toBe(false);
  });

  it('never resolves to an empty base', async () => {
    // An empty ref would make `git diff ""` scope to nothing, which is the
    // silent fail-open this whole module has to avoid.
    const { exec } = fakeExec({ 'pr view': ok('{}') });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved.base).toBe('main');
  });
});

/**
 * The failure paths, each distinguished from its neighbour. Every one of these
 * kills a mutant that the happy-path tests above leave alive: a guard that
 * still returns the right answer for the inputs a test happens to use is not a
 * guard anyone has checked.
 */
describe('resolveEffectiveBase failure paths', () => {
  it('uses the configured base when git cannot be started', async () => {
    const exec = gitCannotStart;
    expect(
      await resolveEffectiveBase({
        exec,
        repoRoot: '/repo',
        configBase: 'main',
        cache: memoryCache(),
        now: NOW,
      }),
    ).toEqual({ base: 'main', source: 'config' });
  });

  it('uses the configured base when git exits non-zero', async () => {
    // Distinct from the spawn failure above: `code: 1` with no `spawnFailed`.
    // Together they kill the `||` -> `&&` mutant on the branch-lookup guard,
    // which a single fixture setting BOTH flags cannot.
    const exec = gitExitsNonZero;
    expect(
      await resolveEffectiveBase({
        exec,
        repoRoot: '/repo',
        configBase: 'main',
        cache: memoryCache(),
        now: NOW,
      }),
    ).toEqual({ base: 'main', source: 'config' });
  });

  it('treats an empty branch name as no branch', async () => {
    const exec = gitAnswersBlankBranch;
    expect(
      await resolveEffectiveBase({
        exec,
        repoRoot: '/repo',
        configBase: 'main',
        cache: memoryCache(),
        now: NOW,
      }),
    ).toEqual({ base: 'main', source: 'config' });
  });

  it('separates a gh that cannot start from a gh that answers non-zero', async () => {
    // The `&&` mutant on the gh guard survives any fixture where both halves
    // are true at once, so each half gets its own run.
    const cannotStart = fakeExec({
      'pr view': { stdout: '', stderr: '', code: 0, spawnFailed: true },
    });
    const whenUnstartable = await resolveEffectiveBase({
      exec: cannotStart.exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(whenUnstartable.base).toBe('main');

    const answersNonZero = fakeExec({
      'pr view': {
        stdout: '{"baseRefName":"feature/parent"}',
        stderr: '',
        code: 1,
      },
    });
    const whenNonZero = await resolveEffectiveBase({
      exec: answersNonZero.exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(whenNonZero.base).toBe('main');
  });

  it('treats a JSON array from gh as no answer', async () => {
    // A JSON array answers property reads with `undefined` rather than
    // throwing, so without the record guard it would read as a blank base.
    const { exec } = fakeExec({ 'pr view': ok('[]') });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved.base).toBe('main');
  });

  it('treats a non-string baseRefName as no answer', async () => {
    const { exec } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 7 })),
    });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved.base).toBe('main');
  });
});

describe('resolveEffectiveBase explicit base', () => {
  it('trims a --base that arrived with whitespace', async () => {
    const { exec } = fakeExec();
    expect(
      await resolveEffectiveBase({
        exec,
        repoRoot: '/repo',
        configBase: 'main',
        explicit: '  feature/parent  ',
        cache: memoryCache(),
        now: NOW,
      }),
    ).toEqual({ base: 'feature/parent', source: 'flag' });
  });

  it('ignores a --base that is only whitespace', async () => {
    // An empty explicit ref would scope `git diff` to nothing. It must fall
    // through to the other sources rather than be honoured as given.
    const { exec } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 'feature/parent' })),
    });
    expect(
      await resolveEffectiveBase({
        exec,
        repoRoot: '/repo',
        configBase: 'main',
        explicit: ' '.repeat(3),
        cache: memoryCache(),
        now: NOW,
      }),
    ).toEqual({ base: 'feature/parent', source: 'pr' });
  });
});

describe('resolveEffectiveBase cache lifetime', () => {
  it('treats an answer exactly at the TTL as expired', async () => {
    // The boundary, because `<` and `<=` are one mutation apart and both look
    // right until something pins which one it is.
    const cache = memoryCache({
      'feature/child': { base: 'feature/stale', at: NOW },
    });
    const { exec } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 'feature/fresh' })),
    });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache,
      now: NOW + BASE_REFERENCE_TTL_MS,
    });
    expect(resolved.base).toBe('feature/fresh');
  });

  it('treats an answer one tick inside the TTL as fresh', async () => {
    const cache = memoryCache({
      'feature/child': { base: 'feature/remembered', at: NOW },
    });
    const { exec, calls } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 'feature/fresh' })),
    });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache,
      now: NOW + BASE_REFERENCE_TTL_MS - 1,
    });
    expect(resolved.base).toBe('feature/remembered');
    expect(calls.some((line) => line.includes('pr view'))).toBe(false);
  });

  it('works with no cache at all', async () => {
    // The cache is optional, and every access to it is optional-chained. With
    // none supplied the resolver must still answer, and must still ask.
    const { exec, calls } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 'feature/parent' })),
    });
    expect(
      await resolveEffectiveBase({
        exec,
        repoRoot: '/repo',
        configBase: 'main',
        now: NOW,
      }),
    ).toEqual({ base: 'feature/parent', source: 'pr' });
    expect(calls.some((line) => line.includes('pr view'))).toBe(true);
  });

  it('defaults `now` to the wall clock', async () => {
    // Kills the `??` -> `&&` mutant on the clock default: with `&&`, an absent
    // `now` yields `undefined` and every cached entry reads as expired.
    const cache = memoryCache({
      'feature/child': { base: 'feature/remembered', at: Date.now() },
    });
    const { exec, calls } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 'feature/other' })),
    });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache,
    });
    expect(resolved.base).toBe('feature/remembered');
    expect(calls.some((line) => line.includes('pr view'))).toBe(false);
  });

  it('writes the answer it found into the cache', async () => {
    const cache = memoryCache();
    const { exec } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 'feature/parent' })),
    });
    await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache,
      now: NOW,
    });
    expect(cache.store['feature/child']).toEqual({
      base: 'feature/parent',
      at: NOW,
    });
  });
});

/**
 * The branch-lookup guard, pinned against a host that WOULD answer.
 *
 * Every one of these needs `gh` able to resolve a base, because that is the
 * only way skipping the guard produces a different answer. A fixture where git
 * and gh both fail proves nothing: the run lands on the configured base either
 * way, and every mutant in the guard survives it.
 */
describe('the branch lookup short-circuits before the host is asked', () => {
  const ghWouldAnswer = (git: ExecResult): Exec => {
    return (command, args) => {
      if (command === 'git' && args.includes('--abbrev-ref')) {
        return Promise.resolve(git);
      }
      return Promise.resolve(
        ok(JSON.stringify({ baseRefName: 'feature/parent' })),
      );
    };
  };

  it.each([
    [
      'git could not start',
      { stdout: '', stderr: '', code: 0, spawnFailed: true as const },
    ],
    [
      'git could not start but left output behind',
      {
        stdout: 'feature/child\n',
        stderr: '',
        code: 0,
        spawnFailed: true as const,
      },
    ],
    [
      'git exited non-zero with output',
      { stdout: 'feature/child\n', stderr: '', code: 1 },
    ],
    ['git answered a blank branch', ok('\n')],
    ['git answered a detached HEAD', ok('HEAD\n')],
  ])('uses the configured base when %s', async (_label, git) => {
    const resolved = await resolveEffectiveBase({
      exec: ghWouldAnswer(git),
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved).toEqual({ base: 'main', source: 'config' });
  });
});

describe('the gh guard, pinned against output that would parse', () => {
  it.each([
    [
      'gh could not start',
      {
        stdout: JSON.stringify({ baseRefName: 'feature/parent' }),
        stderr: '',
        code: 0,
        spawnFailed: true as const,
      },
    ],
    [
      'gh exited non-zero',
      {
        stdout: JSON.stringify({ baseRefName: 'feature/parent' }),
        stderr: '',
        code: 1,
      },
    ],
  ])('uses the configured base when %s', async (_label, answer) => {
    // Each fixture carries a PARSEABLE base, so dropping either half of the
    // guard would resolve to `feature/parent` instead of falling back.
    const { exec } = fakeExec({ 'pr view': answer });
    const resolved = await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(resolved).toEqual({ base: 'main', source: 'config' });
  });
});

describe('both commands run in the repository', () => {
  it('passes the repo root as the working directory', async () => {
    // Without this, the cwd option is unobserved: a run that resolved the
    // WRONG repository's branch would look identical to a correct one.
    const { exec, cwds } = fakeExec({
      'pr view': ok(JSON.stringify({ baseRefName: 'feature/parent' })),
    });
    await resolveEffectiveBase({
      exec,
      repoRoot: '/repo',
      configBase: 'main',
      cache: memoryCache(),
      now: NOW,
    });
    expect(cwds).toEqual(['/repo', '/repo']);
  });
});
