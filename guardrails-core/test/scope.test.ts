import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectManifestScope,
  isPathAllowed,
  isWithinRepo,
} from '../src/scope.js';
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

describe('isPathAllowed', () => {
  const files = new Set(['src/a.ts']);

  it('allows a listed file given as an absolute path', () => {
    expect(isPathAllowed(files, '/repo', '/repo/src/a.ts')).toBe(true);
  });

  it('allows a listed file given as a repo-relative path', () => {
    expect(isPathAllowed(files, '/repo', 'src/a.ts')).toBe(true);
  });

  it('denies a file not in the manifest', () => {
    expect(isPathAllowed(files, '/repo', '/repo/src/b.ts')).toBe(false);
  });

  it('normalizes the candidate so a `..` segment does not cause a false denial', () => {
    expect(isPathAllowed(files, '/repo', 'src/nested/../a.ts')).toBe(true);
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
