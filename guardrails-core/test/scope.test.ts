import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectManifestScope,
  collectSessionScope,
  isWithinRepo,
} from '../src/scope.js';
import { LEASE_TTL_MS } from '../src/state.js';
import { stateDirectory, writeViolations } from '../src/state-store.js';
import type { Violation } from '../src/violation.js';

let root: string;
let directory: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-scope-'));
  directory = stateDirectory(root);
  mkdirSync(directory, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function v(file: string, ruleId = 'x'): Violation {
  return {
    ruleId,
    file,
    message: 'm',
    severity: 'error',
    fixable: false,
    tool: 'eslint',
  };
}

function activate(sessionId: string): void {
  writeFileSync(path.join(directory, `${sessionId}.pre-fix.json`), '[]');
}

function writeActiveViolations(
  sessionId: string,
  violations: readonly Violation[],
): void {
  writeViolations(directory, sessionId, violations);
  activate(sessionId);
}

describe('collectManifestScope', () => {
  it('selects only the exact session manifest', () => {
    writeActiveViolations('s1', [v('src/a.ts'), v('src/b.ts')]);
    writeActiveViolations('s2', [v('src/c.ts')]);
    expect(
      [...collectManifestScope(directory, 's2').files].toSorted((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual(['src/c.ts']);
  });

  it('fails closed when several manifests exist and no session id is available', () => {
    writeActiveViolations('s1', [v('src/a.ts')]);
    expect([...collectManifestScope(directory).files]).toEqual(['src/a.ts']);
    writeActiveViolations('s2', [v('src/b.ts')]);
    const scope = collectManifestScope(directory);
    expect(scope.active).toBe(true);
    expect(scope.files.size).toBe(0);
  });

  it('is empty and INACTIVE when there are no manifests', () => {
    const scope = collectManifestScope(directory);
    expect(scope.files.size).toBe(0);
    // `active` is what the scope-lock keys on: no manifest means no fixer is
    // running, so the lock stands aside.
    expect(scope.active).toBe(false);
  });

  it('ignores a stale manifest after its fix-loop marker is removed', () => {
    writeViolations(directory, 'old', [v('src/stale.ts')]);
    const scope = collectManifestScope(directory, 'old');
    expect(scope.active).toBe(false);
    expect(scope.files.size).toBe(0);
  });

  it('does not confine an exact session because another session is active', () => {
    writeActiveViolations('other', [v('src/other.ts')]);
    const scope = collectManifestScope(directory, 'current');
    expect(scope.active).toBe(false);
    expect(scope.files.size).toBe(0);
  });

  it('is empty and inactive when the state directory does not exist', () => {
    const scope = collectManifestScope(path.join(root, 'absent'));
    expect(scope.files.size).toBe(0);
    expect(scope.active).toBe(false);
  });

  it('is ACTIVE with no editable files when every violation names a denied file', () => {
    // The two empty cases must stay distinguishable: this one denies every
    // write, where "no manifest" allows them all.
    writeActiveViolations('s1', [
      v('package.json', 'guardrails/analyzer-missing'),
      v('guardrails.config.json', 'guardrails/analyzer-unknown'),
    ]);
    const scope = collectManifestScope(directory);
    expect(scope.files.size).toBe(0);
    expect(scope.active).toBe(true);
  });

  it('is active for a manifest that names editable files', () => {
    writeActiveViolations('s1', [v('src/a.ts')]);
    expect(collectManifestScope(directory).active).toBe(true);
  });

  it('is not active for a state directory holding no manifest', () => {
    // A stray non-manifest file must not switch the lock on.
    writeFileSync(path.join(directory, 'notes.json'), '[]');
    expect(collectManifestScope(directory).active).toBe(false);
  });

  it('denies a denied filename whatever its casing', () => {
    writeActiveViolations('s1', [
      v('Package.json'),
      v('GUARDRAILS.CONFIG.JSON'),
      v('packages/a/PACKAGE.JSON'),
    ]);
    expect(collectManifestScope(directory).files.size).toBe(0);
  });

  it('never makes package.json editable, whatever names it', () => {
    // guardrails/analyzer-missing points at package.json. Letting the fixer
    // edit it would let it delete the provider dependency, which flips the
    // analyzer to auto+undeclared and makes the violation vanish.
    writeActiveViolations('s1', [
      v('package.json', 'guardrails/analyzer-missing'),
    ]);
    expect(collectManifestScope(directory).files.size).toBe(0);
  });

  it('never makes guardrails.config.json editable, whatever names it', () => {
    // guardrails/analyzer-unknown points at the config, which holds
    // sanctionedSuppressions, maxAttempts, analyzers and enforcement.
    writeActiveViolations('s1', [
      v('guardrails.config.json', 'guardrails/analyzer-unknown'),
    ]);
    expect(collectManifestScope(directory).files.size).toBe(0);
  });

  it('denies a workspace member package.json at any depth', () => {
    writeActiveViolations('s1', [
      v('packages/a/package.json', 'guardrails/analyzer-missing'),
    ]);
    expect(collectManifestScope(directory).files.size).toBe(0);
  });

  it('reads only `.last.json` manifests, not other state files', () => {
    // The state directory also holds session tallies and recurrence counts, and
    // a consumer may leave anything else there. Without the suffix filter this
    // array-shaped stray would widen the fixer's allowlist.
    writeActiveViolations('s1', [v('src/a.ts')]);
    writeFileSync(
      path.join(directory, 'notes.json'),
      JSON.stringify([v('src/stray.ts')]),
    );
    expect([...collectManifestScope(directory).files]).toEqual(['src/a.ts']);
  });

  it('yields nothing for a manifest that is not a JSON array', () => {
    writeFileSync(path.join(directory, 's1.last.json'), '{"not":"an array"}');
    activate('s1');
    expect(collectManifestScope(directory).files.size).toBe(0);
  });

  it('ignores manifest entries that are not violations', () => {
    writeFileSync(
      path.join(directory, 's1.last.json'),
      JSON.stringify([{ nonsense: true }, v('src/a.ts')]),
    );
    activate('s1');
    expect([...collectManifestScope(directory).files]).toEqual(['src/a.ts']);
  });

  it('keeps every non-denied file editable alongside a denied one', () => {
    writeActiveViolations('s1', [
      v('src/foo.ts'),
      v('package.json', 'guardrails/analyzer-missing'),
    ]);
    expect([...collectManifestScope(directory).files]).toEqual(['src/foo.ts']);
  });
});

describe('isWithinRepo', () => {
  it('accepts paths inside the repo, including node_modules', () => {
    expect(isWithinRepo('/repo', '/repo/src/a.ts')).toBe(true);
    expect(isWithinRepo('/repo', '/repo/node_modules/x/rule.js')).toBe(true);
    expect(isWithinRepo('/repo', '/repo/.claude/state/g/sid.last.json')).toBe(
      true,
    );
  });

  it('accepts the repo root itself', () => {
    expect(isWithinRepo('/repo', '/repo')).toBe(true);
  });

  it('rejects paths outside the repo (e.g. ~/.claude project memory)', () => {
    expect(
      isWithinRepo('/repo', '/home/u/.claude/projects/x/memory/y.md'),
    ).toBe(false);
    expect(isWithinRepo('/repo', '/repo-sibling/file.ts')).toBe(false);
  });
});

describe('collectManifestScope normalization', () => {
  it('stores normalized manifest paths', () => {
    writeActiveViolations('s1', [v('src/nested/../a.ts')]);
    expect(collectManifestScope(directory).files.has('src/a.ts')).toBe(true);
  });
});

describe('collectManifestScope across rungs (commit-rung fixers)', () => {
  it('treats the session commit-rung manifest as active once marked', () => {
    // The commit gate delegates to a fixer too (#49). Before this, only the
    // stop rung's `<session>.last.json` could activate the lock, so a fixer
    // spawned from a commit block could edit anything -- guardrails.config.json
    // included.
    writeActiveViolations('s1-commit', [v('src/a.ts')]);
    const scope = collectManifestScope(directory, 's1');
    expect(scope.active).toBe(true);
    expect([...scope.files]).toEqual(['src/a.ts']);
  });

  it('unions the stop and commit manifests of one session', () => {
    writeActiveViolations('s1', [v('src/a.ts')]);
    writeActiveViolations('s1-commit', [v('src/b.ts')]);
    expect(
      [...collectManifestScope(directory, 's1').files].toSorted((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('ignores an unmarked commit-rung manifest', () => {
    writeViolations(directory, 's1-commit', [v('src/a.ts')]);
    expect(collectManifestScope(directory, 's1').active).toBe(false);
  });

  it('does not treat an arbitrary suffix as a rung of the session', () => {
    writeActiveViolations('s1-other', [v('src/a.ts')]);
    expect(collectManifestScope(directory, 's1').active).toBe(false);
  });

  it('expires a commit-rung marker older than the lease TTL', () => {
    // On hosts that cannot name the calling agent (Codex, Copilot) an active
    // marker confines the whole session, so one left by an abandoned commit
    // must not outlive the fixer it was written for.
    writeActiveViolations('s1-commit', [v('src/a.ts')]);
    const marker = path.join(directory, 's1-commit.pre-fix.json');
    const now = Date.now();
    const old = (now - LEASE_TTL_MS - 1000) / 1000;
    utimesSync(marker, old, old);
    expect(collectManifestScope(directory, 's1', now).active).toBe(false);
  });

  it('expires a commit-rung marker exactly at the lease TTL, not after it', () => {
    writeActiveViolations('s1-commit', [v('src/a.ts')]);
    const marker = path.join(directory, 's1-commit.pre-fix.json');
    const written = 1_700_000_000;
    utimesSync(marker, written, written);
    const at = written * 1000 + LEASE_TTL_MS;
    expect(collectManifestScope(directory, 's1', at).active).toBe(false);
    expect(collectManifestScope(directory, 's1', at - 1000).active).toBe(true);
  });

  it('ignores a stray file that only looks like a manifest by length', () => {
    // Without the suffix filter, `s1.stray.txt` loses its last ten characters
    // and reads as session `s1`, whose marker below would open the loop.
    activate('s1');
    writeFileSync(path.join(directory, 's1.stray.txt'), '[]');
    expect(collectManifestScope(directory, 's1').active).toBe(false);
  });

  it('keeps a fresh commit-rung marker active', () => {
    writeActiveViolations('s1-commit', [v('src/a.ts')]);
    expect(collectManifestScope(directory, 's1', Date.now()).active).toBe(true);
  });

  it('never expires the stop-rung marker, which every stop refreshes or clears', () => {
    writeActiveViolations('s1', [v('src/a.ts')]);
    const marker = path.join(directory, 's1.pre-fix.json');
    const now = Date.now();
    const old = (now - LEASE_TTL_MS - 1000) / 1000;
    utimesSync(marker, old, old);
    expect(collectManifestScope(directory, 's1', now).active).toBe(true);
  });
});

function activateIn(repoRoot: string, id: string, files: string[]): void {
  const state = stateDirectory(repoRoot);
  writeViolations(
    state,
    id,
    files.map((file) => v(file)),
  );
  writeFileSync(path.join(state, `${id}.pre-fix.json`), '[]');
}

describe('collectSessionScope (several checkouts)', () => {
  let nested: string;

  beforeEach(() => {
    nested = path.join(root, '.claude', 'worktrees', 'agent-1');
    mkdirSync(stateDirectory(nested), { recursive: true });
  });

  it('is inactive when no root holds an active manifest', () => {
    const scope = collectSessionScope([root, nested], 's1', Date.now());
    expect(scope.active).toBe(false);
  });

  it('confines to a nested worktree manifest from a parent cwd', () => {
    // A fixer spawned by a lane agent can run with the PARENT checkout as its
    // cwd while the manifest it was handed lives in the lane's worktree.
    activateIn(nested, 's1-commit', ['src/a.ts']);
    const scope = collectSessionScope([root, nested], 's1', Date.now());
    expect(scope.active).toBe(true);
    expect(scope.allowsEdit(path.join(nested, 'src/a.ts'))).toBe(true);
    expect(scope.allowsEdit(path.join(nested, 'guardrails.config.json'))).toBe(
      false,
    );
    expect(scope.allowsEdit(path.join(root, 'src/a.ts'))).toBe(false);
  });

  it('reads within the first root or any active root, nowhere else', () => {
    activateIn(nested, 's1', ['src/a.ts']);
    const scope = collectSessionScope([root, nested], 's1', Date.now());
    expect(scope.allowsRead(path.join(root, 'README.md'))).toBe(true);
    expect(scope.allowsRead(path.join(nested, 'src/b.ts'))).toBe(true);
    expect(scope.allowsRead('/home/u/.claude/projects/x/memory/y.md')).toBe(
      false,
    );
  });

  it('does not let a target root without a manifest widen the read scope', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'guardrails-other-'));
    try {
      activateIn(root, 's1', ['src/a.ts']);
      const scope = collectSessionScope([root, elsewhere], 's1', Date.now());
      expect(scope.allowsRead(path.join(elsewhere, 'secret.ts'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('collectManifestScope — tests the manifest names', () => {
  it('makes a violation’s related tests editable', () => {
    // A surviving mutant is filed against the SOURCE file, but it is killed
    // by strengthening a test. Once the lock engaged at the commit rung, a
    // fixer handed mutants could edit nothing that would kill them -- found
    // dogfooding this very change.
    writeActiveViolations('s1-commit', [
      {
        ...v('src/a.ts', 'stryker/survived'),
        relatedTests: ['test/a.test.ts'],
      },
    ]);
    expect(
      [...collectManifestScope(directory, 's1').files].toSorted((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual(['src/a.ts', 'test/a.test.ts']);
  });

  it('still never makes a denied file editable through relatedTests', () => {
    writeActiveViolations('s1', [
      { ...v('src/a.ts'), relatedTests: ['package.json'] },
    ]);
    expect([...collectManifestScope(directory, 's1').files]).toEqual([
      'src/a.ts',
    ]);
  });
});
