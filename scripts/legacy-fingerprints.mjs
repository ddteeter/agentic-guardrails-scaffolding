#!/usr/bin/env node
// One-shot generator for guardrails-core/scaffold-data/legacy-fingerprints.json:
// exact checksum -> fingerprint for every owned file a release up to 0.11.1
// could have written into a consumer repo. Manifests written by those
// releases carry no fingerprints, so this table is how `init` tells a
// reformat of what it wrote from an edit (see manifest.ts `modificationOf`).
// From 0.12.0 on every write records its own fingerprint, so this never needs
// re-running; it is kept to show how the committed table was produced.
//
// The table is keyed by checksum, so including a file `init` never writes
// costs nothing: its checksum just never matches a manifest. That is why it
// takes every file under templates/ and guidance/ rather than mirroring
// `buildDesiredFiles`, and also builds each skill's SKILL.md both with and
// without its provenance comment (the comment-stripping came in a later
// release than the skills did).
//
// The two hash functions restate manifest.ts's `checksum` and `fingerprint`;
// test/scaffold/legacy-fingerprints.test.ts checks the committed table
// against the real ones.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LAST_PRE_FINGERPRINT_RELEASE = [0, 11, 1];

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(
  root,
  'guardrails-core',
  'scaffold-data',
  'legacy-fingerprints.json',
);

const checksum = (content) =>
  `sha256-${createHash('sha256').update(content, 'utf8').digest('hex')}`;
const fingerprint = (content) =>
  `words-${checksum(content.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, ''))}`;

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function isCovered(tag) {
  const parts = tag.replace(/^v/, '').split('.').map(Number);
  for (const [index, limit] of LAST_PRE_FINGERPRINT_RELEASE.entries()) {
    if (parts[index] !== limit) return parts[index] < limit;
  }
  return true;
}

function filesUnder(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function skillVariants(guidance) {
  let index;
  try {
    index = JSON.parse(readFileSync(path.join(guidance, 'index.json'), 'utf8'));
  } catch {
    return [];
  }
  const variants = [];
  for (const [name, description] of Object.entries(index)) {
    let document;
    try {
      document = readFileSync(path.join(guidance, `${name}.md`), 'utf8');
    } catch {
      continue;
    }
    const bodyAt = document.indexOf('\n\n');
    const stripped = bodyAt === -1 ? document : document.slice(bodyAt + 2);
    for (const body of new Set([document, stripped])) {
      variants.push(
        [
          '---',
          `name: ${name}`,
          `description: ${description}`,
          '---',
          '',
          body,
        ].join('\n'),
      );
    }
  }
  return variants;
}

const table = {};
const tags = git('tag', '--list', 'v*')
  .split('\n')
  .filter(Boolean)
  .filter(isCovered);
for (const tag of tags) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'legacy-fingerprints-'));
  try {
    const archive = execFileSync(
      'git',
      ['archive', tag, 'guardrails-core/templates', 'guardrails-core/guidance'],
      { cwd: root },
    );
    execFileSync('tar', ['-x', '-C', scratch], { input: archive });
    const core = path.join(scratch, 'guardrails-core');
    const contents = [
      ...filesUnder(path.join(core, 'templates')),
      ...filesUnder(path.join(core, 'guidance')),
    ].map((file) => readFileSync(file, 'utf8'));
    for (const content of [
      ...contents,
      ...skillVariants(path.join(core, 'guidance')),
    ]) {
      table[checksum(content)] = fingerprint(content);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const sorted = Object.fromEntries(
  Object.entries(table).toSorted(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(output, `${JSON.stringify(sorted, undefined, 2)}\n`);
console.log(
  `${Object.keys(sorted).length} entries from ${tags.length} tags -> ${path.relative(root, output)}`,
);
