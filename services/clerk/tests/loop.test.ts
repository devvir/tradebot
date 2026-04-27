import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RedisClient } from '@devvir/service-kit';
import type { RabbitMQ } from '@devvir/service-kit';
import { runOnce } from '../src/loop';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../src/vault', () => ({
  listTables:     vi.fn(),
  listFiles:      vi.fn(),
  readFileGroups: vi.fn(),
  isWsMessage:    (item: unknown): boolean =>
    typeof item === 'object' && item !== null && 'action' in item && 'data' in item,
}));

vi.mock('../src/progress', () => ({
  isDone:    vi.fn().mockResolvedValue(false),
  getOffset: vi.fn().mockResolvedValue(0),
  setOffset: vi.fn().mockResolvedValue(undefined),
  markDone:  vi.fn().mockResolvedValue(undefined),
}));

import { listTables, listFiles, readFileGroups } from '../src/vault';
import { isDone, getOffset, setOffset } from '../src/progress';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeExchange = () => ({
  publish: vi.fn().mockResolvedValue(undefined),
});

const makeBroker = (exchange = makeExchange()) => ({
  getExchange: vi.fn(() => exchange),
} as unknown as RabbitMQ.Broker);

const makeRedis = () => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
} as unknown as RedisClient);

const noGate = async () => {};

// Simulates a vault file with N object rows
const makeReadFileGroups = (rowCount: number) =>
  vi.fn().mockImplementation(async (
    _url: string,
    _table: string,
    _date: string,
    onGroup: (row: Record<string, unknown>, index: number) => Promise<void>,
  ) => {
    for (let i = 0; i < rowCount; i++) {
      await onGroup({ id: i }, i);
    }
    return rowCount;
  });

// ── runOnce — date ordering ───────────────────────────────────────────────────

describe('runOnce — date ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDone).mockResolvedValue(false);
    vi.mocked(getOffset).mockResolvedValue(0);
  });

  it('processes all tables for a date before moving to the next date', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade', 'quote']);
    vi.mocked(listFiles).mockImplementation(async (_url, table) => {
      if (table === 'trade') return { '20240101': 'closed', '20240102': 'closed' };
      if (table === 'quote') return { '20240101': 'closed', '20240102': 'closed' };
      return null;
    });

    const order: string[] = [];

    vi.mocked(readFileGroups).mockImplementation(async (
      _url, table, date, onGroup,
    ) => {
      order.push(`start:${table}:${date}`);
      await onGroup({ id: 0 }, 0);
      order.push(`end:${table}:${date}`);
      return 1;
    });

    await runOnce('http://vault', makeBroker(), makeRedis(), noGate);

    // Both tables for 20240101 must finish before either starts 20240102
    const firstDate101 = order.findIndex(e => e.includes('20240101'));
    const lastDate101  = order.findLastIndex(e => e.includes('20240101'));
    const firstDate102 = order.findIndex(e => e.includes('20240102'));

    expect(lastDate101).toBeLessThan(firstDate102);
    expect(firstDate101).toBeGreaterThanOrEqual(0);
  });

  it('skips tables where listFiles returns null', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade', 'unknown']);
    vi.mocked(listFiles).mockImplementation(async (_url, table) => {
      if (table === 'trade') return { '20240101': 'closed' };
      return null;
    });
    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(1));

    await runOnce('http://vault', makeBroker(), makeRedis(), noGate);

    // readFileGroups should only have been called for 'trade', not 'unknown'
    const calls = vi.mocked(readFileGroups).mock.calls;

    expect(calls.every(([, table]) => table === 'trade')).toBe(true);
  });
});

// ── processFile — publish batching ────────────────────────────────────────────

describe('processFile — publish batching', () => {
  beforeEach(() => {
    vi.mocked(isDone).mockResolvedValue(false);
    vi.mocked(getOffset).mockResolvedValue(0);
    vi.mocked(listTables).mockResolvedValue(['trade']);
    vi.mocked(listFiles).mockResolvedValue({ '20240101': 'closed' });
  });

  it('calls publish once per message', async () => {
    const ROW_COUNT = 300;

    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(ROW_COUNT));
    const exchange = makeExchange();

    await runOnce('http://vault', makeBroker(exchange), makeRedis(), noGate);

    expect(exchange.publish).toHaveBeenCalledTimes(ROW_COUNT);
  });

  it('publishes all messages even when count is not a multiple of the batch size', async () => {
    const ROW_COUNT = 750;  // 1 full batch of 500 + 250 remainder

    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(ROW_COUNT));
    const exchange = makeExchange();

    await runOnce('http://vault', makeBroker(exchange), makeRedis(), noGate);

    expect(exchange.publish).toHaveBeenCalledTimes(ROW_COUNT);
  });
});

// ── processFile — setOffset fire-and-forget ───────────────────────────────────

describe('processFile — setOffset checkpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDone).mockResolvedValue(false);
    vi.mocked(getOffset).mockResolvedValue(0);
    vi.mocked(listTables).mockResolvedValue(['trade']);
    vi.mocked(listFiles).mockResolvedValue({ '20240101': 'open' });
  });

  it('calls setOffset at the 500-message checkpoint (not awaited, but still called)', async () => {
    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(500));

    await runOnce('http://vault', makeBroker(), makeRedis(), noGate);

    // checkpoint fires at msgIndex 499 (index+1 === 500)
    expect(vi.mocked(setOffset)).toHaveBeenCalledWith(
      expect.anything(), 'trade', '20240101', 500,
    );
  });

  it('does not call the checkpoint setOffset for fewer than 500 messages', async () => {
    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(499));

    await runOnce('http://vault', makeBroker(), makeRedis(), noGate);

    // Only the final setOffset (open file) should have been called, not the checkpoint
    const calls = vi.mocked(setOffset).mock.calls;
    const checkpointCalls = calls.filter(([, , , offset]) => offset === 500);

    expect(checkpointCalls).toHaveLength(0);
  });
});
