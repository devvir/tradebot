import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { collectLeafFolders } from '../../../../src/tools/sources/merge/discover';
import { _test_executeGroup } from '../../../../src/tools/sources/merge/run';
import type { FileGroup } from '../../../../src/tools/sources/types';

// ── Test harness ──────────────────────────────────────────────────────────────

const ORDER_BOOK_L2_COLS = [
  '_date_', '_action_', 'symbol', 'id', 'side', 'size', 'price', 'transactTime', 'timestamp', 'pool',
];

const ANNOUNCEMENT_COLS = ['_date_', '_action_', 'id', 'link', 'title', 'content', 'date'];

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-merge-e2e-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeGz(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, zlib.gzipSync(lines.join('\n') + '\n'));
}

function readGz(filePath: string): string[] {
  return zlib.gunzipSync(fs.readFileSync(filePath))
    .toString('utf8')
    .replace(/\n$/, '')
    .split('\n');
}

/**
 * Build an orderBookL2 message-start row (non-empty _date_).
 * Columns: _date_,_action_,symbol,id,side,size,price,transactTime,timestamp,pool
 */
function obl2Row(date: string, action: string, timestamp: string, id: number, price: number): string {
  return `${date},${action},XBTUSD,${id},Buy,100,${price},,${timestamp},`;
}

/**
 * Build a continuation row for orderBookL2 (empty _date_ and _action_).
 * This is how multi-row WS messages are stored: only the first row has _date_.
 */
function obl2Cont(timestamp: string, id: number, price: number): string {
  return `,,XBTUSD,${id},Buy,100,${price},,${timestamp},`;
}

function makeGroup(paths: string[], outputPath: string, tableName: string): FileGroup {
  return { day: '20260101', paths, outputPath, tableName };
}

// ── Two-file merge ─────────────────────────────────────────────────────────────

describe('merge e2e — two files (orderBookL2)', () => {
  it('interleaves in timestamp order', async () => {
    const base = path.join(tempDir, '20260101.csv.gz');
    const gaps = path.join(tempDir, '20260101.gap.1.csv.gz');
    const out  = path.join(tempDir, '20260101.merged.csv.gz');
    const hdr  = ORDER_BOOK_L2_COLS.join(',');

    writeGz(base, [
      hdr,
      obl2Row('rx-1', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000),
      obl2Row('rx-2', 'insert', '2026-01-01T00:00:02.000Z', 2, 30100),
      obl2Row('rx-5', 'insert', '2026-01-01T00:00:05.000Z', 5, 30400),
    ]);

    writeGz(gaps, [
      hdr,
      obl2Row('rx-3', 'insert', '2026-01-01T00:00:03.000Z', 3, 30200),
      obl2Row('rx-4', 'insert', '2026-01-01T00:00:04.000Z', 4, 30300),
      obl2Row('rx-6', 'insert', '2026-01-01T00:00:06.000Z', 6, 30500),
    ]);

    await _test_executeGroup(makeGroup([base, gaps], out, 'orderBookL2'));

    const lines = readGz(out);
    expect(lines[0]).toBe(hdr);

    const timestamps = lines.slice(1).map(l => l.split(',')[8] ?? '');
    expect(timestamps).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:03.000Z',
      '2026-01-01T00:00:04.000Z',
      '2026-01-01T00:00:05.000Z',
      '2026-01-01T00:00:06.000Z',
    ]);
  });

  it('base source owns a timestamp; all gap-source messages at that timestamp are skipped', async () => {
    const base = path.join(tempDir, '20260101.csv.gz');
    const gaps = path.join(tempDir, '20260101.gap.1.csv.gz');
    const out  = path.join(tempDir, '20260101.merged.csv.gz');
    const hdr  = ORDER_BOOK_L2_COLS.join(',');

    writeGz(base, [
      hdr,
      obl2Row('rx-a', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000),
      obl2Row('rx-b', 'insert', '2026-01-01T00:00:02.000Z', 2, 30100),
    ]);

    writeGz(gaps, [
      hdr,
      // Both at ts=01: base owns ts=01, so both gap messages are skipped —
      // even the one with different content (id=99).
      obl2Row('rx-c', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000),
      obl2Row('rx-d', 'insert', '2026-01-01T00:00:01.000Z', 99, 99999),
    ]);

    await _test_executeGroup(makeGroup([base, gaps], out, 'orderBookL2'));

    const lines = readGz(out);
    const ids   = lines.slice(1).map(l => l.split(',')[3]);
    // ts=01 owned by base (id=1); ts=02 only base (id=2). Gap's id=99 skipped.
    expect(ids).toEqual(['1', '2']);
  });
});

