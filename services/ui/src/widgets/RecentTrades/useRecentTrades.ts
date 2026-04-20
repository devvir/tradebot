import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useBitmex } from '../../data/DataProvider';
import type { Trade } from '../../types';

export interface TaggedTrade {
  uid:   number;
  trade: Trade;
}

const DEFAULT_LIMIT = 100;

/**
 * Loads a page of recent trades via REST then streams live inserts for the
 * symbol currently in the URL. Returns trades newest-first, capped at `limit`
 * entries (FIFO). Each entry carries a locally-assigned uid suitable for use
 * as a React key — the trade channel has no declared keys so field values
 * cannot be relied upon to be unique.
 */
export function useRecentTrades(limit = DEFAULT_LIMIT): TaggedTrade[] {
  const { symbol = 'XBTUSD' } = useParams<{ symbol: string }>();
  const bitmex  = useBitmex();
  const counter = useRef(0);
  const [trades, setTrades] = useState<TaggedTrade[]>([]);

  function tag(trade: Trade): TaggedTrade {
    return { uid: counter.current++, trade };
  }

  useEffect(() => {
    let active = true;

    setTrades([]);

    bitmex
      .fetch<Trade>('trade', limit, { symbol })
      .then(initial => {
        if (active) {
          setTrades(initial.map(tag));
        }
      })
      .catch(err => {
        console.warn('useRecentTrades: initial fetch failed', err);
      });

    const cleanup = bitmex.stream<Trade>(`trade:${symbol}`, (action, data) => {
      if (! active) {
        return;
      }

      if (action !== 'insert') {
        return;
      }

      setTrades(prev => {
        const incoming = [...data].reverse().map(tag);

        return [...incoming, ...prev].slice(0, limit);
      });
    });

    return () => {
      active = false;
      cleanup();
    };
  }, [bitmex, symbol, limit]);

  return trades;
}
