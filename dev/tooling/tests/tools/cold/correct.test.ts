import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { membersOf, replaceMembers, writePart } from '../../../src/tools/cold/tar';

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
