/**
 * Fixer scope-lock (§2.3). The fixer must touch only the files named in the
 * violations manifest. This turns "touch only listed files" into a hard
 * PreToolUse gate rather than a prompt request: the fixer's Edit/Write hook
 * calls `guardrails scope-check`, which denies any write to a path absent from
 * the manifest.
 *
 * Scope resolves to the hook payload's exact session manifest while its
 * `.pre-fix.json` loop marker exists. If a runtime omits the session id, one
 * active manifest is unambiguous; several active manifests fail closed with an
 * empty scope instead of unioning concurrent permissions. Stale manifests do
 * not confine later main-agent turns. `DENIED_FILE_NAMES` are removed in every
 * case.
 *
 * The result reports `active` separately from `files` because the two empty
 * cases mean opposite things: NO manifest means no fixer is running and the
 * lock must stand aside, while an active manifest that yields no editable files
 * means the fixer has nothing it may legitimately touch — which must deny every
 * write, not disengage the lock.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { readJsonFile } from './json-file.js';
import { LEASE_TTL_MS } from './state.js';
import { stateDirectory } from './state-store.js';
import { isViolation, type Violation } from './violation.js';

/**
 * Files the fixer may never edit, whatever a manifest names — matched on the
 * basename, so a workspace member's `packages/a/package.json` is denied exactly
 * like the root one.
 *
 * Three rule-ids point at a policy/manifest file rather than at code:
 * `guardrails/analyzer-missing` and `guardrails/analyzer-failed` (both
 * `package.json`), and `guardrails/analyzer-unknown`
 * (`guardrails.config.json`). Without this denylist, handing a fixer any of
 * them would make that file editable, and the diff-auditor would not catch the
 * abuse — it scans code for suppression syntax, and these are data edits.
 * Deleting a provider from `devDependencies`
 * flips its analyzer from `auto`+declared to `auto`+undeclared, so the missing
 * error vanishes and `verify` reads green with the guard silently not running;
 * `guardrails.config.json` holds `sanctionedSuppressions`, `sanctionedFiles`,
 * `maxAttempts`, `analyzers` and `enforcement`, so a fixer could grant itself
 * an exemption of either kind, or switch a gate off.
 *
 * Nothing legitimate is lost: the fixer's job is to fix code, and no honest fix
 * to either violation is an edit to these files — installing a dependency is
 * not something the fixer can do at all (it has no Bash). The correct outcome
 * is that it edits nothing and the attempt escalates to the main agent.
 */
const DENIED_FILE_NAMES: ReadonlySet<string> = new Set([
  'package.json',
  'guardrails.config.json',
]);

function isDeniedFile(normalizedPath: string): boolean {
  // Lowercased: macOS and Windows resolve `Package.json` to the real file on
  // write, so a case-sensitive lookup would be a way straight through this.
  return DENIED_FILE_NAMES.has(path.basename(normalizedPath).toLowerCase());
}

/**
What the scope-lock knows about the fixer's editable surface.
*/
export interface ManifestScope {
  /**
  Files the fixer may edit. Empty when every violation named a denied file.
  */
  readonly files: ReadonlySet<string>;
  /**
  Whether any manifest exists at all — distinct from an empty `files`.
  */
  readonly active: boolean;
}

const MANIFEST_SUFFIX = '.last.json';
const ACTIVE_SUFFIX = '.pre-fix.json';

/**
 * The rung suffixes a gate appends to the session id when it writes its own
 * manifest (`<session>-commit.last.json`). The stop rung writes the bare
 * `<session>.last.json`.
 *
 * Spelled out rather than matched as "anything after a hyphen": session ids are
 * UUIDs, which are full of hyphens, so a loose suffix match would let a
 * manifest named for one session's rung read as belonging to another.
 */
const RUNG_SUFFIXES: readonly string[] = ['commit', 'push', 'ci'];

function isSessionManifest(id: string, sessionId: string): boolean {
  return (
    id === sessionId ||
    RUNG_SUFFIXES.some((rung) => id === `${sessionId}-${rung}`)
  );
}

function isRungManifest(id: string): boolean {
  return RUNG_SUFFIXES.some((rung) => id.endsWith(`-${rung}`));
}

/**
 * Is this manifest's fix loop still open?
 *
 * Its marker has to exist. A RUNG marker must also be younger than the lease
 * TTL, because nothing else would ever clear it: the stop rung's marker is
 * refreshed or removed by the very next Stop, but a commit-rung marker is only
 * cleared by the next commit attempt that passes, which an agent may never make.
 * On Codex and Copilot, which cannot say which agent is calling, a live marker
 * confines the WHOLE session, so a marker that outlived its fixer would lock the
 * main agent to a handful of files for days.
 */
function isLoopOpen(directory: string, id: string, now: number): boolean {
  const marker = statSync(path.join(directory, `${id}${ACTIVE_SUFFIX}`), {
    throwIfNoEntry: false,
  });
  if (marker === undefined) {
    return false;
  }
  return !isRungManifest(id) || now - marker.mtimeMs < LEASE_TTL_MS;
}

