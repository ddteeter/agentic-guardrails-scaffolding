/**
 * Per-release upgrade notes (#151): `upgrades/<version>.md`, shipped in the
 * tarball, written for the agent doing an upgrade rather than for a changelog
 * reader. The prose body says what changed and why; the frontmatter is the
 * part a program can act on -- phrases to search an adopter's own instruction
 * files for (`supersedes`), and scripts, hooks or config keys to add (`wire`).
 *
 * The `upgrading-guardrails` skill reads both. `init --plan` will read the
 * frontmatter to warn on its own (#152), which is why it has a parser at all.
 *
 * Only the subset of YAML these files use is read: top-level `key: value`, and
 * lists of flat maps (`  - key: value` then `    key: value`). Values are bare,
 * single-quoted (`''` is a quote) or double-quoted without escapes -- the form
 * prettier rewrites a value holding a quote into on commit. Anything else is refused with the line it
 * is on, so a notes file can never be half-read -- and no YAML dependency
 * ships for three keys.
 */

interface Superseded {
  /**
  A literal, case-insensitive phrase to search instruction files for.
  */
  search: string;
  because: string;
}

const WIRE_KINDS = ['script', 'hook', 'config'] as const;

interface Wiring {
  kind: (typeof WIRE_KINDS)[number];
  name: string;
  value: string;
  because: string;
}

export interface UpgradeNotes {
  version: string;
  supersedes: Superseded[];
  wire: Wiring[];
  body: string;
}

type Item = Map<string, string>;

interface Frontmatter {
  scalars: Map<string, string>;
  lists: Map<string, Item[]>;
}

/**
Prints as its bare message, so `String(error)` in the catch below is the
refusal itself with no `Error: ` prefix.
*/
class NotesError extends Error {
  override toString(): string {
    return this.message;
  }
}

const TOP_KEYS = new Set(['version', 'supersedes', 'wire']);
const LIST_FIELDS: Readonly<Record<'supersedes' | 'wire', readonly string[]>> =
  {
    supersedes: ['search', 'because'],
    wire: ['kind', 'name', 'value', 'because'],
  };

/*
The three line shapes. The value is everything after the colon, trimmed by
`scalar`'s caller rather than the pattern, so no two parts compete for spaces.
*/
const TOP_LINE = /^(\w+):(.*)$/;
const ITEM_START = /^ {2}- (\w+):(.*)$/;
const ITEM_LINE = /^ {4}(\w+):(.*)$/;

function unterminated(lineNumber: number): NotesError {
  return new NotesError(`line ${String(lineNumber)}: unterminated quote`);
}

/**
 * A double-quoted value, as prettier rewrites a single-quoted one that holds a
 * quote. Without escapes: prettier only picks double quotes when none are
 * needed, so a backslash is refused rather than half-understood.
 */
function doubleQuoted(raw: string, lineNumber: number): string {
  const inner = raw.slice(1, -1);
  if (raw.length < 2 || !raw.endsWith('"') || inner.includes('"')) {
    throw unterminated(lineNumber);
  }
  if (inner.includes('\\')) {
    throw new NotesError(
      `line ${String(lineNumber)}: escapes are not supported`,
    );
  }
  return inner;
}

/**
A bare, single-quoted or double-quoted value.
*/
function scalar(raw: string, lineNumber: number): string {
  if (raw.startsWith('"')) {
    return doubleQuoted(raw, lineNumber);
  }
  if (!raw.startsWith("'")) {
    return raw;
  }
  const inner = raw.slice(1, -1);
  const isClosed = raw.length > 1 && raw.endsWith("'");
  if (!isClosed || inner.replaceAll("''", '').includes("'")) {
    throw unterminated(lineNumber);
  }
  return inner.replaceAll("''", "'");
}

function setOnce(
  map: Map<string, string>,
  key: string,
  value: string,
  lineNumber: number,
): void {
  if (map.has(key)) {
    throw new NotesError(`line ${String(lineNumber)}: "${key}" given twice`);
  }
  map.set(key, value);
}

/**
The open list an item line belongs to, or a refusal naming the line.
*/
function openItem(items: Item[] | undefined, lineNumber: number): Item[] {
  if (items === undefined) {
    throw new NotesError(
      `line ${String(lineNumber)}: a list item outside a list`,
    );
  }
  return items;
}

interface Reader extends Frontmatter {
  /**
  The list item lines go into, while one is open.
  */
  items: Item[] | undefined;
}

function readTopLine(
  reader: Reader,
  [key, raw]: readonly [string, string],
  lineNumber: number,
): void {
  if (!TOP_KEYS.has(key)) {
    throw new NotesError(`line ${String(lineNumber)}: unknown key "${key}"`);
  }
  if (reader.scalars.has(key) || reader.lists.has(key)) {
    throw new NotesError(`line ${String(lineNumber)}: "${key}" given twice`);
  }
  if (raw === '') {
    reader.items = [];
    reader.lists.set(key, reader.items);
    return;
  }
  reader.items = undefined;
  reader.scalars.set(key, scalar(raw, lineNumber));
}

