import { describe, it, expect } from 'vitest';
import { parseVaultPath, parseMegaTar } from '../../../../src/tools/sources/scan/parse';
import { SUFFIXED_SOURCE_RE } from '../../../../src/tools/sources/discover';

// ── parseVaultPath ────────────────────────────────────────────────────────────

describe('parseVaultPath — buckets', () => {
  it('parses a suffix-less bucket', () => {
    expect(parseVaultPath('orderBookL2/2026/20260101.csv.gz')).toEqual({
      table:  'orderBookL2',
      year:   '2026',
      day:    '20260101',
      suffix: '',
      isTmp:  false,
    });
  });

  it('parses a bucket being downloaded (.tmp)', () => {
    expect(parseVaultPath('trade/2026/20260101.csv.gz.tmp')).toEqual({
      table:  'trade',
      year:   '2026',
      day:    '20260101',
      suffix: '',
      isTmp:  true,
    });
  });
});

describe('parseVaultPath — source files', () => {
  it('parses a single-segment suffix', () => {
    expect(parseVaultPath('instrument/2026/20260101.local.csv.gz')).toEqual({
      table:  'instrument',
      year:   '2026',
      day:    '20260101',
      suffix: 'local',
      isTmp:  false,
    });
  });

  it('parses a multi-segment suffix (collision counter)', () => {
    expect(parseVaultPath('instrument/2026/20260427.local.1.csv.gz')).toEqual({
      table:  'instrument',
      year:   '2026',
      day:    '20260427',
      suffix: 'local.1',
      isTmp:  false,
    });
  });

  it('parses a suffix with a non-word char', () => {
    expect(parseVaultPath('chat/2026/20260101.host-a.csv.gz')?.suffix).toBe('host-a');
  });

  it('parses a source file being downloaded (.tmp)', () => {
    expect(parseVaultPath('orderBookL2/2026/20260101.mtav.csv.gz.tmp')).toEqual({
      table:  'orderBookL2',
      year:   '2026',
      day:    '20260101',
      suffix: 'mtav',
      isTmp:  true,
    });
  });
});

describe('parseVaultPath — rejections', () => {
  it('rejects an unknown table', () => {
    expect(parseVaultPath('notATable/2026/20260101.csv.gz')).toBeNull();
  });

  it('rejects a malformed year', () => {
    expect(parseVaultPath('trade/26/20260101.csv.gz')).toBeNull();
  });

  it('rejects a path with a subfolder (≠ 3 components)', () => {
    expect(parseVaultPath('trade/2026/prepared/20260101.csv.gz')).toBeNull();
  });

  it('rejects a path missing the year level', () => {
    expect(parseVaultPath('trade/20260101.csv.gz')).toBeNull();
  });

  it('rejects a non-8-digit day', () => {
    expect(parseVaultPath('trade/2026/2026011.csv.gz')).toBeNull();
  });

  it('rejects a non-csv.gz extension', () => {
    expect(parseVaultPath('trade/2026/20260101.csv')).toBeNull();
  });

  it('rejects an empty suffix segment', () => {
    expect(parseVaultPath('trade/2026/20260101..csv.gz')).toBeNull();
  });
});

// ── parseMegaTar ──────────────────────────────────────────────────────────────

describe('parseMegaTar', () => {
  it('parses a year tarball', () => {
    expect(parseMegaTar('orderBookL2/2021.tar')).toEqual({ table: 'orderBookL2', year: 2021 });
  });

  it('rejects an unknown table', () => {
    expect(parseMegaTar('notATable/2021.tar')).toBeNull();
  });

  it('rejects a non-tar file', () => {
    expect(parseMegaTar('orderBookL2/2021.csv.gz')).toBeNull();
  });

  it('rejects a path that is not <table>/YYYY.tar', () => {
    expect(parseMegaTar('orderBookL2/2021/extra.tar')).toBeNull();
  });
});

// ── SUFFIXED_SOURCE_RE (shared suffix definition) ─────────────────────────────

describe('SUFFIXED_SOURCE_RE', () => {
  it('matches single- and multi-segment suffixed sources', () => {
    expect(SUFFIXED_SOURCE_RE.test('20260101.local.csv.gz')).toBe(true);
    expect(SUFFIXED_SOURCE_RE.test('20260427.local.1.csv.gz')).toBe(true);
    expect(SUFFIXED_SOURCE_RE.test('20260101.host-a.csv.gz')).toBe(true);
  });

  it('does not match suffix-less buckets or .tmp files', () => {
    expect(SUFFIXED_SOURCE_RE.test('20260101.csv.gz')).toBe(false);
    expect(SUFFIXED_SOURCE_RE.test('20260101.local.csv.gz.tmp')).toBe(false);
  });
});
