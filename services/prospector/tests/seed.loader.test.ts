import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCatalog } from '../src/database';
import { parseCsv, seed } from '../src/database/migrations/seeds/seed';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The seed loader over fixture directories: what it plants from a well-formed
 * seed, and every way it refuses a malformed one. The shipped seeds are covered
 * by `seed.test.ts` and `seed.contract.test.ts`; these state the reader's own
 * rules.
 */

const VENUE = 'zz';

const PATTERNS = [
  'virtual_id,market,dataset,variant,pattern,grain,retired_at',
  '1,perp,trades,,d/{SYMBOL}/{YYYY}{MM}{DD}.zip,daily,',
  '2,perp,trades,,m/{SYMBOL}/{YYYY}{MM}.zip,monthly,202405',
  '3,perp,funding,,w/{YYYY}{MM}{DD}.zip,daily,',
].join('\n') + '\n';

const SERIES = [
  'pattern_id,symbol,url_symbol,last,floor,note',
  '1,BTCUSDT,,20260801,20250102,"kept, but read by nobody"',
  '1,ETHUSDT,eth-usdt,,20250301,',
  '2,BTCUSDT,,202404,202301,',
  '3,@,,,20240101,',
].join('\n') + '\n';

const TRANSFORMS = [
  'market,symbol,dataset,kind,transform,date_from,date_to',
  'perp,BTCUSDT,,archiveDir,BTC_D2,20250102,20250630',
].join('\n') + '\n';

let root: string;
let db:   DatabaseSync;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'seed-loader-'));
  db   = openCatalog(join(root, 'catalog.db'), { seedData: false });

  db.prepare('INSERT INTO venue (name, base, key_root) VALUES (?, ?, ?)')
    .run(VENUE, 'https://example.test', '');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A seed directory holding `files` for the fixture venue, by table name. */
const seedDir = (files: Record<string, string>): string => {
  const dir = join(root, `seeds-${Math.random().toString(36).slice(2)}`);

  mkdirSync(join(dir, VENUE), { recursive: true });

  for (const [table, text] of Object.entries(files))
    writeFileSync(join(dir, VENUE, `${table}.csv`), text);

  return dir;
};

const plant = (files: Record<string, string>): void => seed(db, VENUE, seedDir(files));

/** Every planted series, by its pattern's text and its symbol. */
const planted = (): Record<string, unknown>[] =>
  db.prepare(
    `SELECT p.pattern, coalesce(i.symbol, '@') AS symbol, s.url_symbol, s.last, s.tip
       FROM series s JOIN pattern p ON p.id = s.pattern_id
       LEFT JOIN instrument i ON i.id = s.instrument_id
      ORDER BY p.pattern, symbol`,
  ).all().map(row => ({ ...row }));

