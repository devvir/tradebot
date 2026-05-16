import type { InstrumentItem } from '../../types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface RollingState {
  window:       { ms: number; size: number; grossValue: number; homeNotional: number; foreignNotional: number }[];
  priceHistory: { ms: number; price: number }[];

  /** Running sums over `window` — maintained on every push/shift, O(1) per trade. */
  volume24h:          number;
  turnover24h:        number;
  homeNotional24h:    number;
  foreignNotional24h: number;

  totalVolume:   number;
  totalTurnover: number;

  /** Last vwap emitted on a minute-cron tick; used for change detection. */
  lastVwap: number | undefined;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export function createRolling(): RollingState {
  return {
    window:             [],
    priceHistory:       [],
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
 * Returns only the trade-event-driven instrument fields — the 24h stats block
 * (volume24h, turnover24h, homeNotional24h, foreignNotional24h, prevPrice24h,
 * vwap) is emitted separately on the minute-cron cadence via `computeMinuteBlock`,
 * matching real BitMEX output.
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

  state.window.push({ ms, size, grossValue, homeNotional, foreignNotional });
  state.volume24h          += size;
  state.turnover24h        += grossValue;
  state.homeNotional24h    += homeNotional;
  state.foreignNotional24h += foreignNotional;

  evictPriceHistory(state, ms);

  const prevPrice24h = olderPrice(state, ms);

  state.priceHistory.push({ ms, price });

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

/** Drop window entries older than 24h, subtracting them from the running sums. */
function evictWindow(state: RollingState, ms: number): void {
  const cutoff = ms - WINDOW_MS;

  while (state.window.length > 0 && state.window[0]!.ms < cutoff) {
    const e = state.window.shift()!;

    state.volume24h          -= e.size;
    state.turnover24h        -= e.grossValue;
    state.homeNotional24h    -= e.homeNotional;
    state.foreignNotional24h -= e.foreignNotional;
  }
}

/**
 * Keep at most one priceHistory entry at or before the 24h cutoff, so
 * `olderPrice` can always look up `prevPrice24h` for near-future events.
 */
function evictPriceHistory(state: RollingState, ms: number): void {
  const cutoff = ms - WINDOW_MS;

  while (state.priceHistory.length > 1 && state.priceHistory[1]!.ms <= cutoff) {
    state.priceHistory.shift();
  }
}

/** Price of the most recent trade at or before `ms - 24h`, if any. */
function olderPrice(state: RollingState, ms: number): number | undefined {
  const cutoff = ms - WINDOW_MS;

  if (state.priceHistory.length > 0 && state.priceHistory[0]!.ms <= cutoff)
    return state.priceHistory[0]!.price;

  return undefined;
}

const WINDOW_MS = 86_400_000;
