import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config';
import { Prefetch, _test_held as held } from '../src/prepare';
import { NoRoom } from '../src/room';
import type { DiskFile, Task } from '../src/types';

/**
 * Archives are extracted ahead of the builds that read them, so the engine is
 * not left waiting — and what is extracted ahead is removed whether or not a
 * build ever comes for it.
 */

let dir: string;

/** A task of one instrument whose single file is a zip holding `body`. */
const zipped = (name: string, body: string): Task => {
  const from = join(dir, `${name}.d`);
  const path = join(dir, `${name}.zip`);

  execFileSync('mkdir', ['-p', from]);
  writeFileSync(join(from, 'k.csv'), body);
  execFileSync('zip', ['-q', path, 'k.csv'], { cwd: from });

  return [{ symbol: name, inputs: [{ absolute: path, size: statSync(path).size, mtimeMs: 0, file: { container: 'zip' } } as unknown as DiskFile] }];
};

/** A task the engine reads where it lies. */
const native = (name: string): Task => {
  const path = join(dir, `${name}.csv`);

  writeFileSync(path, '1\n');

  return [{ symbol: name, inputs: [{ absolute: path, size: 2, mtimeMs: 0, file: { container: 'plain' } } as unknown as DiskFile] }];
};

/** Long enough for whatever was started to finish; nothing here waits on a clock otherwise. */
const settled = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 150)); };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prepare-'));

  await mkdir(config.vaultDir, { recursive: true });
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('extracting ahead of the builds', () => {
  it('hands a build its task\'s archives, in the task\'s order', async () => {
    const ahead = new Prefetch([zipped('a', 'first'), zipped('b', 'second')]);

    const second = await ahead.take(1);
    const first  = await ahead.take(0);

    expect(readFileSync(first.paths[0]![0]!, 'utf8')).toBe('first');
    expect(readFileSync(second.paths[0]![0]!, 'utf8')).toBe('second');

    await first.dispose();
    await second.dispose();

    ahead.release();
  });

  it('has a task extracted before a build asks for it', async () => {
    const ahead = new Prefetch([zipped('early-a', 'x'), zipped('early-b', 'y')]);

    await settled();

    expect(held()).toBeGreaterThan(0);

    const taken = await ahead.take(1);

    expect(existsSync(taken.paths[0]![0]!)).toBe(true);

    await taken.dispose();

    ahead.release();

    await settled();
  });

  it('counts what is extracted until the build removes it', async () => {
    const before = held();
    const ahead  = new Prefetch([zipped('held', 'z'.repeat(1_000))]);
    const taken  = await ahead.take(0);

    expect(held() - before).toBe(1_000);

    await taken.dispose();

    expect(held()).toBe(before);

    ahead.release();
  });

  /** A sweep that stops, or a partition that fails, leaves nothing in scratch. */
  it('removes what was extracted for a build that never came', async () => {
    const before = held();
    const ahead  = new Prefetch([zipped('orphan-a', 'x'), zipped('orphan-b', 'only the orphan holds this')]);
    const peek   = await ahead.take(0);
    const where  = dirname(dirname(peek.paths[0]![0]!));

    await peek.dispose();
    await settled();

    // Scratch is shared with whatever else is running, so the orphan is found by what it holds.
    const orphan = execFileSync('grep', ['-rl', 'only the orphan holds this', where]).toString().trim();

    expect(orphan).not.toBe('');

    ahead.release();

    await settled();

    expect(held()).toBe(before);
    expect(existsSync(dirname(orphan))).toBe(false);
  });

  /** Nothing here knows a venue or a format: what needs no extracting passes straight through. */
  it('costs nothing for a task the engine reads natively', async () => {
    const before = held();
    const task   = native('plain');
    const ahead  = new Prefetch([task]);
    const taken  = await ahead.take(0);

    expect(taken.paths).toEqual([[task[0]!.inputs[0]!.absolute]]);
    expect(held()).toBe(before);

    await taken.dispose();

    ahead.release();
  });

  it('says what went wrong to the build that asks, and holds nothing for it', async () => {
    const before = held();
    const broken: Task = [{ symbol: 'x', inputs: [{ absolute: join(dir, 'missing.zip'), size: 10, mtimeMs: 0, file: { container: 'zip' } } as unknown as DiskFile] }];
    const ahead  = new Prefetch([broken]);

    await expect(ahead.take(0)).rejects.toThrow();

    expect(held()).toBe(before);

    ahead.release();
  });

  /** Nothing is extracted that would leave the volume under its floor: asked before, never found out by a failed write. */
  it('extracts nothing there is no room for, and extracts it once there is', async () => {
    const before = held();
    const floor  = config.minFreeGb;

    config.minFreeGb = 1e9;

    try {
      const ahead = new Prefetch([zipped('roomless-a', 'x'), zipped('roomless-b', 'y')]);

      await settled();

      // Not extracted ahead, and not to the build that asks either.
      expect(held()).toBe(before);

      await expect(ahead.take(0)).rejects.toBeInstanceOf(NoRoom);

      expect(held()).toBe(before);

      config.minFreeGb = floor;

      const taken = await ahead.take(1);

      expect(readFileSync(taken.paths[0]![0]!, 'utf8')).toBe('y');

      await taken.dispose();

      ahead.release();
    } finally {
      config.minFreeGb = floor;
    }
  });
});
