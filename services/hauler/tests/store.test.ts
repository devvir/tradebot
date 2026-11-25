import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The disk: downloads written, flushed and given their place, and what the disk
 * refuses said to be the disk's. See `store.ts`.
 */

const cfg = vi.hoisted(() => ({ archivesDir: '', catalogApi: '', catalogToken: '', venues: [], lens: '', concurrency: 2, minFreeGb: 0 }));

vi.mock('../src/config', () => ({ default: cfg }));

/** What reached the disk, in order — every flush and every rename — and a volume that can be made to run out of room. */
const disk = vi.hoisted(() => ({ steps: [] as string[], noRoom: false }));

vi.mock('node:fs/promises', async (actual) => {
  const real = await actual<typeof import('node:fs/promises')>();

  return {
    ...real,
    open: async (path: string, flags?: string) => {
      if (disk.noRoom && path.endsWith('.part'))
        throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' });

      const handle = await real.open(path, flags);
      const sync   = handle.sync.bind(handle);

      handle.sync = async () => { disk.steps.push(`sync ${path}`); await sync(); };

      return handle;
    },
    rename: async (from: string, to: string) => {
      disk.steps.push(`rename ${to}`);
      await real.rename(from, to);
    },
  };
});

const { DiskError, commit, etagAgrees, isDigest, partialOf, replace, roomRefusedAt, writePartial, _test_forgetRefusal } = await import('../src/store');

const md5 = (bytes: Buffer | string) => createHash('md5').update(bytes).digest('hex');

const body = (...chunks: string[]) => Readable.from(chunks.map(chunk => Buffer.from(chunk)));

beforeEach(() => {
  cfg.archivesDir = mkdtempSync(join(tmpdir(), 'store-'));
  disk.steps = [];
});

afterEach(() => {
  disk.noRoom = false;
  _test_forgetRefusal();
  rmSync(cfg.archivesDir, { recursive: true, force: true });
});

const at = (rel: string) => join(cfg.archivesDir, rel);

describe('a download written', () => {
  it('weighs and hashes as the bytes written', async () => {
    const path    = at('v/a/x.zip');
    const written = await writePartial(path, body('the ', 'whole ', 'file'));

    expect(written).toEqual({ bytes: 14, digest: md5(readFileSync(partialOf(path))) });
    expect(readFileSync(partialOf(path), 'utf8')).toBe('the whole file');
  });

  it('weighs nothing, and hashes as nothing, where the body is empty', async () => {
    expect(await writePartial(at('v/a/x.zip'), body())).toEqual({ bytes: 0, digest: md5('') });
  });

  it('is flushed before it is answered for, and given no name yet', async () => {
    const path = at('v/a/x.zip');

    await writePartial(path, body('bytes'));

    expect(disk.steps).toEqual([`sync ${partialOf(path)}`]);
  });

  /** The way the bytes came failed, not the disk. */
  it('throws what the body threw where the body fails', async () => {
    const failing = Readable.from((async function* () {
      yield Buffer.from('half');
      throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' });
    })());

    const thrown = await writePartial(at('v/a/x.zip'), failing).catch((err: unknown) => err);

    expect(thrown).not.toBeInstanceOf(DiskError);
    expect((thrown as { code?: string }).code).toBe('ECONNRESET');
  });

  it('throws a DiskError where the disk will not take it', async () => {
    writeFileSync(at('.hauler-tmp'), 'a file where scratch goes');

    const thrown = await writePartial(at('v/a/x.zip'), body('bytes')).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(DiskError);
    expect(roomRefusedAt()).toBe(0);
  });

  it('notes a refusal for want of room', async () => {
    disk.noRoom = true;

    const since  = Date.now();
    const thrown = await writePartial(at('v/a/x.zip'), body('bytes')).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(DiskError);
    expect((thrown as InstanceType<typeof DiskError>).code).toBe('ENOSPC');
    expect(roomRefusedAt()).toBeGreaterThanOrEqual(since);
  });
});

describe('a download given its place', () => {
  /** A file counted as downloaded is one a power cut does not take back. */
  it('is renamed, then its directory and every one made for it flushed, up to one already there', async () => {
    const path = at('v/a/b/x.zip');

    await writePartial(path, body('bytes'));

    disk.steps = [];

    await commit(path);

    expect(readFileSync(path, 'utf8')).toBe('bytes');
    expect(disk.steps).toEqual([
      `rename ${path}`, `sync ${at('v/a/b')}`, `sync ${at('v/a')}`, `sync ${at('v')}`, `sync ${cfg.archivesDir}`,
    ]);
  });

  it('flushes only its own directory where that was there already', async () => {
    const path = at('v/a/x.zip');

    mkdirSync(dirname(path), { recursive: true });
    await writePartial(path, body('bytes'));

    disk.steps = [];

    await commit(path);

    expect(disk.steps).toEqual([`rename ${path}`, `sync ${at('v/a')}`]);
  });
});

describe('a file replaced', () => {
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(at(rel)), { recursive: true });
    writeFileSync(at(rel), text);
  };

  it('is simply given its place where nothing was there', async () => {
    const { digest } = await writePartial(at('v/x.zip'), body('new'));

    expect(await replace(at('v/x.zip'), digest)).toBeNull();
    expect(readFileSync(at('v/x.zip'), 'utf8')).toBe('new');
  });

  it('moves what was there aside, once the new one is in hand', async () => {
    put('v/x.zip', 'old');

    const { digest } = await writePartial(at('v/x.zip'), body('new'));

    expect(await replace(at('v/x.zip'), digest)).toBe(at('v/x.zip.bak'));
    expect(readFileSync(at('v/x.zip'), 'utf8')).toBe('new');
    expect(readFileSync(at('v/x.zip.bak'), 'utf8')).toBe('old');
  });

  /** Nothing is kept twice. */
  it('keeps what was there, and drops the download, where they are the same bytes', async () => {
    put('v/x.zip', 'same');

    const { digest } = await writePartial(at('v/x.zip'), body('same'));

    expect(await replace(at('v/x.zip'), digest)).toBeNull();
    expect(readFileSync(at('v/x.zip'), 'utf8')).toBe('same');
    expect(existsSync(at('v/x.zip.bak'))).toBe(false);
    expect(readdirSync(at('.hauler-tmp'))).toEqual([]);
  });
});

describe('an etag', () => {
  const digest = md5('bytes');

  it('agrees with a digest whatever its quotes and case', () => {
    expect(etagAgrees(`"${digest.toUpperCase()}"`, digest)).toBe(true);
    expect(etagAgrees(digest, digest)).toBe(true);
    expect(etagAgrees(`"${md5('other')}"`, digest)).toBe(false);
  });

  it('is a digest only where it is one of the whole object', () => {
    expect(isDigest(`"${digest.toUpperCase()}"`)).toBe(true);
    expect(isDigest(`"${digest}-3"`)).toBe(false);
    expect(isDigest(undefined)).toBe(false);
  });
});
