import type { Candle, Timeframe, ViewportState } from './types';
import { BIN_MS } from './types';
import { useClosedCandles } from './useClosedCandles';
import { useRunningCandle } from './useRunningCandle';
import { useSymbol } from '../../utils/useSymbol';

/**
 * Combines the closed-candle buffer with the running candle.
 *
 *   closed     — committed history, fed by REST + tradeBin WS
 *   running    — the currently-open bin, fed by the trade WS, seeded from
 *                the newest closed candle for OHLC continuity
 *   liveTailMs — the newest bin the venue has closed (see useClosedCandles)
 *
 * Closed and running are exposed separately so callers (e.g. viewport slicing) can
 * decide whether the running candle is relevant in a given mode.
 */
export function useChartCandles(
  timeframe: Timeframe,
  viewport:  ViewportState,
): { closed: Candle[]; running: Candle | null; liveTailMs: number | null } {
  const symbol = useSymbol();

  const { candles: closed, liveTailMs } = useClosedCandles(symbol, timeframe, viewport);
  const seed    = closed.length > 0 ? closed[closed.length - 1] : null;
  const running = useRunningCandle(symbol, seed, BIN_MS[timeframe]);

  return { closed, running, liveTailMs };
}
