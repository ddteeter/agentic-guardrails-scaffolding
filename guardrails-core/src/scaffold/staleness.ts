/**
 * Has the vendored guidance rotted? (#106)
 *
 * `guardrails init` copies guidance docs and skills INTO the consumer repo,
 * and `src/guidance.ts` deliberately points violations at those copies rather
 * than at `node_modules` — the Copilot cloud agent reads the default branch,
 * where `node_modules` has never existed. That is the right call, and it has a
 * cost nothing was paying attention to: the copies never update themselves.
 *
 * The sequence that actually happens is: a repo adopts at one version, the
 * package is upgraded through ordinary dependency maintenance, and the
 * vendored copy stays at the adopted version forever. Measured on an adopting
 * repo: 49 lines behind across three minor versions, unnoticed for six weeks,
 * while the tool confidently sent its agents to read it. Two of the sections
 * it was missing explained a warning that repo hit the very next day.
 *
 * `init --plan` has always computed this exactly. What was missing was
 * anything that RUNS it, so this is the detection, cheap enough for a rung
 * that fires every session: the shipped content, the recorded checksums, and
 * what is on disk. No `detect()`, no spawn.
 *
 * Two classes, and the second is the sharper one:
 *
 * - **updatable** — recorded, unmodified, and different from what ships now.
 *   Safe to upgrade, and `init --apply` will.
 * - **drifted** — recorded and edited since. `init` will leave it alone
 *   forever, which is correct (it is the consumer's edit) and permanent (there
 *   is no state for "this consumer has something to contribute"). One
 *   well-meant edit opts a file out of every future upgrade, silently, and
 *   that is worth saying the first time it is true rather than only inside a
 *   command nobody runs.
 */

import { checksum, type ScaffoldManifest } from './manifest.js';

/**
The shipped content for a scaffolded path: `[repo-relative path, content]`.
*/
type ShippedEntry = readonly [string, string];

export interface StaleArtifacts {
  /**
  Recorded, unmodified, and behind what the installed package ships.
  */
  readonly updatable: readonly string[];
  /**
  Recorded and edited since — excluded from upgrades from now on.
  */
  readonly drifted: readonly string[];
}

export function staleArtifacts(
  shipped: readonly ShippedEntry[],
  manifest: ScaffoldManifest | undefined,
  /**
   * Reads a scaffolded file, or `undefined` when it is not there.
   *
   * A reader rather than a pre-built record on purpose: building the record
   * meant a caller-side `if (contents !== undefined)` whose two branches
   * produce the same answer here — an absent key and a present `undefined`
   * are both "not on disk" — which is an unkillable mutant in the caller
   * rather than a check anything relies on.
   */
  readSource: (file: string) => string | undefined,
): StaleArtifacts {
  const updatable: string[] = [];
  const drifted: string[] = [];
  for (const [path, content] of shipped) {
    // Not recorded: this repo never scaffolded the file. Warning here would be
    // nagging a consumer to adopt something they declined, which is a
    // different conversation from "the thing you adopted has rotted".
    const recorded = manifest?.files[path];
    if (recorded === undefined) {
      continue;
    }
    const onDisk = readSource(path);
    if (onDisk === undefined) {
      // Scaffolded and now gone. `init --apply` restores it.
      updatable.push(path);
      continue;
    }
    if (checksum(onDisk) !== recorded) {
      // Edited since. Reported whether or not an upgrade is available: the
      // file is opted out of FUTURE upgrades too, which is the part worth
      // hearing early.
      drifted.push(path);
      continue;
    }
    if (onDisk !== content) {
      updatable.push(path);
    }
  }
  // Sorted so the warning is stable between runs and diffable in a transcript.
  return {
    updatable: updatable.toSorted((a, b) => a.localeCompare(b)),
    drifted: drifted.toSorted((a, b) => a.localeCompare(b)),
  };
}
