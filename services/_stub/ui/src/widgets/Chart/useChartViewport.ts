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

  /**
   * Shift the view by deltaCandles bins. `latestTime` is the newest closed bin.
   * Live mode shows the running bin one slot after it, so the live edge sits at
   * latestTime + binMs: leaving live pins the anchor relative to that edge, and
   * an anchor that reaches it again returns to live.
   */
  const pan = useCallback((deltaCandles: number, binMs: number, latestTime: Date | null) => {
    setState(s => {
      const liveEdgeMs = latestTime !== null ? latestTime.getTime() + binMs : null;

      if (s.rightAnchor === null) {
        /** In live mode: forward pan is a no-op, backward pan pins an anchor. */
        if (deltaCandles >= 0 || liveEdgeMs === null) {
          return s;
        }

        return { ...s, rightAnchor: new Date(liveEdgeMs + deltaCandles * binMs) };
      }

      const next = s.rightAnchor.getTime() + deltaCandles * binMs;

      /** Panning forward to the live edge snaps back to live mode. */
      if (liveEdgeMs !== null && next >= liveEdgeMs) {
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
