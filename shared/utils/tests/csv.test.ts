import { describe, it, expect } from 'vitest';
import { createCsvParser, rowToCsv } from '../src/csv';

/** Parse CSV text with `createCsvParser` and collect every record. */
const parseAll = async (text: string, columns: false | true | string[] = true): Promise<unknown[]> => {
  const parser  = createCsvParser(columns);
  const records: unknown[] = [];

  parser.on('readable', () => {
    let record: unknown;
    while ((record = parser.read()) !== null) records.push(record);
  });

  const done = new Promise<void>((resolve, reject) => {
    parser.on('end', resolve);
    parser.on('error', reject);
  });

  parser.write(text);
  parser.end();
  await done;

  return records;
};

describe('rowToCsv', () => {
  it('leaves plain values unquoted', () => {
    expect(rowToCsv({ a: 'XBTUSD', b: 42, c: true }, ['a', 'b', 'c'])).toBe('XBTUSD,42,true');
  });

  it('writes null and undefined as empty fields', () => {
    expect(rowToCsv({ a: null, b: undefined }, ['a', 'b', 'c'])).toBe(',,');
  });

  it.each([
    ['comma',        'a,b'],
    ['double quote', 'say "hi"'],
    ['LF',           'line1\nline2'],
    ['CR',           'line1\rline2'],
    ['CRLF',         'line1\r\nline2'],
  ])('quotes a field containing a %s', (_, value) => {
    const line = rowToCsv({ v: value }, ['v']);

    expect(line.startsWith('"')).toBe(true);
    expect(line.endsWith('"')).toBe(true);
  });

  it('doubles embedded quotes', () => {
    expect(rowToCsv({ v: 'say "hi"' }, ['v'])).toBe('"say ""hi"""');
  });

  it('writes objects as quoted JSON when the JSON needs quoting', () => {
    expect(rowToCsv({ v: [[1, 2], [3, 4]] }, ['v'])).toBe('"[[1,2],[3,4]]"');
  });
});

describe('rowToCsv / createCsvParser round trip', () => {
  const cols = ['id', 'text', 'n'];

  it.each([
    ['plain',        'hello'],
    ['comma',        'a,b,c'],
    ['double quote', 'say "hi" and ""bye""'],
    ['LF',           'line1\nline2'],
    ['CR',           'line1\rline2'],
    ['CRLF',         'line1\r\nline2'],
    ['everything',   '"x",\r\n,y\r"z"\n'],
  ])('preserves a field containing %s', async (_, text) => {
    const rows = [
      { id: '1', text,       n: '10' },
      { id: '2', text: 'ok', n: '20' },
    ];
    const csv = [cols.join(','), ...rows.map(row => rowToCsv(row, cols))].join('\n') + '\n';

    expect(await parseAll(csv)).toEqual(rows);
  });

  it('keeps every record when lines end in CRLF', async () => {
    const rows = [
      { id: '1', text: 'a\rb', n: '1' },
      { id: '2', text: 'c',    n: '2' },
    ];
    const csv = rows.map(row => rowToCsv(row, cols)).join('\r\n') + '\r\n';

    expect(await parseAll(csv, cols)).toEqual(rows);
  });
});