// ── Three-file N-way merge ─────────────────────────────────────────────────────

describe('merge e2e — three files (orderBookL2)', () => {
  it('merges all three in timestamp order with deduplication', async () => {
    const f1  = path.join(tempDir, '20260101.csv.gz');
    const f2  = path.join(tempDir, '20260101.gap.1.csv.gz');
    const f3  = path.join(tempDir, '20260101.gap.2.csv.gz');
    const out = path.join(tempDir, '20260101.merged.csv.gz');
    const hdr = ORDER_BOOK_L2_COLS.join(',');

    // f1: ids 1, 4, 7
    writeGz(f1, [
      hdr,
      obl2Row('rx-1', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000),
      obl2Row('rx-4', 'insert', '2026-01-01T00:00:04.000Z', 4, 30300),
      obl2Row('rx-7', 'insert', '2026-01-01T00:00:07.000Z', 7, 30600),
    ]);

    // f2: ids 2, 5, 8
    writeGz(f2, [
      hdr,
      obl2Row('rx-2', 'insert', '2026-01-01T00:00:02.000Z', 2, 30100),
      obl2Row('rx-5', 'insert', '2026-01-01T00:00:05.000Z', 5, 30400),
      obl2Row('rx-8', 'insert', '2026-01-01T00:00:08.000Z', 8, 30700),
    ]);

    // f3: ids 3, 6, 9
    writeGz(f3, [
      hdr,
      obl2Row('rx-3', 'insert', '2026-01-01T00:00:03.000Z', 3, 30200),
      obl2Row('rx-6', 'insert', '2026-01-01T00:00:06.000Z', 6, 30500),
      obl2Row('rx-9', 'insert', '2026-01-01T00:00:09.000Z', 9, 30800),
    ]);

    await _test_executeGroup(makeGroup([f1, f2, f3], out, 'orderBookL2'));

    const lines = readGz(out);
    expect(lines[0]).toBe(hdr);

    const ids = lines.slice(1).map(l => l.split(',')[3]);
    expect(ids).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });
});

// ── Multi-row WS messages ──────────────────────────────────────────────────────

