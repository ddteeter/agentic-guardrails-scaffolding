/**
 * `tool-config-escape` (GR-04): the diff auditor's rule for a Swift tool's
 * own config file. A line signature cannot judge these files. They are not
 * source, and whether an added line weakens a check depends on the key it
 * sits under: `- force_cast` under `opt_in_rules` turns a rule on, the same
 * line under `disabled_rules` turns it off.
 *
 * Covered: `.swiftlint.yml` (`disabled_rules`, `excluded`, at any depth, so a
 * rule's own `excluded` list counts), `.periphery.yml` (`retain_*`) and
 * `.swiftformat` (`--disable`, `--exclude`). All three are also on the fixer
 * denylist (`scope.ts`); this rule is what holds the main agent.
 *
 * Imports nothing: pure over the lines it is fed.
 */

/**
 * One file's rule, fed the post-change lines of a hunk in order, context
 * lines included: a context line can be the key the next added line sits
 * under. Whether a line that weakens a check is a FINDING is the caller's to
 * say (only an added line is).
 */
export interface ToolConfigAuditor {
  /**
  Read the next line; `true` when it is one that weakens a check.
  */
  line(text: string): boolean;
}

/**
 * A config line without its comment. Everything from the first `#` goes: in
 * YAML a `#` glued to a word is not a comment, but what precedes it is never
 * blank and never completes a key, so the simpler rule reads every line the
 * same way.
 */
export function withoutComment(text: string): string {
  return text.replace(/#.*/, '');
}

const YAML_KEY = /^\s*([\w-]+)\s*:/;

/**
 * A YAML file in which some keys are escapes. Tracks the last key seen, at
 * any indentation: every non-key line (a list item, a continuation) belongs
 * to it.
 *
 * `before` holds the post-change lines above the hunk. Without it the key a
 * hunk begins under is unknown, and a line under an unknown key is treated as
 * an escape: an over-match rather than a miss, the same choice the Swift
 * lexer makes for a hunk that begins inside a comment.
 */
function yamlAuditor(
  isEscapeKey: (key: string) => boolean,
  before: readonly string[] | undefined,
): ToolConfigAuditor {
  let isUnderEscape: boolean | undefined;
  const isEscape = (text: string): boolean => {
    const content = withoutComment(text);
    if (content.trim() === '') {
      return false;
    }
    const key = YAML_KEY.exec(content)?.[1];
    if (key !== undefined) {
      isUnderEscape = isEscapeKey(key);
    }
    return isUnderEscape ?? true;
  };
  if (before !== undefined) {
    // A readable file starts under no key at all, and its lines above the
    // hunk say which key the hunk begins under.
    isUnderEscape = false;
    for (const line of before) {
      isEscape(line);
    }
  }
  return { line: isEscape };
}

/**
`--disable` or `--exclude`, as a whole option name, anywhere on the line.
*/
const SWIFTFORMAT_ESCAPE = /--(?:disable|exclude)(?!\S)/;

/**
A `.swiftformat` options file: every line stands alone.
*/
function swiftformatAuditor(): ToolConfigAuditor {
  return {
    line: (text) => SWIFTFORMAT_ESCAPE.test(withoutComment(text)),
  };
}

function isSwiftlintEscape(key: string): boolean {
  return key === 'disabled_rules' || key === 'excluded';
}

function isPeripheryEscape(key: string): boolean {
  return key.startsWith('retain_');
}

/**
The YAML configs this module knows, and which of their keys are escapes.
*/
function yamlEscapeKeys(name: string): ((key: string) => boolean) | undefined {
  if (name === '.swiftlint.yml') {
    return isSwiftlintEscape;
  }
  return name === '.periphery.yml' ? isPeripheryEscape : undefined;
}

/**
 * The rule for `file`, or none when it is not a tool config this module
 * knows. Matched on the base name, so a nested `.swiftlint.yml` (SwiftLint
 * reads one per directory) is held like the root one.
 *
 * `above` answers the post-change lines above the hunk. It is a function
 * because most files are not tool configs and the answer costs a file read:
 * it is called only for a YAML config, whose rule needs it.
 */
export function toolConfigAuditor(
  file: string,
  above: () => readonly string[] | undefined,
): ToolConfigAuditor | undefined {
  const name = file.slice(file.lastIndexOf('/') + 1);
  if (name === '.swiftformat') {
    return swiftformatAuditor();
  }
  const isEscapeKey = yamlEscapeKeys(name);
  return isEscapeKey === undefined
    ? undefined
    : yamlAuditor(isEscapeKey, above());
}
