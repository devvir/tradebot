import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { ChartWidget } from '../../../src/widgets/Chart/ChartWidget';
import { MARGIN } from '../../../src/widgets/Chart/renderer';
import { makeFakeBitmex, makeBitmexWrapper, type FakeBitmex } from '../../helpers/fakeBitmex';
import { installCanvasHarness, pointer, type CanvasHarness } from '../../helpers/canvasHarness';
import type { Trade, TradeBin } from '../../../src/types';

const PLOT_RIGHT = MARGIN.left + 800;

let fake:    FakeBitmex;
let harness: CanvasHarness;

beforeEach(() => {
  fake    = makeFakeBitmex();
  harness = installCanvasHarness({ width: PLOT_RIGHT + MARGIN.right, height: 400 });
});

afterEach(() => {
  harness.restore();
});

const closed: TradeBin = {
  timestamp: '2024-01-01T00:01:00.000Z', symbol: 'XBTUSD',
  open: 100, high: 110, low: 95, close: 105, volume: 1_000,
};

const trade = (price: number): Trade => ({
  timestamp:       '2024-01-01T00:01:30.000Z',
  symbol:          'XBTUSD',
  side:            'Buy',
  size:            1,
  price,
  tickDirection:   'PlusTick',
  trdMatchID:      'm',
  grossValue:      1,
  homeNotional:    1,
  foreignNotional: 1,
});

function closeText(container: HTMLElement): string | undefined {
  return [...container.querySelectorAll('.chart__ohlc-item')]
    .find(el => el.textContent?.startsWith('C '))
    ?.textContent ?? undefined;
}

describe('ChartWidget — OHLC readout under the cursor', () => {
  it('follows the hovered candle as it updates', async () => {
    fake.fetchMock.mockResolvedValue([closed]);

    const Wrapper = makeBitmexWrapper(fake);
    const { container } = render(<Wrapper><ChartWidget /></Wrapper>);

    /** Live view: [closed, running]; the running bin opens at the closed candle's close. */
    await waitFor(() => expect(container.querySelector('.chart__ohlc')?.textContent).toMatch(/O 105\.0/));
    expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0);

    const canvas = container.querySelector('canvas')!;

    /** Hover the rightmost column — the running candle. */
    act(() => { pointer(canvas, 'pointermove', { buttons: 0, clientX: PLOT_RIGHT - 1 }); });

    act(() => { fake.emit<Trade>('trade:XBTUSD', 'insert', [trade(123)]); });

    await waitFor(() => expect(closeText(container)).toBe('C 123.0'));

    /** Hovering the closed candle shows its values. */
    act(() => { pointer(canvas, 'pointermove', { buttons: 0, clientX: PLOT_RIGHT - 15 }); });

    expect(closeText(container)).toBe('C 105.0');
  });
});
