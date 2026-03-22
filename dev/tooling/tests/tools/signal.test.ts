import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── MongoDB mock (via shared connection) ──────────────────────────────────────

const { mockCursor, mockCollection, mockDb, mockClient } = vi.hoisted(() => {
  const mockCursor = {
    sort: vi.fn(),
    limit: vi.fn(),
    toArray: vi.fn().mockResolvedValue([]),
  };

  mockCursor.sort.mockReturnValue(mockCursor);
  mockCursor.limit.mockReturnValue(mockCursor);

  const mockCollection = {
    find: vi.fn().mockReturnValue(mockCursor),
  };

  const mockDb = {
    collection: vi.fn().mockReturnValue(mockCollection),
  };

  const mockClient = {
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { mockCursor, mockCollection, mockDb, mockClient };
});

vi.mock('../../src/shared/connections/mongodb', () => ({
  connectMongo: vi.fn().mockResolvedValue({
    client: mockClient,
    db: mockDb,
    url: 'mongodb://localhost:27017/tradebot',
  }),
}));

import { run } from '../../src/tools/signal/index';

const SIGNALS = [
  { timestamp: new Date('2026-01-01T00:00:00Z'), symbol: 'XBTUSD', type: 'momentum', direction: 'long', strength: 85, price: 50000 },
  { timestamp: new Date('2026-01-02T00:00:00Z'), symbol: 'ETHUSD', type: 'rsi', direction: 'short', strength: 60, price: 3000 },
  { timestamp: new Date('2026-01-03T00:00:00Z'), symbol: 'XBTUSD', type: 'rsi', direction: 'long', strength: 70, price: 51000 },
];

describe('signal tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockCursor.sort.mockReturnValue(mockCursor);
    mockCursor.limit.mockReturnValue(mockCursor);
    mockCursor.toArray.mockResolvedValue([]);
    mockCollection.find.mockReturnValue(mockCursor);
    mockDb.collection.mockReturnValue(mockCollection);

    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queries the signals collection', async () => {
    await run({});
    expect(mockDb.collection).toHaveBeenCalledWith('signals');
    expect(mockCollection.find).toHaveBeenCalled();
  });

  it('filters by symbol when --symbol is set', async () => {
    await run({ symbol: 'XBTUSD' });
    expect(mockCollection.find).toHaveBeenCalledWith({ symbol: 'XBTUSD' });
  });

  it('queries all symbols when no --symbol filter', async () => {
    await run({});
    expect(mockCollection.find).toHaveBeenCalledWith({});
  });

  it('sorts by timestamp descending when --latest is set', async () => {
    await run({ latest: true });
    expect(mockCursor.sort).toHaveBeenCalledWith({ timestamp: -1 });
  });

  it('limits to 20 with --latest, 50 without', async () => {
    await run({ latest: true });
    expect(mockCursor.limit).toHaveBeenCalledWith(20);

    vi.clearAllMocks();
    mockCursor.sort.mockReturnValue(mockCursor);
    mockCursor.limit.mockReturnValue(mockCursor);
    mockCollection.find.mockReturnValue(mockCursor);

    await run({ latest: false });
    expect(mockCursor.limit).toHaveBeenCalledWith(50);
  });

  it('prints each signal with its fields', async () => {
    mockCursor.toArray.mockResolvedValue(SIGNALS);
    await run({});
    const output = vi.mocked(console.log).mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('XBTUSD');
    expect(output).toContain('momentum');
    expect(output).toContain('85%');
    expect(output).toContain('50000');
  });

  it('prints summary counts by symbol and type', async () => {
    mockCursor.toArray.mockResolvedValue(SIGNALS);
    await run({});
    const output = vi.mocked(console.log).mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/XBTUSD: 2/);
    expect(output).toMatch(/rsi: 2/);
  });

  it('closes connection after run', async () => {
    mockCursor.toArray.mockResolvedValue(SIGNALS);
    await run({});
    expect(mockClient.close).toHaveBeenCalled();
  });
});
