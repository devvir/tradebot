import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync } from 'fs';
import { gunzipSync, gzipSync, inflateRawSync } from 'zlib';
import { Readable } from 'stream';
import * as os from 'os';
import * as path from 'path';

// ── Record every fsync (path) without changing behaviour ─────────────────────

const synced = vi.hoisted(() => [] as string[]);

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();

  return {
    ...actual,
    open: async (p: string, flags?: string) => {
      const handle = await actual.open(p, flags);
      const sync   = handle.sync.bind(handle);

      handle.sync = async () => { synced.push(String(p)); return sync(); };

      return handle;
    },
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual  = await importOriginal<typeof import('fs')>();
  const fdPaths = new Map<number, string>();

  return {
    ...actual,
    openSync: (p: string, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...a: unknown[]) => number)(p, ...rest);
      fdPaths.set(fd, String(p));
      return fd;
    },
    fsyncSync: (fd: number) => {
      synced.push(fdPaths.get(fd) ?? `fd:${fd}`);
      actual.fsyncSync(fd);
    },
  };
});

// ── Redirect storage paths to a temp dir ─────────────────────────────────────

let tmpDir: string;

vi.mock('../../src/fs/paths', () => {
  const dataDir    = () => tmpDir;
  const tableDir   = (table: string) => path.join(dataDir(), table);
  const yearDir    = (table: string, filename: string) => path.join(tableDir(table), filename.slice(0, 4));
  const openPath   = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz.tmp`);
  const closedPath = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz`);

  return { get DATA_DIR() { return dataDir(); }, tableDir, yearDir, openPath, closedPath };
});

vi.mock('../../src/fs/health', () => ({
  recordFailure: vi.fn(),
}));

import {
  appendBatch,
  isInitialized,
  deleteFile,
  storeFile,
  removeStaleUploads,
  drainAll,
  _test_reset as resetWriter,
} from '../../src/fs/writer';
import { recordFailure } from '../../src/fs/health';
import { openPath, closedPath } from '../../src/fs/paths';
import { fileState } from '../../src/fs/reader';
import { AlreadyExistsError, InvalidUploadError } from '../../src/fs/errors';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The text of every gzip member in the file: gunzip reads concatenated members as one stream. */
const readMembers = (filePath: string): string => gunzipSync(readFileSync(filePath)).toString('utf8');

/**
 * The text of each gzip member in the file, in order. Each member's deflate
 * stream is inflated on its own, which reports how many bytes it used, so the
 * next member is found without scanning the compressed bytes for a magic.
 */
const memberTexts = (filePath: string): string[] => {
  const buf   = readFileSync(filePath);
  const texts: string[] = [];
  let offset  = 0;

  while (offset < buf.length) {
    expect([buf[offset], buf[offset + 1]]).toEqual([0x1f, 0x8b]);

    // Skip the 10-byte fixed header and whichever optional fields FLG names.
    const flags = buf[offset + 3]!;
    let body    = offset + 10;

    if (flags & 0x04) body += 2 + buf.readUInt16LE(body);
    if (flags & 0x08) body  = buf.indexOf(0, body) + 1;
    if (flags & 0x10) body  = buf.indexOf(0, body) + 1;
    if (flags & 0x02) body += 2;

    const { buffer, engine } = inflateRawSync(buf.subarray(body), { info: true }) as unknown as
      { buffer: Buffer; engine: { bytesWritten: number } };

    texts.push(buffer.toString('utf8'));
    offset = body + engine.bytesWritten + 8;
  }

  return texts;
};

const rows = (n: number): string[] => Array.from({ length: n }, (_, i) => `row-${i}`);

/** A stream of `body` in small chunks, each after a short delay. */
const slowly = (body: Buffer, chunk = 64): Readable => Readable.from((async function* () {
  for (let i = 0; i < body.length; i += chunk) {
    await new Promise(r => setTimeout(r, 1));
    yield body.subarray(i, i + chunk);
  }
})());

