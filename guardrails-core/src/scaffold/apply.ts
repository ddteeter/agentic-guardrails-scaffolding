/**
 * Applies a `ScaffoldPlan` (Task 4) through an injected filesystem seam.
 *
 * Every touch -- read, write, or wiring up `core.hooksPath` -- goes through
 * `ApplyDeps`, so the whole of this module is unit-testable against an
 * in-memory map: no temp directories, no cleanup, and (per the phase this
 * belongs to) a provable idempotency property -- applying, re-planning, and
 * re-applying on an untouched repo writes nothing.
 *
 * `planScaffold` decided WHAT to do with each path; this module decides HOW:
 * an owned/seed-once `create`/`update` writes `desired[path]` verbatim and (for
 * owned files only) refreshes its manifest checksum; a `drift`/`unchanged`
 * writes nothing; a shared `create` or `merge` is routed to the Task 5 merger
 * for that path. The two OWNED/SEED-ONCE kinds that write (`create`/`update`)
 * never write a no-op: `planScaffold` only ever hands out `create`/`update`
 * when `currentContent !== desiredContent`, so idempotency for those files is
 * a `plan.ts` property, not one enforced again here. SHARED is different:
 * `decideShared` always returns `merge` once a shared file exists (spec §6.4
 * SHARED never reports drift, regardless of content), so THIS module is
 * where the idempotency property actually lives for those four paths -- a
 * merge whose result equals what's already on disk is treated as a no-op,
 * not a write.
 */
import path from 'node:path';

import {
  isSharedPath,
  parseConsumerJson,
  SHARED_MERGERS,
  type SharedMergeResult,
  type SharedPath,
} from './merge.js';
import {
  checksum,
  MANIFEST_PATH,
  parseManifest,
  serializeManifest,
  type ScaffoldManifest,
} from './manifest.js';
import type { PlannedAction, ScaffoldPlan } from './plan.js';

export interface ApplyDeps {
  readonly readFile: (filePath: string) => string | undefined;
  readonly writeFile: (filePath: string, content: string) => void;
  readonly setHooksPath: () => void;
}

