import type { Table } from '../types';

/**
 * The canonical schema of each table.
 *
 * Every series projects into exactly this column list, in this order, with NULL
 * wherever a venue does not publish a field. That is what makes the table one
 * dataset rather than a pile of venue-shaped files: a reader gets the same
 * columns whether the rows came from Binance or Gate, and Parquet gets one
 * stable schema it can append to.
 *
 * A field only earns a place here if more than one venue publishes it, or if it
 * is meaningless to lose. Anything venue-specific stays out — normalise
 * structure, never semantics.
 */
export interface Field {
  name: string;
  type: 'BIGINT' | 'DOUBLE' | 'VARCHAR' | 'BOOLEAN';
}

/** `ts` is first everywhere: it is the sort key and the one universal column. */
const TS: Field = { name: 'ts', type: 'BIGINT' };

export const TABLES: Record<Table, Field[]> = {
  trades: [
    TS,
    { name: 'tradeId',    type: 'VARCHAR' },
    { name: 'price',      type: 'DOUBLE'  },

    /**
     * Size **as the venue publishes it**, and its unit is the venue's business:
     * base units on spot everywhere, contracts on OKX swaps, KuCoin and HTX
     * futures, and Binance coin-margined futures. Converting would need a
     * contract multiplier that is in none of these files.
     *
     * `baseSize` and `quoteSize` are filled only where a venue publishes both
     * legs itself, so a reader can tell a converted number from an absent one.
     */
    { name: 'size',       type: 'DOUBLE'  },
    { name: 'baseSize',   type: 'DOUBLE'  },
    { name: 'quoteSize',  type: 'DOUBLE'  },

    /**
     * The taker's side, always lowercase `buy`/`sell`. Venues disagree four ways
     * — `Buy`, `BUY`, `buy`, and Gate's `1`/`2` — and Binance publishes no side
     * at all, only whether the buyer was the maker. It is derived rather than
     * passed through so one column means one thing everywhere; `buyerMaker`
     * keeps Binance's original fact alongside it.
     */
    { name: 'side',       type: 'VARCHAR' },
    { name: 'buyerMaker', type: 'BOOLEAN' },
  ],

  klines: [
    TS,
    { name: 'open',           type: 'DOUBLE' },
    { name: 'high',           type: 'DOUBLE' },
    { name: 'low',            type: 'DOUBLE' },
    { name: 'close',          type: 'DOUBLE' },
    { name: 'volume',         type: 'DOUBLE' },

    /**
     * There is no `closeTime`. Binance publishes one and nothing else does, and
     * it is exactly `ts + interval − 1 tick` — 999,000 µs on a `1s` bar,
     * 3,599,999,000 µs on a `1h` one — so a bar whose start and width are both
     * known already states it. The tick it subtracts is not even stable: 1 ms
     * before Binance's 2025-01 precision change, 1 µs after, which is a venue
     * quirk rather than information.
     *
     * It fails both halves of the rule above, and carrying it cost more than
     * nothing: it was the one column in the schema whose unit was the venue's
     * rather than microseconds, so within one dataset early partitions held
     * milliseconds and later ones microseconds with nothing marking the line.
     */
    { name: 'quoteVolume',    type: 'DOUBLE' },
    { name: 'trades',         type: 'BIGINT' },
    { name: 'takerBuyVolume', type: 'DOUBLE' },
    { name: 'takerBuyQuote',  type: 'DOUBLE' },
  ],

  quotes: [
    TS,
    { name: 'bidPrice', type: 'DOUBLE' },
    { name: 'bidSize',  type: 'DOUBLE' },
    { name: 'askPrice', type: 'DOUBLE' },
    { name: 'askSize',  type: 'DOUBLE' },
  ],

  /**
   * An event log, not reconstructed books. One row per level change, which is
   * the shape OKX, HTX and Gate already publish and the degenerate case of
   * KuCoin's periodic snapshots. Rebuilding a book at an instant is the
   * consumer's job, since the depth it needs is its decision.
   */
  orderBook: [
    TS,
    { name: 'action',     type: 'VARCHAR' },
    { name: 'side',       type: 'VARCHAR' },
    { name: 'price',      type: 'DOUBLE'  },
    { name: 'size',       type: 'DOUBLE'  },
    { name: 'orderCount', type: 'BIGINT'  },
    { name: 'sequence',   type: 'BIGINT'  },
  ],

  /** Notional within ±% bands of the mid. A summary, not a book. */
  depthBands: [
    TS,
    { name: 'percentage', type: 'DOUBLE' },
    { name: 'depth',      type: 'DOUBLE' },
    { name: 'notional',   type: 'DOUBLE' },
  ],

  markPrice:    [TS, { name: 'price', type: 'DOUBLE' },
    { name: 'open', type: 'DOUBLE' }, { name: 'high', type: 'DOUBLE' },
    { name: 'low',  type: 'DOUBLE' }, { name: 'close', type: 'DOUBLE' }],

  indexPrice:   [TS, { name: 'price', type: 'DOUBLE' },
    { name: 'open', type: 'DOUBLE' }, { name: 'high', type: 'DOUBLE' },
    { name: 'low',  type: 'DOUBLE' }, { name: 'close', type: 'DOUBLE' }],

  premiumIndex: [TS,
    { name: 'open', type: 'DOUBLE' }, { name: 'high', type: 'DOUBLE' },
    { name: 'low',  type: 'DOUBLE' }, { name: 'close', type: 'DOUBLE' }],

  /**
   * What was actually applied and the running estimate for the next interval
   * are separated by the **`kind=` path level**, not by a column here — Gate
   * publishes both, and conflating them would invent a series neither venue
   * reports.
   *
   * It is a path attribute because it decides what a row *means*, the same way
   * an interval does for a kline: `rate` alone is not an answer without knowing
   * whether it was charged or forecast. A column could not have done the job —
   * both series then compute one partition id and overwrite each other, and a
   * filter on a plain column prunes no files.
   */
  funding: [
    TS,
    { name: 'rate',          type: 'DOUBLE' },
    { name: 'intervalHours', type: 'BIGINT' },
  ],

  borrowing: [TS, { name: 'currency', type: 'VARCHAR' }, { name: 'rate', type: 'DOUBLE' }],

  openInterest: [
    TS,
    { name: 'openInterest',      type: 'DOUBLE' },
    { name: 'openInterestValue', type: 'DOUBLE' },
    { name: 'longShortRatio',    type: 'DOUBLE' },
    { name: 'takerLongShortVol', type: 'DOUBLE' },
  ],

  liquidations: [
    TS,
    { name: 'side',        type: 'VARCHAR' },
    { name: 'price',       type: 'DOUBLE'  },
    { name: 'size',        type: 'DOUBLE'  },
    { name: 'averagePrice', type: 'DOUBLE' },
    { name: 'status',      type: 'VARCHAR' },
  ],

  settlement: [TS, { name: 'price', type: 'DOUBLE' }],
};

export const fieldsOf = (table: Table): Field[] => {
  const fields = TABLES[table];

  if (! fields) throw new Error(`No canonical schema for table '${table}'`);

  return fields;
};
