import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDumpLog, dumpStatKey } from '../../../../src/tools/db/restore/dumplog';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const KB = 1024;

let dir: string;
let log: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumplog-'));
  log = path.join(dir, 'dump.log');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(content: string): void {
  fs.writeFileSync(log, content);
}

describe('parseDumpLog', () => {
  it('returns an empty map when the log is missing', () => {
    expect(parseDumpLog(path.join(dir, 'nope.log')).size).toBe(0);
  });

  it('parses a plan-table row into docs + uncompressed bytes, keyed by dashless period', () => {
    write([
      'Collection  Period   ~ Documents  ~ Size',
      '────────────────────────────────────────',
      'instrument  2026-03  132,340,663  29.3GB',
      '────────────────────────────────────────',
      'Total       1 pair   132,340,663  29.3GB',
      '',
    ].join('\n'));

    const map = parseDumpLog(log);

    expect(map.size).toBe(1);
    expect(map.get('instrument|202603')).toEqual({
      docs:  132_340_663,
      bytes: Math.round(29.3 * GB),
    });
  });

  it('handles year periods and KB/MB units', () => {
    write([
      'Collection  Period   ~ Documents  ~ Size',
      'orderBookL2  2020       1,000,000  500.5MB',
      'quoteBin1d   2026-05        3,024  466.6KB',
      '',
    ].join('\n'));

    const map = parseDumpLog(log);

    expect(map.get('orderBookL2|2020')).toEqual({ docs: 1_000_000, bytes: Math.round(500.5 * MB) });
    expect(map.get('quoteBin1d|202605')).toEqual({ docs: 3_024,     bytes: Math.round(466.6 * KB) });
  });

  it('skips header, separator, and Total lines', () => {
    write([
      'Collection  Period   ~ Documents  ~ Size',
      '─────────────────────────────',
      'Total       4 pairs    4,556,933  686.6MB',
    ].join('\n'));

    expect(parseDumpLog(log).size).toBe(0);
  });

  it('keeps the last occurrence when a pair is re-dumped', () => {
    write([
      '2026-06-20 10:00:00Z  —  dump  —  args: instrument 202603',
      'instrument  2026-03  100,000,000  20.0GB',
      '',
      '2026-06-22 11:00:00Z  —  dump  —  args: instrument 202603',
      'instrument  2026-03  132,340,663  29.3GB',
      '',
    ].join('\n'));

    expect(parseDumpLog(log).get('instrument|202603')).toEqual({
      docs:  132_340_663,
      bytes: Math.round(29.3 * GB),
    });
  });
});

describe('dumpStatKey', () => {
  it('joins collection and key', () => {
    expect(dumpStatKey('instrument', '202603')).toBe('instrument|202603');
  });
});
