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

export interface ClosedCandles {
  /** Closed candles held for the current viewport, ascending by timestamp. */
  candles:    Candle[];
  /**
   * Timestamp (ms) of the newest bin the venue has closed, as last seen on a
   * live REST page or a tradeBin insert; null until one has been seen. The
   * buffer's tail equals it only while the buffer reaches the live edge.
   */
  liveTailMs: number | null;
}

/** The REST loader's operations, rebuilt whenever the series identity changes. */
interface Loader {
  /** Issue the next needed page unless one is already in flight. */
  pump: () => void;
  /** Drop the buffer, discard any in-flight page, reload. The live tail is kept. */
  wipe: () => void;
}

/**
 * Owns the closed-candle buffer for one symbol and timeframe.
 *
 *   1. REST loader — keeps at most one `trade/bucketed` page in flight. Each
 *      viewport change asks it to evaluate what the viewport needs; after every
 *      page it re-evaluates against the latest viewport and keeps paging until
 *      nothing is needed, the venue returns a short page (start of history), or
 *      the same request would repeat against an unchanged buffer. A page that
 *      does not touch the buffer replaces it. Only a change of client, symbol
 *      or timeframe (or unmount) abandons the in-flight page.
 *   2. tradeBin WS `insert` — while the buffer's tail is the live tail, each
 *      newly closed bin is validated against it (duplicate → drop, contiguous
 *      → append, gap → advance the live tail, wipe + reload). While the buffer
 *      holds history that does not reach the live edge, inserts only advance
 *      the live tail.
 *
 * Has no notion of a running/live candle. Partial tradeBin snapshots are
 * ignored; anything not fully closed is someone else's responsibility.
 */
export function useClosedCandles(
  symbol:    string,
  timeframe: Timeframe,
  viewport:  ViewportState,
): ClosedCandles {
  const bitmex = useBitmex();

  const [candles,    setCandles]    = useState<Candle[]>([]);
  const [liveTailMs, setLiveTailMs] = useState<number | null>(null);

  const binMs = BIN_MS[timeframe];

  const candlesRef  = useRef<Candle[]>(candles);
  const liveTailRef = useRef<number | null>(null);
  const viewportRef = useRef(viewport);
  const loaderRef   = useRef<Loader | null>(null);

  viewportRef.current = viewport;

  const commitCandles = (next: Candle[]) => {
    candlesRef.current = next;
    setCandles(next);
  };

  const commitLiveTail = (ms: number | null) => {
    liveTailRef.current = ms;
    setLiveTailMs(ms);
  };

  /** REST loader — reset and rebuilt when the identity of the series changes. */
  useEffect(() => {
    let active   = true;
    let inFlight = false;
    let epoch    = 0;
    let served: string | null = null;

    commitCandles([]);
    commitLiveTail(null);

    const pump = () => {
      if (! active || inFlight) {
        return;
      }

      const buffer = candlesRef.current;
      const need   = computeNeededFetch(buffer, viewportRef.current, binMs, liveTailRef.current);

      if (! need) {
        return;
      }

      const key = requestKey(need, buffer, liveTailRef.current);

      if (key === served) {
        return;
      }

      const params: Record<string, string | number> = {
        symbol,
        binSize: BIN_SIZE[timeframe],
      };

      if (need.endTime !== null) {
        params.endTime = need.endTime.toISOString();
      }

      const requestEpoch = epoch;
      inFlight = true;

      bitmex
        .fetch<TradeBin>('trade/bucketed', need.count, params)
        .then(data => {
          if (! active) {
            return;
          }

          inFlight = false;

          if (requestEpoch !== epoch) {
            pump();

            return;
          }

          const fetched = [...data].reverse().map(toCandle);

          if (need.endTime === null && fetched.length > 0) {
            const newestMs = toMs(fetched[fetched.length - 1]);
            commitLiveTail(Math.max(liveTailRef.current ?? newestMs, newestMs));
          }

          const next = trimBuffer(
            placePage(candlesRef.current, fetched, binMs),
            viewportRef.current,
            binMs,
          );

          commitCandles(next);
          served = key;

          if (fetched.length >= need.count) {
            pump();
          }
        })
        .catch(err => {
          if (! active) {
            return;
          }

          inFlight = false;
          console.warn('useClosedCandles: fetch failed', err);

          /** A wipe while this page was in flight left its reload to this page's completion. */
          if (requestEpoch !== epoch) {
            pump();
          }
        });
    };

    const wipe = () => {
      epoch++;
      served = null;
      commitCandles([]);
      pump();
    };

    loaderRef.current = { pump, wipe };
    pump();

    return () => {
      active = false;

      if (loaderRef.current?.pump === pump) {
        loaderRef.current = null;
      }
    };
  }, [bitmex, symbol, timeframe, binMs]);

  /** Viewport changes only ask the loader to re-evaluate; they never cancel it. */
  useEffect(() => {
    loaderRef.current?.pump();
  }, [viewport]);

  /** tradeBin WS — only `insert`. Validates dupes/gaps against a live buffer tail. */
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

        const tail     = candlesRef.current;
        const liveTail = liveTailRef.current;

        /** Buffer does not reach the live edge: never merge into it, only track the edge. */
        if (tail.length === 0 || liveTail === null || toMs(tail[tail.length - 1]) !== liveTail) {
          const newestMs = toMs(incoming[incoming.length - 1]);
          commitLiveTail(Math.max(liveTail ?? newestMs, newestMs));
          loaderRef.current?.pump();

          return;
        }

        let   lastMs = liveTail;
        const accepted: Candle[] = [];

        for (const candle of incoming) {
          const actualMs = toMs(candle);

          if (actualMs === lastMs) {
            continue;  // duplicate — drop silently
          }

          if (actualMs !== lastMs + binMs) {
            // Gap — buffer is stale. Keep the live edge this insert reports, wipe and reload.
            commitLiveTail(Math.max(liveTail, toMs(incoming[incoming.length - 1])));
            loaderRef.current?.wipe();

            return;
          }

          accepted.push(candle);
          lastMs = actualMs;
        }

        if (accepted.length === 0) {
          return;
        }

        commitCandles(mergeCandles(candlesRef.current, accepted));
        commitLiveTail(lastMs);
      },
    );

    return () => {
      active = false;
      cleanup();
    };
  }, [bitmex, symbol, timeframe, binMs]);

  return { candles, liveTailMs };
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

