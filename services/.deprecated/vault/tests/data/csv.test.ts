import { describe, it, expect } from 'vitest';
import { createCsvParser, rowToCsv } from '../../src/data/csv';

/** Parse CSV text with `createCsvParser` and collect every record. */
const parseAll = async (text: string, columns: false | true | string[] = true, relaxColumnCount = false): Promise<unknown[]> => {
  const parser  = createCsvParser(columns, relaxColumnCount);
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

  it('writes objects as bare JSON when the JSON needs no quoting', () => {
    expect(rowToCsv({ v: [1] }, ['v'])).toBe('[1]');
  });

  it('writes the columns in the order given, whatever order the row holds them in', () => {
    expect(rowToCsv({ c: 3, a: 1, b: 2 }, ['b', 'c', 'a'])).toBe('2,3,1');
  });

  it('writes only the columns given, and an empty field for one the row lacks', () => {
    expect(rowToCsv({ a: 1, extra: 'x' }, ['a', 'missing'])).toBe('1,');
  });
});

describe('createCsvParser', () => {
  it('reads a multi-line quoted field as one field of one record', async () => {
    expect(await parseAll('id,text\n1,"first\nsecond\n\nthird"\n2,ok\n')).toEqual([
      { id: '1', text: 'first\nsecond\n\nthird' },
      { id: '2', text: 'ok' },
    ]);
  });

  it('reads every field as a string', async () => {
    expect(await parseAll('n,b\n42,true\n')).toEqual([{ n: '42', b: 'true' }]);
  });

  it('drops empty records', async () => {
    expect(await parseAll('a\n1\n\n2\n')).toEqual([{ a: '1' }, { a: '2' }]);
  });

  it('emits records as arrays, header included, with no columns', async () => {
    expect(await parseAll('a,b\n1,2\n', false)).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('reads the first record as data with the columns given', async () => {
    expect(await parseAll('1,2\n', ['a', 'b'])).toEqual([{ a: '1', b: '2' }]);
  });

  it('refuses a record whose field count is not the column count', async () => {
    await expect(parseAll('a,b\n1,2,3\n')).rejects.toThrow();
  });

  it('passes such a record through when the column count is relaxed', async () => {
    expect(await parseAll('a,b\n1,2\n3\n', false, true)).toEqual([['a', 'b'], ['1', '2'], ['3']]);
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
