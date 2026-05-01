import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverFiles } from '../src/discovery';

vi.mock('../src/vault', () => ({
  listTables: vi.fn(),
  listFiles:  vi.fn(),
}));

import { listTables, listFiles } from '../src/vault';

describe('discoverFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips open files and includes only closed ones', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade']);
    vi.mocked(listFiles).mockResolvedValue({
      '20240101': 'closed',
      '20240102': 'open',
      '20240103': 'closed',
    });

    const batches = await discoverFiles('http://vault');

    expect(batches.map(b => b.date)).toEqual(['20240101', '20240103']);
  });

  it('groups multiple tables under the same date', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade', 'quote']);
    vi.mocked(listFiles).mockImplementation(async (_url, table) => {
      if (table === 'trade') return { '20240101': 'closed' };
      if (table === 'quote') return { '20240101': 'closed' };
      return null;
    });

    const batches = await discoverFiles('http://vault');

    expect(batches).toEqual([
      { date: '20240101', tables: ['quote', 'trade'] },
    ]);
  });

  it('sorts dates ascending', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade']);
    vi.mocked(listFiles).mockResolvedValue({
      '20240103': 'closed',
      '20240101': 'closed',
      '20240102': 'closed',
    });

    const batches = await discoverFiles('http://vault');

    expect(batches.map(b => b.date)).toEqual(['20240101', '20240102', '20240103']);
  });

  it('honours the table filter', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade', 'quote', 'orderBookL2']);
    vi.mocked(listFiles).mockResolvedValue({ '20240101': 'closed' });

    const batches = await discoverFiles('http://vault', ['trade', 'quote']);

    expect(batches[0]!.tables).toEqual(['quote', 'trade']);
  });

  it('skips tables where listFiles returns null', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade', 'unknown']);
    vi.mocked(listFiles).mockImplementation(async (_url, table) => {
      if (table === 'trade') return { '20240101': 'closed' };
      return null;
    });

    const batches = await discoverFiles('http://vault');

    expect(batches[0]!.tables).toEqual(['trade']);
  });
});
