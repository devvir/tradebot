import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  collectLeafFolders,
  groupFilesByDay,
  parseFromDay,
  sortByPrioritySortKey,
  tableNameFromFolder,
} from '../../../../src/tools/sources/merge/discover';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FOLDER = '/data/bitmex/vault/orderBookL2/2025';

/** Return just basenames from paths, for compact assertions. */
function names(paths: string[]): string[] {
  return paths.map(p => path.basename(p));
}

// ── groupFilesByDay ───────────────────────────────────────────────────────────

describe('groupFilesByDay — basic classification', () => {
  it('puts 2+ files for the same day into toMerge', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
    ]);

    expect(result.toMerge).toHaveLength(1);
    expect(result.toMerge[0]!.day).toBe('20250101');
    expect(names(result.toMerge[0]!.paths)).toEqual([
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
    ]);
    expect(result.singletons).toHaveLength(0);
    expect(result.alreadyMerged).toHaveLength(0);
  });

  it('puts a single file for a day into singletons', () => {
    const result = groupFilesByDay(FOLDER, ['20250102.csv.gz']);

    expect(result.singletons).toHaveLength(1);
    expect(result.singletons[0]!.day).toBe('20250102');
    expect(path.basename(result.singletons[0]!.path)).toBe('20250102.csv.gz');
    expect(result.toMerge).toHaveLength(0);
  });

  it('skips a day group that already contains the merged output', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250103.csv.gz',
      '20250103.gap.1.csv.gz',
      '20250103.merged.csv.gz',
    ]);

    expect(result.alreadyMerged).toHaveLength(1);
    expect(result.alreadyMerged[0]!.day).toBe('20250103');
    expect(result.toMerge).toHaveLength(0);
    expect(result.singletons).toHaveLength(0);
  });

  it('handles multiple days independently', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
      '20250102.csv.gz',                          // singleton
      '20250103.csv.gz',
      '20250103.gap.1.csv.gz',
      '20250103.merged.csv.gz',                   // already merged
    ]);

    expect(result.toMerge).toHaveLength(1);
    expect(result.toMerge[0]!.day).toBe('20250101');

    expect(result.singletons).toHaveLength(1);
    expect(result.singletons[0]!.day).toBe('20250102');

    expect(result.alreadyMerged).toHaveLength(1);
    expect(result.alreadyMerged[0]!.day).toBe('20250103');
  });
});

describe('groupFilesByDay — output path construction', () => {
  it('builds absolute paths from the folder and name', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
    ]);

    expect(result.toMerge[0]!.paths).toEqual([
      path.join(FOLDER, '20250101.csv.gz'),
      path.join(FOLDER, '20250101.gap.1.csv.gz'),
    ]);
  });

  it('sets outputPath to YYYYMMDD.merged.csv.gz in the folder', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
    ]);

    expect(result.toMerge[0]!.outputPath).toBe(
      path.join(FOLDER, '20250101.merged.csv.gz'),
    );
  });
});

describe('groupFilesByDay — priority order within a group', () => {
  it('sorts paths alphabetically so primary file leads', () => {
    // Already sorted input; the primary file (no suffix) comes first alphabetically.
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
      '20250101.gap.2.csv.gz',
    ]);

    expect(names(result.toMerge[0]!.paths)).toEqual([
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
      '20250101.gap.2.csv.gz',
    ]);
  });

  it('accepts input already sorted; does not re-sort (caller responsibility)', () => {
    // The function trusts the caller to pass sorted names. Verify the order is
    // preserved as-is when already sorted correctly.
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
    ]);

    expect(names(result.toMerge[0]!.paths)[0]).toBe('20250101.csv.gz');
  });
});

describe('groupFilesByDay — edge cases', () => {
  it('returns empty result for an empty list', () => {
    const result = groupFilesByDay(FOLDER, []);

    expect(result.toMerge).toHaveLength(0);
    expect(result.singletons).toHaveLength(0);
    expect(result.alreadyMerged).toHaveLength(0);
  });

  it('ignores files that do not start with 8 digits', () => {
    const result = groupFilesByDay(FOLDER, [
      'README.csv.gz',
      'archive.csv.gz',
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
    ]);

    // Only the YYYYMMDD-prefixed files are grouped.
    expect(result.toMerge).toHaveLength(1);
    expect(result.toMerge[0]!.day).toBe('20250101');
  });

  it('supports 3+ files for a single day', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
      '20250101.gap.2.csv.gz',
      '20250101.gap.3.csv.gz',
    ]);

    expect(result.toMerge[0]!.paths).toHaveLength(4);
  });

  it('outputs toMerge groups sorted by day', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250103.csv.gz',
      '20250103.gap.1.csv.gz',
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
      '20250102.csv.gz',
      '20250102.gap.1.csv.gz',
    ]);

    expect(result.toMerge.map(g => g.day)).toEqual(['20250101', '20250102', '20250103']);
  });
});

// ── sortByPrioritySortKey ─────────────────────────────────────────────────────
//
// Purely alphabetical with .csv.gz stripped. The primary file naturally leads
// because '20260411' < '20260411.a' in standard string order (prefix of a
// longer string sorts first). With full names, naive sort reverses this
// because 'a' < 'c' at the first differing character position.

