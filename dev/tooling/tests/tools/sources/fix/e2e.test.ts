import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { runDiagnose } from '../../../../src/tools/sources/fix/run';
import type { SourceFile } from '../../../../src/tools/sources/types';

// ── Test harness ──────────────────────────────────────────────────────────────

/** Silence the UI logger during e2e runs. */
const originalWrite = process.stdout.write.bind(process.stdout);
const originalErr   = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  process.stderr.write = originalErr;
});

/** Column list for `orderBookL2` (matches vault's TABLE_HEADERS). */
const ORDER_BOOK_L2_COLS = [
  '_date_', '_action_', 'symbol', 'id', 'side', 'size', 'price', 'transactTime', 'timestamp', 'pool',
];

/** Column list for a synthetic small table (no `timestamp` column). */
const SMALL_TABLE_COLS = ['_date_', '_action_', 'id', 'title', 'content'];

/** Column list for a vault-known small table (`chat`) — used for header recovery. */
const CHAT_COLS = [
  '_date_', '_action_', 'channelID', 'date', 'html', 'id', 'message', 'user', 'userColor', 'flair', 'guild',
];

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-fix-e2e-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write an array of CSV lines to a gzipped file at `filePath`. */
function writeGz(filePath: string, lines: string[]): void {
  const content = lines.join('\n') + '\n';
  const gz      = zlib.gzipSync(content);

  fs.writeFileSync(filePath, gz);
}

/** Read a gzipped CSV file and return its lines (trailing newline stripped). */
function readGz(filePath: string): string[] {
  const buf  = fs.readFileSync(filePath);
  const text = zlib.gunzipSync(buf).toString('utf8');

  return text.replace(/\n$/, '').split('\n');
}

/** Build one orderBookL2 row line with a given receive date and per-message timestamp. */
function obl2Row(
  date:      string,
  action:    string,
  timestamp: string,
  id:        number,
  price:     number,
): string {
  // columns: _date_, _action_, symbol, id, side, size, price, transactTime, timestamp, pool
  return `${date},${action},XBTUSD,${id},Buy,100,${price},,${timestamp},`;
}

/** Build one announcement row line. */
function smallRow(date: string, action: string, id: number, title: string, content: string): string {
  return `${date},${action},${id},${title},${content}`;
}

/** Build a SourceFile descriptor for a synthetic vault file. */
function makePair(filePath: string, tableName: string): SourceFile {
  return { basePath: filePath, tableName };
}

/** The output path `runDiagnose` writes to (matches `fixedOutputPath`). */
function fixedPath(basePath: string): string {
  return basePath.replace(/\.csv(\.gz)?$/, '.fixed.csv.gz');
}

// ── Large-table fix ───────────────────────────────────────────────────────────

