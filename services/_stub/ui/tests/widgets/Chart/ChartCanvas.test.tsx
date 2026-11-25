import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ChartCanvas } from '../../../src/widgets/Chart/ChartCanvas';

function mount(candlesPerView = 80) {
  const onZoom = vi.fn();
  const onPan  = vi.fn();

  const { container } = render(
    <div>
      <ChartCanvas candles={[]} candlesPerView={candlesPerView} onZoom={onZoom} onPan={onPan} onHover={() => {}} />
    </div>,
  );

  const canvas = container.querySelector('canvas')!;
  const wheel  = (init: WheelEventInit) => {
    const e = new WheelEvent('wheel', { cancelable: true, ...init });
    canvas.dispatchEvent(e);

    return e;
  };

  return { onZoom, onPan, wheel };
}

describe('ChartCanvas — wheel zoom', () => {
  it('scales the zoom factor with the wheel delta', () => {
    const { onZoom, wheel } = mount();

    const e = wheel({ deltaY: 100 });

    expect(e.defaultPrevented).toBe(true);
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom.mock.calls[0][0]).toBeCloseTo(Math.exp(0.2));

    wheel({ deltaY: -50 });

    expect(onZoom.mock.calls[1][0]).toBeCloseTo(Math.exp(-0.1));
  });

  it('clamps the factor a single event may apply', () => {
    const { onZoom, wheel } = mount();

    wheel({ deltaY: 5_000 });
    wheel({ deltaY: -5_000 });

    expect(onZoom.mock.calls[0][0]).toBeCloseTo(1.25);
    expect(onZoom.mock.calls[1][0]).toBeCloseTo(1 / 1.25);
  });

  it('accumulates small deltas until they change the view by a candle', () => {
    const { onZoom, wheel } = mount();

    /** 80 * exp(3 * 0.002) ≈ 80.48 — not yet a whole candle. */
    wheel({ deltaY: 1 });
    wheel({ deltaY: 1 });
    wheel({ deltaY: 1 });

    expect(onZoom).not.toHaveBeenCalled();

    /** 80 * exp(4 * 0.002) ≈ 80.64 → 81. */
    wheel({ deltaY: 1 });

    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom.mock.calls[0][0]).toBeCloseTo(Math.exp(0.008));
  });

  it('converts line-mode deltas to pixels', () => {
    const { onZoom, wheel } = mount();

    wheel({ deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE });

    expect(onZoom.mock.calls[0][0]).toBeCloseTo(Math.exp(3 * 16 * 0.002));
  });
});