const count = (table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('a well-formed seed', () => {
  it('plants every pattern, series and transform, each floor as the tip one period below it', () => {
    plant({ pattern: PATTERNS, series: SERIES, transform: TRANSFORMS });

    expect(planted()).toEqual([
      { pattern: 'd/{SYMBOL}/{YYYY}{MM}{DD}.zip', symbol: 'BTCUSDT', url_symbol: null,       last: '20260801', tip: '20250101' },
      { pattern: 'd/{SYMBOL}/{YYYY}{MM}{DD}.zip', symbol: 'ETHUSDT', url_symbol: 'eth-usdt', last: null,       tip: '20250228' },
      { pattern: 'm/{SYMBOL}/{YYYY}{MM}.zip',     symbol: 'BTCUSDT', url_symbol: null,       last: '202404',   tip: '202212' },
      { pattern: 'w/{YYYY}{MM}{DD}.zip',          symbol: '@',       url_symbol: null,       last: null,       tip: '20231231' },
    ]);

    expect(db.prepare('SELECT pattern, retired_at FROM pattern ORDER BY pattern').all().map(row => ({ ...row })))
      .toEqual([
        { pattern: 'd/{SYMBOL}/{YYYY}{MM}{DD}.zip', retired_at: null },
        { pattern: 'm/{SYMBOL}/{YYYY}{MM}.zip',     retired_at: '202405' },
        { pattern: 'w/{YYYY}{MM}{DD}.zip',          retired_at: null },
      ]);

    expect(db.prepare('SELECT symbol, kind, transform, date_from, date_to FROM transform').all()
      .map(row => ({ ...row })))
      .toEqual([{ symbol: 'BTCUSDT', kind: 'archiveDir', transform: 'BTC_D2', date_from: '20250102', date_to: '20250630' }]);
  });

  it('plants the same rows from CRLF files as from LF ones', () => {
    plant({ pattern: PATTERNS, series: SERIES });
    const lf = planted();

    db.exec('DELETE FROM series; DELETE FROM instrument; DELETE FROM pattern; DELETE FROM slice;');

    const crlf = (text: string): string => text.replace(/\n/g, '\r\n');

    plant({ pattern: crlf(PATTERNS), series: crlf(SERIES) });

    expect(planted()).toEqual(lf);
    expect(lf).toHaveLength(4);
  });

  it('reads a file that opens with a byte-order mark', () => {
    plant({ pattern: '﻿' + PATTERNS, series: '﻿' + SERIES });

    expect(planted()).toHaveLength(4);
  });

  it('seeds shapes alone where there is no series file, and no transforms where there is no transform file', () => {
    plant({ pattern: PATTERNS });

    expect(count('pattern')).toBe(3);
    expect(count('series')).toBe(0);
    expect(count('transform')).toBe(0);
  });

  it('skips a series row that repeats another in every column the catalog reads', () => {
    plant({ pattern: PATTERNS, series: SERIES + '1,BTCUSDT,,20260801,20250102,another note\n' });

    expect(planted()).toHaveLength(4);
  });
});

describe('a seed the loader refuses', () => {
  it('names the venue whose row is missing', () => {
    expect(() => seed(db, 'nowhere', seedDir({ pattern: PATTERNS })))
      .toThrow(/No venue row for 'nowhere' — the core migration must run first/);
  });

  it('gives a pattern a grain its slots contradict', () => {
    expect(() => plant({ pattern: PATTERNS.replace('.zip,daily,', '.zip,monthly,') }))
      .toThrow(/zz\/pattern\.csv gives pattern 1 the grain "monthly", and its slots say "daily"/);
  });

  it('retires a pattern at something that is not a date stamp', () => {
    expect(() => plant({ pattern: PATTERNS.replace(',202405', ',2024-05') }))
      .toThrow(/zz\/pattern\.csv line 3: retired_at "2024-05" is not a date stamp/);
  });

  it('points a series at a pattern the pattern file does not define', () => {
    expect(() => plant({ pattern: PATTERNS, series: SERIES + '9,BTCUSDT,,,20250102,\n' }))
      .toThrow(/references pattern 9, which zz\/pattern\.csv does not define — it has 3 rows/);
  });

  it('gives two instruments one spelling under one pattern', () => {
    expect(() => plant({ pattern: PATTERNS, series: SERIES + '1,SOLUSDT,eth-usdt,,20250301,\n' }))
      .toThrow(/the key "eth-usdt" for both "ETHUSDT" and "SOLUSDT" — two instruments cannot publish to one URL/);
  });

  it('repeats a series with a different floor', () => {
    expect(() => plant({ pattern: PATTERNS, series: SERIES + '1,BTCUSDT,,20260801,20250105,\n' }))
      .toThrow(/zz\/series\.csv line 6 repeats pattern 1's "BTCUSDT" with a different floor/);
  });

  it('files the market bucket under a pattern that holds one instrument', () => {
    expect(() => plant({ pattern: PATTERNS, series: SERIES + '1,@,,,20250102,\n' }))
      .toThrow(/names "@" under pattern 1, whose files hold one instrument/);
  });

  it('files an instrument under a pattern that holds a whole market', () => {
    expect(() => plant({ pattern: PATTERNS, series: SERIES + '3,BTCUSDT,,,20250102,\n' }))
      .toThrow(/names "BTCUSDT" under pattern 3, whose files hold a whole market/);
  });

  it('states a floor at another grain than its pattern', () => {
    expect(() => plant({ pattern: PATTERNS, series: SERIES.replace('2,BTCUSDT,,202404,202301,', '2,BTCUSDT,,202404,20230101,') }))
      .toThrow(/zz\/series\.csv line 4: floor "20230101" is not a monthly stamp of 6 digits/);
  });

  it('states a last at another grain than its pattern', () => {
    expect(() => plant({ pattern: PATTERNS, series: SERIES.replace('20260801', '202608') }))
      .toThrow(/zz\/series\.csv line 2: last "202608" is not a daily stamp of 8 digits/);
  });

  it('opens a transform at something that is not a date stamp', () => {
    expect(() => plant({ pattern: PATTERNS, transform: TRANSFORMS.replace(',20250102,', ',,') }))
      .toThrow(/zz\/transform\.csv line 2: date_from "" is not a date stamp/);
  });

  it('closes a transform at something that is not a date stamp', () => {
    expect(() => plant({ pattern: PATTERNS, transform: TRANSFORMS.replace(',20250630', ',2025-06-30') }))
      .toThrow(/zz\/transform\.csv line 2: date_to "2025-06-30" is not a date stamp/);
  });

  it('has a row whose field count differs from the header, and names its line', () => {
    expect(() => plant({ pattern: PATTERNS, series: SERIES + '1,XRPUSDT,,,20250102\n' }))
      .toThrow(/zz\/series\.csv line 6 has 5 fields, not 6/);
  });
});

describe('parseCsv', () => {
  it('keys each row by the header', () => {
    expect(parseCsv('a,b\n1,2\n3,4\n', 'f')).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('a,b\n"x,y",z\n', 'f')).toEqual([{ a: 'x,y', b: 'z' }]);
  });

  it('reads a doubled quote inside a quoted field as one quote', () => {
    expect(parseCsv('a,b\n"x""y",z\n', 'f')).toEqual([{ a: 'x"y', b: 'z' }]);
  });

  it('reads an empty last field', () => {
    expect(parseCsv('a,b\n1,\n', 'f')).toEqual([{ a: '1', b: '' }]);
  });

  it('reads an empty quoted field', () => {
    expect(parseCsv('a,b\n"",2\n', 'f')).toEqual([{ a: '', b: '2' }]);
  });

  it('accepts CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n', 'f')).toEqual([{ a: '1', b: '2' }]);
  });

  it('ignores a leading byte-order mark', () => {
    expect(parseCsv('﻿a,b\n1,2\n', 'f')).toEqual([{ a: '1', b: '2' }]);
  });

  it('trims header names', () => {
    expect(parseCsv(' a , b\n1,2\n', 'f')).toEqual([{ a: '1', b: '2' }]);
  });

  it('ends the file at trailing blank lines', () => {
    expect(parseCsv('a\n1\n\n\n', 'f')).toEqual([{ a: '1' }]);
  });

  it('reads a header alone as no rows', () => {
    expect(parseCsv('a,b\n', 'f')).toEqual([]);
  });

  it('refuses an empty file', () => {
    expect(() => parseCsv('', 'f.csv')).toThrow(/f\.csv has no header/);
  });

  it('refuses an unterminated quote', () => {
    expect(() => parseCsv('a,b\n"x,y\n', 'f.csv')).toThrow(/f\.csv line 2: unterminated quote/);
  });

  it('refuses text after a closing quote', () => {
    expect(() => parseCsv('a,b\n"x"y,z\n', 'f.csv')).toThrow(/f\.csv line 2: text after a closing quote/);
  });

  it('refuses a blank line before the last row', () => {
    expect(() => parseCsv('a\n1\n\n2\n', 'f.csv')).toThrow(/f\.csv line 3 is empty/);
  });

  it('refuses a row with the wrong number of fields', () => {
    expect(() => parseCsv('a,b\n1,2,3\n', 'f.csv')).toThrow(/f\.csv line 2 has 3 fields, not 2/);
  });
});
