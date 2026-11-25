import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { gunzipSync, gzipSync } from 'zlib';
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
  drainAll,
  _test_reset as resetWriter,
} from '../../src/fs/writer';
import { recordFailure } from '../../src/fs/health';
import { openPath, closedPath } from '../../src/fs/paths';

// ── Helpers ───────────────────────────────────────────────────────────────────

const readMembers = (filePath: string): string => {
  // Multiple gzip members concatenated decompress as a single text stream
  // when piped through gunzip; Node's gunzipSync handles the first member
  // only, so we walk members manually.
  const buf = readFileSync(filePath);
  let offset = 0;
  let out = '';

  while (offset < buf.length) {
    // Find the next gzip header (1f 8b) after this one
    let next = -1;

    for (let i = offset + 2; i < buf.length - 1; i++) {
      if (buf[i] === 0x1f && buf[i + 1] === 0x8b) { next = i; break; }
    }

    const memberEnd = next === -1 ? buf.length : next;
    const member    = buf.subarray(offset, memberEnd);

    out    += gunzipSync(member).toString('utf8');
    offset  = memberEnd;
  }

  return out;
};

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
    expect(isInitialized('trade', '2023-02-01')).toBe(false);
  });

  it('is true after a .csv.gz.tmp exists on disk (no in-memory handle yet)', () => {
    const dir = path.join(tmpDir, 'trade', '2023');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '2023-02-01.csv.gz.tmp'), gzipSync('header\n'));

    expect(isInitialized('trade', '2023-02-01')).toBe(true);
  });

  it('is true after appendBatch creates the handle', async () => {
    await appendBatch('trade', '2023-02-01', ['line1']);

    expect(isInitialized('trade', '2023-02-01')).toBe(true);
  });
});

// ── appendBatch — basics ──────────────────────────────────────────────────────

describe('appendBatch', () => {
  it('writes a single gzip member and produces a readable file', async () => {
    await appendBatch('trade', '2023-02-01', ['col1,col2', '1,2']);

    const tmp = openPath('trade', '2023-02-01');
    expect(existsSync(tmp)).toBe(true);
    expect(readMembers(tmp)).toBe('col1,col2\n1,2\n');
  });

  it('appends multiple members across calls (resulting file is multi-member gzip)', async () => {
    await appendBatch('trade', '2023-02-01', ['col1,col2']);
    await appendBatch('trade', '2023-02-01', ['1,2']);
    await appendBatch('trade', '2023-02-01', ['3,4']);

    const tmp = openPath('trade', '2023-02-01');
    expect(readMembers(tmp)).toBe('col1,col2\n1,2\n3,4\n');
  });

  it('serialises concurrent writes (FIFO order preserved)', async () => {
    const a = appendBatch('trade', '2023-02-01', ['line-a']);
    const b = appendBatch('trade', '2023-02-01', ['line-b']);
    const c = appendBatch('trade', '2023-02-01', ['line-c']);

    await Promise.all([a, b, c]);

    const tmp = openPath('trade', '2023-02-01');
    expect(readMembers(tmp)).toBe('line-a\nline-b\nline-c\n');
  });

  it('preserves earlier data when resuming a pre-existing .csv.gz.tmp', async () => {
    // Seed the file with prior content as if vault had restarted mid-day.
    const dir = path.join(tmpDir, 'trade', '2023');
    mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '2023-02-01.csv.gz.tmp');
    writeFileSync(tmp, gzipSync('header\nold-1\n'));

    await appendBatch('trade', '2023-02-01', ['new-1', 'new-2']);

    expect(readMembers(tmp)).toBe('header\nold-1\nnew-1\nnew-2\n');
  });

  it('is a no-op when given an empty lines array (no member written)', async () => {
    // First write to create the file.
    await appendBatch('trade', '2023-02-01', ['header']);
    const tmp  = openPath('trade', '2023-02-01');
    const size = statSync(tmp).size;

    await appendBatch('trade', '2023-02-01', []);

    expect(statSync(tmp).size).toBe(size);
  });
});

// ── appendBatch — sealing ─────────────────────────────────────────────────────

describe('appendBatch — seal', () => {
  it('renames .csv.gz.tmp to .csv.gz when seal=true', async () => {
    await appendBatch('trade', '2023-02-01', ['header']);
    await appendBatch('trade', '2023-02-01', ['data-1'], true);

    expect(existsSync(openPath('trade', '2023-02-01'))).toBe(false);
    expect(existsSync(closedPath('trade', '2023-02-01'))).toBe(true);
  });

  it('writes a suffixed filename next to the bare-date file in the same year dir', async () => {
    await appendBatch('trade', '2023-02-01',          ['bare']);
    await appendBatch('trade', '2023-02-01.snapshot', ['snap']);

    const bareTmp = openPath('trade', '2023-02-01');
    const snapTmp = openPath('trade', '2023-02-01.snapshot');

    expect(existsSync(bareTmp)).toBe(true);
    expect(existsSync(snapTmp)).toBe(true);
    expect(path.dirname(bareTmp)).toBe(path.dirname(snapTmp));
    expect(readMembers(snapTmp)).toBe('snap\n');
  });

  it('seals even when the lines array is empty (no final member written)', async () => {
    await appendBatch('trade', '2023-02-01', ['header']);
    await appendBatch('trade', '2023-02-01', [], true);

    expect(existsSync(closedPath('trade', '2023-02-01'))).toBe(true);
  });

  it('drops the in-memory handle after sealing', async () => {
    await appendBatch('trade', '2023-02-01', ['header'], true);

    expect(isInitialized('trade', '2023-02-01')).toBe(false);
  });
});

// ── deleteFile / drainAll ─────────────────────────────────────────────────────

describe('deleteFile', () => {
  it('unlinks .csv.gz.tmp and drops the handle (idempotent)', async () => {
    await appendBatch('trade', '2023-02-01', ['header']);

    deleteFile('trade', '2023-02-01');

    expect(existsSync(openPath('trade', '2023-02-01'))).toBe(false);
    expect(isInitialized('trade', '2023-02-01')).toBe(false);

    // Calling again must not throw.
    expect(() => deleteFile('trade', '2023-02-01')).not.toThrow();
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
    await appendBatch('trade', '2023-02-01', ['header']);
    expect(recordFailure).not.toHaveBeenCalled();
  });
});
