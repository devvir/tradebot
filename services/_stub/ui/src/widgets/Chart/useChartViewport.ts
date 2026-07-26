import { useCallback, useState } from 'react';
import type { ViewportState } from './types';

const DEFAULT_CANDLES_PER_VIEW =  80;
const MIN_CANDLES_PER_VIEW     =  10;
const MAX_CANDLES_PER_VIEW     = 500;

export interface ChartViewport {
  state:  ViewportState;
  zoom:   (factor: number) => void;
  pan:    (deltaCandles: number, binMs: number, latestTime: Date | null) => void;
  goLive: () => void;
}

/**
 * Viewport state for the chart: horizontal zoom (candlesPerView) and horizontal
 * anchor (rightAnchor). Exposes imperative zoom/pan/goLive methods — this hook
 * has no knowledge of the candle buffer, pixel geometry, or data fetching.
 *
 * Gesture handlers (in ChartCanvas) convert pixel deltas to candle deltas and
 * call zoom/pan; viewport changes then drive fetches and renders via React's
 * normal state propagation.
 */
export function useChartViewport(): ChartViewport {
  const [state, setState] = useState<ViewportState>({
    candlesPerView: DEFAULT_CANDLES_PER_VIEW,
    rightAnchor:    null,
  });

  const zoom = useCallback((factor: number) => {
    setState(s => ({
      ...s,
      candlesPerView: clamp(
        Math.round(s.candlesPerView * factor),
        MIN_CANDLES_PER_VIEW,
        MAX_CANDLES_PER_VIEW,
      ),
    }));
  }, []);

  const pan = useCallback((deltaCandles: number, binMs: number, latestTime: Date | null) => {
    setState(s => {
      const latestMs = latestTime?.getTime() ?? null;

      if (s.rightAnchor === null) {
        /** In live mode: forward pan is a no-op, backward pan pins an anchor. */
        if (deltaCandles >= 0 || latestMs === null) {
          return s;
        }

        return { ...s, rightAnchor: new Date(latestMs + deltaCandles * binMs) };
      }

      const next = s.rightAnchor.getTime() + deltaCandles * binMs;

      /** Panning forward past live snaps back to live mode. */
      if (latestMs !== null && next >= latestMs) {
        return { ...s, rightAnchor: null };
      }

      return { ...s, rightAnchor: new Date(next) };
    });
  }, []);

  const goLive = useCallback(() => {
    setState(s => (s.rightAnchor === null ? s : { ...s, rightAnchor: null }));
  }, []);

  return { state, zoom, pan, goLive };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
