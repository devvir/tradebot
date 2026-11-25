import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Rows and messages go through the real write path (encode → buffer → close →
// gzip file) and back through the real read path (parse → decode), over a temp
// data directory.

let tmpDir: string;

vi.mock('../../src/fs/paths', () => {
  const dataDir    = () => tmpDir;
  const tableDir   = (table: string) => path.join(dataDir(), table);
  const yearDir    = (table: string, filename: string) => path.join(tableDir(table), filename.slice(0, 4));
  const openPath   = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz.tmp`);
  const closedPath = (table: string, filename: string) => path.join(yearDir(table, filename), `${filename}.csv.gz`);

  return { get DATA_DIR() { return dataDir(); }, tableDir, yearDir, openPath, closedPath };
});

vi.mock('../../src/fs/health', () => ({
  recordFailure:   vi.fn(),
  setBackpressure: vi.fn(),
}));

import { encode } from '../../src/data/encode';
import { buffers, _test_reset as resetBuffers } from '../../src/data/buffers';
import { closeBucket } from '../../src/data/close';
import { decodeFile } from '../../src/data/decode';
import { TABLE_HEADERS } from '../../src/data/headers';
import { _test_reset as resetBucket } from '../../src/data/bucket';
import { _test_reset as resetWriter } from '../../src/fs/writer';
import type { Row, WsMessage } from '../../src/data/types';

const FILENAME = '20240101';
const T0       = '2024-01-01T00:00:00.000Z';
const T1       = '2024-01-01T00:00:01.000Z';

/** Writes `items` as one sealed file and reads it back as parsed NDJSON values. */
const roundTrip = async (table: string, items: (Row | WsMessage)[]): Promise<unknown[]> => {
  for (const item of items) buffers.get(table, FILENAME).pushMany(encode(table, item));

  await closeBucket(table, FILENAME);

  const out: unknown[] = [];

  for await (const line of decodeFile(table, FILENAME)) out.push(JSON.parse(line));

  return out;
};

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vault-roundtrip-test-'));
  resetBuffers();
  resetBucket();
  resetWriter();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── One representative case per table ─────────────────────────────────────────

interface Case {
  items:    (Row | WsMessage)[];
  expected: unknown[];
}

const tradeBin: Case = {
  items: [{
    timestamp: T0, symbol: 'XBTUSD', open: 42000, high: 42100.5, low: 41900, close: 42050, trades: 12,
    volume: 3400, vwap: 42010.25, lastSize: 100, turnover: 8093000, homeNotional: 0.08, foreignNotional: 3400, pool: 'Primary',
  }],
  expected: [{
    timestamp: T0, symbol: 'XBTUSD', open: 42000, high: 42100.5, low: 41900, close: 42050, trades: 12,
    volume: 3400, vwap: 42010.25, lastSize: 100, turnover: 8093000, homeNotional: 0.08, foreignNotional: 3400, pool: 'Primary',
  }],
};

const quoteBin: Case = {
  items:    [{ timestamp: T0, symbol: 'XBTUSD', bidSize: 100, bidPrice: 42000, askPrice: 42000.5, askSize: 200 }],
  expected: [{ timestamp: T0, symbol: 'XBTUSD', bidSize: 100, bidPrice: 42000, askPrice: 42000.5, askSize: 200 }],
};

const CASES: Record<string, Case> = {
  funding: {
    items:    [{ timestamp: T0, symbol: 'XBTUSD', fundingInterval: '2000-01-01T08:00:00.000Z', fundingRate: 0.0001, fundingRateDaily: 0.0003 }],
    expected: [{ timestamp: T0, symbol: 'XBTUSD', fundingInterval: '2000-01-01T08:00:00.000Z', fundingRate: 0.0001, fundingRateDaily: 0.0003 }],
  },

  insurance: {
    items:    [{ currency: 'XBt', timestamp: T0, walletBalance: 123456789 }],
    expected: [{ currency: 'XBt', timestamp: T0, walletBalance: 123456789 }],
  },

  // A null value and a missing column both read back as an absent field.
  settlement: {
    items: [{
      timestamp: T0, symbol: 'XBTZ23', settlementType: 'Settlement', settledPrice: 42000.5,
      optionStrikePrice: null, bankrupt: 0, taxBase: 0, taxRate: 0,
    }],
    expected: [{ timestamp: T0, symbol: 'XBTZ23', settlementType: 'Settlement', settledPrice: 42000.5, bankrupt: 0, taxBase: 0, taxRate: 0 }],
  },

  compositeIndex: {
    items: [{
      timestamp: T0, symbol: '.BXBT', indexSymbol: '.BXBT', indexMultiplier: 1, reference: 'BSTP', lastPrice: 23000.5,
      sourcePrice: 23000.5, conversionIndex: '', conversionIndexPrice: 1, weight: 0.25, logged: T1,
    }],
    expected: [{
      timestamp: T0, symbol: '.BXBT', indexSymbol: '.BXBT', indexMultiplier: 1, reference: 'BSTP', lastPrice: 23000.5,
      sourcePrice: 23000.5, conversionIndexPrice: 1, weight: 0.25, logged: T1,
    }],
  },

  tick: {
    items:    [{ timestamp: T0, symbol: 'XBTUSD', price: 23000.5, tickDirection: 'PlusTick' }],
    expected: [{ timestamp: T0, symbol: 'XBTUSD', price: 23000.5, tickDirection: 'PlusTick' }],
  },

  // BitMEX archive timestamps use a `D` date/time separator and may carry no
  // zone; they read back as ISO 8601 UTC, every fractional digit kept.
  trade: {
    items: [{
      timestamp: '2024-01-01D00:00:01.123456789', symbol: 'XBTUSD', side: 'Buy', size: 100, price: 42000.5,
      tickDirection: 'ZeroPlusTick', trdMatchID: '00000000-0000-0000-0000-000000000001', grossValue: 238095,
      homeNotional: 0.00238095, foreignNotional: 100, trdType: 'Regular', pool: 'Primary',
    }],
    expected: [{
      timestamp: '2024-01-01T00:00:01.123456789Z', symbol: 'XBTUSD', side: 'Buy', size: 100, price: 42000.5,
      tickDirection: 'ZeroPlusTick', trdMatchID: '00000000-0000-0000-0000-000000000001', grossValue: 238095,
      homeNotional: 0.00238095, foreignNotional: 100, trdType: 'Regular', pool: 'Primary',
    }],
  },

  quote: {
    items:    [{ timestamp: T0, symbol: 'XBTUSD', bidSize: 100, bidPrice: 42000, askPrice: 42000.5, askSize: 200, pool: 'Secondary' }],
    expected: [{ timestamp: T0, symbol: 'XBTUSD', bidSize: 100, bidPrice: 42000, askPrice: 42000.5, askSize: 200, pool: 'Secondary' }],
  },

  tradeBin1m: tradeBin, tradeBin5m: tradeBin, tradeBin1h: tradeBin, tradeBin1d: tradeBin,
  quoteBin1m: quoteBin, quoteBin5m: quoteBin, quoteBin1h: quoteBin, quoteBin1d: quoteBin,

  announcement: {
    items: [{
      action: 'partial', date: T0,
      data:   [{ id: 48713, link: 'https://example.com/a', title: 'Now Live: A, B', content: '<p>one</p>\n<p>"two"</p>', date: T0 }],
    }],
    expected: [{
      action: 'partial', date: T0,
      data:   [{ id: 48713, link: 'https://example.com/a', title: 'Now Live: A, B', content: '<p>one</p>\n<p>"two"</p>', date: T0 }],
    }],
  },

  // Free text with a comma, a quote and a line break; object fields as JSON.
  chat: {
    items: [{
      action: 'insert', date: T0,
      data:   [{ date: T0, id: 7, message: 'hi, "all"\nok', user: 'alice', flair: { tier: 1 }, guild: { name: 'A&B' } }],
    }],
    expected: [{
      action: 'insert', date: T0,
      data:   [{ date: T0, id: 7, message: 'hi, "all"\nok', user: 'alice', flair: { tier: 1 }, guild: { name: 'A&B' } }],
    }],
  },

  connected: {
    items:    [{ action: 'partial', date: T0, data: [{ users: 100, bots: 5 }] }],
    expected: [{ action: 'partial', date: T0, data: [{ users: 100, bots: 5 }] }],
  },

  // A continuation row, numbers and booleans.
  instrument: {
    items: [{
      action: 'update', date: T0,
      data:   [
        { symbol: 'XBTUSD', lastPrice: 23000.5, isInverse: true, hasLiquidity: false, fairMethod: 'FundingRate', timestamp: T0 },
        { symbol: 'ETHUSD', markPrice: 1600.25, timestamp: T0 },
      ],
    }],
    expected: [{
      action: 'update', date: T0,
      data:   [
        { symbol: 'XBTUSD', lastPrice: 23000.5, isInverse: true, hasLiquidity: false, fairMethod: 'FundingRate', timestamp: T0 },
        { symbol: 'ETHUSD', markPrice: 1600.25, timestamp: T0 },
      ],
    }],
  },

  liquidation: {
    items: [
      { action: 'insert', date: T0, data: [{ orderID: 'o1', symbol: 'XBTUSD', side: 'Sell', price: 41000, leavesQty: 500 }] },
      { action: 'delete', date: T1, data: [{ orderID: 'o1', symbol: 'XBTUSD' }] },
    ],
    expected: [
      { action: 'insert', date: T0, data: [{ orderID: 'o1', symbol: 'XBTUSD', side: 'Sell', price: 41000, leavesQty: 500 }] },
      { action: 'delete', date: T1, data: [{ orderID: 'o1', symbol: 'XBTUSD' }] },
    ],
  },

  // A message with `data: []` survives as a message with no rows.
  orderBookL2: {
    items: [
      { action: 'partial', date: T0, data: [] },
      {
        action: 'update', date: T1,
        data:   [
          { symbol: 'XBTUSD', id: 8799000000, side: 'Buy', size: 100, price: 42000, transactTime: T1, timestamp: T1, pool: 'Primary' },
          { symbol: 'XBTUSD', id: 8799000050, side: 'Sell', size: 0, price: 42000.5, transactTime: T1, timestamp: T1, pool: 'Primary' },
        ],
      },
    ],
    expected: [
      { action: 'partial', date: T0, data: [] },
      {
        action: 'update', date: T1,
        data:   [
          { symbol: 'XBTUSD', id: 8799000000, side: 'Buy', size: 100, price: 42000, transactTime: T1, timestamp: T1, pool: 'Primary' },
          { symbol: 'XBTUSD', id: 8799000050, side: 'Sell', size: 0, price: 42000.5, transactTime: T1, timestamp: T1, pool: 'Primary' },
        ],
      },
    ],
  },

  // An empty string reads back as an absent field; `false` stays a boolean.
  publicNotifications: {
    items: [{
      action: 'insert', date: T0,
      data:   [{ title: 'Maintenance, soon', body: '"Planned"\nwindow', ttl: 60000, closable: true, persist: false, sound: '' }],
    }],
    expected: [{
      action: 'insert', date: T0,
      data:   [{ title: 'Maintenance, soon', body: '"Planned"\nwindow', ttl: 60000, closable: true, persist: false }],
    }],
  },
};

describe('encode → file → decode round trip', () => {
  it('has a case for every table with a header definition', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(TABLE_HEADERS).sort());
  });

  for (const [table, { items, expected }] of Object.entries(CASES)) {
    it(table, async () => {
      expect(await roundTrip(table, items)).toEqual(expected);
    });
  }

  it('reads a pseudo-table like its base table', async () => {
    const row = { timestamp: T0, symbol: 'XBTUSD', bidSize: 100, bidPrice: 42000, askPrice: 42000.5, askSize: 200, pool: 'Secondary' };

    expect(await roundTrip('quote.secondary', [row])).toEqual([row]);
  });

  it('keeps a data row\'s own _date_ and _action_ keys from opening a new message', async () => {
    const out = await roundTrip('liquidation', [{
      action: 'insert', date: T0,
      data:   [
        { orderID: 'o1', symbol: 'XBTUSD' },
        { orderID: 'o2', symbol: 'XBTUSD', _date_: T1, _action_: 'delete' },
      ],
    }]);

    expect(out).toEqual([{
      action: 'insert', date: T0,
      data:   [{ orderID: 'o1', symbol: 'XBTUSD' }, { orderID: 'o2', symbol: 'XBTUSD' }],
    }]);
  });
});
