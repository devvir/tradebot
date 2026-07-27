import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commit, discard, exists, pathFor, sweepPartials, writePartial } from '../src/store';

const body = (...bytes: number[]): ReadableStream<Uint8Array> =>
  new ReadableStream({ start: (c) => { c.enqueue(new Uint8Array(bytes)); c.close(); } });

const fresh = (): string => pathFor('storetest', `${Date.now()}-${Math.random()}.zip`);

describe('writePartial / commit', () => {
  // Verification happens between these two calls, so nothing the resume check
  // would accept may exist until commit has run.
  it('leaves only a .part file until commit promotes it', async () => {
    const absolute = fresh();
    const bytes    = await writePartial(absolute, body(1, 2, 3));

    expect(bytes).toBe(3);
    expect(await exists(absolute)).toBe(false);
    expect((await stat(`${absolute}.part`)).size).toBe(3);

    await commit(absolute);

    expect(await exists(absolute)).toBe(true);
    expect(await stat(`${absolute}.part`).catch(() => null)).toBeNull();
  });

  it('discard removes the partial and never the final file', async () => {
    const absolute = fresh();

    await writePartial(absolute, body(1));
    await discard(absolute);

    expect(await stat(`${absolute}.part`).catch(() => null)).toBeNull();

    await writePartial(absolute, body(1));
    await commit(absolute);
    await discard(absolute);   // nothing partial left — a no-op

    expect(await exists(absolute)).toBe(true);
  });
});

describe('exists', () => {
  it('rejects an empty file — a zero-byte archive is a fault, not data', async () => {
    const absolute = fresh();

    await writePartial(absolute, new ReadableStream({ start: (c) => c.close() }));
    await commit(absolute);

    expect(await exists(absolute)).toBe(false);
  });
});

describe('sweepPartials', () => {
  it('removes leftover .part files at any depth and counts them', async () => {
    const root = pathFor('sweeptest', `${Date.now()}`);

    await mkdir(join(root, 'a/b'), { recursive: true });
    await writeFile(join(root, 'a/one.zip.part'), 'x');
    await writeFile(join(root, 'a/b/two.zip.part'), 'x');
    await writeFile(join(root, 'a/b/keep.zip'), 'x');

    expect(await sweepPartials(root)).toBe(2);
    expect((await readFile(join(root, 'a/b/keep.zip'), 'utf8'))).toBe('x');
  });
});
