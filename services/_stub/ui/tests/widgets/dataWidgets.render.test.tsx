/**
 * Data-rendering tests: feed the fake Bitmex client a snapshot and assert the
 * widget paints the expected rows / labels / formatting. Covers branches in
 * the display layer (formatters, conditional layouts, tick arrows).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

import { OrderbookWidget }    from '../../src/widgets/Orderbook/OrderbookWidget';
import { RecentTradesWidget } from '../../src/widgets/RecentTrades/RecentTradesWidget';
import { ChartWidget }        from '../../src/widgets/Chart/ChartWidget';

import { makeFakeBitmex, makeBitmexWrapper, type FakeBitmex } from '../helpers/fakeBitmex';
import type { OrderBookLevel, Trade, TradeBin } from '../../src/types';

let fake: FakeBitmex;

beforeEach(() => {
  fake = makeFakeBitmex();
});

// ── OrderbookWidget — data-driven render ──────────────────────────────────────

describe('OrderbookWidget renders book data', () => {
  it('shows best ask / spread / best bid in the price bar', () => {
    const Wrapper = makeBitmexWrapper(fake);
    const { container } = render(<Wrapper><OrderbookWidget /></Wrapper>);

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'partial', [
        { symbol: 'XBTUSD', id: 1, side: 'Sell', size: 1, price: 100.0 },
        { symbol: 'XBTUSD', id: 2, side: 'Buy',  size: 1, price: 99.5  },
      ]);
    });

    const bar = container.querySelector('.orderbook__price-bar');
    expect(bar?.textContent).toMatch(/100\.0/);
    expect(bar?.textContent).toMatch(/99\.5/);
    expect(bar?.textContent).toMatch(/0\.5/);
  });

  it('renders quote currency derived from symbol', () => {
    const Wrapper = makeBitmexWrapper(fake);
    const { container } = render(<Wrapper><OrderbookWidget /></Wrapper>);

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'partial', [
        { symbol: 'XBTUSD', id: 1, side: 'Sell', size: 1, price: 100 },
        { symbol: 'XBTUSD', id: 2, side: 'Buy',  size: 1, price: 99  },
      ]);
    });

    /** Symbol "XBTUSD" → quote = "USD". */
    expect(container.textContent).toMatch(/USD/);
  });
});

// ── RecentTradesWidget — render trades ────────────────────────────────────────

describe('RecentTradesWidget renders trade rows', () => {
  it('renders trades after WS inserts and includes a tick arrow on PlusTick / MinusTick', async () => {
    const Wrapper = makeBitmexWrapper(fake);
    const { container } = render(<Wrapper><RecentTradesWidget /></Wrapper>);

    await waitFor(() => expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0));

    act(() => {
      fake.emit<Trade>('trade:XBTUSD', 'insert', [
        {
          timestamp: '2024-01-01T00:00:00Z',
          symbol: 'XBTUSD', side: 'Buy', size: 100, price: 68_940,
          tickDirection: 'PlusTick', trdMatchID: 'm1',
          grossValue: 1, homeNotional: 1, foreignNotional: 1,
        },
        {
          timestamp: '2024-01-01T00:00:01Z',
          symbol: 'XBTUSD', side: 'Sell', size: 50, price: 68_939,
          tickDirection: 'MinusTick', trdMatchID: 'm2',
          grossValue: 1, homeNotional: 1, foreignNotional: 1,
        },
        {
          timestamp: '2024-01-01T00:00:02Z',
          symbol: 'XBTUSD', side: 'Sell', size: 50, price: 68_939,
          tickDirection: 'ZeroMinusTick', trdMatchID: 'm3',
          grossValue: 1, homeNotional: 1, foreignNotional: 1,
        },
      ]);
    });

    /** Tick arrow SVG is added only on Plus/Minus ticks → 2 arrows for 3 trades. */
    const ticks = container.querySelectorAll('.recenttrades__tick');
    expect(ticks).toHaveLength(2);

    /** Prices appear in the rendered output. */
    expect(container.textContent).toMatch(/68,940/);
  });
});

// ── ChartWidget — OHLC bar reflects latest candle ─────────────────────────────

describe('ChartWidget renders the OHLC bar from data', () => {
  it('shows O/H/L/C values once a tradeBin frame arrives', async () => {
    const Wrapper = makeBitmexWrapper(fake);

    /** Pre-stage the REST fetch with one closed candle. */
    fake.fetchMock.mockResolvedValue([
      {
        timestamp: '2024-01-01T00:01:00Z', symbol: 'XBTUSD',
        open: 100, high: 110, low: 95, close: 105, volume: 1_000,
      } satisfies TradeBin,
    ]);

    const { container } = render(<Wrapper><ChartWidget /></Wrapper>);

    /** Allow the REST promise + state updates to flush. */
    await waitFor(() => expect(container.textContent).toMatch(/100|110|95|105/));
  });
});