function readItemField(
  reader: Reader,
  [key, raw]: readonly [string, string],
  lineNumber: number,
): void {
  const current = openItem(reader.items, lineNumber).at(-1);
  if (current === undefined) {
    throw new NotesError(
      `line ${String(lineNumber)}: a field before any list item`,
    );
  }
  setOnce(current, key, scalar(raw, lineNumber), lineNumber);
}

/**
A matched line's key and its value, trimmed.
*/
function keyAndValue(match: RegExpExecArray): [string, string] {
  const [, key = '', raw = ''] = match;
  return [key, raw.trim()];
}

function readLine(reader: Reader, line: string, lineNumber: number): void {
  const top = TOP_LINE.exec(line);
  if (top !== null) {
    readTopLine(reader, keyAndValue(top), lineNumber);
    return;
  }
  const start = ITEM_START.exec(line);
  if (start !== null) {
    const [key, raw] = keyAndValue(start);
    openItem(reader.items, lineNumber).push(
      new Map([[key, scalar(raw, lineNumber)]]),
    );
    return;
  }
  const field = ITEM_LINE.exec(line);
  if (field !== null) {
    readItemField(reader, keyAndValue(field), lineNumber);
    return;
  }
  if (line.trim() !== '') {
    throw new NotesError(`line ${String(lineNumber)}: not understood`);
  }
}

function readFrontmatter(text: string): Frontmatter {
  const reader: Reader = {
    scalars: new Map(),
    lists: new Map(),
    items: undefined,
  };
  for (const [index, line] of text.split('\n').entries()) {
    readLine(reader, line, index + 1);
  }
  return { scalars: reader.scalars, lists: reader.lists };
}

/**
 * One list item's fields, every one present, known and non-empty. `where`
 * names the item for the refusal, counting from 1 as a reader would.
 */
function fieldsOf(
  item: Item,
  allowed: readonly string[],
  where: string,
): Record<string, string> {
  for (const key of item.keys()) {
    if (!allowed.includes(key)) {
      throw new NotesError(`${where}: unknown key "${key}"`);
    }
  }
  const fields: Record<string, string> = {};
  for (const key of allowed) {
    const value = item.get(key);
    if (value === undefined) {
      throw new NotesError(`${where}: missing "${key}"`);
    }
    if (value === '') {
      throw new NotesError(`${where}: "${key}" is empty`);
    }
    fields[key] = value;
  }
  return fields;
}

function listOf(
  frontmatter: Frontmatter,
  name: 'supersedes' | 'wire',
): Record<string, string>[] {
  if (frontmatter.scalars.has(name)) {
    throw new NotesError(`"${name}" must be a list`);
  }
  return (frontmatter.lists.get(name) ?? []).map((item, index) =>
    fieldsOf(item, LIST_FIELDS[name], `${name} item ${String(index + 1)}`),
  );
}

const KNOWN_WIRE_KINDS: ReadonlySet<string> = new Set(WIRE_KINDS);

function isWireKind(kind: string): kind is Wiring['kind'] {
  return KNOWN_WIRE_KINDS.has(kind);
}

function wiringOf(fields: Record<string, string>, index: number): Wiring {
  const { kind = '', name = '', value = '', because = '' } = fields;
  if (!isWireKind(kind)) {
    throw new NotesError(
      `wire item ${String(index + 1)}: kind "${kind}" is not one of ` +
        WIRE_KINDS.join(', '),
    );
  }
  return { kind, name, value, because };
}

function notesOf(frontmatter: Frontmatter, body: string): UpgradeNotes {
  const version = frontmatter.scalars.get('version') ?? '';
  if (version === '') {
    throw new NotesError('"version" is missing or empty');
  }
  return {
    version,
    supersedes: listOf(frontmatter, 'supersedes').map(
      ({ search = '', because = '' }) => ({ search, because }),
    ),
    wire: listOf(frontmatter, 'wire').map((fields, index) =>
      wiringOf(fields, index),
    ),
    body,
  };
}

/**
 * Read an upgrade-notes file, or say what is wrong with it. Never throws: a
 * caller reading every release's notes reports a bad file and goes on.
 */
export function parseUpgradeNotes(
  text: string,
): { notes: UpgradeNotes } | { error: string } {
  const normalized = text.replaceAll('\r\n', '\n');
  const rest = normalized.slice('---\n'.length);
  const close = /^---$/m.exec(rest);
  if (close === null || !normalized.startsWith('---\n')) {
    return { error: 'no frontmatter: the file must open with a --- block' };
  }
  const body = rest.slice(close.index + '---'.length).trimStart();
  try {
    return {
      notes: notesOf(readFrontmatter(rest.slice(0, close.index)), body),
    };
  } catch (error) {
    return { error: String(error) };
  }
}
