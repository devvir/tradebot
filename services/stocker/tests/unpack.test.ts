import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unpackAll, weightsOf } from '../src/containers';
import { containerFor } from '../src/containers/registry';
import { extractInto } from '../src/containers/extract';

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

  for (const [member, body] of Object.entries(members)) {
    execFileSync('mkdir', ['-p', dirname(join(from, member))]);
    writeFileSync(join(from, member), body);
  }

  execFileSync('zip', ['-q', ...flags, path, ...Object.keys(members)], { cwd: from });

  return path;
};

/** A tar.gz of these members, written with the system's own `tar`. */
const tarOf = (name: string, members: Record<string, string>): string => {
  const from = join(dir, `${name}.d`);
  const path = join(dir, name);

  for (const [member, body] of Object.entries(members)) {
    execFileSync('mkdir', ['-p', dirname(join(from, member))]);
    writeFileSync(join(from, member), body);
  }

  execFileSync('tar', ['-czf', path, ...Object.keys(members)], { cwd: from });

  return path;
};

/** A zip forced into the 64-bit form, which the direct read leaves to the streaming one. */
const wideOf = (name: string, members: Record<string, string>): string => {
  const path = zipOf(name, members, '-fz');

  // The zip64 end-of-directory record: without it this would test nothing.
  expect(readFileSync(path).includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
  expect(containerFor('zip').members!(path)).toBeNull();

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
  it('streams a zip whose directory uses the 64-bit form', async () => {
    const all = await unpackAll([{ absolute: wideOf('wide.zip', { 'a.csv': 'wide', 'b.csv': 'wider' }), container: 'zip' }]);

    expect(read(all.paths[0]!)).toEqual(['wide', 'wider']);

    await all.dispose();
  });

  /** Two members of one name in different folders are two files, read whole or streamed. */
  it('keeps apart members of one archive that share a name', async () => {
    const members = { 'a/data.csv': '1,first\n', 'b/data.csv': '2,second\n' };

    const all = await unpackAll([
      { absolute: zipOf('folders.zip', members), container: 'zip' },
      { absolute: wideOf('folders-wide.zip', members), container: 'zip' },
    ]);

    for (const paths of all.paths) {
      expect(new Set(paths).size).toBe(2);
      expect(read(paths)).toEqual(['1,first\n', '2,second\n']);
      expect(paths.every(path => basename(path).endsWith('data.csv'))).toBe(true);
    }

    await all.dispose();
  });

  /** Members that cannot be gathered are written out one by one, and still as two files. */
  it('keeps apart same-named members it does not gather', async () => {
    const out    = join(dir, 'ungathered');
    const quoted = zipOf('quoted.zip', { 'a/q.csv': '"1",a\n', 'b/q.csv': '"2",b\n' });

    await mkdir(out, { recursive: true });

    const extracted = await extractInto([{ absolute: quoted, container: 'zip', shape: 0 }], out, [{ header: false }]);

    expect(new Set(extracted.paths[0]!).size).toBe(2);
    expect(read(extracted.paths[0]!)).toEqual(['"1",a\n', '"2",b\n']);
  });

  /** What would inflate past what is held in memory is streamed, however small the archive on disk. */
  it('streams a small zip whose members state more than is inflated in memory', async () => {
    const size = 64 * 1024 ** 2 + 1;
    const path = zipOf('dense.zip', { 'zeros.csv': '0'.repeat(size) });

    expect(containerFor('zip').members!(path)).toBeNull();

    const all = await unpackAll([{ absolute: path, container: 'zip' }]);
    const out = readFileSync(all.paths[0]![0]!);

    expect(out.length).toBe(size);
    expect(out.every(byte => byte === 0x30)).toBe(true);

    await all.dispose();
  }, 60_000);

  /** No member is inflated past the size its entry states. */
  it('refuses a member that inflates to more than its entry states', async () => {
    const path  = zipOf('liar.zip', { 'a.csv': 'x'.repeat(5_000) });
    const bytes = readFileSync(path);
    const entry = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));

    // The central directory says it holds a tenth of what it does.
    bytes.writeUInt32LE(500, entry + 24);
    writeFileSync(path, bytes);

    // Stopped at the size stated, not inflated whole and measured after.
    expect(() => containerFor('zip').members!(path)).toThrow(expect.objectContaining({
      message: expect.stringMatching(/corrupt zip member/),
      cause:   expect.any(RangeError),
    }));
    await expect(unpackAll([{ absolute: path, container: 'zip' }])).rejects.toThrow(/corrupt zip member/);
  });

  it('extracts a tar.gz, returning each file where it was written', async () => {
    const all = await unpackAll([
      { absolute: tarOf('top.tar.gz', { 'x.data': '{"a":1}\n' }), container: 'tar.gz' },
      { absolute: tarOf('nested.tar.gz', { 'd/x.data': '{"b":2}\n', 'e/x.data': '{"c":3}\n' }), container: 'tar.gz' },
    ]);

    expect(all.paths.flat().every(path => existsSync(path))).toBe(true);
    expect(all.paths.map(read)).toEqual([['{"a":1}\n'], ['{"b":2}\n', '{"c":3}\n']]);

    await all.dispose();
  });

  /** What extraction writes is known before anything is extracted: a zip states it. */
  it('says what archives inflate to without extracting them', async () => {
    const pair  = zipOf('weighed.zip', { 'a.csv': 'x'.repeat(5_000), 'b.csv': 'y'.repeat(700) });
    const plain = join(dir, 'weighed.csv');

    writeFileSync(plain, '1,2\n');

    expect(await weightsOf([{ absolute: pair, container: 'zip' }, { absolute: plain, container: 'plain' }])).toEqual([5_700, 0]);
  });

  it('says what a zip in the 64-bit form inflates to', async () => {
    const wide = wideOf('weighed-wide.zip', { 'a.csv': 'x'.repeat(5_000), 'b.csv': 'y'.repeat(700) });

    expect(await weightsOf([{ absolute: wide, container: 'zip' }])).toEqual([5_700]);
  });
});
