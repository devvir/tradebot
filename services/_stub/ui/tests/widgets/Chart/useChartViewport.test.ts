import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChartViewport } from '../../../src/widgets/Chart/useChartViewport';

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

  it('backward pan in live pins an anchor relative to latestTime', () => {
    const { result } = renderHook(() => useChartViewport());
    const latest = new Date(2_000_000_000_000);

    act(() => result.current.pan(-3, BIN_1M, latest));

    expect(result.current.state.rightAnchor?.getTime()).toBe(latest.getTime() + (-3) * BIN_1M);
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
