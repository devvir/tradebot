import { useCallback, useMemo, useRef } from 'react';
import type { Candle, Timeframe, ViewportState } from './types';
import { BIN_MS } from './types';
import { useChartViewport } from './useChartViewport';
import { useChartCandles } from './useChartCandles';

export interface UseChartResult {
  /** Candles the renderer should draw — a viewport slice of the buffer,
   *  with the running bin appended as the last element in live mode. */
  candles:  Candle[];
  /** Current viewport state — exposed so widgets can show status (e.g. "go live" button). */
  viewport: ViewportState;
  /** Multiply candlesPerView by factor (e.g. 1.1 to zoom out, 1/1.1 to zoom in). */
  onZoom:   (factor: number) => void;
  /** Shift the right anchor by deltaCandles (negative = earlier, positive = later). */
  onPan:    (deltaCandles: number) => void;
  /** Snap back to live mode (rightAnchor = null). */
  goLive:   () => void;
}

/**
 * Orchestrates viewport state and candle buffer into what the chart renders.
 *
 * Composition:
 *   useChartViewport  →  zoom level + horizontal anchor (pure UI state)
 *   useChartCandles   →  closed buffer + running candle (data only)
 *   this hook         →  derives the visible slice, bridges latestTime
 *                        from the buffer into viewport.pan
 *
 * Each reaction is coupled only to its cause: gestures change viewport →
 * needed range changes → fetches/disposals run → slice recomputes → render.
 */
export function useChart(timeframe: Timeframe): UseChartResult {
  const binMs = BIN_MS[timeframe];
  const vp    = useChartViewport();

  const { closed, running } = useChartCandles(timeframe, vp.state);

  /** Latest loaded timestamp — fed back into pan so live↔anchored transitions work. */
  const latestTimeRef = useRef<Date | null>(null);
  const lastCandle    = closed[closed.length - 1];
  latestTimeRef.current = lastCandle ? new Date(lastCandle.timestamp) : null;

  const visibleCandles = useMemo(
    () => computeVisible(closed, vp.state, running),
    [closed, vp.state, running],
  );

  const onPan = useCallback((deltaCandles: number) => {
    vp.pan(deltaCandles, binMs, latestTimeRef.current);
  }, [vp, binMs]);

  return {
    candles:  visibleCandles,
    viewport: vp.state,
    onZoom:   vp.zoom,
    onPan,
    goLive:   vp.goLive,
  };
}

/**
 * Slice candlesPerView candles from the closed buffer based on the viewport.
 * In live mode the rightmost slot is reserved for the running bin (when present),
 * so the total rendered count stays equal to candlesPerView. In anchored mode
 * the running bin is not shown — the user is looking at history.
 */
function computeVisible(
  closed:  Candle[],
  vp:      ViewportState,
  running: Candle | null,
): Candle[] {
  if (closed.length === 0) {
    return running && vp.rightAnchor === null ? [running] : [];
  }

  const n = vp.candlesPerView;

  if (vp.rightAnchor === null) {
    const closedCount = running ? n - 1 : n;
    const slice       = closed.slice(Math.max(0, closed.length - closedCount));

    return running ? [...slice, running] : slice;
  }

  /** Navigated: find the rightmost candle <= rightAnchor, slice n candles back. */
  const rightMs = vp.rightAnchor.getTime();
  let rightIdx  = -1;

  for (let i = closed.length - 1; i >= 0; i--) {
    if (new Date(closed[i].timestamp).getTime() <= rightMs) {
      rightIdx = i;
      break;
    }
  }

  if (rightIdx === -1) {
    return [];
  }

  const leftIdx = Math.max(0, rightIdx - n + 1);

  return closed.slice(leftIdx, rightIdx + 1);
}
