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
  const yearDir    = (table: string, date: string) => path.join(tableDir(table), date.slice(0, 4));
  const openPath   = (table: string, date: string) => path.join(yearDir(table, date), `${date}.csv.gz.tmp`);
  const closedPath = (table: string, date: string) => path.join(yearDir(table, date), `${date}.csv.gz`);

  return { get DATA_DIR() { return dataDir(); }, tableDir, yearDir, openPath, closedPath };
});

import { streamLines, fileState, listFiles, listTables } from '../../src/fs/reader';
import { NotFoundError } from '../../src/fs/errors';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeClosedFile = (table: string, date: string, lines: string[]) => {
  const dir = path.join(tmpDir, table, date.slice(0, 4));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${date}.csv.gz`), gzipSync(lines.join('\n') + '\n'));
};

const makeOpenFile = (table: string, date: string) => {
  const dir = path.join(tmpDir, table, date.slice(0, 4));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${date}.csv.gz.tmp`), '');
};

beforeEach(() => {
  tmpDir = mkdirSync(path.join(os.tmpdir(), `vault-test-${Date.now()}`), { recursive: true }) as string;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── streamLines ───────────────────────────────────────────────────────────────

describe('streamLines', () => {
  it('yields lines from a closed gzip file', async () => {
    makeClosedFile('trade', '2023-02-01', ['header,col', 'a,1', 'b,2']);

    const lines: string[] = [];

    for await (const l of streamLines('trade', '2023-02-01')) {
      lines.push(l);
    }

    expect(lines).toEqual(['header,col', 'a,1', 'b,2']);
  });

  it('throws NotFoundError if the closed file does not exist', async () => {
    await expect(async () => {
      for await (const _ of streamLines('trade', '2023-02-01')) { /* consume */ }
    }).rejects.toThrow(NotFoundError);
  });

  it('does not yield empty lines', async () => {
    makeClosedFile('trade', '2023-02-01', ['a,1', '', 'b,2']);

    const lines: string[] = [];

    for await (const l of streamLines('trade', '2023-02-01')) {
      lines.push(l);
    }

    expect(lines).not.toContain('');
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

  it('lists closed and open files with correct states', () => {
    makeClosedFile('trade', '2023-02-01', ['hdr']);
    makeOpenFile('trade', '2023-02-02');

    const result = listFiles('trade');

    expect(result['2023-02-01']).toBe('closed');
    expect(result['2023-02-02']).toBe('open');
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
