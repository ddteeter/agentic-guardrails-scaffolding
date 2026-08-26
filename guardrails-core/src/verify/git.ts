/**
 * Diff-scoping helpers. `verify` runs only over the files a turn actually
 * touched, so a Stop-boundary check stays cheap. The changed set is the union
 * of tracked changes since the base branch and untracked files — the agent's
 * edits are typically uncommitted, so a base-only diff would miss them.
 */

export function parseFileList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter((line) => line.length > 0);
}

export function mergeChangedFiles(
  trackedDiff: string,
  untracked: string,
): string[] {
  return [
    ...new Set([...parseFileList(trackedDiff), ...parseFileList(untracked)]),
  ];
}

export function isTypeScriptFile(file: string): boolean {
  return /\.tsx?$/.test(file) && !file.endsWith('.d.ts');
}

export function isTestFile(file: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(file);
}