describe('merge e2e — multi-row WS messages (orderBookL2)', () => {
  it('writes a multi-row partial snapshot atomically as a single unit', async () => {
    const base = path.join(tempDir, '20260101.csv.gz');
    const gaps = path.join(tempDir, '20260101.gap.1.csv.gz');
    const out  = path.join(tempDir, '20260101.merged.csv.gz');
    const hdr  = ORDER_BOOK_L2_COLS.join(',');

    // base: a 3-row partial snapshot, then a regular insert
    writeGz(base, [
      hdr,
      obl2Row('rx-t0', 'partial', '2026-01-01T00:00:00.000Z', 1, 30000),
      obl2Cont('2026-01-01T00:00:00.000Z', 2, 30100),
      obl2Cont('2026-01-01T00:00:00.000Z', 3, 30200),
      obl2Row('rx-t1', 'insert', '2026-01-01T00:00:01.000Z', 4, 30300),
    ]);

    // gaps: a regular insert with a timestamp between the partial and base insert
    writeGz(gaps, [
      hdr,
      obl2Row('rx-g0', 'insert', '2026-01-01T00:00:00.500Z', 10, 29000),
      obl2Row('rx-t1', 'insert', '2026-01-01T00:00:01.000Z', 4, 30300),  // dup
    ]);

    await _test_executeGroup(makeGroup([base, gaps], out, 'orderBookL2'));

    const lines = readGz(out);
    expect(lines[0]).toBe(hdr);

    // Expected order:
    //   row 0: partial id=1  (_date_ = rx-t0, timestamp = T00:00:00)
    //   row 1: cont    id=2  (empty _date_, continuation of partial)
    //   row 2: cont    id=3  (empty _date_, continuation of partial)
    //   row 3: insert  id=10 (from gaps,  timestamp = T00:00:00.500)
    //   row 4: insert  id=4  (from base,  timestamp = T00:00:01 — dup from gaps dropped)
    const dataLines = lines.slice(1);
    expect(dataLines).toHaveLength(5);

    // The partial's first row has a non-empty _date_.
    expect(dataLines[0]!.split(',')[0]).toBe('rx-t0');
    // The two continuation rows have empty _date_.
    expect(dataLines[1]!.split(',')[0]).toBe('');
    expect(dataLines[2]!.split(',')[0]).toBe('');
    // ids in order
    const ids = dataLines.map(l => l.split(',')[3]);
    expect(ids).toEqual(['1', '2', '3', '10', '4']);
  });

  it('lower-priority partial wins over higher-priority non-partial at the same timestamp', async () => {
    const base = path.join(tempDir, '20260101.csv.gz');
    const gaps = path.join(tempDir, '20260101.gap.1.csv.gz');
    const out  = path.join(tempDir, '20260101.merged.csv.gz');
    const hdr  = ORDER_BOOK_L2_COLS.join(',');

    // Base has a regular insert at T0; gap source has a partial at T0.
    // The partial wins outright — base's insert at T0 is dropped.
    writeGz(base, [
      hdr,
      obl2Row('rx-base-t0', 'insert',  '2026-01-01T00:00:00.000Z', 1, 30000),
      obl2Row('rx-base-t1', 'insert',  '2026-01-01T00:00:01.000Z', 4, 30300),
    ]);

    writeGz(gaps, [
      hdr,
      obl2Row('rx-gap-t0', 'partial', '2026-01-01T00:00:00.000Z', 1, 30000),
      obl2Cont('2026-01-01T00:00:00.000Z', 2, 30100),
      obl2Cont('2026-01-01T00:00:00.000Z', 3, 30200),
    ]);

    await _test_executeGroup(makeGroup([base, gaps], out, 'orderBookL2'));

    const lines = readGz(out);
    const data  = lines.slice(1);

    // Expect: 3-row partial (id=1,2,3 from gaps) at T0, then base's insert id=4 at T1.
    expect(data).toHaveLength(4);
    const ids     = data.map(l => l.split(',')[3]);
    const actions = data.map(l => l.split(',')[1]);
    expect(ids).toEqual(['1', '2', '3', '4']);
    expect(actions[0]).toBe('partial');
    // Base's insert id=1 at T0 must NOT appear — the partial owned T0.
    expect(data[0]!.split(',')[0]).toBe('rx-gap-t0');
  });

  it('base source owns the partial timestamp; gap-source partial is skipped entirely', async () => {
    const base = path.join(tempDir, '20260101.csv.gz');
    const gaps = path.join(tempDir, '20260101.gap.1.csv.gz');
    const out  = path.join(tempDir, '20260101.merged.csv.gz');
    const hdr  = ORDER_BOOK_L2_COLS.join(',');

    // Identical 3-row partial in both files.
    const sharedPartial = [
      obl2Row('rx-t0', 'partial', '2026-01-01T00:00:00.000Z', 1, 30000),
      obl2Cont('2026-01-01T00:00:00.000Z', 2, 30100),
      obl2Cont('2026-01-01T00:00:00.000Z', 3, 30200),
    ];

    writeGz(base, [hdr, ...sharedPartial, obl2Row('rx-t1', 'insert', '2026-01-01T00:00:01.000Z', 4, 30300)]);
    writeGz(gaps, [hdr, ...sharedPartial, obl2Row('rx-t2', 'insert', '2026-01-01T00:00:02.000Z', 5, 30400)]);

    await _test_executeGroup(makeGroup([base, gaps], out, 'orderBookL2'));

    const lines = readGz(out);
    // partial (3 rows) + insert id=4 + insert id=5 = 5 data rows
    expect(lines.slice(1)).toHaveLength(5);

    // The partial should appear exactly once (3 consecutive rows at the start).
    const actions = lines.slice(1).map(l => l.split(',')[1]);
    expect(actions.filter(a => a === 'partial')).toHaveLength(1); // only first row of partial has action
    const ids = lines.slice(1).map(l => l.split(',')[3]);
    expect(ids).toEqual(['1', '2', '3', '4', '5']);
  });
});

// ── Small table (announcement) ────────────────────────────────────────────────

