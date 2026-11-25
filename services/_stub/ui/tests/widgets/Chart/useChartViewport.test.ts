import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChartViewport } from '../../../src/widgets/Chart/useChartViewport';
import { _test_computeVisible as computeVisible } from '../../../src/widgets/Chart/useChart';
import type { Candle } from '../../../src/widgets/Chart/types';

const BIN_1M = 60_000;

// ── zoom ──────────────────────────────────────────────────────────────────────

describe('useChartViewport.zoom', () => {
  it('starts at the default 80 candles per view, no anchor', () => {
    const { result } = renderHook(() => useChartViewport());

    expect(result.current.state.candlesPerView).toBe(80);
    expect(result.current.state.rightAnchor).toBeNull();
  });

  it('multiplies candlesPerView by the factor (rounded)', () => {
    const { result } = renderHook(() => useChartViewport());

    act(() => result.current.zoom(1.5));

    expect(result.current.state.candlesPerView).toBe(120);
  });

  it('clamps at the minimum (10) on extreme zoom-in', () => {
    const { result } = renderHook(() => useChartViewport());

    act(() => result.current.zoom(0.0001));

    expect(result.current.state.candlesPerView).toBe(10);
  });

  it('clamps at the maximum (500) on extreme zoom-out', () => {
    const { result } = renderHook(() => useChartViewport());

    act(() => result.current.zoom(1_000));

    expect(result.current.state.candlesPerView).toBe(500);
  });
});

// ── pan in live mode (rightAnchor = null) ─────────────────────────────────────

describe('useChartViewport.pan (live mode)', () => {
  it('forward pan in live is a no-op', () => {
    const { result } = renderHook(() => useChartViewport());
    const before = result.current.state;

    act(() => result.current.pan(5, BIN_1M, new Date()));

    expect(result.current.state).toBe(before);
  });

  it('backward pan in live pins an anchor relative to the live edge (latestTime + one bin)', () => {
    const { result } = renderHook(() => useChartViewport());
    const latest = new Date(2_000_000_000_000);

    act(() => result.current.pan(-3, BIN_1M, latest));

    expect(result.current.state.rightAnchor?.getTime()).toBe(latest.getTime() + BIN_1M - 3 * BIN_1M);
  });

  it('a sub-candle backward pan keeps the latest closed candle at the right edge, and undoing it returns to live', () => {
    const { result } = renderHook(() => useChartViewport());
    const latestMs = 2_000_000_000_000;
    const closed: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      timestamp: new Date(latestMs - (19 - i) * BIN_1M).toISOString(),
      open: 1, high: 1, low: 1, close: 1, volume: 1,
    }));

    act(() => result.current.pan(-0.3, BIN_1M, new Date(latestMs)));

    const visible = computeVisible(closed, result.current.state, null);

    expect(result.current.state.rightAnchor).not.toBeNull();
    expect(new Date(visible[visible.length - 1].timestamp).getTime()).toBe(latestMs);

    act(() => result.current.pan(0.3, BIN_1M, new Date(latestMs)));

    expect(result.current.state.rightAnchor).toBeNull();
  });

  it('does nothing when latestTime is null', () => {
    const { result } = renderHook(() => useChartViewport());
    const before = result.current.state;

    act(() => result.current.pan(-3, BIN_1M, null));

    expect(result.current.state).toBe(before);
  });
});

// ── pan in anchored mode ──────────────────────────────────────────────────────

describe('useChartViewport.pan (anchored mode)', () => {
  it('shifts the anchor by deltaCandles * binMs', () => {
    const { result } = renderHook(() => useChartViewport());
    const latest = new Date(2_000_000_000_000);

    act(() => result.current.pan(-10, BIN_1M, latest));

    const anchorBefore = result.current.state.rightAnchor!.getTime();

    act(() => result.current.pan(-2, BIN_1M, latest));

    expect(result.current.state.rightAnchor!.getTime()).toBe(anchorBefore - 2 * BIN_1M);
  });

  it('snaps back to live when forward-panned past the latest time', () => {
    const { result } = renderHook(() => useChartViewport());
    const latest = new Date(2_000_000_000_000);

    /** First anchor a bit in the past. */
    act(() => result.current.pan(-5, BIN_1M, latest));

    /** Then pan forward past it. */
    act(() => result.current.pan(100, BIN_1M, latest));

    expect(result.current.state.rightAnchor).toBeNull();
  });

  it('stays anchored while the anchor is on the latest closed bin, short of the live edge', () => {
    const { result } = renderHook(() => useChartViewport());
    const latest = new Date(2_000_000_000_000);

    act(() => result.current.pan(-5, BIN_1M, latest));
    act(() => result.current.pan(4, BIN_1M, latest));

    expect(result.current.state.rightAnchor?.getTime()).toBe(latest.getTime());
  });
});

// ── goLive ────────────────────────────────────────────────────────────────────

describe('useChartViewport.goLive', () => {
  it('clears the anchor', () => {
    const { result } = renderHook(() => useChartViewport());

    act(() => result.current.pan(-5, BIN_1M, new Date()));
    expect(result.current.state.rightAnchor).not.toBeNull();

    act(() => result.current.goLive());

    expect(result.current.state.rightAnchor).toBeNull();
  });

  it('is a no-op when already live (state reference stable)', () => {
    const { result } = renderHook(() => useChartViewport());
    const before = result.current.state;

    act(() => result.current.goLive());

    expect(result.current.state).toBe(before);
  });
});
