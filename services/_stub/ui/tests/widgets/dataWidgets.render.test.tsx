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

  it('prints sub-unit prices and the spread with the digits the book quotes', () => {
    const Wrapper = makeBitmexWrapper(fake);
    const { container } = render(<Wrapper><OrderbookWidget /></Wrapper>);

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'partial', [
        { symbol: 'XBTUSD', id: 1, side: 'Sell', size: 1, price: 0.5124 },
        { symbol: 'XBTUSD', id: 2, side: 'Sell', size: 1, price: 0.5123 },
        { symbol: 'XBTUSD', id: 3, side: 'Buy',  size: 1, price: 0.5121 },
        { symbol: 'XBTUSD', id: 4, side: 'Buy',  size: 1, price: 0.512  },
      ]);
    });

    const bar    = container.querySelectorAll('.orderbook__price-bar span');
    const prices = [...container.querySelectorAll('td.orderbook__col--price')].map(td => td.textContent);

    expect([...bar].map(el => el.textContent)).toEqual(['0.5123', '0.0002 (0.039%)', '0.5121']);
    expect(prices.sort()).toEqual(['0.5120', '0.5121', '0.5123', '0.5124']);
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

    /** Prices share the decimals the listed trades need (whole numbers here). */
    const prices = [...container.querySelectorAll('.recenttrades__price')].map(td => td.textContent);

    expect(prices.sort()).toEqual(['68,939', '68,939', '68,940']);
  });
});

// ── ChartWidget — OHLC bar reflects the running candle ────────────────────────

const ohlcText = (container: HTMLElement) => container.querySelector('.chart__ohlc')?.textContent;

const trade = (timestamp: string, price: number, size = 1): Trade => ({
  timestamp, symbol: 'XBTUSD', side: 'Buy', size, price, tickDirection: 'PlusTick',
  trdMatchID: `m-${timestamp}-${price}`, grossValue: 1, homeNotional: 1, foreignNotional: 1,
});

describe('ChartWidget renders the OHLC bar from data', () => {
  beforeEach(() => {
    /** One closed candle, the 00:00–00:01 bin (stamped with its close time). */
    fake.fetchMock.mockResolvedValue([
      {
        timestamp: '2024-01-01T00:01:00Z', symbol: 'XBTUSD',
        open: 100, high: 110, low: 95, close: 105.5, volume: 1_000,
      } satisfies TradeBin,
    ]);
  });

  it('shows the running candle seeded from the REST close', async () => {
    const Wrapper = makeBitmexWrapper(fake);
    const { container } = render(<Wrapper><ChartWidget /></Wrapper>);

    /** The running bin opens at 00:01 at the closed candle's close; one decimal, as 105.5 needs. */
    await waitFor(() => expect(ohlcText(container)).toBe(
      'Jan 1, 00:01O 105.5H 105.5L 105.5C 105.5Vol 0',
    ));
  });

  it('updates close, high, low and volume as trades arrive in the running bin', async () => {
    const Wrapper = makeBitmexWrapper(fake);
    const { container } = render(<Wrapper><ChartWidget /></Wrapper>);

    await waitFor(() => expect(ohlcText(container)).toMatch(/C 105\.5/));

    act(() => { fake.emit<Trade>('trade:XBTUSD', 'insert', [trade('2024-01-01T00:01:10Z', 107, 3)]); });

    await waitFor(() => expect(ohlcText(container)).toBe(
      'Jan 1, 00:01O 105.5H 107.0L 105.5C 107.0Vol 3',
    ));

    act(() => { fake.emit<Trade>('trade:XBTUSD', 'insert', [trade('2024-01-01T00:01:20Z', 104, 2)]); });

    await waitFor(() => expect(ohlcText(container)).toBe(
      'Jan 1, 00:01O 105.5H 107.0L 104.0C 104.0Vol 5',
    ));
  });
});