describe('merge e2e — small table (announcement)', () => {
  it('gap source fills missing timestamps; base wins at shared timestamps', async () => {
    const base = path.join(tempDir, '20260101.csv.gz');
    const gaps = path.join(tempDir, '20260101.gap.1.csv.gz');
    const out  = path.join(tempDir, '20260101.merged.csv.gz');
    const hdr  = ANNOUNCEMENT_COLS.join(',');

    writeGz(base, [
      hdr,
      '2026-01-01T00:00:01.000Z,insert,1,link-a,title-a,content-a,',
      '2026-01-01T00:00:03.000Z,insert,3,link-c,title-c,content-c,',
    ]);

    writeGz(gaps, [
      hdr,
      '2026-01-01T00:00:02.000Z,insert,2,link-b,title-b,content-b,',
      // Same _date_ as base id=3 → base owns T03, this is skipped.
      '2026-01-01T00:00:03.000Z,insert,3,link-c,title-c,content-c,',
    ]);

    await _test_executeGroup(makeGroup([base, gaps], out, 'announcement'));

    const lines = readGz(out);
    expect(lines[0]).toBe(hdr);
    expect(lines.slice(1)).toHaveLength(3);

    const ids = lines.slice(1).map(l => l.split(',')[2]);
    expect(ids).toEqual(['1', '2', '3']);
  });
});

// ── Crash safety ───────────────────────────────────────────────────────────────

describe('merge e2e — crash safety', () => {
  it('writes via a .tmp file then renames; no .tmp remains after success', async () => {
    const base = path.join(tempDir, '20260101.csv.gz');
    const gaps = path.join(tempDir, '20260101.gap.1.csv.gz');
    const out  = path.join(tempDir, '20260101.merged.csv.gz');
    const tmp  = out + '.tmp';
    const hdr  = ORDER_BOOK_L2_COLS.join(',');

    writeGz(base, [hdr, obl2Row('rx-1', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000)]);
    writeGz(gaps, [hdr, obl2Row('rx-2', 'insert', '2026-01-01T00:00:02.000Z', 2, 30100)]);

    await _test_executeGroup(makeGroup([base, gaps], out, 'orderBookL2'));

    expect(fs.existsSync(out)).toBe(true);
    expect(fs.existsSync(tmp)).toBe(false);
  });
});

// ── Pre-validation ────────────────────────────────────────────────────────────

describe('merge e2e — pre-validation', () => {
  it('throws when any file has a malformed header', async () => {
    const base = path.join(tempDir, '20260101.csv.gz');
    const gaps = path.join(tempDir, '20260101.gap.1.csv.gz');
    const out  = path.join(tempDir, '20260101.merged.csv.gz');
    const hdr  = ORDER_BOOK_L2_COLS.join(',');

    writeGz(base, ['garbage,header', obl2Row('rx-1', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000)]);
    writeGz(gaps, [hdr, obl2Row('rx-2', 'insert', '2026-01-01T00:00:02.000Z', 2, 30100)]);

    await expect(
      _test_executeGroup(makeGroup([base, gaps], out, 'orderBookL2')),
    ).rejects.toThrow(/first line does not start with "_date_,"/);
  });
});

// ── collectLeafFolders ────────────────────────────────────────────────────────

describe('collectLeafFolders', () => {
  it('returns the folder itself when it directly contains .csv.gz files', () => {
    fs.writeFileSync(path.join(tempDir, '20260101.csv.gz'), '');

    expect(collectLeafFolders(tempDir)).toEqual([tempDir]);
  });

  it('returns leaf subdirectories when the root contains no .csv.gz directly', () => {
    const tableDir = path.join(tempDir, 'orderBookL2');
    const yearDir  = path.join(tableDir, '2026');

    fs.mkdirSync(yearDir, { recursive: true });
    fs.writeFileSync(path.join(yearDir, '20260101.csv.gz'), '');

    expect(collectLeafFolders(tempDir)).toEqual([yearDir]);
  });

  it('collects all leaves across multiple table/year paths', () => {
    const ob  = path.join(tempDir, 'orderBookL2', '2026');
    const ann = path.join(tempDir, 'announcement', '2026');

    fs.mkdirSync(ob,  { recursive: true });
    fs.mkdirSync(ann, { recursive: true });
    fs.writeFileSync(path.join(ob,  '20260101.csv.gz'), '');
    fs.writeFileSync(path.join(ann, '20260101.csv.gz'), '');

    const result = collectLeafFolders(tempDir).sort();

    expect(result).toEqual([ann, ob].sort());
  });

  it('returns an empty array when there are no .csv.gz files anywhere', () => {
    const sub = path.join(tempDir, 'empty', 'subdir');
    fs.mkdirSync(sub, { recursive: true });

    expect(collectLeafFolders(tempDir)).toEqual([]);
  });
});
