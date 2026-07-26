import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useBitmex } from '../../data/DataProvider';
import type { OrderBookLevel } from '../../types';

export interface OrderbookRow {
  price: number;
  size:  number;
  /** Cumulative size from the worst price of this side (top of display) down to this level. */
  total: number;
}

export interface Orderbook {
  /**
   * Sorted DESCENDING — index 0 is the worst (highest) ask, last is the best (lowest).
   * Display order: row 0 at the top, best ask at the bottom.
   * Total accumulates from row 0 downward (worst-first).
   */
  asks:   OrderbookRow[];
  /**
   * Sorted ASCENDING — index 0 is the worst (lowest) bid, last is the best (highest).
   * Display order: row 0 at the top, best bid at the bottom.
   * Total accumulates from row 0 downward (worst-first).
   */
  bids:   OrderbookRow[];
  bestAsk: number;
  bestBid: number;
  spread:  number;
}

const DEPTH = 25;

/**
 * Uses orderBookL2_25 (25 levels per side) — lighter subscription than the full book.
 * Switch to orderBookL2 if DEPTH ever needs to exceed 25.
 */
const WS_TOPIC = 'orderBookL2_25';

/** Composite key matching BitMEX's declared keys for orderBookL2: symbol + id + side. */
function levelKey(l: Pick<OrderBookLevel, 'symbol' | 'id' | 'side'>): string {
  return `${l.symbol}:${l.id}:${l.side}`;
}

/**
 * Derive display-ready rows from the live book map.
 * Both sides are sorted worst-first (top of display) so the best prices sit at the bottom,
 * matching BitMEX's layout where the spread is visible at the center-bottom of the widget.
 * Totals accumulate from the worst price downward, so row 0 total = just its own size.
 */
function derive(book: Map<string, OrderBookLevel>): Orderbook {
  const levels = Array.from(book.values());

  // Best 25 asks, ascending (best = lowest at end)
  const rawAsks = levels
    .filter(l => l.side === 'Sell')
    .sort((a, b) => a.price - b.price)
    .slice(0, DEPTH);

  // Best 25 bids, descending (best = highest at end after we reverse)
  const rawBids = levels
    .filter(l => l.side === 'Buy')
    .sort((a, b) => b.price - a.price)
    .slice(0, DEPTH);

  const bestAsk = rawAsks.length ? rawAsks[0].price : 0;
  const bestBid = rawBids.length ? rawBids[0].price : 0;

  // Asks: display worst-first (descending). Accumulate from worst downward.
  let askTotal = 0;
  const asks: OrderbookRow[] = [...rawAsks]
    .reverse()                                 // now worst (highest price) first
    .map(l => {
      askTotal += l.size;
      return { price: l.price, size: l.size, total: askTotal };
    });

  // Bids: display worst-first (ascending). Accumulate from worst downward.
  let bidTotal = 0;
  const bids: OrderbookRow[] = [...rawBids]
    .reverse()                                 // now worst (lowest price) first
    .map(l => {
      bidTotal += l.size;
      return { price: l.price, size: l.size, total: bidTotal };
    });

  const spread = bestAsk && bestBid ? bestAsk - bestBid : 0;

  return { asks, bids, bestAsk, bestBid, spread };
}

/**
 * Streams orderBookL2_25 for the current symbol via WebSocket only.
 * The partial action provides the initial snapshot; subsequent insert/update/delete
 * messages are accumulated into a map keyed by symbol:id:side.
 *
 * Uses a live-view pattern: the map is mutated in place and a version counter
 * triggers re-renders. derive() is called at render time (no intermediate copy).
 */
export function useOrderbook(): Orderbook {
  const { symbol = 'XBTUSD' } = useParams<{ symbol: string }>();
  const bitmex = useBitmex();
  const book   = useRef(new Map<string, OrderBookLevel>());
  const [, setVersion] = useState(0);

  useEffect(() => {
    let active = true;

    book.current.clear();
    setVersion(0);

    const cleanup = bitmex.stream<OrderBookLevel>(`${WS_TOPIC}:${symbol}`, (action, data) => {
      if (! active) {
        return;
      }

      if (action === 'partial') {
        book.current.clear();

        for (const l of data) {
          book.current.set(levelKey(l), l);
        }
      } else if (action === 'insert') {
        for (const l of data) {
          book.current.set(levelKey(l), l);
        }
      } else if (action === 'update') {
        for (const l of data) {
          const key      = levelKey(l);
          const existing = book.current.get(key);

          if (existing) {
            book.current.set(key, { ...existing, size: l.size });
          }
        }
      } else if (action === 'delete') {
        for (const l of data) {
          book.current.delete(levelKey(l));
        }
      }

      setVersion(v => v + 1);
    });

    return () => {
      active = false;
      cleanup();
    };
  }, [bitmex, symbol]);

  return derive(book.current);
}
