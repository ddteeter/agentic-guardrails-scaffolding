/**
 * Reading a repo-relative file as text, for the checks that compare the
 * checked-in policy file against the checked-in source.
 *
 * Shared by the CI `sanctions-check` command and by `runVerify`'s local
 * integrity check (#103) so both read the same way. A key that escapes the repo
 * (`../`) reads as ABSENT rather than reaching outside it: the policy file is
 * checked-in text, but it is still input, and a `file` in a sanction key comes
 * from it.
 *
 * Absent and unreadable are the same answer on purpose — `sanctionCountDrift`
 * scores a file it cannot read as zero occurrences, which is the deleted-file
 * case and should be reported as drift rather than skipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isWithinRepo } from './scope.js';

export function repoSourceReader(
  repoRoot: string,
): (file: string) => string | undefined {
  return (file) => {
    const full = path.join(repoRoot, file);
    return isWithinRepo(repoRoot, file) && existsSync(full)
      ? readFileSync(full, 'utf8')
      : undefined;
  };
}
