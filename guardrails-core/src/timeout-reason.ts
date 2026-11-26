/**
 * What a stryker `Timeout`'s `statusReason` says about how it timed out.
 *
 * Shared by the timeout re-test (#202), which leaves hit-limit timeouts out,
 * and the progress plugin (#236), which counts the two kinds apart. The
 * plugin runs inside stryker and must stay import-light, so this lives on its
 * own rather than in `verify/`.
 *
 * Stryker's runner returns a hit-limit Timeout as an ordinary result, with
 * this reason (`determineHitLimitReached` in `@stryker-mutator/api`); a
 * wall-clock Timeout has no reason, and stryker restarts the test runner
 * process after it. `test/drift/stryker-timeout.test.ts` pins the wording.
 */
const HIT_LIMIT_PREFIX = 'Hit limit reached';

/**
 * Is `reason` the one stryker gives a mutant whose own code ran past the hit
 * limit its dry run set, rather than one the wall clock stopped?
 */
export function isHitLimitReason(reason: unknown): boolean {
  return typeof reason === 'string' && reason.startsWith(HIT_LIMIT_PREFIX);
}
