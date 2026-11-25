import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/fs/writer', () => ({
  appendBatch:   vi.fn(() => Promise.resolve()),
  isInitialized: vi.fn(() => false),
}));

import { writeLines, markClosing, isClosing, acceptsRows, _test_reset } from '../../src/data/bucket';
import { appendBatch, isInitialized } from '../../src/fs/writer';
import { TABLE_HEADERS } from '../../src/data/headers';

const HEADER = TABLE_HEADERS['trade']!.join(',');

beforeEach(() => {
  _test_reset();
  vi.clearAllMocks();
  vi.mocked(isInitialized).mockReturnValue(false);
  vi.mocked(appendBatch).mockResolvedValue(undefined);
});

describe('writeLines', () => {
  it('prepends the header line when the file is not yet initialised', async () => {
    await writeLines('trade', '20230201', ['a', 'b']);

    expect(appendBatch).toHaveBeenCalledWith('trade', '20230201', [HEADER, 'a', 'b'], false);
  });

  it('does not prepend the header when the file is already initialised', async () => {
    vi.mocked(isInitialized).mockReturnValue(true);

    await writeLines('trade', '20230201', ['a'], true);

    expect(appendBatch).toHaveBeenCalledWith('trade', '20230201', ['a'], true);
  });

  it('hands the batch to the writer synchronously, within the call', () => {
    void writeLines('trade', '20230201', ['a']);

    expect(appendBatch).toHaveBeenCalledTimes(1);
  });

  it('rejects, without writing, when the table has no header definition', async () => {
    const result = writeLines('unknownTable', '20230201', ['a']);

    await expect(result).rejects.toThrow(/No header definition for table 'unknownTable'/);
    expect(appendBatch).not.toHaveBeenCalled();
  });

  it('rejects when the writer throws synchronously', async () => {
    vi.mocked(appendBatch).mockImplementation(() => { throw new Error('ENOTDIR'); });

    await expect(writeLines('trade', '20230201', ['a'])).rejects.toThrow('ENOTDIR');
  });
});

describe('closing state', () => {
  it('refuses rows while closing and accepts them after release', () => {
    expect(acceptsRows('trade', '20230201')).toBe(true);

    const release = markClosing('trade', '20230201');

    expect(isClosing('trade', '20230201')).toBe(true);
    expect(acceptsRows('trade', '20230201')).toBe(false);
    expect(acceptsRows('trade', '20230202')).toBe(true);

    release();

    expect(isClosing('trade', '20230201')).toBe(false);
    expect(acceptsRows('trade', '20230201')).toBe(true);
  });

  it('stays closing until every overlapping close has released', () => {
    const first  = markClosing('trade', '20230201');
    const second = markClosing('trade', '20230201');

    first();
    first(); // a repeated release has no further effect

    expect(isClosing('trade', '20230201')).toBe(true);

    second();

    expect(isClosing('trade', '20230201')).toBe(false);
  });
});
