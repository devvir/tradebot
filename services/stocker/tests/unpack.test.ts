import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unpackAll, weightsOf } from '../src/containers';

/**
 * Archives are presented as paths the engine can read. Most are tiny and there
 * are thousands at a time, so they are read whole and extracted into one
 * directory — and what comes out must be exactly what went in.
 */

let dir: string;

/** A zip of these members, written with the system's own `zip`. */
const zipOf = (name: string, members: Record<string, string>, ...flags: string[]): string => {
  const from = join(dir, `${name}.d`);
  const path = join(dir, name);

  execFileSync('mkdir', ['-p', from]);

  for (const [member, body] of Object.entries(members)) writeFileSync(join(from, member), body);

  execFileSync('zip', ['-q', ...flags, path, ...Object.keys(members)], { cwd: from });

  return path;
};

const read = (paths: string[]): string[] => paths.map(path => readFileSync(path, 'utf8'));

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'unpack-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('unpacking archives', () => {
  it('extracts every member of a zip, as it was', async () => {
    const all = await unpackAll([{ absolute: zipOf('pair.zip', { 'a.csv': '1,2\n', 'b.csv': '3,4\n' }), container: 'zip' }]);

    expect(read(all.paths[0]!)).toEqual(['1,2\n', '3,4\n']);
    expect(all.paths[0]!.every(path => path.endsWith('.csv'))).toBe(true);

    await all.dispose();
  });

  it('reads a member stored without compression', async () => {
    const all = await unpackAll([{ absolute: zipOf('stored.zip', { 'a.csv': 'x'.repeat(2_000) }, '-0'), container: 'zip' }]);

    expect(read(all.paths[0]!)).toEqual(['x'.repeat(2_000)]);

    await all.dispose();
  });

  /** One directory holds them all, so two archives may not write the same name. */
  it('keeps apart archives that hold a member of the same name, each at its place', async () => {
    const inputs = ['one', 'two', 'three'].map(body => ({
      absolute: zipOf(`${body}.zip`, { 'data.csv': body }), container: 'zip',
    }));

    const all = await unpackAll(inputs);

    expect(all.paths.map(read)).toEqual([['one'], ['two'], ['three']]);
    expect(new Set(all.paths.map(paths => dirname(paths[0]!))).size).toBe(1);

    await all.dispose();
  });

  it('removes everything it extracted, at once', async () => {
    const all = await unpackAll([
      { absolute: zipOf('gone-a.zip', { 'a.csv': 'a' }), container: 'zip' },
      { absolute: zipOf('gone-b.zip', { 'b.csv': 'b' }), container: 'zip' },
    ]);

    const extracted = dirname(all.paths[0]![0]!);

    await all.dispose();

    expect(existsSync(extracted)).toBe(false);
  });

  /** What the engine reads by itself is handed over where it lies. */
  it('hands over a file the engine reads natively, untouched', async () => {
    const plain = join(dir, 'plain.csv');

    writeFileSync(plain, '1,2\n');

    const all = await unpackAll([
      { absolute: plain, container: 'plain' },
      { absolute: zipOf('beside.zip', { 'a.csv': 'a' }), container: 'zip' },
    ]);

    expect(all.paths[0]).toEqual([plain]);
    expect(read(all.paths[1]!)).toEqual(['a']);

    await all.dispose();

    expect(existsSync(plain)).toBe(true);
  });

  /** A short or altered member must not reach a table as data. */
  it('refuses a member that does not inflate to what its entry states', async () => {
    const path  = zipOf('bad.zip', { 'a.csv': 'x'.repeat(500) }, '-0');
    const bytes = readFileSync(path);

    // One byte in the middle of the stored payload.
    const at = bytes.indexOf('x'.repeat(500)) + 250;

    bytes[at] = bytes[at]! ^ 0xff;
    writeFileSync(path, bytes);

    await expect(unpackAll([{ absolute: path, container: 'zip' }])).rejects.toThrow(/corrupt zip member/);
  });

  /** An archive the direct read does not recognise goes to the reader that takes any zip. */
  it('still reads a zip whose directory uses the 64-bit form', async () => {
    const all = await unpackAll([{ absolute: zipOf('wide.zip', { 'a.csv': 'wide' }, '-fz-'), container: 'zip' }]);

    expect(read(all.paths[0]!)).toEqual(['wide']);

    await all.dispose();
  });

  /** What extraction writes is known before anything is extracted: a zip states it. */
  it('says what archives inflate to without extracting them', async () => {
    const pair  = zipOf('weighed.zip', { 'a.csv': 'x'.repeat(5_000), 'b.csv': 'y'.repeat(700) });
    const plain = join(dir, 'weighed.csv');

    writeFileSync(plain, '1,2\n');

    expect(await weightsOf([{ absolute: pair, container: 'zip' }, { absolute: plain, container: 'plain' }])).toEqual([5_700, 0]);
  });
});