describe('fix e2e — large table (orderBookL2)', () => {
  it('removes a reconnection duplicate (same exchange timestamp, other messages in between)', async () => {
    // A genuine reconnection dup: message at T1 is re-sent after other events at T2 advance
    // the lobby past T1. The lobby no longer holds T1's hash, so seen catches the re-sent message.
    const inputPath = path.join(tempDir, 'obl2.csv.gz');
    const header    = ORDER_BOOK_L2_COLS.join(',');

    writeGz(inputPath, [
      header,
      obl2Row('2026-01-01T00:00:01.500Z', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000), // original at T1
      obl2Row('2026-01-01T00:00:02.000Z', 'insert', '2026-01-01T00:00:02.000Z', 99, 99999), // T2 — advances lobby, clearing T1
      obl2Row('2026-01-01T00:00:02.500Z', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000), // reconnection dup of T1 — seen catches it
      obl2Row('2026-01-01T00:00:03.500Z', 'insert', '2026-01-01T00:00:03.000Z', 2, 30100),
    ]);

    await runDiagnose([makePair(inputPath, 'orderBookL2')], false, null);

    const out = readGz(fixedPath(inputPath));

    // header + 3 messages (reconnection dup removed)
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(header);

    const ids = out.slice(1).map(line => line.split(',')[3]);

    expect(ids).toEqual(['1', '99', '2']);
  });

  it('preserves bounce-backs (identical adjacent messages at the same exchange timestamp)', async () => {
    // Bounce-backs are legitimate events: the lobby gate lets them through.
    // e.g. tick direction cycling ZeroMinusTick → MinusTick → ZeroMinusTick in one exchange ms.
    const inputPath = path.join(tempDir, 'obl2.csv.gz');
    const header    = ORDER_BOOK_L2_COLS.join(',');

    writeGz(inputPath, [
      header,
      obl2Row('2026-01-01T00:00:01.500Z', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000), // first occurrence at T1
      obl2Row('2026-01-01T00:00:01.600Z', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000), // same T1 — bounce-back, must be kept
      obl2Row('2026-01-01T00:00:02.500Z', 'insert', '2026-01-01T00:00:02.000Z', 2, 30100),
    ]);

    await runDiagnose([makePair(inputPath, 'orderBookL2')], false, null);

    const out = readGz(fixedPath(inputPath));

    // header + 3 messages (bounce-back preserved)
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(header);

    const ids = out.slice(1).map(line => line.split(',')[3]);

    expect(ids).toEqual(['1', '1', '2']);
  });

  it('removes non-adjacent duplicates within the same canonical minute', async () => {
    const inputPath = path.join(tempDir, 'obl2.csv.gz');
    const header    = ORDER_BOOK_L2_COLS.join(',');

    writeGz(inputPath, [
      header,
      obl2Row('2026-01-01T00:00:01.500Z', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000),
      obl2Row('2026-01-01T00:00:02.500Z', 'insert', '2026-01-01T00:00:02.000Z', 2, 30100),
      obl2Row('2026-01-01T00:00:03.500Z', 'insert', '2026-01-01T00:00:03.000Z', 3, 30200),
      obl2Row('2026-01-01T00:00:04.500Z', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000), // non-adjacent dup of first
    ]);

    await runDiagnose([makePair(inputPath, 'orderBookL2')], false, null);

    const out = readGz(fixedPath(inputPath));

    expect(out).toHaveLength(4); // header + 3 unique
    expect(out[0]).toBe(header);
  });

  it('sorts wrong-order messages by timestamp within the window', async () => {
    const inputPath = path.join(tempDir, 'obl2.csv.gz');
    const header    = ORDER_BOOK_L2_COLS.join(',');

    // Incoming order is scrambled by timestamp within a single minute
    writeGz(inputPath, [
      header,
      obl2Row('2026-01-01T00:00:10.000Z', 'insert', '2026-01-01T00:00:05.000Z', 5, 30500),
      obl2Row('2026-01-01T00:00:10.000Z', 'insert', '2026-01-01T00:00:03.000Z', 3, 30300),
      obl2Row('2026-01-01T00:00:10.000Z', 'insert', '2026-01-01T00:00:04.000Z', 4, 30400),
      obl2Row('2026-01-01T00:00:10.000Z', 'insert', '2026-01-01T00:00:01.000Z', 1, 30100),
      obl2Row('2026-01-01T00:00:10.000Z', 'insert', '2026-01-01T00:00:02.000Z', 2, 30200),
    ]);

    await runDiagnose([makePair(inputPath, 'orderBookL2')], false, null);

    const out = readGz(fixedPath(inputPath));

    expect(out).toHaveLength(6); // header + 5

    const timestamps = out.slice(1).map(line => line.split(',')[8]);

    expect(timestamps).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:03.000Z',
      '2026-01-01T00:00:04.000Z',
      '2026-01-01T00:00:05.000Z',
    ]);
  });

  it('produces monotonic timestamps across bucket boundaries (spanning multiple minutes)', async () => {
    const inputPath = path.join(tempDir, 'obl2.csv.gz');
    const header    = ORDER_BOOK_L2_COLS.join(',');

    // 5 minutes of messages, 10 per minute, interleaved in incoming order.
    const lines: string[] = [header];

    for (let sec = 0; sec < 10; sec++) {
      for (let m = 0; m < 5; m++) {
        const ts = `2026-01-01T00:0${m}:${String(sec).padStart(2, '0')}.000Z`;

        lines.push(obl2Row(ts, 'insert', ts, m * 10 + sec, 30000 + m * 100 + sec));
      }
    }

    writeGz(inputPath, lines);

    await runDiagnose([makePair(inputPath, 'orderBookL2')], false, null);

    const out         = readGz(fixedPath(inputPath));
    const timestamps  = out.slice(1).map(line => line.split(',')[8] ?? '');

    expect(timestamps).toHaveLength(50);

    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]!.localeCompare(timestamps[i - 1]!)).toBeGreaterThanOrEqual(0);
    }
  });

  it('dry-run does not write an output file', async () => {
    const inputPath = path.join(tempDir, 'obl2.csv.gz');
    const header    = ORDER_BOOK_L2_COLS.join(',');

    writeGz(inputPath, [
      header,
      obl2Row('2026-01-01T00:00:01.000Z', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000),
    ]);

    await runDiagnose([makePair(inputPath, 'orderBookL2')], true, null);

    expect(fs.existsSync(fixedPath(inputPath))).toBe(false);
  });
});