export interface ApplyResult {
  readonly written: readonly string[];
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * The one owned path that only takes effect once git is told to look for it.
 * Re-pointing `core.hooksPath` costs nothing to repeat, but there is no
 * reason to run it on a run that didn't touch the script.
 */
const GIT_HOOKS_SCRIPT_PATH = '.githooks/pre-commit';

/** Accumulates the effects of applying every action, so each per-action
 * helper stays a plain function of its inputs rather than a closure. */
interface ApplyAccumulator {
  readonly written: string[];
  readonly skipped: string[];
  readonly warnings: string[];
  readonly manifestUpdates: Record<string, string>;
}

/**
 * SHARED: always routes through its merger (`merge.ts`'s `SHARED_MERGERS`),
 * whether the file is being created fresh (`current` absent) or merged into
 * (`current` present) -- each merger already knows how to handle an absent
 * file. Writes only when the merged result actually differs from what's on
 * disk, which is what makes a re-run of an up-to-date repo a no-op even
 * though `planScaffold` reports `merge` for these paths every time.
 *
 * A merge that fails closed (unparseable consumer JSON) also produces a
 * result equal to `current` -- indistinguishable from "already up to date"
 * by that comparison alone, and silently doing nothing is exactly how the
 * guardrail hook loop would fail to install without a trace. `parseFailed`
 * is how the merger reports which one actually happened, so the two cases
 * that both skip a write don't also both skip being reported.
 */
function applySharedAction(
  actionPath: SharedPath,
  desiredContent: string,
  fullPath: string,
  deps: ApplyDeps,
  accumulator: ApplyAccumulator,
): void {
  const current = deps.readFile(fullPath);
  const result: SharedMergeResult = SHARED_MERGERS[actionPath](
    current,
    desiredContent,
  );
  const { content, parseFailed } = result;
  if (parseFailed) {
    accumulator.warnings.push(
      `${actionPath} could not be parsed as JSON and was left unchanged`,
    );
  }
  if (content === current) {
    accumulator.skipped.push(actionPath);
    return;
  }
  deps.writeFile(fullPath, content);
  accumulator.written.push(actionPath);
}

/**
 * OWNED/SEED-ONCE: `drift`/`unchanged` never write; `create`/`update` write
 * `desired[path]` verbatim, unconditionally -- unlike `applySharedAction`,
 * this never compares against `current` first, because it doesn't need to:
 * `planScaffold` only produces `create`/`update` when the content actually
 * differs (see `decideOwned`), so every write here is already known to be
 * real. Owned writes refresh their manifest checksum; seed-once writes
 * (which only ever happen once) do not, since seed-once files are never
 * tracked for drift in the first place.
 */
function applyDirectAction(
  action: PlannedAction,
  desiredContent: string,
  fullPath: string,
  deps: ApplyDeps,
  accumulator: ApplyAccumulator,
): void {
  if (action.kind === 'drift' || action.kind === 'unchanged') {
    accumulator.skipped.push(action.path);
    return;
  }
  deps.writeFile(fullPath, desiredContent);
  accumulator.written.push(action.path);
  if (action.fileClass === 'owned') {
    accumulator.manifestUpdates[action.path] = checksum(desiredContent);
  }
  if (action.path === GIT_HOOKS_SCRIPT_PATH) {
    deps.setHooksPath();
  }
}

/**
 * Reads back the manifest already on disk, so a rewrite preserves entries for
 * files this run didn't touch. Absent and malformed are NOT the same thing
 * here, unlike the SHARED mergers' fail-closed convention: a brand-new repo
 * legitimately has no manifest yet, but a manifest that exists and fails to
 * parse is a corrupted file worth surfacing, so only that case adds a
 * warning.
 */
function readExistingManifest(
  manifestFullPath: string,
  deps: ApplyDeps,
  warnings: string[],
): ScaffoldManifest | undefined {
  const raw = deps.readFile(manifestFullPath);
  if (raw === undefined) {
    return undefined;
  }
  const manifest = parseManifest(parseConsumerJson(raw).parsed);
  if (manifest === undefined) {
    warnings.push(`${MANIFEST_PATH} could not be read; treating it as absent`);
  }
  return manifest;
}

/**
 * Rewrites the manifest with the existing entries plus a fresh checksum for
 * every OWNED file this run actually wrote -- never called when nothing was
 * written, which is what keeps a repeat run of an up-to-date repo from
 * touching the manifest at all.
 */
function writeManifest(
  repoRoot: string,
  manifestUpdates: Readonly<Record<string, string>>,
  deps: ApplyDeps,
  warnings: string[],
): void {
  const manifestFullPath = path.join(repoRoot, MANIFEST_PATH);
  const existing = readExistingManifest(manifestFullPath, deps, warnings);
  const manifest: ScaffoldManifest = {
    guardrailsVersion: existing?.guardrailsVersion ?? '',
    files: { ...existing?.files, ...manifestUpdates },
  };
  deps.writeFile(manifestFullPath, serializeManifest(manifest));
}

export function applyScaffold(
  plan: ScaffoldPlan,
  desired: Readonly<Record<string, string>>,
  repoRoot: string,
  deps: ApplyDeps,
): ApplyResult {
  const accumulator: ApplyAccumulator = {
    written: [],
    skipped: [],
    warnings: [],
    manifestUpdates: {},
  };

  for (const action of plan.actions) {
    const desiredContent = desired[action.path];
    if (desiredContent === undefined) {
      accumulator.warnings.push(
        `no desired content recorded for ${action.path}; skipping`,
      );
      accumulator.skipped.push(action.path);
      continue;
    }
    const fullPath = path.join(repoRoot, action.path);
    if (action.fileClass === 'shared') {
      // `PlannedAction.path` is a plain `string`; `planScaffold` only ever
      // sets `fileClass: 'shared'` when `isSharedPath` already agreed (see
      // `plan.ts`'s `classifyFile`), so this narrows rather than validates.
      // A path that reaches here and fails it means the two have drifted
      // apart -- worth a loud failure, not a silent misroute to the wrong
      // merger.
      if (!isSharedPath(action.path)) {
        throw new Error(`no SHARED merger registered for ${action.path}`);
      }
      applySharedAction(
        action.path,
        desiredContent,
        fullPath,
        deps,
        accumulator,
      );
      continue;
    }
    applyDirectAction(action, desiredContent, fullPath, deps, accumulator);
  }

  if (Object.keys(accumulator.manifestUpdates).length > 0) {
    writeManifest(
      repoRoot,
      accumulator.manifestUpdates,
      deps,
      accumulator.warnings,
    );
    accumulator.written.push(MANIFEST_PATH);
  }

  return {
    written: accumulator.written,
    skipped: accumulator.skipped,
    warnings: accumulator.warnings,
  };
}
