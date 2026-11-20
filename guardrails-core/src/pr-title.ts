/**
 * The title a new pull request opens with (#175): `guardrails ship` used the
 * last commit's subject, so a branch ending in a docs or test commit opened
 * its code change under that commit's type -- and, squash-merged, the commit
 * on the base carried it too.
 *
 * A body file can name the title on its first line, as `# <title>`, so the
 * title and the body are written together. When ship still falls back to the
 * last commit, it compares that commit's type with the branch's prefix.
 */

/**
The first non-blank line, when it is `# ` followed by some text.
*/
const TITLE_LINE = /^\s*# ([^\n]*\S[^\n]*)/;

/**
The blank lines between the title line and the body.
*/
const LEADING_BLANK_LINES = /^\s*\n/;

export interface TitledBody {
  title: string;
  body: string;
}

/**
 * The title a body file names on its first line, and the body without it, or
 * `undefined` when the first line is not a title line. Only `# ` counts: a
 * `## ` heading is a section of the body.
 */
export function splitTitleLine(text: string): TitledBody | undefined {
  const match = TITLE_LINE.exec(text);
  if (match === null) {
    return undefined;
  }
  return {
    title: String(match[1]).trim(),
    body: text.slice(match[0].length).replace(LEADING_BLANK_LINES, ''),
  };
}

/**
The conventional-commit types a branch prefix or a subject is compared by.
*/
const TYPES: ReadonlySet<string> = new Set([
  'feat',
  'fix',
  'docs',
  'test',
  'chore',
  'refactor',
  'perf',
  'build',
  'ci',
  'style',
  'revert',
]);

/**
What a branch prefix names: a type, or another spelling of one.
*/
const BRANCH_TYPES: ReadonlyMap<string, string> = new Map([
  ...[...TYPES].map((type): [string, string] => [type, type]),
  ['feature', 'feat'],
  ['bugfix', 'fix'],
  ['hotfix', 'fix'],
]);

const BRANCH_PREFIX = /^([\w-]+)\//;

const SUBJECT_TYPE = /^(\w+)(?:\([^)]*\))?!?:/;

export interface TypeMismatch {
  /**
  The type the branch's prefix names.
  */
  wanted: string;
  /**
  The type the subject has.
  */
  found: string;
}

/**
The type a branch's prefix names, or `undefined` when it names none.
*/
function branchType(branch: string): string | undefined {
  // String() turns "no prefix" into a key no type has.
  return BRANCH_TYPES.get(String(BRANCH_PREFIX.exec(branch)?.[1]));
}

function subjectType(subject: string): string | undefined {
  const type = String(SUBJECT_TYPE.exec(subject)?.[1]);
  return TYPES.has(type) ? type : undefined;
}

/**
 * Whether `subject` has a different conventional type from the one the
 * branch's prefix names (`fix/…` titled `docs(…)`), or `undefined` when they
 * agree or either has no type to compare.
 */
export function titleTypeMismatch(
  branch: string,
  subject: string,
): TypeMismatch | undefined {
  const wanted = branchType(branch);
  const found = subjectType(subject);
  return wanted === undefined || found === undefined || wanted === found
    ? undefined
    : { wanted, found };
}
