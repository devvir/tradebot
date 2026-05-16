import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RedisClient } from '@devvir/service-kit';
import type { RabbitMQ } from '@devvir/service-kit';
import { _test_processNextBatch as processNextBatch } from '../src/loop';
import type { Config } from '../src/types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../src/vault', () => ({
  listTables:     vi.fn(),
  listFiles:      vi.fn(),
  readFileGroups: vi.fn(),
}));

vi.mock('../src/progress', () => ({
  readProgress: vi.fn().mockResolvedValue({ state: 'pending', startFrom: 0 }),
}));

vi.mock('../src/metrics', () => ({
  recordPublish: vi.fn(),
}));

import { listTables, listFiles, readFileGroups } from '../src/vault';
import { readProgress } from '../src/progress';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
  vaultUrl:        'http://vault',
  tables:          [],
  waitIf:          {},
  fileConcurrency: 6,
  readBufferHigh:  5_000,
  readBufferLow:   2_500,
  ...overrides,
});

const makeExchange = () => ({
  publish: vi.fn().mockResolvedValue(undefined),
});

const makeBroker = (exchange = makeExchange()) => ({
  getExchange: vi.fn(() => exchange),
} as unknown as RabbitMQ.Broker);

/**
 * Builds an array of N brokers all backed by the same exchange mock, so
 * `exchange.publish.mock.calls` aggregates calls from every worker.
 */
const makeBrokers = (count: number, exchange = makeExchange()): RabbitMQ.Broker[] =>
  Array.from({ length: count }, () => makeBroker(exchange));

const makeRedis = () => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
} as unknown as RedisClient);

// Simulates a vault file with N raw NDJSON lines
const makeReadFileGroups = (rowCount: number) =>
  vi.fn().mockImplementation(async (
    _url: string,
    _table: string,
    _date: string,
    onGroup: (line: string, index: number) => Promise<void>,
    startFrom: number = 0,
  ) => {
    for (let i = startFrom; i < rowCount; i++) {
      await onGroup(`{"id":${i}}`, i);
    }
    return rowCount;
  });

// ── processNextBatch — discovery & filtering ──────────────────────────────────

describe('processNextBatch — discovery & filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readProgress).mockResolvedValue({ state: 'pending', startFrom: 0 });
    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(1));
  });

  it('skips tables where listFiles returns null', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade', 'unknown']);
    vi.mocked(listFiles).mockImplementation(async (_url, table) => {
      if (table === 'trade') return { '20240101': 'closed' };
      return null;
    });

    await processNextBatch(makeConfig(), makeBrokers(6), makeRedis(), new Set());

    const calls = vi.mocked(readFileGroups).mock.calls;

    expect(calls.every(([, table]) => table === 'trade')).toBe(true);
  });

  it('only processes tables in the filter list when filter is non-empty', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade', 'quote', 'orderBookL2']);
    vi.mocked(listFiles).mockResolvedValue({ '20240101': 'closed' });

    await processNextBatch(makeConfig({ tables: ['trade', 'quote'] }), makeBrokers(6), makeRedis(), new Set());

    const tables = vi.mocked(readFileGroups).mock.calls.map(([, table]) => table);

    expect(tables).not.toContain('orderBookL2');
    expect(tables).toContain('trade');
    expect(tables).toContain('quote');
  });

  it('processes all tables when filter is empty', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade', 'quote', 'orderBookL2']);
    vi.mocked(listFiles).mockResolvedValue({ '20240101': 'closed' });

    await processNextBatch(makeConfig(), makeBrokers(6), makeRedis(), new Set());

    const tables = vi.mocked(readFileGroups).mock.calls.map(([, table]) => table);

    expect(tables).toContain('trade');
    expect(tables).toContain('quote');
    expect(tables).toContain('orderBookL2');
  });

  it('skips files where readProgress returns done', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade']);
    vi.mocked(listFiles).mockResolvedValue({ '20240101': 'closed' });
    vi.mocked(readProgress).mockResolvedValue({ state: 'done' });

    await processNextBatch(makeConfig(), makeBrokers(6), makeRedis(), new Set());

    expect(readFileGroups).not.toHaveBeenCalled();
  });

  it('skips files already completed in this run', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade']);
    vi.mocked(listFiles).mockResolvedValue({ '20240101': 'closed' });

    const completed = new Set(['trade:20240101']);

    await processNextBatch(makeConfig(), makeBrokers(6), makeRedis(), completed);

    expect(readFileGroups).not.toHaveBeenCalled();
  });
});

// ── processNextBatch — independence across files ──────────────────────────────

describe('processNextBatch — file independence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readProgress).mockResolvedValue({ state: 'pending', startFrom: 0 });
  });

  it('processes every not-done file in a single call (no per-date barrier)', async () => {
    vi.mocked(listTables).mockResolvedValue(['trade', 'quote']);
    vi.mocked(listFiles).mockImplementation(async (_url, table) => {
      if (table === 'trade') return { '20240101': 'closed', '20240102': 'closed' };
      if (table === 'quote') return { '20240101': 'closed', '20240102': 'closed' };
      return null;
    });
    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(1));

    await processNextBatch(makeConfig(), makeBrokers(6), makeRedis(), new Set());

    // All four files should be processed in the same cycle.
    const calls = vi.mocked(readFileGroups).mock.calls.map(([, t, d]) => `${t}:${d}`).sort();

    expect(calls).toEqual([
      'quote:20240101',
      'quote:20240102',
      'trade:20240101',
      'trade:20240102',
    ]);
  });
});

