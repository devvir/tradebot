import { useEffect, useRef, useState } from 'react';
import { useBitmex } from '../../data/DataProvider';
import type { TradeBin } from '../../types';
import type { Candle, Timeframe, ViewportState } from './types';
import { BIN_MS } from './types';

const BIN_SIZE: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '1h': '1h',
  '1d': '1d',
};

const WS_TABLE: Record<Timeframe, string> = {
  '1m': 'tradeBin1m',
  '5m': 'tradeBin5m',
  '1h': 'tradeBin1h',
  '1d': 'tradeBin1d',
};

const BUFFER_RATIO     = 0.5;
const MAX_BUFFER_RATIO = 4;

/**
 * Owns the closed-candle buffer. Three inputs feed it:
 *
 *   1. REST fetch — driven by viewport changes; paginates left/right as the
 *      user zooms or navigates.
 *   2. tradeBin WS `insert` — each newly closed bin is validated against the
 *      current tail (duplicate → drop, gap → wipe + force reload).
 *   3. fetchKey bumps — internal mechanism to re-trigger the REST effect when
 *      the buffer is wiped on gap detection.
 *
 * Has no notion of a running/live candle. Partial tradeBin snapshots are
 * ignored; anything not fully closed is someone else's responsibility.
 */
export function useClosedCandles(
  symbol:    string,
  timeframe: Timeframe,
  viewport:  ViewportState,
): Candle[] {
  const bitmex = useBitmex();

  const [candles,  setCandles]  = useState<Candle[]>([]);
  const [fetchKey, setFetchKey] = useState(0);

  const binMs = BIN_MS[timeframe];

  const candlesRef  = useRef<Candle[]>(candles);
  const viewportRef = useRef(viewport);

  candlesRef.current  = candles;
  viewportRef.current = viewport;

  /** Reset the buffer when the identity of the series changes. */
  useEffect(() => {
    setCandles([]);
    candlesRef.current = [];
  }, [symbol, timeframe]);

  /** tradeBin WS — only `insert`. Validates dupes/gaps against the buffer tail. */
  useEffect(() => {
    let active = true;

    const cleanup = bitmex.stream<TradeBin>(
      `${WS_TABLE[timeframe]}:${symbol}`,
      (action, data) => {
        if (! active || action !== 'insert') {
          return;
        }

        const incoming = data
          .map(toCandle)
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        if (incoming.length === 0) {
          return;
        }

        const tail = candlesRef.current;
        let   lastTs: string | null = tail.length > 0 ? tail[tail.length - 1].timestamp : null;
        const accepted: Candle[] = [];

        for (const candle of incoming) {
          if (lastTs !== null) {
            const lastMs     = new Date(lastTs).getTime();
            const actualMs   = new Date(candle.timestamp).getTime();
            const expectedMs = lastMs + binMs;

            if (actualMs === lastMs) {
              continue;  // duplicate — drop silently
            }

            if (actualMs !== expectedMs) {
              // Gap — buffer is stale, wipe and force full reload
              candlesRef.current = [];
              setCandles([]);
              setFetchKey(k => k + 1);

              return;
            }
          }

          accepted.push(candle);
          lastTs = candle.timestamp;
        }

        if (accepted.length === 0) {
          return;
        }

        const next = mergeCandles(candlesRef.current, accepted);
        candlesRef.current = next;
        setCandles(next);
      },
    );

    return () => {
      active = false;
      cleanup();
    };
  }, [bitmex, symbol, timeframe, binMs]);

  /** REST fetch — runs when the viewport needs candles outside the buffer. */
  useEffect(() => {
    let active = true;

    const need = computeNeededFetch(candlesRef.current, viewport, binMs);

    if (! need) {
      return;
    }

    const params: Record<string, string | number> = {
      symbol,
      binSize: BIN_SIZE[timeframe],
    };

    if (need.endTime !== null) {
      params.endTime = need.endTime.toISOString();
    }

    bitmex
      .fetch<TradeBin>('trade/bucketed', need.count, params)
      .then(data => {
        if (! active) {
          return;
        }

        const fetched = data.reverse().map(toCandle);
        const next    = trimBuffer(
          mergeCandles(candlesRef.current, fetched),
          viewportRef.current,
          binMs,
        );

        candlesRef.current = next;
        setCandles(next);
      })
      .catch(err => {
        console.warn('useClosedCandles: fetch failed', err);
      });

    return () => {
      active = false;
    };
  }, [bitmex, symbol, timeframe, binMs, viewport, fetchKey]);

  return candles;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function toCandle(bin: TradeBin): Candle {
  return {
    timestamp: bin.timestamp,
    open:      bin.open   ?? 0,
    high:      bin.high   ?? 0,
    low:       bin.low    ?? 0,
    close:     bin.close  ?? 0,
    volume:    bin.volume ?? 0,
  };
}

/** Merge two candle arrays by timestamp (later wins on collision), sorted asc. */
function mergeCandles(a: Candle[], b: Candle[]): Candle[] {
  if (b.length === 0) {
    return a;
  }

  if (a.length === 0) {
    return b;
  }

  const map = new Map<string, Candle>();

  for (const c of a) {
    map.set(c.timestamp, c);
  }

  for (const c of b) {
    map.set(c.timestamp, c);
  }

  return [...map.values()].sort((x, y) => x.timestamp.localeCompare(y.timestamp));
}

function computeNeededFetch(
  candles:  Candle[],
  viewport: ViewportState,
  binMs:    number,
): { endTime: Date | null; count: number } | null {
  const bufferCandles = Math.ceil(viewport.candlesPerView * BUFFER_RATIO);
  const totalCandles  = viewport.candlesPerView + 2 * bufferCandles;

  const rightEdge = viewport.rightAnchor === null
    ? null
    : new Date(viewport.rightAnchor.getTime() + bufferCandles * binMs);

  if (candles.length === 0) {
    return { endTime: rightEdge, count: totalCandles };
  }

  const rightEdgeMs = rightEdge?.getTime() ?? Date.now();
  const leftEdgeMs  = rightEdgeMs - totalCandles * binMs;
  const firstMs     = new Date(candles[0].timestamp).getTime();
  const lastMs      = new Date(candles[candles.length - 1].timestamp).getTime();

  if (firstMs > leftEdgeMs + binMs) {
    return { endTime: new Date(firstMs), count: totalCandles };
  }

  if (viewport.rightAnchor !== null && lastMs < rightEdgeMs - binMs) {
    return { endTime: rightEdge, count: totalCandles };
  }

  return null;
}

function trimBuffer(
  candles:  Candle[],
  viewport: ViewportState,
  binMs:    number,
): Candle[] {
  const maxCount = Math.max(viewport.candlesPerView * MAX_BUFFER_RATIO, 200);

  if (candles.length <= maxCount) {
    return candles;
  }

  const rightEdgeMs = viewport.rightAnchor === null
    ? new Date(candles[candles.length - 1].timestamp).getTime()
    : viewport.rightAnchor.getTime();

  const bufferLeftMs  = rightEdgeMs - (viewport.candlesPerView + viewport.candlesPerView * BUFFER_RATIO) * binMs;
  const bufferRightMs = rightEdgeMs + viewport.candlesPerView * BUFFER_RATIO * binMs;

  return candles.filter(c => {
    const ms = new Date(c.timestamp).getTime();

    return ms >= bufferLeftMs && ms <= bufferRightMs;
  });
}

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_toCandle           = toCandle;
export const _test_mergeCandles       = mergeCandles;
export const _test_computeNeededFetch = computeNeededFetch;
export const _test_trimBuffer         = trimBuffer;