function toMs(candle: Candle): number {
  return new Date(candle.timestamp).getTime();
}

/**
 * Put a fetched page into the buffer. A page that overlaps or touches the
 * buffer is merged into it; a page more than one bin away from it on either
 * side replaces it, so the buffer never holds a hole.
 */
function placePage(buffer: Candle[], page: Candle[], binMs: number): Candle[] {
  if (page.length === 0 || buffer.length === 0) {
    return mergeCandles(buffer, page);
  }

  const pageFirstMs = toMs(page[0]);
  const pageLastMs  = toMs(page[page.length - 1]);

  if (pageFirstMs > toMs(buffer[buffer.length - 1]) + binMs || pageLastMs < toMs(buffer[0]) - binMs) {
    return page;
  }

  return mergeCandles(buffer, page);
}

/** Identifies a request together with the state it was computed from. */
function requestKey(
  need:       { endTime: Date | null; count: number },
  buffer:     Candle[],
  liveTailMs: number | null,
): string {
  const first = buffer.length > 0 ? buffer[0].timestamp : '';
  const last  = buffer.length > 0 ? buffer[buffer.length - 1].timestamp : '';

  return [need.endTime?.toISOString() ?? 'live', need.count, first, last, buffer.length, liveTailMs].join('|');
}

/**
 * The span of candles the viewport wants loaded: the visible candles plus a
 * margin of half a view on each side. `rightEdge` is null in live mode.
 */
function viewportWindow(viewport: ViewportState, binMs: number) {
  const bufferCandles = Math.ceil(viewport.candlesPerView * BUFFER_RATIO);
  const totalCandles  = viewport.candlesPerView + 2 * bufferCandles;

  const rightEdge = viewport.rightAnchor === null
    ? null
    : new Date(viewport.rightAnchor.getTime() + bufferCandles * binMs);

  return { totalCandles, rightEdge };
}

/**
 * The next REST page the viewport needs, or null when the buffer covers it.
 * `endTime: null` asks for the newest page.
 *
 *   live      — the tail is behind the live tail or older than two bins → newest page
 *   anchored  — the window does not overlap the buffer → page ending at the window's right edge
 *   both      — the buffer starts after the window's left edge → page ending at the buffer's head
 *   anchored  — the buffer ends before the window's right edge (capped at the live edge)
 *               → page ending at the window's right edge
 */
function computeNeededFetch(
  candles:    Candle[],
  viewport:   ViewportState,
  binMs:      number,
  liveTailMs: number | null = null,
): { endTime: Date | null; count: number } | null {
  const { totalCandles, rightEdge } = viewportWindow(viewport, binMs);

  if (candles.length === 0) {
    return { endTime: rightEdge, count: totalCandles };
  }

  const nowMs       = Date.now();
  const rightEdgeMs = rightEdge?.getTime() ?? nowMs;
  const leftEdgeMs  = rightEdgeMs - totalCandles * binMs;
  const firstMs     = toMs(candles[0]);
  const lastMs      = toMs(candles[candles.length - 1]);

  if (rightEdge === null) {
    if (lastMs < Math.max(liveTailMs ?? -Infinity, nowMs - 2 * binMs)) {
      return { endTime: null, count: totalCandles };
    }
  } else if (firstMs > rightEdgeMs || lastMs < leftEdgeMs) {
    return { endTime: rightEdge, count: totalCandles };
  }

  if (firstMs > leftEdgeMs + binMs) {
    return { endTime: new Date(firstMs), count: totalCandles };
  }

  if (rightEdge !== null && lastMs < Math.min(rightEdgeMs, liveTailMs ?? nowMs) - binMs) {
    return { endTime: rightEdge, count: totalCandles };
  }

  return null;
}

/**
 * Bound the buffer once it exceeds max(4 views, 200) candles: keep the
 * viewport's window (see viewportWindow) plus one bin on each side. In live
 * mode the window ends at the buffer's newest candle.
 */
function trimBuffer(
  candles:  Candle[],
  viewport: ViewportState,
  binMs:    number,
): Candle[] {
  const maxCount = Math.max(viewport.candlesPerView * MAX_BUFFER_RATIO, 200);

  if (candles.length <= maxCount) {
    return candles;
  }

  const { totalCandles, rightEdge } = viewportWindow(viewport, binMs);

  const rightEdgeMs   = rightEdge?.getTime() ?? toMs(candles[candles.length - 1]);
  const bufferLeftMs  = rightEdgeMs - (totalCandles + 1) * binMs;
  const bufferRightMs = rightEdgeMs + binMs;

  return candles.filter(c => {
    const ms = toMs(c);

    return ms >= bufferLeftMs && ms <= bufferRightMs;
  });
}

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_toCandle           = toCandle;
export const _test_mergeCandles       = mergeCandles;
export const _test_computeNeededFetch = computeNeededFetch;
export const _test_trimBuffer         = trimBuffer;
export const _test_placePage         = placePage;