// ── processFile — per-message publish ─────────────────────────────────────────

describe('processFile — per-message publish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readProgress).mockResolvedValue({ state: 'pending', startFrom: 0 });
    vi.mocked(listTables).mockResolvedValue(['trade']);
    vi.mocked(listFiles).mockResolvedValue({ '20240101': 'closed' });
  });

  it('calls publish once per message plus one control message', async () => {
    const ROW_COUNT = 300;

    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(ROW_COUNT));
    const exchange = makeExchange();

    await processNextBatch(makeConfig(), makeBrokers(6, exchange), makeRedis(), new Set());

    expect(exchange.publish).toHaveBeenCalledTimes(ROW_COUNT + 1);
  });

  it('publishes all messages regardless of count', async () => {
    const ROW_COUNT = 750;  // > one window of 500

    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(ROW_COUNT));
    const exchange = makeExchange();

    await processNextBatch(makeConfig(), makeBrokers(6, exchange), makeRedis(), new Set());

    expect(exchange.publish).toHaveBeenCalledTimes(ROW_COUNT + 1);
  });

  it('publishes data messages with persistent: false', async () => {
    const exchange = makeExchange();

    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(5));

    await processNextBatch(makeConfig(), makeBrokers(6, exchange), makeRedis(), new Set());

    const dataCalls = exchange.publish.mock.calls.filter(([, rk]) => rk !== 'control');

    for (const call of dataCalls) {
      const opts = call[2] as { persistent?: boolean };

      expect(opts.persistent).toBe(false);
    }
  });

  it('publishes the control message with the broker default (persistent)', async () => {
    const exchange = makeExchange();

    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(5));

    await processNextBatch(makeConfig(), makeBrokers(6, exchange), makeRedis(), new Set());

    const controlCall = exchange.publish.mock.calls.find(([, rk]) => rk === 'control')!;
    const opts        = controlCall[2] as { persistent?: boolean } | undefined;

    // No options passed → broker default (persistent: true) applies.
    expect(opts?.persistent).toBeUndefined();
  });

  it('publishes items in order within a single file', async () => {
    const ROW_COUNT = 1_000;
    const exchange  = makeExchange();

    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(ROW_COUNT));

    await processNextBatch(makeConfig(), makeBrokers(6, exchange), makeRedis(), new Set());

    const dataCalls = exchange.publish.mock.calls.filter(([, rk]) => rk !== 'control');
    const indices   = dataCalls.map(([, , opts]) => (opts as { headers: { 'x-msg-index': number } }).headers['x-msg-index']);

    expect(indices).toEqual(indices.slice().sort((a, b) => a - b));
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(ROW_COUNT - 1);
  });
});

// ── processFile — resume from registrar's offset ──────────────────────────────

describe('processFile — resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTables).mockResolvedValue(['trade']);
    vi.mocked(listFiles).mockResolvedValue({ '20240101': 'closed' });
    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(0));
  });

  it('passes readProgress.startFrom as the vault skip offset', async () => {
    vi.mocked(readProgress).mockResolvedValue({ state: 'pending', startFrom: 500 });

    await processNextBatch(makeConfig(), makeBrokers(6), makeRedis(), new Set());

    expect(readFileGroups).toHaveBeenCalledWith(
      expect.anything(), 'trade', '20240101', expect.anything(), 500,
    );
  });
});

// ── processFile — control message ─────────────────────────────────────────────

describe('processFile — control message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readProgress).mockResolvedValue({ state: 'pending', startFrom: 0 });
    vi.mocked(listTables).mockResolvedValue(['trade']);
    vi.mocked(listFiles).mockResolvedValue({ '20240101': 'closed' });
  });

  it('publishes a complete control message after data, with highestIndex = totalGroups - 1', async () => {
    const ROW_COUNT = 10;
    const exchange  = makeExchange();

    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(ROW_COUNT));

    await processNextBatch(makeConfig(), makeBrokers(6, exchange), makeRedis(), new Set());

    const lastCall = exchange.publish.mock.calls[exchange.publish.mock.calls.length - 1]!;

    expect(lastCall[0]).toEqual({ type: 'complete', table: 'trade', date: '20240101', highestIndex: ROW_COUNT - 1 });
    expect(lastCall[1]).toBe('control');
  });

  it('sends highestIndex: -1 for an empty file', async () => {
    const exchange = makeExchange();

    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(0));

    await processNextBatch(makeConfig(), makeBrokers(6, exchange), makeRedis(), new Set());

    const controlCall = exchange.publish.mock.calls.find(([, rk]) => rk === 'control');

    expect(controlCall).toBeDefined();
    expect(controlCall![0]).toEqual({ type: 'complete', table: 'trade', date: '20240101', highestIndex: -1 });
  });

  it('adds successfully-published files to the in-memory completed set', async () => {
    vi.mocked(readFileGroups).mockImplementation(makeReadFileGroups(1));

    const completed = new Set<string>();

    await processNextBatch(makeConfig(), makeBrokers(6), makeRedis(), completed);

    expect(completed.has('trade:20240101')).toBe(true);
  });
});
