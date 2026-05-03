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

import { streamRecords, fileState, listFiles, listTables } from '../../src/fs/reader';
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

// ── streamRecords ─────────────────────────────────────────────────────────────

describe('streamRecords', () => {
  it('yields parsed records from a closed gzip file', async () => {
    makeClosedFile('trade', '2023-02-01', ['header,col', 'a,1', 'b,2']);

    const records: string[][] = [];

    for await (const r of streamRecords('trade', '2023-02-01')) {
      records.push(r);
    }

    expect(records).toEqual([['header', 'col'], ['a', '1'], ['b', '2']]);
  });

  it('throws NotFoundError if the closed file does not exist', async () => {
    await expect(async () => {
      for await (const _ of streamRecords('trade', '2023-02-01')) { /* consume */ }
    }).rejects.toThrow(NotFoundError);
  });

  it('skips empty CSV records', async () => {
    makeClosedFile('trade', '2023-02-01', ['a,1', '', 'b,2']);

    const records: string[][] = [];

    for await (const r of streamRecords('trade', '2023-02-01')) {
      records.push(r);
    }

    expect(records).toEqual([['a', '1'], ['b', '2']]);
  });

  it('preserves a quoted field containing newlines as a single record', async () => {
    // Mimics announcement / chat / publicNotifications storage: a quoted
    // field with embedded newlines spans multiple physical lines on disk
    // but must read back as one record.
    makeClosedFile('chat', '2023-02-01', [
      '_date_,_action_,id,message',
      '2023-02-01T00:00:00Z,insert,1,"line one',
      'line two',
      'line three"',
    ]);

    const records: string[][] = [];

    for await (const r of streamRecords('chat', '2023-02-01')) {
      records.push(r);
    }

    expect(records).toHaveLength(2);
    expect(records[1]).toEqual([
      '2023-02-01T00:00:00Z',
      'insert',
      '1',
      'line one\nline two\nline three',
    ]);
  });

  it('preserves embedded commas and doubled quotes inside a quoted field', async () => {
    makeClosedFile('announcement', '2023-02-01', [
      '_date_,_action_,id,title,content',
      '2023-02-01T00:00:00Z,insert,42,"Title, with comma","<a href=""https://x.test"">link</a>"',
    ]);

    const records: string[][] = [];

    for await (const r of streamRecords('announcement', '2023-02-01')) {
      records.push(r);
    }

    expect(records[1]).toEqual([
      '2023-02-01T00:00:00Z',
      'insert',
      '42',
      'Title, with comma',
      '<a href="https://x.test">link</a>',
    ]);
  });
});

// ── fileState ─────────────────────────────────────────────────────────────────

describe('fileState', () => {
  it('returns "closed" when the .csv.gz exists', () => {
    makeClosedFile('trade', '2023-02-01', ['hdr']);
    expect(fileState('trade', '2023-02-01')).toBe('closed');
  });

  it('returns "open" when only the .tmp exists', () => {
    makeOpenFile('trade', '2023-02-01');
    expect(fileState('trade', '2023-02-01')).toBe('open');
  });

  it('returns "none" when no file exists', () => {
    expect(fileState('trade', '2023-02-01')).toBe('none');
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
    makeClosedFile('trade', '2023-02-01',          ['hdr']);
    makeOpenFile('trade',   '2023-02-02');
    makeClosedFile('trade', '2023-02-01.snapshot', ['hdr']); // must not appear

    const result = listFiles('trade');

    expect(result['2023-02-01']).toBe('closed');
    expect(result['2023-02-02']).toBe('open');
    expect(result['2023-02-01.snapshot']).toBeUndefined();
  });

  it('lists only suffixed files matching the requested suffix', () => {
    makeClosedFile('trade', '2023-02-01',          ['hdr']); // bare — must not appear
    makeClosedFile('trade', '2023-02-01.snapshot', ['hdr']);
    makeOpenFile('trade',   '2023-02-02.snapshot');
    makeClosedFile('trade', '2023-02-01.other',    ['hdr']); // different suffix — must not appear

    const result = listFiles('trade', 'snapshot');

    expect(result['2023-02-01.snapshot']).toBe('closed');
    expect(result['2023-02-02.snapshot']).toBe('open');
    expect(result['2023-02-01']).toBeUndefined();
    expect(result['2023-02-01.other']).toBeUndefined();
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
