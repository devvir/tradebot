import type { Margin, Market } from '../types';

/**
 * Whether an instrument is linear or inverse, from the venue's symbol.
 *
 * **A stopgap, written down as one.** Margining belongs in instrument metadata —
 * each venue's own listing says what a contract settles in — and that metadata
 * does not exist yet. Until it does, each venue's spelling is read here, and
 * only here: one rule per venue, written from every perpetual and future symbol
 * the catalog held on 2026-10-04.
 *
 * A symbol no rule calls inverse is linear: every venue's default contract is
 * USDT- or USDC-margined, and the coin-margined ones are the spelled-out
 * exception. Spot and options have no margining, and get null.
 */
export const marginOf = (venue: string, market: Market, symbol: string): Margin | null => {
  if (market !== 'perp' && market !== 'future') return null;

  const inverse = INVERSE[venue];

  return inverse?.test(symbol) ? 'inverse' : 'linear';
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** A futures month code: `Z26`, `H25`. */
const EXPIRY = '[FGHJKMNQUVXZ]\\d{2}';

const INVERSE: Record<string, RegExp> = {
  /** `BTCUSD_PERP`, `BTCUSD_230331` — linear ones are `BTCUSDT`, `BTCUSDT_230630`. */
  binance: /USD_/,

  /** `BTCUSD`, `BTCUSDZ22` — linear ones end `USDT`, or `PERP` for USDC. */
  bybit: new RegExp(`USD(${EXPIRY})?$`),

  /** `BTC_USD`, `BTC_USD_20240329` — linear ones are `BTC_USDT`. */
  gate: /_USD(_\d{8})?$/,

  /** `XBTUSDM` — linear ones end `USDTM` or `USDCM`. */
  kucoin: /USDM$/,

  /**
   * `BTC-USD`, `BTC-USD-SWAP`, `BTC-USD-250328`. `BTC-USD_UM` is USD-margined,
   * which is to say linear, despite the `USD` in it.
   */
  okx: /^[^-]+-USD(-|$)/,

  /** `BTC-USD`, `BTC-USD-260529` — linear ones are `BTC-USDT`. */
  htx: /^[^-]+-USD(-|$)/,

  /**
   * `BTCUSD`, `BTCUSD_CM`, and the coin-margined deliveries `BTCCMZ26` and
   * `BTCUSDH26`. Linear ones end `USDT`, `USDC` or `PERP`.
   */
  bitget: new RegExp(`(USD(_CM)?|CM${EXPIRY}|USD${EXPIRY})$`),
};
