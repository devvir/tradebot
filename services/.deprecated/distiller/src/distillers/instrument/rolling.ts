import type { InstrumentItem } from '../../types';
import type { RollingState }   from './types';

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export function createRolling(): RollingState {
  return {
    window:             [],
    windowHead:         0,
    priceHistory:       [],
    priceHead:          0,
    volume24h:          0,
    turnover24h:        0,
    homeNotional24h:    0,
    foreignNotional24h: 0,
    totalVolume:        0,
    totalTurnover:      0,
    lastVwap:           undefined,
  };
}

/**
 * Apply a trade event to the rolling state. Mutates `state` in place.
 *
 * Trades are folded into per-minute aggregate bins (design §5.2) — the window
 * never stores individual trades, so its size is bounded by the window's minute
 * count no matter the trade volume. Returns only the trade-event-driven
 * instrument fields — the 24h stats block (volume24h, turnover24h,
 * homeNotional24h, foreignNotional24h, prevPrice24h, vwap) is emitted separately
 * on the minute-cron cadence via `computeMinuteBlock`, matching real BitMEX
 * output.
 */
export function addTrade(
  state:           RollingState,
  ms:              number,
  size:            number,
  price:           number,
  grossValue:      number,
  homeNotional:    number,
  foreignNotional: number,
  tickDirection:   string,
): Partial<InstrumentItem> {
  evictWindow(state, ms);

  binTrade(state, ms, size, grossValue, homeNotional, foreignNotional);
  state.volume24h          += size;
  state.turnover24h        += grossValue;
  state.homeNotional24h    += homeNotional;
  state.foreignNotional24h += foreignNotional;

  evictPriceHistory(state, ms);

  const prevPrice24h = olderPrice(state, ms);

  binPrice(state, ms, price);

  state.totalVolume   += size;
  state.totalTurnover += grossValue;

  const result: Partial<InstrumentItem> = {
    lastPrice:         price,
    lastTickDirection: tickDirection,
  };

  if (prevPrice24h !== undefined)
    result.lastChangePcnt = (price - prevPrice24h) / prevPrice24h;

  return result;
}

/**
 * Compute the 24h stats block emitted on BitMEX's minute-cron cadence
 * (`HH:MM:15` every minute). Evicts any stale entries from the rolling
 * window/price history based on `ms` before reading the running sums —
 * important for long idle gaps where no trades have evicted them yet.
 *
 * `vwap` is only included when it differs from the last emitted value.
 */
export function computeMinuteBlock(state: RollingState, ms: number): Partial<InstrumentItem> {
  evictWindow(state, ms);
  evictPriceHistory(state, ms);

  const result: Partial<InstrumentItem> = {
    volume24h:          state.volume24h,
    turnover24h:        state.turnover24h,
    homeNotional24h:    state.homeNotional24h,
    foreignNotional24h: state.foreignNotional24h,
  };

  const prev = olderPrice(state, ms);

  if (prev !== undefined) result.prevPrice24h = prev;

  if (state.homeNotional24h > 0) {
    const vwap = state.foreignNotional24h / state.homeNotional24h;

    if (vwap !== state.lastVwap) {
      result.vwap    = vwap;
      state.lastVwap = vwap;
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

const WINDOW_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Evicted-head slots tolerated before the array is compacted in one slice. */
const COMPACT_AT = 1_024;

/**
 * Fold one trade into its minute bin. The tail bin is the common case; a
 * few-minutes-late trade walks back to its own bin (data-prepare's disorder
 * bound), and a brand-new minute pushes. Bins stay time-ordered.
 */
function binTrade(
  state:           RollingState,
  ms:              number,
  size:            number,
  grossValue:      number,
  homeNotional:    number,
  foreignNotional: number,
): void {
  const binMs = ms - (ms % MINUTE_MS);
  const w     = state.window;

  let i = w.length - 1;

  while (i >= state.windowHead && w[i]!.ms > binMs) i--;

  if (i >= state.windowHead && w[i]!.ms === binMs) {
    const bin = w[i]!;

    bin.size            += size;
    bin.grossValue      += grossValue;
    bin.homeNotional    += homeNotional;
    bin.foreignNotional += foreignNotional;
  } else {
    const bin = { ms: binMs, size, grossValue, homeNotional, foreignNotional };

    if (i === w.length - 1) {
      w.push(bin);
    } else {
      w.splice(i + 1, 0, bin);
    }
  }
}

/**
 * Record one trade's price as its minute's last price (exact `ms` kept). One
 * point per minute — the design's accepted resolution for `prevPrice24h`.
 */
function binPrice(state: RollingState, ms: number, price: number): void {
  const binMs = ms - (ms % MINUTE_MS);
  const p     = state.priceHistory;

  let i = p.length - 1;

  while (i >= state.priceHead && p[i]!.ms - (p[i]!.ms % MINUTE_MS) > binMs) i--;

  if (i >= state.priceHead && p[i]!.ms - (p[i]!.ms % MINUTE_MS) === binMs) {
    const point = p[i]!;

    if (ms >= point.ms) {
      point.ms    = ms;
      point.price = price;
    }
  } else if (i === p.length - 1) {
    p.push({ ms, price });
  } else {
    p.splice(i + 1, 0, { ms, price });
  }
}

/**
 * Drop window bins whose whole minute lies before the 24h cutoff, subtracting
 * them from the running sums. Advances the head index — never `shift()` — and
 * compacts the array in one `slice` once enough dead slots accumulate.
 */
function evictWindow(state: RollingState, ms: number): void {
  const cutoff = ms - WINDOW_MS;
  const w      = state.window;

  let h = state.windowHead;

  while (h < w.length && w[h]!.ms + MINUTE_MS <= cutoff) {
    const e = w[h]!;

    state.volume24h          -= e.size;
    state.turnover24h        -= e.grossValue;
    state.homeNotional24h    -= e.homeNotional;
    state.foreignNotional24h -= e.foreignNotional;
    h++;
  }

  state.windowHead = h;

  if (h === w.length) {
    state.window     = [];
    state.windowHead = 0;
  } else if (h >= COMPACT_AT) {
    state.window     = w.slice(h);
    state.windowHead = 0;
  }
}

/**
 * Keep at most one priceHistory point at or before the 24h cutoff, so
 * `olderPrice` can always look up `prevPrice24h` for near-future events.
 * Head-index walk plus periodic compaction, like `evictWindow`.
 */
function evictPriceHistory(state: RollingState, ms: number): void {
  const cutoff = ms - WINDOW_MS;
  const p      = state.priceHistory;

  let h = state.priceHead;

  while (h + 1 < p.length && p[h + 1]!.ms <= cutoff) h++;

  state.priceHead = h;

  if (h >= COMPACT_AT) {
    state.priceHistory = p.slice(h);
    state.priceHead    = 0;
  }
}

/** Price of the most recent recorded point at or before `ms - 24h`, if any. */
function olderPrice(state: RollingState, ms: number): number | undefined {
  const cutoff = ms - WINDOW_MS;
  const p      = state.priceHistory;

  if (state.priceHead < p.length && p[state.priceHead]!.ms <= cutoff)
    return p[state.priceHead]!.price;

  return undefined;
}
