import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { correctionOf, replaceMembers } from '../../../src/tools/cold/push/archives/correct';
import { membersOf, sizedMembersOf } from '../../../src/tools/cold/shared/tar';
import { writePart } from '../../../src/tools/cold/push/archives/pack';

/**
 * A stored tar brought back because one partition in it changed: the old
 * partition comes out and the new one goes in, and everything else in the tar
 * stays exactly as it was — without being on this disk at all.
 */

let dir:  string;
let root: string;
let tar:  string;

const put = (relative: string, content: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
};

const read = (member: string): string =>
  execFileSync('tar', ['-xOf', tar, member]).toString();

beforeEach(async () => {
  dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-correct-'));
  root = path.join(dir, 'archives');
  tar  = path.join(dir, 'staged', 'gate-202006.001.tar');

  put('trades/a.zip', 'old-a');
  put('trades/b.zip', 'old-b');
  put('klines/k.zip', 'klines');

  await writePart(root, tar, ['klines/k.zip', 'trades/a.zip', 'trades/b.zip']);
});

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('correcting a tar', () => {
  it('takes the old partition out and puts the new one in', async () => {
    // The partition changed: one file rewritten, one gone, one new.
    fs.rmSync(path.join(root, 'trades/b.zip'));
    put('trades/a.zip', 'new-a');
    put('trades/c.zip', 'new-c');

    await replaceMembers(root, tar, ['trades/a.zip', 'trades/b.zip'], ['trades/a.zip', 'trades/c.zip']);

    expect((await membersOf(tar)).sort()).toEqual(['klines/k.zip', 'trades/a.zip', 'trades/c.zip']);
    expect(read('trades/a.zip')).toBe('new-a');
    expect(read('trades/c.zip')).toBe('new-c');
  });

  /** The rest of the tar is no longer on this disk, and is neither read nor needed. */
  it('leaves everything else as it was, without it being on disk', async () => {
    fs.rmSync(path.join(root, 'klines'), { recursive: true });
    put('trades/a.zip', 'new-a');

    await replaceMembers(root, tar, ['trades/a.zip', 'trades/b.zip'], ['trades/a.zip']);

    expect(read('klines/k.zip')).toBe('klines');
    expect((await membersOf(tar)).sort()).toEqual(['klines/k.zip', 'trades/a.zip']);
  });

  /** A run stopped partway must find the tar as it was brought back. */
  it('leaves the tar untouched where a new file is not there to add', async () => {
    const before = fs.readFileSync(tar);

    await expect(replaceMembers(root, tar, ['trades/a.zip'], ['trades/missing.zip'])).rejects.toThrow();

    expect(fs.readFileSync(tar).equals(before)).toBe(true);
    expect(fs.existsSync(`${tar}.tmp`)).toBe(false);
  });
});

/**
 * A partition taken off the disk after it was stored comes back only in the
 * files that changed. The tar has the rest, so the two together are the
 * partition — where they add up to what the catalog says.
 */
describe('a partition that changed after it left the disk', () => {
  const trades = async () => (await sizedMembersOf(tar)).filter(one => one.path.startsWith('trades/'));

  it('reads what a tar holds and what each member weighs', async () => {
    expect((await sizedMembersOf(tar)).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'klines/k.zip', bytes: 6 }, { path: 'trades/a.zip', bytes: 5 }, { path: 'trades/b.zip', bytes: 5 },
    ]);
  });

  it('is made whole from the changed file on disk and the rest in the tar', async () => {
    // Evicted, then one file replaced by the venue and downloaded again: only that one is here.
    fs.rmSync(path.join(root, 'trades'), { recursive: true });
    put('trades/a.zip', 'newer-a');

    const fix = correctionOf(await trades(), [{ path: 'trades/a.zip', bytes: 7 }], { files: 2, bytes: 12 });

    expect(fix).toEqual({ remove: ['trades/a.zip'], add: ['trades/a.zip'] });

    await replaceMembers(root, tar, fix!.remove, fix!.add);

    expect(read('trades/a.zip')).toBe('newer-a');
    expect(read('trades/b.zip')).toBe('old-b');
    expect((await membersOf(tar)).sort()).toEqual(['klines/k.zip', 'trades/a.zip', 'trades/b.zip']);
  });

  it('takes in a file the venue added, beside what the tar holds', async () => {
    expect(correctionOf(await trades(), [{ path: 'trades/c.zip', bytes: 4 }], { files: 3, bytes: 14 }))
      .toEqual({ remove: [], add: ['trades/c.zip'] });
  });

  /** Whole on disk: the tar's copy is not consulted at all. */
  it('is taken from the disk alone where the disk has all of it', async () => {
    expect(correctionOf(await trades(), [{ path: 'trades/a.zip', bytes: 7 }, { path: 'trades/z.zip', bytes: 3 }], { files: 2, bytes: 10 }))
      .toEqual({ remove: ['trades/a.zip', 'trades/b.zip'], add: ['trades/a.zip', 'trades/z.zip'] });
  });

  /** A file withdrawn, or a download not here yet: the two do not add up, and nothing is guessed. */
  it('is left alone where disk and tar do not add up to what the catalog says', async () => {
    expect(correctionOf(await trades(), [{ path: 'trades/a.zip', bytes: 7 }], { files: 1, bytes: 7 })).not.toBeNull();
    expect(correctionOf(await trades(), [{ path: 'trades/a.zip', bytes: 7 }], { files: 3, bytes: 20 })).toBeNull();
    expect(correctionOf(await trades(), [{ path: 'trades/a.zip', bytes: 7 }], { files: 2, bytes: 13 })).toBeNull();
    expect(correctionOf(await trades(), [], { files: 2, bytes: 10 })).toBeNull();
  });
});