beforeEach(() => {
  tmpDir = mkdirSync(path.join(os.tmpdir(), `vault-writer-test-${Date.now()}-${Math.random()}`), { recursive: true }) as string;
  resetWriter();
  vi.clearAllMocks();
  synced.length = 0;
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ── isInitialized ─────────────────────────────────────────────────────────────

describe('isInitialized', () => {
  it('is false when no .csv.gz.tmp exists and no in-memory handle', () => {
    expect(isInitialized('trade', '20230201')).toBe(false);
  });

  it('is true after a .csv.gz.tmp exists on disk (no in-memory handle yet)', () => {
    const dir = path.join(tmpDir, 'trade', '2023');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '20230201.csv.gz.tmp'), gzipSync('header\n'));

    expect(isInitialized('trade', '20230201')).toBe(true);
  });

  it('is true after appendBatch creates the handle', async () => {
    await appendBatch('trade', '20230201', ['line1']);

    expect(isInitialized('trade', '20230201')).toBe(true);
  });
});

// ── appendBatch — basics ──────────────────────────────────────────────────────

describe('appendBatch', () => {
  it('writes a single gzip member and produces a readable file', async () => {
    await appendBatch('trade', '20230201', ['col1,col2', '1,2']);

    const tmp = openPath('trade', '20230201');
    expect(existsSync(tmp)).toBe(true);
    expect(readMembers(tmp)).toBe('col1,col2\n1,2\n');
  });

  it('appends multiple members across calls (resulting file is multi-member gzip)', async () => {
    await appendBatch('trade', '20230201', ['col1,col2']);
    await appendBatch('trade', '20230201', ['1,2']);
    await appendBatch('trade', '20230201', ['3,4']);

    expect(memberTexts(openPath('trade', '20230201'))).toEqual(['col1,col2\n', '1,2\n', '3,4\n']);
  });

  it('serialises concurrent writes (FIFO order preserved)', async () => {
    const a = appendBatch('trade', '20230201', ['line-a']);
    const b = appendBatch('trade', '20230201', ['line-b']);
    const c = appendBatch('trade', '20230201', ['line-c']);

    await Promise.all([a, b, c]);

    const tmp = openPath('trade', '20230201');
    expect(readMembers(tmp)).toBe('line-a\nline-b\nline-c\n');
  });

  it('preserves earlier data when resuming a pre-existing .csv.gz.tmp', async () => {
    // Seed the file with prior content as if vault had restarted mid-day.
    const dir = path.join(tmpDir, 'trade', '2023');
    mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '20230201.csv.gz.tmp');
    writeFileSync(tmp, gzipSync('header\nold-1\n'));

    await appendBatch('trade', '20230201', ['new-1', 'new-2']);

    expect(readMembers(tmp)).toBe('header\nold-1\nnew-1\nnew-2\n');
  });

  it('is a no-op when given an empty lines array (no member written)', async () => {
    // First write to create the file.
    await appendBatch('trade', '20230201', ['header']);
    const tmp  = openPath('trade', '20230201');
    const size = statSync(tmp).size;

    await appendBatch('trade', '20230201', []);

    expect(statSync(tmp).size).toBe(size);
  });
});

// ── appendBatch — sealing ─────────────────────────────────────────────────────

describe('appendBatch — seal', () => {
  it('renames .csv.gz.tmp to .csv.gz when seal=true', async () => {
    await appendBatch('trade', '20230201', ['header']);
    await appendBatch('trade', '20230201', ['data-1'], true);

    expect(existsSync(openPath('trade', '20230201'))).toBe(false);
    expect(existsSync(closedPath('trade', '20230201'))).toBe(true);
  });

  it('writes a suffixed filename next to the bare-date file in the same year dir', async () => {
    await appendBatch('trade', '20230201',          ['bare']);
    await appendBatch('trade', '20230201.snapshot', ['snap']);

    const bareTmp = openPath('trade', '20230201');
    const snapTmp = openPath('trade', '20230201.snapshot');

    expect(existsSync(bareTmp)).toBe(true);
    expect(existsSync(snapTmp)).toBe(true);
    expect(path.dirname(bareTmp)).toBe(path.dirname(snapTmp));
    expect(readMembers(snapTmp)).toBe('snap\n');
  });

  it('seals even when the lines array is empty (no final member written)', async () => {
    await appendBatch('trade', '20230201', ['header']);
    await appendBatch('trade', '20230201', [], true);

    expect(existsSync(closedPath('trade', '20230201'))).toBe(true);
  });

  it('drops the in-memory handle after sealing', async () => {
    await appendBatch('trade', '20230201', ['header'], true);

    expect(isInitialized('trade', '20230201')).toBe(false);
  });
});

