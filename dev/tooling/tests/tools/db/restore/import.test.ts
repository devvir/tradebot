import { describe, it, expect } from 'vitest';
import {
  _test_parseProgress as parseProgress,
  _test_parseDoneLine as parseDoneLine,
  _test_sizeToBytes   as sizeToBytes,
} from '../../../../src/tools/db/restore/import';

// ── sizeToBytes ────────────────────────────────────────────────────────────────

describe('sizeToBytes', () => {
  it('handles B, KB, MB, GB, TB', () => {
    expect(sizeToBytes(123, 'B')).toBe(123);
    expect(sizeToBytes(1, 'KB')).toBe(1024);
    expect(sizeToBytes(1, 'MB')).toBe(1048576);
    expect(sizeToBytes(1, 'GB')).toBe(1073741824);
    expect(sizeToBytes(2, 'TB')).toBe(2 * 1024 ** 4);
  });

  it('handles fractional values', () => {
    expect(sizeToBytes(10.4, 'MB')).toBe(Math.round(10.4 * 1024 * 1024));
    expect(sizeToBytes(2.5, 'KB')).toBe(2560);
  });
});

// ── parseProgress ──────────────────────────────────────────────────────────────
// mongorestore --verbose emits running-progress lines as `<ns>  <value><unit>`,
// e.g. `tradebot.quoteBin1h  10.4MB`. Value can be decimal; unit is one of
// B|KB|MB|GB|TB. We convert to bytes.

describe('parseProgress (mongorestore stderr line)', () => {
  it('extracts bytes from a real progress line in MB', () => {
    const line = '2026-05-23T18:30:00.000+0400\t_test_restore.quoteBin1h  10.4MB';
    expect(parseProgress(line)).toEqual({ done: Math.round(10.4 * 1024 * 1024) });
  });

  it('handles KB', () => {
    const line = '2026-05-23T18:30:00.000+0400\ttradebot.quote  595KB';
    expect(parseProgress(line)).toEqual({ done: 595 * 1024 });
  });

  it('handles GB with decimals', () => {
    const line = '2026-05-23T18:30:00.000+0400\ttradebot.quote  1.5GB';
    expect(parseProgress(line)).toEqual({ done: Math.round(1.5 * 1024 * 1024 * 1024) });
  });

  it('handles plain B', () => {
    const line = '2026-05-23T18:30:00.000+0400\ttradebot.tiny  42B';
    expect(parseProgress(line)).toEqual({ done: 42 });
  });

  it('matches namespaces containing digits', () => {
    const line = '2026-05-23T18:30:00.000+0400\ttradebot.tradeBin1m  3.2MB';
    expect(parseProgress(line)).toEqual({ done: Math.round(3.2 * 1024 * 1024) });
  });

  it('returns null for non-progress lines', () => {
    expect(parseProgress('archive prelude `tradebot.quoteBin1h`')).toBeNull();
    expect(parseProgress('preparing collections to restore from')).toBeNull();
    expect(parseProgress('finished restoring `tradebot.quote` (10000 documents, 0 failures)')).toBeNull();
    expect(parseProgress('')).toBeNull();
  });
});

// ── parseDoneLine ──────────────────────────────────────────────────────────────
// We match the final summary line specifically: `<N> document(s) restored
// successfully.` The per-collection "finished restoring" line carries the
// same count and is not separately parsed.

describe('parseDoneLine (mongorestore final summary)', () => {
  it('extracts the success count from the final summary line', () => {
    expect(parseDoneLine('2026-05-25T17:18:29.321+0400\t119544 document(s) restored successfully. 0 document(s) failed to restore.')).toBe(119544);
    expect(parseDoneLine('1 document(s) restored successfully.')).toBe(1);
    expect(parseDoneLine('0 document(s) restored successfully. 0 document(s) failed to restore.')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(parseDoneLine('42 Document(s) Restored Successfully')).toBe(42);
  });

  it('does NOT match the per-collection "finished restoring" line', () => {
    expect(parseDoneLine('finished restoring `tradebot.quote` (119544 documents, 0 failures)')).toBeNull();
  });

  it('returns null for other lines', () => {
    expect(parseDoneLine('tradebot.quote  10.4MB')).toBeNull();
    expect(parseDoneLine('')).toBeNull();
  });
});
