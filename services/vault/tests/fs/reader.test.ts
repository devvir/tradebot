import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { gzipSync } from 'zlib';
import * as os from 'os';
import * as path from 'path';

// ── Redirect storage paths to a temp dir ─────────────────────────────────────

let tmpDir: string;

vi.mock('../../src/fs/paths', () => {
  // Resolve lazily so tmpDir is set by the time the mock is called.
  const dataDir    = () => tmpDir;
  const tableDir   = (table: string) => path.join(dataDir(), table);
  const yearDir    = (table: string, filename: string) => path.join(tableDir(table), filename.slice(0, 4));
  const openPath   = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz.tmp`);
  const closedPath = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz`);

  return { get DATA_DIR() { return dataDir(); }, tableDir, yearDir, openPath, closedPath };
});

import { openClosedFile, fileState, listFiles, listTables } from '../../src/fs/reader';
import { NotFoundError } from '../../src/fs/errors';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeClosedFile = (table: string, filename: string, lines: string[]) => {
  const dir = path.join(tmpDir, table, filename.slice(0, 4));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${filename}.csv.gz`), gzipSync(lines.join('\n') + '\n'));
};

const makeOpenFile = (table: string, filename: string) => {
  const dir = path.join(tmpDir, table, filename.slice(0, 4));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${filename}.csv.gz.tmp`), '');
};

beforeEach(() => {
  tmpDir = mkdirSync(path.join(os.tmpdir(), `vault-test-${Date.now()}`), { recursive: true }) as string;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── openClosedFile ────────────────────────────────────────────────────────────

describe('openClosedFile', () => {
  it('opens a closed file as a decompressed byte stream', async () => {
    makeClosedFile('trade', '20230201', ['header,col', 'a,1']);

    const { stream, close } = openClosedFile('trade', '20230201');

    let data = '';

    for await (const chunk of stream) {
      data += chunk;
    }

    await close();

    expect(data).toBe('header,col\na,1\n');
  });

  it('throws NotFoundError if the closed file does not exist', () => {
    expect(() => openClosedFile('trade', '20230201')).toThrow(NotFoundError);
  });
});

// ── fileState ─────────────────────────────────────────────────────────────────

describe('fileState', () => {
  it('returns "closed" when the .csv.gz exists', () => {
    makeClosedFile('trade', '20230201', ['hdr']);
    expect(fileState('trade', '20230201')).toBe('closed');
  });

  it('returns "open" when only the .tmp exists', () => {
    makeOpenFile('trade', '20230201');
    expect(fileState('trade', '20230201')).toBe('open');
  });

  it('returns "none" when no file exists', () => {
    expect(fileState('trade', '20230201')).toBe('none');
  });
});

// ── listFiles ─────────────────────────────────────────────────────────────────

describe('listFiles', () => {
  it('returns null when the table directory does not exist', () => {
    expect(listFiles('trade')).toBeNull();
  });

  it('returns an empty object when the directory exists but has no files', () => {
    mkdirSync(path.join(tmpDir, 'trade'), { recursive: true });
    expect(listFiles('trade')).toEqual({});
  });

  it('lists bare-date files with correct states, excludes suffixed files', () => {
    makeClosedFile('trade', '20230201',          ['hdr']);
    makeOpenFile('trade',   '20230202');
    makeClosedFile('trade', '20230201.snapshot', ['hdr']); // must not appear

    const result = listFiles('trade');

    expect(result['20230201']).toBe('closed');
    expect(result['20230202']).toBe('open');
    expect(result['20230201.snapshot']).toBeUndefined();
  });

  it('lists only suffixed files matching the requested suffix', () => {
    makeClosedFile('trade', '20230201',          ['hdr']); // bare — must not appear
    makeClosedFile('trade', '20230201.snapshot', ['hdr']);
    makeOpenFile('trade',   '20230202.snapshot');
    makeClosedFile('trade', '20230201.other',    ['hdr']); // different suffix — must not appear

    const result = listFiles('trade', 'snapshot');

    expect(result['20230201.snapshot']).toBe('closed');
    expect(result['20230202.snapshot']).toBe('open');
    expect(result['20230201']).toBeUndefined();
    expect(result['20230201.other']).toBeUndefined();
  });

  it('ignores files outside the <table>/YYYY/YYYYMMDD layout', () => {
    // Operators sometimes rename year dirs to pause processing (e.g. `2025.paused`).
    // Vault must only enumerate dirs matching /^\d{4}$/, and only files whose
    // 8-digit date prefix begins with that same year.
    mkdirSync(path.join(tmpDir, 'trade', '2023.paused'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'trade', '2023.paused', '20230201.csv.gz'), gzipSync('hdr\n'));

    mkdirSync(path.join(tmpDir, 'trade', 'archive'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'trade', 'archive', '20230201.csv.gz'), gzipSync('hdr\n'));

    // Year dir exists but the file inside is from a different year — must be ignored.
    mkdirSync(path.join(tmpDir, 'trade', '2023'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'trade', '2023', '20240101.csv.gz'), gzipSync('hdr\n'));

    // Legitimate file in the right place — must still be listed.
    makeClosedFile('trade', '20230301', ['hdr']);

    expect(listFiles('trade')).toEqual({ '20230301': 'closed' });
  });
});

// ── listTables ────────────────────────────────────────────────────────────────

describe('listTables', () => {
  it('returns an empty array when the data dir has no subdirectories', () => {
    expect(listTables()).toEqual([]);
  });

  it('returns table names from top-level directories', () => {
    mkdirSync(path.join(tmpDir, 'trade'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'quote'), { recursive: true });

    const tables = listTables();

    expect(tables).toContain('trade');
    expect(tables).toContain('quote');
  });
});