// ── deleteFile / drainAll ─────────────────────────────────────────────────────

describe('deleteFile', () => {
  it('unlinks .csv.gz.tmp and drops the handle (idempotent)', async () => {
    await appendBatch('trade', '20230201', ['header']);

    await deleteFile('trade', '20230201');

    expect(existsSync(openPath('trade', '20230201'))).toBe(false);
    expect(isInitialized('trade', '20230201')).toBe(false);

    // Calling again (and with no writer, no file) resolves.
    await expect(deleteFile('trade', '20230201')).resolves.toBeUndefined();
    await expect(deleteFile('trade', '20991231')).resolves.toBeUndefined();
  });

  it('removes an open file left on disk with no writer', async () => {
    const dir = path.join(tmpDir, 'trade', '2023');
    mkdirSync(dir, { recursive: true });
    writeFileSync(openPath('trade', '20230201'), gzipSync('header\n'));

    await deleteFile('trade', '20230201');

    expect(fileState('trade', '20230201')).toBe('none');
  });

  it('leaves no open file behind when members are still queued', async () => {
    void appendBatch('trade', '20230201', ['header']);
    void appendBatch('trade', '20230201', rows(2_000));

    await deleteFile('trade', '20230201');
    await drainAll();

    expect(existsSync(openPath('trade', '20230201'))).toBe(false);
    expect(fileState('trade', '20230201')).toBe('none');
  });

  it('lets a later upload store exactly its own bytes', async () => {
    void appendBatch('trade', '20230201', ['header']);
    void appendBatch('trade', '20230201', rows(2_000));

    await deleteFile('trade', '20230201');

    const body = gzipSync('uploaded-header\nuploaded-row\n');
    await storeFile('trade', '20230201', slowly(body));
    await drainAll();

    expect(readFileSync(closedPath('trade', '20230201'))).toEqual(body);
    expect(existsSync(openPath('trade', '20230201'))).toBe(false);
  });
});

// ── storeFile ─────────────────────────────────────────────────────────────────

