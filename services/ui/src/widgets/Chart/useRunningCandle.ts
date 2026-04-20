import { useEffect, useRef, useState } from 'react';
import { useBitmex } from '../../data/DataProvider';
import type { Trade } from '../../types';
import type { Candle } from './types';

/**
 * Mutable accumulator for the running bin.
 *
 * `timestamp` is the bin's CLOSE time, matching BitMEX's closed-candle
 * convention. `open` is seeded once from the seed candle's close (OHLC
 * continuity) and never changes. close/high/low/volume update from trades.
 */
interface Acc {
  timestamp: string;
  open:      number;
  close:     number;
  high:      number;
  low:       number;
  volume:    number;
}

/**
 * Builds the currently-open candle from the trade stream.
 *
 * The `seed` is the most-recent closed candle — it determines where the
 * running bin starts (`seed.close` = the new bin's open, for OHLC continuity)
 * and when it ends (`seed.timestamp + binMs`). Whenever the seed advances
 * (a new bin has closed elsewhere), the accumulator resets.
 *
 * Trades are accepted only within (binStart, binEnd]. Trades outside that
 * window belong to a neighboring bin and are skipped.
 *
 * State updates are throttled to animation-frame cadence so a busy trade
 * stream doesn't cause tens of renders per second.
 */
export function useRunningCandle(
  symbol: string,
  seed:   Candle | null,
  binMs:  number,
): Candle | null {
  const bitmex = useBitmex();

  const [running, setRunning] = useState<Candle | null>(null);

  const accRef   = useRef<Acc | null>(null);
  const rafIdRef = useRef<number | null>(null);

  /** (Re)seed the accumulator whenever the anchoring closed candle changes. */
  useEffect(() => {
    if (seed === null) {
      accRef.current = null;
      setRunning(null);

      return;
    }

    const acc = seedFrom(seed, binMs);
    accRef.current = acc;
    setRunning(accToCandle(acc));
  }, [seed?.timestamp, seed?.close, binMs]);

  /** trade WS — accumulate into the running bin. */
  useEffect(() => {
    let active = true;

    const cleanup = bitmex.stream<Trade>(
      `trade:${symbol}`,
      (action, data) => {
        if (! active || action !== 'insert') {
          return;
        }

        const acc = accRef.current;

        if (! acc) {
          return;
        }

        const binEndMs   = new Date(acc.timestamp).getTime();
        const binStartMs = binEndMs - binMs;

        let updated = false;

        for (const trade of data) {
          const tradeMs = new Date(trade.timestamp).getTime();

          if (tradeMs <= binStartMs || tradeMs > binEndMs) {
            continue;
          }

          acc.close   = trade.price;
          acc.high    = Math.max(acc.high, trade.price);
          acc.low     = Math.min(acc.low,  trade.price);
          acc.volume += trade.size;
          updated     = true;
        }

        if (! updated) {
          return;
        }

        if (rafIdRef.current !== null) {
          return;
        }

        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;

          if (accRef.current) {
            setRunning(accToCandle(accRef.current));
          }
        });
      },
    );

    return () => {
      active = false;

      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }

      cleanup();
    };
  }, [bitmex, symbol, binMs]);

  return running;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function seedFrom(prev: Candle, binMs: number): Acc {
  const binEndMs = new Date(prev.timestamp).getTime() + binMs;

  return {
    timestamp: new Date(binEndMs).toISOString(),
    open:      prev.close,
    close:     prev.close,
    high:      prev.close,
    low:       prev.close,
    volume:    0,
  };
}

function accToCandle(acc: Acc): Candle {
  return {
    timestamp: acc.timestamp,
    open:      acc.open,
    close:     acc.close,
    high:      acc.high,
    low:       acc.low,
    volume:    acc.volume,
  };
}
