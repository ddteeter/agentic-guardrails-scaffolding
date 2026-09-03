import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readJsonFile } from '../src/json-file.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'guardrails-json-file-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readJsonFile', () => {
  it('parses a valid JSON file', async () => {
    const filePath = path.join(root, 'data.json');
    await writeFile(filePath, JSON.stringify({ hello: 'world' }), 'utf8');
    expect(readJsonFile(filePath)).toEqual({ parsed: { hello: 'world' } });
  });

  it('returns parsed: undefined for a missing file', () => {
    const filePath = path.join(root, 'does-not-exist.json');
    expect(readJsonFile(filePath)).toEqual({ parsed: undefined });
  });

  it('returns parsed: undefined for a malformed file, distinct from a bare undefined', async () => {
    const filePath = path.join(root, 'broken.json');
    await writeFile(filePath, '{ not json', 'utf8');
    const result = readJsonFile(filePath);
    // The wrapper itself must exist even on failure — this is what makes the
    // catch block's mutant observable: emptying it would return `undefined`
    // outright, not an object with a `parsed` property.
    expect(result).toHaveProperty('parsed');
    expect(result.parsed).toBeUndefined();
    expect(result).toEqual({ parsed: undefined });
  });
});