describe('storeFile', () => {
  const yearFiles = () => readdirSync(path.join(tmpDir, 'trade', '2023'));

  it('publishes the stream as the closed file and leaves no temp file', async () => {
    const body = Buffer.concat([gzipSync('header\n'), gzipSync('row\n')]);

    await storeFile('trade', '20230201', Readable.from([body]));

    expect(readFileSync(closedPath('trade', '20230201'))).toEqual(body);
    expect(yearFiles()).toEqual(['20230201.csv.gz']);
    expect(fileState('trade', '20230201')).toBe('closed');
  });

  it('fsyncs the stored file before publishing it and the year directory after', async () => {
    mkdirSync(path.join(tmpDir, 'trade', '2023'), { recursive: true });

    await storeFile('trade', '20230201', Readable.from([gzipSync('x\n')]));

    expect(synced).toHaveLength(2);
    expect(synced[0]).toMatch(/20230201\.csv\.gz\.upload-/);
    expect(synced[1]).toBe(path.join(tmpDir, 'trade', '2023'));
  });

  it('rejects an empty body and leaves nothing behind', async () => {
    await expect(storeFile('trade', '20230201', Readable.from([Buffer.alloc(0)])))
      .rejects.toBeInstanceOf(InvalidUploadError);

    expect(yearFiles()).toEqual([]);
    expect(fileState('trade', '20230201')).toBe('none');
  });

  it.each([
    ['not gzip',         Buffer.from('this is not gzip')],
    ['truncated',        gzipSync('header\nrow\n').subarray(0, 12)],
    ['trailing garbage', Buffer.concat([gzipSync('header\n'), Buffer.from('junk')])],
  ])('rejects a %s body and leaves nothing behind', async (_name, body) => {
    await expect(storeFile('trade', '20230201', Readable.from([body])))
      .rejects.toBeInstanceOf(InvalidUploadError);

    expect(yearFiles()).toEqual([]);
  });

  it('rejects when the source errors mid-stream and leaves neither temp nor closed file', async () => {
    const body   = gzipSync('header\n');
    const source = new Readable({ read() {} });

    source.push(body.subarray(0, 5));
    setTimeout(() => source.destroy(new Error('client went away')), 10);

    await expect(storeFile('trade', '20230201', source)).rejects.toThrow('client went away');

    expect(yearFiles()).toEqual([]);
    expect(fileState('trade', '20230201')).toBe('none');
  });

  it('leaves nothing behind when the source fails before any byte arrives', async () => {
    const source = new Readable({ read() { this.destroy(new Error('reset')); } });

    await expect(storeFile('trade', '20230201', source)).rejects.toThrow('reset');

    expect(yearFiles()).toEqual([]);
  });

  it('never replaces an existing closed file', async () => {
    const first = gzipSync('first\n');

    await storeFile('trade', '20230201', Readable.from([first]));

    await expect(storeFile('trade', '20230201', Readable.from([gzipSync('second\n')])))
      .rejects.toBeInstanceOf(AlreadyExistsError);

    expect(readFileSync(closedPath('trade', '20230201'))).toEqual(first);
    expect(yearFiles()).toEqual(['20230201.csv.gz']);
  });

  it('lets exactly one of two concurrent uploads win, with its own bytes', async () => {
    const a = gzipSync('a-header\n' + 'a\n'.repeat(5_000));
    const b = gzipSync('b-header\n' + 'b\n'.repeat(5_000));

    const results = await Promise.allSettled([
      storeFile('trade', '20230201', slowly(a)),
      storeFile('trade', '20230201', slowly(b)),
    ]);

    const won = results.map(r => r.status === 'fulfilled');

    expect(won.filter(Boolean)).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: expect.any(AlreadyExistsError) });
    expect(readFileSync(closedPath('trade', '20230201'))).toEqual(won[0] ? a : b);
    expect(yearFiles()).toEqual(['20230201.csv.gz']);
  });
});

// ── removeStaleUploads ────────────────────────────────────────────────────────

describe('removeStaleUploads', () => {
  it('removes unfinished upload temp files and nothing else', () => {
    const dir = path.join(tmpDir, 'trade', '2023');
    mkdirSync(dir, { recursive: true });

    const stale = '20230201.csv.gz.upload-0f8b3c1e-7a2d-4c5e-9b1a-2d3e4f5a6b7c';
    const kept  = ['20230201.csv.gz', '20230202.csv.gz.tmp', '20230203.csv.gz.error'];

    for (const name of [stale, ...kept]) writeFileSync(path.join(dir, name), 'x');
    writeFileSync(path.join(tmpDir, 'not-a-table'), 'x');

    removeStaleUploads();

    expect(readdirSync(dir).sort()).toEqual([...kept].sort());
  });

  it('does nothing when the data directory does not exist', () => {
    rmSync(tmpDir, { recursive: true, force: true });

    expect(() => removeStaleUploads()).not.toThrow();
  });
});

