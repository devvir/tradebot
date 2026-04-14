import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { _test_executePair } from '../../../../src/tools/sources/merge/run';
import type { FilePair } from '../../../../src/tools/sources/types';

// ── Test harness ──────────────────────────────────────────────────────────────

/** Column list for `orderBookL2` (matches vault's TABLE_HEADERS). */
const ORDER_BOOK_L2_COLS = [
  '_date_', '_action_', 'symbol', 'id', 'side', 'size', 'price', 'transactTime', 'timestamp', 'pool',
];

/** Column list for a vault-known small table (`announcement`). */
const ANNOUNCEMENT_COLS = ['_date_', '_action_', 'id', 'link', 'title', 'content', 'date'];

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-merge-e2e-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeGz(filePath: string, lines: string[]): void {
  const content = lines.join('\n') + '\n';

  fs.writeFileSync(filePath, zlib.gzipSync(content));
}

function readGz(filePath: string): string[] {
  const buf = fs.readFileSync(filePath);

  return zlib.gunzipSync(buf).toString('utf8').replace(/\n$/, '').split('\n');
}

/** Build one orderBookL2 row. */
function obl2Row(date: string, action: string, timestamp: string, id: number, price: number): string {
  return `${date},${action},XBTUSD,${id},Buy,100,${price},,${timestamp},`;
}

function makePair(base: string, gaps: string, tableName: string): FilePair {
  return {
    basePath:   base,
    gapsPath:   gaps,
    outputPath: base.replace(/\.csv\.gz$/, '.merged.csv.gz'),
    tableName,
  };
}

// ── Large-table merge ─────────────────────────────────────────────────────────

describe('merge e2e — large table (orderBookL2)', () => {
  it('interleaves base and gaps in timestamp order (two-pointer walk)', async () => {
    const basePath = path.join(tempDir, 'obl2.csv.gz');
    const gapsPath = path.join(tempDir, 'obl2.gaps.csv.gz');
    const header   = ORDER_BOOK_L2_COLS.join(',');

    writeGz(basePath, [
      header,
      obl2Row('rx-1', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000),
      obl2Row('rx-2', 'insert', '2026-01-01T00:00:02.000Z', 2, 30100),
      obl2Row('rx-5', 'insert', '2026-01-01T00:00:05.000Z', 5, 30400),
      obl2Row('rx-6', 'insert', '2026-01-01T00:00:06.000Z', 6, 30500),
    ]);

    writeGz(gapsPath, [
      header,
      obl2Row('rx-3', 'insert', '2026-01-01T00:00:03.000Z', 3, 30200),
      obl2Row('rx-4', 'insert', '2026-01-01T00:00:04.000Z', 4, 30300),
      obl2Row('rx-7', 'insert', '2026-01-01T00:00:07.000Z', 7, 30600),
    ]);

    await _test_executePair(makePair(basePath, gapsPath, 'orderBookL2'), false);

    const outPath = basePath.replace(/\.csv\.gz$/, '.merged.csv.gz');
    const out     = readGz(outPath);

    expect(out[0]).toBe(header);

    const timestamps = out.slice(1).map(line => line.split(',')[8] ?? '');

    expect(timestamps).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:03.000Z',
      '2026-01-01T00:00:04.000Z',
      '2026-01-01T00:00:05.000Z',
      '2026-01-01T00:00:06.000Z',
      '2026-01-01T00:00:07.000Z',
    ]);
  });

  it('de-duplicates messages with identical content (base _date_ wins), keeps distinct messages at same timestamp', async () => {
    const basePath = path.join(tempDir, 'obl2.csv.gz');
    const gapsPath = path.join(tempDir, 'obl2.gaps.csv.gz');
    const header   = ORDER_BOOK_L2_COLS.join(',');

    writeGz(basePath, [
      header,
      obl2Row('rx-a', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000), // appears in both files — base wins
      obl2Row('rx-b', 'insert', '2026-01-01T00:00:02.000Z', 2, 30100),
    ]);

    writeGz(gapsPath, [
      header,
      obl2Row('rx-c', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000), // same content as base id=1 → dropped as dup
      obl2Row('rx-d', 'insert', '2026-01-01T00:00:01.000Z', 99, 99999), // same timestamp, different content → kept
    ]);

    await _test_executePair(makePair(basePath, gapsPath, 'orderBookL2'), false);

    const out = readGz(basePath.replace(/\.csv\.gz$/, '.merged.csv.gz'));
    const ids = out.slice(1).map(line => line.split(',')[3]);

    // id=1 from base, id=99 from gaps (different content), id=2 from base
    expect(ids).toEqual(['1', '99', '2']);
  });

  it('dry-run does not write an output file', async () => {
    const basePath = path.join(tempDir, 'obl2.csv.gz');
    const gapsPath = path.join(tempDir, 'obl2.gaps.csv.gz');
    const header   = ORDER_BOOK_L2_COLS.join(',');

    writeGz(basePath, [
      header,
      obl2Row('rx-1', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000),
    ]);

    writeGz(gapsPath, [
      header,
      obl2Row('rx-2', 'insert', '2026-01-01T00:00:02.000Z', 2, 30100),
    ]);

    await _test_executePair(makePair(basePath, gapsPath, 'orderBookL2'), true);

    expect(fs.existsSync(basePath.replace(/\.csv\.gz$/, '.merged.csv.gz'))).toBe(false);
  });
});

