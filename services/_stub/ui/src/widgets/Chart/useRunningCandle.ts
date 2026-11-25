import { useEffect, useRef, useState } from 'react';
import { useBitmex } from '../../data/DataProvider';
import type { Trade } from '../../types';
import type { Candle } from './types';

/**
 * Mutable accumulator for the running bin.
 *
 * `timestamp` is the bin's CLOSE time, matching BitMEX's closed-candle
 * convention. `open` is the previous bin's close (OHLC continuity): the seed
 * candle's close, or the last trade price when the bin was opened by a trade.
 * close/volume update from trades. `high`/`low` are the extremes of the bin's
 * trades (null before its first trade); the candle's high/low also cover `open`.
 */
interface Acc {
  timestamp: string;
  open:      number;
  close:     number;
  high:      number | null;
  low:       number | null;
  volume:    number;
}

/**
 * Builds the currently-open candle from the trade stream.
 *
 * The `seed` is the most-recent closed candle. The running bin starts where
 * the seed ends (`seed.timestamp`) and closes `binMs` later; its open is
 * `seed.close`. A trade after the running bin's close opens the next bin
 * (rolled forward to the bin containing the trade), so trades are not lost
 * while the venue has yet to publish the bin that just closed. When that
 * closed candle arrives as the new seed, the bin it anchors is the one already
 * running: its trades are kept and only `open` is re-anchored to `seed.close`.
 * A seed older than the running bin is ignored; a newer one starts a fresh bin.
 *
 * Trades at or before the running bin's start belong to an earlier bin and are
 * skipped. The running candle covers only the trades seen since its bin was
 * seeded or opened, so on long timeframes it starts flat at mount.
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

  /** Symbol and bin size the accumulator was built for — a change always reseeds. */
  const accKeyRef = useRef<string | null>(null);

  /** (Re)seed the accumulator whenever the anchoring closed candle changes. */
  useEffect(() => {
    if (seed === null) {
      accRef.current    = null;
      accKeyRef.current = null;
      setRunning(null);

      return;
    }

    const key  = `${symbol}|${binMs}`;
    const next = seedFrom(seed, binMs);
    const acc  = accRef.current;

    if (acc && accKeyRef.current === key) {
      const nextEndMs = new Date(next.timestamp).getTime();
      const accEndMs  = new Date(acc.timestamp).getTime();

      /** Seed is behind the running bin (a trade already rolled it forward). */
      if (nextEndMs < accEndMs) {
        return;
      }

      /** Seed closes the bin before the running one: keep its trades, re-anchor open. */
      if (nextEndMs === accEndMs) {
        acc.open = seed.close;

        if (acc.high === null) {
          acc.close = seed.close;
        }

        setRunning(accToCandle(acc));

        return;
      }
    }

    accRef.current    = next;
    accKeyRef.current = key;
    setRunning(accToCandle(next));
  }, [symbol, seed?.timestamp, seed?.close, binMs]);

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

        let updated = false;

        for (const trade of data) {
          const tradeMs  = new Date(trade.timestamp).getTime();
          const binEndMs = new Date(acc.timestamp).getTime();

          if (tradeMs <= binEndMs - binMs) {
            continue;
          }

          if (tradeMs > binEndMs) {
            rollOver(acc, binEndMs + Math.ceil((tradeMs - binEndMs) / binMs) * binMs);
          }

          acc.close   = trade.price;
          acc.high    = Math.max(acc.high ?? trade.price, trade.price);
          acc.low     = Math.min(acc.low  ?? trade.price, trade.price);
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
    high:      null,
    low:       null,
    volume:    0,
  };
}

/** Close the running bin and open the one closing at `binEndMs`, at the last price. */
function rollOver(acc: Acc, binEndMs: number): void {
  acc.timestamp = new Date(binEndMs).toISOString();
  acc.open      = acc.close;
  acc.high      = null;
  acc.low       = null;
  acc.volume    = 0;
}

function accToCandle(acc: Acc): Candle {
  return {
    timestamp: acc.timestamp,
    open:      acc.open,
    close:     acc.close,
    high:      Math.max(acc.open, acc.high ?? acc.open),
    low:       Math.min(acc.open, acc.low  ?? acc.open),
    volume:    acc.volume,
  };
}