// ── Small-table fix ───────────────────────────────────────────────────────────

describe('fix e2e — small table (unknown table — _date_ canonical)', () => {
  it('sorts wrong-order messages by _date_ and removes duplicates', async () => {
    const inputPath = path.join(tempDir, 'small.csv.gz');
    const header    = SMALL_TABLE_COLS.join(',');

    writeGz(inputPath, [
      header,
      smallRow('2026-01-01T00:00:05.000Z', 'insert', 5, 'E', 'content-e'),
      smallRow('2026-01-01T00:00:03.000Z', 'insert', 3, 'C', 'content-c'),
      smallRow('2026-01-01T00:00:05.000Z', 'insert', 5, 'E', 'content-e'), // dup
      smallRow('2026-01-01T00:00:01.000Z', 'insert', 1, 'A', 'content-a'),
      smallRow('2026-01-01T00:00:04.000Z', 'insert', 4, 'D', 'content-d'),
      smallRow('2026-01-01T00:00:02.000Z', 'insert', 2, 'B', 'content-b'),
    ]);

    // 'announcement' is a vault-known table without a timestamp column.
    await runDiagnose([makePair(inputPath, 'announcement')], false, null);

    const out = readGz(fixedPath(inputPath));

    expect(out).toHaveLength(6); // header + 5 unique (dup removed)

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

// ── Header recovery ───────────────────────────────────────────────────────────

describe('fix e2e — header recovery from vault TABLE_HEADERS', () => {
  it('injects the vault header when the source file has a malformed first row', async () => {
    const inputPath    = path.join(tempDir, 'chat.csv.gz');
    const vaultHeader  = CHAT_COLS.join(',');
    // First row is garbage — has correct column count but missing _date_ / _action_ column names.
    const garbageRow   = 'garbage,header,row,,,,,,,,';
    // Synthetic chat messages matching the vault column layout.
    const row1 = '2026-01-01T00:00:01.000Z,insert,1,,,,msg-a,user-a,,,';
    const row2 = '2026-01-01T00:00:02.000Z,insert,1,,,,msg-b,user-b,,,';

    writeGz(inputPath, [garbageRow, row1, row2]);

    await runDiagnose([makePair(inputPath, 'chat')], false, null);

    const out = readGz(fixedPath(inputPath));

    expect(out[0]).toBe(vaultHeader);
    // The garbage row is parsed as a message under the vault header; it will
    // still be written (it is not itself a duplicate or wrong-order).
    // The real rows should appear in sorted order.
    const dates = out.slice(1).map(line => line.split(',')[0]).filter(d => d.startsWith('2026'));

    expect(dates).toContain('2026-01-01T00:00:01.000Z');
    expect(dates).toContain('2026-01-01T00:00:02.000Z');
  });
});

// ── Output-already-exists guard ───────────────────────────────────────────────

describe('fix e2e — output file guard', () => {
  it('does not overwrite an existing fixed output', async () => {
    const inputPath = path.join(tempDir, 'obl2.csv.gz');
    const header    = ORDER_BOOK_L2_COLS.join(',');

    writeGz(inputPath, [
      header,
      obl2Row('2026-01-01T00:00:01.000Z', 'insert', '2026-01-01T00:00:01.000Z', 1, 30000),
    ]);

    const outPath = fixedPath(inputPath);

    fs.writeFileSync(outPath, 'existing');

    await runDiagnose([makePair(inputPath, 'orderBookL2')], false, null);

    expect(fs.readFileSync(outPath, 'utf8')).toBe('existing');
  });
});