// ── Small-table merge ─────────────────────────────────────────────────────────

describe('merge e2e — announcement table', () => {
  it('interleaves base and gaps in _date_ order and deduplicates by content hash', async () => {
    const basePath = path.join(tempDir, 'announcement.csv.gz');
    const gapsPath = path.join(tempDir, 'announcement.gaps.csv.gz');
    const header   = ANNOUNCEMENT_COLS.join(',');

    // Both files must be pre-sorted by _date_ (as produced by `sources fix`).
    writeGz(basePath, [
      header,
      '2026-01-01T00:00:01.000Z,insert,1,link-a,title-a,content-a,',
      '2026-01-01T00:00:03.000Z,insert,3,link-c,title-c,content-c,',
      '2026-01-01T00:00:05.000Z,insert,5,link-e,title-e,content-e,',
    ]);

    writeGz(gapsPath, [
      header,
      '2026-01-01T00:00:02.000Z,insert,2,link-b,title-b,content-b,',
      '2026-01-01T00:00:04.000Z,insert,4,link-d,title-d,content-d,',
      '2026-01-01T00:00:06.000Z,insert,5,link-e,title-e,content-e,', // same content as base id=5, different _date_ → dup
    ]);

    await _test_executePair(makePair(basePath, gapsPath, 'announcement'), false);

    const out = readGz(basePath.replace(/\.csv\.gz$/, '.merged.csv.gz'));

    expect(out[0]).toBe(header);
    expect(out).toHaveLength(6); // header + 5 unique (id=5 dup dropped)

    const dates = out.slice(1).map(line => line.split(',')[0]);

    expect(dates).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:03.000Z',
      '2026-01-01T00:00:04.000Z',
      '2026-01-01T00:00:05.000Z',
    ]);
  });
});

// ── Pre-validation ────────────────────────────────────────────────────────────

describe('merge e2e — pre-validation', () => {
  it('throws a descriptive error when the base file has a malformed header', async () => {
    const basePath = path.join(tempDir, 'obl2.csv.gz');
    const gapsPath = path.join(tempDir, 'obl2.gaps.csv.gz');
    const header   = ORDER_BOOK_L2_COLS.join(',');

    writeGz(basePath, [
      'garbage,header',
      obl2Row('rx-1', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000),
    ]);

    writeGz(gapsPath, [
      header,
      obl2Row('rx-2', 'insert', '2026-01-01T00:00:02.000Z', 2, 30100),
    ]);

    await expect(_test_executePair(makePair(basePath, gapsPath, 'orderBookL2'), false))
      .rejects
      .toThrow(/first line does not start with "_date_,"/);
  });
});