/**
 * The violations recorded in ONE manifest, read by that manifest's own path.
 * Reading the entry the loop inspected — rather than rebuilding a path from a
 * session id sliced back out of its name — is what makes the suffix filter
 * load-bearing: a stray `notes.json` dropped in the state directory is skipped
 * because it is skipped, not because the rebuilt path happened not to exist.
 * A missing, malformed, or non-array file yields nothing, so a corrupt manifest
 * narrows the fixer's scope rather than widening it.
 */
function readManifest(file: string): Violation[] {
  const { parsed } = readJsonFile(file);
  return Array.isArray(parsed)
    ? parsed.filter((entry) => isViolation(entry))
    : [];
}

/**
 * Which open manifests the caller's session owns: with no session id, one open
 * manifest is unambiguous and several select none.
 */
function selectManifests(
  open: readonly string[],
  sessionId: string | undefined,
): readonly string[] {
  if (sessionId === undefined) {
    return open.length === 1 ? open : [];
  }
  return open.filter((id) => isSessionManifest(id, sessionId));
}

/**
 * The fixer's editable surface in one state directory.
 *
 * With a session id, every open loop of THAT session counts -- its stop
 * manifest and any rung manifest (`<session>-commit`) -- and their files are
 * unioned: they are the same session's work, and a fixer handed either one is
 * a fixer of this session. Without a session id, one open manifest is
 * unambiguous and several fail closed with an empty active scope, as before.
 */
export function collectManifestScope(
  directory: string,
  sessionId?: string,
  now: number = Date.now(),
): ManifestScope {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return { files: new Set(), active: false };
  }
  const open = entries
    .filter((name) => name.endsWith(MANIFEST_SUFFIX))
    .map((name) => name.slice(0, -MANIFEST_SUFFIX.length))
    .filter((id) => isLoopOpen(directory, id, now));
  const selected = selectManifests(open, sessionId);
  if (selected.length === 0) {
    // Several manifests with no session id are ambiguous, not additive. An
    // empty active scope denies every edit and cannot inherit permissions from
    // a crashed or concurrently-running session.
    return {
      files: new Set(),
      active: sessionId === undefined && open.length > 0,
    };
  }
  const files = new Set<string>();
  for (const id of selected) {
    const manifested = readManifest(
      path.join(directory, `${id}${MANIFEST_SUFFIX}`),
    );
    for (const violation of manifested) {
      const file = path.normalize(violation.file);
      if (!isDeniedFile(file)) {
        files.add(file);
      }
    }
  }
  return { files, active: true };
}

/**
 * The scope-lock's view across every checkout a hook call touches.
 */
export interface SessionScope {
  /**
  Whether any of the checkouts holds an open fix loop for this session.
  */
  readonly active: boolean;
  /**
  May the fixer write this ABSOLUTE path?
  */
  allowsEdit(file: string): boolean;
  /**
  May the fixer read this ABSOLUTE path?
  */
  allowsRead(file: string): boolean;
}

/**
 * Collect the session's scope from several repository roots at once.
 *
 * One root is not enough once worktrees nest. Claude Code puts subagent
 * worktrees under `.claude/worktrees/` INSIDE the project, and a fixer a lane
 * agent spawns can run with the parent checkout as its cwd while the manifest
 * it was handed -- and the files it edits -- live in the lane's worktree.
 * Looking only at the cwd's root read that as "no fixer running" and left the
 * fixer unconfined in exactly the place it was working.
 *
 * `roots[0]` is the caller's own checkout and is always readable. Every other
 * root counts only if it holds an open loop for this session: a target path's
 * root is a candidate, never a grant, so a read of some unrelated repository
 * cannot widen the read-lock just by naming a file inside it.
 */
export function collectSessionScope(
  roots: readonly string[],
  sessionId: string | undefined,
  now: number,
): SessionScope {
  const unique = [...new Set(roots.map((root) => path.resolve(root)))];
  const open = unique
    .map((root) => ({
      root,
      scope: collectManifestScope(stateDirectory(root), sessionId, now),
    }))
    .filter((entry) => entry.scope.active);
  const editable = new Set(
    open.flatMap(({ root, scope }) =>
      [...scope.files].map((file) => path.resolve(root, file)),
    ),
  );
  const readable = [...unique.slice(0, 1), ...open.map((entry) => entry.root)];
  return {
    active: open.length > 0,
    allowsEdit: (file) => editable.has(path.resolve(file)),
    allowsRead: (file) => readable.some((root) => isWithinRepo(root, file)),
  };
}

/**
 * Read-scope guard (Finding 3 from the dogfooding proof): is `candidate` inside
 * the repo? The fixer may read anything *within* the repo (the manifest, the
 * files it edits, even `node_modules` rule sources — that in-repo exploration is
 * how the thorough tier diagnoses subtle rules), but never *outside* it (e.g.
 * the user's `~/.claude` project memory).
 */
export function isWithinRepo(repoRoot: string, candidate: string): boolean {
  // `path.relative(root, root)` is '', which already satisfies both clauses
  // below — it starts with neither '..' nor a root — so an explicit
  // `relative === ''` disjunct would be dead weight no test could distinguish.
  const relative = path.relative(repoRoot, path.resolve(repoRoot, candidate));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
