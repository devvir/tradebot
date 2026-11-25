import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replaceMembers } from '../../../src/tools/cold/push/archives/correct';
import { writePart } from '../../../src/tools/cold/push/archives/pack';
import { extractMembers, membersOf, sizedMembersOf, tarSize } from '../../../src/tools/cold/shared/tar';

/**
 * The point of this is checking a tar that is *only* in cold storage: its size
 * in Mega's listing against what its `member` rows imply, with no download. So
 * it has to be exact rather than close.
 *
 * Verified against five real tars — 744, 1,677, 9,883, 405,422 and 12 members —
 * every one predicted to the byte.
 */
describe('predicting a tar size from its member list', () => {
  it('accounts for headers, padding and the blocking factor', () => {
    // 512 header + 512 padded content + 1024 trailer = 2,048, padded up to the
    // 10,240 blocking factor.
    expect(tarSize([{ path: 'a', bytes: 100 }])).toBe(10_240);
  });

  /**
   * Enough members that the extra blocks cross a boundary — a single one pads
   * into the same 10,240 block either way, which is why the real tars proved
   * this and a one-member case could not.
   */
  it('adds a long-name header for a path past 100 bytes', () => {
    const many  = (name: string) => Array.from({ length: 20 }, () => ({ path: name, bytes: 1 }));
    const short = tarSize(many('a'.repeat(100)));
    const long  = tarSize(many('a'.repeat(101)));

    // 20 members × (512 long-name header + 512 padded name) = 20,480 more.
    expect(long - short).toBe(20_480);
  });

  /** A path is measured in bytes, not characters, or a CJK name under-counts. */
  it('measures a path in bytes rather than characters', () => {
    const wide = '好'.repeat(40);   // 40 characters, 120 bytes — past the limit.

    expect(Buffer.byteLength(wide)).toBeGreaterThan(100);
    expect(tarSize(Array.from({ length: 20 }, () => ({ path: wide, bytes: 1 }))))
      .toBeGreaterThan(tarSize(Array.from({ length: 20 }, () => ({ path: 'a', bytes: 1 }))));
  });

  it('grows in blocking-factor steps, never between them', () => {
    const sizes = [1, 50, 500, 5_000].map(n =>
      tarSize(Array.from({ length: n }, (_, i) => ({ path: `p${i}`, bytes: 1_000 }))));

    for (const size of sizes) expect(size % 10_240).toBe(0);
  });

  it('is empty-safe', () => {
    expect(tarSize([])).toBe(10_240);
  });
});

describe('a member whose name has unusual characters', () => {
  /** A backslash, which a list read as tar reads one by default takes for an escape, and a listing quotes. */
  const unusual = ['v/c\\d', 'v/\u00fc.zip', 'v/with space', 'v/-dash'];

  let dir: string;

  const source = (): string => path.join(dir, 'source');
  const tar    = (): string => path.join(dir, 'one.tar');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-tar-'));

    for (const [at, name] of [...unusual, 'v/plain', 'v/added\\too'].entries()) {
      fs.mkdirSync(path.dirname(path.join(source(), name)), { recursive: true });
      fs.writeFileSync(path.join(source(), name), 'x'.repeat(at + 1));
    }
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is packed, and listed by the name it has on disk', async () => {
    await writePart(source(), tar(), [...unusual, 'v/plain']);

    expect((await membersOf(tar())).sort()).toEqual([...unusual, 'v/plain'].sort());
    expect((await sizedMembersOf(tar())).map(one => one.path).sort()).toEqual([...unusual, 'v/plain'].sort());
  });

  it('is taken out by that name', async () => {
    await writePart(source(), tar(), [...unusual, 'v/plain']);
    await extractMembers(tar(), path.join(dir, 'out'), unusual);

    for (const name of unusual) expect(fs.readFileSync(path.join(dir, 'out', name), 'utf8')).toBe(fs.readFileSync(path.join(source(), name), 'utf8'));
  });

  it('is removed from a tar and added to one by that name', async () => {
    await writePart(source(), tar(), [...unusual, 'v/plain']);
    await replaceMembers(source(), tar(), ['v/c\\d'], ['v/added\\too']);

    expect((await membersOf(tar())).sort()).toEqual([...unusual.filter(one => one !== 'v/c\\d'), 'v/plain', 'v/added\\too'].sort());
  });
});
