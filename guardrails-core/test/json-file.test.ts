import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseJsonText, readJsonFile } from '../src/json-file.js';

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
    const result = readJsonFile(filePath);
    // `toHaveProperty`, not `toEqual` alone: `toEqual` treats `{}` and
    // `{ parsed: undefined }` as equal, so it cannot tell the wrapper apart
    // from an empty object -- which is exactly the mutant this catch block
    // produces. The wrapper existing is the behaviour under test.
    expect(result).toHaveProperty('parsed');
    expect(result.parsed).toBeUndefined();
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

describe('parseJsonText', () => {
  it('parses valid JSON text', () => {
    expect(parseJsonText('{"hello":"world"}')).toEqual({
      parsed: { hello: 'world' },
    });
  });

  it('parses a non-object top level', () => {
    // Every analyzer adapter guards the shape itself; this helper only owns
    // "did it parse at all", so an array or a scalar is a success here.
    expect(parseJsonText('[]')).toEqual({ parsed: [] });
    expect(parseJsonText('null')).toEqual({ parsed: null });
  });

  it('returns parsed: undefined for text that is not JSON, in a wrapper', () => {
    // The wrapper is the whole design: it makes the catch block's mutant
    // OBSERVABLE (emptying it would return `undefined` outright, not an object
    // carrying a `parsed` property), which is what lets four analyzer adapters
    // share this without any of them needing a mutation suppression. See the
    // module header.
    const result = parseJsonText('not json at all');
    expect(result).toHaveProperty('parsed');
    expect(result.parsed).toBeUndefined();
    expect(result).toEqual({ parsed: undefined });
  });

  it('returns parsed: undefined for empty output', () => {
    // The shape a tool that crashed before writing anything produces.
    expect(parseJsonText('')).toEqual({ parsed: undefined });
  });
});