describe('sortByPrioritySortKey — alphabetical with .csv.gz stripped', () => {
  it('primary file precedes a single-letter-infixed sibling: "20260411" < "20260411.a"', () => {
    const result = sortByPrioritySortKey([
      '20260411.a.csv.gz',
      '20260411.csv.gz',
    ]);

    expect(result).toEqual([
      '20260411.csv.gz',
      '20260411.a.csv.gz',
    ]);
  });

  it('primary file precedes .gap.N siblings (incidentally also true with naive sort)', () => {
    const result = sortByPrioritySortKey([
      '20260411.gap.2.csv.gz',
      '20260411.csv.gz',
      '20260411.gap.1.csv.gz',
    ]);

    expect(result).toEqual([
      '20260411.csv.gz',
      '20260411.gap.1.csv.gz',
      '20260411.gap.2.csv.gz',
    ]);
  });

  it('orders multiple infixed siblings alphabetically after the primary', () => {
    const result = sortByPrioritySortKey([
      '20260411.b.csv.gz',
      '20260411.a.csv.gz',
      '20260411.csv.gz',
    ]);

    expect(result).toEqual([
      '20260411.csv.gz',
      '20260411.a.csv.gz',
      '20260411.b.csv.gz',
    ]);
  });

  it('orders different days by their numeric prefix', () => {
    const result = sortByPrioritySortKey([
      '20260412.csv.gz',
      '20260411.csv.gz',
      '20260411.a.csv.gz',
    ]);

    expect(result).toEqual([
      '20260411.csv.gz',
      '20260411.a.csv.gz',
      '20260412.csv.gz',
    ]);
  });

  it('does not mutate the input', () => {
    const input = ['20260411.a.csv.gz', '20260411.csv.gz'];
    const snapshot = [...input];

    sortByPrioritySortKey(input);

    expect(input).toEqual(snapshot);
  });
});

// ── tableNameFromFolder ───────────────────────────────────────────────────────

describe('tableNameFromFolder', () => {
  it('returns the known table name found in the path', () => {
    expect(tableNameFromFolder('/data/vault/orderBookL2/2025')).toBe('orderBookL2');
    expect(tableNameFromFolder('/data/vault/instrument/2024')).toBe('instrument');
    expect(tableNameFromFolder('/data/vault/announcement/2025')).toBe('announcement');
  });

  it('prefers the deepest known table name when multiple are present', () => {
    // Contrived path; deepest wins.
    expect(tableNameFromFolder('/instrument/vault/orderBookL2/2025')).toBe('orderBookL2');
  });

  it('falls back to basename when no known table name is found', () => {
    expect(tableNameFromFolder('/data/custom/my-table')).toBe('my-table');
    expect(tableNameFromFolder('/tmp')).toBe('tmp');
  });
});

// ── parseFromDay ──────────────────────────────────────────────────────────────

describe('parseFromDay', () => {
  it('returns null for null', () => {
    expect(parseFromDay(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseFromDay(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseFromDay('')).toBeNull();
  });

  it('accepts YYYYMMDD and returns it unchanged', () => {
    expect(parseFromDay('20260101')).toBe('20260101');
  });

  it('accepts YYYY-MM-DD and strips the hyphens', () => {
    expect(parseFromDay('2026-01-01')).toBe('20260101');
  });

  it('throws on a 6-digit string', () => {
    expect(() => parseFromDay('202601')).toThrow(/Invalid --from date/);
  });

  it('throws on a non-numeric value', () => {
    expect(() => parseFromDay('yesterday')).toThrow(/Invalid --from date/);
  });

  it('throws on partial YYYY-MM-DD (missing day)', () => {
    expect(() => parseFromDay('2026-01')).toThrow(/Invalid --from date/);
  });

  it('includes the original input in the error message', () => {
    expect(() => parseFromDay('bad')).toThrow('"bad"');
  });
});

// ── groupFilesByDay — fromDay filter ──────────────────────────────────────────

describe('groupFilesByDay — fromDay filter', () => {
  it('includes all days when fromDay is not supplied', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
      '20250102.csv.gz',
      '20250102.gap.1.csv.gz',
    ]);

    expect(result.toMerge).toHaveLength(2);
  });

  it('skips days strictly before fromDay', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
      '20250102.csv.gz',
      '20250102.gap.1.csv.gz',
      '20250103.csv.gz',
      '20250103.gap.1.csv.gz',
    ], '20250102');

    // 20250101 is before the filter — not in any bucket.
    expect(result.toMerge.map(g => g.day)).toEqual(['20250102', '20250103']);
  });

  it('includes the fromDay itself (boundary is inclusive)', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
    ], '20250101');

    expect(result.toMerge).toHaveLength(1);
    expect(result.toMerge[0]!.day).toBe('20250101');
  });

  it('returns empty buckets when all days are before fromDay', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',
      '20250101.gap.1.csv.gz',
    ], '20260101');

    expect(result.toMerge).toHaveLength(0);
    expect(result.singletons).toHaveLength(0);
    expect(result.alreadyMerged).toHaveLength(0);
  });

  it('filter also applies to singletons and alreadyMerged groups', () => {
    const result = groupFilesByDay(FOLDER, [
      '20250101.csv.gz',                             // singleton, before filter
      '20250102.csv.gz',
      '20250102.merged.csv.gz',                      // alreadyMerged, before filter
      '20250103.csv.gz',                             // singleton, on/after filter
    ], '20250103');

    expect(result.singletons).toHaveLength(1);
    expect(result.singletons[0]!.day).toBe('20250103');
    expect(result.alreadyMerged).toHaveLength(0);
    expect(result.toMerge).toHaveLength(0);
  });
});
