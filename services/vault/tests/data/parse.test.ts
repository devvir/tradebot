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

import { createParser } from '../../src/data/parse';
import { NotFoundError } from '../../src/fs/errors';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeClosedFile = (table: string, filename: string, lines: string[]) => {
  const dir = path.join(tmpDir, table, filename.slice(0, 4));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${filename}.csv.gz`), gzipSync(lines.join('\n') + '\n'));
};

const collect = async (table: string, filename: string, skip?: number): Promise<string[][]> => {
  const out: string[][] = [];

  for await (const record of createParser(table).read(filename, skip)) {
    out.push(record);
  }

  return out;
};

beforeEach(() => {
  tmpDir = mkdirSync(path.join(os.tmpdir(), `vault-parse-test-${Date.now()}`), { recursive: true }) as string;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Comma-split strategy: REST tables ─────────────────────────────────────────

describe('comma-split strategy (REST tables)', () => {
  it('yields the header then split records', async () => {
    makeClosedFile('funding', '2023-02-01', ['timestamp,symbol', 'a,1', 'b,2']);

    expect(await collect('funding', '2023-02-01')).toEqual([
      ['timestamp', 'symbol'],
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('skips empty lines', async () => {
    makeClosedFile('funding', '2023-02-01', ['timestamp,symbol', 'a,1', '', 'b,2']);

    expect(await collect('funding', '2023-02-01')).toEqual([
      ['timestamp', 'symbol'],
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('skip drops the first N records, header always survives', async () => {
    makeClosedFile('funding', '2023-02-01', ['timestamp,symbol', 'a,1', 'b,2', 'c,3']);

    expect(await collect('funding', '2023-02-01', 2)).toEqual([
      ['timestamp', 'symbol'],
      ['c', '3'],
    ]);
  });

  it('throws NotFoundError when no closed file exists', async () => {
    await expect(collect('funding', '2023-02-01')).rejects.toThrow(NotFoundError);
  });
});

// ── Comma-split strategy: WS tables ───────────────────────────────────────────

describe('comma-split strategy (WS tables)', () => {
  it('yields message and continuation rows as separate records', async () => {
    makeClosedFile('orderBookL2', '2023-02-01', [
      '_date_,_action_,symbol,id',
      '2023-02-01T00:00:00Z,partial,XBTUSD,1',
      ',,XBTUSD,2',
      '2023-02-01T00:01:00Z,update,XBTUSD,3',
    ]);

    expect(await collect('orderBookL2', '2023-02-01')).toEqual([
      ['_date_', '_action_', 'symbol', 'id'],
      ['2023-02-01T00:00:00Z', 'partial', 'XBTUSD', '1'],
      ['', '', 'XBTUSD', '2'],
      ['2023-02-01T00:01:00Z', 'update', 'XBTUSD', '3'],
    ]);
  });

  it('skip drops a message together with its continuation rows', async () => {
    makeClosedFile('orderBookL2', '2023-02-01', [
      '_date_,_action_,symbol,id',
      '2023-02-01T00:00:00Z,partial,XBTUSD,1',
      ',,XBTUSD,2',
      ',,XBTUSD,3',
      '2023-02-01T00:01:00Z,update,XBTUSD,4',
    ]);

    expect(await collect('orderBookL2', '2023-02-01', 1)).toEqual([
      ['_date_', '_action_', 'symbol', 'id'],
      ['2023-02-01T00:01:00Z', 'update', 'XBTUSD', '4'],
    ]);
  });
});

// ── RFC 4180 strategy: free-text tables ───────────────────────────────────────

describe('RFC 4180 strategy (free-text tables)', () => {
  it('preserves a quoted field containing newlines as a single record', async () => {
    // A quoted field with embedded newlines spans multiple physical lines on
    // disk but must read back as one record — a comma split would fragment it.
    makeClosedFile('chat', '2023-02-01', [
      '_date_,_action_,id,message',
      '2023-02-01T00:00:00Z,insert,1,"line one',
      'line two',
      'line three"',
    ]);

    const records = await collect('chat', '2023-02-01');

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

    const records = await collect('announcement', '2023-02-01');

    expect(records[1]).toEqual([
      '2023-02-01T00:00:00Z',
      'insert',
      '42',
      'Title, with comma',
      '<a href="https://x.test">link</a>',
    ]);
  });

  it('skip drops a message together with its continuation rows', async () => {
    makeClosedFile('chat', '2023-02-01', [
      '_date_,_action_,id,message',
      '2023-02-01T00:00:00Z,partial,1,first',
      ',,2,second',
      '2023-02-01T00:01:00Z,insert,3,third',
    ]);

    expect(await collect('chat', '2023-02-01', 1)).toEqual([
      ['_date_', '_action_', 'id', 'message'],
      ['2023-02-01T00:01:00Z', 'insert', '3', 'third'],
    ]);
  });

  it('throws NotFoundError when no closed file exists', async () => {
    await expect(collect('chat', '2023-02-01')).rejects.toThrow(NotFoundError);
  });
});
