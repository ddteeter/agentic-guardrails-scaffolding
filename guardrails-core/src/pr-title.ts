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

export interface TitledBody {
  title: string;
  body: string;
}

const TITLE_MARK = '# ';

/**
`text` from its first line that is not blank, or `''` when every line is.
*/
function fromFirstText(text: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  return first === -1 ? '' : lines.slice(first).join('\n');
}

/**
 * The title a body file names on its first non-blank line, `# <title>`, and
 * the body after it without the blank lines between, or `undefined` when that
 * line is not a title line. Only `# ` counts: a `## ` heading is a section of
 * the body.
 */
export function splitTitleLine(text: string): TitledBody | undefined {
  const start = fromFirstText(text);
  const end = start.indexOf('\n');
  const line = end === -1 ? start : start.slice(0, end);
  const title = line.slice(TITLE_MARK.length).trim();
  if (title === '' || !line.startsWith(TITLE_MARK)) {
    return undefined;
  }
  return {
    title,
    body: end === -1 ? '' : fromFirstText(start.slice(end + 1)),
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
Branch prefixes that spell a type another way.
*/
const BRANCH_ALIASES: ReadonlyMap<string, string> = new Map([
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
  subject: string;
}

/**
The type a branch's prefix names, or `undefined` when it names none.
*/
function branchType(branch: string): string | undefined {
  // String() turns "no prefix" into a word no type is.
  const prefix = String(BRANCH_PREFIX.exec(branch)?.[1]);
  const type = BRANCH_ALIASES.get(prefix) ?? prefix;
  return TYPES.has(type) ? type : undefined;
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
    : { wanted, found, subject };
}
