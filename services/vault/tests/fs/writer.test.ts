import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { gunzipSync, gzipSync } from 'zlib';
import * as os from 'os';
import * as path from 'path';

// ── Redirect storage paths to a temp dir ─────────────────────────────────────

let tmpDir: string;

vi.mock('../../src/fs/paths', () => {
  const dataDir    = () => tmpDir;
  const tableDir   = (table: string) => path.join(dataDir(), table);
  const yearDir    = (table: string, date: string) => path.join(tableDir(table), date.slice(0, 4));
  const openPath   = (table: string, date: string) => path.join(yearDir(table, date), `${date}.csv.gz.tmp`);
  const closedPath = (table: string, date: string) => path.join(yearDir(table, date), `${date}.csv.gz`);

  return { get DATA_DIR() { return dataDir(); }, tableDir, yearDir, openPath, closedPath };
});

vi.mock('../../src/fs/health', () => ({
  recordFailure: vi.fn(),
}));

import {
  appendBatch,
  isInitialized,
  deleteFile,
  drainHandle,
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

// ── deleteFile / drainHandle ──────────────────────────────────────────────────

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

describe('drainHandle', () => {
  it('resolves immediately when no handle exists', async () => {
    await expect(drainHandle('trade', '2023-02-01')).resolves.toBeUndefined();
  });

  it('awaits the queued write chain', async () => {
    const _ignored = appendBatch('trade', '2023-02-01', ['line']);
    await drainHandle('trade', '2023-02-01');
    void _ignored;

    const tmp = openPath('trade', '2023-02-01');
    expect(readMembers(tmp)).toBe('line\n');
  });
});

// ── Recovery — ensure recordFailure is wired up ───────────────────────────────

describe('recordFailure wiring', () => {
  it('does not call recordFailure on a normal append', async () => {
    await appendBatch('trade', '2023-02-01', ['header']);
    expect(recordFailure).not.toHaveBeenCalled();
  });
});
