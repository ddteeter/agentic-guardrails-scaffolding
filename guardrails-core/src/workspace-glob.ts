/**
 * The npm **workspace** glob subset — deliberately not a glob library.
 *
 * Workspace declarations use a small, well-known vocabulary (`packages/*`,
 * occasionally `packages/**`, rarely a `!` exclusion), so this implements
 * exactly that and declines everything else. Declining is safe: the caller
 * falls back to nearest-ancestor resolution, which still attributes the file.
 * Guessing is not — a wrong match silently corrupts recurrence memory.
 */

/** Syntax we do not implement: braces, character classes, `?`, extglobs. */
const UNSUPPORTED = /[{}[\]()?+]/;

export interface ParsedGlob {
  /** A leading `!` marks an exclusion, applied after the positive matches. */
  negated: boolean;
  /** `directory` is repo-relative and slash-separated, with no trailing slash. */
  matches: (directory: string) => boolean;
}

function escapeLiteral(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** `*` matches within one segment; `**` spans segments. */
function segmentToPattern(segment: string): string {
  if (segment === '**') {
    return '.*';
  }
  return segment
    .split('*')
    .map((part) => escapeLiteral(part))
    .join('[^/]*');
}

export function parseWorkspaceGlob(glob: string): ParsedGlob | undefined {
  const negated = glob.startsWith('!');
  let body = negated ? glob.slice(1) : glob;
  while (body.endsWith('/')) {
    body = body.slice(0, -1);
  }
  if (body.length === 0 || UNSUPPORTED.test(body)) {
    return undefined;
  }
  const source = body
    .split('/')
    .map((segment) => segmentToPattern(segment))
    .join('/');
  const pattern = new RegExp(`^${source}$`);
  return { negated, matches: (directory) => pattern.test(directory) };
}