describe('drainAll', () => {
  it('resolves immediately when nothing is pending', async () => {
    await expect(drainAll()).resolves.toBeUndefined();
  });

  it('awaits every writer\'s queued members', async () => {
    void appendBatch('trade', '20230201', ['a']);
    void appendBatch('tick',  '20230201', ['b']);

    await drainAll();

    expect(readMembers(openPath('trade', '20230201'))).toBe('a\n');
    expect(readMembers(openPath('tick',  '20230201'))).toBe('b\n');
  });

  it('awaits a seal in progress, including its rename', async () => {
    void appendBatch('trade', '20230201', ['header']);
    const sealed = appendBatch('trade', '20230201', ['last'], true);

    await drainAll();

    expect(existsSync(openPath('trade', '20230201'))).toBe(false);
    expect(readMembers(closedPath('trade', '20230201'))).toBe('header\nlast\n');
    await sealed;
  });

  it('settles even when a seal fails', async () => {
    await appendBatch('trade', '20230201', ['header']);
    rmSync(openPath('trade', '20230201'));

    const sealed = appendBatch('trade', '20230201', [], true);

    await expect(drainAll()).resolves.toBeUndefined();
    await expect(sealed).rejects.toThrow();
  });
});

// ── Failure handling ──────────────────────────────────────────────────────────

describe('appendBatch — failures', () => {
  it('rejects (does not throw) when the year directory cannot be created', async () => {
    writeFileSync(path.join(tmpDir, 'funding'), 'not a directory');

    let result: Promise<void> | undefined;

    expect(() => { result = appendBatch('funding', '20240101', ['x']); }).not.toThrow();
    await expect(result).rejects.toThrow(/ENOTDIR|EEXIST/);
  });

  it('starts a fresh writer after a failed seal, which can then seal the file', async () => {
    await appendBatch('trade', '20230201', ['header', 'old']);
    rmSync(openPath('trade', '20230201'));

    await expect(appendBatch('trade', '20230201', [], true)).rejects.toThrow();

    // The failed writer is gone: the next batch starts a new open file.
    expect(isInitialized('trade', '20230201')).toBe(false);

    await appendBatch('trade', '20230201', ['header', 'new'], true);

    expect(readMembers(closedPath('trade', '20230201'))).toBe('header\nnew\n');
  });

  it('starts a fresh writer after the writer\'s close itself failed', async () => {
    await appendBatch('trade', '20230201', ['header']);

    // A directory at the sealed path makes the rename fail after the fsync.
    mkdirSync(closedPath('trade', '20230201'));

    await expect(appendBatch('trade', '20230201', ['a'], true)).rejects.toThrow();

    rmSync(closedPath('trade', '20230201'), { recursive: true });

    await expect(appendBatch('trade', '20230201', ['b'], true)).resolves.toBeUndefined();
    expect(readMembers(closedPath('trade', '20230201'))).toBe('header\na\nb\n');
  });
});

// ── Durability ────────────────────────────────────────────────────────────────

describe('fsync', () => {
  it('a seal fsyncs the open file before the rename and the year directory after it', async () => {
    await appendBatch('trade', '20230201', ['header']);
    synced.length = 0;

    await appendBatch('trade', '20230201', ['last'], true);

    expect(synced).toEqual([openPath('trade', '20230201'), path.join(tmpDir, 'trade', '2023')]);
    expect(readMembers(closedPath('trade', '20230201'))).toBe('header\nlast\n');
  });

  it('fsyncs the parent of every directory it creates, and only then', async () => {
    await appendBatch('trade', '20230201', ['header']);

    expect(synced).toEqual([path.join(tmpDir, 'trade'), tmpDir]);

    synced.length = 0;
    await appendBatch('trade', '20230202', ['header']);
    expect(synced).toEqual([]);

    await appendBatch('trade', '20240101', ['header']);
    expect(synced).toEqual([path.join(tmpDir, 'trade')]);
  });

  it('does not fsync on a plain append', async () => {
    await appendBatch('trade', '20230201', ['header']);
    synced.length = 0;

    await appendBatch('trade', '20230201', ['a']);

    expect(synced).toEqual([]);
  });
});

// ── Recovery — ensure recordFailure is wired up ───────────────────────────────

describe('recordFailure wiring', () => {
  it('does not call recordFailure on a normal append', async () => {
    await appendBatch('trade', '20230201', ['header']);
    expect(recordFailure).not.toHaveBeenCalled();
  });
});
