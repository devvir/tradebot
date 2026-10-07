import type { Field, Table } from '../types';

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

/** `ts` is first everywhere: it is the sort key and the one universal column. */
const TS: Field = { name: 'ts', type: 'BIGINT' };

/**
 * Whether a contract is `linear` (settles in its USD-like quote) or `inverse`
 * (settles in the coin), NULL on spot.
 *
 * Carried on every table whose numbers mean something different on the two:
 * a coin-margined trade's size is a contract count and its other leg is the
 * coin, a linear one's is base and quote. A constant per file — stocker knows it
 * per instrument, not per row — so it is the last column, filled when each
 * instrument's file is written rather than by the projection.
 */
export const MARGIN: Field = { name: 'margin', type: 'VARCHAR' };

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
    MARGIN,
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
    MARGIN,
  ],

  quotes: [
    TS,
    { name: 'bidPrice', type: 'DOUBLE' },
    { name: 'bidSize',  type: 'DOUBLE' },
    { name: 'askPrice', type: 'DOUBLE' },
    { name: 'askSize',  type: 'DOUBLE' },
    MARGIN,
  ],

  /**
   * A book published as an image and the changes since: an event log, one row a
   * level change, which is the shape OKX, HTX, Bybit and Gate publish. Not
   * reconstructed books — rebuilding one at an instant is the consumer's job,
   * since the depth it needs is its decision. A book published whole at each
   * tick is another kind of data, and `orderBookSnapshot`.
   */
  orderBook: [
    TS,
    { name: 'action',     type: 'VARCHAR' },
    { name: 'side',       type: 'VARCHAR' },
    { name: 'price',      type: 'DOUBLE'  },
    { name: 'size',       type: 'DOUBLE'  },
    { name: 'orderCount', type: 'BIGINT'  },
    { name: 'sequence',   type: 'BIGINT'  },
    MARGIN,
  ],

  /**
   * A book published whole at each tick: one row a message, each side a list of
   * `[price, size]` in the venue's own order. A different kind of data from a
   * book published as an image and the changes since, which is `orderBook` — a
   * tick stands alone and says nothing of what happened between it and the
   * next, so there are no changes to log, only images to keep.
   *
   * Kept as the venue sends it rather than cut into a row a level: a tick is
   * read whole, and stored whole it is what was published, at about the size
   * it was published at.
   */
  orderBookSnapshot: [
    TS,
    { name: 'asks',     type: 'DOUBLE[][]' },
    { name: 'bids',     type: 'DOUBLE[][]' },
    { name: 'sequence', type: 'BIGINT'     },
    MARGIN,
  ],

  /** A book summed into bands either side of the mid: the size and the notional within each ±%. Not its levels. */
  orderBookBands: [
    TS,
    { name: 'percentage', type: 'DOUBLE' },
    { name: 'depth',      type: 'DOUBLE' },
    { name: 'notional',   type: 'DOUBLE' },
    MARGIN,
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
   * An index of implied volatility — Binance's BVOL. A level, not a price of
   * anything that trades, which is why it is not `indexPrice`.
   */
  volatilityIndex: [TS, { name: 'value', type: 'DOUBLE' }],

  /**
   * An option's mark price as bars, with the greeks the venue computed for the
   * bar. Apart from `markPrice` because the greeks belong to options alone and
   * every other market's mark price would carry four empty columns.
   *
   * **The instrument of an option table is the underlying, and `option` names
   * the contract.** A venue lists thousands of contracts a month and each lives
   * days, so a file per contract would be tens of thousands of files of a few
   * rows; every venue's own files are an underlying's, or a whole market's.
   */
  optionMarkPrice: [TS,
    { name: 'option', type: 'VARCHAR' },
    { name: 'open',  type: 'DOUBLE' }, { name: 'high',  type: 'DOUBLE' },
    { name: 'low',   type: 'DOUBLE' }, { name: 'close', type: 'DOUBLE' },
    { name: 'delta', type: 'DOUBLE' }, { name: 'gamma', type: 'DOUBLE' },
    { name: 'vega',  type: 'DOUBLE' }, { name: 'theta', type: 'DOUBLE' }],

  /**
   * The state of an option at a moment, or summed over a bar: what it trades
   * at, what it is quoted at, what the venue marks it at, the implied
   * volatility behind each of those, the greeks and the open interest.
   *
   * A tick fills the quote, the mark and the greeks; a bar adds what traded in
   * it — OHLC and both volumes are of **trades**, never of the mark. Sizes and
   * volumes are in contracts, as every venue publishes them. `option` names the
   * contract, the instrument being its underlying — see `optionMarkPrice`.
   */
  optionTicker: [TS,
    { name: 'option', type: 'VARCHAR' },
    { name: 'open',  type: 'DOUBLE' }, { name: 'high',  type: 'DOUBLE' },
    { name: 'low',   type: 'DOUBLE' }, { name: 'close', type: 'DOUBLE' },
    { name: 'volume',      type: 'DOUBLE' },
    { name: 'quoteVolume', type: 'DOUBLE' },
    { name: 'bidPrice', type: 'DOUBLE' }, { name: 'bidSize', type: 'DOUBLE' }, { name: 'bidIv', type: 'DOUBLE' },
    { name: 'askPrice', type: 'DOUBLE' }, { name: 'askSize', type: 'DOUBLE' }, { name: 'askIv', type: 'DOUBLE' },
    { name: 'markPrice', type: 'DOUBLE' }, { name: 'markIv', type: 'DOUBLE' },
    { name: 'delta', type: 'DOUBLE' }, { name: 'gamma', type: 'DOUBLE' },
    { name: 'vega',  type: 'DOUBLE' }, { name: 'theta', type: 'DOUBLE' },
    { name: 'openInterest',      type: 'DOUBLE' },
    { name: 'openInterestValue', type: 'DOUBLE' }],

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
    MARGIN,
  ],

  liquidations: [
    TS,
    { name: 'side',        type: 'VARCHAR' },
    { name: 'price',       type: 'DOUBLE'  },
    { name: 'size',        type: 'DOUBLE'  },
    { name: 'averagePrice', type: 'DOUBLE' },
    { name: 'status',      type: 'VARCHAR' },
    MARGIN,
  ],

  settlement: [TS, { name: 'price', type: 'DOUBLE' }],
};

/**
 * The name a table's files are kept under, where that is not its own: a book's
 * kinds are a table each — a schema each — of one dataset, told apart in the
 * vault by the `kind=` level its variant gives, as in the catalog.
 */
export const rootOf = (table: Table): string => ROOTS[table] ?? table;

const ROOTS: Partial<Record<Table, string>> = { orderBookSnapshot: 'orderBook', orderBookBands: 'orderBook' };

export const fieldsOf = (table: Table): Field[] => {
  const fields = TABLES[table];

  if (! fields) throw new Error(`No canonical schema for table '${table}'`);

  return fields;
};
