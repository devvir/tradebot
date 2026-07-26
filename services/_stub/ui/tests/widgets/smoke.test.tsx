/**
 * Smoke renders for every widget — verifies they mount without throwing and
 * surface a recognisable title. Data-bound widgets get a fake BitmexClient
 * with an empty stream; static widgets render straight from `mockData`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ChartWidget }        from '../../src/widgets/Chart/ChartWidget';
import { DepthChartWidget }   from '../../src/widgets/DepthChart/DepthChartWidget';
import { MarginWidget }       from '../../src/widgets/Margin/MarginWidget';
import { OrderHistoryWidget } from '../../src/widgets/OrderHistory/OrderHistoryWidget';
import { OrderbookWidget }    from '../../src/widgets/Orderbook/OrderbookWidget';
import { OrdersWidget }       from '../../src/widgets/Orders/OrdersWidget';
import { PositionsWidget }    from '../../src/widgets/Positions/PositionsWidget';
import { RecentTradesWidget } from '../../src/widgets/RecentTrades/RecentTradesWidget';
import { TradeHistoryWidget } from '../../src/widgets/TradeHistory/TradeHistoryWidget';

import { makeFakeBitmex, makeBitmexWrapper, type FakeBitmex } from '../helpers/fakeBitmex';

let fake: FakeBitmex;

beforeEach(() => {
  fake = makeFakeBitmex();
});

// ── Static widgets (mock-data, no context required) ───────────────────────────

describe('Static widgets render', () => {
  it('MarginWidget renders the title', () => {
    render(<MarginWidget />);
    expect(screen.getByText('Margin')).toBeInTheDocument();
  });

  it('DepthChartWidget renders the title', () => {
    const { container } = render(<DepthChartWidget />);

    /** "Depth Chart" appears twice (title + placeholder) — assert on the title node specifically. */
    expect(container.querySelector('.widget__title')?.textContent).toBe('Depth Chart');
  });

  it('OrdersWidget renders the title', () => {
    render(<OrdersWidget />);
    expect(screen.getByText('Active Orders')).toBeInTheDocument();
  });

  it('PositionsWidget renders the title', () => {
    render(<PositionsWidget />);
    expect(screen.getByText('Positions')).toBeInTheDocument();
  });

  it('OrderHistoryWidget renders the title', () => {
    render(<OrderHistoryWidget />);
    expect(screen.getByText('Order History')).toBeInTheDocument();
  });

  it('TradeHistoryWidget renders the title', () => {
    render(<TradeHistoryWidget />);
    expect(screen.getByText('Trade History')).toBeInTheDocument();
  });
});

// ── Data-bound widgets (BitmexContext + router) ───────────────────────────────

describe('Data-bound widgets render', () => {
  it('OrderbookWidget mounts and renders without crashing', () => {
    const Wrapper = makeBitmexWrapper(fake);

    render(<Wrapper><OrderbookWidget /></Wrapper>);

    /** subscribes on mount. */
    expect(fake.subscriberCount('orderBookL2_25:XBTUSD')).toBeGreaterThan(0);
  });

  it('RecentTradesWidget mounts, fetches and subscribes', () => {
    const Wrapper = makeBitmexWrapper(fake);

    render(<Wrapper><RecentTradesWidget /></Wrapper>);

    expect(fake.fetchMock).toHaveBeenCalledWith('trade', expect.any(Number), { symbol: 'XBTUSD' });
    expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0);
  });

  it('ChartWidget mounts and subscribes to a tradeBin channel', () => {
    const Wrapper = makeBitmexWrapper(fake);

    render(<Wrapper><ChartWidget /></Wrapper>);

    /** Default timeframe (per `TIMEFRAMES[0]`) is 1m → subscribes to tradeBin1m + trade for running candle. */
    expect(fake.subscriberCount('tradeBin1m:XBTUSD')).toBeGreaterThan(0);
    expect(fake.subscriberCount('trade:XBTUSD')).toBeGreaterThan(0);
  });
});
